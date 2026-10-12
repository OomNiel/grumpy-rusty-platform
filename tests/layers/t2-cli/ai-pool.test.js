'use strict';

/**
 * t2-cli: the hand-off to the `pool` agent, driven by a fake `pool` executable.
 *
 * Real child process, real stdin, real NDJSON on stdout, real exit codes — but no Poolside account and no
 * network, so this layer stays hermetic. What is asserted here is the contract that was measured against the
 * real binary (v1.0.16): the prompt goes in on **stdin**, stdout is NDJSON, and 0 / 4 / anything-else mean
 * three different things.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, ok, notOk, equal, contains, notContains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');

const pool = compiled('ai/pool');

const SHIM = path.join(__dirname, 'shims', 'pool');

/** Runs `fn` with SHIM_POOL_* set for the duration, restoring the environment afterwards. */
async function withEnv(vars, fn) {
    const previous = new Map();
    for (const [key, value] of Object.entries(vars)) {
        previous.set(key, process.env[key]);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        return await fn();
    } finally {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

/** A throwaway working directory: the shim never writes, but the spawn needs a real cwd. */
function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rusty-pool-'));
}

/** One hand-off against the shim. */
function run(overrides = {}) {
    return pool.runPool({
        command: SHIM,
        directory: tempDir(),
        prompt: 'Change the LED pin.',
        timeoutMs: 20000,
        ...overrides
    });
}

// ---------------------------------------------------------------- the pure contract

test('the arguments put the prompt on stdin and never in the argument list', () => {
    const args = pool.poolArgs({ prompt: 'ignored', directory: '/tmp/proj' });
    equal(args[0], 'exec', 'it is exec');
    contains(args.join(' '), '-o json', 'the output format is asked for');
    contains(args.join(' '), '-d /tmp/proj', 'the working directory is the project');
    equal(args[args.length - 1], '-', 'the prompt argument is a dash: read it from stdin');
    equal(args[args.length - 2], '-p', 'and it is the -p flag');
    notOk(args.some((a) => a.includes('ignored')), 'the prompt text itself is in no argument');

    const resumed = pool.poolArgs({ prompt: 'x', directory: '/tmp/p', continueId: 'abc-123', autoAllow: true, agent: 'Poolside' });
    contains(resumed.join(' '), '--continue abc-123', 'a resume passes the run id');
    contains(resumed.join(' '), '--unsafe-auto-allow', 'and auto-allow when asked');
    contains(resumed.join(' '), '-a Poolside', 'and the agent when named');
    notOk(pool.poolArgs({ prompt: 'x', directory: '/tmp/p' }).join(' ').includes('--continue'), 'a first run does not resume');
});

test('NDJSON parses into an answer, the agent\'s work, and its own verdict', () => {
    const text = [
        '{"args":{"path":"src/main.rs"},"name":"edit_file","type":"toolCall"}',
        '{"message":"reading main.rs","type":"assistantMessage"}',
        '{"args":{"command":"cargo check"},"name":"run_command","type":"toolCall"}',
        '{"message":"I changed the pin and the build is clean.","type":"assistantMessage"}',
        '{"args":{"success":true},"name":"exit","type":"toolCall"}'
    ].join('\n');
    const record = pool.parsePoolNdjson(text);
    equal(record.toolCalls.length, 3, 'three tool calls, including the exit');
    equal(record.exitSuccess, true, 'the exit call carries the verdict');
    contains(record.answer, 'I changed the pin', 'the answer holds the narration');
    equal(record.final, 'I changed the pin and the build is clean.', 'and `final` is only what came after the last tool call');
    equal(record.types.assistantMessage, 2, 'the types are counted');
});

test('a line that is not JSON is skipped, and an unknown type is visible rather than ignored', () => {
    const record = pool.parsePoolNdjson(
        ['not json', '{"message":"one","type":"assistantMessage"}', '{"type":"aShapeFromTheFuture"}', '{"message":"two","type":"assistantMessage"}'].join('\n')
    );
    equal(record.answer, 'one\ntwo', 'the answer survives a junk line');
    equal(record.types['(unparsed)'], 1, 'the junk line is counted, not hidden');
    equal(record.types.aShapeFromTheFuture, 1, 'and a message type this parser does not know is on the record');
});

test('a tool call reads as the developer would say it', () => {
    equal(pool.poolToolLine({ name: 'edit_file', args: { path: 'src/main.rs' } }), 'edit_file: src/main.rs', 'a file');
    equal(pool.poolToolLine({ name: 'run_command', args: { command: 'cargo check' } }), 'run_command: cargo check', 'a command');
    equal(pool.poolToolLine({ name: 'some_new_tool', args: { other: 1 } }), 'some_new_tool', 'an unknown tool reads as itself');
});

test('the run id comes out of the trajectory name', () => {
    equal(
        pool.runIdFromTrajectory('trajectory-standalone_01a130d4-3fd0-789d-8125-34be28f40e2d.ndjson'),
        '01a130d4-3fd0-789d-8125-34be28f40e2d',
        'the uuid after the mode prefix'
    );
    equal(pool.runIdFromTrajectory('trajectory-tenant_01a130d4-3fd0-789d-8125-34be28f40e2d.ndjson').startsWith('01a130'), true, 'any mode');
    equal(pool.runIdFromTrajectory('not-a-trajectory.ndjson'), undefined, 'and anything else is not one');
    equal(pool.runIdFromTrajectory('trajectory-standalone_nonsense.ndjson'), undefined, 'a name without a uuid is not one');
});

test('the newest run since a moment is the one a resume continues', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'trajectory-standalone_11111111-1111-1111-1111-111111111111.ndjson'), '');
    fs.writeFileSync(path.join(dir, 'not-a-trajectory.txt'), '');
    const startedAt = Date.now();
    // An older file must not be picked: that would resume somebody else's conversation.
    const old = path.join(dir, 'trajectory-standalone_22222222-2222-2222-2222-222222222222.ndjson');
    fs.writeFileSync(old, '');
    fs.utimesSync(old, new Date(0), new Date(0));
    const fresh = path.join(dir, 'trajectory-standalone_33333333-3333-3333-3333-333333333333.ndjson');
    fs.writeFileSync(fresh, '');
    equal(
        pool.newestRunId(dir, startedAt),
        '33333333-3333-3333-3333-333333333333',
        'the run that just happened, not the one from before it'
    );
    equal(pool.newestRunId(path.join(dir, 'does-not-exist'), startedAt), undefined, 'a missing folder is not a crash');
});

