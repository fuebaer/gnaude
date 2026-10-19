import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {lastTurn} from './conversation.js';
import {oneLine, previewText} from './messages.js';

const STATUS_ICONS = {
    pending: 'content-loading-symbolic',
    done: 'object-select-symbolic',
    error: 'dialog-error-symbolic',
    refused: 'action-unavailable-symbolic',
    cancelled: 'process-stop-symbolic',
};

function formatTime(ms) {
    const time = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    const now = GLib.DateTime.new_now_local();
    const sameDay = time.get_year() === now.get_year() &&
        time.get_day_of_year() === now.get_day_of_year();
    return time.format(sameDay ? '%H:%M' : '%x');
}

const ConversationItem = GObject.registerClass(
class ConversationItem extends PopupMenu.PopupBaseMenuItem {
    _init(conversation, onStop) {
        super._init({style_class: 'gnaude-history-item'});

        const turn = lastTurn(conversation);
        this.add_child(new St.Icon({
            icon_name: STATUS_ICONS[turn.status] ?? STATUS_ICONS.done,
            style_class: 'popup-menu-icon',
            y_align: Clutter.ActorAlign.START,
        }));

        const textBox = new St.BoxLayout({
            style_class: 'gnaude-history-text',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.add_child(textBox);

        const title = new St.Label({
            style_class: 'gnaude-history-prompt',
            text: oneLine(conversation.turns[0].prompt),
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(title);

        const count = conversation.turns.length;
        let preview = previewText(conversation);
        if (count > 1)
            // Translators: number of questions asked in a chat, shown in the history menu
            preview = `${ngettext('%d question', '%d questions', count).format(count)} · ${preview}`;
        const previewLabel = new St.Label({
            style_class: 'gnaude-history-preview',
            opacity: 170,
            text: preview,
        });
        previewLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(previewLabel);

        if (turn.status === 'pending') {
            const stopButton = new St.Button({
                style_class: 'gnaude-stop-button',
                accessible_name: _('Stop'),
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
                child: new St.Icon({icon_name: 'media-playback-stop-symbolic', icon_size: 16}),
            });
            stopButton.connect('clicked', onStop);
            this.add_child(stopButton);
        } else {
            this.add_child(new St.Label({
                style_class: 'gnaude-history-time',
                opacity: 150,
                text: formatTime(conversation.updatedAt),
                y_align: Clutter.ActorAlign.START,
            }));
        }
    }
});

export const GnaudeIndicator = GObject.registerClass(
class GnaudeIndicator extends PanelMenu.Button {
    _init(extension) {
        // dontCreateMenu: the built-in click handling would open the menu on every
        // button. Instead a primary click opens the prompt dialog and any other
        // button opens the history menu set up below.
        super._init(0.0, 'Gnaude', true);
        this._extension = extension;

        this.add_child(new St.Icon({
            icon_name: 'system-search-symbolic',
            style_class: 'system-status-icon',
        }));

        // Same wiring as PanelMenu.Button.setMenu(), minus re-enabling its click gesture.
        // Main.panel registers this.menu with its menu manager in addToStatusArea().
        this.menu = new PopupMenu.PopupMenu(this, 0.0, St.Side.TOP);
        this.menu.actor.add_style_class_name('panel-menu');
        this.menu.connect('open-state-changed', this._onOpenStateChanged.bind(this));
        Main.uiGroup.add_child(this.menu.actor);
        this.menu.actor.hide();

        const click = new Clutter.ClickGesture({recognize_on_press: true});
        click.connect('recognize', () => {
            if (click.get_button() === Clutter.BUTTON_PRIMARY) {
                this.menu.close();
                this._extension.toggleDialog();
            } else {
                this.menu.toggle();
            }
        });
        this.add_action(click);

        this._buildMenu();
        this._extension.history.connectObject('changed', () => this._syncHistory(), this);
        this._syncHistory();
    }

    _buildMenu() {
        this.menu.addAction(_('New chat …'), () => this._extension.openDialog({fresh: true}));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('History')));

        this._emptyItem = new PopupMenu.PopupMenuItem(_('No chats yet'), {reactive: false});
        this.menu.addMenuItem(this._emptyItem);

        // History items live in an inner section inside a scroll view, so a long
        // history does not push the menu off screen.
        this._historySection = new PopupMenu.PopupMenuSection();
        this._scrollSection = new PopupMenu.PopupMenuSection();
        this._scrollSection.actor.add_child(new St.ScrollView({
            style_class: 'gnaude-history-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: this._historySection.actor,
        }));
        this.menu.addMenuItem(this._scrollSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._clearItem = this.menu.addAction(_('Clear history'),
            () => this._extension.history.clear());
        this.menu.addAction(_('Settings'), () => this._extension.openPreferences());
    }

    _syncHistory() {
        this._historySection.removeAll();

        const {conversations} = this._extension.history;
        this._emptyItem.visible = conversations.length === 0;
        this._scrollSection.actor.visible = conversations.length > 0;
        this._clearItem.visible = conversations.length > 0;

        for (const conversation of conversations) {
            const item = new ConversationItem(conversation,
                () => this._extension.cancel(conversation.id));
            // The inner section is not part of the menu tree, so close the menu here.
            item.connect('activate', () => {
                this.menu.close();
                this._extension.showConversation(conversation.id);
            });
            this._historySection.addMenuItem(item);
        }
    }
});
