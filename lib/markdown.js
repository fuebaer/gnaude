// Converts the Markdown subset Claude typically produces into Pango markup.
// Supported: headings, bold, italic, inline code, fenced code blocks, lists,
// block quotes and links. Anything else is shown as plain text.

import GLib from 'gi://GLib';

const escape = text => GLib.markup_escape_text(text, -1);

function inline(text) {
    // Split off code spans first so their content is not formatted.
    return text.split(/(`[^`]+`)/).map(part => {
        if (/^`[^`]+`$/.test(part))
            return `<tt>${escape(part.slice(1, -1))}</tt>`;

        return escape(part)
            .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<u>$1</u> <span fgalpha="60%">($2)</span>')
            .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
            .replace(/__(.+?)__/g, '<b>$1</b>')
            .replace(/(^|[^*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, '$1<i>$2</i>')
            .replace(/~~(.+?)~~/g, '<s>$1</s>');
    }).join('');
}

/**
 * @param {string} markdown
 * @returns {string} Pango markup
 */
export function markdownToPango(markdown) {
    const out = [];
    let inFence = false;

    for (const line of markdown.split('\n')) {
        if (/^\s*```/.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) {
            out.push(`<tt>${escape(line)}</tt>`);
            continue;
        }

        let match;
        if ((match = line.match(/^(#{1,6})\s+(.*)$/))) {
            const size = match[1].length <= 2 ? 'large' : 'medium';
            out.push(`<span size="${size}" weight="bold">${inline(match[2])}</span>`);
        } else if ((match = line.match(/^(\s*)[-*+]\s+(.*)$/))) {
            out.push(`${match[1]}  •  ${inline(match[2])}`);
        } else if ((match = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/))) {
            out.push(`${match[1]}  ${match[2]}.  ${inline(match[3])}`);
        } else if ((match = line.match(/^>\s?(.*)$/))) {
            out.push(`<span fgalpha="70%"><i>▍ ${inline(match[1])}</i></span>`);
        } else if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
            out.push('<span fgalpha="40%">────────────</span>');
        } else {
            out.push(inline(line));
        }
    }
    return out.join('\n');
}

/**
 * Strips Markdown syntax for one-line previews (menu, notifications).
 *
 * @param {string} markdown
 * @returns {string} plain text
 */
export function markdownToPlain(markdown) {
    return markdown
        .replace(/^\s*```.*$/gm, '')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '• ')
        .replace(/^>\s?/gm, '')
        .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
        .replace(/\*\*|__|~~|`/g, '')
        .replace(/(^|[^*\w])\*(?!\s)(.+?)(?<!\s)\*/g, '$1$2');
}
