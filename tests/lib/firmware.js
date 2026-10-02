'use strict';

/**
 * Shared helper for the opt-in layers that need the real CYW43 firmware blobs.
 *
 * It downloads the blobs straight from the pinned Embassy commit using the same
 * metadata the extension ships (`toolchain/cyw43Firmware`), verifying each SHA-256.
 * That makes the e2e layer a genuine check of the pinned URLs *and* hashes, not just
 * of the generated Rust.
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { compiled, repoRoot } = require('./harness');

const { filesForProject, rawUrlFor } = compiled('toolchain/cyw43Firmware');

function cacheDir() {
    return path.join(repoRoot(), 'tests', 'out', 'firmware-cache');
}

function sha256Of(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function download(url, destination, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 5) {
            reject(new Error(`Too many redirects for ${url}`));
            return;
        }
        https
            .get(url, { headers: { 'User-Agent': 'grumpy-rusty-platform-tests' } }, (response) => {
                const status = response.statusCode ?? 0;
                if (status >= 300 && status < 400 && response.headers.location) {
                    response.resume();
                    download(new URL(response.headers.location, url).toString(), destination, redirects + 1)
                        .then(resolve)
                        .catch(reject);
                    return;
                }
                if (status !== 200) {
                    response.resume();
                    reject(new Error(`HTTP ${status} for ${url}`));
                    return;
                }
                const file = fs.createWriteStream(destination);
                response.pipe(file);
                file.on('finish', () => file.close(() => resolve()));
                file.on('error', reject);
            })
            .on('error', reject);
    });
}

/** Cached, hash-verified copy of one blob. */
async function ensureBlob(blob) {
    const cached = path.join(cacheDir(), blob.fileName);
    if (fs.existsSync(cached) && sha256Of(cached) === blob.sha256) {
        return cached;
    }
    fs.mkdirSync(cacheDir(), { recursive: true });
    await download(rawUrlFor(blob.fileName), cached);

    const actual = sha256Of(cached);
    if (actual !== blob.sha256) {
        fs.rmSync(cached, { force: true });
        throw new Error(
            `Pinned hash for ${blob.fileName} is wrong.\n  expected ${blob.sha256}\n  actual   ${actual}`,
        );
    }
    return cached;
}

/** Downloads (with caching) and copies the requested blobs into `<project>/firmware`. */
async function installFirmware(projectDir, blobFileNames) {
    const blobs = filesForProject(blobFileNames);
    const firmwareDir = path.join(projectDir, 'firmware');
    fs.mkdirSync(firmwareDir, { recursive: true });

    for (const blob of blobs) {
        const source = await ensureBlob(blob);
        fs.copyFileSync(source, path.join(firmwareDir, blob.fileName));
    }
    return blobs.map((blob) => blob.fileName);
}

module.exports = { cacheDir, ensureBlob, installFirmware };
