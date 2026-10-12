'use strict';

/**
 * The pre-flight scope check.
 *
 * The numbers in these tests are the *test project's*, not invented: `main.rs` really is 41,542 bytes, the
 * default window really is 8192 with 4096 reserved for the answer. The point of pinning them is that the claim
 * "this request was impossible" becomes checkable — if a default moves, this suite says so rather than letting
 * the feature quietly start sending prompts the model cannot read.
 */

const { test, ok, notOk, equal, contains, notContains, compiled } = require('../../lib/harness');
const { checkScope, namedRustFile, intentHit, scopeLogLine, looksLikeChangeRequest, MIN_ANSWER_TOKENS } =
    compiled('ai/scope');
const { estimateTokens, promptRoom, MAX_METHOD_LINES } = compiled('ai/assistant');
// From the module that owns it: `assistant.ts` *imports* this for its own arithmetic and does not re-export it.
const { DEFAULT_CONTEXT_SIZE } = compiled('ai/modelSpecs');

/** A prompt of roughly `tokens` tokens, as the estimator counts it (4 characters per token). */
const promptOf = (tokens) => [{ role: 'user', content: 'x'.repeat(tokens * 4) }];

/** The settings the failing case ran under: the bundled default window and answer budget. */
const bundled = (messages, extra = {}) => ({
    messages,
    contextSize: DEFAULT_CONTEXT_SIZE,
    maxTokens: 4096,
    ...extra
});

test('the default window really cannot hold the test project main.rs', () => {
    // The arithmetic the whole feature rests on, asserted directly: 41,542 bytes of Rust is ~10,386 tokens
    // against the ~4,032 the default configuration leaves for a prompt.
    const mainRs = 'x'.repeat(41542);
    const tokens = estimateTokens(mainRs);
    const room = promptRoom(DEFAULT_CONTEXT_SIZE, 4096);
    equal(tokens, 10386, 'a 41,542-byte file is ~10,386 tokens');
    equal(room, 4032, 'and the default window leaves 4,032 of its 8192 for the prompt');
    ok(tokens > room * 2, 'so the file is more than twice the prompt room it would need to fit in');
});

test('a request that fits is sent without comment', () => {
    const verdict = checkScope(bundled(promptOf(500)));
    ok(verdict.ok, 'a small request is fine');
    equal(verdict.problem, undefined, 'with nothing to report');
    notOk(verdict.handoff, 'and nothing to hand off');
    equal(verdict.facts.promptTokens, 500, 'the measured prompt is reported back');
    equal(verdict.facts.room, 4032, 'along with the room it was measured against');
});

test('a prompt the model cannot read is refused, with both numbers in the message', () => {
    const verdict = checkScope(bundled(promptOf(5000)));
    notOk(verdict.ok, 'a 5,000-token prompt against 4,032 of room is refused');
    equal(verdict.problem, 'prompt-overflow', 'for the reason that it does not fit');
    contains(verdict.message, '5000 tokens', 'the message says how big the request is');
    contains(verdict.message, '4032 left for the prompt', 'and how little room the model has');
    ok(verdict.handoff, 'and it is worth handing off');
    ok(Boolean(verdict.advice), 'with something to do about it');
});

test('the file a request must reproduce whole is measured too', () => {
    // The prompt itself is small here, so this is the file check and not the prompt one: that separation is the
    // reason the message can name the file instead of talking about tokens in the abstract.
    const verdict = checkScope(
        bundled(promptOf(200), { target: { path: 'src/main.rs', text: 'x'.repeat(41542) } })
    );
    notOk(verdict.ok, 'a 41 KB target file is refused');
    equal(verdict.problem, 'file-too-big', 'as a file problem, not a prompt problem');
    contains(verdict.message, 'src/main.rs', 'the message names the file');
    contains(verdict.message, '10386 tokens', 'and its measured size');
    equal(verdict.facts.targetTokens, 10386, 'which is carried in the facts');

    const small = checkScope(
        bundled(promptOf(200), { target: { path: 'src/ui_handlers.rs', text: 'x'.repeat(381) } })
    );
    ok(small.ok, 'the same check passes a 381-byte file, so naming a file is not itself a refusal');
});

test('an item longer than the rewrite limit is refused by name and length', () => {
    const item = { name: 'main', text: `${'    let x = 1;\n'.repeat(852)}` };
    const verdict = checkScope(bundled(promptOf(200), { item }));
    notOk(verdict.ok, 'an 852-line item is refused');
    equal(verdict.problem, 'item-too-long', 'for its length');
    contains(verdict.message, 'main is 853 lines', 'the message names the item and counts its lines');
    contains(verdict.message, String(MAX_METHOD_LINES), 'and quotes the limit it broke');
    equal(verdict.facts.itemLines, 853, 'the line count is carried in the facts');
});

