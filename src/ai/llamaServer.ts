/* The user's **own** `llama-server` — found, started, stopped and reported from here.
 *
 * WHY THIS EXISTS (asked 2026-09-16). *"Models served by the Llama.cpp server respond faster and better
 * than the LM Studio models."* The AI assist has always been able to talk to a `llama-server` the user
 * started themselves — it is an OpenAI-compatible address like any other — but it could not **start** one,
 * which left the developer to write the command line (a model path, a port, a context size, a thread count,
 * an offload count) before the feature was any use. This module is that command line, written for them.
 *
 * HOW IT RELATES TO THE OTHER TWO RUNTIMES. There are three now, and the difference is *who owns the
 * process*:
 *
 *   - **bundled** (`runtime.ts`) — OUR sidecar (`sidecar/`, llama.cpp via `llama-cpp-2`) holding OUR weights,
 *     downloaded into the extension's storage. The extension is the only thing that knows about it.
 *   - **lmstudio** (`localModelCore.ts`) — a *remote control* for LM Studio's own engine (`lms load`).
 *   - **this one** — the user's `llama-server` binary and the user's `.gguf`, started as a child of this
 *     window (or as the user's own systemd unit, see `llamaService.ts`).
 *
 * WHAT IT WILL FETCH FOR YOU (asked 2026-10-04). *"When i select My own llama-server, the extension must
 * start the llama.cpp server and load the weights automatically. If the server or the 27B model is not on the
 * host machine the extention must offer to download and install."* Before that, this module said the honest
 * but useless thing — "no `llama-server` was found, go and build llama.cpp" — and the model always had to be
 * found by hand. Now:
 *
 *   - the **binary**: PATH and the usual build folders (`llamaServerBinary`), then an offer to download
 *     llama.cpp's own prebuilt server for this platform (`llamaInstall.ts`), then the file dialog;
 *   - the **weights**: the `modelPath` setting, else a verified copy of the known 27B already on this
 *     machine (`OWN_SERVER_SPECS`), else one question whose first entry is that 27B — downloaded and
 *     checksum-verified if it is not here, adopted from wherever else it already is if it is.
 *
 * The rule is *only ask what we do not already know*: on the second run and every one after it the command
 * starts the server with nothing to answer, which is what "automatically" means to a developer.
 *
 * EVERY DECISION THAT CAN BE TESTED WITHOUT A PROCESS LIVES IN `localModels.ts` — where the binary is,
 * the exact argv, which failure is worth retrying, what `/health` means, which release asset fits this
 * machine, and which model needs no question. What is here is the process.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { normalizeAssistantConfig, probeServer } from './assistant';
import { lastPickerFolder, rememberPickerFile } from './pickers';
import { freePort, isMissingExecutable } from './sys';
import { log, logError } from './log';
import {
    classifyHealth,
    findLlamaServer,
    isLlamaServerModels,
    isUnknownArgumentFailure,
    llamaServerAlias,
    llamaServerArgs,
    llamaServerPortCandidates,
    ownServerModelPreference,
    parseLlamaProps,
    recommendedLlamaOptions,
    sidecarContextSize,
    sidecarGpuLayers
} from './localModels';
import { OWN_SERVER_SPECS, formatBytes, ownServerSpecByFileName, type ModelSpec } from './modelSpecs';
import { scanForModelFiles, setupFacts, type FoundModelFile } from './localModelCore';
import { allModelSpecs, ensureModelFile, extensionContext, modelFileFor, modelFolder } from './runtime';
import { describeInstall, installLlamaServer, llamaServerVersion } from './llamaInstall';
import { configView } from './settings';
// `proveItWorks` is the shared "is it really answering?" round trip every load path uses. This module is
// the only one that imports it *downwards* (the palette flows live there, the process lives here), so the
// dependency has one direction: llamaServer → localModelSetup → assistantUi.
import { proveItWorks } from './localModelSetup';

const SETTINGS = 'rustyPlatform.assistant';

/** How long a cold start may take before we give up. A 7 GB model on a busy disk can take minutes. */
const LOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** How long to wait before deciding "it died on startup" rather than "it is loading". */
const EARLY_EXIT_MS = 900;

/** What a running server of ours knows about itself. */
export interface OwnServerInfo {
    endpoint: string;
    port: number;
    pid?: number;
    /** The `.gguf` it was started with. */
    modelPath: string;
    /** The model id the server reported (the alias we asked for, or the file path). */
    modelId: string;
    /** The flags it was started with, so "Load" can tell "already running like this" from "restart with these". */
    settings: OwnServerSettings;
    /** The exact command line, so the user can reproduce or tune it by hand. */
    args: string[];
    startedAt: number;
}

/** The knobs the panel and the palette command choose; a change to any of them needs a restart. */
export interface OwnServerSettings {
    threads: number;
    contextSize: number;
    gpuLayers: number;
    extraArgs: string;
}

/** The last lines the process said — quoted in a failure, and logged as it goes. */
const tail: string[] = [];

function remember(chunk: Buffer): void {
    for (const raw of chunk.toString().split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        tail.push(line);
        if (tail.length > 40) tail.shift();
    }
}

/** The server's own last words, oldest first — empty when it has said nothing. */
export function llamaServerTail(): string[] {
    return tail.slice();
}

/**
 * One server per window, like the sidecar: a `llama-server` holds gigabytes of weights, and starting a
 * second one with the same file would halve the machine's free RAM for the same answer.
 */
class OwnLlamaServer {
    private proc?: cp.ChildProcess;
    private info?: OwnServerInfo;
    /** Serialised so two clicks ("Load" in the panel and the palette command) cannot start two servers. */
    private starting?: Promise<OwnServerInfo>;

    current(): OwnServerInfo | undefined {
        if (!this.proc || !this.info || this.proc.exitCode !== null) return undefined;
        return this.info;
    }

    async ensureStarted(
        bin: string,
        launch: { modelPath: string } & OwnServerSettings,
        onProgress?: (message: string) => void
    ): Promise<OwnServerInfo> {
        const running = this.current();
        // Same file **and** the same settings and still alive: reuse it. Anything else means the caller is
        // asking for something different — a restart, not a second server (a second one would hold the same
        // weights twice). "Load Model" has to honour the numbers above it, or the panel would quietly ignore
        // a context length the user just changed.
        if (running && running.modelPath === launch.modelPath && sameSettings(running.settings, launch)) return running;
        if (running) {
            log('llama-server: restarting it — the model or one of the settings changed');
            this.stop();
        }
        if (this.starting) return this.starting;
        this.starting = this.start(bin, launch, onProgress).finally(() => { this.starting = undefined; });
        return this.starting;
    }

