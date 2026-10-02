import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { downloadFile } from '../util/download';
import { formatBytes, sha256OfFile } from '../util/hash';
import {
    Cyw43BlobFile,
    cachedPathFor,
    cyw43CacheDir,
    filesForProject,
    missingBlobs,
    rawUrlFor,
    totalSize,
} from './cyw43Firmware';

/**
 * Fetches the CYW43 firmware blobs once into a shared cache and copies them into a
 * project's `firmware/` directory. Everything is SHA-256 verified on arrival, and a
 * cached file is re-verified rather than trusted.
 */

export interface Cyw43Host {
    output: vscode.OutputChannel;
}

export function isBlobCached(blob: Cyw43BlobFile): boolean {
    try {
        const target = cachedPathFor(blob);
        return fs.existsSync(target) && sha256OfFile(target) === blob.sha256;
    } catch {
        return false;
    }
}

export async function ensureBlob(blob: Cyw43BlobFile, host: Cyw43Host): Promise<string> {
    const target = cachedPathFor(blob);
    if (isBlobCached(blob)) {
        host.output.appendLine(`Using cached ${blob.fileName}`);
        return target;
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    const url = rawUrlFor(blob.fileName);
    host.output.appendLine(`Downloading ${url}`);
    await downloadFile(url, target);

    const actual = sha256OfFile(target);
    if (actual !== blob.sha256) {
        fs.rmSync(target, { force: true });
        throw new Error(
            `Checksum mismatch for ${blob.fileName}\n  expected ${blob.sha256}\n  actual   ${actual}\n` +
            'The file was deleted; the project was left without it.',
        );
    }
    host.output.appendLine(`Verified ${blob.fileName} (${formatBytes(blob.size)})`);
    return target;
}

/**
 * Downloads (once) and copies the CYW43 blobs into `<project>/firmware`, next to the
 * generated `firmware/README.md` that documents where they came from.
 */
export async function installFirmwareIntoProject(
    projectDir: vscode.Uri,
    blobFileNames: readonly string[],
    host: Cyw43Host,
): Promise<string[]> {
    const blobs = filesForProject(blobFileNames);
    const missing = missingBlobs(blobs, (fileName) => {
        const blob = blobs.find((candidate) => candidate.fileName === fileName);
        return blob ? isBlobCached(blob) : false;
    });

    host.output.appendLine(
        `CYW43 firmware: ${blobs.length} file(s), ${missing.length} to download ` +
        `(${formatBytes(totalSize(missing))}); cache ${cyw43CacheDir()}`,
    );

    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'CYW43 wireless firmware',
            cancellable: false,
        },
        async (progress) => {
            const written: string[] = [];
            for (const [index, blob] of blobs.entries()) {
                progress.report({
                    message: `${index + 1}/${blobs.length}: ${blob.fileName}`,
                    increment: 100 / blobs.length,
                });
                const source = await ensureBlob(blob, host);
                await vscode.workspace.fs.copy(
                    vscode.Uri.file(source),
                    vscode.Uri.joinPath(projectDir, 'firmware', blob.fileName),
                    { overwrite: true },
                );
                written.push(blob.fileName);
            }
            host.output.appendLine(`CYW43 firmware written: ${written.join(', ')}`);
            return written;
        },
    );
}
