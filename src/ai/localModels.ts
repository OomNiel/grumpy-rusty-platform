/* Choosing a local model without knowing anything about ports, ids or flags.
 *
 * THE POINT (2026-09-15): setting the AI assist up by hand means knowing an endpoint, a port, an exact
 * model id, and enough about llama.cpp to pick a context length and an offload ratio — the user called that
 * "way too complicated for a novice", and they are right. So the picker does it: it asks LM Studio what is
 * on disk, offers the models by name, and derives every value from the machine.
 *
 * WHY THIS FILE IS PURE. Everything here is a function of text: the CLI's output comes in as a string and
 * the decisions come out as data. That is what lets the suite pin the parsing of real `lms ls`, `lms ps`
 * and `lms load --estimate-only` output (captured from a real machine, see the fixtures in the tests and
 * NOTES.md §100) without LM Studio installed, and it keeps the VS Code half thin.
 *
 * The CLI is LM Studio's own `lms` binary (`~/.lmstudio/bin/lms`): `ls` lists what is on disk, `ps` what is
 * loaded, `server status` the port, and `load` takes exactly the knobs a novice should not have to know —
 * `--gpu`, `-c/--context-length`, `--ttl`, `--identifier`.
 */

// `formatBytes` is pure and has no dependencies of its own, so importing it keeps this module testable
// without VS Code while giving the download progress line the same "4.7 GB" wording everywhere.
// `defaultThreads` is the same rule the sidecar uses ("one less than the cores, capped at 8"), applied to
// the user's own llama-server so the two runtimes cannot disagree about how many threads a machine wants.
import { CONTEXT_ALLOWANCE_GB, defaultThreads, formatBytes, recommendedContextFor } from './modelSpecs';
// The one place "nothing is listening there" is decided, shared with the sentence the client writes. Added
// deliberately: the rescue below, the hint next to it and the message itself must not drift apart.
import { isNoAnswerError } from './assistant';

/** Which local runtime a model comes from. */
export type ModelProvider = 'lmstudio' | 'bundled' | 'custom';

export interface LocalModel {
    provider: ModelProvider;
    /** What to pass back to the runtime — for LM Studio this is the `lms` model key and the API id. */
    key: string;
    /** Human label, e.g. `qwen3.8-27b`. */
    label: string;
    /** Parameters as printed (`27B`, `7.5B`, empty when unknown). */
    params: string;
    /** Architecture (`qwen35`, `gemma4`, `Nomic BERT`, …). */
    arch: string;
    sizeGb: number;
    /** LM Studio's own classification, when the REST API answered (`llm`/`vlm`/`embeddings`). */
    kind?: 'chat' | 'embeddings' | 'unknown';
}

export interface LocalModelList {
    chat: LocalModel[];
    embeddings: LocalModel[];
    /** Everything on disk, as the CLI reported it ("taking up 30.70 GB"). */
    diskGb: number;
}

export interface LoadOptions {
    contextLength: number;
    /** `lms load --gpu` value: 'off' | 'max' | a ratio as a string. */
    gpu: string;
    /** Seconds of idleness before LM Studio frees the memory; 0 = keep loaded. */
    ttlSeconds: number;
    /** The name the model answers to on the API — this is what the extension pins. */
    identifier: string;
    /** One line per decision, shown in the confirmation so the choice is not a black box. */
    reasons: string[];
}

const SIZE_UNITS: Record<string, number> = { KB: 1e-6, MB: 1e-3, GB: 1, TB: 1000 };

/** `84.11 MB` → 0.08411 (GB). */
export function parseSizeGb(text: string): number | undefined {
    const m = /([\d.]+)\s*(KB|MB|GB|TB)/i.exec(String(text ?? ''));
    if (!m) return undefined;
    const value = Number(m[1]);
    const factor = SIZE_UNITS[m[2]!.toUpperCase()];
    return Number.isFinite(value) && factor ? value * factor : undefined;
}

/** The CLI pads its columns, so two-or-more spaces is the separator (model keys never contain them). */
function columns(line: string): string[] {
    return line.trim().split(/\s{2,}/).filter((c) => c.length > 0);
}

/**
 * Parses `lms ls`. Real output (captured 2026-09-15):
 *
 *   You have 4 models, taking up 30.70 GB of disk space.
 *   LLM                               PARAMS    ARCH      SIZE        DEVICE
 *   google/gemma-4-e4b (1 variant)    7.5B      gemma4    6.33 GB     Local
 *   EMBEDDING                               PARAMS    ARCH          SIZE        DEVICE
 *   text-embedding-nomic-embed-text-v1.5              Nomic BERT    84.11 MB    Local
 *
 * Note the embedding row has an EMPTY params column and a two-word arch, which is why the columns are
 * matched positionally against the header rather than counted; and note "(1 variant)", which is not part
 * of the model key.
 */
export function parseLmsList(stdout: string): LocalModelList {
    const result: LocalModelList = { chat: [], embeddings: [], diskGb: 0 };
    let section: 'chat' | 'embeddings' | undefined;

    for (const raw of String(stdout ?? '').split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, '');
        if (!line.trim()) continue;

        const disk = /taking up\s+([\d.]+\s*[KMG]?B)/i.exec(line);
        if (disk) {
            result.diskGb = parseSizeGb(disk[1]!) ?? 0;
            continue;
        }
        if (/^\s*EMBEDDING\b/i.test(line)) {
            section = 'embeddings';
            continue;
        }
        if (/^\s*LLM\b/i.test(line)) {
            section = 'chat';
            continue;
        }

        const cells = columns(line);
        // A data row needs at least a key and one more column; the header/summary lines do not match.
        if (!section || cells.length < 2) continue;
        const key = cells[0]!.replace(/\s*\(\d+\s+variants?\)$/i, '').trim();
        if (!key || /\s/.test(key)) continue;
        // The last two columns are SIZE and DEVICE; what sits between the key and SIZE is PARAMS then
        // ARCH — but PARAMS is EMPTY for embedding models, so it is found by shape and the rest is arch.
        const sizeGb = parseSizeGb(cells[cells.length - 2] ?? '') ?? parseSizeGb(line);
        if (sizeGb === undefined) continue;
        const middle = cells.slice(1, Math.max(1, cells.length - 2));
        const params = middle.find((c) => /^[\d.]+[KMB]$/i.test(c)) ?? '';
        const arch = middle.filter((c) => c !== params).join(' ');

        const model: LocalModel = {
            provider: 'lmstudio',
            key,
            label: key,
            params,
            arch,
            sizeGb,
            kind: section === 'chat' ? 'chat' : 'embeddings'
        };
        (section === 'chat' ? result.chat : result.embeddings).push(model);
    }
    return result;
}

/**
 * Parses `lms ps`. Only the *empty* answer is unambiguous ("No models are currently loaded."); the loaded
 * table format has not been observed, so anything else returns `undefined` and the caller falls back to the
 * REST API's `state` field, which is verified. Guessing here would be worse than deferring.
 */
export function parseLmsPs(stdout: string): string[] | undefined {
    const text = String(stdout ?? '');
    if (/no models are currently loaded/i.test(text)) return [];
    return undefined;
}

/** `The server is running on port 1234.` */
export function parseLmsServerStatus(stdout: string): { running: boolean; port?: number } {
    const text = String(stdout ?? '');
    const running = /running on port\s+(\d+)/i.exec(text);
    if (running) return { running: true, port: Number(running[1]) };
    if (/not running|stopped|no server/i.test(text)) return { running: false };
    return { running: false };
}

