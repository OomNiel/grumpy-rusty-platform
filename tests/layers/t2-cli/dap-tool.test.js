'use strict';

/**
 * The `dap-session` tool, without the hardware.
 *
 * The tool exists to answer "does a breakpoint set before the session starts actually fire?", which
 * needs a real probe - but its argument handling and its module wiring are cheap to pin, and a tool
 * that throws on startup is worse than no tool. Everything here runs `--help` or fails before the
 * adapter is spawned.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, ok, equal, contains } = require('../../lib/harness');
const { repoRoot } = require('../../lib/harness');

const TOOL = path.join(repoRoot(), 'tests', 'tools', 'dap-session.js');

function run(...args) {
    return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', timeout: 30_000 });
}

test('the tool starts and documents itself', () => {
    const result = run('--help');
    equal(result.status, 0, `--help should exit 0, stderr: ${result.stderr}`);
    contains(result.stdout, '--project', 'the options must be documented');
    contains(result.stdout, '--line');
    contains(result.stdout, 'Exit codes');
    ok(!result.stdout.includes(' * '), 'the help should read as prose, not as a comment block');
});

test('a bad option fails before anything is spawned', () => {
    const result = run('--nonsense');
    equal(result.status, 2, 'exit code 2 means it could not run');
    contains(result.stderr, 'unknown option --nonsense');

    // `--line` is repeatable (that is how a breakpoint *limit* was measured), so a non-number in
    // any position has to be caught up front rather than silently becoming NaN.
    const badLine = run('--line', '92', '--line', 'nope');
    equal(badLine.status, 2);
    contains(badLine.stderr, '--line takes a number');
});

test('an attach session refuses the flashing flags, like probe-rs does', () => {
    const result = run('--project', repoRoot(), '--as', 'attach', '--flash');
    equal(result.status, 2);
    contains(result.stderr, 'attach');
});

test('a project without a launch.json is reported as such', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rusty-dap-'));
    try {
        const result = run('--project', empty);
        equal(result.status, 2);
        contains(result.stderr, 'launch.json');
    } finally {
        fs.rmSync(empty, { recursive: true, force: true });
    }
});
