// Minimal streaming client for the Anthropic Messages API.
//
// GNOME Shell cannot load the official JS SDK (no npm/Node runtime), so this
// talks to POST /v1/messages directly with libsoup and parses the SSE stream.
// Only plain gi imports are used, so the module can be tested with `gjs -m`.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// Lets us ask for invalidated thinking blocks to be dropped instead of failing
// the request (see the notes at the top of conversation.js).
const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';
const MAX_TOKENS = 64000;

export class ApiError extends Error {
    constructor(type, message, status = 0) {
        super(message || type || 'Unknown API error');
        this.name = 'ApiError';
        this.type = type;
        this.status = status;
    }

    static fromResponse(status, body) {
        try {
            const {error} = JSON.parse(body);
            return new ApiError(error?.type, error?.message, status);
        } catch {
            return new ApiError('http_error', `HTTP ${status}: ${body.slice(0, 200)}`, status);
        }
    }
}

/**
 * @typedef {object} StreamResult
 * @property {string} text - concatenated text of all text blocks
 * @property {object[]} content - all content blocks as received, for verbatim replay
 * @property {string|null} model - model that produced the message (differs on fallback)
 * @property {string|null} stopReason - end_turn, max_tokens, refusal, ...
 * @property {object|null} stopDetails - set on refusals (category, explanation)
 * @property {boolean} fellBack - a server-side fallback model took over
 */

export class AnthropicClient {
    constructor({baseUrl = DEFAULT_BASE_URL, userAgent = 'Gnaude'} = {}) {
        this._url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;
        this._session = new Soup.Session({user_agent: userAgent});
    }

    /** Closes open connections; running requests fail with a cancellation error. */
    destroy() {
        this._session.abort();
    }

    /**
     * Sends a conversation and streams the reply.
     *
     * @param {object} params
     * @param {string} params.apiKey
     * @param {string} params.model
     * @param {string} params.effort - low | medium | high | xhigh | max
     * @param {string} params.system - system prompt
     * @param {object[]} params.messages - conversation, ending with a user message
     * @param {boolean} params.fallbacks - opt into server-side refusal fallbacks
     * @param {Gio.Cancellable} [params.cancellable]
     * @param {(phase: string) => void} [params.onPhase] - thinking | writing | fallback
     * @param {(text: string) => void} [params.onText] - full text so far
     * @returns {Promise<StreamResult>}
     */
    async stream({apiKey, model, effort, system, messages, fallbacks, cancellable = null, onPhase, onText}) {
        const body = {
            model,
            max_tokens: MAX_TOKENS,
            stream: true,
            system,
            // Degrade instead of failing if a replayed thinking block no longer matches.
            thinking: {type: 'adaptive', block_binding: {prefix_mismatch_behavior: 'drop_block'}},
            output_config: {effort},
            // Caches the growing conversation prefix across follow-ups.
            cache_control: {type: 'ephemeral'},
            messages,
        };
        const betas = [THINKING_BINDING_BETA];
        if (fallbacks) {
            body.fallbacks = 'default';
            betas.push(FALLBACK_BETA);
        }

        const message = Soup.Message.new('POST', this._url);
        const headers = message.get_request_headers();
        headers.append('x-api-key', apiKey);
        headers.append('anthropic-version', API_VERSION);
        headers.append('anthropic-beta', betas.join(','));
        message.set_request_body_from_bytes('application/json',
            new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body))));

        const input = await this._session.send_async(message, GLib.PRIORITY_DEFAULT, cancellable);
        const lines = new Gio.DataInputStream({base_stream: input, close_base_stream: true});
        try {
            const status = message.get_status();
            if (status !== Soup.Status.OK)
                throw ApiError.fromResponse(status, await readAll(lines, cancellable));

            return await readEvents(lines, cancellable, {onPhase, onText});
        } finally {
            lines.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
        }
    }
}

// Not via Gio._promisify(): GNOME Shell already promisifies read_line_async with
// the byte-returning read_line_finish, and a second _promisify() call is a no-op.
function readLine(lines, cancellable) {
    return new Promise((resolve, reject) => {
        lines.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (_stream, result) => {
            try {
                resolve(lines.read_line_finish_utf8(result)[0]);
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function readAll(lines, cancellable) {
    const chunks = [];
    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- lines arrive one after another
        const line = await readLine(lines, cancellable);
        if (line === null)
            return chunks.join('\n');
        chunks.push(line);
    }
}

async function readEvents(lines, cancellable, {onPhase, onText}) {
    const result = {text: '', content: [], model: null, stopReason: null, stopDetails: null, fellBack: false};

    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- events must be handled in order
        const line = await readLine(lines, cancellable);
        if (line === null)
            break;
        // Every Anthropic SSE event carries its whole payload on a single `data:` line;
        // the `event:` line just repeats `type`, so it can be ignored.
        if (!line.startsWith('data:'))
            continue;

        const event = JSON.parse(line.slice(5));
        switch (event.type) {
        case 'message_start':
            result.model = event.message?.model ?? result.model;
            logDroppedThinking(event.message?.input_transformations);
            break;
        case 'content_block_start': {
            result.content[event.index] = {...event.content_block};
            const type = event.content_block?.type;
            if (type === 'thinking' || type === 'redacted_thinking') {
                onPhase?.('thinking');
            } else if (type === 'text') {
                onPhase?.('writing');
            } else if (type === 'fallback') {
                // A fallback model continues the same stream; partial text stays valid.
                result.fellBack = true;
                onPhase?.('fallback');
            }
            break;
        }
        case 'content_block_delta': {
            const block = result.content[event.index];
            if (!block)
                break;
            switch (event.delta?.type) {
            case 'text_delta':
                block.text = (block.text ?? '') + event.delta.text;
                result.text += event.delta.text;
                onText?.(result.text);
                break;
            case 'thinking_delta':
                block.thinking = (block.thinking ?? '') + event.delta.thinking;
                break;
            case 'signature_delta':
                block.signature = event.delta.signature;
                break;
            }
            break;
        }
        case 'message_delta':
            result.stopReason = event.delta?.stop_reason ?? result.stopReason;
            result.stopDetails = event.delta?.stop_details ?? result.stopDetails;
            break;
        case 'error':
            throw new ApiError(event.error?.type, event.error?.message);
        }
    }

    if (!result.stopReason)
        throw new ApiError('incomplete_stream', 'The connection closed before the answer was complete.');

    result.content = result.content.filter(Boolean);
    return result;
}

function logDroppedThinking(transformations) {
    for (const {type, path, reason} of transformations ?? []) {
        if (type === 'thinking_dropped' && reason === 'prefix_binding_mismatch')
            console.warn(`Gnaude: the API dropped an invalidated thinking block at ${path}`);
    }
}