export interface LoadEstimate {
    model: string;
    contextLength: number;
    gpuOffloadPercent: number;
    totalGiB: number;
    confidence: string;
    /** The CLI's own closing verdict line, shown verbatim in the confirmation. */
    verdict: string;
}

/**
 * Parses `lms load … --estimate-only`, which answers "what would this cost?" without loading anything —
 * the reason a 17 GB model can be refused *before* a three-minute wait. Real output:
 *
 *   Model: qwen3.8-27b
 *   Context Length: 8,192
 *   GPU Offload: 0%
 *   Estimated GPU Memory:   16.52 GiB
 *   Estimated Total Memory: 16.52 GiB
 *   Confidence: LOW
 *   Estimate: This model may be loaded based on your resource guardrails settings.
 */
export function parseLoadEstimate(stdout: string): LoadEstimate | undefined {
    const text = String(stdout ?? '');
    const num = (re: RegExp) => {
        const m = re.exec(text);
        return m ? Number(m[1]!.replace(/[,_]/g, '')) : undefined;
    };
    const total = num(/Estimated Total Memory:\s*([\d.,]+)\s*GiB/i);
    if (total === undefined) return undefined;
    return {
        model: (/Model:\s*(.+)/i.exec(text)?.[1] ?? '').trim(),
        contextLength: num(/Context Length:\s*([\d.,]+)/i) ?? 0,
        gpuOffloadPercent: num(/GPU Offload:\s*(\d+)\s*%/i) ?? 0,
        totalGiB: total,
        confidence: (/Confidence:\s*(\S+)/i.exec(text)?.[1] ?? '').trim(),
        verdict: (/Estimate:\s*(.+)/i.exec(text)?.[1] ?? '').trim()
    };
}

/** Machine facts the recommendation depends on (passed in, so it is testable). */
/**
 * GPU offload, decided from the **graphics card's own memory** when that is known.
 *
 * The old rule was `sizeGb > 8 ? off : max` — written when the only GPU in the room was an integrated one
 * sharing system RAM, where offloading a large model really is slower. On a machine with a card (8-48 GB of
 * dedicated VRAM) that rule refuses the one thing the card is for, which is the same complaint as the model
 * list: the extension was deciding from *this* PC. Without a VRAM figure the conservative rule stands, and
 * the reason says which of the two it is.
 */
export function gpuOffloadFor(sizeGb: number, vramGb: number | undefined): { gpuLayers: number; reason: string } {
    const size = Number.isFinite(sizeGb) ? sizeGb : 0;
    if (vramGb === undefined || !Number.isFinite(vramGb) || vramGb <= 0) {
        return sidecarGpuLayers(size > 8 ? 'off' : 'max') > 0
            ? { gpuLayers: sidecarGpuLayers('max'), reason: `GPU offload on (all layers) — ${size.toFixed(1)} GB is small enough for a shared-memory GPU` }
            : { gpuLayers: 0, reason: `GPU offload off — a ${size.toFixed(1)} GB model does not fit a shared-memory GPU, where offloading is slower. Set "gpuVramGb" if this machine has a dedicated card` };
    }
    // Weights + the context cache have to fit together, with a little room for the driver.
    const needed = Math.round((size + CONTEXT_ALLOWANCE_GB) * 10) / 10;
    if (needed <= vramGb) {
        return { gpuLayers: sidecarGpuLayers('max'), reason: `GPU offload on (all layers) — ${needed.toFixed(1)} GB of weights and context fit in ${vramGb.toFixed(1)} GB of VRAM` };
    }
    return {
        gpuLayers: 0,
        reason: `GPU offload off — this model needs about ${needed.toFixed(1)} GB of VRAM with its context and the card has ${vramGb.toFixed(1)} GB, `
            + 'so its layers would be swapped through PCIe, which is slower than keeping them in RAM'
    };
}

export interface SetupFacts {
    totalRamGb: number;
    freeRamGb: number;
    cpuCount: number;
    /** The kernel's `ulimit -l`, in GB — the reason `mlock` fails on big models. */
    lockLimitGb: number;
    /**
     * The **dedicated** graphics memory, in GB, when this machine has a card this extension can ask.
     *
     * Optional and undefined by default, because it is the fact the old recommendations silently did without:
     * with no VRAM figure every machine was treated like the laptop this was written on, so a model too large
     * for a shared-memory iGPU was never offloaded even on a machine with a 24 GB card (2026-10-04).
     */
    vramGb?: number;
}

/**
 * The values a novice should not have to choose, derived from the machine instead:
 *
 *  - **context**: as much as fits comfortably. 16 K on a roomy machine, 8 K normally, 4 K when RAM is tight.
 *  - **GPU offload**: OFF for anything large. On a shared-memory iGPU (the common laptop case) offloading a
 *    17 GB model is slower than the CPU and risks OOM; it only pays off when the model fits in dedicated
 *    VRAM. Small models are offloaded, where the GPU genuinely helps.
 *  - **ttl**: 15 minutes, so the memory comes back on its own instead of being held for the rest of the day.
 *  - **identifier**: the model key, which is what the extension pins as `assistant.model`.
 */
export function recommendedLoadOptions(model: LocalModel, facts: SetupFacts): LoadOptions {
    const reasons: string[] = [];
    const contextLength = recommendedContextFor(facts.freeRamGb);
    reasons.push(
        `Context ${contextLength.toLocaleString('en-US')} tokens — sized to the ${Math.max(0, Math.round(facts.freeRamGb))} GB you have free`
    );

    const offload = gpuOffloadFor(model.sizeGb, facts.vramGb);
    const gpu = offload.gpuLayers > 0 ? 'max' : 'off';
    reasons.push(offload.reason);

    reasons.push('Unloads itself after 15 idle minutes, so the RAM comes back on its own');
    if (model.kind !== 'embeddings' && model.sizeGb > facts.lockLimitGb) {
        reasons.push(
            `Keep-model-in-memory is NOT usable for this one: it needs ${model.sizeGb.toFixed(1)} GB locked and this machine allows ${facts.lockLimitGb.toFixed(1)} GB`
        );
    }

    return { contextLength, gpu, ttlSeconds: 900, identifier: model.key, reasons };
}

/** The exact `lms` argv for those options. Pure, so the command line is asserted rather than assumed. */
export function buildLoadArgs(model: LocalModel, options: LoadOptions): string[] {
    const args = ['load', model.key, '--gpu', options.gpu, '--context-length', String(options.contextLength)];
    // `-y` answers any prompt the CLI would raise. Pressing "Load Model" IS the approval, and a prompt here
    // has no one to answer it: the child process has no terminal, so the load would sit there until the
    // 30-minute timeout with the panel showing nothing but "loading…". Only models that exceed LM Studio's
    // resource guardrails (the 17.7 GB class on a 28 GB machine, for one) get that far — which makes this a
    // "some models simply do not work" bug rather than an obvious one. `lms import` has always passed it.
    args.push('--yes');
    // `--ttl` must be at least 1: "never unload" is expressed by leaving the flag out entirely, which LM
    // Studio treats as "no timer". Passing 0 was rejected with
    //   error: option '--ttl <seconds>' argument '0' is invalid. Number out of range, must be at least 1
    // — reported by the user on 2026-09-15 after choosing the panel's "never — keep loaded" option.
    if (options.ttlSeconds >= 1) args.push('--ttl', String(options.ttlSeconds));
    args.push('--identifier', options.identifier);
    return args;
}

/** Where `lms` may live, most likely first. Pure (the caller checks existence). */
export function lmsCandidates(homeDir: string, platform: NodeJS.Platform = process.platform): string[] {
    const exe = platform === 'win32' ? 'lms.exe' : 'lms';
    return [homeDir ? `${homeDir}/.lmstudio/bin/${exe}` : exe, exe];
}