    private async start(
        bin: string,
        launch: { modelPath: string } & OwnServerSettings,
        onProgress?: (message: string) => void
    ): Promise<OwnServerInfo> {
        const saying = onProgress ?? (() => undefined);
        if (!fs.existsSync(launch.modelPath)) throw new Error(`The model file is not there: ${launch.modelPath}`);
        const port = await freePort();
        const alias = llamaServerAlias(launch.modelPath);
        const base = {
            modelPath: launch.modelPath,
            port,
            threads: launch.threads,
            contextSize: launch.contextSize,
            gpuLayers: launch.gpuLayers,
            extraArgs: launch.extraArgs
        };

        saying('starting llama-server…');
        // Relative paths in the user's own extra flags resolve against the model's folder: if they write
        // `--lora adapter.gguf`, the file they mean is the one next to the model, not next to VS Code.
        const cwd = path.dirname(launch.modelPath);
        let started = await this.spawnOnce(bin, llamaServerArgs({ ...base, alias }), cwd);
        // An unknown flag makes llama.cpp exit *before* reading any weights, so a refusal of one of ours is
        // recoverable: start again without the cosmetic ones (`--alias` is the only one we add for looks).
        if (started.exitedEarly && isUnknownArgumentFailure(started.output)) {
            log(`llama-server refused a flag we passed (${started.output.split('\n').slice(-2).join(' ').trim()}) — `
                + 'starting again without --alias.');
            saying('this llama-server does not accept --alias — starting again without it…');
            started = await this.spawnOnce(bin, llamaServerArgs(base), cwd);
        }
        if (started.exitedEarly) {
            const why = started.output.split('\n').map((l) => l.trim()).filter(Boolean).slice(-4).join(' · ');
            throw new Error(
                `llama-server stopped immediately${started.code === null ? '' : ` (exit ${started.code})`}`
                + `${why ? `: ${why}` : ''}. The command line was: llama-server ${started.args.join(' ')}`
            );
        }

        const endpoint = `http://127.0.0.1:${port}/v1`;
        const modelId = await this.waitUntilReady(port, started.args, saying);
        const info: OwnServerInfo = {
            endpoint,
            port,
            pid: this.proc?.pid,
            modelPath: launch.modelPath,
            modelId,
            settings: {
                threads: launch.threads,
                contextSize: launch.contextSize,
                gpuLayers: launch.gpuLayers,
                extraArgs: launch.extraArgs
            },
            args: started.args,
            startedAt: Date.now()
        };
        this.info = info;
        log(`llama-server: ready on ${endpoint} as "${modelId}" — llama-server ${started.args.join(' ')}`);
        return info;
    }

    /** Spawn once and report whether it died before it could have been loading anything. */
    private async spawnOnce(bin: string, args: string[], cwd: string): Promise<{ exitedEarly: boolean; code: number | null; output: string; args: string[] }> {
        let output = '';
        const child = cp.spawn(bin, args, { cwd });
        this.proc = child;
        child.stdout?.on('data', (d: Buffer) => {
            output += d.toString();
            remember(d);
            log(`llama-server: ${d.toString().trim()}`);
        });
        child.stderr?.on('data', (d: Buffer) => {
            output += d.toString();
            remember(d);
            logError(`llama-server: ${d.toString().trim()}`);
        });
        child.on('exit', (code) => {
            if (this.info?.pid === child.pid) this.info = undefined;
            log(`llama-server: exited (${code ?? 'signal'})`);
        });

        const early = await new Promise<{ exitedEarly: boolean; code: number | null }>((resolve) => {
            const timer = setTimeout(() => resolve({ exitedEarly: false, code: null }), EARLY_EXIT_MS);
            child.once('error', (e) => {
                clearTimeout(timer);
                output += e.message;
                resolve({ exitedEarly: true, code: null });
            });
            child.once('exit', (code) => {
                clearTimeout(timer);
                resolve({ exitedEarly: true, code });
            });
        });
        return { ...early, output, args };
    }

    /**
     * Wait until the weights are in RAM, then ask which model the server answers to.
     *
     * `/health` is the signal (see `classifyHealth`): llama.cpp answers 503 while loading and 200 when it is
     * ready, while `/v1/models` answers immediately with a `null` meta block — so a server read as "ready"
     * from its model list would fail the very first request. A build old enough to have no `/health` falls
     * back to the model list, and `proveItWorks()` after this is what proves the fallback was sane.
     */
    private async waitUntilReady(port: number, args: string[], onProgress: (message: string) => void): Promise<string> {
        const deadline = Date.now() + LOAD_TIMEOUT_MS;
        let healthAbsent = false;
        let lastLine = '';
        for (; ;) {
            const child = this.proc;
            if (!child || child.exitCode !== null) {
                throw new Error(`llama-server stopped while loading${lastLine ? `: ${lastLine}` : ''}`
                    + `. See View → Output → "Grumpy's WYSIWYG Designer" for its own messages.`);
            }
            const verdict = await this.health(port);
            if (verdict === 'ok') break;
            if (verdict === 'absent') healthAbsent = true;
            if (healthAbsent) {
                // On a build with no `/health`, llama.cpp's model list is all there is — and it answers
                // *before* the weights are in, with a `null` meta block (its own documented behaviour).
                // Requiring meta is what keeps "ready" meaning ready on those builds.
                const id = await loadedModelId(port);
                if (id) {
                    log('llama-server: this build has no /health — using the model list (with its meta block) instead.');
                    return id;
                }
            }
            const said = tail[tail.length - 1];
            if (said && said !== lastLine) {
                lastLine = said;
                onProgress(said.slice(0, 120));
            } else if (verdict === 'loading') {
                onProgress('loading the weights into RAM…');
            }
            if (Date.now() > deadline) {
                throw new Error(
                    `llama-server did not finish loading in 5 minutes. It is still running on port ${port} — `
                    + `the command line was: llama-server ${args.join(' ')}`
                );
            }
            await delay(500);
        }
        const id = await this.modelId(port);
        if (!id) throw new Error('llama-server is up but reports no model — see the "Grumpy\'s WYSIWYG Designer" output.');
        return id;
    }

