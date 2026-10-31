/* The AI section of the designer's ⚙ Code Fix/AI-Assist Settings panel — the extension half.
 *
 * Why it lives here and not in `assistantUi.ts`: this is the *designer webview's* conversation. The panel
 * renders the panel's own markup (`designerPanel.ts` holds the HTML, `media/designer.js` the behaviour),
 * and this module answers its messages: what models exist, load one, unload, run the status check, and
 * store the choices.
 *
 * The operations themselves are `localModelCore.ts` — the very same ones the Command Palette uses, so
 * "Load Model" here and "AI: Choose a Local Model…" there cannot behave differently. What is specific to
 * this file is only the *shaping* of the state the panel shows, and the fact that progress is posted to a
 * webview instead of reported in a notification.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { normalizeAssistantConfig, looksLikeEmbeddingModel, probeServer, answeredHere } from './assistant';
import { log, logError, mirrorLogTo } from './log';
import {
    chatModels,
    discover,
    findLmsCli,
    importModelFile,
    lmStudioModelsRoot,
    load,
    scanForModelFiles,
    setupFacts,
    unloadAll,
    type Discovery,
    type FoundModelFile
} from './localModelCore';
import { MODEL_SPECS, DEFAULT_CONTEXT_SIZE, sidecarBackend, specById, specByFileName, type ModelSpec, type SidecarBackend } from './modelSpecs';
import { hostGate, type HostGate } from './hostCheck';
import { configView } from './settings';
import {
    modelLabel,
    recommendedLoadOptions,
    resolveLoadOptions,
    sidecarContextSize,
    filesOfferedForSelection,
    sidecarGpuLayers,
    type LoadOptions,
    type LocalModel,
    type RequestedLoad
} from './localModels';
import { bundledFilesOnDisk, bundledRuntimeRunning, allModelSpecs, ensureBundledEndpoint, ensureModelFile, extensionContext, modelFolder, modelFileFor, stopModelServer } from './runtime';
import { proveItWorks } from './localModelSetup';
import { normaliseConventions, parseConventionsText } from './conventions';
import {
    findRunningLlamaServer,
    llamaServerBinary,
    ownLlamaServerStatus,
    startOwnLlamaServer,
    stopOwnLlamaServer
} from './llamaServer';
import { llamaServerState, type LlamaServerState } from './llamaService';

export const SETTINGS = 'rustyPlatform.assistant';

/** One entry in the panel's model dropdown. `value` is what the panel sends back. */
export interface ModelChoice {
    value: string;
    label: string;
    detail: string;
    /** What kind of thing it is, so the panel can explain why a load will take a while. */
    kind: 'lmstudio' | 'file' | 'bundled' | 'custom' | 'llama' | 'any';
    /** True for the entry that is serving requests right now — what "● loaded" means. */
    live?: boolean;
    /**
     * The `<optgroup>` this entry belongs in, or nothing for the models shown at the top (asked 2026-09-17:
     * *"There should only be 2 options in the picker"*). The two shipped entries are the list; everything
     * else — LM Studio's library, loose `.gguf` files, other servers — lives under one fold so a novice
     * never has to read it.
     */
    group?: string;
}

export interface PanelState {
    enabled: boolean;
    endpoint: string;
    /**
     * The host check: whether this machine may run a local model at all, and the warning when it may but is
     * tight on memory. Sent with every state so the panel can grey the section out and explain why
     * (`assistant.ignoreHostCheck` is the escape hatch, and `host.overridden` says it was used).
     */
    host: HostGate;
    /** Show the model's code as a diff before it is applied (⚙ Code Fix/AI-Assist Settings, `assistant.showDiff`). */
    showDiff: boolean;
    /**
     * The native build of the built-in runtime (`assistant.bundledBackend`): `cpu` or `vulkan`.
     *
     * The panel needs it for one sentence — whether "max" on the GPU-offload row can do anything at all for
     * a model the built-in runtime serves (2026-09-16).
     */
    bundledBackend: SidecarBackend;
    /** The house rules, one per line in the panel's editor (`assistant.conventions`). */
    conventions: string[];
    /** The value of the entry that matches the settings right now, or '' when nothing matches. */
    selected: string;
    choices: ModelChoice[];
    options: {
        contextLength: number;
        gpu: string;
        ttlSeconds: number;
        maxTokens: number;
        timeoutSeconds: number;
        /** The values this machine would get, so "recommended" is never a mystery. */
        recommended: { contextLength: number; gpu: string; ttlSeconds: number };
    };
    /** A line under the dropdown: what is loaded, what was found by a scan, or why the list is empty. */
    hint: string;
    /** What requests will actually use, in words — the panel's answer to "did my load take?". */
    pinned: string;
    /**
     * The user's own `llama-server`: who is serving the endpoint, how Start would bring it up, and whether
     * either is possible (2026-09-17). One object, so the panel's row and the status dialog cannot disagree
     * about who started it.
     */
    llamaServer: LlamaServerState;
    /**
     * Whether "Remove Model" can act on the current selection, and why not when it cannot (2026-09-17).
     * The panel greys the button out and uses this as its tooltip, so "nothing happened" cannot be the answer
     * — which is exactly what the button used to give when the selection was a server entry.
     */
    remove: { allowed: boolean; hint: string };
}

/** Anything a scan found this session, kept so the dropdown does not lose it on the next refresh. */
let scanned: FoundModelFile[] = [];

/** `lms:<key>` · `file:<path>` · `bundled:<specId>` · `custom:<url>` */
export function choiceValue(kind: string, key: string): string {
    return `${kind}:${key}`;
}

export function parseChoiceValue(value: string): { kind: string; key: string } {
    const at = String(value ?? '').indexOf(':');
    if (at < 0) return { kind: '', key: '' };
    return { kind: value.slice(0, at), key: value.slice(at + 1) };
}

