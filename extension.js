import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AnthropicClient, ApiError} from './lib/anthropic.js';
import {SYSTEM_PROMPT, buildMessages, isPending, lastTurn} from './lib/conversation.js';
import {HistoryStore} from './lib/history.js';
import {GnaudeIndicator} from './lib/indicator.js';
import {markdownToPlain} from './lib/markdown.js';
import {errorText, oneLine} from './lib/messages.js';
import {findModel} from './lib/models.js';
import {PromptDialog} from './lib/promptDialog.js';
import {lookupApiKey} from './lib/secret.js';

const NOTIFICATION_BODY_LENGTH = 200;

class MissingApiKeyError extends Error {}

export default class GnaudeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._client = new AnthropicClient({
            userAgent: `Gnaude/${this.metadata['version-name'] ?? 'dev'}`,
        });
        /** @type {Map<string, Gio.Cancellable>} running request per conversation */
        this._requests = new Map();

        this.history = new HistoryStore({
            path: GLib.build_filenamev([GLib.get_user_data_dir(), 'gnaude', 'history.json']),
            maxEntries: this._settings.get_int('history-size'),
        });
        this.history.load().catch(e => console.error(`Gnaude: could not load history: ${e.message}`));
        this._settings.connectObject('changed::history-size', () => {
            this.history.maxEntries = this._settings.get_int('history-size');
        }, this);

        this._dialog = new PromptDialog(this);
        this._indicator = new GnaudeIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // SYSTEM_MODAL lets the shortcut close our own (modal) dialog again.
        Main.wm.addKeybinding('toggle-dialog', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.SYSTEM_MODAL,
            () => this.toggleDialog());
    }

    disable() {
        Main.wm.removeKeybinding('toggle-dialog');

        // Running requests end as "cancelled" in the history (see _run()).
        for (const cancellable of this._requests.values())
            cancellable.cancel();
        this._requests = null;

        this._settings.disconnectObject(this);
        this._settings = null;

        this._indicator.destroy();
        this._indicator = null;
        this._dialog.destroy();
        this._dialog = null;
        this._notificationSource?.destroy();
        this._notificationSource = null;

        this._client = null;
        this.history = null;
    }

    get settings() {
        return this._settings;
    }

    toggleDialog() {
        if (this._dialog.isOpen)
            this._dialog.close();
        else if (Main.actionMode & (Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW))
            this.openDialog(); // not on top of another system modal dialog
    }

    /** Opens the dialog with a new chat, or the latest one if the user prefers that. */
    openDialog({fresh = false} = {}) {
        const [latest] = this.history.conversations;
        if (!fresh && latest && this._settings.get_boolean('continue-last-chat'))
            this._dialog.openConversation(latest.id);
        else
            this._dialog.openNew();
    }

    showConversation(id) {
        this._dialog.openConversation(id);
    }

    /**
     * Sends a prompt as a new conversation or as a follow-up, in the background.
     * The conversation is updated while the answer streams in, whether or not the
     * dialog stays open.
     *
     * @returns {import('./lib/history.js').Conversation}
     */
    submit(prompt, conversationId = null, {effort = null} = {}) {
        const conversation = this.history.startTurn({
            conversationId,
            prompt,
            model: this._settings.get_string('model'),
            system: SYSTEM_PROMPT,
            effort,
        });
        this._run(conversation).catch(e => console.error(`Gnaude: ${e.message}`));
        return conversation;
    }

    cancel(conversationId) {
        this._requests.get(conversationId)?.cancel();
    }

    async _run(conversation) {
        // disable() may run while this request is in flight: keep our own references.
        const {history, _client: client, _requests: requests} = this;
        const effort = conversation.effort ?? this._settings.get_string('effort');
        const {id} = conversation;
        const model = lastTurn(conversation).model ?? conversation.model;
        const cancellable = new Gio.Cancellable();
        requests.set(id, cancellable);

        try {
            const apiKey = await lookupApiKey(cancellable);
            if (!apiKey)
                throw new MissingApiKeyError();

            const result = await client.stream({
                apiKey,
                model,
                effort,
                system: conversation.system,
                messages: buildMessages(conversation),
                fallbacks: findModel(model).fallbacks,
                cancellable,
                onPhase: phase => history.progress(id, {phase}),
                onText: response => history.progress(id, {response}),
            });

            if (result.stopReason === 'refusal') {
                // A refusal invalidates any partial output.
                history.finish(id, {
                    status: 'refused',
                    response: '',
                    errorCode: 'refusal',
                    refusalCategory: result.stopDetails?.category ?? undefined,
                    error: result.stopDetails?.explanation ?? undefined,
                });
            } else {
                history.finish(id, {
                    status: 'done',
                    response: result.text,
                    content: result.content,
                    servedBy: result.model ?? undefined,
                    truncated: result.stopReason === 'max_tokens',
                    fellBack: result.fellBack,
                });
            }
        } catch (e) {
            if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                history.finish(id, {status: 'cancelled', errorCode: 'cancelled'});
            else if (e instanceof MissingApiKeyError)
                history.finish(id, {status: 'error', errorCode: 'missing_api_key'});
            else if (e instanceof ApiError)
                history.finish(id, {status: 'error', errorCode: e.type ?? 'api_error', error: e.message});
            else
                history.finish(id, {status: 'error', errorCode: 'network', error: e.message});
        } finally {
            requests.delete(id);
        }

        if (!cancellable.is_cancelled())
            this._notifyFinished(id);
    }

    _notifyFinished(id) {
        // The user is watching the answer arrive; no need to notify.
        if (this._dialog.isShowing(id))
            return;

        const conversation = this.history.get(id);
        if (!conversation || isPending(conversation))
            return;

        const turn = lastTurn(conversation);
        const body = turn.status === 'done'
            ? markdownToPlain(turn.response).slice(0, NOTIFICATION_BODY_LENGTH)
            : errorText(turn);
        const source = this._getNotificationSource();
        const notification = new MessageTray.Notification({
            source,
            title: oneLine(turn.prompt),
            body,
        });
        notification.connect('activated', () => this.showConversation(id));
        source.addNotification(notification);
    }

    _getNotificationSource() {
        if (!this._notificationSource) {
            this._notificationSource = new MessageTray.Source({
                title: 'Gnaude',
                iconName: 'system-search-symbolic',
            });
            this._notificationSource.connect('destroy', () => {
                this._notificationSource = null;
            });
            Main.messageTray.add(this._notificationSource);
        }
        return this._notificationSource;
    }
}
