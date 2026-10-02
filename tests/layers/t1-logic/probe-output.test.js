'use strict';

const { test, ok, equal, contains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const {
    parseProbeList,
    parseTargetList,
    parseVersion,
    classifyProbeError,
} = compiled('toolchain/detect');

// Real outputs captured from this machine — keep them verbatim, they are the
// contract with probe-rs/rustup.
const REAL_PROBE_LIST = `The following debug probes were found:
[0]: Debug Probe (CMSIS-DAP) -- 2e8a:000c-0:E6614103E74B072F (CMSIS-DAP)
`;

const REAL_OUTDATED_FIRMWARE = `Could not attach to target. Try running with --verbose for more information about the target.
Error: Failed to open probe: Failed to open the debug probe.

Caused by:
    0: The debug probe could not be created.
    1: An error specific with the selected probe occurred.
    2: The firmware on the probe is outdated, and not supported by probe-rs. The minimum supported firmware version is 2.2.0.
`;

// Captured with a healthy probe and a healthy Pico 2 W: `probe-rs info` cannot
// auto-detect RP235x, so this failure is NORMAL and must not be reported as a fault.
const REAL_CHIP_NOT_DETECTED = `Could not attach to target. Try running with --verbose for more information about the target.
Error: Connecting to the chip was unsuccessful.

Caused by:
    0: Unable to load specification for chip
    1: The connected chip could not automatically be determined.
`;

// Captured with the SWD wires sub-swapped: this is the real "dead link" signal.
const REAL_NO_TARGET = `Error: Connecting to the chip was unsuccessful.

Caused by:
    0: An ARM specific error occurred.
    1: No target responded to the debug port. Check that the target is connected and powered, and that the SWD/JTAG wiring is correct.
    2: An error occurred in the communication with an access port or debug port.
    3: Target device did not respond to request.
`;

test('parseVersion extracts a semver from tool output', () => {
    equal(parseVersion('cargo 1.99.0 (5f94df478 2026-08-27)'), '1.99.0');
    equal(parseVersion('rustup 1.29.1 (d95a37b6a 2026-08-13)'), '1.29.1');
    equal(parseVersion('probe-rs 0.32.0 (git commit: 48f5e4d)'), '0.32.0');
    equal(parseVersion('no version here'), undefined);
});

test('parseTargetList reads rustup target output', () => {
    equal(parseTargetList('thumbv6m-none-eabi\nthumbv8m.main-none-eabihf\nx86_64-unknown-linux-gnu\n'), [
        'thumbv6m-none-eabi',
        'thumbv8m.main-none-eabihf',
        'x86_64-unknown-linux-gnu',
    ]);
});

test('parseTargetList ignores informational noise and blank lines', () => {
    equal(parseTargetList('info: syncing channel updates\n\nthumbv6m-none-eabi\n'), ['thumbv6m-none-eabi']);
    equal(parseTargetList(''), []);
});

test('parseProbeList reads a connected CMSIS-DAP probe', () => {
    const probes = parseProbeList(REAL_PROBE_LIST);
    equal(probes.length, 1);
    equal(probes[0].index, 0);
    equal(probes[0].name, 'Debug Probe (CMSIS-DAP)');
    equal(probes[0].selector, '2e8a:000c-0:E6614103E74B072F');
    equal(probes[0].protocol, 'CMSIS-DAP');
});

test('parseProbeList ignores the header line', () => {
    equal(parseProbeList('The following debug probes were found:\n'), []);
});

test('parseProbeList reads several probes', () => {
    const probes = parseProbeList(
        'The following debug probes were found:\n' +
        '[0]: Debug Probe (CMSIS-DAP) -- 2e8a:000c-0:AAA (CMSIS-DAP)\n' +
        '[1]: Picoprobe (CMSIS-DAP) -- 2e8a:0004-1:BBB (CMSIS-DAP)\n',
    );
    equal(probes.length, 2);
    equal(probes[1].name, 'Picoprobe (CMSIS-DAP)');
    equal(probes[1].index, 1);
});

test('an empty probe list yields nothing', () => {
    equal(parseProbeList(''), []);
    equal(parseProbeList('No probes were found.\n'), []);
});

test('outdated probe firmware is diagnosed with the required version', () => {
    const diagnosis = classifyProbeError(REAL_OUTDATED_FIRMWARE);
    equal(diagnosis.kind, 'firmware-outdated');
    contains(diagnosis.message, '2.2.0');
    contains(diagnosis.message, 'debugprobe');
    ok(diagnosis.raw.includes('Failed to open probe'));
});

test('USB permission failures are diagnosed as permission-denied', () => {
    const diagnosis = classifyProbeError('Error: Failed to open probe: Permission denied (os error 13)');
    equal(diagnosis.kind, 'permission-denied');
    contains(diagnosis.message, 'udev');
});

test('a chip probe-rs cannot auto-detect is normal, not a probe fault', () => {
    const diagnosis = classifyProbeError(REAL_CHIP_NOT_DETECTED);
    equal(diagnosis.kind, 'chip-not-autodetected');
    contains(diagnosis.message, 'RP235x');
    contains(diagnosis.message, 'working');
});

test('a dead SWD link is diagnosed as no-target', () => {
    const diagnosis = classifyProbeError(REAL_NO_TARGET);
    equal(diagnosis.kind, 'no-target');
    contains(diagnosis.message, 'wiring');
});

test('the dead-link message wins over the generic chip-detection failure', () => {
    // Both real blobs start with "Connecting to the chip was unsuccessful"; only the
    // dead-link one carries the NO TARGET line, and that must take precedence.
    equal(classifyProbeError(REAL_NO_TARGET).kind, 'no-target');
    equal(classifyProbeError(REAL_CHIP_NOT_DETECTED).kind, 'chip-not-autodetected');
});

test('empty stderr means the probe is healthy', () => {
    equal(classifyProbeError('').kind, 'ok');
    equal(classifyProbeError('   \n  ').kind, 'ok');
});

test('unrecognised errors are kept verbatim', () => {
    const diagnosis = classifyProbeError('Error: something completely unexpected');
    equal(diagnosis.kind, 'unknown');
    contains(diagnosis.message, 'something completely unexpected');
});