/** Builds the dropdown: everything that could be loaded, in the order a developer would look. */
export function buildChoices(found: Discovery, files: FoundModelFile[], endpoint: string, backend = 'off', modelPath = '', bundled: Record<string, { onDisk: boolean; bytes: number }> = {}, specs: ModelSpec[] = MODEL_SPECS, llamaBin = '', llamaRunning = '', native: SidecarBackend = 'cpu', ownModelPath = ''): ModelChoice[] {
    const choices: ModelChoice[] = [];
    // "Whatever is loaded" is a real answer, and it is the one the settings most often hold (`model` empty).
    // Without an entry for it the dropdown showed the *first* LM Studio model as if it had been chosen — and
    // pressing Save then pinned a model nobody picked (found while verifying the selection, 2026-09-15).
    choices.push({
        value: choiceValue('any', ''),
        label: 'Let the server decide — whatever it has loaded',
        detail: found.loaded.length
            ? `${found.loaded.length} model(s) in memory right now`
            : 'nothing is in memory right now — a request would fail until something is loaded',
        kind: 'any'
    });
    for (const model of chatModels(found)) {
        const loaded = found.loaded.some((id) => id === model.key || id.endsWith(model.key));
        choices.push({
            value: choiceValue('lms', model.key),
            label: `${modelLabel(model)}${loaded ? '   ● loaded' : ''}`,
            // These *are* LM Studio's library entries (`lms ls` is what My Models shows), and saying so is the
            // answer to "why does a model have to be in My Models?": the extension is only a remote control
            // here — LM Studio is the runtime, and it can only load what it has an entry for (2026-09-15).
            detail: `LM Studio · ${loaded ? 'in memory now' : 'in My Models, ready to load'}`,
            kind: 'lmstudio',
            live: loaded
        });
    }
    for (const spec of specs) {
        // A bundled model pins through `modelPath`, and the runtime shows it is up — so this is the marker
        // that tells the user their load took. Without it, loading the extension's own model looked like
        // nothing had happened (reported 2026-09-15).
        const running = bundledRuntimeRunning();
        // Two entries share one file since 0.10.5, so "is this one pinned?" cannot be answered by the file name
        // alone: the entry also has to be the **build that is configured**, or both entries call themselves
        // pinned at once — reported 2026-09-17 as *"the picker is listing both the vulcan and non-valcon is
        // pinned"*. An entry with no build of its own (a Hub-added model) is always a match.
        const mine = !spec.backend || spec.backend === native;
        const isPinned = mine && backend === 'bundled' && !!modelPath && modelPath.endsWith(spec.fileName);
        // Whether these weights are already on this machine, said outright. "Downloaded once when you press
        // Load Model" was true of every entry and therefore told the user nothing — a 4.4 GB entry that had
        // never been fetched looked exactly like the ready one (asked 2026-09-15: "the Qwen models does not
        // work - Not downloaded???").
        const disk = bundled[spec.id];
        const sizeGb = Math.round(spec.bytes / (1024 * 1024 * 1024) * 10) / 10;
        const state = disk?.onDisk
            ? 'weights on disk, ready to load'
            : disk && disk.bytes > 0
                ? 'a partial download is on disk — Load Model resumes it'
                : disk
                    ? `not downloaded yet — ${sizeGb} GB to fetch on the first load`
                    : `downloads once when you press Load Model (${sizeGb} GB)`;
        choices.push({
            value: choiceValue('bundled', spec.id),
            label: `${spec.label}  ·  ${Math.round(spec.bytes / (1024 * 1024 * 1024) * 10) / 10} GB`
                + `${isPinned && running.running ? '   ● in use' : isPinned ? '   ● pinned, runtime stopped' : ''}`,
            detail: `This extension's own runtime · ${state}`,
            kind: 'bundled',
            live: isPinned && running.running
        });
    }
    // Files inside LM Studio's folder are offered only when `lms ls` is not answering — otherwise they are
    // already in the LM Studio group above, and two entries for one set of weights is noise. Hiding them
    // *always* was the bug: with `lms` installed but its daemon refusing to start they appeared nowhere.
    for (const file of filesOfferedForSelection(files, found.list.chat.length > 0)) {
        choices.push({
            value: choiceValue('file', file.file),
            label: `${file.name}  ·  ${file.sizeGb.toFixed(1)} GB`,
            detail: file.inLmStudio
                // It is already where LM Studio keeps its models, so there is nothing to import: our own
                // runtime reads the file in place, which also works while LM Studio's daemon is down.
                ? `Found on this machine · ${file.folder} · already inside LM Studio's folder, served by the extension's own runtime`
                : found.cli
                    // What pressing Load will actually do with a file that is *not* in LM Studio yet — the step
                    // that was invisible, and the reason a model outside My Models looked unusable (2026-09-15).
                    ? `Found on this machine · ${file.folder} · added to LM Studio first (a symbolic link — your file stays where it is)`
                    : `Found on this machine · ${file.folder} · served by the extension's own runtime (no LM Studio needed)`,
            kind: 'file'
        });
    }
    // The user's **own** `llama-server` (asked 2026-09-16: *"models served by the Llama.cpp server respond
    // faster and better than the LM Studio models"*). It sits right next to the extension's own runtime
    // because it is the same kind of answer — a local engine this window can start, stop and pin — while the
    // "a server I run myself" entry below stays the one for an address that is *already* serving something.
    const own = ownLlamaServerStatus();
    // The file *this* server was set up with — `llamaServerModelPath`, not the built-in runtime's `modelPath`.
    const chosenFile = ownModelPath ? path.basename(ownModelPath) : '';
    choices.push({
        value: choiceValue('llama', ''),
        label: `My own llama-server  ·  llama.cpp${own.running && own.info ? `   ● running on port ${own.info.port}` : ''}`,
        detail: !llamaBin
            ? 'llama.cpp · no llama-server on this machine yet — Load Model offers to download llama.cpp for you, or point "llamaServerPath" at your own build'
            : own.running && own.info
                ? `llama.cpp · serving ${path.basename(own.info.modelPath)} right now`
                : llamaRunning
                    // One the user started themselves is answering. Saying so is the difference between a
                    // useful entry and one that looks like it would start a *second* model (2026-09-16).
                    ? `llama.cpp · ${llamaRunning} — Load Model uses that one, it is already in memory`
                    : chosenFile
                        ? `llama.cpp · runs ${chosenFile} with the flags below, using ${llamaBin.replace(os.homedir(), '~')}`
                        : 'llama.cpp · found — Load Model gets the 27B for you (downloading it if this machine has none)',
        kind: 'llama',
        live: own.running
    });
    choices.push({
        value: choiceValue('custom', endpoint),
        label: 'A server I run myself  ·  any OpenAI-compatible address',
        detail: 'Ollama, llama.cpp or anything else already running — set the address below',
        kind: 'custom'
    });

    // Presentation (re-ordered 2026-09-17, asked: *"There should only be 2 options in the picker"* — "Two, with
    // an 'Advanced…' fold for the rest"). What this extension ships for comes first and is the whole list a
    // novice reads: the 7B on the GPU build, then the same weights on the CPU build. Everything else is real
    // and still works — LM Studio's library, loose `.gguf` files found on disk, the user's own `llama-server`,
    // a bare address — but it is folded under "Advanced…", where it cannot be mistaken for the choice being
    // asked of them. Nothing was removed; only the reading order changed.
    const ADVANCED = 'Advanced…';
    for (const c of choices) if (c.kind !== 'bundled') c.group = ADVANCED;
    const order: Record<string, number> = { bundled: 0, any: 1, llama: 2, custom: 3, lmstudio: 4, file: 5 };
    return choices
        .map((c, i) => ({ c, i }))
        .sort((a, b) => ((order[a.c.kind] ?? 9) - (order[b.c.kind] ?? 9)) || (a.i - b.i))
        .map((x) => x.c);
}

