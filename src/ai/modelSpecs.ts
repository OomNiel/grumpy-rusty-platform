/* Local AI assist — which models the bundled runtime offers, and the pure maths around it.
 *
 * Kept away from both `assistant.ts` (prompts, parsers, client) and `modelRuntime.ts` (VS Code,
 * processes, downloads) because everything here is a plain function of its arguments: the picker, the
 * status command, the download and the tests all read the same table. A wrong byte count or hash here
 * would mean a corrupt download for every user, so the numbers are the ones Hugging Face reports for
 * these exact files (checked 2026-09-14), and the sidecar refuses a file that does not match.
 *
 * Why a code-specialised model and not Phi-3-mini (the original guess, see NOTES.md §91): Microsoft's
 * own model card warns that Phi-3 is trained predominantly on Python and that scripts in other
 * languages must be verified by hand — exactly the wrong risk for generated C# and VB.NET.
 */

export interface ModelSpec {
    id: string;
    label: string;
    /** One line for the picker: size and what the choice buys. */
    detail: string;
    fileName: string;
    url: string;
    bytes: number;
    sha256: string;
    /** Total RAM this model wants before it is worth offering. */
    minRamGb: number;
    /**
     * The native build this entry runs on, when the **same weights** are offered twice (2026-09-17).
     *
     * Absent means "whatever `assistant.bundledBackend` already says". Present means the entry *is* that
     * choice: the Load path writes it to the setting before starting the runtime, so picking "GPU (Vulkan)"
     * or "CPU only" is the whole difference — one download, two ways to run it.
     */
    backend?: SidecarBackend;
}

/** Folder inside the extension's global storage that holds the downloaded weights. */
export const MODEL_FOLDER = 'models';

/** Context window handed to the sidecar. Big enough for header + method + a 900-token answer. */
export const DEFAULT_CONTEXT_SIZE = 4096;

/** The sidecar prints this on stdout once it is listening (mirrors `PREVIEWER_HOST_READY`). */
export const READY_PREFIX = 'MODEL_HOST_READY';

const HF = 'https://huggingface.co/Qwen';

/**
 * The two entries this extension offers — the **same weights**, twice (asked 2026-09-17).
 *
 * WHY TWO, AND WHY THIS PAIR. *"We know the Qwen 7B answered correctly and that it should be a Vulkan build.
 * There should only be 2 options in the picker, the Qwen 7B built with Vulkan and the 7B build without
 * Vulkan."* Measured on this machine with the application's own prompt — the ComboBox → grid-row handler, with
 * the DataSet facts block in it (NOTES.md §132, §134):
 *
 *   - the **7B** wrote the only answer that compiles (`CustomersDataSet.Customers.FirstOrDefault(row =>
 *     row.Name == selectedName)`), in **9.7 s on the Vulkan build** and 13.0 s on the CPU one;
 *   - the 3B was quickest and wrong — `DataTable.Rows.Find(predicate)`, and `Find` takes a key, not a predicate;
 *   - DeepSeek-Coder-V2-Lite wrote `DataGrid1.Items` — the `CS1061` failure 0.10.2 was about — *while the
 *     prompt told it that member does not exist*;
 *   - Gemma-4-Coder 12B answered nothing at all through the OpenAI path (its chat template).
 *
 * So the choice a novice actually faces is not "which model" but **"use the GPU or not"**, and it is offered as
 * two entries over one download: the weights are fetched and verified once, and the only difference is which
 * native build of llama.cpp runs them. `backend` is what makes an entry mean something — the Load path writes
 * it to `assistant.bundledBackend`, the same key the status line reads back, so "which build actually loaded"
 * is never a guess. A Vulkan load that dies is retried on the CPU build (`sidecarAttempts`), and the panel says
 * so.
 *
 * THE STEP UP IS NOT A THIRD ENTRY. When a repair run ends without a clean build, the extension *offers* the
 * user's own big model — *"the system must ask the user if it should re-try a fix with the 30B model"* — and
 * `bigModel.ts` is that path.
 */
export const MODEL_SPECS: ModelSpec[] = [
    {
        id: 'qwen2.5-coder-7b-gpu',
        label: 'Qwen2.5-Coder 7B  ·  GPU (Vulkan)',
        detail: '4.4 GB — the same weights on the GPU build; measured 9.7 s for a handler here, against 13.0 s on the CPU',
        fileName: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf',
        url: `${HF}/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf`,
        bytes: 4683073536,
        sha256: '509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c',
        minRamGb: 16,
        backend: 'vulkan'
    },
    {
        id: 'qwen2.5-coder-7b-cpu',
        label: 'Qwen2.5-Coder 7B  ·  CPU only (no GPU)',
        detail: '4.4 GB — the same weights with no GPU involved: the fallback if this machine\'s Vulkan driver will not load them',
        fileName: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf',
        url: `${HF}/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf`,
        bytes: 4683073536,
        sha256: '509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c',
        minRamGb: 16,
        backend: 'cpu'
    }
];