    private async health(port: number): Promise<ReturnType<typeof classifyHealth>> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        try {
            const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
            return classifyHealth(res.status);
        } catch {
            return classifyHealth(0);
        } finally {
            clearTimeout(timer);
        }
    }

    private async modelId(port: number): Promise<string | undefined> {
        const probe = await probeServer(
            normalizeAssistantConfig({ backend: 'external', endpoint: `http://127.0.0.1:${port}/v1`, model: '' }),
            { timeoutMs: 1500 }
        ).catch(() => undefined);
        return probe?.ok && probe.models.length ? probe.models[0]!.id : undefined;
    }
    stop(): void {
        const proc = this.proc;
        const wasRunning = !!this.info;
        this.proc = undefined;
        this.info = undefined;
        if (proc && proc.exitCode === null && !proc.killed) {
            try { proc.kill(); } catch { /* already gone */ }
        }
        if (wasRunning) log('llama-server: stopped');
    }

    dispose(): void {
        this.stop();
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

let own: OwnLlamaServer | undefined;

/** Called once from `activate`, so every entry point shares one child process per window. */
export function initLlamaServer(context: vscode.ExtensionContext): void {
    own = new OwnLlamaServer();
    context.subscriptions.push(own);
}

/**
 * The commands the palette and the "Choose a Local Model…" picker use.
 *
 * WHY THIS EXISTS AS A FUNCTION THAT MUST BE CALLED. Both commands were reachable from inside the extension
 * — the model picker executes `rustyPlatform.assistant.startLlamaServer` for its "My own llama-server" entry
 * — but the command was never **registered**, and the two settings it writes were never declared in
 * `package.json`. Selecting that entry therefore failed with "command not found" (the picker's own note even
 * said the command "is registered by then", which was an assumption, not a fact). Registration and the
 * contribution are pinned together by `tests/layers/t1-logic/ai-wiring.test.js`, which reads `package.json`
 * and this file and fails on the next command that is promised and not delivered.
 */
export function registerLlamaServerCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('rustyPlatform.assistant.startLlamaServer', () => startMyLlamaServerFlow(context)),
        vscode.commands.registerCommand('rustyPlatform.assistant.stopLlamaServer', () => {
            const status = ownLlamaServerStatus();
            if (!status.running || !status.info) {
                // "Mine" means this window's process. A server started outside it — this machine's own is a
                // systemd user unit — is deliberately not killed from here, and `unloadEverything` (the
                // panel's Unload) is where the user is told what is still holding the memory.
                void vscode.window.showInformationMessage(
                    'This window is not running a llama-server of its own. One started outside it (a systemd service, '
                    + 'for instance) is not this command\'s to stop.'
                );
                return;
            }
            stopOwnLlamaServer();
            void vscode.window.showInformationMessage(
                `Stopped your llama-server on port ${status.info.port} (${path.basename(status.info.modelPath)}).`
            );
        })
    ];
}

/** The running server of ours, if any. */
export function ownLlamaServerStatus(): { running: boolean; info?: OwnServerInfo } {
    const info = own?.current();
    return info ? { running: true, info } : { running: false };
}

export interface LlamaBinaryLookup {
    /** The binary to run. */
    path?: string;
    /** The `llamaServerPath` setting, when it is the thing that failed. */
    configured?: string;
    /** True when a path was set but does not exist — the one failure the user can fix in a second. */
    configuredMissing?: boolean;
}

/** Where the user's `llama-server` is, using the setting first and PATH second. Pure logic, thin lookup. */
export function llamaServerBinary(configuredOverride?: string): LlamaBinaryLookup {
    const configured = configuredOverride ?? configView(SETTINGS).get<string>('llamaServerPath', '');
    const wanted = String(configured ?? '').trim();
    const found = findLlamaServer({
        homeDir: os.homedir(),
        pathValue: process.env.PATH ?? '',
        preferred: wanted,
        exists: (p) => { try { return fs.existsSync(p); } catch { return false; } }
    });
    if (found) return { path: found };
    return wanted ? { configured: wanted, configuredMissing: true } : {};
}

/**
 * The status-dialog lines for this runtime.
 *
 * Shown whenever it is relevant: a server of ours is running, one the developer started themselves is
 * answering, a binary was found, or a path was set (which may be the thing that is wrong). On a machine
 * with none of those, saying nothing is the honest answer — a "not installed" line for a feature the user
 * never asked about is noise.
 *
 * `elsewhere` is the (async, cached) answer to "is one already running?", passed in so this stays a
 * function of what it is told: the difference between the two running cases is the one that matters —
 * *whose* process it is, and therefore which button frees the memory.
 */
export function llamaServerStatusLines(
    lookup: LlamaBinaryLookup = llamaServerBinary(),
    elsewhere?: RunningLlamaServer,
    ownerLine?: string
): string[] {
    const running = ownLlamaServerStatus();
    const lines: string[] = [];
    if (running.running && running.info) {
        lines.push(`Your llama-server: running on port ${running.info.port} — ${path.basename(running.info.modelPath)}`
            + ` (pid ${running.info.pid ?? '?'}, model "${running.info.modelId}")`);
        lines.push(`Command: llama-server ${running.info.args.join(' ')}`);
        return lines;
    }
    if (elsewhere) {
        const name = elsewhere.modelPath ? path.basename(elsewhere.modelPath) : elsewhere.modelId;
        lines.push(`Your llama-server: already running on port ${elsewhere.port} — ${name}`
            + `${elsewhere.buildInfo ? ` (build ${elsewhere.buildInfo})` : ''}`);
        // With an owner line the vague sentence is replaced by the answer itself (2026-09-17): the cgroup
        // says which unit holds it, so "who started it?" no longer needs a shrug. Without one — the two-arg
        // call this function has always had — the old sentence stands, because guessing would be worse.
        lines.push(ownerLine
            ? `Started outside this window: ${ownerLine}. Start / Stop in Code Fix/AI-Assist Settings (⚙) → `
            + 'My llama-server control it.'
            : 'Started outside this window — "Stop" and "Unload" leave it alone on purpose.');
        return lines;
    }
    if (lookup.configuredMissing) {
        lines.push(`Your llama-server: the path in the settings (${lookup.configured}) does not exist.`);
    } else if (lookup.path) {
        lines.push(`Your llama-server: ${lookup.path.replace(os.homedir(), '~')} — not running`);
    }
    return lines;
}

