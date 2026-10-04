/* Looking for weights that are already on this machine, before a download is spent on them.
 *
 * WHY THIS EXISTS. Selecting a local model used to look only inside the extension's own storage folder, so a
 * 4.4 GB `.gguf` already sitting in `~/Downloads`, on a mounted drive, or in another tool's cache was
 * downloaded again. The same file is the same bytes, and a hash is what makes "the same" true rather than
 * assumed — a `.gguf` of the wrong quantisation can share a name, and adopting it would be worse than not
 * having a model at all.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not hash every `.gguf` on the disk; that would cost more than the
 * download it hopes to save. A file is a *candidate* when its name is exactly the spec's, or when its size
 * is exactly the spec's. Only candidates are hashed, and the hash is what decides. The walk is bounded in
 * depth and time because `/media` and `/mnt` can hold network mounts, and a search that hangs is worse than
 * a download that starts.
 *
 * NO `vscode` IMPORT. Everything here is a function of the filesystem, so the t1 suite drives it with a
 * temporary directory instead of an editor — the same reason `localModels.ts` and `modelSpecs.ts` are free
 * of it. That is also why `roots` and `budgetMs` are injectable: the tests point the search at a folder they
 * just made, and one of them makes the budget expire on purpose.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canImportFile, scanRoots } from './localModels';
import { rankLocalCandidates, type LocalModelCandidate, type ModelSpec } from './modelSpecs';

/** How long the search may take before it gives up and lets the download happen. */
export const LOCAL_SEARCH_BUDGET_MS = 15_000;

/** How deep the walk goes. A model is a big file near the top of a folder, never in a deep tree. */
const MAX_DEPTH = 5;

/** Directories never worth descending into, for the same reason the panel's scan skips them. */
const SKIP_DIRS = /^(proc|sys|dev|run|snap|node_modules)$/;

export interface LocalSearchOptions {
    /** One line per step, for the panel or the notification. */
    onProgress?: (message: string) => void;
    /** Stop early — the user cancelled the download. */
    isCancelled?: () => boolean;
    /** Where to look. Defaults to the machine's usual model folders (`scanRoots`). */
    roots?: string[];
    /**
     * Overridable so a test can watch a budget expire without waiting 15 seconds. `0` means "do not
     * search at all", which is also the honest reading of a zero budget.
     */
    budgetMs?: number;
    /** Injected for the same reason: hashing is not the thing under test. */
    hash?: (file: string) => Promise<string>;
}

/** SHA-256 of a file, streamed so a 4 GB model does not have to fit in memory. */
export function sha256File(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(file);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

/**
 * The path of a verified copy of `spec` already on this machine, or undefined.
 *
 * The name-matched files are tried first (cheap, and the strongest signal), then the size-matched ones. A
 * candidate that fails the hash is skipped rather than fatal: there may be a correct copy further down the
 * list, and the caller's fallback — a download — is always available.
 */
export async function findLocalCopy(
    spec: ModelSpec,
    opts: LocalSearchOptions = {}
): Promise<string | undefined> {
    const saying = opts.onProgress ?? (() => undefined);
    const hash = opts.hash ?? sha256File;
    const budget = opts.budgetMs ?? LOCAL_SEARCH_BUDGET_MS;
    const started = Date.now();
    // `>=` so a zero budget expires immediately: "do not search" is a useful thing to be able to say.
    const overBudget = (): boolean => Date.now() - started >= budget;
    const wanted = spec.fileName.toLowerCase();
    const candidates: LocalModelCandidate[] = [];
    let visited = 0;

    const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH || opts.isCancelled?.() || overBudget()) return;
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return; // unreadable: a permission or a broken mount is not a failure worth reporting
        }
        for (const entry of entries) {
            if (opts.isCancelled?.() || overBudget()) return;
            if (entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (SKIP_DIRS.test(entry.name)) continue;
                await walk(full, depth + 1);
                continue;
            }
            if (!entry.isFile()) continue;
            visited += 1;
            if (!canImportFile(entry.name)) continue;
            const byName = entry.name.toLowerCase() === wanted;
            if (!byName) {
                // Without a name match the only cheap signal is the size, so it is read here and nowhere else.
                try {
                    if ((await fs.promises.stat(full)).size !== spec.bytes) continue;
                } catch {
                    continue;
                }
            }
            candidates.push({ file: full, name: entry.name, bytes: byName ? undefined : spec.bytes });
        }
    };

    for (const root of opts.roots ?? scanRoots(os.homedir())) {
        try {
            if (!fs.existsSync(root)) continue;
        } catch {
            continue;
        }
        saying(`looking for ${spec.fileName} in ${root.replace(os.homedir(), '~')}…`);
        await walk(root, 0);
        if (opts.isCancelled?.() || overBudget()) break;
    }

    const ranked = rankLocalCandidates(candidates, spec);
    for (const candidate of ranked) {
        // The walk's budget does not cover hashing (which is disk-bound, not tree-bound), so the ceiling is
        // three times the walk's: enough for a few 4 GB candidates, not enough to read a whole drive.
        if (opts.isCancelled?.() || Date.now() - started >= budget * 3) return undefined;
        let bytes = candidate.bytes;
        if (bytes === undefined) {
            try {
                bytes = fs.statSync(candidate.file).size;
            } catch {
                continue;
            }
        }
        if (bytes !== spec.bytes) continue;
        saying(`checking ${candidate.file.replace(os.homedir(), '~')}…`);
        try {
            if ((await hash(candidate.file)) !== spec.sha256) continue;
        } catch {
            continue;
        }
        return candidate.file;
    }
    return undefined;
}

/**
 * Puts a verified local copy where the runtime expects it, preferring a hard link.
 *
 * A hard link shares the inode, so the weights are not duplicated and deleting the original later does not
 * remove the model. Across filesystems a link is impossible (EXDEV), and then a copy is the only way to keep
 * one models folder — the alternative, pointing `modelPath` at the found file, would leave the extension's
 * bookkeeping ("already downloaded", the `.verified` marker) describing a folder that no longer holds it.
 */
export function adoptLocalCopy(dest: string, source: string): 'hard link' | 'copy' {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { force: true });
    try {
        fs.linkSync(source, dest);
        return 'hard link';
    } catch {
        fs.copyFileSync(source, dest);
        return 'copy';
    }
}
