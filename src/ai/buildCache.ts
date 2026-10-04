/* Keeping the compiled sidecar across VS Code reloads *and* extension updates.
 *
 * WHY A FINGERPRINT AND NOT A TIMESTAMP. The build output used to live inside the installed extension
 * (`<extension>/sidecar/target`), which survives a window reload but not an update: a new version is a new
 * folder, so llama.cpp — several minutes and hundreds of megabytes — was compiled again for a sidecar whose
 * source had not changed at all. Moving the output to the extension's **global storage** fixes the folder
 * problem; comparing a *content* fingerprint rather than modification times fixes the rest, because every
 * file in a freshly unpacked VSIX carries the install time, which is newer than any binary built before it.
 *
 * So the marker beside the binary records two things: which cargo backend it was built with (a feature is a
 * compile-time choice, and a CPU binary cannot answer "was I built for Vulkan?"), and the fingerprint of the
 * exact sources it came from. Same fingerprint and same backend means cargo is not even started.
 *
 * NO `vscode` IMPORT, deliberately: the decision is a function of file contents and a marker string, so the
 * t1 suite pins it without an editor or a compiler.
 */

import * as crypto from 'crypto';

/** What the marker beside a built sidecar records. */
export interface BuildMarker {
    /** `cpu`, `vulkan`, `cuda` or `metal` — the cargo feature set this binary was built with. */
    backend: string;
    /** Fingerprint of the sources it was built from (see {@link fingerprintSources}). */
    fingerprint: string;
}

/** One source file, as the fingerprint sees it. */
export interface SourceFile {
    /** Path relative to the sidecar directory, so the fingerprint does not move with the checkout. */
    name: string;
    text: string;
}

/**
 * A stable fingerprint of a set of sources.
 *
 * Sorted by name, so the order the filesystem happens to return them in cannot change the answer, and
 * truncated to 32 hex characters: this is a cache key, not a security boundary.
 */
export function fingerprintSources(files: readonly SourceFile[]): string {
    const hash = crypto.createHash('sha256');
    for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        hash.update(file.name);
        hash.update('\0');
        hash.update(file.text);
        hash.update('\0');
    }
    return hash.digest('hex').slice(0, 32);
}

/**
 * Reads the marker, tolerating the older format.
 *
 * The first version wrote the bare backend name (`cpu`); those markers have no fingerprint, so a build made
 * by that version is treated as stale and rebuilt once — which is the honest answer, since nothing recorded
 * what it was built from.
 */
export function parseBuildMarker(raw: string | undefined): BuildMarker | undefined {
    const text = String(raw ?? '').trim();
    if (!text) return undefined;
    try {
        const obj = JSON.parse(text) as { backend?: unknown; fingerprint?: unknown };
        if (typeof obj?.backend === 'string' && typeof obj?.fingerprint === 'string') {
            return { backend: obj.backend, fingerprint: obj.fingerprint };
        }
        return undefined;
    } catch {
        return { backend: text, fingerprint: '' };
    }
}

/** True when the binary at hand was built from exactly these sources, with exactly this backend. */
export function buildIsCurrent(
    marker: BuildMarker | undefined,
    backend: string,
    fingerprint: string
): boolean {
    return !!marker && marker.backend === backend && marker.fingerprint === fingerprint;
}

/** The marker's own text, ready to be written beside the binary. */
export function buildMarkerText(backend: string, fingerprint: string): string {
    return JSON.stringify({ backend, fingerprint } satisfies BuildMarker);
}
