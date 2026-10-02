import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { downloadFile } from '../util/download';
import { formatBytes, sha256OfFile } from '../util/hash';
import {
    DEBUGPROBE_VERSION,
    DebugProbeImage,
    checkSiliconMatch,
    downloadUrlFor,
} from './debugProbe';
import {
    BOOTSEL_VOLUME_DESCRIPTION,
    Uf2VolumeInfo,
    readUf2Info,
    waitForBootselVolume,
    waitForVolumeToDisappear,
} from '../flash/bootsel';

/**
 * Writes Debug Probe firmware. The interesting part is that only the *user* can
 * put the probe into BOOTSEL mode, so we cache and verify the image first, then
 * wait for the volume to show up and copy the file onto it.
 */

export interface ProbeFirmwareHost {
    output: vscode.OutputChannel;
    /**
     * Asked once a BOOTSEL volume has been found, before anything is written. Asking a
     * human is the only real gate available: `INFO_UF2.TXT` tells us the *type* of board
     * in BOOTSEL mode but carries no serial number, so nothing here can distinguish the
     * board you meant from another Pico that happens to be in BOOTSEL mode. Returning
     * false must leave the device untouched.
     */
    confirmWrite(request: ConfirmWriteRequest): Promise<boolean>;
}

/** Everything the user needs to decide whether this is the board they meant. */
export interface ConfirmWriteRequest {
    image: DebugProbeImage;
    volume: string;
    /** Parsed `INFO_UF2.TXT`, when it could be read. */
    info: Uf2VolumeInfo | undefined;
    /** Set when the image's silicon and the volume's identity disagree. */
    warning: string | undefined;
}

export function probeFirmwareCacheDir(version: string = DEBUGPROBE_VERSION): string {
    return path.join(os.homedir(), '.grumpy-rusty-platform', 'firmware', `debugprobe-${version}`);
}

export function imageCachePath(image: DebugProbeImage, version?: string): string {
    return path.join(probeFirmwareCacheDir(version), image.fileName);
}

/** True when the image is cached *and* still matches its pinned hash. */
export function isImageCached(image: DebugProbeImage): boolean {
    const target = imageCachePath(image);
    try {
        return fs.existsSync(target) && sha256OfFile(target) === image.sha256;
    } catch {
        return false;
    }
}

/** Downloads the firmware image once, verifying the pinned SHA-256. Returns its path. */
export async function ensureProbeImage(image: DebugProbeImage, host: ProbeFirmwareHost): Promise<string> {
    const target = imageCachePath(image);
    if (isImageCached(image)) {
        host.output.appendLine(`Using cached ${image.fileName} (${target})`);
        return target;
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    const url = downloadUrlFor(image);
    host.output.appendLine(`Downloading ${url}`);
    await downloadFile(url, target);

    const actual = sha256OfFile(target);
    if (actual !== image.sha256) {
        fs.rmSync(target, { force: true });
        throw new Error(
            `Checksum mismatch for ${image.fileName}\n  expected ${image.sha256}\n  actual   ${actual}\n` +
            'The file was deleted; nothing was written to the device.',
        );
    }
    host.output.appendLine(`Verified ${image.fileName} (${formatBytes(image.size)}, sha256 ${actual})`);
    return target;
}

/** Full flow: cache → wait for BOOTSEL → confirm → copy → wait for reboot. */
export async function updateProbeFirmware(
    image: DebugProbeImage,
    host: ProbeFirmwareHost,
): Promise<{ volume: string; written: boolean }> {
    const imagePath = await ensureProbeImage(image, host);

    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Debug Probe firmware: ${image.fileName}`,
            cancellable: true,
        },
        async (progress, token) => {
            progress.report({ message: `Waiting for ${BOOTSEL_VOLUME_DESCRIPTION}…` });
            const volume = await waitForBootselVolume(
                (message) => progress.report({ message }),
                { cancelled: () => token.isCancellationRequested },
            );

            // Identify the board and let a human confirm before a single byte is written.
            const info = readUf2Info(volume);
            const warning = info ? checkSiliconMatch(image, info) : undefined;
            const agreed = await host.confirmWrite({ image, volume, info, warning });
            if (!agreed) {
                host.output.appendLine(`Nothing was written: ${volume} was not confirmed.`);
                return { volume, written: false };
            }

            const destination = path.join(volume, image.fileName);
            progress.report({ message: `Copying to ${volume}…` });
            host.output.appendLine(`Copying ${imagePath} -> ${destination}`);
            try {
                fs.copyFileSync(imagePath, destination);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(
                    `Could not write to ${destination}: ${message}\n` +
                    `The image is ready at ${imagePath} — copy it onto the ${BOOTSEL_VOLUME_DESCRIPTION} by hand.`,
                );
            }

            progress.report({ message: 'Waiting for the board to restart…' });
            await waitForVolumeToDisappear(volume, { cancelled: () => token.isCancellationRequested });
            host.output.appendLine('BOOTSEL volume disappeared; new firmware should be running.');
            return { volume, written: true };
        },
    );
}
