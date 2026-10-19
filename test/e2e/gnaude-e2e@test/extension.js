// End-to-end driver: runs inside a throwaway headless GNOME Shell started by
// test/e2e/run.sh, drives Gnaude with virtual input devices and writes
// result.json plus screenshots to $GNAUDE_E2E_OUT.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot');
Gio._promisify(Gio.OutputStream.prototype, 'close_async');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const UUID = 'gnaude@n2soft.de';
const ACTIVE = 1;
const OUT = GLib.getenv('GNAUDE_E2E_OUT');
const MOCK = GLib.getenv('GNAUDE_E2E_MOCK');
const LANGUAGE = GLib.getenv('GNAUDE_E2E_LANGUAGE') ?? 'en';
const SCENARIO = GLib.getenv('GNAUDE_E2E_SCENARIO') ?? 'full';
const NEW_CHAT_LABEL = {en: 'New chat', de: 'Neuer Chat', fr: 'Nouvelle discussion', it: 'Nuova chat', es: 'Chat nuevo'};

const sleep = ms => new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    });
});

async function waitFor(condition, timeout = 15000) {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeout)
            return false;
        await sleep(100);
    }
    return true;
}

const now = () => GLib.get_monotonic_time();
const lastTurn = conversation => conversation.turns[conversation.turns.length - 1];
// Gnaude binds its gettext domain globally, so its translations are available here too.
const T = text => GLib.dgettext('gnaude', text);
const settled = conversation => () => lastTurn(conversation).status !== 'pending';

export default class GnaudeE2E extends Extension {
    enable() {
        if (globalThis.__gnaudeE2EStarted)
            return;
        globalThis.__gnaudeE2EStarted = true;

        this._results = [];
        const seat = global.stage.context.get_backend().get_default_seat();
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);

