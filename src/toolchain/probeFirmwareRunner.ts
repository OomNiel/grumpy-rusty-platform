import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { downloadFile } from '../util/download';
import { formatBytes, sha256OfFile } from '../util/hash';
import {
    BOOTSEL_INFO_FILE,
    BOOTSEL_VOLUME_LABEL,
    DEBUGPROBE_VERSION,
    DebugProbeImage,
    bootselMountCandidates,
    downloadUrlFor,
} from './debugProbe';

/**
 * Writes Debug Probe firmware. The interesting part is that only the *user* can
 * put the probe into BOOTSEL mode, so we cache and verify the image first, then
 * wait for the volume to show up and copy the file onto it.
 */

export interface ProbeFirmwareHost {
    output: vscode.OutputChannel;
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

/**
 * Finds a BOOTSEL volume. We confirm it by the `INFO_UF2.TXT` the boot ROM writes,
 * which avoids mistaking an unrelated folder for the probe.
 */
export function findBootselVolume(
    candidates: string[] = bootselMountCandidates(process.platform, os.homedir(), safeUserName()),
): string | undefined {
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(path.join(candidate, BOOTSEL_INFO_FILE))) {
                return candidate;
            }
        } catch {
            // Unreadable mount points are simply not candidates.
        }
    }
    return undefined;
}

function safeUserName(): string {
    try {
        return os.userInfo().username;
    } catch {
        return process.env.USER ?? process.env.USERNAME ?? 'user';
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForBootselVolume(
    token: vscode.CancellationToken,
    onProgress: (message: string) => void,
    timeoutMs = 180_000,
): Promise<string> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (token.isCancellationRequested) {
            throw new Error('Cancelled.');
        }
        const volume = findBootselVolume();
        if (volume) {
            return volume;
        }
        onProgress(
            `Waiting for the ${BOOTSEL_VOLUME_LABEL} volume — hold BOOTSEL while plugging the probe in…`,
        );
        await delay(1000);
    }
    throw new Error(
        `Timed out waiting for a ${BOOTSEL_VOLUME_LABEL} volume.\n` +
        'Hold BOOTSEL (the small button on the probe) while plugging in the USB cable. ' +
        'On Linux the volume may need to be mounted by your desktop before this can see it.',
    );
}

export async function waitForVolumeToDisappear(
    volume: string,
    token: vscode.CancellationToken,
    timeoutMs = 60_000,
): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (token.isCancellationRequested) {
            return;
        }
        if (!fs.existsSync(path.join(volume, BOOTSEL_INFO_FILE))) {
            return;
        }
        await delay(500);
    }
}

/** Full flow: cache → wait for BOOTSEL → copy → wait for reboot. */
export async function updateProbeFirmware(
    image: DebugProbeImage,
    host: ProbeFirmwareHost,
): Promise<{ volume: string }> {
    const imagePath = await ensureProbeImage(image, host);

    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Debug Probe firmware: ${image.fileName}`,
            cancellable: true,
        },
        async (progress, token) => {
            progress.report({ message: `Waiting for ${BOOTSEL_VOLUME_LABEL}…` });
            const volume = await waitForBootselVolume(token, (message) => progress.report({ message }));

            const destination = path.join(volume, image.fileName);
            progress.report({ message: `Copying to ${volume}…` });
            host.output.appendLine(`Copying ${imagePath} -> ${destination}`);
            try {
                fs.copyFileSync(imagePath, destination);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(
                    `Could not write to ${destination}: ${message}\n` +
                    `The image is ready at ${imagePath} — copy it onto the ${BOOTSEL_VOLUME_LABEL} volume by hand.`,
                );
            }

            progress.report({ message: 'Waiting for the probe to restart…' });
            await waitForVolumeToDisappear(volume, token);
            host.output.appendLine('Probe volume disappeared; new firmware should be running.');
            return { volume };
        },
    );
}
