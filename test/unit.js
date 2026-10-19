// Tests for the shell-independent modules. Run via `make test`, which starts
// test/mock_server.py and passes its URL as the first argument.

import './shell-env.js'; // must stay first
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';

import {AnthropicClient, ApiError} from '../lib/anthropic.js';
import {buildMessages, replayContent} from '../lib/conversation.js';
import {HistoryStore} from '../lib/history.js';
import {markdownToPango, markdownToPlain} from '../lib/markdown.js';

const [baseUrl] = ARGV;
let failures = 0;

function check(name, condition, detail = '') {
    print(`${condition ? 'ok  ' : 'FAIL'} ${name}${condition || !detail ? '' : ` -- ${detail}`}`);
    if (!condition)
        failures++;
}

async function lastRequest() {
    const session = new Soup.Session();
    const bytes = await session.send_and_read_async(
        Soup.Message.new('GET', `${baseUrl}/last`), GLib.PRIORITY_DEFAULT, null);
    return JSON.parse(new TextDecoder().decode(bytes.get_data()));
}
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const client = new AnthropicClient({baseUrl});
const params = {apiKey: 'sk-test', model: 'claude-opus-5-5', effort: 'low', system: 'sys', fallbacks: true};
const ask = prompt => [{role: 'user', content: prompt}];

async function testStream() {
    const phases = [];
    let updates = 0;
    const result = await client.stream({
        ...params,
        messages: ask('Hallo'),
        onPhase: p => phases.push(p),
        onText: () => updates++,
    });
    check('stream: text is concatenated', result.text.startsWith('# Antwort') && result.text.endsWith('Fertig & gut.'));
    check('stream: stop reason', result.stopReason === 'end_turn', result.stopReason);
    check('stream: model from message_start', result.model === 'claude-opus-5-5');
    check('stream: phases', phases.join() === 'thinking,writing', phases.join());
    check('stream: one update per delta', updates === 5, String(updates));
    check('stream: content keeps the signed thinking block and the text',
        result.content.length === 2 && result.content[0].type === 'thinking' &&
        result.content[0].signature.startsWith('sig_') && result.content[1].text === result.text,
        JSON.stringify(result.content));

    const {headers, body} = await lastRequest();
    check('request: api key header', headers['x-api-key'] === 'sk-test');
    check('request: version header', headers['anthropic-version'] === '2023-06-01');
    check('request: beta headers', headers['anthropic-beta'] ===
        'thinking-binding-controls-2026-08-01,server-side-fallback-2026-07-01', headers['anthropic-beta']);
    check('request: fallbacks default', body.fallbacks === 'default');
    check('request: effort', body.output_config?.effort === 'low');
    check('request: streaming + max_tokens', body.stream === true && body.max_tokens === 64000);
    check('request: drop invalidated thinking instead of failing',
        body.thinking?.type === 'adaptive' && body.thinking.block_binding?.prefix_mismatch_behavior === 'drop_block');
    check('request: automatic prompt caching', body.cache_control?.type === 'ephemeral');
}

async function testNoFallbacks() {
    await client.stream({...params, model: 'claude-haiku-5-5', fallbacks: false, messages: ask('Hallo')});
    const {headers, body} = await lastRequest();
    check('haiku: no fallbacks param', !('fallbacks' in body));
    check('haiku: no fallback beta header', headers['anthropic-beta'] === 'thinking-binding-controls-2026-08-01');
}

async function testAuthError() {
    try {
        await client.stream({...params, messages: ask('AUTHFAIL')});
        check('401: throws', false);
    } catch (e) {
        check('401: ApiError with message', e instanceof ApiError && e.status === 401 &&
            e.message === 'invalid x-api-key', `${e.name}: ${e.message}`);
    }
}

async function testRefusal() {
    const result = await client.stream({...params, messages: ask('REFUSE')});
    check('refusal: stop reason', result.stopReason === 'refusal');
    check('refusal: category', result.stopDetails?.category === 'cyber');
}

async function testCancel() {
    const cancellable = new Gio.Cancellable();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        cancellable.cancel();
        return GLib.SOURCE_REMOVE;
    });
    try {
        await client.stream({...params, messages: ask('SLOW'), cancellable});
        check('cancel: throws', false);
    } catch (e) {
        check('cancel: CANCELLED error', e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED), e.message);
    }
}