/** The model the settings point at right now, as a dropdown value. */
export function currentSelection(choices: ModelChoice[], model: string, backend: string, modelPath: string, ownServerRunning = false, native: SidecarBackend = 'cpu'): string {
    if (backend === 'bundled') {
        // The entry whose build is the configured one wins (the two entries share a file since 0.10.5), so
        // picking "CPU only" does not leave the picker pointing at the GPU entry — and a spec with no build of
        // its own (a model added from the Hub) still matches by name.
        const named = modelPath
            ? MODEL_SPECS.find((s) => path.basename(modelPath) === s.fileName && (!s.backend || s.backend === native))
            ?? specByFileName(modelPath)
            : undefined;
        // No weights pinned to the setting: the placeholder (`""`), never the first spec. Falling back to the
        // first entry is how a picker ends up naming a model nobody chose — the webview already refused that
        // (2026-09-15), and the host now agrees with it. Only a real, on-disk pin selects a bundled model.
        return named ? choiceValue('bundled', named.id) : '';
    }
    // Our own `llama-server` is the one entry whose pin the panel cannot recognise from `model` alone (the
    // id is whichever alias the running process reports, and the address is a port that changes every time).
    // The process itself is the authority: while it is up, this is what requests are going to.
    if (ownServerRunning && choices.some((c) => c.kind === 'llama')) return choiceValue('llama', '');
    const match = choices.find((c) => c.kind === 'lmstudio' && c.value === choiceValue('lms', model));
    return match ? match.value : choiceValue('any', '');
}

/** Everything the panel needs to draw itself, in one message. */
export async function panelState(fresh = false): Promise<PanelState> {
    const cfg = configView(SETTINGS);
    const backend = cfg.get<string>('backend', 'off');
    const endpoint = cfg.get<string>('endpoint', '') || 'http://127.0.0.1:1234/v1';
    if (fresh) scanned = [];
    // Asked with a cache and a short patience (2026-09-17): this runs on every panel open, save and focus, and
    // the first `lms` call of a session starts LM Studio's service on the way — 20 s per call, twice per state,
    // which is what made ⚙ Code Fix/AI-Assist Settings crawl the first time it was opened after a reload. `fresh` is the user's own
    // Refresh list, so that one asks in full; the load and import flows do the same.
    const found = await discover(fresh ? { maxAgeMs: 0, cliTimeoutMs: 20000 } : { maxAgeMs: 15000, cliTimeoutMs: 3000 });
    const lookup = llamaServerBinary(cfg.get<string>('llamaServerPath', ''));
    const ownServer = ownLlamaServerStatus();
    // Cached for 15 s inside the probe: a state refresh happens on every panel open, save and focus, and
    // three local ports that are not listening answer instantly — but a *hung* one would not, and this
    // question is only worth asking once in a while either way.
    const elsewhere = await findRunningLlamaServer(endpoint);
    const llamaRunning = elsewhere
        ? `already running on port ${elsewhere.port}${elsewhere.modelId ? ` (${elsewhere.modelId})` : ''}`
        : '';
    const choices = buildChoices(found, scanned, endpoint, backend, cfg.get<string>('modelPath', ''), bundledFilesOnDisk(), allModelSpecs(), lookup.path ?? '', llamaRunning, sidecarBackend(cfg.get<string>('bundledBackend', 'vulkan')), cfg.get<string>('llamaServerModelPath', ''));
    if (choices.length === 0 && !found.cli) {
        choices.push({
            value: choiceValue('custom', endpoint),
            label: 'A server I run myself  ·  any OpenAI-compatible address',
            detail: 'LM Studio is not installed on this machine',
            kind: 'custom'
        });
    }

    // The recommendation needs a model to be sized against; without a selection the largest chat model is
    // the honest worst case, and model-free facts (RAM, lock limit) are what actually drive the numbers.
    const facts = setupFacts();
    const sample: LocalModel = chatModels(found)[0]
        ?? { provider: 'bundled', key: 'sample', label: 'sample', params: '', arch: '', sizeGb: 2, kind: 'chat' };
    const recommended = recommendedLoadOptions(sample, facts);
    const hint = found.cli
        ? `${chatModels(found).length} LM Studio model(s) on disk · ${found.loaded.length} loaded`
        + (scanned.length ? ` · ${scanned.length} file(s) found by the scan` : ' · nothing scanned yet')
        : `LM Studio is not installed — ${allModelSpecs().length} downloadable model(s) and files found on disk still work`;

    // The selection is computed once and used twice: as the panel's value, and as the thing "Remove Model"
    // would act on — the two must be the same string or the button's promise and its result differ.
    const selectedValue = currentSelection(
        choices,
        cfg.get<string>('model', ''),
        backend,
        cfg.get<string>('modelPath', ''),
        ownServer.running,
        sidecarBackend(cfg.get<string>('bundledBackend', 'vulkan'))
    );
    const context = extensionContext();

    return {
        // The switch, not merely "a backend is configured": with the assistant off the panel must not look
        // ready to answer, because a request would have nowhere to go.
        enabled: cfg.get<boolean>('enabled', false) === true && backend !== 'off',
        endpoint,
        host: await hostGate(),
        showDiff: cfg.get<boolean>('showDiff', true),
        bundledBackend: sidecarBackend(cfg.get<string>('bundledBackend', 'vulkan')),
        conventions: normaliseConventions(cfg.get<unknown>('conventions', [])),
        llamaServer: await llamaServerState(endpoint),
        selected: selectedValue,
        remove: removeAdvice({
            value: selectedValue,
            specs: allModelSpecs(),
            folder: context ? modelFolder(context) : '',
            pinnedModelPath: cfg.get<string>('modelPath', ''),
            ownServedPath: ownServer.running ? ownServer.info?.modelPath : undefined
        }),
        choices,
        options: {
            contextLength: cfg.get<number>('loadContextLength', 0) || recommended.contextLength,
            gpu: cfg.get<string>('loadGpu', '') || recommended.gpu,
            ttlSeconds: cfg.get<number>('loadTtlSeconds', -1) >= 0 ? cfg.get<number>('loadTtlSeconds', -1) : recommended.ttlSeconds,
            maxTokens: cfg.get<number>('maxTokens', 4096),
            timeoutSeconds: cfg.get<number>('timeoutSeconds', 60),
            recommended: {
                contextLength: recommended.contextLength,
                gpu: recommended.gpu,
                ttlSeconds: recommended.ttlSeconds
            }
        },
        hint: ownServer.running && ownServer.info
            ? `${hint} · your own llama-server is running on port ${ownServer.info.port}`
            : hint,
        pinned: describePin(
            backend,
            cfg.get<string>('model', ''),
            cfg.get<string>('modelPath', ''),
            endpoint,
            found,
            cfg.get<boolean>('enabled', false) === true
        )
    };
}

/**
 * What requests will actually use, said in words.
 *
 * The panel used to leave this to be inferred from the dropdown, and for a **bundled** model that inference
 * was impossible: the pin lives in `modelPath`, not `model`, and no bundled entry ever showed a loaded
 * marker — so a successful load looked like nothing had happened (reported 2026-09-15).
 */
