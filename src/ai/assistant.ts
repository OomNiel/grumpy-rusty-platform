/* Local AI assist — the model-agnostic core.
 *
 * The feature has to work for a developer who has **no** AI at all: no Copilot, no cloud key, no local
 * server. That means the model runtime eventually ships with the extension (see NOTES.md §90), so this
 * module deliberately knows nothing about *who* serves the endpoint — only the OpenAI-compatible chat
 * shape every local runtime speaks (LM Studio, Ollama, llama.cpp's `llama-server`, and later our own
 * bundled runtime). Tier 1 talks to a server the developer already runs; the same code then talks to
 * the bundled one.
 *
 * Three rules shaped the design:
 *
 *  1. **The model edits exactly one method.** Every prompt asks for the *complete replacement of the
 *     method the caret is in*, and nothing else. A small model that is asked to "fix my file" will
 *     rewrite half of it; a model asked to return one function is graded by `cargo check` in seconds.
 *  2. **Output is parsed defensively.** Small models wrap answers in prose, fence them twice, or echo
 *     the input first, so `extractCode` takes the LAST fenced block (the answer, not the echo) and
 *     falls back to a JSON `{"code": …}` shape.
 *  3. **Nothing is applied without a diff.** This module returns text; `assistantUi.ts` shows the diff
 *     and the developer decides. The deterministic checker keeps owning the structural fixes — the
 *     model is for the semantic ones it cannot express as a rule (fill this handler in, make this
 *     error go away).
 *
 * Everything here is pure or injectable, so the test suite covers it without a model: prompts, the
 * parsers, the span maths and the client (against a throwaway local HTTP server).
 */

import * as fs from 'fs';
import * as os from 'os';

// The window the bundled runtime is started with by default — the number `contextForBudget` grows when the
// answer budget needs more room.
import { DEFAULT_CONTEXT_SIZE, sidecarBackend, type SidecarBackend } from './modelSpecs';

/** How the assistant gets its model. `bundled` = the extension builds and runs its own local server. */
export type AssistantBackend = 'off' | 'external' | 'bundled';

/** The settings shape after normalisation (see `normalizeAssistantConfig`). */
export interface AssistantConfig {
    /**
     * The switch: true means the assistant is on.
     *
     * Off is the default and it means *off* — a window that starts with the switch down unloads the models and
     * stops the llama-server rather than merely refusing to start one (see `ai/assistantSwitch.ts`). It is a
     * setting of its own rather than a reuse of `backend` because "which backend" and "on or off" are separate
     * questions: turning the switch off must remember what to turn back on.
     */
    enabled: boolean;
    /**
     * Whether a window that starts with the switch off enforces that.
     *
     * On by default — the switch says off, and a seventeen-gigabyte server still running is not what off
     * means — but switchable, because someone who runs their own llama-server for other work does not want an
     * editor stopping it at every launch. The panel puts this next to the switch; stopping a server the window
     * did not start still asks first, once per window.
     */
    stopServersAtStartup: boolean;
    backend: AssistantBackend;
    /** Base URL of an OpenAI-compatible API, e.g. `http://127.0.0.1:1234/v1`. For `bundled` the
     *  runtime fills this in at request time — the request shape is identical either way. */
    endpoint: string;
    /** Model id to request. Empty = let the server pick (`/models` order). */
    model: string;
    /** `.gguf` file for the bundled runtime (set by "AI: Set Up Local Model…"). */
    modelPath: string;
    /** Threads for the bundled runtime; 0 = choose automatically. */
    threads: number;
    /**
     * Context window handed to the bundled runtime (`--ctx`). LM Studio models get theirs from `lms load`
     * instead — this is the built-in runtime's own copy of the same decision.
     */
    contextSize: number;
    /** Layers offloaded to the GPU by the bundled runtime (`--gpu-layers`). 0 = CPU only. */
    gpuLayers: number;
    /**
     * Which native build of the bundled runtime to run — `cpu` (the default) or `vulkan` (2026-09-16).
     *
     * The choice is a request, not a guarantee: the runtime reports back what llama.cpp actually loaded,
     * which is how "Vulkan" cannot end up on screen for a model that is running on the CPU.
     */
    bundledBackend: SidecarBackend;
    timeoutSeconds: number;
    maxTokens: number;
    temperature: number;
    /**
     * Show the model's code as a diff before it is applied.
     *
     * On by default, because a small model's answer is a *proposal* and a diff is how it is reviewed
     * (2026-09-14). Switched off, the same code is written straight into the file: the deterministic
     * rules still run first — a name that already exists is refused, the visibility is corrected — and
     * the write is a normal edit, so Ctrl+Z undoes it (asked 2026-09-16).
     */
    showDiff: boolean;
}

/** Raw settings as they come out of the manifest (every field possibly undefined/wrong-typed). */
export interface RawAssistantSettings {
    enabled?: unknown;
    stopServersAtStartup?: unknown;
    backend?: unknown;
    endpoint?: unknown;
    model?: unknown;
    modelPath?: unknown;
    threads?: unknown;
    contextSize?: unknown;
    gpuLayers?: unknown;
    bundledBackend?: unknown;
    timeoutSeconds?: unknown;
    maxTokens?: unknown;
    temperature?: unknown;
    showDiff?: unknown;
}

/** LM Studio's default port — the most likely local server, and what the docs point at. */
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:1234/v1';

/** A method longer than this is refused: it will not fit the budget of a small local model. */
export const MAX_METHOD_LINES = 120;