// A real follow-up through the client: the mock rejects replayed thinking blocks
// whose conversation prefix changed, like the API does.
async function testFollowUp() {
    const conversation = {model: 'claude-opus-5-5', system: 'sys', turns: [
        {prompt: 'Erste Frage', status: 'pending'},
    ]};
    const send = () => client.stream({...params, system: conversation.system, messages: buildMessages(conversation)});

    const first = await send();
    Object.assign(conversation.turns[0], {status: 'done', response: first.text, content: first.content});
    conversation.turns.push({prompt: 'Abgebrochen', status: 'cancelled', response: 'halb'});
    conversation.turns.push({prompt: 'Zweite Frage', status: 'pending'});

    const second = await send();
    const {body} = await lastRequest();
    check('follow-up: history is replayed and accepted', second.text.startsWith('# Antwort 2'), second.text);
    check('follow-up: cancelled turn is left out',
        body.messages.map(m => m.role).join() === 'user,assistant,user' &&
        body.messages[2].content === 'Zweite Frage', JSON.stringify(body.messages.map(m => m.role)));
    check('follow-up: answer replayed verbatim',
        JSON.stringify(body.messages[1].content) === JSON.stringify(first.content));

    conversation.turns[0].prompt = 'Erste Frage, nachträglich geändert';
    try {
        await send();
        check('follow-up: edited history is rejected by the mock', false);
    } catch (e) {
        check('follow-up: edited history is rejected by the mock',
            e instanceof ApiError && e.type === 'invalid_request_error', e.message);
    }
}

function testReplay() {
    const content = [
        {type: 'thinking', thinking: '', signature: 'a'},
        {type: 'text', text: 'partial'},
        {type: 'fallback', from: {model: 'x'}, to: {model: 'y'}},
        {type: 'thinking', thinking: '', signature: 'b'},
        {type: 'text', text: 'rest'},
    ];
    check('replay: before a fallback only text is echoed',
        replayContent(content).map(b => b.signature ?? b.type).join() === 'text,fallback,b,text');
    check('replay: without fallback everything is echoed', replayContent(content.slice(0, 2)).length === 2);
    check('replay: version 1 answers become a text block',
        JSON.stringify(buildMessages({turns: [
            {prompt: 'a', status: 'done', response: 'A'}, {prompt: 'b', status: 'pending'},
        ]})[1]) === JSON.stringify({role: 'assistant', content: [{type: 'text', text: 'A'}]}));
}

async function testHistory() {
    const dir = GLib.dir_make_tmp('gnaude-test-XXXXXX');
    const path = GLib.build_filenamev([dir, 'sub', 'history.json']);
    const prompts = store => store.conversations.map(c => c.turns.map(t => t.prompt).join('+')).join();

    const store = new HistoryStore({path, maxEntries: 2});
    let changes = 0;
    store.connect('changed', () => changes++);
    const a = store.startTurn({prompt: 'a', model: 'm', system: 's'});
    store.progress(a.id, {response: 'partial'});
    check('history: progress does not emit changed', changes === 1, String(changes));
    store.finish(a.id, {status: 'done', response: 'A'});
    const b = store.startTurn({prompt: 'b', model: 'm', system: 's'});
    store.finish(b.id, {status: 'done', response: 'B'});
    store.startTurn({conversationId: a.id, prompt: 'a2', model: 'other', system: 'other'});
    check('history: follow-up moves the chat to the front', prompts(store) === 'a+a2,b', prompts(store));
    check('history: chat keeps its model and system prompt', a.model === 'm' && a.system === 's');
    check('history: each turn records its model', a.turns.every(t => t.model === 'm'));
    store.setModel(a.id, 'm2');
    check('history: model switch applies to the chat', a.model === 'm2' && a.turns[1].model === 'm');
    store.setModel(a.id, 'm');
    const c = store.startTurn({prompt: 'c', model: 'm', system: 's'});
    check('history: trimmed to maxEntries, pending chats kept', prompts(store) === 'c,a+a2', prompts(store));
    store.clear();
    check('history: clear keeps running chats', prompts(store) === 'c,a+a2', prompts(store));
    store.finish(a.id, {status: 'done', response: 'A2'});
    await store.flush();

    const mode = Gio.File.new_for_path(path).query_info('unix::mode', 0, null).get_attribute_uint32('unix::mode');
    check('history: file is private (0600)', (mode & 0o777) === 0o600, (mode & 0o777).toString(8));

    const reloaded = new HistoryStore({path, maxEntries: 10});
    await reloaded.load();
    check('history: reload keeps order (latest prompt first)', prompts(reloaded) === 'c,a+a2', prompts(reloaded));
    const interrupted = reloaded.get(c.id).turns[0];
    check('history: pending turn becomes interrupted on reload',
        interrupted.status === 'cancelled' && interrupted.errorCode === 'interrupted');
    check('history: phase is not persisted', !('phase' in interrupted));

    reloaded.clear();
    check('history: clear', reloaded.conversations.length === 0);
}