function describePin(
    backend: string,
    model: string,
    modelPath: string,
    endpoint: string,
    found: Discovery,
    switchOn = true
): string {
    if (!switchOn) return 'AI assist is switched off — turn it on in the panel to start the model.';
    if (backend === 'off') return 'No backend has been chosen yet — pick a model in the settings.';
    // A `llama-server` this window started: named by the file it was started with and the port it got, since
    // both come from the process rather than from a setting the user typed (2026-09-16).
    const own = ownLlamaServerStatus();
    if (backend === 'external' && own.running && own.info && own.info.endpoint === endpoint) {
        return `Pinned: ${path.basename(own.info.modelPath)} — your own llama-server, running on ${own.info.endpoint}`
            + ` (it answers to "${own.info.modelId}")`;
    }
    const runtime = bundledRuntimeRunning();
    if (backend === 'bundled') {
        const spec = modelPath ? specByFileName(modelPath) : undefined;
        const name = spec?.label ?? (modelPath ? path.basename(modelPath) : 'the built-in model');
        return runtime.running
            ? `Pinned: ${name} — serving requests on ${runtime.endpoint}`
            : `Pinned: ${name} — the built-in runtime is not running; the next request starts it`;
    }
    if (model) {
        const inMemory = found.loaded.some((id) => id === model || id.endsWith(model));
        // Discovery is LM Studio's list, and it knows nothing about a `llama-server`, a server another window
        // started, or any OpenAI-compatible endpoint the user runs — so it answered "not in memory yet" for a
        // model that had just written a whole reply, and kept saying it for the rest of the conversation
        // (reported 2026-10-31). An answer from this model at this address is the stronger fact, and it is the
        // one the user can see, so the line says what happened instead of what a registry guessed.
        return inMemory || answeredHere(endpoint, model)
            ? `Pinned: ${model} on ${endpoint} — Model loaded and active`
            : `Pinned: ${model} on ${endpoint} — not in memory yet; the next request loads it`;
    }
    const loaded = found.loaded.filter((id) => !looksLikeEmbeddingModel(id));
    return loaded.length
        ? `Not pinned — ${endpoint} serves whatever is loaded (${loaded.join(', ')})`
        : `Not pinned, and nothing is loaded on ${endpoint} — a request will fail until something is loaded.`;
}

export interface LoadOutcome {
    ok: boolean;
    /** Where it ended up, for the panel to show. */
    endpoint?: string;
    message?: string;
    /** What the load cost, when the CLI estimated it. */
    estimate?: string;
}

/** True when the weights are already in the extension's storage. */
function fileOnDisk(context: vscode.ExtensionContext, spec: ModelSpec): boolean {
    try {
        return fs.statSync(modelFileFor(context, spec)).size === spec.bytes;
    } catch {
        return false;
    }
}

/** True when the Rust sidecar has never been built, so the next start compiles llama.cpp for this machine. */
function firstBuildNote(context: vscode.ExtensionContext): boolean {
    // The build output lives in global storage, not beside the installed sources, so it survives an update.
    return !fs.existsSync(path.join(context.globalStorageUri.fsPath, 'sidecar', 'target', 'release'));
}

/**
 * What the panel sends, for a **load** and for a **save** alike. Deliberately **flat**, matching
 * `aiPayload()` in `media/designer.js` field for field — the two used to disagree (the webview sent this,
 * the extension read `state.options.contextLength`), which threw a TypeError before a single message could
 * be posted. That mismatch *was* "nothing further happens". One type for both directions means there is
 * nothing to drift, and `tests/t2-logic/panelContract.test.js` compares the two files field by field.
 */
export interface PanelAiRequest extends RequestedLoad {
    /** The AI switch. A load implies "on", so the load path does not read it; Save does. */
    enabled: boolean;
    /** Review the model's code as a diff, or write it straight into the file. */
    showDiff: boolean;
    /** The house rules as the panel's editor holds them — one rule per line, blank lines ignored. */
    conventions?: string;
    /** The dropdown value (`lms:<key>`, `file:<path>`, `bundled:<id>`, `custom:<url>`). */
    value: string;
    /** Answer budget and timeout — request settings, applied by Save rather than by a load. */
    maxTokens: number;
    timeoutSeconds: number;
    endpoint: string;
}

export async function loadChoice(context: vscode.ExtensionContext, request: PanelAiRequest, value?: string): Promise<LoadOutcome> {
    const cfg = configView(SETTINGS);
    const { kind, key } = parseChoiceValue(value ?? request.value ?? '');
    resetProgressClock();
    aiLog(context, `Load requested: kind=${kind} key=${key}`);
    // Nothing below may throw: a load that dies without a word is what "nothing further happens" was, and
    // the user has no way to tell a slow step from a dead one. Every exit is a LoadOutcome with a sentence.
    try {
        return await startLoad(context, cfg, request, kind, key);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        aiLog(context, `Load FAILED: ${message}`);
        logError(`AI load failed: ${message}`);
        return { ok: false, message: `${message} (details in ${aiLogFile(context)})` };
    }
}