test('the three outcomes are three different sentences', () => {
    const done = pool.describePoolRun({ code: 0, record: pool.parsePoolNdjson('') });
    ok(done.ok, '0 is done');
    equal(done.kind, 'done', 'and says so');

    const failed = pool.describePoolRun({ code: 4, record: pool.parsePoolNdjson('') });
    notOk(failed.ok, '4 is the agent giving up');
    equal(failed.kind, 'task-failed', 'which is not the same as broken');
    contains(failed.message, 'could not complete', 'and the sentence says which');

    const error = pool.describePoolRun({ code: 2, stderr: 'Error: rate limit exceeded', record: pool.parsePoolNdjson('') });
    equal(error.kind, 'error', 'another code is an error');
    contains(error.message, 'rate limit exceeded', 'and pool\'s own words are passed on');

    equal(pool.describePoolRun({ code: 1, missing: true, record: pool.parsePoolNdjson('') }).kind, 'missing', 'a missing binary is its own case');
    equal(pool.describePoolRun({ code: 1, timedOut: true, record: pool.parsePoolNdjson(''), seconds: 900 }).kind, 'timeout', 'and so is a timeout');
});

test('the scripted prompt asks an agent to verify, not to reproduce a file', () => {
    const prompt = pool.handoffPrompt({
        request: 'make the LED blink twice a second',
        refused: 'This request is about 5000 tokens …',
        facts: 'THE CRATES\nembassy-rp',
        target: { path: 'src/main.rs', text: 'fn main() {}' }
    });
    contains(prompt, 'make the LED blink twice a second', 'the request is carried verbatim');
    contains(prompt, 'This request is about 5000 tokens', 'and why it came here');
    contains(prompt, 'embassy-rp', 'and the facts the agent cannot look up cheaply');
    contains(prompt, 'src/main.rs', 'and the file in focus');
    contains(prompt, 'cargo build', 'it is told to build');
    notOk(/whole file/i.test(prompt), 'and is never asked for a whole file — the habit this all came from');
    const resumed = pool.handoffPrompt({ request: 'now do the second LED', resuming: true });
    notOk(resumed.includes('WHAT IS ASKED FOR\nnow do the second LED\n\nWHY IT COMES'), 'a resume does not restate the whole script');
    contains(resumed, 'now do the second LED', 'but does carry the new request');
    contains(resumed, 'Carry on from where you stopped', 'and says to continue');
});

