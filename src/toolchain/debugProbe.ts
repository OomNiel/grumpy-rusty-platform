import * as fs from 'fs';
import * as path from 'path';
import { ProbeDiagnosisKind } from './detect';

/**
 * Raspberry Pi Debug Probe support.
 *
 * The Debug Probe ships with firmware that probe-rs may refuse to open
 * ("The firmware on the probe is outdated... minimum supported firmware version
 * is 2.2.0"). Recovery is the RP2040/RP2350 BOOTSEL dance: hold the button while
 * plugging in, then copy a `.uf2` onto the BOOTSEL volume — `RPI-RP2` on an RP2040,
 * `RP2350` on an RP2350.
 *
 * Everything here is pure (or plain filesystem access) so the steps, the pinned hashes
 * and the volume identification are testable. The VSCode-facing actions live in
 * probeFirmwareRunner.ts.
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

/**
 * Volume labels a BOOTSEL mass-storage volume can present. The label comes from the
 * boot ROM's FAT image, so it identifies the silicon family:
 *
 *   RP2040 (pico-bootrom-rp2040) -> `RPI-RP2`  — what an authentic Debug Probe uses
 *   RP2350 (pico-bootrom-rp2350) -> `RP2350`
 *
 * Both must be accepted: the Debug Probe is RP2040-based, a Pico 2 is RP2350.
 */
export const BOOTSEL_VOLUME_LABELS = ['RPI-RP2', 'RP2350'];

/** Describes the volume in user-facing text without committing to one label. */
export const BOOTSEL_VOLUME_DESCRIPTION = `BOOTSEL volume (${BOOTSEL_VOLUME_LABELS.join(' or ')})`;

/** File the boot ROM puts on every BOOTSEL volume; used to confirm we found the right thing. */
export const BOOTSEL_INFO_FILE = 'INFO_UF2.TXT';

/**
 * Places a BOOTSEL volume typically mounts, in the order we should probe them.
 * A candidate only counts once `INFO_UF2.TXT` is found inside it (see
 * `findBootselVolume`), which rules out an unrelated folder that merely shares the name.
 */
export function bootselMountCandidates(
    platform: NodeJS.Platform,
    home: string,
    user: string,
): string[] {
    if (platform === 'darwin') {
        return BOOTSEL_VOLUME_LABELS.map((label) => `/Volumes/${label}`);
    }
    if (platform === 'win32') {
        // Windows mounts by drive letter, not by label, so every letter is a candidate.
        return 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => `${letter}:\\`);
    }
    const candidates: string[] = [];
    for (const label of BOOTSEL_VOLUME_LABELS) {
        candidates.push(
            `/media/${user}/${label}`,
            `/run/media/${user}/${label}`,
            `/media/${label}`,
            `/mnt/${label}`,
            `${home}/${label}`,
        );
    }
    return candidates;
}

/**
 * Directories whose *children* are mounted volumes. Scanning these as a fallback means a
 * volume mounted under a name we did not predict — an unlabelled FAT, a desktop that
 * renames the mount point — is still found. It stays safe because every candidate must
 * contain `INFO_UF2.TXT` before it counts as a volume.
 */
export function bootselMountParents(platform: NodeJS.Platform, user: string): string[] {
    if (platform === 'darwin') {
        return ['/Volumes'];
    }
    if (platform === 'win32') {
        return [];
    }
    return [`/media/${user}`, `/run/media/${user}`, '/media', '/run/media', '/mnt'];
}

// ------------------------------------------------------------- volume identity

/**
 * What the board sitting in BOOTSEL mode says about itself. `INFO_UF2.TXT` is a version
 * line followed by `Key: value` lines; the boot ROMs insert `Model` and `Board-ID` and
 * nothing else:
 *
 *   RP2040  (pico-bootrom-rp2040/bootrom/info_uf2.txt)
 *     UF2 Bootloader v3.0 / Model: Raspberry Pi RP2 / Board-ID: RPI-RP2
 *   RP2350  (pico-bootrom-rp2350/src/nsboot/info_uf2_txt.h)
 *     UF2 Bootloader v1.1 / Model: Raspberry Pi RP2350 / Board-ID: RP2350
 *
 * Parsing is deliberately generic: those strings can be white-labelled through OTP, and
 * the file contains no serial number, so a human has to confirm which board is meant.
 */
export interface Uf2VolumeInfo {
    /** Where this was read from. */
    volume: string;
    /** First line, e.g. `UF2 Bootloader v1.1`. */
    header: string;
    /** Every `Key: value` line the file carries, in order. */
    fields: { key: string; value: string }[];
    model?: string;
    boardId?: string;
}