        this._run()
            .catch(e => this._check(`unexpected exception: ${e.message}`, false, e.stack))
            .finally(() => this._finish());
    }

    disable() {
    }

    _check(name, ok, detail = '') {
        this._results.push({name, ok: Boolean(ok), detail: ok ? '' : String(detail)});
    }

    _finish() {
        GLib.file_set_contents(`${OUT}/result.json`, JSON.stringify(this._results, null, 2));
        GLib.file_set_contents(`${OUT}/done`, '');
    }

    async _shot(name) {
        await sleep(400); // let animations settle
        const file = Gio.File.new_for_path(`${OUT}/${name}.png`);
        const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        await new Shell.Screenshot().screenshot(false, stream);
        await stream.close_async(GLib.PRIORITY_DEFAULT, null);
    }

    async _lastRequest() {
        const bytes = await new Soup.Session().send_and_read_async(
            Soup.Message.new('GET', `${MOCK}/last`), GLib.PRIORITY_DEFAULT, null);
        return JSON.parse(new TextDecoder().decode(bytes.get_data()));
    }

    async _keys(...keyvals) {
        for (const keyval of keyvals)
            this._keyboard.notify_keyval(now(), keyval, Clutter.KeyState.PRESSED);
        for (const keyval of keyvals.reverse())
            this._keyboard.notify_keyval(now(), keyval, Clutter.KeyState.RELEASED);
        await sleep(600);
    }

    async _click(actor, button = Clutter.BUTTON_PRIMARY) {
        const [x, y] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();
        this._pointer.notify_absolute_motion(now(), x + width / 2, y + height / 2);
        await sleep(100);
        this._pointer.notify_button(now(), button, Clutter.ButtonState.PRESSED);
        this._pointer.notify_button(now(), button, Clutter.ButtonState.RELEASED);
        await sleep(700);
    }

    _hotkey() {
        return this._keys(Clutter.KEY_Control_L, Clutter.KEY_Super_L, Clutter.KEY_space);
    }

    async _type(dialog, text) {
        dialog._entry.text = text;
        dialog._entry.clutter_text.set_cursor_position(-1);
        await sleep(100);
    }

    /** Screenshots and the actor tree of the dialogs, for checks next to other extensions. */
    async _visual(ext) {
        const dialog = ext._dialog;
        dialog.openNew();
        await sleep(1500);
        await this._shot('v1-empty');
        this._dumpTree(Main.layoutManager.modalDialogGroup, 'v1-tree.txt');

        await this._type(dialog, 'Hallo');
        await this._keys(Clutter.KEY_Return);
        await waitFor(() => !dialog._stopButton.visible, 15000);
        await sleep(1500);
        await this._shot('v2-chat');
        this._dumpTree(Main.layoutManager.modalDialogGroup, 'v2-tree.txt');
        this._dumpTree(Main.layoutManager.uiGroup, 'v2-ui.txt', 3);
        await this._keys(Clutter.KEY_Escape);
        await sleep(800);

        Main.openRunDialog();
        await sleep(1500);
        await this._shot('v3-run-dialog');
        this._dumpTree(Main.layoutManager.modalDialogGroup, 'v3-tree.txt');
        await this._keys(Clutter.KEY_Escape);
        this._check('visual scenario finished', true);
    }

    _dumpTree(root, file, depth = 6) {
        const lines = [];
        const walk = (actor, level) => {
            if (level > depth || !actor.visible)
                return;
            const [x, y] = actor.get_transformed_position();
            const [w, h] = actor.get_transformed_size();
            const style = actor.get_style_class_name?.() ?? '';
            const effects = actor.get_effects().map(e => e.constructor.name).join(',');
            lines.push(`${'  '.repeat(level)}${actor.constructor.name} [${style}] ` +
                `${x.toFixed(1)},${y.toFixed(1)} ${w.toFixed(1)}x${h.toFixed(1)}` +
                `${effects ? ` effects=${effects}` : ''}${actor.style ? ` style="${actor.style}"` : ''}`);
            for (const child of actor.get_children())
                walk(child, level + 1);
        };
        walk(root, 0);
        GLib.file_set_contents(`${OUT}/${file}`, lines.join('\n'));
    }

    async _run() {
        let meta = null;
        await waitFor(() => (meta = Main.extensionManager.lookup(UUID))?.state === ACTIVE);
        this._check('gnaude is enabled', meta?.state === ACTIVE, `state=${meta?.state} error=${meta?.error}`);
        if (meta?.state !== ACTIVE)
            return;
        await sleep(2000); // startup animation

        let ext = meta.stateObj;
        const {AnthropicClient} = await import(meta.dir.get_child('lib').get_child('anthropic.js').get_uri());
        ext._client = new AnthropicClient({baseUrl: MOCK});
        const dialog = ext._dialog;
        const indicator = Main.panel.statusArea[UUID];
        this._check('indicator is in the panel', Boolean(indicator?.get_stage()));

        if (SCENARIO === 'visual') {
            await this._visual(ext);
            return;
        }

        // A fresh virtual pointer only gets its events delivered once it has moved
        // outside a grab; give it a position before the modal dialog opens.
        this._pointer.notify_absolute_motion(now(), 800, 500);
        await sleep(300);

        // --- Dialog, translations, multi-line input -------------------------
        await this._hotkey();
        this._check('hotkey opens the dialog', dialog.isOpen);
        this._check(`UI is translated (${LANGUAGE})`, dialog._newButton.label === NEW_CHAT_LABEL[LANGUAGE],
            dialog._newButton.label);
        await this._shot('01-dialog-empty');

        // --- Model selector -------------------------------------------------------
        this._check('model button shows the default model', dialog._modelLabel.text === 'Opus 5.5',
            dialog._modelLabel.text);
        await this._click(dialog._modelButton);
        this._check('model button opens the model menu', dialog._modelMenu.isOpen);
        await this._shot('02-model-menu');
        await this._click(dialog._modelItems.find(item => item.modelId === 'claude-haiku-5-5'));
        this._check('choosing a model in a new chat changes the default',
            ext._settings.get_string('model') === 'claude-haiku-5-5' && dialog._modelLabel.text === 'Haiku 5.5' &&
            !dialog._modelMenu.isOpen && global.stage.key_focus === dialog._entry.clutter_text,
            `${ext._settings.get_string('model')} ${dialog._modelLabel.text} open=${dialog._modelMenu.isOpen}`);
        await this._keys(Clutter.KEY_Control_L, Clutter.KEY_m);
        this._check('Ctrl+M switches to the next model', ext._settings.get_string('model') === 'claude-fable-5-1');
        await this._keys(Clutter.KEY_Control_L, Clutter.KEY_m);
        this._check('Ctrl+M wraps around', ext._settings.get_string('model') === 'claude-opus-5-5');

        // --- Effort selector --------------------------------------------------------
        const isOverride = () => dialog._effortLabel.has_style_class_name('gnaude-override');
        this._check('effort button shows the default from the preferences',
            dialog._effortLabel.text === T('Medium') && !isOverride(), dialog._effortLabel.text);
        await this._click(dialog._effortButton);
        this._check('effort button opens the effort menu', dialog._effortMenu.isOpen);
        await this._shot('02-effort-menu');
        await this._click(dialog._effortItems.find(item => item.effortId === 'xhigh'));
        this._check('choosing an effort overrides it without changing the preferences',
            dialog._currentEffort() === 'xhigh' && ext._settings.get_string('effort') === 'medium' &&
            dialog._effortLabel.text === T('Very high') && isOverride() && !dialog._effortMenu.isOpen,
            `${dialog._currentEffort()} ${dialog._effortLabel.text}`);
        const ctrlE = () => this._keys(Clutter.KEY_Control_L, Clutter.KEY_e);
        await ctrlE();
        await ctrlE();
        this._check('Ctrl+E cycles back to the default', dialog._currentEffort() === null && !isOverride());
        for (let i = 0; i < 3; i++)
            await ctrlE();
        this._check('Ctrl+E steps through the levels', dialog._currentEffort() === 'high' &&
            dialog._effortLabel.text === T('High'), String(dialog._currentEffort()));

        await this._type(dialog, Array.from({length: 14}, (_, i) => `Zeile ${i + 1}`).join('\n'));
        await sleep(300);
        const entryAdjustment = dialog._entryScroll.vadjustment;
        this._check('long prompt scrolls inside the entry',
            entryAdjustment.upper > entryAdjustment.page_size && entryAdjustment.value > 0,
            `upper=${entryAdjustment.upper} page=${entryAdjustment.page_size} value=${entryAdjustment.value}`);
        await this._shot('03-multiline');

        await this._type(dialog, 'Erste Zeile');
        await this._keys(Clutter.KEY_Shift_L, Clutter.KEY_Return);
        this._check('Shift+Enter inserts a newline', dialog._entry.text === 'Erste Zeile\n',
            JSON.stringify(dialog._entry.text));
        dialog._entry.clutter_text.insert_text('Zweite Zeile SLOW', -1);
        await this._keys(Clutter.KEY_Return);
        const chat = ext.history.conversations[0];
        this._check('Enter sends the multi-line prompt',
            chat?.turns[0].prompt === 'Erste Zeile\nZweite Zeile SLOW' && dialog._entry.text === '',
            JSON.stringify(chat?.turns[0]));

        await this._type(dialog, 'Zu früh');
        await this._keys(Clutter.KEY_Return);
        this._check('no follow-up while the answer is streaming', chat.turns.length === 1 && dialog._entry.text === 'Zu früh');
        await sleep(1500);
        await this._shot('04-streaming');
        await waitFor(settled(chat));
        this._check('first answer finishes', lastTurn(chat).status === 'done', lastTurn(chat).errorCode);
        const firstRequest = await this._lastRequest();
        this._check('the chosen effort is sent and kept with the chat',
            firstRequest.body.output_config.effort === 'high' && chat.effort === 'high',
            `${firstRequest.body.output_config.effort} ${chat.effort}`);
        this._check('answer is rendered as markup', dialog._transcript.get_last_child().clutter_text.use_markup);

        // --- Follow-ups, switching the model, cancelling ---------------------------
        await this._click(dialog._modelButton);
        await this._click(dialog._modelItems.find(item => item.modelId === 'claude-sonnet-5-5'));
        this._check('choosing a model in a chat switches only that chat',
            chat.model === 'claude-sonnet-5-5' && ext._settings.get_string('model') === 'claude-opus-5-5');

        await this._type(dialog, 'Und jetzt?');
        await this._keys(Clutter.KEY_Return);
        await waitFor(settled(chat));
        let request = await this._lastRequest();
        this._check('follow-up goes to the newly chosen model',
            request.body.model === 'claude-sonnet-5-5' && lastTurn(chat).model === 'claude-sonnet-5-5' &&
            chat.turns[0].model === 'claude-opus-5-5' && dialog._statusLabel.text.startsWith('Claude Sonnet 5.5'),
            `${request.body.model} ${dialog._statusLabel.text}`);
        this._check('follow-up is answered in the same chat',
            chat.turns.length === 2 && lastTurn(chat).response.startsWith('# Antwort 2'), lastTurn(chat).response);
        this._check('follow-up replays the first answer with its thinking block',
            request.body.messages.length === 3 && request.body.messages[1].content[0].type === 'thinking');
        this._check('follow-up keeps the chat effort', request.body.output_config.effort === 'high');
        await this._shot('05-follow-up');

        await this._type(dialog, 'SLOW bitte stoppen');
        await this._keys(Clutter.KEY_Return);
        await sleep(2000);
        this._check('stop button shows while streaming', dialog._stopButton.visible);
        const [stopX, stopY] = dialog._stopButton.get_transformed_position();
        const [stopW, stopH] = dialog._stopButton.get_transformed_size();
        const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, stopX + stopW / 2, stopY + stopH / 2);
        this._check('stop button is the actor under the pointer', picked === dialog._stopButton,
            `${picked} at ${stopX},${stopY} ${stopW}x${stopH}`);
        await this._click(dialog._stopButton);
        await waitFor(settled(chat), 3000);
        this._check('stop button cancels and keeps the partial answer',
            lastTurn(chat).status === 'cancelled' && lastTurn(chat).response.length > 0, JSON.stringify(lastTurn(chat)));
        await this._shot('06-stopped');

        await this._type(dialog, 'Noch eine Frage');
        await this._keys(Clutter.KEY_Return);
        await waitFor(settled(chat));
        request = await this._lastRequest();
        this._check('follow-up after a cancelled turn is accepted and skips it',
            lastTurn(chat).status === 'done' && request.body.messages.length === 5,
            `${lastTurn(chat).errorCode} ${lastTurn(chat).error} messages=${request.body.messages.length}`);

        await this._keys(Clutter.KEY_Control_L, Clutter.KEY_n);
        this._check('Ctrl+N starts a new chat', dialog.isOpen && !dialog._conversationBox.visible);
        this._check('a new chat starts with the default effort', dialog._currentEffort() === null && !isOverride());

        await this._keys(Clutter.KEY_Escape);
        this._check('Escape closes the dialog', !dialog.isOpen);

        // --- Background requests, errors --------------------------------------
        const background = ext.submit('Frage im Hintergrund');
        await waitFor(settled(background));
        request = await this._lastRequest();
        this._check('without an override the preference is sent', request.body.output_config.effort === 'medium',
            request.body.output_config.effort);
        await sleep(300);
        this._check('background answer sends a notification', (ext._notificationSource?.count ?? 0) === 1,
            `count=${ext._notificationSource?.count}`);
        await this._shot('07-notification');

        const failed = ext.submit('AUTHFAIL bitte');
        const refused = ext.submit('REFUSE das');
        await waitFor(() => settled(failed)() && settled(refused)());
        this._check('API error is recorded', lastTurn(failed).errorCode === 'authentication_error',
            JSON.stringify(lastTurn(failed)));
        this._check('refusal is recorded without partial text',
            lastTurn(refused).errorCode === 'refusal' && lastTurn(refused).refusalCategory === 'cyber' &&
            lastTurn(refused).response === '', JSON.stringify(lastTurn(refused)));

        // --- Top bar: clicks, menu, stopping from the menu ---------------------
        await this._click(indicator, Clutter.BUTTON_PRIMARY);
        this._check('primary click opens the dialog', dialog.isOpen && !indicator.menu.isOpen);
        await this._keys(Clutter.KEY_Escape);

        const running = ext.submit('SLOW im Menü stoppen');
        await this._click(indicator, Clutter.BUTTON_SECONDARY);
        this._check('secondary click opens the menu', indicator.menu.isOpen && !dialog.isOpen);
        let items = indicator._historySection._getMenuItems();
        this._check('menu lists every chat', items.length === ext.history.conversations.length,
            `${items.length} vs ${ext.history.conversations.length}`);
        await this._shot('08-menu');
        await this._click(items[0].get_last_child());
        await waitFor(settled(running), 3000);
        this._check('stop button in the menu cancels the request', lastTurn(running).status === 'cancelled',
            lastTurn(running).status);
        this._check('stop button does not open the chat', !dialog.isOpen);

        if (!indicator.menu.isOpen)
            await this._click(indicator, Clutter.BUTTON_SECONDARY);
        items = indicator._historySection._getMenuItems();
        const chatItem = items[ext.history.conversations.indexOf(chat)];
        await this._click(chatItem);
        this._check('history item reopens the chat with all turns',
            dialog.isShowing(chat.id) && dialog._renderedTurns === 4 && dialog._entry.text === '',
            `showing=${dialog.isShowing(chat.id)} turns=${dialog._renderedTurns}`);
        await this._shot('09-history-chat');
        await this._keys(Clutter.KEY_Escape);

        // --- "Continue the last chat" setting and hotkey toggling ---------------
        ext._settings.set_boolean('continue-last-chat', true);
        await this._hotkey();
        const [latest] = ext.history.conversations;
        this._check('with "continue the last chat" the hotkey reopens the latest chat', dialog.isShowing(latest.id));
        await this._hotkey();
        this._check('hotkey closes the dialog', !dialog.isOpen);
        ext._settings.set_boolean('continue-last-chat', false);
        await this._hotkey();
        this._check('by default the hotkey starts a new chat', dialog.isOpen && !dialog._conversationBox.visible);
        await this._keys(Clutter.KEY_Escape);

        // --- Disable/enable -----------------------------------------------------
        const interrupted = ext.submit('SLOW wird abgebrochen');
        const oldHistory = ext.history;
        const chats = ext.history.conversations.length;
        await sleep(300);
        Main.extensionManager.disableExtension(UUID);
        await waitFor(() => meta.state !== ACTIVE);
        await waitFor(settled(interrupted), 3000);
        this._check('disable cancels running requests', lastTurn(interrupted).status === 'cancelled');
        this._check('disable removes the indicator', !Main.panel.statusArea[UUID]);
        await oldHistory.flush();

        Main.extensionManager.enableExtension(UUID);
        await waitFor(() => meta.state === ACTIVE);
        ext = meta.stateObj;
        await waitFor(() => ext.history.conversations.length > 0, 3000);
        this._check('re-enable restores the history', ext.history.conversations.length === chats,
            `${ext.history.conversations.length} vs ${chats}`);
        this._check('re-enable keeps follow-up turns',
            ext.history.get(chat.id)?.turns.length === 4);

        // --- Preferences --------------------------------------------------------
        ext.openPreferences();
        const found = await waitFor(() => global.display.list_all_windows()
            .some(w => w.get_wm_class()?.includes('Extensions') || w.get_title()?.includes('Gnaude')), 15000);
        this._check('preferences window opens', found,
            global.display.list_all_windows().map(w => `${w.get_wm_class()}|${w.get_title()}`).join(', '));
        await sleep(2500);
        await this._shot('10-prefs');
    }
}
