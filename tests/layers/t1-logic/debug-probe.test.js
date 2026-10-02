'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, ok, equal, notOk, contains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const {
    DEBUGPROBE_VERSION,
    DEBUGPROBE_MIN_SUPPORTED,
    DEBUGPROBE_IMAGES,
    checkSiliconMatch,
    compareVersions,
    debugProbeImageById,
    downloadUrlFor,
    isFirmwareOutdated,
    minimumFirmwareFromProbeRs,
    planProbeFirmwareUpdate,
    releaseTagFor,
    siliconForImage,
    updateReason,
} = compiled('toolchain/debugProbe');
const {
    BOOTSEL_INFO_FILE,
    BOOTSEL_VOLUME_DESCRIPTION,
    BOOTSEL_VOLUME_LABELS,
    bootselMountCandidates,
    bootselMountParents,
    describeUf2Info,
    findBootselVolume,
    isBootselVolume,
    parseUf2Info,
    readUf2Info,
    volumeSilicon,
} = compiled('flash/bootsel');
const { formatBytes } = compiled('util/hash');

/**
 * The exact file the RP2350 boot ROM serves.
 * Source: raspberrypi/pico-bootrom-rp2350, src/nsboot/info_uf2_txt.h (the template inserts
 * `Board-ID` = "RP2350" and `Model` = "Raspberry Pi RP2350").
 */
const RP2350_INFO = 'UF2 Bootloader v1.1\nModel: Raspberry Pi RP2350\nBoard-ID: RP2350\n';

/**
 * The exact file the RP2040 boot ROM serves.
 * Source: raspberrypi/pico-bootrom-rp2040, bootrom/info_uf2.txt.
 */
const RP2040_INFO = 'UF2 Bootloader v3.0\nModel: Raspberry Pi RP2\nBoard-ID: RPI-RP2\n';

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

test('BOOTSEL volumes are found per platform, for both silicon revisions', () => {
    const linux = bootselMountCandidates('linux', '/home/niel', 'niel').join('\n');
    for (const label of BOOTSEL_VOLUME_LABELS) {
        contains(linux, `/media/niel/${label}`);
        contains(linux, `/run/media/niel/${label}`);
    }
    equal(
        bootselMountCandidates('darwin', '/Users/niel', 'niel'),
        BOOTSEL_VOLUME_LABELS.map((label) => `/Volumes/${label}`),
    );
    ok(bootselMountCandidates('win32', 'C:\\Users\\niel', 'niel').includes('D:\\'));
    equal(BOOTSEL_INFO_FILE, 'INFO_UF2.TXT', 'the volume is confirmed by this file');
});

test('both the authentic probe and a Pico 2 can be programmed', () => {
    equal(BOOTSEL_VOLUME_LABELS, ['RPI-RP2', 'RP2350'], 'RP2040 bootrom label first, then RP2350');
    contains(BOOTSEL_VOLUME_DESCRIPTION, 'RPI-RP2');
    contains(BOOTSEL_VOLUME_DESCRIPTION, 'RP2350');
});

test('the update plan does not assume a single volume label', () => {
    const steps = planProbeFirmwareUpdate(debugProbeImageById('debugprobe'), {
        hasCachedImage: true,
        diagnosis: 'firmware-outdated',
    });
    const copy = steps.find((step) => step.id === 'copy');
    contains(copy.title, 'RPI-RP2');
    contains(copy.title, 'RP2350');
});

