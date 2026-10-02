'use strict';

/**
 * t4-e2e (opt-in): really compile a generated project with the real toolchain.
 *
 *   node tests/runner.js --e2e
 *
 * This downloads crates and takes minutes, which is why it is not part of the
 * default run. It is the only test that proves the templates are actually
 * buildable — everything faster is a proxy.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, skip, ok, equal, fail, runtimeSkip } = require('../../lib/harness');
const { compiled, repoRoot } = require('../../lib/harness');

const { BOARDS } = compiled('boards/catalog');
const { generateProjectFiles, crateNameFrom } = compiled('generate/files');
const { findExecutable, augmentedEnv } = compiled('util/exec');

const WORK_ROOT = path.join(repoRoot(), 'tests', 'out', 'e2e');
const BUILD_TIMEOUT_MS = 20 * 60 * 1000;

function writeProject(board) {
    const dir = path.join(WORK_ROOT, board.id);
    fs.rmSync(dir, { recursive: true, force: true });
    for (const file of generateProjectFiles({ board, projectName: `e2e-${board.id}` })) {
        const target = path.join(dir, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.content, 'utf8');
    }
    return dir;
}

function tail(text, lines = 25) {
    return text.split('\n').slice(-lines).join('\n');
}

const cargo = findExecutable('cargo');

if (!cargo) {
    test('t4-e2e requires cargo', () => {
        skip('cargo is not installed', 'install the Rust toolchain to enable this layer');
    });
} else {
    for (const board of BOARDS) {
        test(`a generated ${board.name} project compiles (cargo build)`, () => {
            const dir = writeProject(board);
            const result = spawnSync(cargo, ['build'], {
                cwd: dir,
                env: augmentedEnv(),
                encoding: 'utf8',
                timeout: BUILD_TIMEOUT_MS,
            });

            if (result.error) {
                runtimeSkip(`cargo build could not run: ${result.error.message}`);
            }
            if (result.status !== 0) {
                fail(
                    `cargo build exited with ${result.status}\n` +
                    `      project: ${dir}\n` +
                    `      --- stderr (tail) ---\n      ${tail(result.stderr || '').split('\n').join('\n      ')}\n` +
                    `      --- stdout (tail) ---\n      ${tail(result.stdout || '').split('\n').join('\n      ')}`,
                );
            }

            // Cargo names the default binary after the package name, hyphens intact.
            const artefact = path.join(dir, 'target', board.target, 'debug', crateNameFrom(`e2e-${board.id}`));
            ok(
                fs.existsSync(artefact),
                `expected the ELF artefact at ${artefact}\n      found: ${fs.readdirSync(path.dirname(artefact)).join(', ')}`,
            );
            const size = fs.statSync(artefact).size;
            ok(size > 10_000, `ELF looks too small (${size} bytes)`);
            equal(result.status, 0);
        });
    }
}
