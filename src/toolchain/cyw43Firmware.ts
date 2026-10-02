import * as os from 'os';
import * as path from 'path';

/**
 * Pinned CYW43 firmware blobs.
 *
 * These are the exact files Embassy's own examples use, taken from a *commit*, not
 * a branch, so the pinned SHA-256 hashes below cannot drift. We deliberately do not
 * ship them inside the extension: they carry their own binary licence, so the
 * wizard downloads them on demand (once) and caches them.
 */

export const CYW43_FIRMWARE_COMMIT = 'b12a6d9efcd2711037abca1b63a661a9ef726444';

export const CYW43_FIRMWARE_RAW_BASE =
    `https://raw.githubusercontent.com/embassy-rs/embassy/${CYW43_FIRMWARE_COMMIT}/cyw43-firmware`;

export interface Cyw43BlobFile {
    fileName: string;
    size: number;
    sha256: string;
}

/** Hashes computed 2026-10-02 from the pinned commit above. */
export const CYW43_BLOBS: readonly Cyw43BlobFile[] = [
    {
        fileName: '43439A0.bin',
        size: 231_077,
        sha256: '5555e0261da2610a500d68c18d895cace0152bbefbf76f4aa683ebce77e3d7eb',
    },
    {
        fileName: '43439A0_clm.bin',
        size: 984,
        sha256: 'e712b3d218e8b1e2747b092e03b8b0afcb8c8c8e355d2a4a0d47b493800f3f89',
    },
    {
        fileName: 'nvram_rp2040.bin',
        size: 742,
        sha256: '4904bdbb0c937bd0ac2eb2a1d62f2da4dd90e32082384e02874e8d671b0f330d',
    },
    {
        fileName: '43439A0_btfw.bin',
        size: 6_164,
        sha256: 'ce1992c1a6a16ae51bc012439486e9fb212623eca92d9e82a8090c2acf7ef1df',
    },
];

/** The binary licence that covers the blobs; copied next to them in each project. */
export const CYW43_LICENCE_FILE: Cyw43BlobFile = {
    fileName: 'LICENSE-permissive-binary-license-1.0.txt',
    size: 2_419,
    sha256: '5f65b8a496ac27afda41917c18cb6e690b4a022df1f5a12ea823eb38a287f50e',
};

export function rawUrlFor(fileName: string): string {
    return `${CYW43_FIRMWARE_RAW_BASE}/${fileName}`;
}

export function blobFor(fileName: string): Cyw43BlobFile | undefined {
    if (fileName === CYW43_LICENCE_FILE.fileName) {
        return CYW43_LICENCE_FILE;
    }
    return CYW43_BLOBS.find((blob) => blob.fileName === fileName);
}

/** Every file a project needs: the blobs it references plus the licence. */
export function filesForProject(blobFileNames: readonly string[]): Cyw43BlobFile[] {
    const wanted = new Set([...blobFileNames, CYW43_LICENCE_FILE.fileName]);
    return [...wanted].map((name) => {
        const blob = blobFor(name);
        if (!blob) {
            throw new Error(`No pinned hash for firmware file "${name}"`);
        }
        return blob;
    });
}

/** Local cache shared by every project, keyed by the pinned embassy commit. */
export function cyw43CacheDir(home: string = os.homedir()): string {
    return path.join(home, '.grumpy-rusty-platform', 'firmware', `cyw43-${CYW43_FIRMWARE_COMMIT.slice(0, 8)}`);
}

export function cachedPathFor(blob: Cyw43BlobFile, home: string = os.homedir()): string {
    return path.join(cyw43CacheDir(home), blob.fileName);
}

/** Which of `blobs` are not present locally, given an injected existence check. */
export function missingBlobs(
    blobs: readonly Cyw43BlobFile[],
    exists: (fileName: string) => boolean,
): Cyw43BlobFile[] {
    return blobs.filter((blob) => !exists(blob.fileName));
}

/** Total download size for a set of blobs, in bytes. */
export function totalSize(blobs: readonly Cyw43BlobFile[]): number {
    return blobs.reduce((sum, blob) => sum + blob.size, 0);
}
