'use strict';

/**
 * The J-Code driver, asserted against the run that measured it.
 *
 * The contract in `src/ai/jcode.ts` was recorded from the real binary (`jcode` v0.75.0) on 2026-10-13; that
 * recording is `tests/layers/t2-cli/fixtures/jcode-run.ndjson`, and it is used here directly, so a parser change
 * has to keep reading the *actual* output of the CLI rather than a shape invented for the test.
 *
 * What is pinned, and why each one matters:
 *   - the message is the **last argument** (the opposite of pool's stdin), so it is also the last thing in the
 *     argument list;
 *   - a `tool_input` carries **no id**, and a long argument arrives in several deltas: they have to land on the
 *     call that was opened last, in order;
 *   - the closing `done.text` is the answer — and the narration is kept for a run that died before sending one;
 *   - the token counts are per *request*, so "what was sent" is the largest prompt and "what was generated" is
 *     the sum (a multi-round run must not be reported as a small one);
 *   - exit 0 means the run finished, and the record's own caveats are what the report repeats — no second exit
 *     code is invented, because none was measured.
 */

const fs = require('fs');
const path = require('path');
const { test, ok, notOk, equal, contains, notContains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');

const jcode = compiled('ai/jcode');

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 't2-cli', 'fixtures', 'jcode-run.ndjson'), 'utf8');

test('the message is the last argument, and the project folder is passed as one', () => {
    const args = jcode.jcodeArgs({
        prompt: 'Take over this change.',
        directory: '/tmp/proj'
    });
    equal(args[0], 'run', 'it is the run subcommand');
    contains(args.join(' '), '--ndjson', 'with the measured machine-readable output flag');
    contains(args.join(' '), '--quiet', 'and quiet, which is what keeps stdout to NDJSON alone');
    contains(args.join(' '), '--no-update', 'never auto-updating the CLI underneath a run');
    ok(args.includes('-C') && args.includes('/tmp/proj'), 'the project folder is passed with -C');
    equal(args[args.length - 1], 'Take over this change.', 'the message is the last argument');

    // The flags a hand-off can add, each in the CLI's own spelling.
    const full = jcode.jcodeArgs({
        prompt: 'x',
        directory: '/tmp/proj',
        provider: 'openai-compatible',
        model: 'agnes-2.5-flash',
        continueId: 'session_calf_1_ab'
    });
    ok(full.includes('-p') && full.includes('openai-compatible'), 'the provider goes in as -p');
    ok(full.includes('-m') && full.includes('agnes-2.5-flash'), 'the model as -m');
    ok(full.includes('--resume') && full.includes('session_calf_1_ab'), 'and the conversation as --resume');
    equal(full[full.length - 1], 'x', 'with the message still last, after every flag');

    // A message that begins with a dash would otherwise be read as a flag's value: being last is what makes that
    // impossible, which is the reason this shape is asserted rather than assumed.
    const dash = jcode.jcodeArgs({ prompt: '-not-a-flag', directory: '/tmp/proj' });
    equal(dash[dash.length - 1], '-not-a-flag');
});

test('the recorded run parses into the answer, the session and the work', () => {
    const record = jcode.parseJcodeNdjson(FIXTURE);
    equal(record.answer, 'done', 'the closing text is the answer, trimmed of the whitespace it streamed first');
    equal(record.runId, 'session_dolphin_1791901733357_8cd680a40913a606', 'the session id is what --resume takes');
    equal(record.model, 'agnes-2.5-flash');
    equal(record.provider, 'openrouter', 'the route is reported verbatim rather than translated');
    equal(record.stopReason, 'stop');
    equal(record.toolCalls.length, 1, 'one tool call');
    equal(record.toolCalls[0].name, 'write');
    // Reassembled from the deltas, which is the only way the arguments can be read: they arrive in pieces.
    contains(record.toolCalls[0].input, 'file_path', 'with the arguments it was given');
    contains(record.toolCalls[0].output, 'Created /tmp/jcode-probe/probe.txt', 'and with what the tool said it did');
    ok(record.types.start === 1 && record.types.text_delta === 3, 'the event census is kept, so an unknown shape shows up');
    notOk(Object.keys(record.types).some((type) => type.startsWith('(')), 'and nothing in the recorded run was unreadable');
});

