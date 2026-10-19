import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ShellEntry from 'resource:///org/gnome/shell/ui/shellEntry.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {isPending, lastTurn} from './conversation.js';
import {markdownToPango} from './markdown.js';
import {errorText, statusText} from './messages.js';
import {EFFORTS, MODELS, findModel} from './models.js';

// Coalesce streamed deltas so long answers are not re-rendered for every token.
const RENDER_INTERVAL_MS = 60;
const COPY_FEEDBACK_MS = 1500;
// Space kept below the cursor when the prompt scrolls, so the entry padding stays visible.
const CURSOR_MARGIN = 12;
const ENTER_KEYS = [Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_ISO_Enter];

function setMarkdown(clutterText, markdown) {
    const markup = markdownToPango(markdown);
    try {
        Pango.parse_markup(markup, -1, '');
        clutterText.set_markup(markup);
    } catch {
        // Unbalanced formatting (e.g. mid-stream): show the raw text instead.
        clutterText.set_text(markdown);
    }
}

function wrappedLabel(styleClass, text = '') {
    const label = new St.Label({style_class: styleClass, text});
    const clutterText = label.clutter_text;
    clutterText.line_wrap = true;
    clutterText.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    clutterText.ellipsize = Pango.EllipsizeMode.NONE;
    clutterText.selectable = true;
    clutterText.reactive = true;
    return label;
}

function renderAnswer(label, turn) {
    const problem = errorText(turn);
    if (problem)
        setMarkdown(label.clutter_text, turn.response ? `${turn.response}\n\n⚠ ${problem}` : `⚠ ${problem}`);
    else if (turn.response)
        setMarkdown(label.clutter_text, turn.response);
    else
        label.clutter_text.set_text('');
}