async function startLoad(
    context: vscode.ExtensionContext,
    cfg: vscode.WorkspaceConfiguration,
    request: PanelAiRequest,
    kind: string,
    key: string
): Promise<LoadOutcome> {
    const facts = setupFacts();
    const report = (message: string) => progress(message);

    if (kind === 'llama') {
        // The user's own `llama-server` (asked 2026-09-16). No download and no other program is involved: the
        // binary is theirs, the `.gguf` is theirs, and this window owns the process. `key` carries a file when
        // a caller has one; otherwise the model file is the one the settings already name.
        const file = key || cfg.get<string>('llamaServerModelPath', '');
        progress('starting your own llama-server…');
        const outcome = await startOwnLlamaServer({
            modelPath: file,
            contextLength: request.contextLength,
            gpu: request.gpu,
            threads: cfg.get<number>('threads', 0),
            onProgress: report
        });
        aiLog(context, `llama-server start: ${outcome.ok ? `ok on ${outcome.endpoint}` : `failed — ${outcome.message}`}`);
        if (!outcome.ok) return { ok: false, message: outcome.message };
        // "The process is up" is not "a request works" — the same one-line proof every other load path runs.
        progress('checking that it answers…');
        const proof = await proveItWorks();
        if (!proof.ok) {
            return {
                ok: false,
                endpoint: outcome.endpoint,
                message: `llama-server is running on ${outcome.endpoint}, but a test request failed: ${proof.why ?? 'no answer'}`
            };
        }
        return { ok: true, endpoint: outcome.endpoint, message: outcome.message };
    }

    if (kind === 'custom') {
        if (!/^https?:\/\/\S+$/i.test(key)) return { ok: false, message: 'That address does not look like an http:// URL.' };
        await cfg.update('backend', 'external', vscode.ConfigurationTarget.Global);
        await cfg.update('endpoint', key, vscode.ConfigurationTarget.Global);
        await cfg.update('model', '', vscode.ConfigurationTarget.Global);
        return { ok: true, endpoint: key };
    }

    if (kind === 'any') {
        // Nothing to load: the point is to check that the server this points at has something to serve.
        // Today's failure mode was exactly that — "on" in the panel, `HTTP 400 No models loaded` on the wire.
        progress('asking the server what it has loaded…');
        const live = normalizeAssistantConfig({
            backend: 'external',
            endpoint: request.endpoint || cfg.get<string>('endpoint', ''),
            model: '',
            timeoutSeconds: request.timeoutSeconds
        });
        await cfg.update('backend', 'external', vscode.ConfigurationTarget.Global);
        await cfg.update('model', '', vscode.ConfigurationTarget.Global);
        const answer = await proveItWorks();
        const probe = await probeServer(live);
        const chat = (probe.models ?? []).filter((m) => !looksLikeEmbeddingModel(m.id));
        aiLog(context, `Any-model load: ${chat.length} chat model(s) offered, test request ${answer.ok ? 'answered' : 'failed'}`);
        if (!answer.ok) {
            return {
                ok: false,
                endpoint: live.endpoint,
                message: `Nothing is answering on ${live.endpoint}. ${answer.why ?? ''} Load a model there, or pick one from the list.`
            };
        }
        return {
            ok: true,
            endpoint: live.endpoint,
            message: `Ready — ${live.endpoint} answers, and requests will use whichever model it has loaded`
                + `${chat.length > 1 ? ` (it offers ${chat.length} — pick one above to make answers reproducible)` : ''}.`
        };
    }

    if (kind === 'bundled') {
        const spec = specById(key);
        if (!spec) return { ok: false, message: `Unknown bundled model "${key}".` };
        // The entry *is* the choice of native build (2026-09-17): the same weights are offered once for the GPU
        // build and once for the CPU build, so which one was picked is written here — the same key the status
        // line reads back to say which build actually loaded.
        if (spec.backend) {
            const before = cfg.get<string>('bundledBackend', 'vulkan');
            await cfg.update('bundledBackend', spec.backend, vscode.ConfigurationTarget.Global);
            if (before !== spec.backend) aiLog(context, `Load: native build ${before} → ${spec.backend} (from the entry)`);
        }
        // …and the offload, because a "GPU" entry whose layers all stay on the CPU is a label that lies — and it
        // did, silently (asked 2026-09-17): ModelHost's own argv said `--gpu-layers 0` while both the picker and
        // `Native backend: Vulkan build` said GPU, because `sidecarGpuLayers` turns only `max` into a layer count
        // and everything else — `auto` included — into 0. Only the shipped entries carry a `backend`, so a model
        // the user added keeps their own GPU field: its size is unknown to us, and guessing `max` for a 16 GB
        // model on a shared-memory GPU is exactly the mistake this setting was written to avoid.
        const wantedGpu = spec.backend ? (spec.backend === 'cpu' ? 'off' : 'max') : undefined;
        if (wantedGpu) {
            const beforeGpu = cfg.get<string>('loadGpu', 'auto');
            if (beforeGpu !== wantedGpu) {
                await cfg.update('loadGpu', wantedGpu, vscode.ConfigurationTarget.Global);
                aiLog(context, `Load: GPU offload ${beforeGpu} → ${wantedGpu} (from the entry)`);
            }
        }
        // Say which of the two things is about to happen. The webview cannot know — it used to guess
        // "downloading (first time)" even when the weights were already on disk (the user's report,
        // 2026-09-15), which sent them looking for a download that never started.
        const already = fileOnDisk(context, spec);
        progress(already
            ? `${spec.label} is already on disk — starting the built-in runtime${firstBuildNote(context) ? ' (its first build downloads the inference library, which can take a few minutes)' : ''}…`
            : `downloading ${spec.label} — this can take a few minutes…`);
        aiLog(context, `Bundled load: file=${already ? 'on disk' : 'to download'} path=${modelFileFor(context, spec)}`);
        const file = await ensureModelFile(context, spec, {
            report: ({ message }) => progress(message ?? '')
        } as vscode.Progress<{ message?: string }>);
        aiLog(context, `Weights ready: ${file}`);
        await cfg.update('backend', 'bundled', vscode.ConfigurationTarget.Global);
        await cfg.update('modelPath', file, vscode.ConfigurationTarget.Global);
        await cfg.update('model', '', vscode.ConfigurationTarget.Global);
        progress('starting the built-in runtime…');
        // The load in progress uses the entry's own choice too, not the field the webview sent a moment ago: the
        // setting was just written, so reading the old value here would offload nothing until the *next* load.
        const endpoint = await startBundled(wantedGpu ? { ...request, gpu: wantedGpu } : request, file, cfg.get<number>('threads', 0));
        aiLog(context, `Bundled runtime answering on ${endpoint}`);
        return { ok: true, endpoint, message: `${spec.label} is answering from the extension's own runtime.` };
    }

    if (kind === 'file') {
        const insideLmStudio = key.startsWith(lmStudioModelsRoot() + path.sep);
        if (!foundLms() || insideLmStudio) {
            // No LM Studio, or the file already lives in LM Studio's own folder: our runtime takes any `.gguf`
            // and reads it in place. Importing a file that is already there is refused by `lms` (and pointless),
            // and when LM Studio's daemon will not start this is the only route to the file at all.
            progress('starting the extension\'s own runtime for this file…');
            await cfg.update('backend', 'bundled', vscode.ConfigurationTarget.Global);
            await cfg.update('modelPath', key, vscode.ConfigurationTarget.Global);
            const endpoint = await startBundled(request, key, cfg.get<number>('threads', 0));
            aiLog(context, `File served by the built-in runtime: ${key} → ${endpoint}`);
            return { ok: true, endpoint, message: `${key} is answering from the extension's own runtime.` };
        }
        progress('importing it into LM Studio (a symbolic link, your file stays where it is)…');
        const imported = await importModelFile(key, { onProgress: report });
        if (!imported.ok || !imported.key) {
            return { ok: false, message: imported.message ?? 'The import did not add a model — see the "Grumpy\'s WYSIWYG Designer" output.' };
        }
        const refreshed = await discover();
        const model = chatModels(refreshed).find((m) => m.key === imported.key);
        if (!model) return { ok: false, message: `Imported, but "${imported.key}" is not in the model list.` };
        return await loadLmStudio(model, resolveLoadOptions(model, request, facts), facts, refreshed, report);
    }

    const found = await discover();
    const model = chatModels(found).find((m) => m.key === key);
    if (!model) return { ok: false, message: `"${key}" is not in the LM Studio list any more — press Refresh list.` };
    return await loadLmStudio(model, resolveLoadOptions(model, request, facts), facts, found, report);
}

/** Starts (and if needed builds) the extension's own runtime and returns its endpoint. */
async function startBundled(request: RequestedLoad, modelPath: string | undefined, threads: number): Promise<string> {
    // The panel's choices reach the built-in runtime too (2026-09-18): context length is `--ctx`, and the
    // GPU field, which is a *ratio* for LM Studio, becomes a layer count for llama.cpp. Before this, the
    // built-in runtime always started with its own defaults and the two fields were silently ignored.
    const cfg = normalizeAssistantConfig({
        backend: 'bundled',
        modelPath,
        threads,
        contextSize: sidecarContextSize(request.contextLength, DEFAULT_CONTEXT_SIZE),
        gpuLayers: sidecarGpuLayers(request.gpu),
        endpoint: '',
        model: ''
    });
    return ensureBundledEndpoint(cfg);
}