test('the token counts say what was sent and what was generated', () => {
    // Per request, and a run makes one request per round of tool use — so a two-round run has two `tokens`
    // events, and reporting the last of them as the whole story would understate it.
    const text = [
        '{"input":12898,"output":88,"type":"tokens"}',
        '{"input":13055,"output":16,"type":"tokens"}',
        '{"session_id":"session_a_1_b","text":"ok","type":"done"}',
        ''
    ].join('\n');
    const record = jcode.parseJcodeNdjson(text);
    equal(record.promptTokens, 13055, 'the largest prompt is the whole conversation, and the last request carries it');
    equal(record.completionTokens, 104, 'while the generated tokens are the sum — 88 in the first round plus 16 in the second');
});

test('a run that never sent `done` still has its narration', () => {
    const text = [
        '{"session_id":"session_a_1_b","type":"start"}',
        '{"text":"Looking at ","type":"text_delta"}',
        '{"text":"the timer.","type":"text_delta"}',
        ''
    ].join('\n');
    const record = jcode.parseJcodeNdjson(text);
    equal(record.answer, 'Looking at the timer.', 'the streamed pieces become the answer when nothing closed it');
    equal(record.narration, 'Looking at the timer.');
    equal(record.runId, 'session_a_1_b', 'and the session id was in `start`, so it can still be continued');
});

test('tool input deltas land on the call that opened them, in order', () => {
    const text = [
        '{"id":"call_1","name":"write","type":"tool_start"}',
        '{"delta":"{\\"content\\": \\"he","type":"tool_input"}',
        '{"delta":"llo\\", \\"file_path\\": \\"src/main.rs\\"}","type":"tool_input"}',
        '{"id":"call_1","name":"write","type":"tool_exec"}',
        '{"error":null,"id":"call_1","name":"write","output":"Created src/main.rs","type":"tool_done"}',
        '{"id":"call_2","name":"bash","type":"tool_start"}',
        '{"delta":"{\\"command\\": \\"cargo build\\"}","type":"tool_input"}',
        '{"id":"call_2","name":"bash","type":"tool_exec"}',
        '{"id":"call_3","name":"read","type":"tool_start"}',
        '{"type":"done","text":"done"}',
        ''
    ].join('\n');
    const record = jcode.parseJcodeNdjson(text);
    equal(record.toolCalls.length, 3, 'every call is kept, in the order it started');
    equal(record.toolCalls[0].input, '{"content": "hello", "file_path": "src/main.rs"}', 'the pieces arrive in order');
    equal(record.toolCalls[1].input, '{"command": "cargo build"}', 'and each delta belongs to the call above it, not to the first one');
    equal(record.toolCalls[2].input, '', 'a call that was given no arguments has none');
    equal(record.toolCalls[2].output, undefined, 'and a call that never finished says nothing it did not say');
});

test('a line the parser does not know is counted, never fatal', () => {
    const text = [
        'not json at all',
        '{"type":"aShapeFromTheFuture","value":1}',
        '{"text":"still working","type":"text_delta"}',
        '{"session_id":"session_a_1_b","text":"still working","type":"done"}',
        ''
    ].join('\n');
    const record = jcode.parseJcodeNdjson(text);
    equal(record.answer, 'still working', 'the run is not lost to one unexpected line');
    equal(record.types['(unparsed)'], 1, 'an unreadable line is counted');
    equal(record.types['aShapeFromTheFuture'], 1, 'and so is an event type this parser has never seen');
});

test('a tool line names the tool, the file and what it did', () => {
    const ok = jcode.jcodeToolLine({
        id: 'call_1',
        name: 'write',
        input: '{"content": "hello", "file_path": "src/main.rs"}',
        output: 'Created src/main.rs (1 lines):\n1+ hello'
    });
    contains(ok, 'write', 'the tool');
    contains(ok, 'src/main.rs', 'the file');
    contains(ok, 'Created src/main.rs', 'and the tool\'s own words, which are the most useful part');

    const failed = jcode.jcodeToolLine({
        id: 'call_2',
        name: 'bash',
        input: '{"command": "cargo build"}',
        error: 'exit status 101'
    });
    contains(failed, 'bash', 'a failure names the tool');
    contains(failed, 'cargo build', 'and what it was asked to do');
    contains(failed, 'failed', 'and says it failed rather than showing an empty output');

    const unknown = jcode.jcodeToolLine({ id: 'call_3', name: 'some_future_tool', input: '' });
    equal(unknown, 'some_future_tool', 'a tool the extension has never seen reads as itself');
});

