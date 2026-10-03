'use strict';

/**
 * Install planning for one project, and the shell-PATH fix.
 *
 * Both exist because of the same real failure on this machine: rustup is installed with
 * `--no-modify-path`, so `~/.cargo/bin` is on no PATH — the extension found cargo, the user's
 * terminal did not, and `cargo build` said "Command 'cargo' not found".
 */

const { test, ok, equal, contains, notContains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const { planProjectSetup, planInstallation } = compiled('toolchain/installPlan');
const {
    addCargoToPath,
    cargoPathBlock,
    cargoBinPath,
    profileCandidates,
    PATH_BLOCK_MARKER,
} = compiled('toolchain/shellPath');
const { allTargets, BOARDS } = compiled('boards/catalog');

const PICO2W_TARGET = BOARDS.find((board) => board.id === 'pico2w').target; // thumbv8m.main-none-eabihf
const PICO_TARGET = BOARDS.find((board) => board.id === 'pico').target; // thumbv6m-none-eabi

/** A machine with everything installed. */
function ready(overrides = {}) {
    return {
        platform: 'linux',
        rustup: { name: 'rustup', found: true, version: '1.29.1' },
        cargo: { name: 'cargo', found: true, version: '1.99.0' },
        probeRs: { name: 'probe-rs', found: true, version: '0.32.0' },
        installedTargets: [...allTargets()],
        missingTargets: [],
        probes: [],
        probeDiagnosis: { kind: 'none-connected', message: 'No debug probe detected.' },
        udevRulesPresent: true,
        ready: true,
        ...overrides,
    };
}

const LINUX = { platform: 'linux', arch: 'x64' };

test('a project with everything present needs no setup steps', () => {
    equal(
        planProjectSetup(ready(), { targets: [PICO2W_TARGET], needsProbeRs: false, ...LINUX }),
        [],
    );
});

test('only the project\'s own target is offered, not every board\'s', () => {
    const bare = ready({ installedTargets: [], missingTargets: [...allTargets()] });
    const steps = planProjectSetup(bare, { targets: [PICO2W_TARGET], needsProbeRs: false, ...LINUX });
    equal(steps.map((step) => step.target), [PICO2W_TARGET]);
    notContains(
        steps.map((step) => step.target).join(','),
        PICO_TARGET,
        'the Pico 2 W project must not be asked to install the RP2040 target',
    );
});

test('the tool-wide plan is broader than the project plan', () => {
    const bare = ready({ installedTargets: [], missingTargets: [...allTargets()] });
    const project = planProjectSetup(bare, { targets: [PICO2W_TARGET], needsProbeRs: false, ...LINUX });
    const toolchain = planInstallation(bare, { targets: allTargets(), ...LINUX });
    ok(
        toolchain.length > project.length,
        'planInstallation covers all four boards; the prompt in front of a build must not',
    );
});

test('a missing toolchain installs rustup first, then the targets', () => {
    const nothing = ready({
        rustup: { name: 'rustup', found: false },
        cargo: { name: 'cargo', found: false },
        installedTargets: [],
        missingTargets: [...allTargets()],
    });
    const steps = planProjectSetup(nothing, { targets: [PICO2W_TARGET], needsProbeRs: false, ...LINUX });
    equal(steps.map((step) => step.kind), ['rustup', 'target']);
    equal(steps[0].id, 'rustup');
    equal(steps[1].target, PICO2W_TARGET, 'rustup-init does not install the embedded target for us');
});

test('probe-rs is offered for monitor, never for build', () => {
    const noProbeRs = ready({ probeRs: { name: 'probe-rs', found: false } });
    equal(
        planProjectSetup(noProbeRs, { targets: [PICO2W_TARGET], needsProbeRs: false, ...LINUX }),
        [],
        'a plain build does not need probe-rs',
    );
    const forMonitor = planProjectSetup(noProbeRs, { targets: [PICO2W_TARGET], needsProbeRs: true, ...LINUX });
    equal(forMonitor.map((step) => step.kind), ['probe-rs']);
});

test('the order is always rustup, targets, probe-rs', () => {
    const nothing = ready({
        rustup: { name: 'rustup', found: false },
        cargo: { name: 'cargo', found: false },
        probeRs: { name: 'probe-rs', found: false },
        installedTargets: [],
        missingTargets: [...allTargets()],
    });
    const steps = planProjectSetup(nothing, { targets: [PICO2W_TARGET], needsProbeRs: true, ...LINUX });
    equal(steps.map((step) => step.kind), ['rustup', 'target', 'probe-rs']);
    for (const step of steps) {
        ok(step.title.trim() !== '' && step.detail.trim() !== '', `${step.id} needs a title and detail`);
        equal(step.requiresElevation, false, `${step.id} does not need root`);
    }
});

test('duplicate targets collapse and the order is stable', () => {
    const bare = ready({ installedTargets: [], missingTargets: [...allTargets()] });
    const steps = planProjectSetup(bare, {
        targets: [PICO2W_TARGET, PICO_TARGET, PICO2W_TARGET],
        needsProbeRs: false,
        ...LINUX,
    });
    equal(steps.map((step) => step.target), [PICO2W_TARGET, PICO_TARGET].sort());
});

test('the PATH block is POSIX-safe and self-guarding', () => {
    const block = cargoPathBlock();
    contains(block, PATH_BLOCK_MARKER, 'the block is recognisable');
    contains(block, 'case ":$PATH:" in', 'sh has no portable array or "contains" test, so this guard is the point');
    contains(block, 'esac');
    contains(block, 'fi');
    contains(block, '$HOME/.cargo/bin');
    notContains(block, 'local ', 'sh does not have local everywhere; .profile is read by sh');
});

test('appending to an empty or non-newline-terminated profile stays well formed', () => {
    const fromEmpty = addCargoToPath('');
    ok(fromEmpty.changed);
    equal(fromEmpty.reason, 'appended');
    ok(fromEmpty.content.startsWith(`# ${PATH_BLOCK_MARKER}`), 'no leading blank line in an empty file');

    const fromFull = addCargoToPath('export EDITOR=vim');
    ok(fromFull.changed);
    contains(fromFull.content, 'export EDITOR=vim\n\n# ' + PATH_BLOCK_MARKER);

    const fromEnded = addCargoToPath('export EDITOR=vim\n');
    contains(fromEnded.content, 'export EDITOR=vim\n\n# ' + PATH_BLOCK_MARKER);
    notContains(fromEnded.content, 'vim\n\n\n', 'exactly one blank line is inserted');
});

test('the edit is idempotent, and respects a line the user already has', () => {
    const once = addCargoToPath('# my profile\n');
    const twice = addCargoToPath(once.content);
    ok(!twice.changed);
    equal(twice.reason, 'already-present');
    equal(twice.content, once.content, 'a second run must not duplicate the block');

    const handwritten = 'export PATH="$HOME/.cargo/bin:$PATH"\n';
    const edit = addCargoToPath(handwritten);
    ok(!edit.changed);
    equal(edit.content, handwritten, 'what the user wrote is left alone');
});

test('profile candidates exist for POSIX platforms and none for Windows', () => {
    equal(profileCandidates('linux'), ['.profile', '.bashrc']);
    ok(profileCandidates('darwin').includes('.zshrc'));
    equal(profileCandidates('win32'), [], 'PATH on Windows is a registry setting, not a text file');
});

test('the cargo bin path is derived from the home directory, not hard-coded', () => {
    equal(cargoBinPath('/home/someone'), '/home/someone/.cargo/bin');
    ok(cargoBinPath(os_home()).endsWith('/.cargo/bin'));
});

function os_home() {
    // Mirrors what the extension does at runtime; asserted only loosely so it works anywhere.
    return require('os').homedir();
}
