'use strict';

/**
 * The chat file: what is kept, what is dropped, and which conversation is which.
 *
 * The panel persists a conversation so a reload does not throw it away, and the rules that decide its shape —
 * the title, the workspace grouping, the bounds — are pure functions here. The tests drive them with plain
 * objects, which is what lets the file format be pinned without an editor or a filesystem.
 */

const { test, ok, equal } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');

const store = compiled('ai/chatStore');

const turn = (role, text) => ({ role, text });

test('a junk or truncated file is an empty store, never an error', () => {
    equal(store.parseStore(undefined), { version: 1, chats: [] });
    equal(store.parseStore(''), { version: 1, chats: [] });
    equal(store.parseStore('{ not json'), { version: 1, chats: [] });
    equal(store.parseStore('null'), { version: 1, chats: [] });
    equal(store.parseStore('{"chats":"nope"}'), { version: 1, chats: [] });
});

test('unusable entries are dropped and usable ones kept', () => {
    const parsed = store.parseStore(JSON.stringify({
        version: 1,
        chats: [
            null,
            { id: '', turns: [] },
            { id: 'good', workspace: '/w', updatedAt: 5, turns: [turn('user', 'hello'), turn('narrator', '?'), turn('assistant', 'hi')] }
        ]
    }));
    equal(parsed.chats.length, 1);
    equal(parsed.chats[0].id, 'good');
    equal(parsed.chats[0].turns.map((t) => t.role), ['user', 'assistant'], 'an unknown role is not a turn');
    equal(parsed.chats[0].title, 'hello', 'the title comes from the first question');
});

test('the title is the first question, one line, cut to fit', () => {
    equal(store.titleFor([]), 'New chat');
    equal(store.titleFor([turn('assistant', 'hi')]), 'New chat');
    equal(store.titleFor([turn('user', '\n  \nFix the blink loop please\nmore')]), 'Fix the blink loop please');
    const long = store.titleFor([turn('user', 'x'.repeat(200))]);
    equal(long.length, 60);
    ok(long.endsWith('…'), 'a cut title says it was cut');
});

test('upsert replaces by id, renames from the turns and keeps the newest first', () => {
    const one = { ...store.newChat('a', '/w', 1), turns: [turn('user', 'first question')] };
    let s = store.upsertChat(store.emptyStore(), one);
    equal(s.chats.length, 1);
    equal(s.chats[0].title, 'first question');

    const renamed = { ...one, title: 'kept name' };
    s = store.upsertChat(s, renamed);
    equal(s.chats.length, 1, 'the same id is replaced, not duplicated');
    equal(s.chats[0].title, 'kept name');

    const later = { ...store.newChat('b', '/w', 2), turns: [] };
    s = store.upsertChat(s, later);
    equal(s.chats.map((c) => c.id), ['b', 'a'], 'newest first');
});

test('a conversation is listed only in its own workspace', () => {
    let s = store.emptyStore();
    s = store.upsertChat(s, { ...store.newChat('in-project', '/proj', 1), turns: [] });
    s = store.upsertChat(s, { ...store.newChat('elsewhere', '/other', 2), turns: [] });
    s = store.upsertChat(s, { ...store.newChat('no-window', undefined, 3), turns: [] });

    equal(store.chatsFor(s, '/proj').map((c) => c.id), ['in-project']);
    equal(store.chatsFor(s, '/other').map((c) => c.id), ['elsewhere']);
    equal(store.chatsFor(s, undefined).map((c) => c.id), ['no-window'], 'an empty window has its own list');
});

test('remove drops one chat and leaves the rest', () => {
    let s = store.emptyStore();
    s = store.upsertChat(s, { ...store.newChat('a', '/w', 1), turns: [] });
    s = store.upsertChat(s, { ...store.newChat('b', '/w', 2), turns: [] });
    equal(store.removeChat(s, 'a').chats.map((c) => c.id), ['b']);
});

test('the file stays bounded in both directions', () => {
    let s = store.emptyStore();
    for (let i = 0; i < store.MAX_CHATS + 5; i += 1) {
        s = store.upsertChat(s, { ...store.newChat(`chat-${i}`, '/w', i), turns: [] });
    }
    equal(s.chats.length, store.MAX_CHATS, 'no more chats than the cap');
    equal(s.chats[0].id, `chat-${store.MAX_CHATS + 4}`, 'and the newest are the ones kept');

    const long = { ...store.newChat('long', '/w', 1), turns: [] };
    for (let i = 0; i < store.MAX_TURNS + 20; i += 1) long.turns.push(turn('user', `q${i}`));
    const trimmed = store.upsertChat(store.emptyStore(), long);
    equal(trimmed.chats[0].turns.length, store.MAX_TURNS);
    equal(trimmed.chats[0].turns[trimmed.chats[0].turns.length - 1].text, `q${store.MAX_TURNS + 19}`, 'the newest turns survive');
});