/**
 * A one-line reason the feature cannot be used, with the way out.
 *
 * Two different failures, two different answers: a path the user set that is not there is *their* setting
 * and is fixable in a second, while "nothing found" means llama.cpp is not installed — and since
 * 2026-10-04 that is no longer a dead end, because the flow that shows this line also offers to download
 * llama.cpp's own prebuilt server. The sentence still names the manual route, for a machine where the
 * download cannot happen (no network, an unsupported platform).
 */
export function llamaServerMissingMessage(lookup: LlamaBinaryLookup): string {
    if (lookup.configuredMissing) {
        return `The "llamaServerPath" setting points at ${lookup.configured}, which is not there. Fix or clear `
            + 'that setting (Settings → Grumpy\'s WYSIWYG Designer → Assistant) and try again.';
    }
    return 'No `llama-server` was found on this machine (checked PATH and the usual build folders). This '
        + 'extension can download llama.cpp\'s own prebuilt server for you, or you can point "llamaServerPath" '
        + 'at a build you made yourself.';
}

export interface LlamaStartOutcome {
    ok: boolean;
    endpoint?: string;
    modelId?: string;
    message?: string;
    /** True when an already-running server was used instead of starting one. */
    reused?: boolean;
}

export interface LlamaStartRequest {
    /** The `.gguf` to serve. */
    modelPath: string;
    /** Context length in tokens (0 = the recommendation for this machine). */
    contextLength?: number;
    /** The panel's GPU field: `auto` | `off` | `max` | `0.5`. */
    gpu?: string;
    /** The `threads` setting; 0 = choose from this machine's core count. */
    threads?: number;
    /** Extra flags; when omitted the `llamaServerArgs` setting is used. */
    extraArgs?: string;
    /**
     * Use a `llama-server` that is already running **the same file** instead of starting a second copy of
     * it. On by default, because the alternative is two sets of weights in RAM for one answer; the palette
     * flow turns it off only after the user was asked and chose "start another one".
     */
    reuseRunning?: boolean;
    onProgress?: (message: string) => void;
}

/**
 * Starts (or reuses) the user's `llama-server` and pins the settings at it.
 *
 * The pin is written here and not by each caller, for the same reason `wireSettings` exists: the panel and
 * the palette command must not be able to end up pointing at different addresses. `backend` stays
 * `external` on purpose — this *is* an external OpenAI-compatible server; what is ours is the process.
 */
export async function startOwnLlamaServer(request: LlamaStartRequest): Promise<LlamaStartOutcome> {
    if (!own) return { ok: false, message: 'The llama-server manager is not initialised — reload the window.' };
    const cfg = configView(SETTINGS);
    // The binary: the setting, PATH and the usual build folders — and, when this machine has none, the offer
    // to download llama.cpp's own prebuilt server. Every caller of this function is a click the user just
    // made (the panel's Load, the panel's Start server, the palette command), so a question is allowed here;
    // without it, the panel's own-server entry could only ever say "no llama-server was found".
    const lookup = llamaServerBinary();
    const context = extensionContext();
    const bin = lookup.path ?? (context ? await ensureLlamaServerBinary(context, cfg) : undefined);
    if (!bin) return { ok: false, message: llamaServerMissingMessage(lookup) };

    // The model: what the caller named, else the same automatic resolution the palette flow uses (the
    // `modelPath` setting, a verified copy of the known 27B, then one picker whose first entry is that 27B).
    let modelPath = String(request.modelPath ?? '').trim();
    if (!modelPath && context) {
        const preference = ownServerModelPreference({
            pinned: cfg.get<string>('modelPath', ''),
            known: knownOwnServerModelPath(context),
            exists: (p) => { try { return fs.existsSync(p); } catch { return false; } }
        });
        modelPath = preference.path ?? (await chooseLlamaServerModel(context, cfg)) ?? '';
    }
    if (!modelPath) {
        return {
            ok: false,
            message: 'No model file is chosen for your llama-server yet. Run "AI: Start My llama-server…" '
                + 'once to pick one (or pick a .gguf found on disk in this list).'
        };
    }
    if (!fs.existsSync(modelPath)) return { ok: false, message: `The model file is not there: ${modelPath}` };

    // One already running with *this* file: reuse it. Starting a second copy would double the RAM for an
    // identical answer, and the developer's own server is usually a service they started on purpose.
    const runningElsewhere = ownLlamaServerStatus().running
        ? undefined
        : await findRunningLlamaServer(cfg.get<string>('endpoint', ''));
    if (runningElsewhere && (request.reuseRunning ?? true) && sameFile(runningElsewhere.modelPath, modelPath)) {
        return await useRunningLlamaServer(runningElsewhere);
    }

    const facts = setupFacts();
    const sizeGb = sizeOfGb(modelPath);
    const recommended = recommendedLlamaOptions(sizeGb, facts);
    const threads = request.threads && request.threads > 0 ? request.threads : recommended.threads;
    const launch = {
        modelPath,
        threads,
        contextSize: sidecarContextSize(request.contextLength ?? 0, recommended.contextSize),
        gpuLayers: sidecarGpuLayers(request.gpu ?? 'auto') || recommended.gpuLayers,
        extraArgs: request.extraArgs ?? cfg.get<string>('llamaServerArgs', '')
    };
    try {
        const info = await own.ensureStarted(bin, launch, request.onProgress);
        // The version is logged, never used to decide anything: a build too old for a flag says so itself,
        // and the retry above is what acts on it.
        void llamaServerVersion(bin).then((v) => { if (v) log(`llama-server version ${v}`); });
        await cfg.update('modelPath', modelPath);
        await cfg.update('backend', 'external');
        await cfg.update('endpoint', info.endpoint);
        await cfg.update('model', info.modelId);
        await vscode.commands.executeCommand('setContext', 'rustyPlatform.aiEnabled', true);
        forgetRunningProbe();
        // Say it out loud when this makes a *second* server: two sets of weights in RAM is the user's
        // memory, and the sentence is the only place they would hear about it.
        const twin = runningElsewhere
            ? ` Note: your llama-server on port ${runningElsewhere.port} is still running its own model, so both are in memory now.`
            : '';
        return {
            ok: true,
            endpoint: info.endpoint,
            modelId: info.modelId,
            message: `${path.basename(modelPath)} is answering from your own llama-server on ${info.endpoint}.${twin}`
        };
    } catch (err) {
        // The binary exists (it was found) but could not be executed: a wrong architecture, or a file whose
        // execute bit is missing. Saying "not found" here would send the user looking for the wrong thing.
        if (isMissingExecutable(err)) {
            return { ok: false, message: `llama-server could not be started: ${bin} (is it executable?)` };
        }
        const message = err instanceof Error ? err.message : String(err);
        logError(`llama-server failed to start: ${message}`);
        return { ok: false, message };
    }
}

