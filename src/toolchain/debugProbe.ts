import { ProbeDiagnosisKind } from './detect';

/**
 * Raspberry Pi Debug Probe support.
 *
 * The Debug Probe ships with firmware that probe-rs may refuse to open
 * ("The firmware on the probe is outdated... minimum supported firmware version
 * is 2.2.0"). Recovery is the RP2040/RP2350 BOOTSEL dance: hold the button while
 * plugging in, then copy a `.uf2` onto the `RPI-RP2` volume.
 *
 * Everything here is pure so the steps and the pinned hashes are testable.
 * The physical actions live in probeFirmwareRunner.ts.
 */

/** Version we instruct users to install. */
export const DEBUGPROBE_VERSION = '2.3.1';

/** probe-rs 0.32 refuses anything older than this. */
export const DEBUGPROBE_MIN_SUPPORTED = '2.2.0';

export const DEBUGPROBE_RELEASE_BASE = 'https://github.com/raspberrypi/debugprobe/releases/download';

export function releaseTagFor(version: string = DEBUGPROBE_VERSION): string {
    return `debugprobe-v${version}`;
}

export type DebugProbeImageId = 'debugprobe' | 'debugprobe_on_pico' | 'debugprobe_on_pico2';

export interface DebugProbeImage {
    id: DebugProbeImageId;
    fileName: string;
    /** Exact size of the release asset, in bytes. */
    size: number;
    /** SHA-256 of the release asset — pinned here, verified before writing to a device. */
    sha256: string;
    label: string;
    description: string;
}

/**
 * Hashes computed from the debugprobe-v2.3.1 release assets on 2026-10-02.
 * The `debugprobe_on_pico*` images turn a spare Pico into a probe.
 */
export const DEBUGPROBE_IMAGES: DebugProbeImage[] = [
    {
        id: 'debugprobe',
        fileName: 'debugprobe.uf2',
        size: 106_496,
        sha256: 'aae9585f456c28c00865eb3df4d4bfc184f8e7ae60ebed3cc32a32512521a1b8',
        label: 'Raspberry Pi Debug Probe (official firmware)',
        description: 'For the Debug Probe itself. This is the one you normally want.',
    },
    {
        id: 'debugprobe_on_pico',
        fileName: 'debugprobe_on_pico.uf2',
        size: 105_984,
        sha256: '6649ebba11df46cfa6cfa1faec9706bd21303893cf3f1e40067284bd4e3792d4',
        label: 'Pico as a debug probe (RP2040)',
        description: 'Turns a spare Raspberry Pi Pico into a debug probe.',
    },
    {
        id: 'debugprobe_on_pico2',
        fileName: 'debugprobe_on_pico2.uf2',
        size: 99_840,
        sha256: '98cbb993872e4bb7bf7ac064cef8986cda171b9e783ef6ce1544873d7b704621',
        label: 'Pico 2 as a debug probe (RP2350)',
        description: 'Turns a spare Raspberry Pi Pico 2 into a debug probe.',
    },
];

export function debugProbeImageById(id: string | undefined): DebugProbeImage | undefined {
    return id === undefined ? undefined : DEBUGPROBE_IMAGES.find((image) => image.id === id);
}

export function downloadUrlFor(image: DebugProbeImage, version: string = DEBUGPROBE_VERSION): string {
    return `${DEBUGPROBE_RELEASE_BASE}/${releaseTagFor(version)}/${image.fileName}`;
}

/** The volume an RP2040/RP2350 exposes while in BOOTSEL (mass-storage) mode. */
export const BOOTSEL_VOLUME_LABEL = 'RPI-RP2';

/**
 * Places a BOOTSEL volume typically mounts, in the order we should probe them.
 * A candidate only counts once `INFO_UF2.TXT` is found inside it (see the runner),
 * which rules out an unrelated folder that merely shares the name.
 */
export function bootselMountCandidates(
    platform: NodeJS.Platform,
    home: string,
    user: string,
): string[] {
    if (platform === 'darwin') {
        return [`/Volumes/${BOOTSEL_VOLUME_LABEL}`];
    }
    if (platform === 'win32') {
        // BOOTSEL volumes usually take the first free drive letter.
        return 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => `${letter}:\\`);
    }
    return [
        `/media/${user}/${BOOTSEL_VOLUME_LABEL}`,
        `/run/media/${user}/${BOOTSEL_VOLUME_LABEL}`,
        `/media/${BOOTSEL_VOLUME_LABEL}`,
        `/mnt/${BOOTSEL_VOLUME_LABEL}`,
        `${home}/${BOOTSEL_VOLUME_LABEL}`,
    ];
}

