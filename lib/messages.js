// User-visible texts for conversation state, shared by the dialog, the menu and
// notifications. Shell process only. The gettext functions only work after the
// extension object exists, so nothing here may run at import time.

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {lastTurn} from './conversation.js';
import {markdownToPlain} from './markdown.js';
import {findModel} from './models.js';

export const oneLine = text => text.replace(/\s+/g, ' ').trim();

function phaseText(phase) {
    switch (phase) {
    case 'thinking':
        return _('thinking …');
    case 'writing':
        return _('writing …');
    case 'fallback':
        return _('fallback model takes over …');
    default:
        return _('connecting …');
    }
}

function outcomeText(status) {
    switch (status) {
    case 'done':
        return _('done');
    case 'refused':
        return _('declined');
    case 'cancelled':
        return _('cancelled');
    default:
        return _('error');
    }
}

/** Status line for a conversation, e.g. "Claude Opus 5.5 · writing …". */
export function statusText(conversation) {
    const turn = lastTurn(conversation);
    const parts = [findModel(turn.model ?? conversation.model).name];
    if (turn.status === 'pending') {
        parts.push(phaseText(turn.phase));
    } else {
        parts.push(outcomeText(turn.status));
        if (turn.fellBack)
            parts.push(_('fallback model'));
        if (turn.truncated)
            parts.push(_('cut off (maximum length)'));
    }
    return parts.join(' · ');
}

/** Why a turn has no (complete) answer, or null if it has one. */
export function errorText(turn) {
    switch (turn.errorCode) {
    case undefined:
        // Entries from version 1 stored a ready-made message.
        return turn.status === 'done' || turn.status === 'pending' ? null : turn.error ?? null;
    case 'missing_api_key':
        return _('No API key set. Add one in the Gnaude preferences.');
    case 'interrupted':
        return _('Interrupted (the extension was reloaded).');
    case 'cancelled':
        return _('Cancelled.');
    case 'incomplete_stream':
        return _('The connection closed before the answer was complete.');
    case 'refusal': {
        let text = turn.refusalCategory
            // Translators: %s is a refusal category reported by the API, e.g. "cyber"
            ? _('Claude declined this request (category: %s).').format(turn.refusalCategory)
            : _('Claude declined this request.');
        if (turn.error)
            text += ` ${turn.error}`;
        return text;
    }
    default:
        return turn.error ?? turn.errorCode;
    }
}

/** One-line summary of the last answer, for the menu and notifications. */
export function previewText(conversation) {
    const turn = lastTurn(conversation);
    const answer = oneLine(markdownToPlain(turn.response ?? ''));
    switch (turn.status) {
    case 'pending':
        return answer || _('Writing the answer …');
    case 'done':
        return answer || _('(empty answer)');
    default:
        return errorText(turn) ?? outcomeText(turn.status);
    }
}