/** Same file, however the two paths were spelled (`./a.gguf` vs `/home/x/a.gguf`). */
function sameFile(a: string | undefined, b: string): boolean {
    if (!a || !b) return false;
    try {
        return path.resolve(a) === path.resolve(b);
    } catch {
        return a === b;
    }
}

/** Are these two sets of flags the same decision? Used to decide reuse vs restart. */
function sameSettings(a: OwnServerSettings, b: OwnServerSettings): boolean {
    return a.threads === b.threads && a.contextSize === b.contextSize
        && a.gpuLayers === b.gpuLayers && a.extraArgs === b.extraArgs;
}

function sizeOfGb(file: string): number {
    try {
        return fs.statSync(file).size / (1024 * 1024 * 1024);
    } catch {
        return 2;
    }
}

// ---------------- a llama-server that was already running ----------------

/** A `llama-server` this window did NOT start — the developer's own, usually a systemd service. */
export interface RunningLlamaServer {
    endpoint: string;
    port: number;
    modelId: string;
    /** From `/props`, so the "already running" message can name the file it serves. */
    modelPath?: string;
    buildInfo?: string;
}

/**
 * Is one already answering?
 *
 * This machine's own setup is exactly why this exists: the developer's `llama-server` is a **systemd user
 * service** on port 8080 holding a 30 B Qwen3-Coder (`--alias my-local-model`). Without this check,
 * "Start My llama-server" would load a *second* copy of the same weights into 28 GB of RAM to answer the
 * same questions — the one failure a user would notice immediately and never forgive.
 *
 * Both of llama.cpp's identifiers are required or accepted in order of how sure they make us: `/props`
 * (`model_path` + `build_info`, llama.cpp's own endpoint) or `/v1/models` with `owned_by: "llamacpp"`.
 * A plain OpenAI-compatible server on port 8080 (Ollama, vLLM) matches neither and is left alone.
 */
export async function findRunningLlamaServer(endpoint: string, opts: { cacheMs?: number } = {}): Promise<RunningLlamaServer | undefined> {
    const cacheMs = opts.cacheMs ?? 15000;
    if (cacheMs > 0 && runningProbe.value && Date.now() - runningProbe.at < cacheMs) return runningProbe.value;
    const found = await probeRunning(endpoint);
    runningProbe = { at: Date.now(), value: found };
    return found;
}

let runningProbe: { at: number; value?: RunningLlamaServer } = { at: 0 };

async function probeRunning(endpoint: string): Promise<RunningLlamaServer | undefined> {
    const ports = llamaServerPortCandidates(endpoint);
    // Asked in parallel: three ports, and the state refresh this feeds should not be as slow as the sum of
    // them. A port that is not listening refuses instantly; the timeout only matters for a *hung* one, which
    // is why it is short and why a miss is cached below.
    const answers = await Promise.all(ports.map((port) => askPort(port)));
    for (const running of answers) {
        if (!running) continue;
        log(`llama-server: found one already running on ${running.endpoint}`
            + `${running.modelId ? ` (model "${running.modelId}")` : ''}${running.buildInfo ? ` — build ${running.buildInfo}` : ''}`);
        return running;
    }
    return undefined;
}

/** What one port says about itself, or nothing. Never throws. */
async function askPort(port: number): Promise<RunningLlamaServer | undefined> {
    const base = `http://127.0.0.1:${port}`;
    const [props, models] = await Promise.all([getJson(`${base}/props`), getJson(`${base}/v1/models`)]);
    const parsed = props ? parseLlamaProps(props) : undefined;
    // Both of llama.cpp's own identifiers count, `/props` first because it also names the model file:
    // `owner_by: "llamacpp"` in `/v1/models`, and `model_path` + `build_info` in `/props`. A plain
    // OpenAI-compatible server (LM Studio, Ollama, vLLM) matches neither and is left completely alone.
    if (!parsed?.modelPath && !isLlamaServerModels(models)) return undefined;
    const id = (models as { data?: { id?: unknown }[] } | undefined)?.data?.[0]?.id;
    return {
        endpoint: `${base}/v1`,
        port,
        modelId: typeof id === 'string' ? id : path.basename(parsed?.modelPath ?? 'llama-server'),
        modelPath: parsed?.modelPath,
        buildInfo: parsed?.buildInfo
    };
}