/**
 * The kernel's locked-memory limit, in GB, from `/proc/self/limits` (Linux):
 *
 *   Max locked memory         3694476               3694476               bytes
 *
 * Worth parsing because it silently decides whether a model can be memory-locked: on this machine it is
 * 3.5 GB, which is why a 5.34 GB model aborted llama.cpp inside `llama_mlock::grow_to` (2026-09-14) and a
 * 16.8 GB one certainly would. Returns undefined when the file says `unlimited` or cannot be read.
 */
export function parseLockLimitGb(limitsText: string, unlimitedGb = 1024): number | undefined {
    const line = /Max locked memory\s+(\S+)\s+(\S+)/i.exec(String(limitsText ?? ''));
    if (!line) return undefined;
    const [, soft] = line;
    if (/unlimited/i.test(soft!)) return unlimitedGb;
    const bytes = Number(soft);
    return Number.isFinite(bytes) ? bytes / 1e9 : undefined;
}

/** Where a setting already lives, as VS Code's `inspect` reports it. */
export interface SettingScopes {
    globalValue?: unknown;
    workspaceValue?: unknown;
    workspaceFolderValue?: unknown;
}

/**
 * The scope that currently supplies a setting — write **there**, or the write is shadowed.
 *
 * A workspace value beats a global one, so saving `backend: bundled` to Global while the project pins
 * `backend: external` in `<project>/.vscode/settings.json` changes nothing that anyone can see: the load works,
 * the runtime answers, and the panel goes on reading `external` (found on this machine 2026-09-15 — the two
 * built-in models could never stick while the two LM Studio ones worked, because `external` is what they need).
 * Pure, so every branch is asserted instead of being discovered in a user's project folder.
 */
export function writeTargetFor(scopes: SettingScopes): 'workspaceFolder' | 'workspace' | 'global' {
    if (scopes.workspaceFolderValue !== undefined) return 'workspaceFolder';
    if (scopes.workspaceValue !== undefined) return 'workspace';
    return 'global';
}

/** How the picker labels a model, and what it says underneath. */
export function modelLabel(model: LocalModel): string {
    const size = `${model.sizeGb.toFixed(1)} GB`;
    const kind = model.kind === 'embeddings' ? 'embeddings — cannot answer chat' : model.params || model.arch;
    return `${model.label}  ·  ${kind}  ·  ${size}`;
}

/**
 * A load failure is explained from LM Studio's own log, because the two failures that actually happen are
 * both invisible in the UI: llama.cpp aborting on `mlock` (`GGML_ASSERT(addr) failed` in `llama_mlock::grow_to`
 * — the lock limit is smaller than the model) and running out of memory. Pure: takes the log text and the
 * facts, returns the sentence to show.
 *
 * The mlock branch is the one a big model hits, and the *setting* is LM Studio's, not ours: verified on this
 * machine 2026-09-15 — `google/gemma-4-e4b` has its own load config with `llm.load.llama.keepModelInMemory:
 * false` and loads fine, while `qwen3.8-27b` (no per-model config, so LM Studio's default) is started with
 * `--mlock` and aborts three times in four seconds. Our `lms load` command line cannot change it; the two
 * real ways out are the toggle in LM Studio and the kernel's locked-memory limit.
 */
export function explainLoadFailure(logTail: string, facts: SetupFacts, modelSizeGb?: number): string | undefined {
    const log = String(logTail ?? '');
    // Checked before the allocation branch: a Vulkan abort logs "not enough memory for command submission",
    // which is not the RAM running out and must not be explained as if it were.
    //
    // Observed here 2026-09-15 with the 17.7 GB model at 0% offload: `radv/amdgpu: Not enough memory for
    // command submission` → `ggml_vulkan: device lost on Vulkan0` → `terminate called after throwing an
    // instance of 'vk::DeviceLostError'` → SIGABRT. LM Studio answers with its own jargon
    // ("Engine protocol runtime llama-server … exited before becoming healthy"), so this branch is what turns
    // it into something actionable.
    if (/device[ _-]?lost|devicelost|command submission|ggml_vulkan|vk::[A-Za-z]*Error/i.test(log)) {
        return (
            'The GPU backend crashed while loading'
            + `${modelSizeGb ? ` the ${modelSizeGb.toFixed(1)} GB model` : ' the model'}`
            + ': Vulkan reported "device lost". This is not offload — it happens at 0% too, because LM Studio '
            + 'is running its Vulkan build of llama.cpp and an integrated GPU shares system memory with the '
            + 'model itself. Select a CPU-only engine instead (`lms runtime ls` lists them, `lms runtime select '
            + '<engine>` picks one — or LM Studio → Runtime), or load a smaller model.'
        );
    }
    if (/GGML_ASSERT\(addr\)|llama_mlock|mlock/i.test(log)) {
        return (
            'LM Studio tried to lock this model in RAM and the kernel refused. "Keep Model in Memory" is on for '
            + 'this model — that is a setting in LM Studio, not in this extension — and this machine allows only '
            + `${facts.lockLimitGb.toFixed(1)} GB of locked memory${modelSizeGb ? ` while the model needs about ${modelSizeGb.toFixed(1)} GB` : ''}. `
            + 'Turn "Keep Model in Memory" OFF in this model\'s load settings in LM Studio (the Advanced section), '
            + 'then press Load Model again. Raising the limit system-wide (a systemd `LimitMEMLOCK=`) is the other '
            + 'way, but locking 17 GB of a 28 GB machine means the weights can never be swapped out.'
        );
    }
    if (/failed to allocate|out of memory|std::bad_alloc|CUDA error|out of host memory/i.test(log)) {
        return (
            `Not enough free memory to load it${modelSizeGb ? ` (about ${modelSizeGb.toFixed(1)} GB)` : ''} — `
            + `${facts.freeRamGb.toFixed(1)} GB is free. Close other models, try a smaller quantization, or pick a smaller model.`
        );
    }
    // A prompt nobody can answer: the load runs without a terminal, so the CLI waits until the timeout. The
    // extension passes `-y` (the click is the approval), so this branch should be unreachable — it is here so
    // that the next time it *is* reachable, the panel says why instead of saying nothing for half an hour.
    if (/guardrail|exceeds|continue\?|\[y\/n\]|\(y\/n\)|are you sure/i.test(log)) {
        return (
            'LM Studio asked for confirmation before loading this model (it is close to the machine\'s limits). '
            + 'Load it from a terminal once with `lms load <model> --yes`, or raise the limit in LM Studio → '
            + 'Settings → Hardware.'
        );
    }
    return undefined;
}

// ---------------- files on this machine ----------------

/**
 * Where a `.gguf` a developer actually wants might live, most likely first.
 *
 * LM Studio's own folder is first because it is the common case, but note what the scan does with those
 * files: they are already in the `lms ls` list, so they are counted and then left out of the results
 * rather than offered twice under two different names (LM Studio's model *key* and its file path have no
 * reliable mapping — the folder says `lmstudio-community` where the key says `google`).
 */
export function scanRoots(homeDir: string): string[] {
    const home = homeDir || '';
    // The drive roots are listed as roots on purpose: an external volume appears one directory deep inside
    // them and the walker descends by itself, so nothing here has to look at the filesystem. All four are
    // needed — `/media` is the older mount point, `/run/media` is where udisks2 mounts removable drives on
    // most current desktops, `/mnt` is where an administrator mounts one by hand, and `/Volumes` is macOS.
    return [
        `${home}/.lmstudio/models`,
        `${home}/Downloads`,
        `${home}/models`,
        `${home}/llama.cpp`,
        `${home}/.cache/huggingface/hub`,
        `${home}/.cache/lm-studio/models`,
        '/media',
        '/run/media',
        '/mnt',
        '/Volumes'
    ];
}

