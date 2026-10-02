'use strict';

/**
 * t5-hil (opt-in): flash a generated project onto real hardware and read defmt
 * back over RTT.
 *
 *   node tests/runner.js --hil
 *   HIL_BOARD=pico2 node tests/runner.js --hil
 *   HIL_BOARD=picow HIL_TEMPLATE=wifi WIFI_SSID=my-ssid WIFI_PASSWORD=secret \
 *     node tests/runner.js --hil
 *
 * Flashing hardware is never part of the default run. The layer skips itself with a
 * reason when there is no healthy probe, when a target is missing, or when a Wi-Fi
 * template has no credentials to use.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { test, skip, ok, contains, fail, runtimeSkip } = require('../../lib/harness');
const { compiled, repoRoot } = require('../../lib/harness');
const { installFirmware } = require('../../lib/firmware');

const { boardById } = compiled('boards/catalog');
const { defaultTemplateFor, generateProjectFiles, requiredFirmware, templatesFor } = compiled('generate/files');
const { augmentedEnv, execFileFn, findExecutable } = compiled('util/exec');
const { detectToolchain } = compiled('toolchain/detect');
const { detectBoardFromProject } = compiled('boards/detect');

const WORK_ROOT = path.join(repoRoot(), 'tests', 'out', 'hil');
const BOARD_ID = process.env.HIL_BOARD || 'pico';
const BUILD_TIMEOUT_MS = 25 * 60 * 1000;
const RTT_CAPTURE_MS = 5000;

const board = boardById(BOARD_ID);
const template = process.env.HIL_TEMPLATE || (board ? defaultTemplateFor(board) : 'blinky');
const projectName = `hil-${BOARD_ID}-${template}`;

const cargo = findExecutable('cargo');
const probeRs = findExecutable('probe-rs');

/** What defmt line proves this template actually ran. */
function expectedLogFragment() {
    if (template === 'wifi' || template === 'wifi-bluetooth') {
        return 'Wi-Fi is up';
    }
    return board.wireless === 'none' ? 'Hello from' : 'CYW43 is up';
}

async function prepareProject() {
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
    return dir;
}

/** Runs `probe-rs run` and kills it after a moment, returning the captured output. */
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
        const timer = setTimeout(() => child.kill('SIGKILL'), RTT_CAPTURE_MS);
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
} else if (!templatesFor(board).some((info) => info.id === template)) {
    test('t5-hil template selection', () => {
        fail(`template "${template}" is not available for ${board.name}`);
    });
} else if (!cargo || !probeRs) {
    test('t5-hil requires the Rust toolchain', () => {
        skip('cargo and/or probe-rs are not installed', 'run --e2e first');
    });
} else {
    test(`a generated ${board.name} / ${template} project flashes and logs`, async () => {
        const needsWifi = template === 'wifi' || template === 'wifi-bluetooth';
        if (needsWifi && !process.env.WIFI_SSID) {
            runtimeSkip('set WIFI_SSID and WIFI_PASSWORD to test a Wi-Fi template');
        }

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

        const dir = await prepareProject();
        const detected = detectBoardFromProject({
            cargoToml: fs.readFileSync(path.join(dir, 'Cargo.toml'), 'utf8'),
            cargoConfigToml: fs.readFileSync(path.join(dir, '.cargo/config.toml'), 'utf8'),
        });
        ok(detected && detected.id === board.id, `generated project should be detected as ${board.id}`);

        const build = spawnSync(cargo, ['build', '--release'], {
            cwd: dir,
            env: augmentedEnv({
                WIFI_SSID: process.env.WIFI_SSID,
                WIFI_PASSWORD: process.env.WIFI_PASSWORD,
            }),
            encoding: 'utf8',
            timeout: BUILD_TIMEOUT_MS,
        });
        if (build.status !== 0) {
            fail(`cargo build --release failed (${build.status}):\n      ${(build.stderr || '').slice(-1500)}`);
        }

        // Cargo keeps hyphens in the artefact name.
        const elf = path.join(dir, 'target', board.target, 'release', projectName);
        ok(fs.existsSync(elf), `missing ELF ${elf}`);

        const log = await captureDefmt(dir, elf);
        const fragment = expectedLogFragment();
        contains(
            log,
            fragment,
            `expected "${fragment}" in the captured RTT output:\n      ${log.slice(-900)}`,
        );
    });
}
