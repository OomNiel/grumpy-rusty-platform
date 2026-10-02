import * as crypto from 'crypto';
import * as fs from 'fs';

/**
 * Hashing helpers shared by the toolchain installer and the debug-probe firmware
 * updater. Kept free of `vscode` so the logic stays testable.
 */

export function sha256OfFile(file: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function sha256OfBuffer(data: Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
}

/** The published `.sha256` files are `<hex>  <filename>` (cargo-dist format). */
export function parseSha256File(contents: string): string | undefined {
    const match = /^([0-9a-f]{64})\s/i.exec(contents.trim());
    return match?.[1]?.toLowerCase();
}

/** Human-readable byte size, e.g. `231.1 KB`. */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