/**
 * Is this file name a model a chat request could be sent to?
 *
 * The `mmproj-*.gguf` files are the reason this is not just an extension check: they sit in the same
 * folders as the weights (all six `.gguf` files found on this machine on 2026-09-15 included two of them)
 * and are *vision projectors* — loading one produces a failure that says nothing about the real problem.
 */
export function canImportFile(fileName: string): boolean {
    const name = String(fileName ?? '');
    if (!/\.gguf$/i.test(name)) return false;
    if (/^mmproj[-_.]/i.test(name)) return false;
    return true;
}

// ---------------- the panel's load options, for the built-in runtime ----------------

/**
 * The panel's context-length field, as the sidecar wants it: tokens, or the fallback when the user left it
 * on "recommended". LM Studio gets `-c` through `lms load`; the built-in runtime gets `--ctx`.
 */
export function sidecarContextSize(loadContextLength: number, fallback: number): number {
    const asked = Math.round(Number(loadContextLength) || 0);
    if (asked <= 0) return Math.max(512, Math.round(fallback));
    return Math.min(262144, Math.max(512, asked));
}

/**
 * Is this REST `state` a model that is in memory?
 *
 * A **comparison, not a substring test** — and that is the whole point: `"not-loaded".includes("loaded")` is
 * true, so the original `/loaded/i` marked *every* model as loaded. The panel then showed "● loaded" on all
 * three LM Studio models while the server had nothing in memory, which is how a user ends up loading a model
 * that "does not have the tag" and concluding the picker is broken (reported 2026-09-15).
 */
export function isModelLoaded(state: unknown): boolean {
    return String(state ?? '').trim().toLowerCase() === 'loaded';
}

/**
 * The panel's GPU field, as `--gpu-layers`.
 *
 * The mismatch is real and worth naming: LM Studio takes a **ratio** (`off`/`max`/`0.5`) while llama.cpp
 * takes a **count of layers**. So `max` becomes "all of them" (999, which llama.cpp clamps) and anything
 * else — including `auto`, because this machine's GPU shares its memory with the CPU — becomes CPU-only.
 * `0.5` is deliberately *not* guessed into a layer count: half of an unknown number of layers is not a
 * number of layers, and a wrong guess costs more than it buys.
 */
export function sidecarGpuLayers(loadGpu: string): number {
    return String(loadGpu ?? '').trim() === 'max' ? 999 : 0;
}

/** What the panel sends for a load: the raw fields as the controls held them, including `auto` markers. */
export interface RequestedLoad {
    contextLength: number;
    gpu: string;
    ttlSeconds: number;
}

/**
 * Turns the panel's controls into the arguments `lms load` actually accepts.
 *
 * The controls carry three ways of saying "you decide": context `0`, GPU `auto` (and `''`), and TTL `-1`.
 * Passing those through would put `--gpu auto` and `--ttl -1` on the command line, which LM Studio rejects —
 * and it is exactly the sort of thing that only shows up when a real user presses the button, so it lives
 * here as a pure function with a test rather than inside the click handler.
 *
 * `ttlSeconds: 0` is kept as **0**, meaning "no timer": `buildLoadArgs` leaves the flag out for it, because
 * `--ttl 0` is itself invalid (`must be at least 1`).
 */
export function resolveLoadOptions(model: LocalModel, requested: RequestedLoad, facts: SetupFacts): LoadOptions {
    const recommended = recommendedLoadOptions(model, facts);
    const context = Math.round(Number(requested.contextLength) || 0);
    const gpu = String(requested.gpu ?? '').trim();
    const ttl = Math.round(Number(requested.ttlSeconds));
    return {
        contextLength: context > 0 ? context : recommended.contextLength,
        gpu: gpu && gpu !== 'auto' ? gpu : recommended.gpu,
        ttlSeconds: Number.isFinite(ttl) && ttl >= 0 ? ttl : recommended.ttlSeconds,
        identifier: model.key,
        reasons: recommended.reasons
    };
}

/**
 * The download progress line: **bytes of bytes**, plus the percentage when the total is known.
 *
 * Written as a pure function because it is the only feedback a 4.7 GB download gives, and it has to be
 * right in the two cases that differ: a server that sends `Content-Length` (most) and one that does not
 * (the "paste a URL" path). `rateMBps` is optional — a stalled download should still show its progress.
 */
export function downloadProgressText(receivedBytes: number, totalBytes: number, rateMBps?: number): string {
    const got = Math.max(0, receivedBytes);
    const total = Math.max(0, totalBytes);
    const rate = rateMBps !== undefined && rateMBps > 0 ? `  ·  ${rateMBps.toFixed(1)} MB/s` : '';
    if (!total) return `${formatBytes(got)} downloaded${rate}`;
    const pct = Math.min(100, Math.round((got / total) * 100));
    return `${formatBytes(got)} of ${formatBytes(total)}  ·  ${pct}%${rate}`;
}

/**
 * How much of a partial download can be kept, given what the server is about to send.
 *
 * Resume is worth the code here: the two published models are 2.1 GB and 4.7 GB, and a dropped connection
 * at 90% should not cost the whole download. A partial that is *larger* than the file (a stale file, a
 * different quantisation) is discarded instead — resuming onto it would append to the wrong bytes.
 */
export function resumeFromBytes(partialBytes: number, expectedBytes: number): number {
    const have = Math.max(0, Math.round(partialBytes));
    if (have === 0) return 0;
    if (expectedBytes > 0 && have >= expectedBytes) return 0;
    return have;
}

// ---------------- the user's own `llama-server` (asked 2026-09-16) ----------------
//
// *"Models served by the Llama.cpp server respond faster and better than the LM Studio models."* The
// extension already speaks to any OpenAI-compatible address, so a `llama-server` the user started
// themselves has always worked — what it could not do was start one. That is what this section decides:
// **where the binary is**, **what it is started with**, and **whether it is ready**. All of it is a
// function of text and of a filesystem the caller describes, so the suite pins it without a llama.cpp
// build on the machine (which is the case here: there is none).
//
// The flags are llama.cpp's own, read from the server's `--help` reference (`tools/server/README.md`,
// checked 2026-09-16): `-m/--model`, `--host`, `--port`, `-t/--threads`, `-c/--ctx-size`,
// `-ngl/--n-gpu-layers` and `-a/--alias`. The sidecar's flags (`--ctx`, `--gpu-layers`) are OUR wrapper's
// spelling and must never be sent to the user's binary — it would refuse to start on the first one.

/** Where a `llama-server` binary may live, most likely first. Pure (the caller checks existence). */
export function llamaServerCandidates(homeDir: string, platform: NodeJS.Platform = process.platform): string[] {
    const home = homeDir || '';
    // The last entry is a bare name: it means "look on PATH", which is how most people install it.
    if (platform === 'win32') {
        return [
            `${home}\\llama.cpp\\build\\bin\\Release\\llama-server.exe`,
            `${home}\\llama.cpp\\build\\bin\\llama-server.exe`,
            'llama-server.exe'
        ];
    }
    return [
        `${home}/llama.cpp/build/bin/llama-server`,
        `${home}/.local/bin/llama-server`,
        '/usr/local/bin/llama-server',
        '/usr/bin/llama-server',
        'llama-server'
    ];
}

