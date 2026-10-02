'use strict';

/**
 * Capture helper for layers that drive a long-running child process (`probe-rs run`).
 *
 * The rule this enforces: **never time a capture window from process start.** `probe-rs
 * run` spends ~10 s programming the image before it prints a single byte, so a fixed
 * window kills it mid-flash and returns an empty string that looks exactly like "the
 * firmware logged nothing". Wait for the line you expect; keep the timeout only as a
 * safety net for a target that never gets there.
 */

/**
 * Collects a child process's stdout/stderr until `fragment` shows up, then stops it.
 *
 * @param {import('child_process').ChildProcess} child
 * @param {{ fragment?: string, timeoutMs: number }} options
 * @returns {Promise<{ output: string, matched: boolean }>} everything captured, and
 *   whether the process stopped because of the fragment (rather than the timeout or exit)
 */
function captureUntil(child, { fragment, timeoutMs }) {
    return new Promise((resolve) => {
        let output = '';
        let settled = false;
        let timer;

        const finish = (matched, kill) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            if (kill && child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
            }
            resolve({ output, matched });
        };

        const collect = (chunk) => {
            output += chunk.toString();
            if (fragment && output.includes(fragment)) {
                finish(true, true);
            }
        };

        if (child.stdout) {
            child.stdout.on('data', collect);
        }
        if (child.stderr) {
            child.stderr.on('data', collect);
        }
        timer = setTimeout(() => finish(false, true), timeoutMs);
        child.on('close', () => finish(false, false));
        child.on('error', () => finish(false, false));
    });
}

module.exports = { captureUntil };
