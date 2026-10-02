'use strict';

/**
 * t4-e2e (opt-in): really compile generated projects with the real toolchain.
 *
 *   node tests/runner.js --e2e
 *
 * Downloads crates and takes minutes, so it is not part of the default run. It is
 * the only layer that proves the templates are buildable and linkable — everything
 * faster is a proxy. For wireless boards it also downloads the CYW43 blobs through
 * the pinned URLs and verifies the pinned SHA-256 hashes, so a bad pin fails here
 * rather than in someone's project.
 *
 * A shared CARGO_TARGET_DIR across the matrix means the heavy dependencies
 * (embassy-net, cyw43) are compiled once instead of six times.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, skip, ok, equal, fail, runtimeSkip } = require('../../lib/harness');
const { compiled, repoRoot } = require('../../lib/harness');
const { installFirmware } = require('../../lib/firmware');

const { boardById } = compiled('boards/catalog');
const { generateProjectFiles, requiredFirmware } = compiled('generate/files');
const { findExecutable, augmentedEnv } = compiled('util/exec');

const WORK_ROOT = path.join(repoRoot(), 'tests', 'out', 'e2e');
// Explicit, and shared with t5-hil: an ambient CARGO_TARGET_DIR must never be able
// to redirect the output, and heavy dependencies are then compiled only once.
const TARGET_DIR = path.join(repoRoot(), 'tests', 'out', 'cargo-target');
const BUILD_TIMEOUT_MS = 25 * 60 * 1000;

/**
 * What we build. Every wired board gets its only template; the wireless boards get
 * all three, on at least one of them, so the Bluetooth dependency set and the
 * LED-only variant are both compiled for real.
 */
const BUILD_MATRIX = [
    { board: 'pico', template: 'blinky' },
    { board: 'pico2', template: 'blinky' },
    { board: 'picow', template: 'blinky' },
    { board: 'picow', template: 'wifi' },
    { board: 'picow', template: 'wifi-bluetooth' },
    { board: 'pico2w', template: 'wifi' },
];

async function writeProject(boardId, template) {
    const board = boardById(boardId);
    const projectName = `e2e-${boardId}-${template}`;
    const dir = path.join(WORK_ROOT, projectName);
    fs.rmSync(dir, { recursive: true, force: true });

    for (const file of generateProjectFiles({ board, projectName, template })) {
        const target = path.join(dir, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.content, 'utf8');
    }

    const blobNames = requiredFirmware(board, template).map((blob) => blob.fileName);
    if (blobNames.length > 0) {
        await installFirmware(dir, blobNames);
    }
    return { dir, projectName };
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
    for (const { board, template } of BUILD_MATRIX) {
        const boardName = boardById(board).name;
        test(`a generated ${boardName} / ${template} project compiles`, async () => {
            const { dir, projectName } = await writeProject(board, template);
            const target = boardById(board).target;

            const result = spawnSync(cargo, ['build'], {
                cwd: dir,
                env: augmentedEnv({ CARGO_TARGET_DIR: TARGET_DIR }),
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
            const artefact = path.join(TARGET_DIR, target, 'debug', projectName);
            ok(
                fs.existsSync(artefact),
                `expected the ELF artefact at ${artefact}\n      found: ${fs.readdirSync(path.dirname(artefact)).join(', ')}`,
            );
            const size = fs.statSync(artefact).size;
            ok(size > 10_000, `ELF looks too small (${size} bytes)`);
            equal(result.status, 0);
        });
    }

    test('a wireless build with the firmware baked in is much larger than a wired one', () => {
        const wired = path.join(TARGET_DIR, 'thumbv6m-none-eabi', 'debug', 'e2e-pico-blinky');
        const wireless = path.join(TARGET_DIR, 'thumbv6m-none-eabi', 'debug', 'e2e-picow-wifi');
        if (!fs.existsSync(wired) || !fs.existsSync(wireless)) {
            runtimeSkip('run the matrix first (missing artefacts)');
        }
        const wiredSize = fs.statSync(wired).size;
        const wirelessSize = fs.statSync(wireless).size;
        ok(
            wirelessSize > wiredSize,
            `the CYW43 firmware alone is 231 KB, so the wireless image should be bigger ` +
            `(wired ${wiredSize}, wireless ${wirelessSize})`,
        );
        ok(
            wirelessSize > 231_077,
            `a wireless image must at least contain the 231 KB firmware (got ${wirelessSize})`,
        );
    });
}
