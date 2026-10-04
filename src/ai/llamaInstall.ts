/* Getting a `llama-server` onto a machine that has none (asked 2026-10-04).
 *
 * *"If the server … is not on the host machine the extention must offer to download and install."* The
 * feature this belongs to is "My own llama-server" — the user's own llama.cpp, which is the fastest of the
 * three engines and the one this developer actually uses (a systemd user unit holding a 30 B Qwen3-Coder on
 * port 8080). The catch is that it is also the only one the extension could not set up for anyone: LM Studio
 * installs itself, and the bundled runtime builds itself, but a user with no llama.cpp got a sentence telling
 * them to go and compile C++.
 *
 * WHAT THIS DOES, in five steps: ask GitHub for the newest release of `ggml-org/llama.cpp`; pick the asset
 * that matches this platform and architecture; download it to a `.part` file with progress and resume;
 * verify it against the `sha256:` digest the API published; unpack it with the system `tar` into
 * `<global storage>/llama.cpp/<tag>/` and hand back the `llama-server` inside.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not download a GPU build (cuda/rocm/vulkan/sycl/openvino). Those
 * are 150-600 MB instead of 18, and whether they work depends on a driver this extension cannot inspect —
 * the CPU build is the one that runs everywhere, and the user's own build is one setting away for anyone who
 * wants more. It does not use the release page's HTML: the API is what carries the digest, and a download
 * that cannot be verified is not one to hand a user and then execute.
 *
 * THE DECISIONS ARE NOT HERE. Which asset, how to unpack it, what the binary is called and which entry in the
 * archive is the server are all pure functions in `localModels.ts`, where the t1 suite pins them without a
 * network. What is left here is the network and the filesystem.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { log, logError } from './log';
import {
    digestHex,
    extractArgs,
    installReleaseFor,
    llamaBinaryName,
    llamaReleasesApiUrl,
    parseLlamaVersion,
    parseReleases,
    pickBinaryFromListing,
    type ReleaseAsset
} from './localModels';
import { formatBytes, shortHash } from './modelSpecs';
import { downloadToFile } from './runtime';
import { sha256File } from './localSearch';

/** Where the installs live, inside the extension's global storage. */
const FOLDER = 'llama.cpp';

/** The API call is small and quick; a machine with no route to GitHub should not hang on it. */
const API_TIMEOUT_MS = 20_000;

/** Where the installs live, and where this tag's own folder is. */
export function llamaInstallDir(context: vscode.ExtensionContext, tag: string): string {
    return path.join(context.globalStorageUri.fsPath, FOLDER, tag);
}

/** `llama-server --version`, for the log and for proving a fresh install actually runs. Bounded. */
export function llamaServerVersion(bin: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        const child = cp.execFile(bin, ['--version'], { timeout: 8000 }, (err, stdout, stderr) => {
            if (err && !stdout && !stderr) return resolve(undefined);
            resolve(parseLlamaVersion(String(stdout ?? ''), String(stderr ?? '')));
        });
        child.on('error', () => resolve(undefined));
    });
}

/**
 * The recent prebuilt releases, as the API describes them — raw, for the pure chooser to read.
 *
 * The *list* is asked for rather than "latest", because on llama.cpp "latest" is the tagged `v0.5.0` release
 * whose only asset is `nightly-tag.txt`: the binaries live under `bNNNNN` tags that endpoint does not return
 * (found by running this for real on 2026-10-04). A 403 is GitHub's unauthenticated rate limit (60 calls an
 * hour per address, which a person will not reach and a shared office might) and is reported as itself rather
 * than as "no network" — the two need different answers from the user.
 */
async function fetchReleases(): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
        const res = await fetch(llamaReleasesApiUrl(), {
            signal: controller.signal,
            headers: { accept: 'application/vnd.github+json', 'user-agent': 'grumpy-rusty-platform' }
        });
        if (!res.ok) {
            throw new Error(res.status === 403
                ? 'GitHub refused the request (its limit for unauthenticated requests was reached) — try again later, '
                + 'or build llama.cpp yourself and point "llamaServerPath" at it.'
                : `GitHub answered ${res.status} for the llama.cpp release list.`);
        }
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

export interface InstallResult {
    /** The unpacked `llama-server`, ready to run. */
    bin: string;
    tag: string;
    asset: ReleaseAsset;
    /** The version the freshly unpacked binary printed — proof it runs, not just that it unpacked. */
    version?: string;
}

/**
 * Downloads and unpacks the prebuilt `llama-server` for this machine, and proves it runs.
 *
 * Throws a sentence meant for the user at every failure: nothing published for this platform, no digest to
 * verify against, a checksum that does not match, `tar` refusing the archive, or a binary that does not
 * answer `--version` (which is how a wrong architecture or a missing shared library shows up).
 */
