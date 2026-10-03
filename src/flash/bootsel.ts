import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RpFamily } from '../boards/types';

/**
 * BOOTSEL mass-storage volumes: finding one, and identifying which board it belongs to.
 *
 * Two features need this, which is why it has its own module:
 *   - the Debug Probe firmware update flow (writing `debugprobe.uf2` to the probe)
 *   - flashing a *project* over USB when there is no debug probe at all
 *
 * Nothing here imports `vscode`, so all of it is covered by tests. The waiting helpers take
 * a plain cancel callback rather than a `CancellationToken` for the same reason.
 */

/**
 * Volume labels a BOOTSEL mass-storage volume can present. The label comes from the boot
 * ROM's FAT image, so it identifies the silicon family:
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

/** Indented, human-readable identity lines for a confirmation dialog. */
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

/** The silicon a board family expects to find in BOOTSEL mode. */
export function siliconForFamily(family: RpFamily): SiliconFamily {
    return family === 'RP2040' ? 'rp2040' : 'rp2350';
}

/**
 * Warns when firmware built for one silicon is aimed at a volume that identifies as the
 * other. Written for the probe image first, but both flows use it: writing RP2040 firmware
 * to an RP2350 (or the reverse) does not run, and recovering the board needs the BOOTSEL
 * dance again — so we say so before the copy, not after.
 */
export function checkVolumeSilicon(
    expected: SiliconFamily,
    info: Uf2VolumeInfo,
    what: string,
): string | undefined {
    const found = volumeSilicon(info);
    if (found === 'unknown') {
        return (
            `Could not tell which chip this volume belongs to (no RP2040/RP2350 identity in ` +
            `${BOOTSEL_INFO_FILE}), and ${what} is ${expected.toUpperCase()} firmware.`
        );
    }
    if (found !== expected) {
        return (
            `${what} is ${expected.toUpperCase()} firmware, but this volume looks like ` +
            `an ${found.toUpperCase()} board.`
        );
    }
    return undefined;
}

// ------------------------------------------------------------------ waiting

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Best-effort current username, for the Linux mount paths under /media and /run/media. */
export function safeUserName(): string {
    try {
        return os.userInfo().username;
    } catch {
        return process.env.USER ?? process.env.USERNAME ?? 'user';
    }
}

/** The candidates and mount roots for this machine. */
export function bootselLocations(): { candidates: string[]; parents: string[] } {
    const user = safeUserName();
    return {
        candidates: bootselMountCandidates(process.platform, os.homedir(), user),
        parents: bootselMountParents(process.platform, user),
    };
}

/** One look for a BOOTSEL volume, using this machine's mount points. */
export function findBootselVolumeNow(): string | undefined {
    const { candidates, parents } = bootselLocations();
    return findBootselVolume(candidates, parents);
}

export interface WaitOptions {
    timeoutMs?: number;
    /** Polled once per second; return true to give up. */
    cancelled?: () => boolean;
}

/**
 * Waits for the user to put a board into BOOTSEL mode. Only a human can press the button,
 * so this polls quietly and reports progress, and gives up with instructions.
 */
export async function waitForBootselVolume(
    onProgress: (message: string) => void,
    options: WaitOptions = {},
): Promise<string> {
    const timeoutMs = options.timeoutMs ?? 180_000;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (options.cancelled?.()) {
            throw new Error('Cancelled.');
        }
        const volume = findBootselVolumeNow();
        if (volume) {
            return volume;
        }
        onProgress(`Waiting for the ${BOOTSEL_VOLUME_DESCRIPTION} — hold BOOTSEL while plugging the board in…`);
        await delay(1000);
    }
    throw new Error(
        `Timed out waiting for a ${BOOTSEL_VOLUME_DESCRIPTION}.\n` +
        'Hold BOOTSEL (the small button on the board) while plugging in the USB cable. ' +
        'On Linux the volume may need to be mounted by your desktop before this can see it.',
    );
}

/** Waits for the volume to vanish, which is what happens when the board takes the image. */
export async function waitForVolumeToDisappear(volume: string, options: WaitOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (options.cancelled?.()) {
            return;
        }
        if (!isBootselVolume(volume)) {
            return;
        }
        await delay(500);
    }
}