/** A `lms` on this machine, asked through the core so both front doors see the same answer. */
function foundLms(): boolean {
    return !!findLmsCli();
}

async function loadLmStudio(
    model: LocalModel,
    options: LoadOptions,
    facts: ReturnType<typeof setupFacts>,
    found: Discovery,
    onProgress: (message: string) => void
): Promise<LoadOutcome> {
    const withId: LoadOptions = { ...options, identifier: model.key };
    const result = await load({ model, options: withId, facts, server: found.server, onProgress });
    if (result.cancelled) return { ok: false, message: 'Cancelled.' };
    if (!result.ok || !result.endpoint) return { ok: false, message: result.message ?? 'The load failed.' };
    const cfg = configView(SETTINGS);
    await cfg.update('backend', 'external', vscode.ConfigurationTarget.Global);
    await cfg.update('endpoint', result.endpoint, vscode.ConfigurationTarget.Global);
    await cfg.update('model', model.key, vscode.ConfigurationTarget.Global);
    // "lms load exited 0" is not "a request works". The bundled path proves itself with a one-line round trip
    // and this one did not — which is how the panel could say "on" while the wire said
    // `HTTP 400 No models loaded` (2026-09-15). Same proof, both paths.
    onProgress('checking that it answers…');
    const proof = await proveItWorks();
    log(`Panel load: ${model.key} → ${result.endpoint} (test request ${proof.ok ? 'answered' : 'FAILED'})`);
    if (!proof.ok) {
        return {
            ok: false,
            endpoint: result.endpoint,
            message: `${model.key} is loaded on ${result.endpoint}, but a test request failed: ${proof.why ?? 'no answer'}`
        };
    }
    return {
        ok: true,
        endpoint: result.endpoint,
        message: result.unloaded.length
            ? `Loaded ${model.key} (unloaded ${result.unloaded.join(', ')} first) and it answered a test request.`
            : `Loaded ${model.key} and it answered a test request.`,
        estimate: result.estimate
            ? `Estimated ${result.estimate.totalGiB.toFixed(1)} GB of memory at ${result.estimate.contextLength} tokens `
            + `(confidence ${result.estimate.confidence}).`
            : undefined
    };
}

/**
 * "Unload" — the button has to free **both** runtimes.
 *
 * It only ever ran `lms unload --all`, which is LM Studio's command: for a built-in model it did nothing at all,
 * leaving the sidecar holding the weights and the picker still showing `● in use` (reported 2026-09-15, the moment
 * pinning started working). Stopping the extension's own runtime is what "unload" means for those models, and it
 * is harmless when it is not running.
 *
 * LM Studio being absent is not a failure either: there is simply nothing of its to free.
 */
export async function unloadEverything(): Promise<LoadOutcome> {
    const done: string[] = [];
    if (bundledRuntimeRunning().running) {
        stopModelServer();
        done.push('the built-in runtime is stopped');
    }
    // The user's own llama-server is the third runtime and, like the sidecar, only this window can stop it —
    // it is a child process of the extension host. "Unload" that left it holding several gigabytes would be
    // the same bug "unload everything" had for the sidecar (2026-09-15).
    if (ownLlamaServerStatus().running) {
        stopOwnLlamaServer();
        done.push('your own llama-server is stopped');
    }
    // One the user started themselves (this machine's is a systemd service) is deliberately left running: it
    // is not ours to kill, but staying silent about it would be worse — it is still holding the memory.
    let note = '';
    if (ownLlamaServerStatus().running === false) {
        const elsewhere = await findRunningLlamaServer(configView(SETTINGS).get<string>('endpoint', ''));
        if (elsewhere) {
            note = `a llama-server on port ${elsewhere.port} is still running — this window did not start it, `
                + 'so stop the service yourself to free that memory';
        }
    }
    if (foundLms()) {
        const result = await unloadAll();
        if (!result.ok) return { ok: false, message: result.message };
        done.push('LM Studio has nothing loaded');
    }
    return {
        ok: true,
        message: done.length || note
            ? `Done — ${[...done, note].filter(Boolean).join(', and ')}.`
            : 'Nothing was loaded, so there was nothing to free.'
    };
}

/**
 * "Remove Model" — deletes the selected model's weights from local storage so the file is gone until the
 * next "Load Model" re-downloads it.
 *
 * The host shows the confirmation (not the panel): it can validate the selection first (only a
 * downloaded bundled model can be removed) and it can stop the built-in runtime first — the sidecar
 * holds the `.gguf` open while it serves it, and Windows locks files that are in use, so deleting
 * a loaded model without stopping it would fail mid-`unlink`. Both the final weights file and the
 * `.part`/`.verified` sidecar markers are removed, so the entry returns to its "download once when you
 * press Load Model" state instead of lingering as a half-downloaded file.
 */
/**
 * What "Remove Model" would delete for a given selection — resolved, or refused with a reason.
 *
 * WHY THIS EXISTS (reported 2026-09-17: *"The Remove Model function is not removing the selected model."*).
 * The button acts on the **selection**, and the selection is frequently not a downloaded model at all: after a
 * Load the pinned value is `llama:`/`any:`, while the file behind it is one this extension downloaded itself.
 * The old code looked only at `bundled:<id>` and refused everything else with one terse sentence — no log line,
 * no trace, and a file the extension owned sitting right there. Three artefacts from that report agreed: the
 * log held no removal line for the attempt (a refusal logged nothing), `settings.json` had `backend: external`
 * with a dynamic endpoint (so the selection was a server entry) and `modelPath` pointed at the downloaded 7B
 * inside the extension's own storage.
 *
 * The rule the resolution follows is the rule deletion has always followed: **only a file inside this
 * extension's model folder is ours to delete.** Anything else — a Hugging Face cache, LM Studio's library, a
 * folder the user chose — is refused, with the reason *and* the folder we do own named, so the answer is
 * actionable instead of silent.
 */
export interface RemoveTarget {
    /** The `.gguf` to delete. */
    file: string;
    /** What to call it in the dialogs — the file's name, never an internal id. */
    name: string;
    /** The spec id when the file is one the picker knows, so the pin can be cleared with it. */
    specId?: string;
}

