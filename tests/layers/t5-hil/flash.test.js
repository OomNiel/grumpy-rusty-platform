'use strict';

/**
 * t5-hil (opt-in): flash a generated project onto the target on the desk and
 * check that defmt logging comes back over RTT.
 *
 *   node tests/runner.js --hil
 *
 * Flashing real hardware is never part of the default run. The layer skips
 * itself (with a reason) when no healthy probe is attached, so it is safe to
 * leave enabled on a machine without hardware.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { test, skip, ok, contains, fail, runtimeSkip } = require('../../lib/harness');
const { compiled, repoRoot } = require('../../lib/harness');

const { boardById } = compiled('boards/catalog');
const { generateProjectFiles, crateNameFrom } = compiled('generate/files');
const { findExecutable, augmentedEnv } = compiled('util/exec');
const { detectToolchain } = compiled('toolchain/detect');
const { execFileFn } = compiled('util/exec');
const { detectBoardFromProject } = compiled('boards/detect');

const WORK_ROOT = path.join(repoRoot(), 'tests', 'out', 'hil');
const BOARD_ID = process.env.HIL_BOARD || 'pico';
const BUILD_TIMEOUT_MS = 20 * 60 * 1000;
const RTT_CAPTURE_MS = 4000;

const board = boardById(BOARD_ID);
const cargo = findExecutable('cargo');
const probeRs = findExecutable('probe-rs');

function prepareProject() {
    const dir = path.join(WORK_ROOT, board.id);
    fs.rmSync(dir, { recursive: true, force: true });
    for (const file of generateProjectFiles({ board, projectName: `hil-${board.id}` })) {
        const target = path.join(dir, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.content, 'utf8');
    }
    return dir;
}

/** Runs `probe-rs run` and kills it after a moment, returning captured output. */
function captureDefmt(dir, elf) {
    return new Promise((resolve) => {
        const child = spawn(probeRs, ['run', '--chip', board.probeChip, elf], {
            cwd: dir,
            env: augmentedEnv({ DEFMT_LOG: 'info' }),
        });
        let output = '';
        const collect = (chunk) => {
            output += chunk.toString();
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
        }, RTT_CAPTURE_MS);
        child.on('close', () => {
            clearTimeout(timer);
            resolve(output);
        });
    });
}

if (!board) {
    test('t5-hil board selection', () => {
        fail(`unknown HIL_BOARD "${BOARD_ID}"`);
    });
} else if (!cargo || !probeRs) {
    test('t5-hil requires the Rust toolchain', () => {
        skip('cargo and/or probe-rs are not installed', 'run --e2e first');
    });
} else {
    test(`a generated ${board.name} project flashes and logs over RTT`, async () => {
        const status = await detectToolchain(execFileFn, {
            requiredTargets: [board.target],
            udevRulesPresent: () => true,
        });

        if (status.probeDiagnosis.kind === 'none-connected') {
            runtimeSkip('no debug probe attached');
        }
        if (status.probeDiagnosis.kind !== 'ok') {
            runtimeSkip(status.probeDiagnosis.message);
        }
        if (status.missingTargets.length > 0) {
            runtimeSkip(`target ${status.missingTargets.join(', ')} not installed`);
        }

        const dir = prepareProject();
        const detour = detectBoardFromProject({
            cargoToml: fs.readFileSync(path.join(dir, 'Cargo.toml'), 'utf8'),
            cargoConfigToml: fs.readFileSync(path.join(dir, '.cargo/config.toml'), 'utf8'),
        });
        ok(detour && detour.id === board.id, `generated project should be detected as ${board.id}`);

        const build = spawnSync(cargo, ['build', '--release'], {
            cwd: dir,
            env: augmentedEnv(),
            encoding: 'utf8',
            timeout: BUILD_TIMEOUT_MS,
        });
        if (build.status !== 0) {
            fail(`cargo build --release failed (${build.status}):\n      ${(build.stderr || '').slice(-1500)}`);
        }

        const elf = path.join(dir, 'target', board.target, 'release', crateNameFrom(`hil-${board.id}`));
        ok(fs.existsSync(elf), `missing ELF ${elf}`);

        const log = await captureDefmt(dir, elf);
        contains(log, 'Hello from', `expected the defmt greeting in the captured RTT output:\n      ${log.slice(-800)}`);
    });
}