async function testEffort() {
    const path = GLib.build_filenamev([GLib.dir_make_tmp('gnaude-test-XXXXXX'), 'history.json']);
    const store = new HistoryStore({path, maxEntries: 10});
    const plain = store.startTurn({prompt: 'p', model: 'm', system: 's'});
    const tuned = store.startTurn({prompt: 't', model: 'm', system: 's', effort: 'high'});
    check('effort: new chats follow the preferences by default', plain.effort === null);
    check('effort: a new chat can start with an override', tuned.effort === 'high');
    store.startTurn({conversationId: tuned.id, prompt: 't2', model: 'm', system: 's', effort: 'low'});
    check('effort: follow-ups keep the chat override', tuned.effort === 'high');
    store.setEffort(tuned.id, null);
    check('effort: override can be cleared', tuned.effort === null);
    await store.flush();
}

async function testMigration() {
    const dir = GLib.dir_make_tmp('gnaude-test-XXXXXX');
    const path = GLib.build_filenamev([dir, 'history.json']);
    const v1 = [
        {id: 'n', prompt: 'neu', response: 'Neu', model: 'claude-opus-5-5', status: 'done', createdAt: 2, finishedAt: 3},
        {id: 'o', prompt: 'alt', response: '', model: 'claude-opus-5-5', status: 'error', error: 'kaputt', createdAt: 1},
    ];
    GLib.file_set_contents(path, JSON.stringify(v1));

    const store = new HistoryStore({path, maxEntries: 10});
    await store.load();
    const [neu, alt] = store.conversations;
    check('migration: entries become one-turn chats',
        neu.id === 'n' && neu.turns.length === 1 && neu.turns[0].response === 'Neu' && neu.updatedAt === 3);
    check('migration: errors are kept', alt.turns[0].status === 'error' && alt.turns[0].error === 'kaputt');
    check('migration: turns keep their model', neu.turns[0].model === 'claude-opus-5-5');
    store.startTurn({conversationId: 'n', prompt: 'weiter', model: 'x', system: 'frozen'});
    check('migration: first follow-up freezes the system prompt', neu.system === 'frozen');
}

function testMarkdown() {
    const md = '# Titel\n**fett** und *kursiv* und `a<b>`\n- eins\n```\nx < y && z\n```\n[Link](https://example.com)';
    const markup = markdownToPango(md);
    let valid = true;
    try {
        Pango.parse_markup(markup, -1, '');
    } catch (e) {
        valid = false;
    }
    check('markdown: valid pango markup', valid, markup);
    check('markdown: bold/italic', markup.includes('<b>fett</b>') && markup.includes('<i>kursiv</i>'));
    check('markdown: inline code escaped', markup.includes('<tt>a&lt;b&gt;</tt>'));
    check('markdown: fenced code escaped', markup.includes('<tt>x &lt; y &amp;&amp; z</tt>'));
    check('markdown: list bullet', markup.includes('•  eins'));
    check('markdown: snake_case untouched', markdownToPango('my_var_name') === 'my_var_name');

    const plain = markdownToPlain('# Antwort\n\nDas ist **fett**, *kursiv*, `code` und [Link](https://x.y).\n- eins');
    check('plain: markup stripped', plain === 'Antwort\n\nDas ist fett, kursiv, code und Link.\n• eins', JSON.stringify(plain));
}

const loop = new GLib.MainLoop(null, false);
(async () => {
    try {
        await testStream();
        await testNoFallbacks();
        await testAuthError();
        await testRefusal();
        await testCancel();
        await testFollowUp();
        testReplay();
        await testHistory();
        await testEffort();
        await testMigration();
        testMarkdown();
    } catch (e) {
        check(`unexpected exception: ${e.message}`, false, e.stack);
    }
    loop.quit();
})();
loop.run();

print(failures ? `\n${failures} test(s) failed` : '\nall tests passed');
System.exit(failures ? 1 : 0);
