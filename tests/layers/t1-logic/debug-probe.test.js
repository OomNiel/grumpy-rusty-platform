'use strict';

const { test, ok, equal, notOk, contains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const {
    DEBUGPROBE_VERSION,
    DEBUGPROBE_MIN_SUPPORTED,
    DEBUGPROBE_IMAGES,
    BOOTSEL_VOLUME_LABEL,
    BOOTSEL_INFO_FILE,
    bootselMountCandidates,
    compareVersions,
    debugProbeImageById,
    downloadUrlFor,
    isFirmwareOutdated,
    minimumFirmwareFromProbeRs,
    planProbeFirmwareUpdate,
    releaseTagFor,
    updateReason,
} = compiled('toolchain/debugProbe');
const { formatBytes } = compiled('util/hash');

/** The exact error probe-rs 0.32 produced against the firmware on the desk. */
const REAL_OUTDATED_OUTPUT =
    'Could not attach to target. Try running with --verbose for more information about the target.\n' +
    'Error: Failed to open probe: Failed to open the debug probe.\n\n' +
    'Caused by:\n' +
    '    0: The debug probe could not be created.\n' +
    '    1: An error specific with the selected probe occurred.\n' +
    '    2: The firmware on the probe is outdated, and not supported by probe-rs. ' +
    'The minimum supported firmware version is 2.2.0.';

test('the pinned firmware satisfies probe-rs', () => {
    ok(
        compareVersions(DEBUGPROBE_VERSION, DEBUGPROBE_MIN_SUPPORTED) >= 0,
        `${DEBUGPROBE_VERSION} must be >= ${DEBUGPROBE_MIN_SUPPORTED}`,
    );
});

test('every firmware image has a pinned hash and a believable size', () => {
    for (const image of DEBUGPROBE_IMAGES) {
        equal(image.sha256.length, 64, `${image.id} needs a full SHA-256`);
        ok(/^[0-9a-f]{64}$/.test(image.sha256), `${image.id} hash must be lowercase hex`);
        ok(image.size > 4096 && image.size < 1024 * 1024, `${image.id} size looks wrong: ${image.size}`);
        ok(image.fileName.endsWith('.uf2'), `${image.id} must be a .uf2`);
    }
});

test('image ids are unique and addressable', () => {
    const ids = DEBUGPROBE_IMAGES.map((image) => image.id);
    equal(new Set(ids).size, ids.length);
    ok(debugProbeImageById('debugprobe'), 'the Debug Probe image must exist');
    notOk(debugProbeImageById('nope'));
    notOk(debugProbeImageById(undefined));
});

test('the official Debug Probe image is the first choice offered', () => {
    equal(DEBUGPROBE_IMAGES[0].id, 'debugprobe');
    contains(DEBUGPROBE_IMAGES[0].description.toLowerCase(), 'debug probe');
});

test('download URLs point at the pinned release tag', () => {
    const image = debugProbeImageById('debugprobe');
    const url = downloadUrlFor(image);
    contains(url, `raspberrypi/debugprobe/releases/download/${releaseTagFor()}`);
    contains(url, 'debugprobe.uf2');
    contains(releaseTagFor(), DEBUGPROBE_VERSION);
});

test('the spare-Pico images exist for both silicon revisions', () => {
    ok(debugProbeImageById('debugprobe_on_pico'), 'RP2040 Pico-as-probe image missing');
    ok(debugProbeImageById('debugprobe_on_pico2'), 'RP2350 Pico-as-probe image missing');
});

test('compareVersions orders dotted versions', () => {
    equal(compareVersions('2.3.1', '2.2.0'), 1);
    equal(compareVersions('2.2.0', '2.3.1'), -1);
    equal(compareVersions('2.2.0', '2.2.0'), 0);
    equal(compareVersions('2.10.0', '2.9.0'), 1, 'numeric, not lexicographic');
    equal(compareVersions('2.3', '2.3.0'), 0, 'missing components are zero');
});

test('isFirmwareOutdated only complains with evidence', () => {
    equal(isFirmwareOutdated('2.1.0', '2.2.0'), true);
    equal(isFirmwareOutdated('2.2.0', '2.2.0'), false);
    equal(isFirmwareOutdated('2.3.1', '2.2.0'), false);
    equal(isFirmwareOutdated(undefined, '2.2.0'), false, 'an unknown version must not trigger a nag');
    equal(isFirmwareOutdated('', '2.2.0'), false);
});

test('the required version is read out of the real probe-rs failure', () => {
    equal(minimumFirmwareFromProbeRs(REAL_OUTDATED_OUTPUT), '2.2.0');
});

test('unrelated probe-rs output yields no required version', () => {
    equal(minimumFirmwareFromProbeRs('Error: Failed to open probe: Permission denied (os error 13)'), undefined);
    equal(minimumFirmwareFromProbeRs(''), undefined);
});

test('BOOTSEL volumes are found per platform', () => {
    const linux = bootselMountCandidates('linux', '/home/niel', 'niel');
    contains(linux.join('\n'), `/media/niel/${BOOTSEL_VOLUME_LABEL}`);
    contains(linux.join('\n'), `/run/media/niel/${BOOTSEL_VOLUME_LABEL}`);
    equal(bootselMountCandidates('darwin', '/Users/niel', 'niel'), [`/Volumes/${BOOTSEL_VOLUME_LABEL}`]);
    ok(bootselMountCandidates('win32', 'C:\\Users\\niel', 'niel').includes('D:\\'));
    equal(BOOTSEL_INFO_FILE, 'INFO_UF2.TXT', 'the volume is confirmed by this file');
});

test('a cached image skips the download step', () => {
    const image = debugProbeImageById('debugprobe');
    const steps = planProbeFirmwareUpdate(image, { hasCachedImage: true, diagnosis: 'firmware-outdated' });
    equal(
        steps.map((step) => step.id),
        ['bootsel', 'copy', 'verify'],
    );
});

test('an uncached image adds a download step carrying the pinned hash', () => {
    const image = debugProbeImageById('debugprobe');
    const steps = planProbeFirmwareUpdate(image, { hasCachedImage: false, diagnosis: 'firmware-outdated' });
    equal(
        steps.map((step) => step.id),
        ['download', 'bootsel', 'copy', 'verify'],
    );
    contains(steps[0].detail, image.sha256);
    contains(steps[0].detail, downloadUrlFor(image));
});

test('the BOOTSEL step is always present and marked as physical', () => {
    for (const image of DEBUGPROBE_IMAGES) {
        const steps = planProbeFirmwareUpdate(image, { hasCachedImage: true, diagnosis: 'ok' });
        const bootsel = steps.find((step) => step.id === 'bootsel');
        ok(bootsel, `${image.id}: no BOOTSEL step`);
        equal(bootsel.physical, true, 'only the user can press the button');
        equal(steps.filter((step) => step.physical).length, 1, 'exactly one step needs hands');
    }
});

test('the BOOTSEL wording matches the device being programmed', () => {
    const probe = planProbeFirmwareUpdate(debugProbeImageById('debugprobe'), {
        hasCachedImage: true,
        diagnosis: 'firmware-outdated',
    });
    contains(probe.find((s) => s.id === 'bootsel').detail, 'Debug Probe');

    const pico = planProbeFirmwareUpdate(debugProbeImageById('debugprobe_on_pico'), {
        hasCachedImage: true,
        diagnosis: 'ok',
    });
    contains(pico.find((s) => s.id === 'bootsel').detail, 'Pico');
});

test('the update reason reflects the diagnosis', () => {
    contains(updateReason('firmware-outdated', '2.2.0'), '2.2.0');
    contains(updateReason('permission-denied'), 'USB permissions');
    contains(updateReason('ok'), 'optional');
});

test('byte sizes are human readable', () => {
    equal(formatBytes(512), '512 B');
    equal(formatBytes(1024), '1.0 KB');
    equal(formatBytes(106_496), '104.0 KB');
    equal(formatBytes(231_077), '225.7 KB');
    equal(formatBytes(4 * 1024 * 1024), '4.0 MB');
});