/** Parses the contents of an `INFO_UF2.TXT`. */
export function parseUf2Info(volume: string, text: string): Uf2VolumeInfo {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '');

    const fields: { key: string; value: string }[] = [];
    for (const line of lines) {
        const separator = line.indexOf(':');
        if (separator <= 0) {
            continue;
        }
        fields.push({ key: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() });
    }

    const pick = (key: string): string | undefined =>
        fields.find((field) => field.key.toLowerCase() === key)?.value;

    const first = lines[0];
    return {
        volume,
        header: first !== undefined && !first.includes(':') ? first : '',
        fields,
        model: pick('model'),
        boardId: pick('board-id'),
    };
}

/** True when `dir` holds the `INFO_UF2.TXT` that only a boot ROM writes. */
export function isBootselVolume(dir: string): boolean {
    try {
        return fs.existsSync(path.join(dir, BOOTSEL_INFO_FILE));
    } catch {
        return false;
    }
}

/** Reads and parses `INFO_UF2.TXT`; undefined when it is missing or unreadable. */
export function readUf2Info(volume: string): Uf2VolumeInfo | undefined {
    try {
        return parseUf2Info(volume, fs.readFileSync(path.join(volume, BOOTSEL_INFO_FILE), 'utf8'));
    } catch {
        return undefined;
    }
}

/**
 * Finds a BOOTSEL volume: the labelled paths first, then the children of the mount roots.
 * Nothing is accepted without `INFO_UF2.TXT` inside, so an ordinary USB stick cannot be
 * mistaken for a board in BOOTSEL mode.
 */
export function findBootselVolume(candidates: string[], parents: string[] = []): string | undefined {
    for (const candidate of candidates) {
        if (isBootselVolume(candidate)) {
            return candidate;
        }
    }
    for (const parent of parents) {
        let entries: string[];
        try {
            entries = fs.readdirSync(parent);
        } catch {
            // A mount root we cannot list is simply not a candidate.
            continue;
        }
        for (const entry of entries) {
            const child = path.join(parent, entry);
            if (isBootselVolume(child)) {
                return child;
            }
        }
    }
    return undefined;
}

/** Indented, human-readable identity lines for the confirmation dialog. */
export function describeUf2Info(info: Uf2VolumeInfo): string {
    const lines = [`  volume: ${info.volume}`];
    if (info.header) {
        lines.push(`  ${info.header}`);
    }
    if (info.model) {
        lines.push(`  Model: ${info.model}`);
    }
    if (info.boardId) {
        lines.push(`  Board-ID: ${info.boardId}`);
    }
    if (!info.model && !info.boardId) {
        lines.push(`  (${BOOTSEL_INFO_FILE} has no Model/Board-ID lines)`);
    }
    return lines.join('\n');
}

/** Which silicon a volume's identity points at, as far as we can tell. */
export type SiliconFamily = 'rp2040' | 'rp2350' | 'unknown';

/**
 * Classifies a volume by the identity strings it advertises. Tolerant on purpose: a
 * white-labelled board reports a custom `Board-ID`, which we refuse to guess about.
 */
export function volumeSilicon(info: Uf2VolumeInfo): SiliconFamily {
    const text = `${info.model ?? ''} ${info.boardId ?? ''}`.toUpperCase();
    if (text.includes('RP2350')) {
        return 'rp2350';
    }
    if (text.includes('RPI-RP2') || text.includes('RP2')) {
        return 'rp2040';
    }
    return 'unknown';
}

/** Which silicon a firmware image is built for. The Debug Probe itself is RP2040-based. */
export function siliconForImage(image: DebugProbeImage): Exclude<SiliconFamily, 'unknown'> {
    return image.id === 'debugprobe_on_pico2' ? 'rp2350' : 'rp2040';
}

/**
 * Warns when the firmware and the board in BOOTSEL mode disagree. RP2040 firmware written
 * to an RP2350 (or the reverse) simply does not run, and recovering the board needs the
 * BOOTSEL dance again — so we say so before the copy, not after.
 */
export function checkSiliconMatch(image: DebugProbeImage, info: Uf2VolumeInfo): string | undefined {
    const board = volumeSilicon(info);
    const wanted = siliconForImage(image);
    if (board === 'unknown') {
        return (
            `Could not tell which chip this volume belongs to (no RP2040/RP2350 identity in ` +
            `${BOOTSEL_INFO_FILE}), and ${image.fileName} is ${wanted.toUpperCase()} firmware.`
        );
    }
    if (board !== wanted) {
        return (
            `${image.fileName} is ${wanted.toUpperCase()} firmware, but this volume looks like ` +
            `an ${board.toUpperCase()} board.`
        );
    }
    return undefined;
}

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
        title: `Copy ${image.fileName} onto the ${BOOTSEL_VOLUME_DESCRIPTION}`,
        detail: 'The board reboots by itself once the copy completes.',
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