export function resolveRemoveTarget(input: {
    value: string;
    specs: ModelSpec[];
    /** The extension's own model folder — the only place it may delete from. */
    folder: string;
    /** `assistant.modelPath`: the file the settings pin, which is what a server entry is serving. */
    pinnedModelPath?: string;
    /** The file this window's own `llama-server` is serving, when one is running. */
    ownServedPath?: string;
}): { target?: RemoveTarget; why?: string } {
    const { kind, key } = parseChoiceValue(input.value);
    const folder = input.folder ? path.resolve(input.folder) : '';
    const fromPath = (p: string): { target?: RemoveTarget; why?: string } => {
        const file = path.resolve(p);
        const name = path.basename(file);
        if (!folder || path.dirname(file) !== folder) {
            return {
                why: `${name} is not in this extension's model folder (${input.folder || 'unknown'}), so it is not `
                    + 'ours to delete — remove it with the tool you downloaded it with.'
            };
        }
        return { target: { file, name, specId: input.specs.find((s) => s.fileName === name)?.id } };
    };

    if (kind === 'bundled') {
        const spec = input.specs.find((s) => s.id === key);
        if (!spec) return { why: `The chosen model (${key}) is no longer in the model list.` };
        return fromPath(path.join(folder, spec.fileName));
    }
    if (kind === 'file' && key) return fromPath(key);
    if (kind === 'lms') {
        return {
            why: `${key} belongs to LM Studio — this extension is only a remote control for it, so its library `
                + 'is LM Studio\'s to delete (My Models), not ours.'
        };
    }
    // `llama:` · `any:` · `custom:` — a server entry. Its weights are the file the settings pin, and after a
    // Load that is usually one this extension downloaded: the case the report was about.
    const served = input.ownServedPath || input.pinnedModelPath || '';
    if (!served) {
        return {
            why: 'That entry is an address rather than a downloaded model, so there is no file of ours behind it. '
                + 'Pick a downloaded model — or a server entry whose .gguf lives in this extension\'s storage.'
        };
    }
    return fromPath(served);
}

/** What the panel needs in order to grey the button out and explain itself (2026-09-17). */
export function removeAdvice(input: Parameters<typeof resolveRemoveTarget>[0]): { allowed: boolean; hint: string } {
    const resolved = resolveRemoveTarget(input);
    if (resolved.target) return { allowed: true, hint: `Deletes ${resolved.target.name} from disk.` };
    return { allowed: false, hint: resolved.why ?? 'There is nothing here for Remove Model to delete.' };
}

export async function confirmAndRemoveModel(context: vscode.ExtensionContext, value: string): Promise<{ ok: boolean; message?: string }> {
    const cfg = configView(SETTINGS);
    const own = ownLlamaServerStatus();
    const resolved = resolveRemoveTarget({
        value,
        specs: allModelSpecs(),
        folder: modelFolder(context),
        pinnedModelPath: cfg.get<string>('modelPath', ''),
        ownServedPath: own.running ? own.info?.modelPath : undefined
    });
    if (!resolved.target) {
        // Logged on purpose: the report that produced this resolver had *nothing* in the log for the attempt,
        // because refusing was the one path that told nobody anything except the user's own eye.
        aiLog(context, `Remove Model refused (${value || 'nothing selected'}): ${resolved.why ?? 'unknown reason'}`);
        return { ok: false, message: resolved.why };
    }
    const { file, name } = resolved.target;
    if (!fs.existsSync(file)) {
        aiLog(context, `Remove Model: ${name} is not on disk`);
        return { ok: false, message: `${name} is not on disk — there is nothing to remove.` };
    }

    // "Confirm Removal" warning — the panel never deletes without this host-side answer. The path is in it
    // because one file name can exist in two folders, and this is the last moment to notice.
    const confirmed = await vscode.window.showWarningMessage(
        `Remove ${name} from disk?\n\n${file}\n\nIt will re-download the next time you press Load Model. This cannot be undone.`,
        { modal: true }, 'Remove', 'Cancel'
    );
    if (confirmed !== 'Remove') {
        aiLog(context, `Remove Model cancelled for ${name}`);
        return { ok: false, message: 'removal cancelled' };
    }

    const backend = cfg.get<string>('backend', 'off');
    const modelPath = cfg.get<string>('modelPath', '');
    const pinned = !!modelPath && path.resolve(modelPath) === file;
    const isActive = pinned && backend !== 'off';

    // A running runtime holds this file open (and Windows locks files that are in use), so the one that is
    // serving it is stopped first — the built-in runtime, and this window's own llama-server when that is what
    // serves the file. Best-effort: a delete that works anyway is not a failure because a stop did not.
    if (isActive && bundledRuntimeRunning().running) { try { stopModelServer(); } catch { /* best-effort */ } }
    if (own.running && own.info && path.resolve(own.info.modelPath) === file) {
        try { stopOwnLlamaServer(); } catch { /* best-effort */ }
    }
    // Only files that are really gone count. `unlinkSync` fails when another process holds the file open —
    // exactly the case the unload above is meant to prevent, and one a silent `catch` would turn into a
    // cheerful "removed" for a 7 GB file that is still there (found out only at the next download).
    const kept: string[] = [];
    for (const p of [file, `${file}.part`, `${file}.verified`]) {
        try { fs.unlinkSync(p); } catch { /* already gone — e.g. another tab removed it first */ }
        if (fs.existsSync(p)) kept.push(path.basename(p));
    }
    if (kept.length) {
        aiLog(context, `Remove failed — still on disk: ${kept.join(', ')}`);
        return {
            ok: false,
            message: `${kept.join(', ')} could not be deleted. A runtime may still hold the file open — ` +
                'press Unload, then try again.'
        };
    }
    // The loaded model is gone: drop the pin so the picker returns to "— choose a model —" instead of
    // leaving a selection that names a file which no longer exists. AI stays on; only the selection resets.
    // `configView.update` writes to the scope that already owns the value (2026-09-15), so no target here.
    if (isActive) {
        await cfg.update('modelPath', '');
        await cfg.update('model', '');
    }
    aiLog(context, `Removed model file from disk: ${name}`);
    return { ok: true, message: `${name} removed. It will re-download on next Load Model.` };
}

/** What the panel's Save sends. The same shape a load carries, read through the same type. */
export type AiSettingsInput = PanelAiRequest;

/**
 * Saves the AI choices. **Switching off unloads the model**, which is the point of a switch that says
 * "no AI": leaving 17 GB of weights resident after the user turned the feature off would be a strange
 * thing to do to their machine.
 *
 * The load options are stored as settings even though they only matter at load time, so the panel can say
 * "reload to apply" instead of silently ignoring a change.
 */