test('the version is read out of whatever the tool prints', () => {
    equal(pool.parsePoolVersion('pool 1.0.16 (fake)'), '1.0.16', 'the number');
    equal(pool.parsePoolVersion('1.0'), '1.0', 'two parts are enough');
    equal(pool.parsePoolVersion('no number here'), undefined, 'and nothing is undefined');
});

// ---------------------------------------------------------------- the real spawn

test('a run reads its prompt from stdin and comes back with the agent\'s answer', async () => {
    const prompt = 'Change the LED pin to GPIO 15 and check the build.';
    const result = await withEnv({ SHIM_POOL_MODE: 'ok' }, () =>
        run({ prompt, onProgress: undefined })
    );
    ok(result.outcome.ok, 'the run is a success');
    equal(result.code, 0, 'with pool\'s own success code');
    equal(result.record.exitSuccess, true, 'and the agent\'s own verdict');
    // The shim reports how many bytes it read: this is the proof that the prompt went in on stdin.
    contains(result.record.answer, `read ${prompt.length} bytes`, 'the prompt arrived on stdin, whole');
    contains(result.record.answer, 'first: Change the LED pin', 'with its first line intact');
    contains(result.record.answer, '-o json', 'and the run was asked for NDJSON');
    contains(result.record.answer, '-p -', 'with the prompt on stdin');
    equal(result.record.toolCalls.length, 3, 'the agent\'s work is on the record');
});

test('each tool call is reported as it arrives', async () => {
    const seen = [];
    await withEnv({ SHIM_POOL_MODE: 'ok' }, () => run({ onProgress: (line) => seen.push(line) }));
    contains(seen.join(' | '), 'edit_file: src/main.rs', 'the file it edited');
    contains(seen.join(' | '), 'run_command: cargo check', 'and the command it ran');
    notOk(seen.some((l) => l.includes('exit')), 'and the exit call is not progress — it is the end');
});

test('a resume and an agent name reach the process', async () => {
    const result = await withEnv({ SHIM_POOL_MODE: 'ok' }, () =>
        run({ continueId: '01a130d4-3fd0-789d-8125-34be28f40e2d', autoAllow: true, agent: 'Poolside' })
    );
    contains(result.record.answer, '--continue 01a130d4-3fd0-789d-8125-34be28f40e2d', 'the run id is passed');
    contains(result.record.answer, '--unsafe-auto-allow', 'and auto-allow');
    contains(result.record.answer, '-a Poolside', 'and the agent');
});

test('exit code 4 is the agent saying it could not, not a broken hand-off', async () => {
    const result = await withEnv({ SHIM_POOL_MODE: 'failed' }, () => run());
    notOk(result.outcome.ok, 'it did not succeed');
    equal(result.outcome.kind, 'task-failed', 'and it is reported as the agent\'s own failure');
    contains(result.record.answer, 'could not find the pin table', 'its explanation is passed on');
    equal(result.record.exitSuccess, false, 'and its own verdict is kept');
});

test('an unexpected exit code is an error, with pool\'s own words', async () => {
    const result = await withEnv({ SHIM_POOL_MODE: 'error' }, () => run());
    equal(result.outcome.kind, 'error', 'a non-zero, non-four code is an error');
    contains(result.outcome.message, 'rate limit exceeded', 'and the stderr tail explains it');
});

test('a pool that is not installed is reported as missing, not as a failure', async () => {
    const result = await run({ command: '/nonexistent/path/to/pool' });
    equal(result.outcome.kind, 'missing', 'the one failure worth its own sentence');
    ok(result.missing, 'and it is flagged for the caller');
});

test('a run that will not finish is stopped, and said to have been stopped', async () => {
    const startedAt = Date.now();
    const result = await withEnv({ SHIM_POOL_MODE: 'slow' }, () => run({ timeoutMs: 1500 }));
    const elapsed = Date.now() - startedAt;
    equal(result.outcome.kind, 'timeout', 'a run over its budget is a timeout');
    ok(result.timedOut, 'which the caller can see');
    contains(result.outcome.message, 'continue the conversation', 'and the sentence says what to do about it');
    ok(elapsed < 20000, `it was actually killed rather than waited out (${elapsed} ms)`);
});

