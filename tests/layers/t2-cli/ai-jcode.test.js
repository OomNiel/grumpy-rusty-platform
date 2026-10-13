'use strict';

/**
 * t2-cli: the hand-off to the Agnes Code CLI, driven by a fake `jcode` executable.
 *
 * Real child process, real arguments, real NDJSON on stdout, real exit codes — but no Agnes account and no
 * network, so this layer stays hermetic. What is asserted is the contract that was measured against the real
 * v0.75.0 binary on 2026-10-13: the message goes in as the **last argument** (unlike pool, whose prompt is on
 * stdin), stdout is one JSON event per line, tools run with no approval prompt, and exit 0 means finished.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, ok, notOk, equal, contains, notContains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');

const jcode = compiled('ai/jcode');

const SHIM = path.join(__dirname, 'shims', 'jcode');

/** Runs `fn` with SHIM_JCODE_* set for the duration, restoring the environment afterwards. */
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
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rusty-jcode-'));
}

/** One hand-off against the shim. */
function run(overrides = {}) {
    return jcode.runJcode({
        command: SHIM,
        directory: tempDir(),
        prompt: 'Change the LED pin.',
        timeoutMs: 20000,
        ...overrides
    });
}

test('the message arrives as an argument, and stdin is given nothing', async () => {
    // The difference from pool, and the reason this is asserted rather than assumed: a prompt written to stdin
    // would be an prompt this CLI never reads, and a hand-off that silently does nothing is the worst outcome
    // there is. The shim reports both what it was handed in argv and what it found on stdin.
    const prompt = 'Take over this change, and make the build pass.';
    const outcome = await run({ prompt });
    ok(outcome.outcome.ok, 'the run finished');
    contains(outcome.record.answer, `message ${prompt.length} bytes`, 'the message reached it through argv');
    contains(outcome.record.answer, 'stdin 0 bytes', 'and nothing was written to its stdin');
    equal(outcome.record.runId, 'session_probe_1791901733357_8cd680a40913a606', 'the session id came out of the run');
    equal(outcome.record.toolCalls.length, 1, 'and its tool call was reported');
    contains(jcode.jcodeToolLine(outcome.record.toolCalls[0]), 'src/main.rs', 'with the file it touched');
    ok(outcome.ms < 20000, 'without waiting for the timeout');
});

test('a hand-off continues the session the CLI names', async () => {
    const wanted = 'session_calf_1786632703841_090c1d6906b3dd5b';
    await withEnv({ SHIM_JCODE_SESSION: wanted }, async () => {
        const outcome = await run({ continueId: wanted });
        equal(outcome.record.runId, wanted, 'the session the CLI reports is the one it was told to continue');
        contains(outcome.record.answer, `resume ${wanted}`, 'and --resume carried the id through the argument list');
    });
});

test('the version probe answers without starting a run', async () => {
    equal(await jcode.jcodeVersion(SHIM), '0.75.0', 'the version is read out of the CLI\'s own line');
    equal(await jcode.jcodeVersion(path.join(__dirname, 'shims', 'not-a-real-jcode')), undefined, 'and a command that is not there reports no version');
});

test('a run that finishes with a failed tool says so instead of claiming success', async () => {
    await withEnv({ SHIM_JCODE_MODE: 'failed-tools' }, async () => {
        const outcome = await run();
        ok(outcome.outcome.ok, 'the run itself finished');
        contains(outcome.outcome.message, 'failed', 'but the failed tool call is in the outcome');
        contains(outcome.outcome.message, 'the write tool failed', 'along with the CLI\'s own note');
        ok(outcome.record.toolCalls[0].error, 'and the caller can see which call it was');
    });
});

test('an event shape this parser has never seen does not lose the run', async () => {
    await withEnv({ SHIM_JCODE_MODE: 'junk' }, async () => {
        const outcome = await run();
        contains(outcome.record.answer, 'carried on regardless', 'the answer survives an unreadable line');
        equal(outcome.record.types['(unparsed)'], 1, 'the unreadable line is counted');
        equal(outcome.record.types['aShapeFromTheFuture'], 1, 'and so is the unknown event');
        ok(outcome.outcome.ok, 'and the run is still reported as finished');
    });
});