export async function saveAiSettings(input: PanelAiRequest): Promise<void> {
    const cfg = configView(SETTINGS);
    const target = vscode.ConfigurationTarget.Global;
    // Written before the switch is looked at: whether a diff is shown is a preference about *reviewing*,
    // not about whether AI is on, so it must stick even while the feature is switched off (2026-09-16).
    await cfg.update('showDiff', input.showDiff !== false, target);
    // Same reasoning for the house rules: they describe the developer's code, not this switch.
    if (input.conventions !== undefined) {
        await cfg.update('conventions', parseConventionsText(input.conventions), target);
    }
    await cfg.update('maxTokens', Math.min(16384, Math.max(64, Math.round(input.maxTokens) || 4096)), target);
    await cfg.update('timeoutSeconds', Math.min(600, Math.max(5, Math.round(input.timeoutSeconds) || 60)), target);
    await cfg.update('loadContextLength', Math.max(0, Math.round(input.contextLength) || 0), target);
    await cfg.update('loadGpu', /^(auto|off|max|0\.\d+)$/.test(input.gpu) ? input.gpu : 'auto', target);
    await cfg.update('loadTtlSeconds', Math.max(0, Math.round(input.ttlSeconds) || 0), target);
    if (input.enabled) {
        const { kind } = parseChoiceValue(input.value);
        // The kind decides which setting owns the answer: `model` for a server, `modelPath` for a file.
        if (kind === 'bundled' || kind === 'file') {
            await cfg.update('backend', 'bundled', target);
        } else if (kind === 'llama') {
            // The address *and* the model id belong to the process that was started, so Save only states the
            // backend. Blanking `model` here is exactly what the "any" entry used to do to a model nobody had
            // chosen (2026-09-15) — and doing it to a running llama-server would unpin the model it reports.
            await cfg.update('backend', 'external', target);
        } else if (kind === 'any') {
            // "Let the server decide" must stay that way — writing a model key here is what pinned a model the
            // user never chose.
            await cfg.update('backend', 'external', target);
            await cfg.update('model', '', target);
        } else {
            await cfg.update('backend', 'external', target);
            await cfg.update('model', kind === 'lmstudio' ? parseChoiceValue(input.value).key : '', target);
            if (kind === 'custom' && /^https?:\/\/\S+$/i.test(input.endpoint)) {
                await cfg.update('endpoint', input.endpoint.trim(), target);
            }
        }
        await vscode.commands.executeCommand('setContext', 'rustyPlatform.aiEnabled', true);
        log(`AI assist enabled (${input.value || 'no model chosen yet'})`);
        return;
    }
    await cfg.update('backend', 'off', target);
    await vscode.commands.executeCommand('setContext', 'rustyPlatform.aiEnabled', false);
    const unloaded = await unloadAll();
    log(`AI assist disabled — model unloaded${unloaded.ok ? '' : ` (${unloaded.message})`}`);
}

/** "Scan machine for models…" — bounded, and it never throws at the panel. */
export async function scan(webview: vscode.Webview, onDone: (state: PanelState) => Promise<void>): Promise<void> {
    scanned = await scanForModelFiles({
        onProgress: (message) => progress(message, webview),
        roots: undefined
    });
    // Whether to *show* the ones inside LM Studio's folder is `filesOfferedForSelection`'s decision, not the
    // scanner's — so the count says what was found, not what was hidden.
    progress(
        scanned.length
            ? `found ${scanned.length} model file(s) on this machine`
            : 'no model files found on this machine',
        webview
    );
    await onDone(await panelState());
}

/**
 * Where progress goes, and which panels to keep in step.
 *
 * Every open panel is kept, not just the last one that spoke: a designer tab that is not active hears nothing,
 * so its AI section keeps the state from whenever it was opened — the picker showing "Let the server decide"
 * while another tab had loaded a model, and the same panel showing a dropdown that never followed the load the
 * user had just performed (reported 2026-09-15).
 */
let progressTarget: vscode.Webview | undefined;
let currentPanel: vscode.WebviewPanel | undefined;
const openPanels = new Set<vscode.WebviewPanel>();

/** The last line posted, so the elapsed-time ticker can keep showing it with a growing counter. */
let lastProgress = '';
let progressTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Reports progress **and keeps reporting it**: a step that takes minutes (a download, the first NuGet
 * build, a model load) used to sit on one stale line, which the user read as "nothing further happens"
 * even while work was in flight. The ticker re-posts the same message with the seconds spent, and any new
 * message replaces it.
 */
export function progress(message: string, webview?: vscode.Webview): void {
    lastProgress = message;
    if (webview) {
        void webview.postMessage({ type: 'aiProgress', message });
    } else if (openPanels.size) {
        // No explicit target: every open panel shows the same line, so a load started in one tab is visible in
        // the others too instead of leaving them with a line that never changes.
        for (const panel of openPanels) void panel.webview.postMessage({ type: 'aiProgress', message });
    } else if (progressTarget) {
        void progressTarget.postMessage({ type: 'aiProgress', message });
    }
    if (progressTimer) return;
    progressTimer = setInterval(() => {
        const still = progressTarget;
        if (!still || !lastProgress) return;
        const seconds = Math.round((Date.now() - progressStarted) / 1000);
        const line = `${lastProgress}  (${seconds} s)`;
        for (const panel of openPanels) void panel.webview.postMessage({ type: 'aiProgress', message: line });
    }, 2000);
}

let progressStarted = Date.now();

export function stopProgress(): void {
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = undefined;
    lastProgress = '';
}

/** Restarts the elapsed-time clock (called when a new load begins). */
export function resetProgressClock(): void {
    progressStarted = Date.now();
}

/**
 * A line in the extension's own log file, for the failures that cannot be reproduced from here.
 *
 * "Downloading is not starting … nothing further happens" is exactly the kind of report that needs the
 * other end's log, and the Output channel is not something a user can hand over. Best-effort: a broken log
 * must never break a load.
 */
export function aiLogFile(context: vscode.ExtensionContext): string {
    const dir = path.join(context.globalStorageUri.fsPath, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'ai.log');
}

export function aiLog(context: vscode.ExtensionContext, line: string): void {
    // The file sink lives in the logger now, so `log` and `aiLog` land in the same place: the AI client's own
    // lines (requests, answers, failures) used to reach the Output channel only, which is exactly the half a
    // bug report cannot hand over.
    mirrorLogTo(aiLogFile(context));
    log(line);
}

export function attachPanel(panel: vscode.WebviewPanel | undefined): void {
    currentPanel = panel;
    progressTarget = panel?.webview;
    if (!panel) return;
    if (!openPanels.has(panel)) {
        openPanels.add(panel);
        // Pruned on dispose so a closed designer tab cannot be posted to for the rest of the session.
        try { panel.onDidDispose(() => openPanels.delete(panel)); } catch { /* already gone */ }
    }
}

/** Every designer tab that is open, so a broadcast can reach all of them. */
export function panelsFor(): vscode.WebviewPanel[] {
    return [...openPanels];
}

export function panelFor(): vscode.WebviewPanel | undefined {
    return currentPanel;
}

/**
 * Re-sends the panel its state, if a panel is open.
 *
 * The state it draws is not only the settings: an LM Studio model can enter memory *outside* the panel — a
 * request loads it just-in-time — and the panel has no way to hear about that. Refreshing after a request,
 * and when the panel regains focus, is what keeps `● loaded` and the "in memory" hint true instead of a
 * snapshot from whenever the panel was opened (reported 2026-09-15: "as soon as a task is assigned the model
 * is marked as loaded" while the panel still said it was not).
 *
 * Never throws: it is called from paths where a failed refresh must not become a failed action. It reaches
 * **every** open panel, including designer tabs that are not the active one.
 */
export async function refreshAiState(): Promise<void> {
    if (!openPanels.size) return;
    try {
        const state = await panelState();
        for (const panel of openPanels) void panel.webview.postMessage({ type: 'aiState', state });
    } catch {
        /* the panel may be mid-dispose — a refresh is never worth an error */
    }
}