/** A GET that answers JSON or nothing — bounded, and never throws at a caller. */
async function getJson(url: string, timeoutMs = 900): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return undefined;
        return await res.json();
    } catch {
        return undefined;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The id a llama-server reports **together with its meta block** — which it only fills in once the weights
 * are loaded (`meta` is `null` while loading, by llama.cpp's own documentation). Used on builds with no
 * `/health`, where this is the closest thing to a readiness signal the server offers.
 */
async function loadedModelId(port: number): Promise<string | undefined> {
    const answer = await getJson(`http://127.0.0.1:${port}/v1/models`);
    const first = (answer as { data?: { id?: unknown; meta?: unknown }[] } | undefined)?.data?.[0];
    return typeof first?.id === 'string' && first.id && first.meta ? first.id : undefined;
}

/**
 * Pins the settings at a server that is already running — the same three settings a start writes, without a
 * process. Used when the developer says "use the one I already have", and when Load asks for a file that a
 * running server is already serving.
 */
export async function useRunningLlamaServer(running: RunningLlamaServer): Promise<LlamaStartOutcome> {
    const cfg = configView(SETTINGS);
    await cfg.update('backend', 'external');
    await cfg.update('endpoint', running.endpoint);
    await cfg.update('model', running.modelId);
    await vscode.commands.executeCommand('setContext', 'rustyPlatform.aiEnabled', true);
    const name = running.modelPath ? path.basename(running.modelPath) : running.modelId;
    log(`llama-server: using the one already running on ${running.endpoint} (${running.modelId})`);
    return {
        ok: true,
        endpoint: running.endpoint,
        modelId: running.modelId,
        message: `Using the llama-server already running on port ${running.port}${name ? ` — it serves ${name}` : ''}. `
            + 'This window did not start it, so "Stop" leaves it alone (stop the service yourself to free the memory).',
        reused: true
    };
}

/** Forgets the cached "is one running?" answer — called after we start or stop something ourselves. */
export function forgetRunningProbe(): void {
    runningProbe = { at: 0 };
}

/** "Stop My llama-server" — ours to stop, because ours is the process we started. */
export function stopOwnLlamaServer(): boolean {
    const was = ownLlamaServerStatus().running;
    own?.stop();
    return was;
}

// ---------------- the palette front door ----------------

/**
 * Finds the binary, offering to fetch llama.cpp when this machine has none.
 *
 * A path the user set is used without a word. Nothing found means one question with three ways out: install
 * the prebuilt server (the default, and the whole point of the offer), point at a build of their own, or
 * stop. Returns the binary to run, or undefined when the user backed out.
 *
 * The file dialog is the *old* way out, kept because a developer who already compiled llama.cpp — this one
 * has, at `~/llama.cpp/build/bin/llama-server` — should never be made to download a second copy of it.
 */
export async function ensureLlamaServerBinary(
    context: vscode.ExtensionContext,
    cfg: vscode.WorkspaceConfiguration = configView(SETTINGS)
): Promise<string | undefined> {
    const lookup = llamaServerBinary(cfg.get<string>('llamaServerPath', ''));
    if (lookup.path) return lookup.path;

    const pick = await vscode.window.showWarningMessage(
        llamaServerMissingMessage(lookup), 'Download llama.cpp', 'Point at my own build…', 'Cancel'
    );
    if (pick === 'Download llama.cpp') {
        try {
            let installed: Awaited<ReturnType<typeof installLlamaServer>> | undefined;
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Installing llama.cpp', cancellable: true },
                async (progress) => {
                    installed = await installLlamaServer(context, {
                        onProgress: (message) => progress.report({ message })
                    });
                }
            );
            if (!installed) return undefined;
            await cfg.update('llamaServerPath', installed.bin);
            void vscode.window.showInformationMessage(
                `llama.cpp ${describeInstall(installed)} is installed and will be used from now on.`
            );
            return installed.bin;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logError(`llama.cpp install failed: ${message}`);
            const again = await vscode.window.showErrorMessage(`llama.cpp could not be installed. ${message}`, 'Point at my own build…');
            if (again !== 'Point at my own build…') return undefined;
        }
    } else if (pick !== 'Point at my own build…') {
        return undefined;
    }

    const startFolder = lastPickerFolder('binary');
    const chosen = await vscode.window.showOpenDialog({
        title: 'Where is llama-server?',
        canSelectMany: false,
        openLabel: 'Use this binary',
        defaultUri: startFolder ? vscode.Uri.file(startFolder) : undefined,
        filters: process.platform === 'win32' ? { Program: ['exe'] } : {}
    });
    const file = chosen?.[0]?.fsPath;
    if (!file) return undefined;
    await rememberPickerFile('binary', file);
    await cfg.update('llamaServerPath', file);
    return file;
}

/**
 * A copy of the known 27B that this extension has already downloaded and verified.
 *
 * Deliberately narrow: the extension's own storage, matching the published byte count to the byte. That is
 * the file `ensureModelFile` fetched and hashed, so starting it without asking is not a guess. Weights found
 * *elsewhere* (LM Studio's folder, `~/Downloads`, a mounted drive) are offered by the picker instead — they
 * are the same model by name and size, and the hash that would prove it costs half a minute of reading on a
 * 16.8 GB file, which is too long to spend before a menu appears.
 */
export function knownOwnServerModelPath(context: vscode.ExtensionContext): string | undefined {
    for (const spec of OWN_SERVER_SPECS) {
        const file = modelFileFor(context, spec);
        try {
            if (fs.statSync(file).size === spec.bytes) return file;
        } catch {
            /* not downloaded here — the picker will offer the copy found anywhere else, or the download */
        }
    }
    return undefined;
}

/**
 * "AI: Start My llama-server…" — resolve the binary and the model, start it, prove it answers.
 *
 * The questions are asked in the order the answers become useful, and **only when they are not already
 * known**: the binary (with the install offer), whether to reuse a server that is already running, the model
 * — and the flags only when the model was just chosen by hand. On a machine that has been through this once,
 * that is zero questions: the command starts the server and loads the weights, which is what was asked for
 * (*"the extension must start the llama.cpp server and load the weights automatically"*).
 */
export async function startMyLlamaServerFlow(context: vscode.ExtensionContext): Promise<boolean> {
    const cfg = configView(SETTINGS);
    const bin = await ensureLlamaServerBinary(context, cfg);
    if (!bin) return false;
    const version = await llamaServerVersion(bin);
    log(`llama-server: using ${bin}${version ? ` (version ${version})` : ''}`);

    // Is one already answering? On this machine the answer is usually yes — the developer's own llama-server
    // runs as a systemd user service on port 8080 with a 30 B model — and starting a second copy of *any*
    // weights is the one thing this feature could do that costs 8-17 GB for nothing. The choice is theirs;
    // the default is the one that does not touch their RAM.
    const existing = await withNotification('Looking for a llama-server that is already running…', () =>
        findRunningLlamaServer(cfg.get<string>('endpoint', '')));
    let startAnother = false;
    if (existing) {
        const name = existing.modelPath ? path.basename(existing.modelPath) : existing.modelId;
        const pick = await vscode.window.showQuickPick(
            [
                {
                    label: `$(check) Use the one already running on port ${existing.port}`,
                    detail: `Serves ${name}${existing.buildInfo ? ` (build ${existing.buildInfo})` : ''} — nothing new goes into memory. `
                        + 'This window did not start it, so "AI: Stop My llama-server" cannot stop it (stop the service yourself).',
                    reuse: true
                },
                {
                    label: '$(add) Start another one with a different model',
                    detail: 'Both are then in memory at the same time — a big model costs its own size in RAM again',
                    reuse: false
                }
            ],
            { title: 'A llama-server is already running', ignoreFocusOut: true }
        );
        if (!pick) return false;
        if (pick.reuse) return finishLlamaStart(await useRunningLlamaServer(existing));
        startAnother = true;
    }

    // The model. Automatic when this machine already answers the question: the `modelPath` setting first (the
    // user's own last choice), then a verified copy of the known 27B. Otherwise one picker whose first entry
    // is that 27B — downloaded if it is not here, adopted if it is.
    const known = knownOwnServerModelPath(context);
    const preference = ownServerModelPreference({
        pinned: cfg.get<string>('modelPath', ''),
        known,
        exists: (p) => { try { return fs.existsSync(p); } catch { return false; } }
    });
    let modelPath = preference.path;
    let askedForModel = false;
    if (!modelPath) {
        modelPath = await chooseLlamaServerModel(context, cfg);
        askedForModel = true;
    }
    if (!modelPath) return false;

    const facts = setupFacts();
    const sizeGb = sizeOfGb(modelPath);
    const recommended = recommendedLlamaOptions(sizeGb, facts);
    // The flags are a question only when the model itself was just chosen: after a start that used a model the
    // settings already named, the panel's ⚙ is where those numbers are changed, and asking again would make
    // "start it automatically" mean "answer three questions".
    const settings = askedForModel
        ? await askLlamaFlags(modelPath, sizeGb, recommended, cfg)
        : { contextSize: recommended.contextSize, threads: recommended.threads, gpuLayers: recommended.gpuLayers, extraArgs: cfg.get<string>('llamaServerArgs', '') };
    if (!settings) return false;
    await cfg.update('llamaServerArgs', settings.extraArgs);

    let outcome: LlamaStartOutcome | undefined;
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Starting ${path.basename(modelPath)}…`, cancellable: false },
        async (progress) => {
            outcome = await startOwnLlamaServer({
                modelPath,
                contextLength: settings.contextSize,
                gpu: settings.gpuLayers > 0 ? 'max' : 'off',
                threads: settings.threads,
                extraArgs: settings.extraArgs,
                // The user was asked about the running server a moment ago; if they chose to start another
                // one, this must not quietly reuse it instead.
                reuseRunning: !startAnother,
                onProgress: (message) => progress.report({ message })
            });
        }
    );
    return finishLlamaStart(outcome ?? { ok: false, message: 'The start was cancelled before it began.' });
}

/**
 * Proves the server answers and reports it — the tail both endings share (using the one that was already
 * running, and starting a new one), so "Ready" cannot mean two different things on the two paths.
 */
async function finishLlamaStart(outcome: LlamaStartOutcome): Promise<boolean> {
    if (!outcome.ok) {
        const pick = await vscode.window.showErrorMessage(
            `Could not start llama-server. ${outcome.message ?? ''}`, 'Copy details', 'Show status'
        );
        if (pick === 'Copy details') {
            await vscode.env.clipboard.writeText(`llama-server failed\n${outcome.message ?? ''}\n\n${llamaServerTail().join('\n')}`);
        }
        if (pick === 'Show status') await vscode.commands.executeCommand('rustyPlatform.assistant.status');
        return false;
    }
    // Prove it before the user touches code — the same one-line round trip every other path uses, because
    // "the process is up" and "a request works" are different claims (2026-09-15).
    const proof = await withNotification('Checking that it answers…', () => proveItWorks());
    const raised = proof.raisedBudget
        ? ` It thinks before it answers, so the answer budget was raised to ${proof.raisedBudget}.`
        : '';
    await vscode.window.showInformationMessage(
        proof.ok
            ? `Ready. ${outcome.message}${raised}`
            : `The server on ${outcome.endpoint} is up, but the test request came back empty. ${proof.why ?? ''}`,
        'Show status',
        'OK'
    );
    return true;
}

/** The models worth offering the user's own server, without making them find the path by hand. */
async function chooseLlamaServerModel(
    context: vscode.ExtensionContext,
    cfg: vscode.WorkspaceConfiguration
): Promise<string | undefined> {
    const items: (vscode.QuickPickItem & { file?: string; browse?: boolean; spec?: ModelSpec })[] = [];
    const seen = new Set<string>();
    const push = (file: string, label: string, detail: string) => {
        if (seen.has(file)) return;
        seen.add(file);
        items.push({ label, detail, file });
    };

    // The known 27B first, because it is the model this feature exists for and the one the developer asked
    // for by name. Present → its path. Absent → the download itself, which is the "offer to download" half of
    // that request; `ensureModelFile` looks for a verified copy anywhere on this machine before spending any
    // bandwidth, so a user who already has these weights (in LM Studio, in `~/Downloads`, on a mounted drive)
    // gets them adopted instead of fetched twice.
    for (const spec of OWN_SERVER_SPECS) {
        const file = modelFileFor(context, spec);
        if (sizeMatches(file, spec.bytes)) {
            push(file, `$(star) ${spec.label}`, `already downloaded for your llama-server · ${formatBytes(spec.bytes)}`);
        } else {
            items.push({ label: `$(cloud-download) ${spec.label}`, detail: `${spec.detail} · download it`, spec });
        }
    }

    const pinned = cfg.get<string>('modelPath', '');
    if (pinned && fs.existsSync(pinned) && /\.gguf$/i.test(pinned)) {
        push(pinned, `$(star) ${path.basename(pinned)}`, `already chosen · ${shortFolder(pinned)}`);
    }
    for (const spec of allModelSpecs()) {
        const file = modelFileFor(context, spec);
        if (!fs.existsSync(file)) continue;
        // The extension's own storage is the one place a model is *guaranteed* to be, so it is listed
        // whether or not the user remembers downloading it.
        push(file, `$(cloud-download) ${spec.fileName}`, `downloaded by this extension · ${formatBytes(spec.bytes)}`);
    }

    // The same bounded walk the panel's "Scan machine for models…" uses: a fixed depth, a time budget and
    // a size floor, so "find my models" cannot turn into `find /` on a machine with network mounts.
    const found = await withNotification<FoundModelFile[]>('Looking for .gguf files on this machine…', () =>
        scanForModelFiles({ onProgress: () => undefined }));
    for (const file of found) {
        // A copy of the known 27B found somewhere else is still *the* model — said with the star so the
        // choice between "download 15.7 GB" and "use the one you already have" is obvious at a glance.
        const known = ownServerSpecByFileName(file.name);
        push(file.file,
            `${known ? '$(star)' : '$(file)'} ${file.name}`,
            known
                ? `the known 27B, already on this machine · ${file.folder} · ${file.sizeGb.toFixed(1)} GB`
                : `found on this machine · ${file.folder} · ${file.sizeGb.toFixed(1)} GB`);
    }
    items.push({ label: '$(folder-opened) Another .gguf file…', detail: 'Pick one with the file browser', browse: true });

    const pick = await vscode.window.showQuickPick(items, {
        title: 'Which model should your llama-server run?',
        placeHolder: `Nothing is downloaded for this — llama-server reads the file in place · ${modelFolder(context).replace(os.homedir(), '~')} holds the extension's own models`,
        ignoreFocusOut: true,
        matchOnDetail: true,
        matchOnDescription: true
    });
    if (!pick) return undefined;
    if (pick.spec) return await downloadOwnServerModel(context, pick.spec);
    if (!pick.browse) return pick.file;

    const startFolder = lastPickerFolder('model');
    const chosen = await vscode.window.showOpenDialog({
        title: 'Pick a .gguf model file',
        canSelectMany: false,
        openLabel: 'Use this model',
        defaultUri: startFolder ? vscode.Uri.file(startFolder) : undefined,
        filters: { 'GGUF model': ['gguf'] }
    });
    const pickedModel = chosen?.[0]?.fsPath;
    if (pickedModel) await rememberPickerFile('model', pickedModel);
    return pickedModel;
}