/** File the boot ROM puts on every BOOTSEL volume; used to confirm we found the right thing. */
export const BOOTSEL_INFO_FILE = 'INFO_UF2.TXT';

// ------------------------------------------------------------------ versions

/** Compares dotted numeric versions. Returns -1, 0 or 1. Unparsable parts sort last. */
export function compareVersions(a: string, b: string): number {
    const parse = (value: string): number[] =>
        value
            .trim()
            .split('.')
            .map((part) => {
                const match = /^(\d+)/.exec(part);
                return match ? Number(match[1]) : -1;
            });
    const left = parse(a);
    const right = parse(b);
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
        const l = left[i] ?? 0;
        const r = right[i] ?? 0;
        if (l !== r) {
            return l < r ? -1 : 1;
        }
    }
    return 0;
}

/**
 * True when `current` is known and older than `minimum`.
 * An unknown current version returns false — we do not nag without evidence.
 */
export function isFirmwareOutdated(current: string | undefined, minimum: string): boolean {
    if (!current || compareVersions(current, '0.0.0') <= 0) {
        return false;
    }
    return compareVersions(current, minimum) < 0;
}

/** Pulls the required version out of probe-rs's "minimum supported firmware version is X". */
export function minimumFirmwareFromProbeRs(text: string): string | undefined {
    const match = /minimum supported firmware version is ([0-9]+(?:\.[0-9]+)*)/i.exec(text);
    return match?.[1];
}

// --------------------------------------------------------------------- plan

export interface ProbeFirmwareStep {
    id: 'download' | 'bootsel' | 'copy' | 'verify';
    title: string;
    detail: string;
    /** Requires a physical action from the user (the BOOTSEL button). */
    physical: boolean;
}

export interface ProbeFirmwarePlanOptions {
    /** True when the image is already in the local cache. */
    hasCachedImage: boolean;
    /** What probe-rs last reported, if anything. */
    diagnosis: ProbeDiagnosisKind;
}

/**
 * The steps to get the chosen firmware onto a probe. `download` is omitted when the
 * image is cached; the physical BOOTSEL step is always present because only the user
 * can press the button.
 */
export function planProbeFirmwareUpdate(
    image: DebugProbeImage,
    options: ProbeFirmwarePlanOptions,
): ProbeFirmwareStep[] {
    const steps: ProbeFirmwareStep[] = [];

    if (!options.hasCachedImage) {
        steps.push({
            id: 'download',
            title: `Download ${image.fileName} (${image.size} bytes)`,
            detail: `${downloadUrlFor(image)}\nSHA-256 must match ${image.sha256}`,
            physical: false,
        });
    }

    steps.push({
        id: 'bootsel',
        title: 'Put the target into BOOTSEL mode',
        detail:
            image.id === 'debugprobe'
                ? 'Hold the BOOTSEL button on the Debug Probe while plugging in its USB cable.'
                : 'Hold the BOOTSEL button on the Pico while plugging in its USB cable.',
        physical: true,
    });

    steps.push({
        id: 'copy',
        title: `Copy ${image.fileName} onto the ${BOOTSEL_VOLUME_LABEL} volume`,
        detail: 'The probe reboots by itself once the copy completes.',
        physical: false,
    });

    steps.push({
        id: 'verify',
        title: 'Wait for the probe to come back and re-check with probe-rs',
        detail: 'The volume disappears while the new firmware boots.',
        physical: false,
    });

    return steps;
}

/** One-line explanation of why an update is being offered. */
export function updateReason(diagnosis: ProbeDiagnosisKind, requiredVersion?: string): string {
    if (diagnosis === 'firmware-outdated') {
        return requiredVersion
            ? `probe-rs requires Debug Probe firmware ${requiredVersion} or newer.`
            : 'probe-rs reports that this probe firmware is too old.';
    }
    if (diagnosis === 'permission-denied') {
        return 'USB permissions are missing, so the firmware version cannot be read.';
    }
    return 'Updating is optional but recommended before reporting probe bugs.';
}
