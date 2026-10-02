import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { augmentedEnv, findExecutable } from '../util/exec';
import { formatBytes } from '../util/hash';
import {
    BOOTSEL_VOLUME_DESCRIPTION,
    Uf2VolumeInfo,
    checkVolumeSilicon,
    readUf2Info,
    waitForBootselVolume,
    waitForVolumeToDisappear,
} from './bootsel';
import { findElfArtifactPath } from './cargoArtifacts';
import { siliconForUf2Family } from './route';
import { distUf2Path, elfToUf2 } from './uf2';

/**
 * Flashing a project with **no debug probe**: build, convert to UF2, then let the user put
 * the board into BOOTSEL mode by hand.
 *
 * The trade-off to be honest about: with no probe there is no RTT, so a probe-less user sees
 * the LED and nothing else — no `defmt` output, no panic messages.
 */

export interface UsbFlashConfirmation {
    uf2Path: string;
    bytes: number;
    volume: string;
    info: Uf2VolumeInfo | undefined;
    /** Set when the firmware's silicon and the volume's identity disagree. */
    warning: string | undefined;
}

export interface UsbFlashHost {
    output: vscode.OutputChannel;
    /**
     * Asked once the BOOTSEL volume has been found and before anything is copied. Same rule
     * as the probe firmware flow: `INFO_UF2.TXT` names a board *type* and carries no serial
     * number, so only a person can confirm this is the board they meant.
     */
    confirmWrite(request: UsbFlashConfirmation): Promise<boolean>;
}

export interface UsbFlashOptions {
    folder: vscode.Uri;
    /** UF2 family for this project's silicon (see `uf2FamilyForProject`). */
    familyId: number;
}

export interface UsbFlashResult {
    elf: string;
    uf2: string;
    volume: string;
    bytes: number;
    written: boolean;
}

function run(
    command: string,
    args: string[],
    cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env: augmentedEnv() });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

/** Builds in release mode and returns the path of the binary cargo linked. */
export async function buildReleaseElf(
    folder: vscode.Uri,
    output: vscode.OutputChannel,
): Promise<string> {
    const cargo = findExecutable('cargo');
    if (!cargo) {
        throw new Error('cargo was not found. Install the Rust toolchain first.');
    }

    output.appendLine(`Building: "${cargo}" build --release`);
    const { code, stdout, stderr } = await run(
        cargo,
        ['build', '--release', '--message-format=json-render-diagnostics'],
        folder.fsPath,
    );

    // Rendered diagnostics arrive on stderr; keep them visible.
    for (const line of stderr.split(/\r?\n/)) {
        if (line.trim() !== '') {
            output.appendLine(line);
        }
    }
    if (code !== 0) {
        output.show(true);
        throw new Error(`cargo build --release failed (exit ${code ?? 'signal'}) — see the output panel.`);
    }

    const elf = findElfArtifactPath(stdout);
    if (!elf) {
        throw new Error('cargo did not report a binary artefact — is this a binary crate?');
    }
    if (!fs.existsSync(elf)) {
        throw new Error(`cargo reported "${elf}", but it is not there.`);
    }
    return elf;
}

/** Build → convert → wait for BOOTSEL → confirm → copy → wait for the reboot. */
export async function flashProjectOverUsb(
    options: UsbFlashOptions,
    host: UsbFlashHost,
): Promise<UsbFlashResult> {
    const elf = await buildReleaseElf(options.folder, host.output);

    const uf2Path = distUf2Path(options.folder.fsPath, elf);
    const { uf2, image } = elfToUf2(fs.readFileSync(elf), options.familyId);
    fs.mkdirSync(path.dirname(uf2Path), { recursive: true });
    fs.writeFileSync(uf2Path, uf2);
    host.output.appendLine(
        `Converted ${path.basename(elf)} -> ${uf2Path}: ` +
        `${formatBytes(uf2.length)}, entry ${image.entry.toString(16)}, ` +
        `${image.segments.length} segment(s), family 0x${options.familyId.toString(16)}`,
    );

    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Flashing ${path.basename(elf)} over USB`,
            cancellable: true,
        },
        async (progress, token) => {
            progress.report({ message: `Waiting for ${BOOTSEL_VOLUME_DESCRIPTION}…` });
            const volume = await waitForBootselVolume(
                (message) => progress.report({ message }),
                { cancelled: () => token.isCancellationRequested },
            );

            const info = readUf2Info(volume);
            // The project's own silicon, checked against what the volume says it is.
            const warning = info
                ? checkVolumeSilicon(siliconForUf2Family(options.familyId), info, path.basename(uf2Path))
                : undefined;

            const agreed = await host.confirmWrite({
                uf2Path,
                bytes: uf2.length,
                volume,
                info,
                warning,
            });
            if (!agreed) {
                host.output.appendLine(`Nothing was written: ${volume} was not confirmed.`);
                return { elf, uf2: uf2Path, volume, bytes: uf2.length, written: false };
            }

            const destination = path.join(volume, path.basename(uf2Path));
            progress.report({ message: `Copying to ${volume}…` });
            host.output.appendLine(`Copying ${uf2Path} -> ${destination}`);
            try {
                fs.copyFileSync(uf2Path, destination);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(
                    `Could not write to ${destination}: ${message}\n` +
                    `The file is ready at ${uf2Path} — copy it onto the ${BOOTSEL_VOLUME_DESCRIPTION} by hand.`,
                );
            }

            progress.report({ message: 'Waiting for the board to restart…' });
            await waitForVolumeToDisappear(volume, { cancelled: () => token.isCancellationRequested });
            host.output.appendLine('BOOTSEL volume disappeared; the board should be running the new firmware.');
            return { elf, uf2: uf2Path, volume, bytes: uf2.length, written: true };
        },
    );
}
