// Persistent conversation history, stored as JSON in the user data dir.
// Only plain gi imports are used, so the module can be tested with `gjs -m`.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';

import {isPending, lastTurn} from './conversation.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const FILE_VERSION = 2;

/**
 * @typedef {object} Turn
 * @property {string} prompt
 * @property {string} [model] - model the prompt was sent to
 * @property {string} response - answer text (Markdown), partial while pending
 * @property {object[]} [content] - answer content blocks as received, replayed verbatim
 * @property {'pending'|'done'|'error'|'refused'|'cancelled'} status
 * @property {string} [phase] - live progress while pending (connecting, thinking, writing, fallback)
 * @property {string} [errorCode] - missing_api_key, interrupted, cancelled, refusal, network or an API error type
 * @property {string} [error] - untranslated detail (API message, refusal explanation)
 * @property {string} [refusalCategory]
 * @property {boolean} [truncated] - stopped at max_tokens
 * @property {boolean} [fellBack] - a fallback model answered
 * @property {string} [servedBy] - model that produced the answer
 * @property {number} createdAt - unix ms
 * @property {number} [finishedAt] - unix ms
 */

/**
 * @typedef {object} Conversation
 * @property {string} id
 * @property {string} model - model for the next prompt; can change between turns
 * @property {string|null} [effort] - effort override; null follows the preferences
 * @property {string} system - system prompt, frozen at creation
 * @property {Turn[]} turns
 * @property {number} createdAt - unix ms
 * @property {number} updatedAt - unix ms
 */

export const HistoryStore = GObject.registerClass({
    Signals: {
        // The list changed (conversation added, finished, removed): rebuild menus, persist.
        'changed': {},
        // Live progress of a conversation's last turn (streamed text, phase). Not persisted.
        'conversation-progress': {param_types: [GObject.TYPE_STRING]},
    },
}, class HistoryStore extends GObject.Object {
    constructor({path, maxEntries = 50}) {
        super();
        this._file = Gio.File.new_for_path(path);
        this._maxEntries = maxEntries;
        /** @type {Conversation[]} most recently used first */
        this._conversations = [];
        this._writeQueue = Promise.resolve();
    }

    /** @returns {Conversation[]} most recently used first */
    get conversations() {
        return this._conversations;
    }

    /**
     * @param {string|null} id
     * @returns {Conversation|null}
     */
    get(id) {
        return this._conversations.find(c => c.id === id) ?? null;
    }

    set maxEntries(value) {
        this._maxEntries = value;
        if (this._trim())
            this._changed();
    }

    async load() {
        let data;
        try {
            const [contents] = await this._file.load_contents_async(null);
            data = JSON.parse(new TextDecoder().decode(contents));
        } catch (e) {
            if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return;
            throw e;
        }

        if (data?.version !== FILE_VERSION || !Array.isArray(data.conversations))
            return;
        const {conversations} = data;

        // Requests do not survive a shell restart or an extension reload.
        for (const turn of conversations.map(lastTurn)) {
            if (turn?.status === 'pending') {
                turn.status = 'cancelled';
                turn.errorCode = 'interrupted';
                delete turn.phase;
            }
        }
        // Keep conversations started while the file was loading in front.
        const known = new Set(this._conversations.map(c => c.id));
        this._conversations.push(...conversations.filter(c => !known.has(c.id)));
        this._trim();
        this.emit('changed');
    }

    /**
     * Appends a pending turn, to an existing conversation or a new one.
     *
     * @param {object} params
     * @param {string|null} [params.conversationId] - the chat to continue, or null for a new one
     * @param {string} params.prompt
     * @param {string} params.model - model of a new chat
     * @param {string} params.system - system prompt of a new chat
     * @param {string|null} [params.effort] - effort override of a new chat
     * @returns {Conversation}
     */
    startTurn({conversationId = null, prompt, model, system, effort = null}) {
        const now = Date.now();
        let conversation = conversationId ? this.get(conversationId) : null;
        if (conversation) {
            this._conversations.splice(this._conversations.indexOf(conversation), 1);
        } else {
            conversation = {
                id: GLib.uuid_string_random(),
                model,
                system,
                effort,
                turns: [],
                createdAt: now,
            };
        }
        conversation.turns.push({
            prompt,
            model: conversation.model,
            response: '',
            status: 'pending',
            phase: 'connecting',
            createdAt: now,
        });
        conversation.updatedAt = now;
        this._conversations.unshift(conversation);
        this._trim();
        this._changed();
        return conversation;
    }

    /**
     * Live update of the last turn while streaming; cheap, not persisted.
     *
     * @param {string} id
     * @param {Partial<Turn>} patch
     */
    progress(id, patch) {
        const conversation = this.get(id);
        if (!conversation)
            return;
        Object.assign(lastTurn(conversation), patch);
        this.emit('conversation-progress', id);
    }

    /**
     * Final update of the last turn: persists and notifies list observers.
     *
     * @param {string} id
     * @param {Partial<Turn>} patch
     */
    finish(id, patch) {
        const conversation = this.get(id);
        if (!conversation)
            return;
        const turn = lastTurn(conversation);
        Object.assign(turn, patch, {finishedAt: Date.now()});
        delete turn.phase;
        conversation.updatedAt = turn.finishedAt;
        this.emit('conversation-progress', id);
        this._changed();
    }

    /**
     * Switches the model used for the conversation's next prompts.
     *
     * @param {string} id
     * @param {string} model
     */
    setModel(id, model) {
        const conversation = this.get(id);
        if (!conversation || conversation.model === model)
            return;
        conversation.model = model;
        this._changed();
    }

    /**
     * Sets or clears the effort override for the conversation's next prompts.
     *
     * @param {string} id
     * @param {string|null} effort - null follows the preferences
     */
    setEffort(id, effort) {
        const conversation = this.get(id);
        if (!conversation || (conversation.effort ?? null) === effort)
            return;
        conversation.effort = effort;
        this._changed();
    }

    remove(id) {
        this._conversations = this._conversations.filter(c => c.id !== id);
        this._changed();
    }

    clear() {
        // Running requests keep their conversation so they can still finish into it.
        this._conversations = this._conversations.filter(isPending);
        this._changed();
    }

    /** Waits for pending writes, e.g. before tests inspect the file. */
    flush() {
        return this._writeQueue;
    }

    _trim() {
        let removed = false;
        while (this._conversations.length > this._maxEntries) {
            const index = this._conversations.findLastIndex(c => !isPending(c));
            if (index < 0)
                break;
            this._conversations.splice(index, 1);
            removed = true;
        }
        return removed;
    }

    _changed() {
        this.emit('changed');
        this._save();
    }

    _save() {
        const json = JSON.stringify({version: FILE_VERSION, conversations: this._conversations},
            (key, value) => key === 'phase' ? undefined : value);
        this._writeQueue = this._writeQueue.then(async () => {
            try {
                const dir = this._file.get_parent().get_path();
                GLib.mkdir_with_parents(dir, 0o700);
                await this._file.replace_contents_bytes_async(
                    new GLib.Bytes(new TextEncoder().encode(json)),
                    null, false, Gio.FileCreateFlags.PRIVATE, null);
            } catch (e) {
                console.error(`Gnaude: could not save history: ${e.message}`);
            }
        });
    }
});