/** Is that file there, and exactly the size the published model is? Reading a size costs nothing; a hash does not. */
function sizeMatches(file: string, bytes: number): boolean {
    try {
        return fs.statSync(file).size === bytes;
    } catch {
        return false;
    }
}

/**
 * Fetches a known model for the user's own server — adopted from this machine when it is already here,
 * downloaded with progress and a checksum when it is not. Returns the path, or undefined if it failed (the
 * reason is shown; this is one step of a flow, not the flow's only outcome).
 */
async function downloadOwnServerModel(context: vscode.ExtensionContext, spec: ModelSpec): Promise<string | undefined> {
    try {
        return await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Getting ${spec.label}`, cancellable: true },
            async (progress, token) => await ensureModelFile(context, spec, progress, token)
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`llama-server model download failed: ${message}`);
        void vscode.window.showErrorMessage(`The model could not be downloaded. ${message}`);
        return undefined;
    }
}

function shortFolder(file: string): string {
    return path.dirname(file).replace(os.homedir(), '~');
}

interface LlamaFlags {
    contextSize: number;
    threads: number;
    gpuLayers: number;
    extraArgs: string;
}

/** The flags, shown as one sentence each so the numbers are not a black box (the LM Studio path's rule). */
async function askLlamaFlags(
    modelPath: string,
    sizeGb: number,
    recommended: ReturnType<typeof recommendedLlamaOptions>,
    cfg: vscode.WorkspaceConfiguration
): Promise<LlamaFlags | undefined> {
    const detail = [
        `Model: ${path.basename(modelPath)} (${sizeGb.toFixed(1)} GB)`,
        ...recommended.reasons.map((r) => `• ${r}`)
    ].join('\n');
    const pick = await vscode.window.showQuickPick(
        [
            { label: '$(check) Start it with these settings', detail, change: false },
            { label: '$(settings-gear) Change them…', detail: 'Context size, threads, GPU layers, and any flags of your own', change: true }
        ],
        { title: `${path.basename(modelPath)} — how should llama-server run it?`, ignoreFocusOut: true }
    );
    if (!pick) return undefined;
    const extra = cfg.get<string>('llamaServerArgs', '');
    if (!pick.change) {
        return { contextSize: recommended.contextSize, threads: recommended.threads, gpuLayers: recommended.gpuLayers, extraArgs: extra };
    }

    const context = await vscode.window.showInputBox({
        title: 'Context size (tokens)',
        value: String(recommended.contextSize),
        prompt: 'How much text the model can hold at once. Bigger costs memory (-c/--ctx-size).',
        validateInput: (v) => (/^\d{3,7}$/.test(v.trim()) ? undefined : 'A number, e.g. 8192')
    });
    if (!context) return undefined;
    const threads = await vscode.window.showInputBox({
        title: 'CPU threads',
        value: String(recommended.threads),
        prompt: 'llama.cpp is fastest one thread below the machine\'s core count (-t/--threads).',
        validateInput: (v) => (/^\d{1,3}$/.test(v.trim()) ? undefined : 'A number, e.g. 4')
    });
    if (!threads) return undefined;
    const gpu = await vscode.window.showQuickPick(
        [
            { label: 'off', detail: 'CPU only — safest, and usually faster on a shared-memory GPU', layers: 0 },
            { label: 'all layers', detail: 'Push the model to the GPU (-ngl)', layers: sidecarGpuLayers('max') }
        ],
        { title: 'GPU layers (--n-gpu-layers)', ignoreFocusOut: true }
    );
    if (!gpu) return undefined;
    const extraArgs = await vscode.window.showInputBox({
        title: 'Any flags of your own (optional)',
        value: extra,
        prompt: 'Added after the flags above, so they win. Example: --flash-attn on --no-warmup',
        placeHolder: '',
        ignoreFocusOut: true
    });
    if (extraArgs === undefined) return undefined;
    return { contextSize: Number(context), threads: Number(threads), gpuLayers: gpu.layers, extraArgs };
}

/** A notification with a progress line, for a step that has one thing to say. */
async function withNotification<T>(title: string, work: () => Promise<T>): Promise<T> {
    return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: false },
        () => work()
    );
}
