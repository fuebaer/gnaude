// Turns stored conversations into Messages API requests.
// Plain JS only, so it can be unit-tested with `gjs -m`.
//
// Current models bind each thinking block to the exact conversation prefix that
// produced it (system prompt and every earlier message). Answers are therefore
// stored as the raw content blocks and replayed verbatim, the system prompt is
// frozen per conversation, and the history is only ever appended to.

export const SYSTEM_PROMPT = `You are Gnaude, an assistant built into the user's GNOME desktop. \
The user types prompts into a small launcher dialog and reads your replies there; \
they may ask follow-up questions. \
Answer in the language of the prompt and get to the point. \
The dialog renders basic Markdown (headings, bold, italic, lists, inline code, code blocks) \
but no tables or images.`;

/** @returns {import('./history.js').Turn|null} */
export function lastTurn(conversation) {
    return conversation?.turns[conversation.turns.length - 1] ?? null;
}

export function isPending(conversation) {
    return lastTurn(conversation)?.status === 'pending';
}

/**
 * Content blocks to echo for a stored answer. After a mid-output fallback only
 * the text blocks before the last `fallback` block may be echoed; everything
 * from that block on goes back unchanged.
 */
export function replayContent(content) {
    const boundary = content.findLastIndex(block => block.type === 'fallback');
    if (boundary < 0)
        return content;
    return content.filter((block, index) => index >= boundary || block.type === 'text');
}

/**
 * Messages for the request that answers the conversation's last (pending) turn:
 * every finished turn with its answer replayed verbatim, then the new prompt.
 * Failed or cancelled turns are left out entirely. Later answers were produced
 * without them, so leaving them out keeps the history append-only.
 */
export function buildMessages(conversation) {
    const messages = [];
    for (const turn of conversation.turns.slice(0, -1)) {
        if (turn.status !== 'done')
            continue;

        const content = replayContent(turn.content ?? [{type: 'text', text: turn.response}]);
        if (!content.some(block => block.type === 'text' && block.text))
            continue;

        messages.push({role: 'user', content: turn.prompt}, {role: 'assistant', content});
    }
    messages.push({role: 'user', content: lastTurn(conversation).prompt});
    return messages;
}