/** Total RAM the bundled runtime needs to be worth offering at all (Tier 2 gate). */
export const MIN_RAM_GB = 8;
/** Where a 3B-class model at Q4 has room to breathe. */
export const GOOD_RAM_GB = 16;

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Clamp a number setting, tolerating strings (settings UI, JSON round-trips) and junk. */
function num(v: unknown, fallback: number, min: number, max: number): number {
    const n = typeof v === 'string' ? Number(v) : v;
    if (!isFiniteNumber(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/** `http://host:port` → `http://host:port/v1`; keeps anything already ending in `/v1`. */
export function normalizeEndpoint(endpoint: string): string {
    const trimmed = String(endpoint || '').trim().replace(/\/+$/, '');
    if (!trimmed) return DEFAULT_ENDPOINT;
    return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * The last model that actually answered, and where — the fact that lets the panel stop claiming the weights
 * are not loaded (reported 2026-10-31: after a whole working conversation the status line still read *"not in
 * memory yet; the next request loads it"*).
 *
 * WHY A RECORD RATHER THAN THE DISCOVERY. `Discovery.loaded` is what LM Studio says it holds, and nothing
 * else knows about it: a `llama-server`, a server another window started, or any OpenAI-compatible endpoint
 * the user runs themselves can be answering perfectly while that list is empty — and even LM Studio's own list
 * is read through a 15 s cache. An answer from the pinned model at the pinned address is the stronger fact,
 * and it costs nothing to keep.
 */
export interface AnsweredModel {
    /** Normalised, so `http://127.0.0.1:1234` and `.../v1` are the same server. */
    endpoint: string;
    model: string;
}

let lastAnswered: AnsweredModel | undefined;

/** Records that `model` answered a request at `endpoint`. Called by `chatDetailed` for every reply. */
export function noteModelAnswered(endpoint: string, model: string): void {
    const id = String(model ?? '').trim();
    // No pinned id means "the server decides", and then there is no name to make a claim about.
    if (!id) return;
    lastAnswered = { endpoint: normalizeEndpoint(endpoint), model: id };
}

/** Whether `model` has answered at `endpoint` in this session. Matching tolerates the qualifier suffixes. */
export function answeredHere(endpoint: string, model: string): boolean {
    const id = String(model ?? '').trim();
    if (!lastAnswered || !id) return false;
    if (lastAnswered.endpoint !== normalizeEndpoint(endpoint)) return false;
    return lastAnswered.model === id || lastAnswered.model.endsWith(id) || id.endsWith(lastAnswered.model);
}

/**
 * Turns whatever the settings hold into a usable configuration. Pure on purpose: the manifest, the
 * UI and the tests all funnel through here, so "what does backend X mean" has one answer.
 */
export function normalizeAssistantConfig(raw: RawAssistantSettings): AssistantConfig {
    const backend: AssistantBackend =
        raw.backend === 'external' ? 'external' : raw.backend === 'bundled' ? 'bundled' : 'off';
    return {
        // Only an explicit `true` switches the assistant on: a missing setting is the documented default (off)
        // and junk must never look like consent to start a server.
        enabled: raw.enabled === true,
        // The other way round, like `showDiff`: only an explicit `false` turns the startup enforcement off,
        // because the default is the one the switch's own semantics imply.
        stopServersAtStartup: raw.stopServersAtStartup !== false,
        backend,
        endpoint: normalizeEndpoint(typeof raw.endpoint === 'string' ? raw.endpoint : DEFAULT_ENDPOINT),
        model: typeof raw.model === 'string' ? raw.model.trim() : '',
        modelPath: typeof raw.modelPath === 'string' ? raw.modelPath.trim() : '',
        threads: num(raw.threads, 0, 0, 32),
        contextSize: num(raw.contextSize, 4096, 512, 262144),
        gpuLayers: num(raw.gpuLayers, 0, 0, 999),
        // The default is the CPU build: a missing or misspelt setting must never turn into a GPU request
        // nobody made, and the CPU build is the one that needs nothing beyond cmake and a C++ compiler.
        bundledBackend: sidecarBackend(raw.bundledBackend ?? 'cpu'),
        timeoutSeconds: num(raw.timeoutSeconds, 60, 5, 600),
        maxTokens: num(raw.maxTokens, 4096, 64, 8192),
        temperature: num(raw.temperature, 0.2, 0, 1),
        // Only an explicit `false` turns the diff off: a missing setting, or anything unreadable, keeps
        // the safe default (review before writing).
        showDiff: raw.showDiff !== false
    };
}

/** True when the user has switched the feature on *and* there is somewhere to send requests: either a
 *  server they pointed at, or the bundled runtime that fills the endpoint in itself. */
export function assistantEnabled(cfg: AssistantConfig): boolean {
    // The switch comes first: an assistant that is off does not answer, whatever backend is configured.
    if (!cfg.enabled) return false;
    if (cfg.backend === 'off') return false;
    if (cfg.backend === 'bundled') return true;
    return cfg.endpoint.length > 0;
}

/**
 * Heuristic: an embedding model cannot answer a chat request, and local servers happily list them next
 * to the chat models (LM Studio ships `text-embedding-nomic-embed-text-v1.5` alongside real ones). Only
 * the obvious names are flagged — this drives a *hint*, never a hard filter, so a false positive costs a
 * word in a dialog and nothing else.
 */
export function looksLikeEmbeddingModel(id: string): boolean {
    return /(^|[^a-z])(embed|bge|gte|e5)([^a-z]|$)/i.test(id);
}

/**
 * The `Model:` line of the status dialog.
 *
 * "(the server decides)" is technically true and practically useless — on a server with exactly one
 * model loaded the answer is known, and on a server with several the developer needs to know that
 * setting `model` is what pins one down (Ollama, in particular, refuses an unnamed request). Pure, so
 * every branch is asserted in the suite rather than being discovered in a dialog. Pass the *chat* models
 * (see `looksLikeEmbeddingModel`) so the counts match what can actually answer.
 */
export function describeModel(
    cfg: Pick<AssistantConfig, 'backend' | 'model' | 'modelPath'>,
    probe?: { ok: boolean; models: { id: string }[] }
): string {
    const fileName = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p;
    if (cfg.backend === 'bundled') {
        return cfg.modelPath
            ? `Model: ${fileName(cfg.modelPath)} (bundled runtime)`
            : 'Model: none yet — run "AI: Set Up Local Model…"';
    }
    if (cfg.model) return `Model: ${cfg.model} (asked for by name)`;
    if (probe?.ok && probe.models.length === 1) {
        return `Model: ${probe.models[0]?.id ?? '?'} (the only chat model the server offers)`;
    }
    if (probe?.ok && probe.models.length > 1) {
        return `Model: (the server picks one of ${probe.models.length} chat models — set "model" to pin it down)`;
    }
    if (probe?.ok) return 'Model: (no chat model offered — only embeddings, which cannot answer)';
    if (probe && !probe.ok) return 'Model: (not known yet — the server is not answering)';
    return 'Model: (the server decides)';
}

/**
 * What is in memory *right now* — the question the settings cannot answer, and the one that made an unloaded
 * model look loaded (reported 2026-09-15: after Unload "the picker is not updated and the status check still
 * shows that model as being loaded").
 *
 * "Asked for by name" describes the *next* request; this describes *this moment*. Both are reported because
 * they disagree exactly when it matters — right after an unload — and one line without the other is
 * ambiguous in a way a developer notices and a log does not.
 *
 * `undefined` for the bundled backend (its runtime reports itself in `bundledStatusLines`) so the caller
 * never has to phrase a sentence it has no facts for.
 */
export function describeLoadedNow(
    cfg: Pick<AssistantConfig, 'backend' | 'model'>,
    loaded: string[]
): string | undefined {
    if (cfg.backend !== 'external') return undefined;
    const short = (id: string) => id.replace(/\\/g, '/').split('/').pop() ?? id;
    if (!loaded.length) {
        return cfg.model
            ? `Loaded now: nothing — the next request loads ${short(cfg.model)} first.`
            : 'Loaded now: nothing — the next request makes the server load one.';
    }
    const names = loaded.map(short).join(', ');
    // A pin may be qualified where the running id is not, or the reverse ("google/gemma-4-e4b" vs
    // "gemma-4-e4b") — same model, and comparing the short forms is what makes that true.
    if (!cfg.model || loaded.some((id) => id === cfg.model || short(id) === short(cfg.model))) {
        return `Loaded now: ${names}`;
    }
    return `Loaded now: ${names} — not ${short(cfg.model)}, which is what the next request asks for.`;
}

// ---------------- hardware ----------------

/** Facts about the machine, read once and passed around (so the verdict is testable). */
export interface HardwareFacts {
    arch: string;
    cpuCount: number;
    totalRamGb: number;
    freeRamGb: number;
    /** AVX2 is the practical floor for llama.cpp on x86-64 — without it a 3B model crawls. */
    hasAvx2: boolean;
    /** `null` when it could not be determined (non-Linux, unreadable /proc). */
    platform: string;
}

export interface HardwareAssessment {
    /** False = do not offer local inference at all (the caller hides/disables the feature). */
    ok: boolean;
    level: 'none' | 'minimal' | 'good';
    /** One line per reason, ready to show in the status message. */
    reasons: string[];
}

/**
 * Decides whether this machine can run a small model *in system RAM* (no VRAM assumption — that is the
 * requirement the feature was specced with). Pure: `readHardwareFacts()` supplies the numbers.
 */
export function assessHardware(f: HardwareFacts): HardwareAssessment {
    const reasons: string[] = [];
    let ok = true;

    if (f.arch !== 'x64' && f.arch !== 'arm64') {
        ok = false;
        reasons.push(`CPU architecture "${f.arch}" is not supported (x64 or arm64 required).`);
    }
    if (f.arch === 'x64' && !f.hasAvx2) {
        ok = false;
        reasons.push('The CPU has no AVX2 instructions — local inference would be too slow to use.');
    }
    if (f.cpuCount < 4) {
        ok = false;
        reasons.push(`Only ${f.cpuCount} CPU threads — a small model needs at least 4.`);
    }
    if (f.totalRamGb < MIN_RAM_GB) {
        ok = false;
        reasons.push(`Only ${f.totalRamGb.toFixed(1)} GB of RAM — ${MIN_RAM_GB} GB is the minimum.`);
    } else if (f.freeRamGb < 3.5) {
        ok = false;
        reasons.push(
            `Only ${f.freeRamGb.toFixed(1)} GB of RAM is free right now — free at least 3.5 GB ` +
            '(close some applications) and try again.'
        );
    }

    if (!ok) {
        if (reasons.length === 0) reasons.push('This machine cannot run a local model.');
        return { ok: false, level: 'none', reasons };
    }

    const good = f.totalRamGb >= GOOD_RAM_GB && f.cpuCount >= 8 && f.freeRamGb >= 6;
    if (!good) {
        reasons.push(
            `Running at the minimum: ${f.totalRamGb.toFixed(0)} GB RAM, ${f.cpuCount} threads — ` +
            'expect slow (10-30 s) answers and use the smallest model.'
        );
    } else {
        reasons.push(`${f.totalRamGb.toFixed(0)} GB RAM, ${f.cpuCount} threads, ${f.arch}: fine for a 3B-class model.`);
    }
    return { ok: true, level: good ? 'good' : 'minimal', reasons };
}

/** Reads the machine facts. Linux-first (the feature ships there first), degrading gracefully. */
export function readHardwareFacts(): HardwareFacts {
    const cpus = os.cpus();
    let hasAvx2 = false;
    try {
        // One read, no shell: /proc/cpuinfo lists the CPU flags the kernel advertised.
        hasAvx2 = /(^|\s)avx2(\s|$)/m.test(fs.readFileSync('/proc/cpuinfo', 'utf8'));
    } catch {
        // Not Linux (or unreadable): fall back to "assume yes" on a 64-bit CPU rather than blocking
        // the feature on a machine that may well be fine.
        hasAvx2 = process.arch === 'x64' || process.arch === 'arm64';
    }
    const totalRamGb = os.totalmem() / 1024 ** 3;
    const freeRamGb = os.freemem() / 1024 ** 3;
    return {
        arch: process.arch,
        cpuCount: cpus.length,
        totalRamGb,
        freeRamGb,
        hasAvx2,
        platform: process.platform
    };
}

// ---------------- the client ----------------

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface ServerModelInfo {
    id: string;
}

export interface ProbeResult {
    ok: boolean;
    models: ServerModelInfo[];
    error?: string;
}

/** Minimal shape of `fetch` we depend on — declared locally so the client stays injectable. */
export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
    body?: unknown;
    json(): Promise<unknown>;
}>;

function defaultFetch(): FetchLike {
    const f = (globalThis as { fetch?: unknown }).fetch;
    if (typeof f !== 'function') throw new Error('This VS Code build has no fetch() — update VS Code.');
    return f as FetchLike;
}

/**
 * Is this failure "nothing is listening there"?
 *
 * Exported because three places have to agree on it: the sentence below, the hint in `localModels` that names
 * what *is* answering, and the rescue that starts a llama-server and retries (2026-10-04). A second copy of
 * the regex would let one of them stop recognising the failure the other two are built around.
 */
export function isNoAnswerError(message: string): boolean {
    const text = String(message ?? '');
    // Both wordings, because the caller of this predicate sees the *sentence*, not the socket: `chatDetailed`
    // throws `describeError`'s text ("No server answered at …"), which no longer contains the raw
    // `ECONNREFUSED`. Recognising only the raw form would have left the rescue unreachable — found by the
    // test below, which is why it asserts on the sentence as well as on the error.
    return /ECONNREFUSED|fetch failed/i.test(text) || /no server answered/i.test(text);
}

/**
 * A failure in the words the user needs.
 *
 * `endpoint` is printed **in the message** and not only in the log, because the 2026-10-04 report was exactly
 * this failure with no address in it: *"Ready. Using the llama-server already running on port 8080"*, then a
 * prompt that answered "No server answered — is the local model server running (and the endpoint correct)?"
 * with nothing saying **which** address it had asked. The answer was in the settings (a stale form had
 * overwritten port 8080 with LM Studio's 1234), and the message made the user hunt for it.
 */
export function describeError(err: unknown, endpoint?: string): string {
    const msg = err instanceof Error ? err.message : String(err);
    const at = endpoint ? ` at ${endpoint}` : '';
    const to = endpoint ? ` to ${endpoint}` : '';
    if (isNoAnswerError(msg)) {
        return `No server answered${at} — is the local model server running (and the endpoint correct)?`;
    }
    if (/aborted|abort/i.test(msg)) return `The request${to} was cancelled or timed out.`;
    return msg;
}

/** `GET /models` — used to verify an endpoint and to offer the model list. */
export async function probeServer(
    cfg: AssistantConfig,
    opts: { timeoutMs?: number; fetchImpl?: FetchLike } = {}
): Promise<ProbeResult> {
    const timeoutMs = opts.timeoutMs ?? 2500;
    const doFetch = opts.fetchImpl ?? defaultFetch();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await doFetch(`${cfg.endpoint}/models`, { signal: controller.signal });
        if (!res.ok) return { ok: false, models: [], error: `The server answered HTTP ${res.status}.` };
        const body = (await res.json()) as { data?: { id?: unknown }[] };
        const models = (body.data ?? [])
            .map((m) => (typeof m.id === 'string' ? { id: m.id } : undefined))
            .filter((m): m is ServerModelInfo => !!m);
        return { ok: true, models };
    } catch (err) {
        return { ok: false, models: [], error: describeError(err, cfg.endpoint) };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * One streamed chunk, as far as this extension cares about it. Pure.
 *
 * `reasoning` exists because thinking models put their chain of thought in its own field. Measured
 * 2026-09-15 against LM Studio with `qwen/qwen3.5-9b`: a one-method request spent **837 reasoning
 * tokens** (3 186 characters) before writing a 71-character answer, and with a 900-token budget it
 * produced `finish_reason: length` and **nothing else** — which is what "0 characters" was. Reading the
 * field is what makes that explicable instead of silent.
 */
export interface SseChunk {
    /** The answer text. */
    content?: string;
    /** The model's thinking, when it thinks. Never used as code — always kept as evidence. */
    reasoning?: string;
    /** `stop` when it finished on its own, `length` when the token budget ran out. */
    finishReason?: string;
    /** Token counts, when the server reports them. */
    usage?: { promptTokens?: number; completionTokens?: number; reasoningTokens?: number };
}

/**
 * Parses one SSE line into everything it carries. Streaming matters: the developer sees progress
 * instead of a frozen notification, and the inactivity watchdog is re-armed per chunk. Pure, so the
 * parser is tested directly against real captured chunks.
 */
export function parseSseChunk(line: string): SseChunk | undefined {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return undefined;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return undefined;
    try {
        const obj = JSON.parse(payload) as {
            choices?: { delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }; finish_reason?: unknown }[];
            usage?: {
                prompt_tokens?: unknown;
                completion_tokens?: unknown;
                completion_tokens_details?: { reasoning_tokens?: unknown };
            };
        };
        const choice = obj.choices?.[0];
        const delta = choice?.delta ?? {};
        const chunk: SseChunk = {};
        if (typeof delta.content === 'string' && delta.content) chunk.content = delta.content;
        // LM Studio uses `reasoning_content`, llama.cpp/vLLM also emit `reasoning`; either counts.
        const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
            : typeof delta.reasoning === 'string' ? delta.reasoning
                : '';
        if (reasoning) chunk.reasoning = reasoning;
        if (typeof choice?.finish_reason === 'string') chunk.finishReason = choice.finish_reason;
        if (obj.usage) {
            chunk.usage = {
                promptTokens: typeof obj.usage.prompt_tokens === 'number' ? obj.usage.prompt_tokens : undefined,
                completionTokens: typeof obj.usage.completion_tokens === 'number' ? obj.usage.completion_tokens : undefined,
                reasoningTokens: typeof obj.usage.completion_tokens_details?.reasoning_tokens === 'number'
                    ? obj.usage.completion_tokens_details.reasoning_tokens
                    : undefined
            };
        }
        return chunk.content || chunk.reasoning || chunk.finishReason || chunk.usage ? chunk : undefined;
    } catch {
        return undefined;
    }
}

/** The answer text of one SSE line — the narrow view of {@link parseSseChunk}. */
export function parseSseDelta(line: string): string | undefined {
    return parseSseChunk(line)?.content;
}

/** The text and the thinking out of a non-streaming `/chat/completions` body. Pure. */
export function parseChatCompletionFull(body: unknown): { text: string; reasoning: string } {
    const obj = body as {
        choices?: { message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }; text?: unknown }[];
    };
    const first = obj?.choices?.[0];
    const reasoning = typeof first?.message?.reasoning_content === 'string' ? first.message.reasoning_content
        : typeof first?.message?.reasoning === 'string' ? first.message.reasoning
            : '';
    if (typeof first?.message?.content === 'string') return { text: first.message.content, reasoning };
    if (typeof first?.text === 'string') return { text: first.text, reasoning };
    return { text: '', reasoning };
}

/** Pulls the full text out of a non-streaming `/chat/completions` body. Pure. */
export function parseChatCompletion(body: unknown): string {
    return parseChatCompletionFull(body).text;
}

/**
 * What a request is doing right now, for a progress line that answers "is it still working?".
 *
 * `promptTokens`/`contextSize` are the "how full is the window" pair: the bundled runtime reports the real
 * prompt count before it generates (it has just tokenized it), and the window is the one this extension
 * started it with. Against an external server neither is known, and the fields stay undefined rather than
 * showing a percentage of a window somebody else chose.
 */
export interface ChatProgress {
    /** `connecting` = the request is in flight; `waiting` = sent, nothing back yet; then thinking/writing. */
    phase: 'connecting' | 'waiting' | 'thinking' | 'streaming';
    /** Answer pieces received. Local runtimes send about one per token, which is what makes this a count. */
    tokens: number;
    /** Answer characters received. */
    characters: number;
    /** Characters of the model's own thinking, when it thinks. */
    reasoningChars: number;
    elapsedMs: number;
    /** Milliseconds since anything arrived — the number that says the model is still alive. */
    sinceLastChunkMs: number;
    /** How long the model spent before its first piece (prompt processing). */
    firstTokenMs?: number;
    /** Prompt tokens, when the server reported them. */
    promptTokens?: number;
    /** The window the request has to fit in, when it is ours to know. */
    contextSize?: number;
}

/** How long the model has actually been writing: since its first piece, or since the request if none has. */
function firstTokenMsOr(p: ChatProgress): number {
    return p.firstTokenMs !== undefined ? Math.max(0, p.elapsedMs - p.firstTokenMs) : p.elapsedMs;
}

/** Seconds, one decimal while it matters, whole seconds once it stops being a stopwatch. */
function seconds(ms: number): string {
    return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

/**
 * One line of "what is happening", for a progress notification or a chat status row.
 *
 * The numbers answer the two questions a waiting developer actually has: *is it alive?* (elapsed time, and
 * how long since anything arrived) and *how far in is it?* (pieces written, and how much of the window the
 * prompt already took). Pure, so every branch is pinned by the suite rather than by a screenshot.
 */
export function describeProgress(p: ChatProgress): string {
    const context = p.promptTokens !== undefined && p.contextSize
        ? ` · context ${Math.min(100, Math.round((p.promptTokens / p.contextSize) * 100))}% (${p.promptTokens}/${p.contextSize})`
        : '';
    if (p.phase === 'connecting') return `Asking the model… (${seconds(p.elapsedMs)})`;
    if (p.phase === 'waiting') {
        return p.firstTokenMs === undefined && p.reasoningChars === 0
            ? `The model is reading the prompt… (${seconds(p.elapsedMs)})${context}`
            : `Thinking… (${seconds(p.elapsedMs)})${context}`;
    }
    if (p.phase === 'thinking') {
        return `Thinking… ${p.reasoningChars} characters of reasoning (${seconds(p.elapsedMs)})${context}`;
    }
    // The rate is measured from the first token, not from the request: a 3 s prompt read followed by 42
    // tokens in 3.2 s is 13 tokens/s of generation, and dividing by the whole 6.2 s would report 6.8 — a
    // number that makes a perfectly fast model look slow for the rest of the answer.
    const generatingMs = firstTokenMsOr(p);
    const rate = generatingMs >= 250 && p.tokens > 0
        ? ` · ${(p.tokens / (generatingMs / 1000)).toFixed(1)} tokens/s`
        : '';
    return `Writing… ${p.tokens} token${p.tokens === 1 ? '' : 's'}${rate} (${seconds(p.elapsedMs)})${context}`;
}

export interface ChatOptions {
    onToken?: (text: string) => void;
    /**
     * Called while the request runs — on every piece that arrives and on a half-second heartbeat, so a model
     * that is reading a long prompt still shows movement. The heartbeat is the point: without it, the gap
     * before the first token is indistinguishable from a hang.
     */
    onProgress?: (progress: ChatProgress) => void;
    /** Progress only: the model is still thinking (reasoning models). `chars` is the running total. */
    onReasoning?: (chars: number) => void;
    signal?: AbortSignal;
    fetchImpl?: FetchLike;
}

/** What a request produced — including the evidence needed to explain an empty answer. */
export interface ChatOutcome {
    text: string;
    /** The model's thinking, when it thinks. Never code, but never thrown away either: it is the only
     * explanation for an answer that never came. */
    reasoning: string;
    /** `stop` when it finished on its own, `length` when the token budget ran out. */
    finishReason?: string;
    completionTokens?: number;
    reasoningTokens?: number;
}

/**
 * Sends a chat request and returns the answer **and** the thinking behind it. Streams when the server
 * supports it (every local runtime does) and falls back to a single JSON read when it does not.
 *
 * `timeoutSeconds` is an **inactivity** budget, not a total one: the watchdog is re-armed every time
 * data arrives, so a 3B model on a CPU taking two minutes for a long method is fine while a server that
 * has stopped talking is caught in seconds. A total budget would have killed exactly the slow-but-busy
 * case this feature exists for — and a thinking model is busy while it thinks, so this is also what lets
 * a 27B reason for a minute without being killed.
 */
export async function chatDetailed(
    cfg: AssistantConfig,
    messages: ChatMessage[],
    opts: ChatOptions = {}
): Promise<ChatOutcome> {
    const doFetch = opts.fetchImpl ?? defaultFetch();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armWatchdog = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), cfg.timeoutSeconds * 1000);
    };
    armWatchdog();
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort);

    // Live progress. `tokens` counts pieces rather than asking the server, and that is deliberate: every
    // local runtime streams about one piece per token, and the alternative — counting only at the end — is
    // exactly the "is it doing anything?" this exists to answer.
    const startedAt = Date.now();
    let lastChunkAt = startedAt;
    let connected = false;
    let tokens = 0;
    let reasoningChars = 0;
    let firstTokenMs: number | undefined;
    // Only the bundled runtime's window is ours to know: we started it, with this context size. An external
    // server decides its own, so `describeProgress` shows no percentage rather than a made-up one.
    const contextSize = cfg.backend === 'bundled' ? cfg.contextSize : undefined;
    // A rough prompt size, so the percentage is there from the first tick and refined by the real count the
    // runtime sends once it has tokenized the prompt.
    let promptTokens: number | undefined = estimateTokens(messages.map((m) => m.content).join('\n'));
    // Declared before `tick`, which reads its length: calling `tick()` while this was still in its temporal
    // dead zone threw "Cannot access 'outcome' before initialization" and broke the request outright.
    const outcome: ChatOutcome = { text: '', reasoning: '' };
    const phaseOf = (): ChatProgress['phase'] =>
        !connected ? 'connecting' : tokens > 0 ? 'streaming' : reasoningChars > 0 ? 'thinking' : 'waiting';
    const tick = (): void => {
        const now = Date.now();
        opts.onProgress?.({
            phase: phaseOf(),
            tokens,
            characters: outcome.text.length,
            reasoningChars,
            elapsedMs: now - startedAt,
            sinceLastChunkMs: now - lastChunkAt,
            firstTokenMs,
            promptTokens,
            contextSize
        });
    };
    const heartbeat = setInterval(tick, 500);
    tick();
    const apply = (chunk: SseChunk | undefined, into: ChatOutcome) => {
        if (!chunk) return;
        if (chunk.content) {
            into.text += chunk.content;
            tokens += 1;
            firstTokenMs ??= Date.now() - startedAt;
            opts.onToken?.(chunk.content);
        }
        if (chunk.reasoning) {
            into.reasoning += chunk.reasoning;
            reasoningChars = into.reasoning.length;
            firstTokenMs ??= Date.now() - startedAt;
            opts.onReasoning?.(reasoningChars);
        }
        if (chunk.finishReason) into.finishReason = chunk.finishReason;
        if (chunk.usage?.promptTokens !== undefined) promptTokens = chunk.usage.promptTokens;
        if (chunk.usage?.completionTokens !== undefined) into.completionTokens = chunk.usage.completionTokens;
        if (chunk.usage?.reasoningTokens !== undefined) into.reasoningTokens = chunk.usage.reasoningTokens;
    };
    try {
        const res = await doFetch(`${cfg.endpoint}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                model: cfg.model || undefined,
                messages,
                temperature: cfg.temperature,
                max_tokens: cfg.maxTokens,
                stream: true,
                // Ask for the token counts in the closing chunk: the reasoning count is what turns "0
                // characters" into "837 of its 900 tokens went on thinking". A server that does not know
                // the field ignores it.
                stream_options: { include_usage: true }
            })
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`The server answered HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
        }
        connected = true;
        // The server took the request and is answering, so this model is the one in memory at this address —
        // whatever the model registry says (see `answeredHere`, and the status line it feeds).
        noteModelAnswered(cfg.endpoint, cfg.model);

        // The response is an SSE stream; read it chunk by chunk and hand every delta to the caller.
        const body = res.body as { getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | undefined;
        if (typeof body?.getReader !== 'function') {
            const full = parseChatCompletionFull(await res.json());
            if (full.text) opts.onToken?.(full.text);
            return { text: full.text, reasoning: full.reasoning };
        }

        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let raw = '';
        for (; ;) {
            const { done, value } = await reader.read();
            if (done) break;
            armWatchdog(); // data arrived: the server is alive, whatever its speed
            lastChunkAt = Date.now();
            const chunk = decoder.decode(value, { stream: true });
            raw += chunk;
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? ''; // the last line may be half-received
            for (const line of lines) apply(parseSseChunk(line), outcome);
        }
        buffer += decoder.decode();
        apply(parseSseChunk(buffer), outcome);
        tick();
        // A server that ignores `stream: true` sends one plain JSON body: no `data:` lines at all, so
        // nothing was accumulated and the answer is in the raw body.
        if (!outcome.text && !outcome.reasoning) {
            try {
                const full = parseChatCompletionFull(JSON.parse(raw));
                if (full.text || full.reasoning) {
                    if (full.text) opts.onToken?.(full.text);
                    return { ...outcome, text: full.text, reasoning: full.reasoning };
                }
            } catch {
                /* not JSON either — fall through with whatever arrived */
            }
        }
        return outcome;
    } catch (err) {
        throw new Error(describeError(err, cfg.endpoint));
    } finally {
        clearInterval(heartbeat);
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
    }
}

/** The answer text on its own, for callers that do not care how it was reached. */
export async function chat(
    cfg: AssistantConfig,
    messages: ChatMessage[],
    opts: ChatOptions = {}
): Promise<string> {
    return (await chatDetailed(cfg, messages, opts)).text;
}

/**
 * The prompt block for a passage the developer selected (asked 2026-10-31: *"enable the AI Assist model to be
 * able to read selected text in the active editor tab"*).
 *
 * WHY THE SELECTION LEADS AND THE WHOLE FILE DOES NOT FOLLOW. The chat sent the active file and nothing else,
 * clipped at 12 000 characters — so "why is this line wrong?" was answered about the top of the file, and the
 * line in question was exactly what the clip removed. A selection says what the question is about far more
 * precisely than a file does, so it comes first, with a numbered window either side for context.
 *
 * Numbers are kept because "the loop on line 14 never awaits" is an answer the developer can act on, and `»`
 * marks the selected lines so the model cannot mistake the window for the thing being asked about. Pure: the
 * caller passes the document's lines, which is what lets this be pinned by a test with no editor.
 */
export function selectionContext(
    path: string,
    lines: string[],
    selectedFrom: number,
    selectedTo: number,
    options: { around?: number; selectionLimit?: number; contextLimit?: number } = {}
): string {
    const around = options.around ?? 20;
    const selectionLimit = options.selectionLimit ?? 4000;
    const contextLimit = options.contextLimit ?? 2000;
    const total = Math.max(1, lines.length);
    const first = Math.min(Math.max(1, Math.trunc(selectedFrom)), total);
    const last = Math.min(Math.max(first, Math.trunc(selectedTo)), total);
    const clip = (text: string, limit: number, what: string): string =>
        text.length > limit ? `${text.slice(0, limit)}\n// … (${what} clipped at ${limit} characters)` : text;
    const from = Math.max(1, first - around);
    const to = Math.min(lines.length, last + around);
    const numbered: string[] = [];
    for (let line = from; line <= to; line += 1) {
        const marked = line >= first && line <= last;
        numbered.push(`${marked ? '»' : ' '} ${String(line).padStart(4, ' ')}: ${lines[line - 1] ?? ''}`);
    }
    const range = first === last ? `${first}` : `${first}–${last}`;
    return `The file the developer is looking at is ${path}, and the question is about the lines they selected`
        + ` (${range}). The selection is:\n`
        + '```rust\n' + clip(lines.slice(first - 1, last).join('\n'), selectionLimit, 'selection') + '\n```\n\n'
        + `Lines ${from}–${to} of the same file, with line numbers (» marks the selected lines):\n`
        + '```rust\n' + clip(numbered.join('\n'), contextLimit, 'context') + '\n```';
}

// ---------------- prompts and parsing ----------------
//
// The prompts themselves live in `rustCode.ts`: they are the one part of this subsystem that has to know
// the language (Rust, embassy, `no_std`) and the target (a Pico or an ESP32). Everything else here —
// this parser, the client above, the token arithmetic below — is language-free on purpose, which is what
// lets a future C or MicroPython assistant reuse it with different prompt text.

/** The fence every code answer is asked for, and the one `extractCode` looks for. */
const CODE_FENCE = '```';

/** One fenced block of code in an answer, with the language the model declared for it. */
export interface CodeBlock {
    /** The info string's first word, lower-cased (`rust`, `bash`, `` when the model wrote none). */
    language: string;
    code: string;
}

/**
 * The code blocks in an answer that are worth offering to apply to a Rust project.
 *
 * WHY THIS IS NOT `extractCode` (asked 2026-10-04: *"In the ai assist chat box, if the response contains
 * refactored code, add the option to implement that code in the project."*). `extractCode` answers "what is
 * **the** code here" for a flow that already knows it will apply one thing; the chat has to answer "is there
 * anything here to apply, and how many", because a refactoring answer often carries two blocks (before and
 * after) or a Rust block beside a `Cargo.toml` one. So every block is reported, and `language` is what lets
 * the caller leave the `toml` alone.
 *
 * Only **closed** fences count. An unclosed fence means the answer was cut off by the token budget (the case
 * `extractCode` salvages, deliberately, for a flow where the user is watching); offering a *button* that
 * writes half a function into a file is a different proposition, and the honest answer there is to let the
 * user read the answer and ask again.
 */
export function codeBlocks(answer: string): CodeBlock[] {
    const text = String(answer ?? '');
    const out: CodeBlock[] = [];
    const fenceRe = new RegExp(`${CODE_FENCE}([^\\n]*)${'\\n'}([\\s\\S]*?)${CODE_FENCE}`, 'g');
    let m: RegExpExecArray | null;
    while ((m = fenceRe.exec(text)) !== null) {
        const language = String(m[1] ?? '').trim().split(/\\s+/)[0]?.toLowerCase() ?? '';
        const code = String(m[2] ?? '').replace(/\\s+$/, '');
        if (code.trim()) out.push({ language, code });
    }
    return out;
}

/** Is this block worth offering to implement in a Rust project? */
export function isRustCodeBlock(block: CodeBlock): boolean {
    // No language at all counts: the assistant answers about this project, and a model that omits the info
    // string is still almost always writing Rust. Anything that *named* another language is left alone.
    return block.language === '' || /^(rust|rs|rust-lang)$/.test(block.language);
}

/** The Rust code blocks in an answer — the ones the chat offers to implement. */
export function rustCodeBlocks(answer: string): CodeBlock[] {
    return codeBlocks(answer).filter(isRustCodeBlock);
}

/**
 * Pulls the code out of a model answer. Takes the **last** fenced block, because a small model often
 * echoes the method it was given first and then answers; falls back to `{"code": …}` and, failing
 * everything, to the raw text with the fences stripped.
 */
export function extractCode(answer: string): { code: string; note: string } {
    const text = String(answer ?? '');

    // Some models answer with JSON when the prompt smells like an API call.
    const jsonMatch = /\{[\s\S]*"code"[\s\S]*\}/.exec(text);
    if (jsonMatch) {
        try {
            const obj = JSON.parse(jsonMatch[0]) as { code?: unknown; explanation?: unknown; note?: unknown };
            if (typeof obj.code === 'string' && obj.code.trim()) {
                const note = [obj.explanation, obj.note].find((v) => typeof v === 'string' && v.trim());
                return { code: tidyCode(obj.code), note: typeof note === 'string' ? note.trim() : '' };
            }
        } catch {
            // not JSON after all — carry on with the fence handling
        }
    }

    const blocks: string[] = [];
    const fenceRe = new RegExp(CODE_FENCE + '[^\\n]*\\n([\\s\\S]*?)' + CODE_FENCE, 'g');
    let m: RegExpExecArray | null;
    while ((m = fenceRe.exec(text))) blocks.push(m[1] ?? '');

    if (blocks.length > 0) {
        const code = tidyCode(blocks[blocks.length - 1] ?? '');
        const outside = `${text.slice(0, text.indexOf(CODE_FENCE))}`.trim();
        const repeated = blocks.length > 1 ? `The model repeated the code ${blocks.length} times; the last block was used.` : '';
        return { code, note: repeated || outside.slice(0, 400) };
    }

    // A fence that was never closed: the answer was cut off, usually by the token budget. What is inside
    // is still the best thing available, so take it and say so — throwing it away is what produced the
    // unactionable "returned nothing usable" on the first bundled run (2026-09-14).
    const openFence = text.lastIndexOf(CODE_FENCE);
    if (openFence >= 0) {
        const after = text.slice(openFence + CODE_FENCE.length).replace(/^[^\n]*\n/, '');
        const salvaged = tidyCode(after);
        if (salvaged) {
            return {
                code: salvaged,
                note: 'The answer was cut off before its code block closed — check the end of the method.'
            };
        }
    }

    // No fence at all. Only take it if it reads like code: an unfenced answer is at least as likely to be
    // a sentence about the change, and substituting a method with prose is worse than changing nothing.
    const bare = tidyCode(text);
    if (looksLikeCode(bare)) {
        return { code: bare, note: 'The model answered without a code fence; the whole answer was used.' };
    }
    return { code: '', note: '' };
}

/**
 * Is this unfenced text source code rather than a sentence about it? Deliberately conservative — the
 * cost of saying no is a clear message, the cost of saying yes is a method replaced by a paragraph.
 */
export function looksLikeCode(text: string): boolean {
    const body = String(text ?? '').trim();
    if (!body) return false;
    if (/[{}]/.test(body)) return true;
    if (/\b(private|public|internal|protected|static|void|async|Sub|End Sub|Function|End Function|Dim|If\b)\b/.test(body)) return true;
    // A body without braces or keywords: accept it when its shape is code — several lines, indented or
    // punctuated like statements — and reject prose, whose lines end in full stops.
    const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) return false;
    const codeish = lines.filter((l) => /^\s/.test(l) || /[;{,)]\s*$/.test(l.trim())).length;
    return codeish * 2 >= lines.length;
}