export async function installLlamaServer(
    context: vscode.ExtensionContext,
    opts: { onProgress?: (message: string) => void } = {}
): Promise<InstallResult> {
    const saying = opts.onProgress ?? (() => undefined);
    saying('asking GitHub for the newest llama.cpp release…');
    const releases = await fetchReleases();
    const choice = installReleaseFor(releases);
    if (!choice) {
        const seen = parseReleases(releases).length;
        throw new Error(
            seen === 0
                ? 'llama.cpp\'s release list could not be read — check the connection and try again.'
                : `llama.cpp publishes no prebuilt server for this machine (${process.platform}/${process.arch}). `
                + 'Build it yourself (https://github.com/ggml-org/llama.cpp) and set "llamaServerPath" to the binary.'
        );
    }
    const { tag, asset } = choice;
    const sha = digestHex(asset.digest);
    if (!sha) {
        throw new Error(
            `${asset.name} came without a checksum, and an executable that cannot be verified is not one this `
            + 'extension will download and run. Build llama.cpp yourself, or pick the release by hand.'
        );
    }

    const dir = llamaInstallDir(context, tag);
    fs.mkdirSync(dir, { recursive: true });
    const archive = path.join(dir, asset.name);
    const part = `${archive}.part`;
    const existing = fs.existsSync(part) ? fs.statSync(part).size : 0;
    // A partial file is kept between attempts, exactly like a model download: 18 MB is small, but the
    // resume path is the same code and the same promise, and a file larger than the asset is stale.
    const resume = existing > 0 && existing < asset.bytes ? existing : 0;
    log(`llama.cpp install: ${asset.name} (${formatBytes(asset.bytes)}) → ${dir}${resume ? ` (resuming at ${resume} bytes)` : ''}`);

    // The path of the `llama-server` **inside** the archive, resolved before anything is unpacked: the
    // archive's own layout is the authority on where the binary and the shared libraries beside it land.
    let relative = '';
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Downloading ${asset.name}`, cancellable: true },
        async (progress, token) => {
            await downloadToFile(asset.url, part, asset.bytes, progress, token, resume);
            progress.report({ message: 'checking the checksum…' });
            const hash = await sha256File(part);
            if (hash !== sha) {
                fs.rmSync(part, { force: true });
                throw new Error(
                    `The downloaded llama.cpp build does not match the checksum GitHub published (${shortHash(hash)} `
                    + `instead of ${shortHash(sha)}) — please try again.`
                );
            }
            fs.renameSync(part, archive);

            progress.report({ message: 'unpacking it…' });
            const listing = await tar(argumentsForListing(archive), dir);
            const found = pickBinaryFromListing(listing);
            if (!found) {
                throw new Error(`${asset.name} did not contain a ${llamaBinaryName()} — the download may be the wrong file.`);
            }
            relative = found;
            await tar(extractArgs(archive, dir), dir);
            // The archive keeps the exec bit, but a zip unpacked by a tool that does not restore Unix
            // permissions would not, and "llama-server could not be started (is it executable?)" is a
            // confusing way to learn that. The `.so` files beside it need no bit.
            fs.chmodSync(path.join(dir, relative), 0o755);
            fs.rmSync(archive, { force: true });
        }
    );

    const bin = path.join(dir, relative);
    if (!fs.existsSync(bin)) throw new Error(`The build was unpacked but no ${llamaBinaryName()} was found under ${dir}.`);
    const version = await llamaServerVersion(bin);
    if (!version) {
        throw new Error(
            `The llama.cpp build was unpacked to ${bin} but it will not run (no answer to --version). `
            + 'Build llama.cpp yourself and set "llamaServerPath" to your own binary.'
        );
    }
    log(`llama.cpp install: ready — ${bin} (version ${version})`);
    return { bin, tag, asset, version };
}

/** `-tzf` for a tarball, `-tf` for a zip — the listing half of `extractArgs`. */
function argumentsForListing(archive: string): string[] {
    return /\.zip$/i.test(archive) ? ['-tf', archive] : ['-tzf', archive];
}

/** Runs `tar` and returns its stdout lines. `tar` reads zips too (see `extractArgs`). */
function tar(args: string[], cwd: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
        cp.execFile('tar', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                logError(`llama.cpp install: tar ${args.join(' ')} failed: ${String(stderr || err.message).trim()}`);
                reject(new Error(`Could not unpack the llama.cpp build (tar ${args[0]} failed: ${String(stderr || err.message).split('\n')[0]?.trim()}).`));
                return;
            }
            resolve(String(stdout ?? '').split(/\r?\n/).filter((l) => l.trim().length > 0));
        });
    });
}

/**
 * The whole offer: install llama.cpp, or use a build the user already has, or stop.
 *
 * Returns the binary to use, or undefined when the user backed out. The message written by
 * `llamaServerMissingMessage` is the first half of the question — it already says whether a *setting* is
 * wrong or whether nothing was found at all — and this adds the thing that makes it actionable.
 */
export async function offerLlamaInstall(context: vscode.ExtensionContext): Promise<string | undefined> {
    const pick = await vscode.window.showWarningMessage(
        'No `llama-server` was found on this machine. This extension can download llama.cpp\'s own prebuilt '
        + 'server for this platform (about 18 MB) into its storage, or you can point it at a build you made.',
        'Download llama.cpp',
        'Point at my own build…',
        'Cancel'
    );
    if (pick === 'Point at my own build…') return undefined;
    if (pick !== 'Download llama.cpp') return undefined;
    try {
        let result: InstallResult | undefined;
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Installing llama.cpp', cancellable: true },
            async (progress) => {
                result = await installLlamaServer(context, { onProgress: (message) => progress.report({ message }) });
            }
        );
        if (!result) return undefined;
        log(`llama.cpp install: ${result.bin} (${result.tag})`);
        return result.bin;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`llama.cpp install failed: ${message}`);
        void vscode.window.showErrorMessage(`llama.cpp could not be installed. ${message}`);
        return undefined;
    }
}

/** Where a finished install says it is, for the message after it succeeds. */
export function describeInstall(result: InstallResult): string {
    return `${result.tag} (${result.asset.name}, ${formatBytes(result.asset.bytes)})`
        + `${result.version ? ` — version ${result.version}` : ''}`;
}
