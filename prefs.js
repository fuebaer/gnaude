import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {EFFORTS, MODELS} from './lib/models.js';
import {clearApiKey, lookupApiKey, storeApiKey} from './lib/secret.js';

const API_KEYS_URL = 'https://platform.claude.com/settings/keys';

const ShortcutRow = GObject.registerClass(
class ShortcutRow extends Adw.ActionRow {
    constructor(settings, key, params) {
        super({activatable: true, ...params});
        this._settings = settings;
        this._key = key;

        this._label = new Adw.ShortcutLabel({
            disabled_text: _('Disabled'),
            valign: Gtk.Align.CENTER,
        });
        this.add_suffix(this._label);

        const resetButton = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: _('Restore default'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        resetButton.connect('clicked', () => settings.reset(key));
        this.add_suffix(resetButton);

        this.connect('activated', () => this._capture());
        const changedId = settings.connect(`changed::${key}`, () => this._sync());
        this.connect('destroy', () => settings.disconnect(changedId));
        this._sync();
    }

    _sync() {
        const [accelerator = ''] = this._settings.get_strv(this._key);
        this._label.accelerator = accelerator;
    }

    _capture() {
        const dialog = new Adw.AlertDialog({
            heading: _('Set Shortcut'),
            body: _('Press the new key combination.\nEsc cancels, Backspace disables the shortcut.'),
        });
        dialog.add_response('cancel', _('Cancel'));

        const controller = new Gtk.EventControllerKey({
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        });
        controller.connect('key-pressed', (_controller, keyval, keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;
            keyval = Gdk.keyval_to_lower(keyval);

            if (!mask && keyval === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (!mask && keyval === Gdk.KEY_BackSpace) {
                this._settings.set_strv(this._key, []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }

            // A global shortcut needs a modifier, except for function keys.
            const isFunctionKey = keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35;
            if ((!mask && !isFunctionKey) || !Gtk.accelerator_valid(keyval, mask))
                return Gdk.EVENT_STOP;

            this._settings.set_strv(this._key,
                [Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask)]);
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);
        dialog.present(this.get_root());
    }
});

function comboRow(settings, key, items, params) {
    const current = settings.get_string(key);
    // Keep a value set outside the prefs (e.g. via gsettings) selectable.
    if (!items.some(item => item.id === current))
        items = [...items, {id: current, name: current}];

    const row = new Adw.ComboRow({
        model: Gtk.StringList.new(items.map(item => item.name)),
        selected: items.findIndex(item => item.id === current),
        ...params,
    });
    row.connect('notify::selected', () => settings.set_string(key, items[row.selected].id));
    return row;
}

export default class GnaudePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(640, 800);
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({
            title: 'Gnaude',
            icon_name: 'system-search-symbolic',
        });
        page.add(this._buildApiGroup(window));
        page.add(this._buildModelGroup(settings));
        page.add(this._buildUsageGroup(settings));
        window.add(page);
    }

    _buildApiGroup(window) {
        const group = new Adw.PreferencesGroup({
            title: _('Anthropic API'),
            description: _('The API key is stored in the GNOME keyring, not in dconf.'),
        });

        const keyRow = new Adw.PasswordEntryRow({
            title: _('Enter API key'),
            show_apply_button: true,
        });
        group.add(keyRow);

        const statusRow = new Adw.ActionRow({title: _('Stored API key')});
        const removeButton = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            tooltip_text: _('Remove the API key from the keyring'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        statusRow.add_suffix(removeButton);
        group.add(statusRow);

        const linkRow = new Adw.ActionRow({
            title: _('Create an API key'),
            subtitle: API_KEYS_URL,
            activatable: true,
        });
        linkRow.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        linkRow.connect('activated', () => {
            new Gtk.UriLauncher({uri: API_KEYS_URL}).launch(window, null, null);
        });
        group.add(linkRow);

        const toast = title => window.add_toast(new Adw.Toast({title}));
        const refresh = async () => {
            try {
                const key = await lookupApiKey();
                // Translators: %s are the last four characters of the API key
                statusRow.subtitle = key ? _('Present (ends in …%s)').format(key.slice(-4)) : _('None');
                removeButton.sensitive = Boolean(key);
            } catch (e) {
                statusRow.subtitle = _('Keyring not available: %s').format(e.message);
                removeButton.sensitive = false;
            }
        };

        keyRow.connect('apply', async () => {
            const key = keyRow.text.trim();
            if (!key)
                return;
            try {
                await storeApiKey(key);
                keyRow.text = '';
                toast(_('API key saved'));
            } catch (e) {
                toast(_('Saving failed: %s').format(e.message));
            }
            await refresh();
        });
        removeButton.connect('clicked', async () => {
            try {
                await clearApiKey();
                toast(_('API key removed'));
            } catch (e) {
                toast(_('Removing failed: %s').format(e.message));
            }
            await refresh();
        });

        refresh();
        return group;
    }

    _buildModelGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Model'),
            description: _('Defaults for new chats. The prompt dialog can switch the model and effort of each chat.'),
        });
        group.add(comboRow(settings, 'model', MODELS, {title: _('Claude model')}));
        const efforts = EFFORTS.map(effort => ({...effort, name: _(effort.name)}));
        group.add(comboRow(settings, 'effort', efforts, {
            title: _('Effort'),
            subtitle: _('Lower answers faster and cheaper, higher thinks more thoroughly'),
        }));
        return group;
    }

    _buildUsageGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Usage')});
        group.add(new ShortcutRow(settings, 'toggle-dialog', {
            title: _('Shortcut'),
            subtitle: _('Opens and closes the prompt dialog'),
        }));

        const continueRow = new Adw.SwitchRow({
            title: _('Continue the last chat'),
            subtitle: _('The shortcut and the top bar icon reopen the most recent chat instead of starting a new one'),
        });
        settings.bind('continue-last-chat', continueRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(continueRow);

        const historyRow = Adw.SpinRow.new_with_range(1, 500, 1);
        historyRow.title = _('Chats in the history');
        settings.bind('history-size', historyRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(historyRow);
        return group;
    }
}