export function specById(id: string): ModelSpec | undefined {
    return MODEL_SPECS.find((s) => s.id === id);
}

// ---------------- models the user brings from Hugging Face (asked 2026-09-16) ----------------
//
// *"Should we remove the LM Studio dependency from the extension and load everything from Hugging Face?"*
// The bundled runtime has always fetched its weights from Hugging Face — but only the five files pinned in
// this table. Anyone who found a model they liked (a llama.cpp server answered faster and better than the LM
// Studio models, in the report that started this) had to download it by hand and point the extension at the
// *file*. These three functions turn a pasted Hub URL into a spec, and the Hub's own file listing into the
// numbers the download needs. All pure: the network call and the download live in `modelRuntime`.

/** A Hugging Face reference: the repo, and optionally one file in it. */
export interface HubRef {
    repo: string;
    revision: string;
    file?: string;
}

/**
 * Reads what a browser gives you when you copy a Hugging Face link.
 *
 * Accepted, because all of them end up on the clipboard depending on where you click:
 *   `https://huggingface.co/owner/repo`
 *   `https://huggingface.co/owner/repo/tree/main`
 *   `https://huggingface.co/owner/repo/blob/main/file.gguf`
 *   `https://huggingface.co/owner/repo/resolve/main/file.gguf`
 *   `owner/repo` — no scheme, which people also paste.
 */