/**
 * Why an answer was not usable — the sentence the developer reads instead of a shrug. Pure, so the
 * wording is asserted: the first real "returned nothing usable" arrived with no evidence at all, which
 * is exactly what made it impossible to act on.
 */
/** Why an answer came back empty — the numbers that make it actionable. */
export interface EmptyAnswerDiagnostics {
    /** Characters of thinking the model produced before it stopped. */
    reasoningChars?: number;
    reasoningTokens?: number;
    /** `length` means the budget ran out; that is the difference between "too small" and "rambled". */
    finishReason?: string;
    /** Rough size of the prompt that was sent (~characters/4), when it is known. */
    promptTokens?: number;
    /** The window the request had to fit in, when it is known. */
    contextSize?: number;
}

export function describeEmptyAnswer(answer: string, diag: EmptyAnswerDiagnostics = {}): string {
    const text = String(answer ?? '');
    // The prompt and the window, when they are known: "the budget ran out" is only actionable if it says
    // how much of the window the *prompt* had already taken (added 2026-09-16, after a bundled 12B model
    // answered with nothing at all).
    const squeeze = diag.promptTokens && diag.contextSize
        ? ` The prompt was about ${diag.promptTokens} tokens of a ${diag.contextSize}-token window, so the `
        + 'answer had little room left.'
        : '';
    if (!text.trim()) {
        const thinking = diag.reasoningChars ?? 0;
        if (thinking > 0) {
            const tokens = diag.reasoningTokens ? ` — ${diag.reasoningTokens} tokens` : '';
            const spentAll = diag.finishReason === 'length';
            return `This model thinks before it answers: it wrote ${thinking} characters of reasoning${tokens} `
                + `${spentAll ? 'and then ran out of budget before writing any code' : 'but no code'}. `
                + `Raise "rustyPlatform.assistant.maxTokens" (4096 is enough for a thinking model), `
                + `or choose a coder model that answers directly.${spentAll ? squeeze : ''}`;
        }
        if (diag.finishReason === 'length') {
            return 'The answer budget ran out before the model wrote anything — raise '
                + `"rustyPlatform.assistant.maxTokens".${squeeze}`;
        }
        return `The model returned an empty answer${diag.finishReason ? ` (finish reason "${diag.finishReason}")` : ''}.`
            + `${squeeze} A model that says nothing at all usually cannot use the prompt it was given — `
            + 'try the same request with another model, and check the window above.';
    }
    if (text.includes(CODE_FENCE)) {
        return 'The code block in the answer was never closed — it was cut off before it was complete.';
    }
    const firstLine = (text.trim().split(/\r?\n/)[0] ?? '').slice(0, 140);
    return `The model answered with prose instead of code: "${firstLine}"`;
}