export const PromptDialog = GObject.registerClass(
class PromptDialog extends ModalDialog.ModalDialog {
    _init(extension) {
        super._init({
            styleClass: 'gnaude-dialog',
            destroyOnClose: false,
        });

        // No dialog buttons: Enter submits, Escape closes.
        this.buttonLayout.hide();

        this._extension = extension;
        this._history = extension.history;
        this._conversationId = null;
        this._renderedTurns = 0;
        this._followBottom = true;
        this._renderId = 0;
        this._copyResetId = 0;
        // Effort chosen for the next new chat; null follows the preferences.
        this._newChatEffort = null;
        this._selectorMenus = [];

        this._buildEntry();
        this._buildConversation();

        const hint = new St.Label({
            style_class: 'gnaude-hint',
            opacity: 150,
            text: _('Enter: send  ·  Shift+Enter: new line  ·  Ctrl+M: model  ·  Ctrl+E: effort  ·  Ctrl+N: new chat  ·  Esc: close'),
        });
        hint.clutter_text.line_wrap = true;
        hint.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this.contentLayout.add_child(hint);

        // Keyboard handling happens before any child sees the event: ModalDialog has
        // no Escape handling, and ClutterText (mutter 51) never inserts a newline for
        // Enter, even in multi-line mode, so Enter and Shift+Enter are handled here.
        this.connect('captured-event', (_actor, event) => {
            if (event.type() !== Clutter.EventType.KEY_PRESS)
                return Clutter.EVENT_PROPAGATE;

            const symbol = event.get_key_symbol();
            const state = event.get_state();
            if (symbol === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            if ((symbol === Clutter.KEY_n || symbol === Clutter.KEY_N) &&
                (state & Clutter.ModifierType.CONTROL_MASK)) {
                this.startNew();
                return Clutter.EVENT_STOP;
            }
            if ((symbol === Clutter.KEY_m || symbol === Clutter.KEY_M) &&
                (state & Clutter.ModifierType.CONTROL_MASK)) {
                this._cycleModel();
                return Clutter.EVENT_STOP;
            }
            if ((symbol === Clutter.KEY_e || symbol === Clutter.KEY_E) &&
                (state & Clutter.ModifierType.CONTROL_MASK)) {
                this._cycleEffort();
                return Clutter.EVENT_STOP;
            }
            if (ENTER_KEYS.includes(symbol) && global.stage.key_focus === this._entry.clutter_text) {
                if (state & Clutter.ModifierType.SHIFT_MASK)
                    this._insertNewline();
                else
                    this._submit();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._history.connectObject(
            'conversation-progress', (_store, id) => {
                if (id === this._conversationId)
                    this._queueRender();
            },
            'changed', () => {
                if (this._conversationId && !this._history.get(this._conversationId))
                    this._showConversation(null);
                else
                    this._render();
            }, this);

        // The selectors show the defaults from the preferences while no chat overrides them.
        extension.settings.connectObject(
            'changed::model', () => this._syncModelButton(),
            'changed::effort', () => this._syncEffortButton(), this);

        this.connect('destroy', () => {
            this._selectorMenus.forEach(menu => menu.destroy());
            if (this._renderId)
                GLib.source_remove(this._renderId);
            if (this._copyResetId)
                GLib.source_remove(this._copyResetId);
        });
    }

    _buildEntry() {
        // The frame (background, focus ring, icon) belongs to the box around the
        // scroll view, so it stays in place when a long prompt scrolls.
        const promptBox = new St.BoxLayout({style_class: 'gnaude-prompt', x_expand: true});
        this.contentLayout.add_child(promptBox);

        promptBox.add_child(new St.Icon({
            icon_name: 'system-search-symbolic',
            style_class: 'gnaude-prompt-icon',
            y_align: Clutter.ActorAlign.START,
        }));

        this._entry = new St.Entry({
            style_class: 'gnaude-entry',
            can_focus: true,
            x_expand: true,
        });
        ShellEntry.addContextMenu(this._entry);

        // Multi-line prompt; Enter and Shift+Enter are handled in the captured-event handler.
        const text = this._entry.clutter_text;
        text.single_line_mode = false;
        text.activatable = false;
        text.line_wrap = true;
        text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        text.connect('key-focus-in', () => promptBox.add_style_pseudo_class('focus'));
        text.connect('key-focus-out', () => promptBox.remove_style_pseudo_class('focus'));
        this.setInitialKeyFocus(text);

        // The entry grows with its text; beyond the scroll view's max-height it scrolls.
        const entryBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        entryBox.add_child(this._entry);
        this._entryScroll = new St.ScrollView({
            style_class: 'gnaude-entry-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            child: entryBox,
        });
        promptBox.add_child(this._entryScroll);

        text.connect('cursor-changed', () => this._scrollToCursor());
        this._entryScroll.vadjustment.connect('changed', () => this._scrollToCursor());

        this._buildModelSelector(promptBox);
        this._buildEffortSelector(promptBox);
    }

    /** A compact button with a popup menu at the right end of the prompt. */
    _addSelector(promptBox, accessibleName) {
        const label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        const buttonBox = new St.BoxLayout({style_class: 'gnaude-selector-box'});
        buttonBox.add_child(label);
        buttonBox.add_child(new St.Icon({icon_name: 'pan-down-symbolic', icon_size: 12}));

        const button = new St.Button({
            style_class: 'gnaude-selector',
            accessible_name: accessibleName,
            can_focus: true,
            y_align: Clutter.ActorAlign.START,
            child: buttonBox,
        });
        promptBox.add_child(button);

        // Same setup as the entry's context menu: a popup with its own manager
        // works on top of the modal dialog.
        const menu = new PopupMenu.PopupMenu(button, 0.5, St.Side.TOP);
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();
        menu.manager = new PopupMenu.PopupMenuManager(button);
        menu.manager.addMenu(menu);
        this._selectorMenus.push(menu);

        button.connect('clicked', () => menu.toggle());
        menu.connect('open-state-changed', (_menu, open) => {
            if (!open)
                this._entry.clutter_text.grab_key_focus();
        });
        return {button, label, menu};
    }

    _buildModelSelector(promptBox) {
        ({button: this._modelButton, label: this._modelLabel, menu: this._modelMenu} =
            this._addSelector(promptBox, _('Choose model')));

        this._modelItems = MODELS.map(({id, name}) => {
            const item = this._modelMenu.addAction(name, () => this._selectModel(id));
            item.modelId = id;
            return item;
        });
        this._syncModelButton();
    }

    _buildEffortSelector(promptBox) {
        ({button: this._effortButton, label: this._effortLabel, menu: this._effortMenu} =
            this._addSelector(promptBox, _('Choose effort')));

        this._defaultEffortItem = this._effortMenu.addAction('', () => this._selectEffort(null));
        this._effortMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._effortItems = EFFORTS.map(({id, name}) => {
            const item = this._effortMenu.addAction(_(name), () => this._selectEffort(id));
            item.effortId = id;
            return item;
        });
        this._syncEffortButton();
    }
    _buildConversation() {
        this._conversationBox = new St.BoxLayout({
            style_class: 'gnaude-conversation',
            orientation: Clutter.Orientation.VERTICAL,
            visible: false,
        });
        this.contentLayout.add_child(this._conversationBox);

        const statusBox = new St.BoxLayout({style_class: 'gnaude-status'});
        this._conversationBox.add_child(statusBox);

        this._spinner = new Animation.Spinner(16, {hideOnStop: true});
        statusBox.add_child(this._spinner);

        this._statusLabel = new St.Label({
            style_class: 'gnaude-status-label',
            opacity: 180,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        statusBox.add_child(this._statusLabel);

        const addButton = (label, callback) => {
            const button = new St.Button({
                style_class: 'button gnaude-status-button',
                label,
                can_focus: true,
            });
            button.connect('clicked', callback);
            statusBox.add_child(button);
            return button;
        };
        this._stopButton = addButton(_('Stop'), () => this._extension.cancel(this._conversationId));
        this._copyButton = addButton(_('Copy'), () => this._copy());
        this._newButton = addButton(_('New chat'), () => this.startNew());

        this._transcript = new St.BoxLayout({
            style_class: 'gnaude-transcript',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._scroll = new St.ScrollView({
            style_class: 'gnaude-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: this._transcript,
        });
        this._conversationBox.add_child(this._scroll);

        // Follow new output as long as the user has not scrolled up.
        const adjustment = this._scroll.vadjustment;
        adjustment.connect('changed', () => {
            if (this._followBottom)
                adjustment.value = adjustment.upper - adjustment.page_size;
        });
        adjustment.connect('notify::value', () => {
            this._followBottom = adjustment.value >= adjustment.upper - adjustment.page_size - 1;
        });
    }

    get isOpen() {
        return this.state === ModalDialog.State.OPENED ||
            this.state === ModalDialog.State.OPENING;
    }

    /** True if the dialog is open and showing the given conversation. */
    isShowing(id) {
        return this.isOpen && this._conversationId === id;
    }

    openNew() {
        this.startNew();
        this.open();
    }

    openConversation(id) {
        this._entry.text = '';
        this._showConversation(this._history.get(id) ? id : null);
        this.open();
    }

    startNew() {
        this._entry.text = '';
        this._newChatEffort = null;
        this._showConversation(null);
        this._entry.clutter_text.grab_key_focus();
    }

    _submit() {
        const prompt = this._entry.text.trim();
        if (!prompt)
            return;

        // One request per conversation at a time: wait for the answer or stop it.
        const current = this._history.get(this._conversationId);
        if (isPending(current))
            return;

        const conversation = this._extension.submit(prompt, current?.id ?? null,
            {effort: this._newChatEffort});
        this._entry.text = '';
        this._showConversation(conversation.id);
    }

    /** Model for the next prompt: the open chat's model, or the default for new chats. */
    _currentModel() {
        return this._history.get(this._conversationId)?.model ??
            this._extension.settings.get_string('model');
    }

    _selectModel(id) {
        const conversation = this._history.get(this._conversationId);
        if (conversation)
            this._history.setModel(conversation.id, id);
        else
            this._extension.settings.set_string('model', id);
        this._syncModelButton();
    }

    _cycleModel() {
        const index = MODELS.findIndex(model => model.id === this._currentModel());
        this._selectModel(MODELS[(index + 1) % MODELS.length].id);
    }

    _syncModelButton() {
        const current = this._currentModel();
        this._modelLabel.text = findModel(current).name.replace(/^Claude /, '');
        for (const item of this._modelItems) {
            item.setOrnament(item.modelId === current
                ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
    }

    /** Effort override for the next prompt, or null to follow the preferences. */
    _currentEffort() {
        const conversation = this._history.get(this._conversationId);
        return conversation ? conversation.effort ?? null : this._newChatEffort;
    }

    _selectEffort(effort) {
        const conversation = this._history.get(this._conversationId);
        if (conversation)
            this._history.setEffort(conversation.id, effort);
        else
            this._newChatEffort = effort;
        this._syncEffortButton();
    }

    _cycleEffort() {
        const choices = [null, ...EFFORTS.map(effort => effort.id)];
        const index = choices.indexOf(this._currentEffort());
        this._selectEffort(choices[(index + 1) % choices.length]);
    }

    _syncEffortButton() {
        const shortName = id => _(EFFORTS.find(effort => effort.id === id)?.short ?? id);
        const current = this._currentEffort();
        const defaultEffort = this._extension.settings.get_string('effort');

        this._effortLabel.text = shortName(current ?? defaultEffort);
        // An override is shown in the accent color, the default from the preferences is not.
        if (current)
            this._effortLabel.add_style_class_name('gnaude-override');
        else
            this._effortLabel.remove_style_class_name('gnaude-override');

        // Translators: %s is the effort level set in the preferences, e.g. "Medium"
        this._defaultEffortItem.label.text = _('Default (%s)').format(shortName(defaultEffort));
        this._defaultEffortItem.setOrnament(current
            ? PopupMenu.Ornament.NONE : PopupMenu.Ornament.CHECK);
        for (const item of this._effortItems) {
            item.setOrnament(item.effortId === current
                ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
    }

    _insertNewline() {
        const text = this._entry.clutter_text;
        text.delete_selection();
        text.insert_unichar('\n');
    }

    _showConversation(id) {
        this._conversationId = id;
        this._renderedTurns = 0;
        this._followBottom = true;
        this._entry.hint_text = id ? _('Ask a follow-up question …') : _('Ask Claude …');
        this._syncModelButton();
        this._syncEffortButton();
        this._render();
    }

    _queueRender() {
        if (this._renderId)
            return;

        this._renderId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RENDER_INTERVAL_MS, () => {
            this._renderId = 0;
            this._render();
            return GLib.SOURCE_REMOVE;
        });
    }

    _render() {
        const conversation = this._history.get(this._conversationId);
        this._conversationBox.visible = conversation !== null;
        if (!conversation) {
            this._transcript.destroy_all_children();
            this._renderedTurns = 0;
            this._spinner.stop();
            return;
        }

        if (conversation.turns.length !== this._renderedTurns)
            this._rebuildTranscript(conversation);
        else
            renderAnswer(this._transcript.get_last_child(), lastTurn(conversation));

        const turn = lastTurn(conversation);
        const pending = turn.status === 'pending';
        if (pending)
            this._spinner.play();
        else
            this._spinner.stop();

        this._statusLabel.text = statusText(conversation);
        this._stopButton.visible = pending;
        this._copyButton.visible = !pending && Boolean(turn.response);
    }

    _rebuildTranscript(conversation) {
        this._transcript.destroy_all_children();
        for (const turn of conversation.turns) {
            this._transcript.add_child(wrappedLabel('gnaude-turn-prompt', turn.prompt));
            const answer = wrappedLabel('gnaude-turn-answer');
            renderAnswer(answer, turn);
            this._transcript.add_child(answer);
        }
        this._renderedTurns = conversation.turns.length;
    }

    _scrollToCursor() {
        const text = this._entry.clutter_text;
        const adjustment = this._entryScroll.vadjustment;
        const cursor = text.get_cursor_rect();
        const top = this._entry.get_allocation_box().y1 + text.get_allocation_box().y1 + cursor.get_y();
        const bottom = Math.min(top + cursor.get_height() + CURSOR_MARGIN, adjustment.upper);

        if (top < adjustment.value)
            adjustment.value = top;
        else if (bottom > adjustment.value + adjustment.page_size)
            adjustment.value = bottom - adjustment.page_size;
    }

    _copy() {
        const turn = lastTurn(this._history.get(this._conversationId));
        if (!turn?.response)
            return;

        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, turn.response);
        this._copyButton.label = _('Copied ✓');

        if (this._copyResetId)
            GLib.source_remove(this._copyResetId);
        this._copyResetId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COPY_FEEDBACK_MS, () => {
            this._copyResetId = 0;
            this._copyButton.label = _('Copy');
            return GLib.SOURCE_REMOVE;
        });
    }
});