export function parseHubUrl(input: string): HubRef | undefined {
    let text = String(input ?? '').trim();
    if (!text) return undefined;
    // Whether the user pasted a full URL matters: with a host, it has to be Hugging Face's — otherwise
    // `https://example.com/owner/repo` would be read as the repo `example.com/owner` and the flow would offer
    // a download from the wrong place (found by the test, 2026-09-16). Without one, `owner/repo` is meant.
    const hadHost = /^(?:https?:\/\/|www\.)/i.test(text);
    text = text.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
    const parts = text.split(/[?#]/)[0]!.split('/').filter((p) => p.length > 0);
    if (parts[0]?.toLowerCase() === 'huggingface.co') parts.shift();
    else if (hadHost) return undefined;
    const [owner, repo, verb, ...rest] = parts;
    if (!owner || !repo) return undefined;
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return undefined;
    const isFile = verb === 'blob' || verb === 'resolve' || verb === 'raw';
    if (!isFile) {
        // `/tree/<rev>` names a revision; anything else is ignored, and `main` is the default.
        return { repo: `${owner}/${repo}`, revision: verb === 'tree' && rest[0] ? rest[0] : 'main' };
    }
    const revision = rest[0] ?? 'main';
    const file = rest.slice(1).join('/');
    return { repo: `${owner}/${repo}`, revision, file: file || undefined };
}

/**
 * The Hub URLs, in the registry module — the one place a `huggingface.co` address may appear (a guard in the
 * suite enforces that, so the API the download reads and the file it fetches can never drift apart).
 */
export function hubApiUrl(repo: string, revision = 'main'): string {
    return `https://huggingface.co/api/models/${repo}?blobs=true&revision=${encodeURIComponent(revision)}`;
}

export function hubResolveUrl(repo: string, revision: string, file: string): string {
    return `https://huggingface.co/${repo}/resolve/${revision || 'main'}/${file}`;
}

/** One `.gguf` file as the Hub's `?blobs=true` answer describes it. */
export interface HubFile {
    file: string;
    bytes: number;
    /** The LFS hash the Hub reports — what the download is verified against. */
    sha256?: string;
}

/**
 * The `.gguf` files in a repo, from `https://huggingface.co/api/models/<repo>?blobs=true`.
 *
 * The answer's shape is the one this session read by hand to verify the pinned specs, so it is pinned here
 * too: `siblings[].rfilename` for the name, `size` for the bytes and `lfs.sha256` for the hash. Files without
 * a hash are dropped rather than offered: the download verifies what it fetches, and a model that cannot be
 * verified is not one to hand a user as if it were the one they asked for.
 */
export function hubGgufFiles(apiAnswer: unknown): HubFile[] {
    const siblings = (apiAnswer as { siblings?: unknown })?.siblings;
    if (!Array.isArray(siblings)) return [];
    const out: HubFile[] = [];
    for (const entry of siblings) {
        const e = entry as { rfilename?: unknown; size?: unknown; lfs?: { sha256?: unknown } };
        const file = typeof e?.rfilename === 'string' ? e.rfilename : '';
        if (!file.toLowerCase().endsWith('.gguf')) continue;
        const bytes = typeof e?.size === 'number' ? e.size : 0;
        const sha = typeof e?.lfs?.sha256 === 'string' ? e.lfs.sha256 : undefined;
        out.push({ file, bytes, sha256: sha });
    }
    return out;
}

/**
 * The spec for a file the user chose, from the Hub's own numbers.
 *
 * `minRamGb` is derived, not asked for: a local model needs roughly its own size again in RAM while it runs
 * (weights plus context), and the pinned table follows the same rule of thumb (`max(8, size × 2)`), so an
 * added model is gated the same way the built-in ones are.
 */
export function hubFileSpec(input: {
    repo: string;
    file: string;
    revision?: string;
    bytes?: number;
    sha256?: string;
}): ModelSpec {
    const revision = input.revision || 'main';
    const bytes = Math.max(0, Math.round(input.bytes ?? 0));
    const sizeText = bytes > 0 ? formatBytes(bytes) : 'size unknown until the download starts';
    const file = input.file;
    return {
        id: `hub/${input.repo}/${file}`,
        label: `${file}  ·  Hugging Face`,
        detail: `${sizeText} — from ${input.repo} on Hugging Face; downloaded once, verified against the hash the Hub reports`,
        fileName: file.split('/').pop() ?? file,
        url: hubResolveUrl(input.repo, revision, file),
        bytes,
        sha256: input.sha256 ?? '',
        minRamGb: bytes > 0 ? Math.max(8, Math.round((bytes / (1024 * 1024 * 1024)) * 2)) : 16
    };
}

/** Recognises one of our files by name, so a file already in storage needs no re-download. */
export function specByFileName(file: string, specs: ModelSpec[] = MODEL_SPECS): ModelSpec | undefined {
    const name = String(file).replace(/\\/g, '/').split('/').pop() ?? '';
    const lower = name.toLowerCase();
    return specs.find((s) => s.fileName.toLowerCase() === lower);
}

/** `2104932800` → `2.0 GB`. Decimal units: the number the download page shows. */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '?';
    if (bytes < 1000) return `${Math.round(bytes)} B`;
    const units = ['kB', 'MB', 'GB', 'TB'];
    let value = bytes / 1000;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit += 1;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** `509287f7…894d3c` → `509287f7…` so a hash can be shown without wrecking the layout. */
export function shortHash(sha256: string): string {
    return /^[0-9a-f]{16,}$/i.test(sha256) ? `${sha256.slice(0, 8)}…` : sha256;
}

/**
 * Threads for llama.cpp. Physical cores would be ideal but Node only reports logical ones, and
 * oversubscribing them makes generation *slower*, so leave one for the editor and cap at 8.
 */
export function defaultThreads(cpuCount: number): number {
    const n = Number.isFinite(cpuCount) ? Math.floor(cpuCount) : 1;
    return Math.max(1, Math.min(8, n - 1));
}

export interface SidecarOptions {
    modelPath: string;
    port: number;
    threads?: number;
    contextSize?: number;
    gpuLayers?: number;
    backend?: SidecarBackend;
}

/**
 * The native build the built-in runtime should use (2026-09-16).
 *
 * `cpu` is the default and is what the extension has always shipped: llama.cpp's CPU libraries need nothing
 * from the GPU. `vulkan` asks for the GPU build, which is the same binary with a different set of native
 * libraries (`runtimes/<rid>/native/vulkan/`) — and asking is a *request*: LLamaSharp falls back to the CPU
 * libraries when this machine has no usable Vulkan device, so the answer is read back from the runtime (see
 * `Native backend:` in the status) rather than assumed from the setting.
 */
/**
 * Which native build of the bundled runtime to run.
 *
 * `cpu` is the default and needs nothing beyond `cmake` and a C++ compiler. The others are **cargo
 * features**, each needing a platform SDK at build time — `vulkan` (Vulkan SDK), `cuda` (CUDA toolkit),
 * `metal` (Xcode). The name is exactly the feature and exactly what the sidecar echoes back in `/health`.
 */
export type SidecarBackend = 'cpu' | 'vulkan' | 'cuda' | 'metal';

/** A setting (or anything else) as a backend: only the exact word `vulkan` asks for the GPU build. */
export function sidecarBackend(value: unknown): SidecarBackend {
    const word = String(value ?? '').trim().toLowerCase();
    return word === 'vulkan' || word === 'cuda' || word === 'metal' ? word : 'cpu';
}

/** Exact argv for the sidecar. Pure so the process it starts is testable without starting one. */
export function sidecarArgs(options: SidecarOptions): string[] {
    const args = ['--model', options.modelPath, '--port', String(options.port)];
    if (options.threads) args.push('--threads', String(options.threads));
    args.push('--ctx', String(options.contextSize ?? DEFAULT_CONTEXT_SIZE));
    args.push('--gpu-layers', String(options.gpuLayers ?? 0));
    // Always stated, like `--gpu-layers 0`: the log line is the evidence of what was asked for, and a request
    // that only sometimes appears on the command line is the sort of thing nobody can check later.
    args.push('--backend', options.backend ?? 'cpu');
    return args;
}

/**
 * The native builds to try, in order.
 *
 * Asking for Vulkan is a request, not a guarantee, and the failure this exists for is not a *file* problem:
 * a Vulkan driver can die while the weights are loading (the driver aborts the process, which no library can
 * catch). One retry on the CPU turns "the model stopped loading" into "the model loaded", and a second
 * attempt is never made: if the CPU build cannot load it either, the reason is the model, not the GPU.
 */
export function sidecarAttempts(backend: SidecarBackend): SidecarBackend[] {
    return backend === 'cpu' ? ['cpu'] : [backend, 'cpu'];
}

/** The base URL the extension's existing client is pointed at — `/chat/completions` hangs off it. */
export function sidecarBaseUrl(port: number): string {
    return `http://127.0.0.1:${port}/v1`;
}

export function sidecarHealthUrl(port: number): string {
    return `http://127.0.0.1:${port}/health`;
}

export interface SidecarHealth {
    /** True when the weights are in and the server can answer a chat request. */
    ok: boolean;
    loading: boolean;
    model?: string;
    /** The native build the runtime actually loaded (`cpu` until it says otherwise). */
    backend?: SidecarBackend;
    /** The Vulkan device it used, when it used one. */
    device?: string;
    error?: string;
}

/** Reads the sidecar's `/health`. Pure: every branch is covered by the tests, not by a live server. */
export function parseHealth(body: unknown): SidecarHealth {
    const obj = (body ?? {}) as { ok?: unknown; loaded?: unknown; loading?: unknown; model?: unknown; backend?: unknown; device?: unknown; error?: unknown };
    const loaded = obj.loaded === true || obj.ok === true;
    return {
        ok: loaded,
        loading: obj.loading === true,
        model: typeof obj.model === 'string' ? obj.model : undefined,
        backend: obj.backend === undefined ? undefined : sidecarBackend(obj.backend),
        device: typeof obj.device === 'string' && obj.device ? obj.device : undefined,
        error: typeof obj.error === 'string' && obj.error ? obj.error : undefined
    };
}

/**
 * The status line for the built-in runtime's native build — one implementation for the status dialog and the
 * ⚙ panel, so the two cannot disagree about whether the GPU is in play.
 *
 * `loaded` is what the *runtime* reported. Null means it is not running, and then the only honest thing to
 * say is what was chosen, not what will happen: the fallback is llama.cpp's decision, made when the weights
 * load, and a build that says "Vulkan" for a runtime that quietly ended up on the CPU is exactly the kind of
 * claim this project does not make.
 */
export function nativeBackendLine(selected: SidecarBackend, loaded?: { backend?: SidecarBackend; device?: string }): string {
    const label = (backend: SidecarBackend): string =>
        backend === 'cpu' ? 'CPU' : `${backend.charAt(0).toUpperCase()}${backend.slice(1)}`;
    if (!loaded) {
        return selected === 'cpu'
            ? 'Native backend: CPU build'
            : `Native backend: ${label(selected)} build (chosen — it starts with the next request)`;
    }
    if (loaded.backend && loaded.backend !== 'cpu') {
        return `Native backend: ${label(loaded.backend)} build${loaded.device ? ` — ${loaded.device}` : ''}`;
    }
    return selected === 'cpu'
        ? 'Native backend: CPU build'
        : `Native backend: CPU build — the ${label(selected)} build was asked for, but llama.cpp could not use it on this machine`;
}

/**
 * Whether this machine should be offered `spec` at all. A 7B model on an 8 GB laptop would swap for
 * minutes, so it is not offered there — better an honest "too big" than a feature that feels broken.
 */
export function canRunSpec(
    spec: ModelSpec,
    hardware: { level: 'good' | 'minimal' | 'none'; totalRamGb: number }
): { ok: boolean; reason?: string } {
    if (hardware.level === 'none') return { ok: false, reason: 'this machine cannot run a local model' };
    if (hardware.totalRamGb < spec.minRamGb) {
        return { ok: false, reason: `needs ${spec.minRamGb} GB RAM (this machine has ${hardware.totalRamGb.toFixed(0)} GB)` };
    }
    return { ok: true };
}

/** A `.gguf` file the user pointed at themselves. */
export function isGgufPath(file: string): boolean {
    return /\.gguf$/i.test(String(file).trim());
}