test('a run that stops with a tool call still pending does not read as finished work', async () => {
    await withEnv({ SHIM_JCODE_MODE: 'unfinished' }, async () => {
        const outcome = await run();
        contains(outcome.outcome.message, 'tool_calls', 'the last message being a tool call is named');
        contains(outcome.record.toolCalls[0].output, 'E0425', 'and the compiler output it saw is kept');
    });
});

test('a failure from the CLI carries its own words', async () => {
    await withEnv({ SHIM_JCODE_MODE: 'error' }, async () => {
        const outcome = await run();
        equal(outcome.outcome.ok, false, 'a non-zero exit is not a finished run');
        equal(outcome.outcome.kind, 'error');
        contains(outcome.outcome.message, '401 Unauthorized', 'and the reason is the CLI\'s own message');
    });
});

test('a run is stopped at its timeout, with its group killed', async () => {
    // The reason this is a test and not a comment: `jcode` is a launcher, and a `sleep` it started holds the
    // stdout pipe. Killing only the wrapper leaves the promise waiting for a grandchild — measured on the pool
    // side on 2026-10-12, where a 1.5 s timeout took thirty seconds.
    const started = Date.now();
    const outcome = await withEnv({ SHIM_JCODE_MODE: 'slow' }, () => run({ timeoutMs: 1500 }));
    const elapsed = Date.now() - started;
    equal(outcome.outcome.kind, 'timeout', 'the run is reported as stopped');
    equal(outcome.timedOut, true);
    ok(elapsed < 12000, `and it came back promptly (${elapsed} ms)`);
});

test('the editor\'s cancel button stops the run too', async () => {
    const controller = new AbortController();
    const pending = withEnv({ SHIM_JCODE_MODE: 'slow' }, () => run({ timeoutMs: 30000, signal: controller.signal }));
    setTimeout(() => controller.abort(), 400);
    const outcome = await pending;
    equal(outcome.outcome.kind, 'cancelled');
    contains(outcome.outcome.message, 'disk', 'and says the changes it made are still there');
});

test('a command that is not installed is reported as missing, not as a failure', async () => {
    const outcome = await run({ command: path.join(os.tmpdir(), 'definitely-not-jcode') });
    equal(outcome.missing, true);
    equal(outcome.outcome.kind, 'missing');
    contains(outcome.outcome.message, 'Agnes Code CLI', 'and the message names the thing to install');
});

test('the last session is the one that was working in this project', async () => {
    // The fallback path, for a window that has forgotten the id. jcode records `working_dir` in every session, so
    // this can ask a precise question — "the newest session that says it was working here" — rather than taking
    // the newest file, which would continue a conversation about some other project.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rusty-jcode-home-'));
    const sessions = path.join(home, '.jcode', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const older = path.join(sessions, 'session_calf_1000_aaaaaaaaaaaaaaaa.json');
    const newer = path.join(sessions, 'session_ram_2000_bbbbbbbbbbbbbbbb.json');
    fs.writeFileSync(older, JSON.stringify({ id: 'session_calf_1000_aaaaaaaaaaaaaaaa', working_dir: '/tmp/projA' }));
    fs.writeFileSync(newer, JSON.stringify({ id: 'session_ram_2000_bbbbbbbbbbbbbbbb', working_dir: '/tmp/projB' }));
    // Make the newer file newer on disk too, so only the recorded directory can decide this.
    const later = Date.now() / 1000;
    fs.utimesSync(older, later - 600, later - 600);
    fs.utimesSync(newer, later, later);

    equal(
        jcode.sessionIdForDirectory('/tmp/projA', { home }),
        'session_calf_1000_aaaaaaaaaaaaaaaa',
        'the session for this project is found even though another one is newer'
    );
    equal(jcode.sessionIdForDirectory('/tmp/projB', { home }), 'session_ram_2000_bbbbbbbbbbbbbbbb', 'and the other way round');
    equal(jcode.sessionIdForDirectory('/tmp/never-seen', { home }), undefined, 'a project with no sessions gets nothing');
    equal(jcode.sessionIdForDirectory('/tmp/projA', { home: path.join(home, 'nowhere') }), undefined, 'and a home with no sessions is not an error');
    notContains(String(jcode.sessionIdForDirectory('/tmp/never-seen', { home })), 'session_', 'never a guessed id');
});