test('mount roots are scanned so an unlabelled volume is still found', () => {
    const linux = bootselMountParents('linux', 'niel');
    contains(linux.join('\n'), '/media/niel');
    contains(linux.join('\n'), '/run/media/niel');
    equal(bootselMountParents('darwin', 'niel'), ['/Volumes']);
    equal(bootselMountParents('win32', 'niel'), [], 'drive letters are already exhaustive');
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

test('INFO_UF2.TXT from both boot ROMs parses into the same shape', () => {
    const rp2350 = parseUf2Info('/media/niel/RP2350', RP2350_INFO);
    equal(rp2350.header, 'UF2 Bootloader v1.1');
    equal(rp2350.model, 'Raspberry Pi RP2350');
    equal(rp2350.boardId, 'RP2350');
    equal(rp2350.fields.length, 2, 'Model and Board-ID are the only inserted fields');

    const rp2040 = parseUf2Info('/media/niel/RPI-RP2', RP2040_INFO);
    equal(rp2040.header, 'UF2 Bootloader v3.0');
    equal(rp2040.model, 'Raspberry Pi RP2');
    equal(rp2040.boardId, 'RPI-RP2');
});

test('the identity classifier tolerates white-labelled boards', () => {
    equal(volumeSilicon(parseUf2Info('v', RP2350_INFO)), 'rp2350');
    equal(volumeSilicon(parseUf2Info('v', RP2040_INFO)), 'rp2040');
    equal(volumeSilicon(parseUf2Info('v', 'UF2 Bootloader v1.0\n')), 'unknown');
    equal(
        volumeSilicon(parseUf2Info('v', 'UF2 Bootloader v1.1\nModel: Acme Widget\nBoard-ID: ACME-1\n')),
        'unknown',
        'a custom Board-ID is never guessed at',
    );
});

test('writing the wrong silicon to a board is flagged before the copy', () => {
    const rp2350 = parseUf2Info('/media/niel/RP2350', RP2350_INFO);
    const rp2040 = parseUf2Info('/media/niel/RPI-RP2', RP2040_INFO);

    equal(siliconForImage(debugProbeImageById('debugprobe')), 'rp2040', 'the authentic probe is RP2040');
    equal(siliconForImage(debugProbeImageById('debugprobe_on_pico')), 'rp2040');
    equal(siliconForImage(debugProbeImageById('debugprobe_on_pico2')), 'rp2350');

    equal(checkSiliconMatch(debugProbeImageById('debugprobe'), rp2040), undefined);
    equal(checkSiliconMatch(debugProbeImageById('debugprobe_on_pico2'), rp2350), undefined);
    contains(checkSiliconMatch(debugProbeImageById('debugprobe'), rp2350), 'RP2040');
    contains(checkSiliconMatch(debugProbeImageById('debugprobe_on_pico2'), rp2040), 'RP2350');
    contains(
        checkSiliconMatch(debugProbeImageById('debugprobe'), parseUf2Info('v', 'UF2 Bootloader v1.0\n')),
        'Could not tell',
        'an unidentifiable volume is called out, not assumed',
    );
});

test('the confirmation names the board it is about to overwrite', () => {
    const described = describeUf2Info(parseUf2Info('/media/niel/RP2350', RP2350_INFO));
    contains(described, '/media/niel/RP2350');
    contains(described, 'UF2 Bootloader v1.1');
    contains(described, 'Model: Raspberry Pi RP2350');
    contains(described, 'Board-ID: RP2350');

    contains(describeUf2Info(parseUf2Info('/mnt/x', 'UF2 Bootloader v1.0\n')), 'no Model/Board-ID');
});

test('a volume counts only when a boot ROM put INFO_UF2.TXT in it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rusty-bootsel-'));
    const volume = path.join(root, 'RP2350');
    const decoy = path.join(root, 'usb-stick');
    fs.mkdirSync(volume);
    fs.mkdirSync(decoy);
    fs.writeFileSync(path.join(decoy, 'holiday-photos.txt'), 'not a bootloader');

    try {
        equal(isBootselVolume(volume), false);
        equal(findBootselVolume([path.join(root, 'RPI-RP2')]), undefined, 'a missing path is not a volume');
        equal(findBootselVolume([decoy, volume]), undefined, 'no INFO_UF2.TXT means no volume');

        fs.writeFileSync(path.join(volume, BOOTSEL_INFO_FILE), RP2350_INFO);

        equal(isBootselVolume(volume), true);
        equal(findBootselVolume([decoy, volume]), volume, 'the labelled path wins');
        equal(findBootselVolume([], [root]), volume, 'the fallback scan finds it by content, not by name');
        equal(findBootselVolume([], [path.join(root, 'nope')]), undefined, 'an unlistable root is skipped');

        equal(readUf2Info(volume).boardId, 'RP2350');
        equal(readUf2Info(decoy), undefined, 'a volume without the file reads as unknown');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('byte sizes are human readable', () => {
    equal(formatBytes(512), '512 B');
    equal(formatBytes(1024), '1.0 KB');
    equal(formatBytes(106_496), '104.0 KB');
    equal(formatBytes(231_077), '225.7 KB');
    equal(formatBytes(4 * 1024 * 1024), '4.0 MB');
});
