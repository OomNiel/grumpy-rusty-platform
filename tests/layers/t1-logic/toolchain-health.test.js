'use strict';

/**
 * The health check's verdict, and the rule it turns on: **a probe is not a prerequisite on every
 * board.**
 *
 * Pressing the health control on a Sunton CYD produced a modal about "no debug probe detected" — a
 * device an Xtensa chip cannot use, since it flashes over USB serial — while saying nothing about the
 * ESP toolchain the project actually cannot be built without. The report is the single decision behind
 * the sidebar row, the status-bar tooltip and that modal, so it is pinned here.
 */

const { test, ok, notOk, equal, contains, notContains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const { cargoVisibleOnShellPath, healthReport } = compiled('toolchain/health');

/** A ToolchainStatus with only the fields the report reads filled in. */
function status(options = {}) {
    const missing = options.missing ?? [];
    return {
        platform: 'linux',
        rustup: { found: true, version: '1.99.0' },
        cargo: { found: options.cargoFound ?? true, version: '1.99.0', path: '/home/niel/.local/bin/cargo' },
        probeRs: { found: options.probeRsFound ?? true, version: '0.32.0' },
        installedTargets: ['x86_64-unknown-linux-gnu'],
        missingTargets: missing,
        probes: options.probeRsFound === false ? [] : [{ index: 0, name: 'Debug Probe', selector: '2e8a:000c' }],
        probeDiagnosis: {
            kind: options.probeKind ?? 'ok',
            message: options.probeMessage ?? 'Debug probe is reachable.',
        },
        udevRulesPresent: true,
        ready: missing.length === 0,
    };
}

/** An EspToolchainStatus with only what the report reads filled in. */
function esp(options = {}) {
    const missing = options.missing ?? [];
    return {
        espup: { found: !missing.includes('espup'), version: '0.14.0' },
        espflash: { found: !missing.includes('espflash'), version: '4.6.0' },
        toolchainInstalled: !missing.includes('toolchain'),
        exportFile: missing.includes('export-esp.sh') ? undefined : '/home/niel/export-esp.sh',
        chips: options.chips ?? ['esp32'],
        ready: missing.length === 0,
    };
}

const NO_PROBE = {
    probeKind: 'none-connected',
    probeMessage: 'No debug probe detected. Connect a Debug Probe or picoprobe.',
};

test('cargo on the shell PATH is a yes/no question with the right delimiter', () => {
    const bin = '/home/niel/.cargo/bin';
    ok(cargoVisibleOnShellPath(`/usr/bin:${bin}:/bin`, bin), 'found in a colon-separated PATH');
    notOk(cargoVisibleOnShellPath('/usr/bin:/bin', bin), 'not there at all');
    ok(cargoVisibleOnShellPath(`C:\\Users\\niel\\.cargo\\bin;C:\\Windows`, 'C:\\Users\\niel\\.cargo\\bin', ';'),
        'Windows separates with a semicolon');
    notOk(cargoVisibleOnShellPath(`C:\\Users\\niel\\.cargo\\bin;C:\\Windows`, 'C:\\Users\\niel\\.cargo\\bin'),
        'and a colon split does not find it');
    ok(cargoVisibleOnShellPath(undefined, ''), 'an unknown bin directory is never reported as a problem');
});

test('an ESP project with its toolchain is ready without any probe', () => {
    const report = healthReport({
        status: status(NO_PROBE),
        esp: esp(),
        family: 'esp',
        cargoOnShellPath: true,
    });
    ok(report.ok, `an Xtensa board flashes over USB serial: ${report.problems.join('; ')}`);
    equal(report.problems.length, 0);
    equal(report.actions.length, 0, 'nothing to press');
});

test('the ESP toolchain is the problem an ESP project is told about', () => {
    const report = healthReport({
        status: status(NO_PROBE),
        esp: esp({ missing: ['espup', 'espflash'], chips: ['esp32', 'esp32s3'] }),
        family: 'esp',
        cargoOnShellPath: true,
    });
    ok(!report.ok);
    contains(report.problems.join(' | '), 'ESP toolchain: missing: espup, espflash');
    contains(report.problems.join(' | '), 'chips: esp32, esp32s3', 'the install needs to know which chips');
    equal(report.actions.join(','), 'install-esp-toolchain');
    notContains(report.problems.join(' | '), 'probe', 'and never a word about the probe it cannot use');
});

test('cargo is shared, so it is a problem for either family', () => {
    const report = healthReport({
        status: status({ ...NO_PROBE, cargoFound: false }),
        esp: esp(),
        family: 'esp',
        cargoOnShellPath: true,
    });
    contains(report.problems.join(' | '), 'cargo is not installed');
    contains(report.actions.join(','), 'install-toolchain');
});

test('a Raspberry Pi project is judged on the probe, as it always was', () => {
    const noProbe = healthReport({ status: status(NO_PROBE), family: 'rp', cargoOnShellPath: true });
    ok(!noProbe.ok, 'a Pico really is blocked without a probe');
    contains(noProbe.problems.join(' | '), 'No debug probe detected');
    equal(noProbe.actions.length, 0, 'there is nothing to install for a probe that is simply not plugged in');

    const outdated = healthReport({
        status: status({ probeKind: 'firmware-outdated', probeMessage: 'Debug Probe firmware is outdated.' }),
        family: 'rp',
        cargoOnShellPath: true,
    });
    contains(outdated.problems.join(' | '), 'firmware is outdated');
    equal(outdated.actions.join(','), 'update-probe-firmware');

    const noProbeRs = healthReport({
        status: status({ probeRsFound: false, probeKind: 'none-connected' }),
        family: 'rp',
        cargoOnShellPath: true,
    });
    contains(noProbeRs.problems.join(' | '), 'probe-rs is not installed');
    contains(noProbeRs.actions.join(','), 'install-toolchain');
});

test('with no project open, the safe reading is kept', () => {
    const report = healthReport({
        status: status({ ...NO_PROBE, missing: ['thumbv6m-none-eabi'] }),
        esp: esp({ missing: ['espup'] }),
        family: 'unknown',
        cargoOnShellPath: true,
    });
    contains(report.problems.join(' | '), 'No debug probe detected', 'the probe-rs side is still reported');
    contains(report.problems.join(' | '), 'missing targets: thumbv6m-none-eabi');
    notContains(report.problems.join(' | '), 'espup', 'an RP-only user is not nagged about the Xtensa toolchain');
    contains(report.notes.join(' | '), 'ESP toolchain: missing: espup', 'it is a note in the log instead');
});

test('an ESP project is never judged on Raspberry Pi targets', () => {
    const report = healthReport({
        status: status({ missing: ['thumbv6m-none-eabi', 'riscv32imac-unknown-none-elf'] }),
        esp: esp(),
        family: 'esp',
        cargoOnShellPath: true,
    });
    ok(report.ok, 'rustup targets for RP boards have nothing to do with an Xtensa build');
});

test('cargo that is installed but invisible to the shell is its own problem', () => {
    const report = healthReport({
        status: status(),
        esp: esp(),
        family: 'esp',
        cargoOnShellPath: false,
    });
    contains(report.problems.join(' | '), "not on this shell's PATH");
    contains(report.actions.join(','), 'add-cargo-path');
});

test('a toolchain that has not been detected yet is not called healthy', () => {
    const report = healthReport({ family: 'esp', cargoOnShellPath: true });
    ok(!report.ok);
    contains(report.problems.join(' | '), 'not been detected');
});