/**
 * Trims the blank lines a model likes to put around its answer, and nothing else. `String.trim()` is
 * wrong here: it would eat the first line's indentation, and since `reindent` re-bases every line on the
 * *smallest* indentation it finds, that would then push the whole body one level deeper.
 */
function tidyCode(code: string): string {
    return String(code ?? '')
        // The sidecar decodes special tokens on purpose (so it can stop at the model's end-of-turn
        // marker), which means such a marker can land inside the answer. It is never part of the method.
        // Trade-off: a marker inside a string literal would be removed too — vanishingly unlikely in a
        // method body, and the alternative is shipping `<|im_end|>` into the file.
        .replace(/<\|[a-zA-Z_]+\|>|<\|end_of_turn>|<\|start_of_turn>|<\/s>/g, '')
        .replace(/^\n+/, '')
        .replace(/\s+$/, '');
}

// ---------------- editing text ----------------

/** A method's span inside the file text (offsets, as `enclosingMethod` reports them). */
export interface MethodSpan {
    name: string;
    params: string;
    start: number;
    end: number;
    line: number;
}

/** The exact EOL the document uses, so a proposal never mixes line endings. */
export function detectEol(text: string): string {
    return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Re-indents a proposal to the method's original indentation, keeping relative nesting. */
export function reindent(code: string, indent: string, eol: string): string {
    const lines = code.replace(/\r\n/g, '\n').split('\n');
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    const current = Math.min(...nonEmpty.map((l) => /^[ \t]*/.exec(l)![0].replace(/\t/g, '    ').length), 99);
    return lines
        .map((l) => (l.trim() ? indent + l.replace(/\t/g, '    ').slice(current) : ''))
        .join(eol)
        .replace(/\s+$/, '');
}

/**
 * Replaces one method with the model's version. Pure — the caller decides how to write the result — and
 * it restores a stripped BOM, because the checker works on BOM-free text.
 */
export function spliceMethod(text: string, span: MethodSpan, code: string, eol = detectEol(text)): string {
    const body = text.replace(/\uFEFF/g, '');
    // The declaration's own leading whitespace is the target indentation, whether or not the span
    // starts at the beginning of the line.
    const raw = body.slice(span.start, span.end);
    const indent = /^[ \t]*/.exec(raw)?.[0] ?? '';
    // The span carries the line break(s) after the method — often the blank line that separates it from
    // the next one. Reproducing that count is what keeps the file's shape (and its line count) intact.
    const trailing = (/[\r\n]+$/.exec(raw)?.[0] ?? '').replace(/\r\n/g, '\n').length;
    const replacement = reindent(code, indent, eol) + eol.repeat(trailing);
    return (text.charCodeAt(0) === 0xFEFF ? '\uFEFF' : '') + body.slice(0, span.start) + replacement + body.slice(span.end);
}

/** Line count guard: a method too long for a small model is refused before we send anything. */
export function methodTooLong(method: string): boolean {
    return method.split('\n').length > MAX_METHOD_LINES;
}

/**
 * Rough token count for a prompt or an answer (`characters / 4`).
 *
 * A rule of thumb, deliberately: it is used to keep a request inside the window the model was started
 * with, and for that it only has to be in the right ballpark — being 20% wrong still leaves headroom.
 */
export function estimateTokens(text: string): number {
    return Math.ceil(String(text ?? '').length / 4);
}

/**
 * The answer budget a request may ask for, given the window it has to share with its prompt.
 *
 * Found on 2026-09-16, after a bundled 12B model answered with **0 characters**: the window the sidecar
 * was started with (4096 by default) and the answer budget the extension asked for (4096 by default,
 * raised for thinking models in 0.9.15) were chosen independently, so prompt + answer could not both fit.
 * The sidecar's own clamp reserves a flat 512 tokens for the prompt — a number that was right when the
 * request cap *was* 900 tokens and has been wrong since. A thinking model then spends what is left on
 * thinking and returns `finish_reason: length` with nothing to show for it.
 *
 * The prompt is therefore measured and the answer gets what is actually left. Only meaningful for the
 * bundled runtime: an external server (LM Studio, Ollama) decides its own context, and guessing it would
 * cut requests that are perfectly fine there.
 */
export function answerBudget(
    maxTokens: number,
    contextSize: number,
    promptTokens: number
): { maxTokens: number; reduced: boolean; room: number } {
    // 64 tokens of slack for the template and the stop marker, and a floor so a huge prompt still gets a
    // usable (if short) answer instead of a refusal: the model can always say "that does not fit".
    const room = Math.max(64, Math.floor(contextSize - promptTokens - 64));
    return { maxTokens: Math.max(64, Math.min(maxTokens, room)), reduced: maxTokens > room, room };
}

/**
 * The context the bundled runtime should be started with, given the answer budget the user asked for.
 *
 * The other half of the same bug: a 4096-token window with a 4096-token answer budget leaves nothing for
 * the prompt, so the window grows to hold both — unless the user set an explicit context length, which is
 * honoured as-is (the per-request clamp above keeps that safe).
 */
export function contextForBudget(requestedContext: number, maxTokens: number): number {
    const asked = Math.round(Number(requestedContext) || 0);
    if (asked > 0) return asked;
    return Math.max(DEFAULT_CONTEXT_SIZE, Math.round(maxTokens) + 2048);
}

/**
 * A sentence for the developer when the answer has almost no room left, or `undefined` when it has.
 *
 * "Only accepts 180 tokens", asked 2026-10-12, is this: the window is shared, the prompt is read first, and the
 * answer gets the remainder. There is no fixed 180 anywhere — it was 4096 minus whatever the function, the file
 * header, the crates and the house rules came to, minus the slack. The answer is what gets cut, so the numbers
 * are the only way to point at the setting that fixes it.
 */
export function squeezedAnswerNotice(
    budget: { maxTokens: number; reduced: boolean; room: number },
    contextSize: number,
    promptTokens: number,
    /** Below this the answer cannot hold a rewritten function, so it is worth interrupting for. */
    floor = 512
): string | undefined {
    if (!budget.reduced || budget.maxTokens >= floor) return undefined;
    return (
        `The prompt is about ${promptTokens} tokens of a ${contextSize}-token window, so only ` +
        `${budget.maxTokens} are left for the answer — too few to rewrite a function, and the usual reason one ` +
        'comes back cut short. Raise "rustyPlatform.assistant.contextSize" (or lower "maxTokens"), or ask for ' +
        'a smaller function.'
    );
}

// ---------------- how big a prompt may be (asked 2026-09-16) ----------------
//
// The user's aim, in their words: *"limit the length of the prompt to ensure the model's response does not take
// too long to process but still replies with a reasonably accurate result."*
//
// Half of that is physics and half is a trade-off, and they are worth keeping apart:
//   - **Physics:** prompt-processing time is linear in prompt tokens, so capping the prompt genuinely bounds
//     how long the model takes to *start* answering. That is real and worth doing.
//   - **Trade-off:** what gets dropped is context the model would have used. This project includes one short
//     sibling method on purpose — it is what lifts a small model from "plausible C#" to "compiles here" — so
//     dropping it makes the answer *cheaper*, not *better*. The parts are therefore dropped in a fixed,
//     explainable order (the optional ones only), the order is reported, and the user's own sentence is
//     capped rather than their code.
//   - What a cap cannot do is make the *answer* shorter: that is `maxTokens`, a separate decision.

/** Tokens reserved for the chat template, the stop marker and rounding. */
const PROMPT_SLACK_TOKENS = 64;

/** How much of the window is left for the prompt once the answer has its share. */
export function promptRoom(contextSize: number, maxTokens: number): number {
    return Math.max(0, Math.floor(contextSize - maxTokens - PROMPT_SLACK_TOKENS));
}

/** One part of a prompt, so it can be left out when the window is full. */
export interface PromptPart {
    /** Named in the log when it is dropped: `style`, `members`, `method`… */
    name: string;
    text: string;
    /** Required parts are never dropped; if they alone do not fit, the request is refused. */
    required: boolean;
}

export interface PromptFit {
    /** The parts to send, in the order they were given. */
    kept: PromptPart[];
    /** Names of the optional parts that had to go, in the order they were dropped. */
    dropped: string[];
    /** Tokens the *required* parts need beyond the room (0 when everything fitted). */
    overflowTokens: number;
    /** The room the fit was computed against. */
    room: number;
    /** Tokens the kept parts need. */
    usedTokens: number;
}

/**
 * Keeps the parts that fit and drops the optional ones that do not — in the order they are given.
 *
 * Callers order the optional parts by value, so the first one is the last to be dropped. For the
 * generate-a-member prompt that order is the member list (cheap, and it is what stops the model inventing
 * calls) before the style sample (expensive, and only about idiom).
 */
export function fitPromptParts(parts: PromptPart[], room: number): PromptFit {
    const tokensOf = (p: PromptPart) => estimateTokens(p.text);
    const required = parts.filter((p) => p.required);
    const optional = parts.filter((p) => !p.required);
    const requiredTokens = required.reduce((n, p) => n + tokensOf(p), 0);
    if (requiredTokens > room) {
        return { kept: required, dropped: [], overflowTokens: requiredTokens - room, room, usedTokens: requiredTokens };
    }
    let left = room - requiredTokens;
    const dropped: string[] = [];
    const keptOptional: PromptPart[] = [];
    for (const part of optional) {
        const cost = tokensOf(part);
        if (cost <= left) {
            left -= cost;
            keptOptional.push(part);
        } else {
            dropped.push(part.name);
        }
    }
    // The original order is restored so the prompt reads the way it always did when nothing was dropped.
    const kept = parts.filter((p) => required.includes(p) || keptOptional.includes(p));
    return {
        kept,
        dropped,
        overflowTokens: 0,
        room,
        usedTokens: kept.reduce((n, p) => n + tokensOf(p), 0)
    };
}

/**
 * The cap on the developer's own sentence.
 *
 * A sentence or two is what the feature asks for, so this is generous rather than strict: it exists to stop a
 * pasted wall of text from dominating the prompt (and the wait), not to make people count words.
 */
export const MAX_DESCRIPTION_TOKENS = 400;

/** Tokens left for the sentence: what the prompt does not need, capped, never negative. */
export function descriptionAllowance(room: number, usedTokens: number): number {
    return Math.max(0, Math.min(MAX_DESCRIPTION_TOKENS, Math.floor(room - usedTokens)));
}

/** `315` → `~315 tokens (~1260 characters)`. One wording for every place that shows the allowance. */
export function allowanceText(tokens: number): string {
    return `~${tokens} tokens (~${tokens * 4} characters)`;
}

