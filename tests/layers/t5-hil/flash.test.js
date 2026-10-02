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
const { captureUntil } = require('../../lib/rtt');

const { boardById } = compiled('boards/catalog');
const { defaultTemplateFor, generateProjectFiles, requiredFirmware, templatesFor } = compiled('generate/files');
const { augmentedEnv, execFileFn, findExecutable } = compiled('util/exec');
const { detectToolchain } = compiled('toolchain/detect');
const { detectBoardFromProject } = compiled('boards/detect');

const WORK_ROOT = path.join(repoRoot(), 'tests', 'out', 'hil');
// Explicit, and shared with t4-e2e: an ambient CARGO_TARGET_DIR must never be able
// to redirect the build, and the compiled dependencies are reused.
const TARGET_DIR = path.join(repoRoot(), 'tests', 'out', 'cargo-target');
const BOARD_ID = process.env.HIL_BOARD || 'pico';
const BUILD_TIMEOUT_MS = 25 * 60 * 1000;
// `probe-rs run` programs the image before it prints anything, and that alone takes
// ~10 s here, so a capture window measured from process start kills it mid-flash.
// We therefore wait for the expected line and use this only as the ceiling.
const RTT_WAIT_MS = 120000;

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

/**
 * Runs `probe-rs run` and returns everything it printed, stopping as soon as `fragment`
 * appears. The waiting rule (and why it is not a fixed window) lives in `lib/rtt`.
 */
async function captureDefmt(dir, elf, fragment) {
    const child = spawn(probeRs, ['run', '--chip', board.probeChip, elf], {
        cwd: dir,
        env: augmentedEnv({ DEFMT_LOG: 'info' }),
    });
    const { output } = await captureUntil(child, { fragment, timeoutMs: RTT_WAIT_MS });
    return output;
}

/**
 * The captured tail without cyw43's very chatty debug logging, for failure messages:
 * what we care about is the template's own lines.
 */
function interestingTail(log) {
    const lines = log.split(/\r?\n/).filter((line) => line.trim() !== '');
    const ours = lines.filter((line) => !line.includes('cyw43-'));
    return (ours.length > 0 ? ours : lines).slice(-8).join('\n      ');
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
        // `chip-not-autodetected` is the normal result on RP235x: the probe is fine and
        // flashing works because we always pass an explicit chip id.
        if (status.probeDiagnosis.kind !== 'ok' && status.probeDiagnosis.kind !== 'chip-not-autodetected') {
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
                CARGO_TARGET_DIR: TARGET_DIR,
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
        const elf = path.join(TARGET_DIR, board.target, 'release', projectName);
        ok(fs.existsSync(elf), `missing ELF ${elf}`);

        const fragment = expectedLogFragment();
        const log = await captureDefmt(dir, elf, fragment);
        contains(
            log,
            fragment,
            `expected "${fragment}" in the captured RTT output; got:\n      ${interestingTail(log)}`,
        );
    });
}