test('a sentence that asks for a whole file is refused, quoting what was read', () => {
    for (const request of [
        'rewrite the whole file with the new pin',
        'please give me the entire file',
        'replace the file with this'
    ]) {
        const verdict = checkScope(bundled(promptOf(200), { request }));
        notOk(verdict.ok, `"${request}" is refused`);
        equal(verdict.problem, 'whole-file-intent', 'as a whole-file request');
        contains(verdict.message, 'read as:', 'the warning says it is a reading, not a fact');
        ok(verdict.handoff, 'and it can be handed off');
    }
});

test('naming a file is not by itself a whole-file request', () => {
    // The distinction that keeps the intent check from refusing good work: "rewrite src/main.rs" only names a
    // file, and the arithmetic above decides whether that file is too big. If the file is small, this passes.
    equal(namedRustFile('rewrite src/main.rs with the new pin'), 'src/main.rs', 'the path is extracted');
    equal(namedRustFile('change ui_handlers.rs'), 'ui_handlers.rs', 'a bare name counts');
    equal(namedRustFile('make the LED blink'), undefined, 'and no name means nothing to measure');
    equal(namedRustFile('a sentence about .rs files in general'), undefined, 'a bare suffix is not a file');
    ok(
        checkScope(bundled(promptOf(200), { request: 'rewrite src/main.rs' })).ok,
        'so the sentence alone does not refuse — the size of the file does the deciding'
    );
});

test('work that spans files is refused as beyond the model', () => {
    for (const request of [
        'refactor the whole project',
        'migrate the codebase to embassy',
        'add a new crate for the display',
        'write me a complete app that logs temperature'
    ]) {
        const verdict = checkScope(bundled(promptOf(200), { request }));
        notOk(verdict.ok, `"${request}" is refused`);
        equal(verdict.problem, 'beyond-model', 'as work this model cannot hold');
    }
});

test('the worst problem is the one reported', () => {
    // A prompt that is too big *and* asks for a refactor is reported as too big: reporting both buries the one
    // that a setting can fix, and the refactor may well be fine once the prompt fits.
    const verdict = checkScope(bundled(promptOf(5000), { request: 'refactor the whole project' }));
    equal(verdict.problem, 'prompt-overflow', 'size is reported before intent');
});

test('a starved answer is refused even when the prompt fits', () => {
    // Narrow on purpose, and worth saying so: with sane settings the prompt check fires first. This is the case
    // where the answer budget was lowered below the floor and the prompt is nearly filling the window.
    const verdict = checkScope({ messages: promptOf(7700), contextSize: 8192, maxTokens: 256 });
    notOk(verdict.ok, 'a 7,700-token prompt with a 256-token answer budget is refused');
    equal(verdict.problem, 'answer-starved', 'because the answer has no room');
    ok(verdict.facts.answerTokens < MIN_ANSWER_TOKENS, 'which is what the facts say');
});

test('the user can always override an abort', () => {
    const verdict = checkScope(bundled(promptOf(5000), { forced: true }));
    ok(verdict.ok, 'a forced request is sent');
    equal(verdict.problem, 'prompt-overflow', 'with the reason kept');
    ok(verdict.overridden, 'and marked as overridden so the log can say so');
    ok(verdict.handoff, 'while still being something worth handing off next time');
});

test('the log line carries the numbers either way', () => {
    contains(scopeLogLine(checkScope(bundled(promptOf(500)))), 'scope: ok', 'a sent request says so');
    contains(scopeLogLine(checkScope(bundled(promptOf(5000)))), 'scope: refused (prompt-overflow)', 'a refusal names its reason');
    contains(scopeLogLine(checkScope(bundled(promptOf(5000), { forced: true }))), 'overridden', 'an override is recorded');
    contains(scopeLogLine(checkScope(bundled(promptOf(500)))), 'prompt=500/4032', 'and the numbers are always there');
});

test('intentHit reports the phrase it matched, not just that it matched', () => {
    equal(intentHit([/\bre-?facto?r\s+(?:the\s+)?project\b/i], 'please refactor project now'), 'refactor project', 'the hit is quoted verbatim');
    equal(intentHit([/\bnothing\b/], 'a sentence with no match'), undefined, 'and nothing matched is undefined');
    notContains(JSON.stringify(checkScope(bundled(promptOf(200), { request: 'refactor the whole project' }))), 'undefined', 'no verdict carries an undefined in its text');
});

test('a change request is told from a question by its verb', () => {
    // This is what lets the chat measure the file in front of the developer for "add a timeout here" but not for
    // "why does this deadlock?" — a clipped view answers a question; it cannot safely change a file.
    for (const change of ['add a timeout to the loop', 'fix the pin number', 'implement this', 'remove that delay', 'switch it to GPIO 15']) {
        ok(looksLikeChangeRequest(change), `"${change}" reads as a change`);
    }
    for (const question of ['why does this deadlock?', 'what does this function do', 'is embassy on the crate list']) {
        notOk(looksLikeChangeRequest(question), `"${question}" reads as a question`);
    }
    equal(looksLikeChangeRequest(''), false, 'and nothing at all is not a change');
});