test('a junk line from the tool does not lose the run', async () => {
    const result = await withEnv({ SHIM_POOL_MODE: 'junk' }, () => run());
    ok(result.outcome.ok, 'the run still succeeds');
    contains(result.record.answer, 'still here', 'and the answer is still read');
    contains(result.record.answer, 'carried on regardless', 'all of it');
    equal(result.record.types['(unparsed)'], 1, 'with the junk line accounted for');
});

test('the version and the trajectory folder are asked of the tool itself', async () => {
    equal(await pool.poolVersion(SHIM), '1.0.16', 'the version comes from the binary');
    pool.forgetTrajectoryDir();
    const dir = await withEnv({ SHIM_POOL_TRAJECTORIES: '/tmp/somewhere-trajectories' }, () => pool.trajectoryDir(SHIM));
    equal(dir, '/tmp/somewhere-trajectories', 'and the trajectory folder comes from `pool config`');
    // The fallback has to be there: a pool that cannot be asked must not cost the run-id lookup.
    pool.forgetTrajectoryDir();
    equal(await pool.trajectoryDir('/nonexistent/pool'), pool.defaultTrajectoryDir(), 'a tool that cannot answer falls back to the documented path');
    pool.forgetTrajectoryDir();
});

test('the hand-off settings mean what the manifest says they mean', () => {
    // The asymmetries here are the point of the test. `handoff` defaults to on and only an explicit "off"
    // switches it off, while `autoAllow` and `resume` only go off on an explicit false — neither may be changed
    // by a setting that is missing or misspelt.
    const defaults = pool.normalizeHandoff({});
    equal(defaults.target, 'pool', 'the hand-off is on by default');
    equal(defaults.command, 'pool', 'and looks for `pool` on the PATH');
    equal(defaults.autoAllow, true, 'with auto-allow on, or a non-interactive run could not act at all');
    equal(defaults.resume, true, 'and continuing the last conversation');
    equal(defaults.timeoutSeconds, 900, 'a fifteen-minute budget');
    equal(defaults.agent, '', 'and pool\'s own default agent');

    equal(pool.normalizeHandoff({ handoff: 'off' }).target, 'off', 'an explicit off is off');
    equal(pool.normalizeHandoff({ handoff: 'nonsense' }).target, 'pool', 'and junk is not an instruction to switch it off');
    equal(pool.normalizeHandoff({ poolAutoAllow: false }).autoAllow, false, 'an explicit false turns auto-allow off');
    equal(pool.normalizeHandoff({ poolResume: false }).resume, false, 'and an explicit false stops resuming');
    equal(pool.normalizeHandoff({ poolCommand: '  /opt/pool/pool  ' }).command, '/opt/pool/pool', 'a command is trimmed');
    equal(pool.normalizeHandoff({ poolCommand: '   ' }).command, 'pool', 'and a blank one falls back to the PATH');
    equal(pool.normalizeHandoff({ poolTimeoutSeconds: 5 }).timeoutSeconds, 30, 'a timeout below the floor is raised to it');
    equal(pool.normalizeHandoff({ poolTimeoutSeconds: 99999 }).timeoutSeconds, 7200, 'and one above the ceiling is lowered to it');
    equal(pool.normalizeHandoff({ poolTimeoutSeconds: 'abc' }).timeoutSeconds, 900, 'junk is the default, not NaN');
    equal(pool.normalizeHandoff({ poolTimeoutSeconds: '600' }).timeoutSeconds, 600, 'a string number is understood');
});

test('the scripted hand-off carries what it was told to', () => {
    // A hand-off is the one place the extension hands a developer's code to something else, so what it *puts in
    // the prompt* is worth pinning: the request, why it came here, and an instruction to verify.
    const resuming = pool.handoffPrompt({ request: 'x', resuming: true });
    notContains(resuming, 'THE FILE IN FOCUS', 'a resume does not re-send the file');
    contains(pool.handoffPrompt({ request: 'x' }), 'cargo build', 'a fresh hand-off asks for a real build');
});