/** The first directory on PATH that holds `name` — the lookup `which`/`where` would do. Pure. */
export function findOnPath(
    name: string,
    pathValue: string,
    exists: (path: string) => boolean,
    platform: NodeJS.Platform = process.platform
): string | undefined {
    const separator = platform === 'win32' ? ';' : ':';
    const names = platform === 'win32' && !/\.exe$/i.test(name) ? [`${name}.exe`, name] : [name];
    for (const dir of String(pathValue ?? '').split(separator)) {
        if (!dir) continue;
        for (const candidate of names) {
            const full = dir.replace(/[\\/]+$/, '') + (platform === 'win32' ? '\\' : '/') + candidate;
            if (exists(full)) return full;
        }
    }
    return undefined;
}

/**
 * The `llama-server` this machine has, if any.
 *
 * A path the user set wins — and a path they set that is *not there* returns undefined rather than
 * falling back, so the caller can say which line of their settings is wrong instead of quietly starting
 * a different binary than the one they named.
 */
export function findLlamaServer(opts: {
    homeDir: string;
    pathValue: string;
    exists: (path: string) => boolean;
    /** The `llamaServerPath` setting; empty means "find it yourself". */
    preferred?: string;
    /**
     * Further absolute paths to try, after the usual build folders and before PATH.
     *
     * This is where a build **this extension installed itself** is offered (`<global storage>/llama.cpp/<tag>/…`).
     * Without it, "a llama-server is installed" meant "the `llamaServerPath` setting survives": clearing that
     * setting, or opening a window whose settings had not kept it, hid a build the extension had fetched and
     * verified — and the next start would have offered to download it a second time.
     */
    extra?: readonly string[];
    platform?: NodeJS.Platform;
}): string | undefined {
    const platform = opts.platform ?? process.platform;
    const preferred = String(opts.preferred ?? '').trim();
    if (preferred) return opts.exists(preferred) ? preferred : undefined;
    // The user's own candidates first (a hand-built llama.cpp may be newer, or built with a GPU backend this
    // extension never downloads), then whatever was installed for us, then PATH.
    const candidates = [...llamaServerCandidates(opts.homeDir, platform), ...(opts.extra ?? [])];
    for (const candidate of candidates) {
        if (!/[\\/]/.test(candidate)) {
            const onPath = findOnPath(candidate, opts.pathValue, opts.exists, platform);
            if (onPath) return onPath;
            continue;
        }
        if (opts.exists(candidate)) return candidate;
    }
    return undefined;
}

/** `llama-server --version` → `1 (62a7f7c)`. Pure; undefined when the output is not that. */
export function parseLlamaVersion(stdout: string, stderr = ''): string | undefined {
    const match = /version:\s*(\S+)\s*(?:\(([^)]+)\))?/i.exec(`${stdout}\n${stderr}`);
    if (!match) return undefined;
    return match[2] ? `${match[1]} (${match[2]})` : match[1];
}

/**
 * A tidy id for the server to answer to.
 *
 * Without `--alias` llama.cpp reports the model as the **full path of the file**, so the pinned model
 * would read `/home/…/models/…gguf` everywhere the extension names it. The base name is what the user
 * calls the model; the quantisation suffix is kept, because two quants of the same model are two models.
 */
export function llamaServerAlias(modelPath: string): string {
    const base = String(modelPath ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
    const name = base.replace(/\.gguf$/i, '').replace(/[^\w.+-]+/g, '-').replace(/^-+|-+$/g, '');
    return name.slice(0, 60) || 'local-model';
}

/** The extra flags a user typed into the `llamaServerArgs` setting, split like a shell would. Pure. */
export function splitArgs(text: string): string[] {
    const out: string[] = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(String(text ?? ''))) !== null) out.push(match[1] ?? match[2] ?? match[3]!);
    return out;
}

export interface LlamaLaunch {
    modelPath: string;
    port: number;
    threads?: number;
    contextSize?: number;
    gpuLayers?: number;
    host?: string;
    /** What the model answers to on the API; empty leaves llama.cpp reporting the file path. */
    alias?: string;
    /** The user's own flags, appended last so they win over the ones computed here. */
    extraArgs?: string;
}

/**
 * Exact argv for the user's `llama-server`. Pure, because this is the command line a developer will read
 * back in the log and reproduce by hand — one wrong spelling and the server refuses to start at all.
 *
 * `--ctx-size 0` (llama.cpp's "take it from the model") is not sent when the caller passes 0/undefined,
 * but `--n-gpu-layers 0` **is**: on llama.cpp that flag is a count, and 0 is the meaningful "GPU offload
 * off" that a shared-memory iGPU wants. Omitting it would leave the default (`auto`) in charge.
 */
export function llamaServerArgs(options: LlamaLaunch): string[] {
    const args = [
        '--model', options.modelPath,
        '--host', options.host ?? '127.0.0.1',
        '--port', String(options.port)
    ];
    if (options.contextSize) args.push('--ctx-size', String(options.contextSize));
    if (options.threads) args.push('--threads', String(options.threads));
    if (options.gpuLayers !== undefined) args.push('--n-gpu-layers', String(options.gpuLayers));
    const alias = String(options.alias ?? '').trim();
    if (alias) args.push('--alias', alias);
    args.push(...splitArgs(options.extraArgs ?? ''));
    return args;
}

/**
 * Did the server refuse a flag we passed?
 *
 * `--alias` and the `--n-gpu-layers` spelling have both moved around in llama.cpp's history, and an
 * unknown flag makes `llama-server` print `invalid argument: …` and exit **immediately** — before any
 * weights are read, which is what makes this recoverable: the caller starts once more without the
 * cosmetic flags, and the user gets a working server instead of a version lecture. A failure that is
 * *not* about our arguments (a missing model file, a bad quantisation) must never be retried this way.
 */
export function isUnknownArgumentFailure(text: string): boolean {
    return /unknown argument|unrecognized (argument|option)|invalid argument|invalid option|error: invalid argument/i
        .test(String(text ?? ''));
}

/** What the server's `/health` says. */
export type HealthVerdict = 'ok' | 'loading' | 'absent' | 'unreachable';

/**
 * `/health` is the only endpoint that distinguishes "listening" from "the weights are in RAM":
 * llama.cpp answers `503 {"error":{"message":"Loading model"}}` while loading and `200 {"status":"ok"}`
 * when ready. `/v1/models` answers immediately with a `null` meta block, so reading *it* as readiness
 * would report a server that cannot answer a request yet.
 *
 * The four verdicts are the four things the caller must do about them: `ok` = go, `loading` = wait,
 * `absent` = an older build with no `/health` (fall back to what the API offers), `unreachable` = nothing
 * is listening on that port yet (keep waiting). `status` 0 is "no answer at all", which `fetch` reports as
 * a throw rather than a response. Pure, so each status is asserted instead of being discovered live.
 */
export function classifyHealth(status: number): HealthVerdict {
    if (status === 200) return 'ok';
    if (status === 503) return 'loading';
    if (status === 0) return 'unreachable';
    // Anything else that *answered* is some other endpoint: a 404 from a build that predates `/health`,
    // or a 401 from one started with an API key.
    return 'absent';
}