test('exit 0 is a finished run, with the record\'s own caveats repeated', () => {
    const done = jcode.describeJcodeRun({ code: 0, record: jcode.parseJcodeNdjson(FIXTURE), seconds: 42 });
    ok(done.ok, 'a clean run is ok');
    equal(done.kind, 'done');
    contains(done.message, 'complete', 'and says so plainly');

    // Exit 0 and still not a clean job: the record is where that shows, and each caveat changes what to do next.
    const withFailedTool = jcode.describeJcodeRun({
        code: 0,
        record: jcode.parseJcodeNdjson(
            [
                '{"id":"call_1","name":"write","type":"tool_start"}',
                '{"id":"call_1","name":"write","type":"tool_exec"}',
                '{"error":"permission denied","id":"call_1","name":"write","type":"tool_done"}',
                '{"type":"done","text":"I could not write the file."}',
                ''
            ].join('\n')
        ),
        seconds: 3
    });
    ok(withFailedTool.ok, 'the run itself finished');
    contains(withFailedTool.message, 'failed', 'but the failed tool call is reported rather than glossed over');

    const detail = jcode.describeJcodeRun({
        code: 0,
        record: jcode.parseJcodeNdjson('{"type":"done","text":"x","status_detail":"the write tool failed"}'),
        seconds: 3
    });
    contains(detail.message, 'the write tool failed', 'and the CLI\'s own note is repeated verbatim');

    const unfinished = jcode.describeJcodeRun({
        code: 0,
        record: jcode.parseJcodeNdjson('{"stop_reason":"tool_calls","type":"message_end"}\n{"type":"done","text":"x"}'),
        seconds: 3
    });
    contains(unfinished.message, 'tool_calls', 'a last message that was a tool call is named, so "finished" is not oversold');
});

test('the ways a run can go wrong each keep their own kind', () => {
    const record = jcode.parseJcodeNdjson('');
    equal(jcode.describeJcodeRun({ code: 1, missing: true, record, seconds: 1 }).kind, 'missing');
    contains(jcode.describeJcodeRun({ code: 1, missing: true, record, seconds: 1 }).message, 'jcode', 'and says which command was not found');
    equal(jcode.describeJcodeRun({ code: 1, timedOut: true, record, seconds: 900 }).kind, 'timeout');
    contains(
        jcode.describeJcodeRun({ code: 1, timedOut: true, record, seconds: 900 }).message,
        'on disk',
        'a stopped run says its changes are still there'
    );
    equal(jcode.describeJcodeRun({ code: 1, cancelled: true, record, seconds: 5 }).kind, 'cancelled');
    const error = jcode.describeJcodeRun({ code: 7, record, stderr: 'jcode: 401 Unauthorized', seconds: 2 });
    equal(error.kind, 'error');
    contains(error.message, '7', 'an unexpected exit code is reported as itself');
    contains(error.message, '401 Unauthorized', 'with the CLI\'s own words, which is where the reason is');
});

test('the version and the session names are read, not guessed', () => {
    equal(jcode.parseJcodeVersion('jcode v0.75.0 (5ae238574)'), '0.75.0');
    equal(jcode.parseJcodeVersion('jcode 1.2'), '1.2');
    equal(jcode.parseJcodeVersion('no version here'), undefined);

    equal(
        jcode.sessionIdFromFile('session_dolphin_1791901733357_8cd680a40913a606.json'),
        'session_dolphin_1791901733357_8cd680a40913a606',
        'a saved session is named by its id, which is what --resume takes'
    );
    equal(jcode.sessionIdFromFile('notes.txt'), undefined, 'and anything else is not a session');
    contains(jcode.defaultSessionDir('/home/someone'), path.join('.jcode', 'sessions'), 'sessions live under the home directory');
});
