'use strict';

/**
 * t4-e2e (opt-in): the designer's canvas-to-glass check.
 *
 *   node tests/runner.js --e2e
 *
 * The t1 layer proves the arithmetic -- that the pixel tracks add up to the rectangles they came from. It
 * cannot prove that `embedded-gui`'s layout engine *honours* those tracks, because that is a property of the
 * engine. This layer closes that gap: `tests/tools/designer-sim.js` runs the fixture through the extension's
 * own emitter and compiles the result on the host with the real `include_gui!` macro, then measures where
 * the engine put every widget with `absolute_rect`.
 *
 * It needs cargo and downloads crates, so it is not part of the default run. No board is involved.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { test, skip, ok, fail, runtimeSkip, repoRoot, compiled } = require('../../lib/harness');
const { findExecutable } = compiled('util/exec');

const SIM_TIMEOUT_MS = 25 * 60 * 1000;

const cargo = findExecutable('cargo');

if (!cargo) {
    test('t4-e2e designer simulator requires cargo', () => {
        skip('cargo is not installed', 'install the Rust toolchain to enable this layer');
    });
} else {
    /**
     * The two halves of the designer's promise, each a separate run of the host renderer: that the layout
     * engine puts every widget on the rectangle the canvas showed, and that a *touch* at those coordinates
     * reaches that widget and raises its event. The second is the question a flash and a finger would answer.
     */
    for (const [name, flag] of [
        ['the designer\'s pixel tracks land where the canvas placed them, on a real render', []],
        ['a tap at a widget\'s designed centre reaches that widget and no other', ['--touch']],
    ]) {
    test(name, () => {
        const tool = path.join(repoRoot(), 'tests', 'tools', 'designer-sim.js');
        const result = spawnSync(process.execPath, [tool, ...flag], {
            cwd: repoRoot(),
            encoding: 'utf8',
            timeout: SIM_TIMEOUT_MS,
        });

        if (result.error) {
            runtimeSkip(`the simulator could not run: ${result.error.message}`);
        }
        if (result.status !== 0) {
            const output = `${result.stderr || ''}${result.stdout || ''}`
                .split('\n')
                .filter((line) => line.trim() !== '')
                .slice(-25)
                .join('\n      ');
            fail(`the simulator reported a mismatch (exit ${result.status}):\n      ${output}`);
        }
        ok(
            (result.stdout || '').includes('PASS'),
            `expected the simulator to report PASS, got:\n      ${result.stdout}`,
        );
    });
    }
}