/** The recommended settings for the user's own server, with a reason for each. Pure. */
export function recommendedLlamaOptions(
    sizeGb: number,
    facts: Pick<SetupFacts, 'freeRamGb' | 'cpuCount'> & { vramGb?: number }
): { contextSize: number; threads: number; gpuLayers: number; reasons: string[] } {
    const reasons: string[] = [];
    const contextSize = recommendedContextFor(facts.freeRamGb);
    reasons.push(`Context ${contextSize.toLocaleString('en-US')} tokens — sized to the ${Math.max(0, Math.round(facts.freeRamGb))} GB free`);
    // The same decision the LM Studio path makes, from the same place: the card's own VRAM when it is known,
    // the conservative shared-memory rule when it is not (`gpuOffloadFor`).
    const offload = gpuOffloadFor(sizeGb, facts.vramGb);
    const gpuLayers = offload.gpuLayers;
    reasons.push(offload.reason);
    const threads = defaultThreads(facts.cpuCount);
    reasons.push(`${threads} CPU thread(s) — one less than this machine's ${facts.cpuCount} logical cores, which is where llama.cpp is fastest`);
    return { contextSize, threads, gpuLayers, reasons };
}

// ---------------- recognising a llama-server that is already running ----------------
//
// Asked 2026-09-16, and it matters because of what this machine actually runs: the developer's own
// `llama-server` is a **systemd user service** (`~/.config/systemd/user/llama-server.service`) serving a
// 30 B Qwen3-Coder on port 8080 with `--alias my-local-model`. Starting a second one from the extension
// would put another ~17 GB of weights in RAM to answer the same requests. So before any start, the first
// question is "is one already answering?" — and it is answered from the server's own words, not from a
// process list (this extension cannot see a process it did not spawn).

/** The port an endpoint URL means. Pure; undefined when there is no port to read. */
export function endpointPort(endpoint: string): number | undefined {
    const match = /^\s*https?:\/\/[^\s/:]+:(\d{2,5})(?:\/|$)/i.exec(String(endpoint ?? ''));
    if (!match) return undefined;
    const port = Number(match[1]);
    return port > 0 && port < 65536 ? port : undefined;
}

/**
 * What to add to "nothing answered there" when something *is* answering somewhere else.
 *
 * The failure this exists for (2026-10-04): the settings pointed at LM Studio's 1234, a llama-server was
 * running on 8080, and the message said only "No server answered". The user had already seen "Ready. Using
 * the llama-server already running on port 8080" a minute earlier — a stale settings form had overwritten the
 * pin — so a sentence naming both addresses is the difference between a puzzle and a fix.
 *
 * Pure: takes the endpoint that was tried and what a probe found, returns the sentence to append (empty when
 * there is nothing useful to add — a hint that guesses would be worse than silence).
 */
export function endpointMismatchHint(
    triedEndpoint: string,
    running: { port: number; modelId?: string; modelPath?: string } | undefined
): string {
    if (!running) return '';
    if (endpointPort(triedEndpoint) === running.port) return '';
    const name = running.modelPath ? running.modelPath.replace(/\\/g, '/').split('/').pop() : running.modelId;
    return ` A llama-server IS answering on port ${running.port}${name ? ` (${name})` : ''} — the settings point at `
        + `${triedEndpoint || 'no address'}, so the endpoint above is the thing to change.`;
}

/**
 * The ports worth asking about, in order: the one the settings point at (when it is this machine), then
 * llama.cpp's own defaults.
 *
 * 8080 is what `llama-server` has always bound by default, and 9931 is the port its own start-up notice
 * says the default is moving to (seen in this machine's journal, 2026-09-16). Both are checked because the
 * settings are most often still on LM Studio's 1234 while the developer's llama-server runs on 8080.
 */
export function llamaServerPortCandidates(endpoint: string, extra: number[] = []): number[] {
    const ports: number[] = [];
    // A remote address is not probed here: this lookup asks **127.0.0.1**, so reusing a port taken from
    // `https://build-box:8080/v1` would test a different machine's port on this one and could report a
    // local server as if it were the endpoint the user configured.
    const local = isLocalEndpoint(endpoint) ? endpointPort(endpoint) : undefined;
    for (const port of [local, ...extra, 8080, 9931]) {
        if (port !== undefined && !ports.includes(port)) ports.push(port);
    }
    return ports;
}

/** True when an endpoint names this machine (or no host at all). Pure — a remote endpoint is not ours to probe. */
export function isLocalEndpoint(endpoint: string): boolean {
    const host = /^\s*https?:\/\/([^/:?#\s]+)/i.exec(String(endpoint ?? ''))?.[1];
    if (!host) return true;
    return /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(host);
}

/** One model as a llama-server reports it in `/v1/models` (real answer, 2026-09-16). */
export interface ServedModel {
    id: string;
    /** llama.cpp fills this in as `llamacpp` — LM Studio and Ollama do not. */
    ownedBy: string;
    /** `meta.n_ctx` — the context the running server was started with. */
    contextSize?: number;
}

/**
 * Reads `/v1/models`. Real answer from this machine's service (2026-09-16):
 *
 *   {"object":"list","data":[{"id":"my-local-model","object":"model","created":1789569219,
 *     "owned_by":"llamacpp","meta":{"n_ctx":16384,"n_params":30532122624,"ftype":"Q4_K - Small"}}]}
 *
 * `owned_by` is the identifier that makes this safe to act on: it is llama.cpp's own marker, so a server
 * answering here is *known* to be a llama-server rather than guessed from the port being 8080.
 */
export function parseServedModels(apiAnswer: unknown): ServedModel[] {
    const data = (apiAnswer as { data?: unknown })?.data;
    if (!Array.isArray(data)) return [];
    const out: ServedModel[] = [];
    for (const entry of data) {
        const e = entry as { id?: unknown; owned_by?: unknown; meta?: { n_ctx?: unknown } };
        if (typeof e?.id !== 'string' || !e.id) continue;
        out.push({
            id: e.id,
            ownedBy: typeof e.owned_by === 'string' ? e.owned_by : '',
            contextSize: typeof e.meta?.n_ctx === 'number' ? e.meta.n_ctx : undefined
        });
    }
    return out;
}

/** True when this `/v1/models` answer came from llama.cpp. Pure. */
export function isLlamaServerModels(apiAnswer: unknown): boolean {
    return parseServedModels(apiAnswer).some((m) => /^llamacpp$/i.test(m.ownedBy));
}

/** The parts of `GET /props` that identify a running llama-server and what it has loaded. */
export interface LlamaProps {
    modelPath?: string;
    buildInfo?: string;
    totalSlots?: number;
}

/**
 * Reads `/props`, which is llama.cpp's own endpoint (no OpenAI equivalent): real answer from this machine
 * (2026-09-16) carries `model_path`, `build_info: "b1234-abcdef"` and `total_slots: 1`. A second
 * identity check on purpose — `/v1/models` is what the client uses, and a server that answers *both* the
 * OpenAI shape and this one is a llama-server beyond argument.
 */
export function parseLlamaProps(body: unknown): LlamaProps {
    const o = (body ?? {}) as { model_path?: unknown; build_info?: unknown; total_slots?: unknown };
    return {
        modelPath: typeof o.model_path === 'string' && o.model_path ? o.model_path : undefined,
        buildInfo: typeof o.build_info === 'string' && o.build_info ? o.build_info : undefined,
        totalSlots: typeof o.total_slots === 'number' ? o.total_slots : undefined
    };
}

/**
 * The scanned files worth offering, given whether LM Studio is already offering its own.
 *
 * A `.gguf` inside LM Studio's folder is also listed by `lms ls` as a model key, so when that list is
 * answering, the file would be a second entry for the same weights. When it is *not* answering — the `lms`
 * binary is installed but its daemon will not start, which is a state a real machine was found in on
 * 2026-10-04 — those files are the only route to a model the user already downloaded, so all are offered.
 */
export function filesOfferedForSelection<T extends { inLmStudio: boolean }>(
    files: readonly T[],
    lmStudioHasModels: boolean
): T[] {
    return lmStudioHasModels ? files.filter((f) => !f.inLmStudio) : files.slice();
}

// ---------------- installing llama.cpp when this machine has none (asked 2026-10-04) ----------------
//
// *"If the server or the 27B model is not on the host machine the extention must offer to download and
// install."* Until now the honest-but-useless answer when no `llama-server` was found was "install llama.cpp
// yourself" — a sentence that tells a novice to compile C++ before they can use the feature they were just
// offered. llama.cpp publishes a prebuilt server for every platform it supports, so the offer is now a
// download.
//
// WHICH FILE, EXACTLY. The release page carries 35 assets, most of them GPU builds (cuda, rocm, vulkan,
// sycl, openvino) plus Android, iOS and s390x. The names have a fixed shape, read from the real release list
// fetched on 2026-10-04:
//
//     llama-b11384-bin-ubuntu-x64.tar.gz          17.7 MB   ← the one this picks on Linux x64
//     llama-b11384-bin-macos-arm64.tar.gz         11.9 MB
//     llama-b11384-bin-win-cpu-x64.zip            19.4 MB
//     llama-b11384-bin-ubuntu-vulkan-x64.tar.gz   31.6 MB   ← never picked: a GPU build is a request this
//     cudart-llama-b11384-bin-ubuntu-cuda-12.8-x64.tar.gz      extension cannot verify the driver for, and
//                                                              the CPU build is what runs everywhere.
//
// THE HASH COMES FROM THE API, not from the release page: each asset carries `digest: "sha256:…"`, which is
// the same kind of promise the model download verifies against. A release that carries no digest is not
// offered — an unverifiable 18 MB download that then has to be executed is not a risk worth taking.

/** One downloadable file on a GitHub release. */
export interface ReleaseAsset {
    name: string;
    url: string;
    bytes: number;
    /** The `sha256:<hex>` the API reports, or empty when this release has no digest for it. */
    digest: string;
}

export interface LlamaRelease {
    tag: string;
    assets: ReleaseAsset[];
}

/** The GitHub API call that answers "what prebuilt llama.cpp builds are there?" */
export function llamaReleasesApiUrl(repo = 'ggml-org/llama.cpp'): string {
    // NOT `/releases/latest`, and that cost a real debugging round on 2026-10-04: on llama.cpp "latest" is
    // the tagged `v0.5.0` release, whose only asset is `nightly-tag.txt` — the actual binaries ship under
    // `bNNNNN` tags, which that endpoint does not return. Asking for the list and choosing from it is the
    // only way to get a file that can be run.
    return `https://api.github.com/repos/${repo}/releases?per_page=20`;
}

/** The hex half of a GitHub `digest` field (`sha256:abc…` → `abc…`), or empty. */
export function digestHex(digest: string): string {
    const m = /^sha256:([0-9a-f]{64})$/i.exec(String(digest ?? '').trim());
    return m ? m[1]!.toLowerCase() : '';
}

/** One entry of that list: the tag, and the files published under it. */
export function parseReleases(apiAnswer: unknown): LlamaRelease[] {
    if (!Array.isArray(apiAnswer)) return [];
    const out: LlamaRelease[] = [];
    for (const raw of apiAnswer) {
        const o = (raw ?? {}) as { tag_name?: unknown; assets?: unknown };
        const tag = typeof o.tag_name === 'string' ? o.tag_name.trim() : '';
        if (!tag || !Array.isArray(o.assets)) continue;
        const assets: ReleaseAsset[] = [];
        for (const entry of o.assets) {
            const a = entry as { name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown };
            if (typeof a?.name !== 'string' || typeof a.browser_download_url !== 'string') continue;
            assets.push({
                name: a.name,
                url: a.browser_download_url,
                bytes: typeof a.size === 'number' ? a.size : 0,
                digest: typeof a.digest === 'string' ? a.digest : ''
            });
        }
        out.push({ tag, assets });
    }
    return out;
}

/**
 * The newest release with a runnable, verifiable prebuilt server for this machine.
 *
 * The list is newest-first, and a release is used only when it has **both** the asset this platform needs and
 * a `sha256:` digest to check it against. That is what makes the `v0.5.0` entry harmless: it is at the top of
 * the list, it has no binary at all, and it is simply passed over rather than reported as "llama.cpp has no
 * build for you".
 */
export function installReleaseFor(
    apiAnswer: unknown,
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch
): { tag: string; asset: ReleaseAsset } | undefined {
    for (const release of parseReleases(apiAnswer)) {
        const asset = installAssetFor(release.assets, platform, arch);
        if (asset && digestHex(asset.digest)) return { tag: release.tag, asset };
    }
    return undefined;
}

/**
 * The prebuilt asset for this platform and architecture, or undefined when llama.cpp does not publish one.
 *
 * The suffix is the whole test. `-bin-ubuntu-x64.tar.gz` cannot match the Vulkan build (which ends
 * `-bin-ubuntu-vulkan-x64.tar.gz`), and the GPU flavours are excluded by name as well, because a *future*
 * release could name one in a way that collides — and picking a CUDA build on a machine with no CUDA driver
 * is a failure that arrives as "the server stopped immediately" with no hint of why.
 */
export function installAssetFor(
    assets: readonly ReleaseAsset[],
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch
): ReleaseAsset | undefined {
    const suffix =
        platform === 'linux' && arch === 'x64' ? '-bin-ubuntu-x64.tar.gz'
            : platform === 'linux' && arch === 'arm64' ? '-bin-ubuntu-arm64.tar.gz'
                : platform === 'darwin' && arch === 'arm64' ? '-bin-macos-arm64.tar.gz'
                    : platform === 'darwin' && arch === 'x64' ? '-bin-macos-x64.tar.gz'
                        : platform === 'win32' && arch === 'x64' ? '-bin-win-cpu-x64.zip'
                            : platform === 'win32' && arch === 'arm64' ? '-bin-win-cpu-arm64.zip'
                                : undefined;
    if (!suffix) return undefined;
    const unusable = /cuda|rocm|vulkan|sycl|openvino|opencl|cudart|android|xcframework|s390x/i;
    return assets.find((a) => a.name.startsWith('llama-') && a.name.endsWith(suffix) && !unusable.test(a.name) && a.bytes > 0);
}

/** `tar.gz` or `zip` — the two shapes llama.cpp publishes, and the two `tar` knows how to unpack. */
export function archiveKind(name: string): 'tar.gz' | 'zip' {
    return /\.zip$/i.test(String(name ?? '')) ? 'zip' : 'tar.gz';
}

/**
 * The argv that unpacks one of those two, with the system `tar`.
 *
 * Deliberately not a Node zip reader: this project has no dependencies, gzip is in Node but zip is not, and
 * `tar` is present on every platform that can run VS Code — macOS and Linux always, and Windows since 10
 * ships bsdtar as `tar.exe`, which reads `.zip` as well. `-xzf` vs `-xf` is the only difference (bsdtar
 * infers gzip on its own, GNU tar needs to be told).
 */
export function extractArgs(archive: string, intoDir: string): string[] {
    return archiveKind(archive) === 'zip' ? ['-xf', archive, '-C', intoDir] : ['-xzf', archive, '-C', intoDir];
}

/** What the binary is called on this platform — the one name that differs between them. */
export function llamaBinaryName(platform: NodeJS.Platform = process.platform): string {
    return platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

/**
 * The `llama-server` inside an archive, from its own file listing (`tar -tzf`).
 *
 * The prebuilt archives extract into a folder named after the tag (`llama-b11384/llama-server`) beside a
 * dozen shared libraries that must stay next to it. So the *directory* of the winner is what the caller
 * keeps, and the shallowest match wins: a nested copy (`…/bin/llama-server`) is not the one the `.so` files
 * sit beside.
 */
export function pickBinaryFromListing(listing: readonly string[], platform: NodeJS.Platform = process.platform): string | undefined {
    const wanted = llamaBinaryName(platform);
    const depth = (entry: string): number => entry.replace(/\\/g, '/').split('/').length;
    const hits = listing
        .map((entry) => String(entry ?? '').trim())
        .filter((entry) => entry.split('/').pop() === wanted)
        .sort((a, b) => depth(a) - depth(b));
    return hits[0];
}

/**
 * Where the `llama-server` of one installed release may be, given that folder's own listing.
 *
 * The prebuilt archives unpack into a folder named after their tag, and the binary sits either directly in it
 * (`<tag>/llama-server`) or one level down (`<tag>/llama-b11384/llama-server`) — the second is what the
 * current releases do, and both are accepted because the archive's own root has changed between builds. Pure
 * (`entries` is a directory listing), so the layout is pinned by a test instead of by whichever release the
 * machine happened to fetch.
 */
export function installedLlamaServerCandidates(
    dir: string,
    entries: readonly string[],
    platform: NodeJS.Platform = process.platform
): string[] {
    const wanted = llamaBinaryName(platform);
    const join = (a: string, b: string): string => `${a.replace(/[\\/]+$/, '')}/${b}`;
    const direct = join(dir, wanted);
    // Every entry is offered as a possible folder, because a flat listing cannot say which entries are
    // directories — and guessing from the name (`llama-*`) is wrong in the way that matters: a release whose
    // listing starts with `llama-cli` would stop the search before the real subfolder was tried. The caller
    // checks each candidate's existence, so a wrong guess costs one `stat`, not a missed install.
    return [direct, ...entries.filter((e) => e !== wanted).map((e) => join(join(dir, e), wanted))];
}

/** The line the install offer shows: what will be fetched, and what it costs. */
export function installOfferLine(asset: ReleaseAsset): string {
    return `llama.cpp's own prebuilt server for this machine — ${asset.name} (${formatBytes(asset.bytes)})`;
}

// ---------------- getting a server up when the request had nowhere to go (asked 2026-10-04) ----------------
//
// *"This extension must not rely on the user to have a llama.cpp server installed. If the server is installed
// on the host, just start it and use it. If not, offer installation to the user."*
//
// The offer to install existed, and the palette flow could start a server — but the *request* paths (the chat
// view, implement/fix/repair) still ended at "No server answered" when the configured address was dead. So a
// prompt that failed went on failing, however much llama.cpp was sitting on the disk: the one moment the user
// needed the extension to act was the one moment it only complained about. These are the rules for acting
// instead, and they are decisions of text alone, so they are pinned here rather than in the click handler.

/** What to do about a request that could not reach its endpoint. */
export type EndpointRescue =
    /** A llama-server is already answering on another local port — use it. */
    | 'use-running'
    /** A `llama-server` binary is available — start it with the model the settings already know. */
    | 'start-own'
    /** No binary on this machine — ask the user whether to fetch llama.cpp. */
    | 'offer-install'
    /** Not our business: leave the failure alone. */
    | 'none';

/**
 * Whether a failed request should be rescued by getting a llama-server up — and how.
 *
 * The three refusals matter more than the two actions:
 *
 *   - **only for `external`.** A `bundled` failure is the extension's own runtime's problem (it has its own
 *     retry and its own message), and an LM Studio failure is that program's to explain. Starting a
 *     llama-server because the sidecar would not build would be a surprise, not a rescue.
 *   - **only for a local address.** A remote endpoint (`http://build-box:8080/v1`) that is down must not make
 *     this machine start anything: the user pointed at another computer on purpose, and a local process would
 *     answer questions they never asked of it.
 *   - **only for "nothing answered".** A `400`, a context overflow or a cancelled request are not solved by
 *     starting a server, and retrying them would only waste the user's time.
 *
 * `canInstall` is the caller's answer to "could this machine install one at all?" — false when llama.cpp
 * publishes nothing for the platform, so the user is not offered a download that cannot happen.
 */
export function endpointRescuePlan(input: {
    /** The address the settings point at. */
    endpoint: string;
    /** `external`, `bundled`, `lmstudio` or `off`. */
    backend: string;
    /** The failure, as the client worded it. */
    message: string;
    /** True when a `llama-server` can be run (the setting, PATH, a build folder, or our own install). */
    binaryFound: boolean;
    /** The port of a llama-server found answering elsewhere, when one was. */
    runningPort?: number;
    /** False when this platform has no prebuilt server to fetch. */
    canInstall?: boolean;
}): EndpointRescue {
    if (String(input.backend ?? '').trim() !== 'external') return 'none';
    if (!isNoAnswerError(input.message)) return 'none';
    if (!isLocalEndpoint(input.endpoint)) return 'none';
    if (input.runningPort !== undefined && input.runningPort !== endpointPort(input.endpoint)) return 'use-running';
    if (input.binaryFound) return 'start-own';
    return input.canInstall === false ? 'none' : 'offer-install';
}

// ---------------- which model the user's own server should run (asked 2026-10-04) ----------------

/** Where the `.gguf` for the user's own server came from, which is what decides whether to ask again. */
export type OwnServerModelSource = 'setting' | 'known' | 'none';

/**
 * The model to serve, without asking anything — or `none`, which means "ask".
 *
 * The rule is "only ask what we do not already know", and it is what makes *"the extension must start the
 * llama.cpp server and load the weights automatically"* true on the second run and every one after it:
 *
 *   1. the `llamaServerModelPath` setting, when the file is there and it is **not** one of the bundled
 *      runtime's own models — a real choice made for this server, so it is honoured without a word;
 *   2. the known 27B, when a copy is anywhere on this machine (extension storage, LM Studio's folder, the
 *      Hub cache, an external drive) — the model this feature exists for;
 *   3. nothing, and then the caller asks: a picker of the files found, the download offer, or both.
 *
 * WHY `pinnedIsBundled` EXISTS. `modelPath` is the **bundled runtime's** pin — the panel marks a built-in
 * entry as loaded by comparing it with `modelPath`, and `chooseLocalModel` writes it when the extension's own
 * model is chosen. It used to be borrowed by this path too, which on a real machine meant the user's own
 * llama-server started the 4.4 GB Qwen2.5-Coder the *built-in* runtime had been set up with, silently, when
 * what they had asked for was the 27B (found 2026-10-04: `modelPath` held the Designer's copy of the shipped
 * 7B). A file the bundled runtime knows by name is therefore not an answer to *this* question, and falls
 * through to the picker — which still lists it, because it is a perfectly good model to pick.
 *
 * A pinned path that no longer exists is not used and not an error here: it falls through, and the caller's
 * picker will say the file is gone if it comes to that.
 */
export function ownServerModelPreference(input: {
    /** The `llamaServerModelPath` setting. */
    pinned?: string;
    /** True when that setting names one of the bundled runtime's own models (`MODEL_SPECS`/the user's added ones). */
    pinnedIsBundled?: boolean;
    /** A verified copy of the known 27B already on this machine, if one was found. */
    known?: string;
    exists: (path: string) => boolean;
    platform?: NodeJS.Platform;
}): { path?: string; source: OwnServerModelSource } {
    const gguf = (p: string | undefined): p is string => !!p && /\.gguf$/i.test(p) && input.exists(p);
    if (!input.pinnedIsBundled && gguf(input.pinned)) return { path: input.pinned, source: 'setting' };
    if (gguf(input.known)) return { path: input.known, source: 'known' };
    return { source: 'none' };
}
