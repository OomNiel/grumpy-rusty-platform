/**
 * Can this machine actually run a local model — checked once when the extension starts.
 *
 * The AI assist is the one feature whose usefulness depends on the machine it runs on: a local model needs
 * memory *available right now*, and on a machine without any of it the feature would only produce a slow
 * failure. Asked for on 2026-09-17: *"the extension must check the resources of the host pc. If it has less
 * than 32 GB ram and an integrated GPU, or less than 16 GB ram and a separate GPU with less than 4 GB VRAM,
 * the AI assistance feature must be greyed out with an explanation."*
 *
 * Two decisions were taken with the user (same day), because the rules as first stated would have greyed the
 * feature out on **their own machine** (28 GB RAM, integrated Radeon 760M) — the box that loads a 3B model in
 * 602 ms on Vulkan:
 *
 *  1. **Gate on memory AVAILABLE, not total.** `freeRamGb` (plus the VRAM of a real discrete card, which is
 *     genuinely separate memory) against the smallest supported model's own requirement — the same
 *     `minRamGb` the per-model fit check uses, so the two can never disagree. An integrated GPU's
 *     `mem_info_vram_total` is a carve-out *out of* system RAM and is deliberately not added: counting it
 *     would count the same gigabytes twice.
 *  2. **An escape hatch.** The section is greyed out with the reason, and the explanation offers
 *     "Use it anyway" — an eGPU, an undetected card or a machine that runs a 1B model fine must not lock the
 *     user out of their own computer. That is a setting (`assistant.ignoreHostCheck`), and it is logged.
 *
 * The memory *warning* (their point 3) is separate and softer: a machine that may run the feature but with
 * little headroom is told so, in the AI section and once when a model is started — never blocked.
 *
 * Everything here is pure except `probeGpu()` (which spawns three platform tools) and the settings read, so
 * the whole verdict is asserted in the suite with fixture strings instead of real hardware.
 */
import * as os from 'os';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { assessHardware, readHardwareFacts, type HardwareFacts } from './assistant';

/**
 * The memory a local model needs while it runs — the floor at which the AI assist is worth trying at all.
 *
 * It is deliberately **not** the shipped model's `minRamGb` (the pinned 7B asks for 16 GB): the table is a
 * menu, not a fence, and *AI: Add a Model from Hugging Face…* can add a smaller model that runs under this.
 * Greying the whole section out for a machine that could still run one would be the wrong way round
 * (re-checked 2026-09-17, when the table was trimmed to one model).
 */
export const AI_MIN_AVAILABLE_GB = 8;
/** Below this much memory there is little headroom for a model *and* the rest of the session: warn. */
export const AI_WARN_AVAILABLE_GB = 20;

export interface GpuFacts {
    kind: 'none' | 'integrated' | 'discrete';
    /** What the tool reported, for the explanation ("AMD Radeon 760M"). Empty when nothing was found. */
    name: string;
    /** Dedicated VRAM in GB, when the probe could read it. 0 = unknown or shared. */
    vramGb: number;
    /** How it was decided, so a wrong verdict can be traced: `nvidia-smi`, `lspci`, `sysfs`, `powershell`… */
    source: string;
}

export interface HostGate {
    /** False = the AI section is greyed out (unless the escape hatch is on). */
    aiAllowed: boolean;
    /** The memory a model could actually use: free RAM + a discrete card's VRAM. */
    availableGb: number;
    /** True when the run was allowed by the escape hatch, not by the hardware. */
    overridden: boolean;
    gpu: GpuFacts;
    hardware: HardwareFacts;
    /** One line per reason, ready to show. Empty when everything is fine. */
    reasons: string[];
    /** Set when the machine is allowed but tight on memory (the user's "20 GB" warning). */
    warning?: string;
}

/** Raw text a platform tool produced; `undefined` when the tool is not there or failed. */
export interface GpuProbeOutput {
    platform: NodeJS.Platform;
    /** `lspci -mm` — Linux. */
    lspci?: string;
    /** `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader` — any OS with the driver. */
    nvidiaSmi?: string;
    /** Highest `mem_info_vram_total` seen on any DRM card, in GB (Linux sysfs; APUs included). */
    sysfsVramGb?: number;
    /** Windows: `Win32_VideoController` as `name|adapterRamBytes` lines. */
    winControllers?: string[];
    /** macOS: `system_profiler -json SPDisplaysDataType` output. */
    macDisplays?: string;
    /** `os.cpus()[0].model` — the fallback for telling an APU from a card when names are all we have. */
    cpuModel?: string;
}

/**
 * Names that mean "this is a card with its own memory".
 *
 * A POSITIVE list on purpose, and this is the important half of the design: the probe only credits VRAM to a
 * device it can positively identify as a card. An unknown name — an APU whose `lspci` entry is
 * `AMD Device 14e8`, a new card the `pci.ids` database does not know yet — is treated as integrated, which
 * means no memory is added to the budget. That direction can only under-count, never let a machine through on
 * memory it does not have. (Found the hard way: the first version used a list of *integrated* names and got
 * the user's own APU wrong the moment `lspci` stopped recognising it.)
 */
const DISCRETE_HINTS = [
    'geforce', 'rtx', 'gtx', 'quadro', 'tesla', 'nvidia', 'radeon rx', 'radeon pro', 'firepro', 'instinct',
    'intel arc', 'arc a', 'arc b', 'arc pro'
];

function looksDiscrete(name: string): boolean {
    const lower = name.toLowerCase();
    return DISCRETE_HINTS.some((hint) => lower.includes(hint));
}

/** Tokens that make a device name worth showing a user (`AMD/ATI Phoenix1`, `GeForce RTX 3060`). */
const DESCRIPTIVE = /radeon|geforce|rtx|gtx|intel|arc|vega|phoenix|graphics|nvidia|amd|ati|adreno|apple/i;

/**
 * Turns what the tools printed into one verdict. Pure, so every branch is a test rather than a machine.
 *
 * Order matters: an NVIDIA card answers `nvidia-smi` and is never integrated; then known integrated names;
 * then a device that reports 4 GB or more of its own memory must be a card; anything else is treated as
 * integrated (the conservative direction — it only means no VRAM is added to the memory budget).
 */
export function classifyGpu(raw: GpuProbeOutput): GpuFacts {
    // 1) `nvidia-smi` is authoritative when it answers: an NVIDIA card is never an integrated GPU, and it is
    //    the one tool that reports VRAM reliably on every platform where the driver is installed.
    const nvidia = (raw.nvidiaSmi ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean); if (nvidia.length > 0) {
        const [name, mem] = nvidia[0]!.split(',').map((s) => (s ?? '').trim());
        const mib = Number((mem ?? '').replace(/[^0-9.]/g, ''));
        return {
            kind: 'discrete',
            name: name || 'NVIDIA GPU',
            vramGb: Number.isFinite(mib) ? mib / 1024 : 0,
            source: 'nvidia-smi'
        };
    }

    // 2) Everything else the platform tools can see, with a size when one of them reports one.
    const devices: { name: string; vramGb: number; source: string }[] = [];
    for (const line of (raw.lspci ?? '').split(/\r?\n/)) {
        // `01:00.0 "VGA compatible controller" "NVIDIA Corporation" "GA106 [GeForce RTX 3060]"`.
        // The CLASS has to be checked: `lspci` lists every PCI device, and `AMD Family 19h USB4/Thunderbolt
        // PCIe tunnel` matched the vendor list happily and became "the GPU" (seen on the user's box).
        const m = /"([^"]*)"\s+"([^"]*)"\s+"([^"]*)"/.exec(line);
        if (!m || !/vga|3d|display/i.test(m[1]!)) continue;
        devices.push({ name: `${m[2]} ${m[3]}`.trim(), vramGb: 0, source: 'lspci' });
    }
    for (const line of raw.winControllers ?? []) {
        const [name, bytes] = line.split('|');
        const gb = bytes ? Number(bytes) / 1024 ** 3 : 0;
        devices.push({
            name: (name ?? '').trim(),
            // `AdapterRAM` is a 32-bit field and saturates at 4 GB minus a byte, so a 12 GB card is reported as
            // 3.999… GB. A value at the ceiling therefore means *unknown*, not "4 GB" — reading it as a size
            // would have made every Windows card look like it had 3 GB and no card would ever be credited.
            vramGb: Number.isFinite(gb) && gb >= 3.9 && gb <= 4 ? 0 : gb,
            source: 'powershell'
        });
    }
    if (raw.macDisplays) {
        for (const m of raw.macDisplays.matchAll(/"sppci_model"\s*:\s*"([^"]+)"/g)) {
            devices.push({ name: m[1]!, vramGb: 0, source: 'system_profiler' });
        }
    }
    const sysfs = raw.sysfsVramGb ?? 0;
    if (devices.length === 0 && sysfs <= 0) return { kind: 'none', name: '', vramGb: 0, source: 'none' };

    // 3) The device that decides is a card if there is one, else the best-named device: `lspci` happily emits
    //    `AMD Device 14e8` next to `AMD/ATI Phoenix1`, and "Device 14e8" tells the user nothing.
    const solid = devices.filter((d) => !/\bdevice [0-9a-f]{4}\b/i.test(d.name));
    const hit = solid.find((d) => looksDiscrete(d.name))
        ?? solid.find((d) => DESCRIPTIVE.test(d.name))
        ?? solid[0]
        ?? devices[0];
    const name = hit?.name ?? 'GPU (name not reported)';
    const vramGb = Math.max(sysfs, hit?.vramGb ?? 0);

    // 4) A card is a card when its NAME identifies one — and, when a size is known at all, it has at least the
    //    4 GB the user drew. A card whose size could not be read (Windows `AdapterRAM` saturation) is still a
    //    card, it simply contributes no VRAM to the budget. Anything else counts as integrated, which only ever
    //    means less memory is credited.
    const sized = vramGb > 0;
    const kind = looksDiscrete(name) && (!sized || vramGb >= 4) ? 'discrete' : 'integrated';
    return { kind, name, vramGb, source: hit?.source ?? 'sysfs' };
}

/**
 * The verdict. Composes the existing hardware assessment (CPU, AVX2, total-RAM floor) with the memory that
 * is actually available, so a machine that fails either way is refused with the reason that applies.
 */
export function assessHost(hardware: HardwareFacts, gpu: GpuFacts, overridden = false): HostGate {
    const base = assessHardware(hardware);
    // Only a real card's memory is separate memory. An APU's VRAM is a carve-out of the RAM counted above.
    const vram = gpu.kind === 'discrete' && gpu.vramGb >= 4 ? gpu.vramGb : 0;
    const availableGb = hardware.freeRamGb + vram;

    const reasons: string[] = [];
    if (!base.ok) {
        reasons.push(...base.reasons);
    } else if (availableGb < AI_MIN_AVAILABLE_GB) {
        reasons.push(
            `${availableGb.toFixed(1)} GB of memory is available to a model right now (${hardware.freeRamGb.toFixed(1)} GB free`
            + `${vram > 0 ? ` + ${vram.toFixed(1)} GB VRAM` : ''}) and the smallest supported model needs about `
            + `${AI_MIN_AVAILABLE_GB} GB. Close some applications and re-check.`
        );
        if (gpu.vramGb > 0 && gpu.vramGb < 4 && gpu.name) {
            reasons.push(
                `${gpu.name} has ${gpu.vramGb.toFixed(1)} GB VRAM, under the 4 GB a model plus context needs, `
                + 'so it is treated as no help.'
            );
        }
    }

    const allowed = reasons.length === 0;
    const gate: HostGate = {
        aiAllowed: allowed || overridden,
        availableGb,
        overridden: !allowed && overridden,
        gpu,
        hardware,
        reasons
    };
    if (gate.aiAllowed && availableGb < AI_WARN_AVAILABLE_GB) {
        gate.warning =
            `Only ${availableGb.toFixed(1)} GB of memory is available to a model`
            + `${vram > 0 ? ` (${hardware.freeRamGb.toFixed(1)} GB free RAM + ${vram.toFixed(1)} GB VRAM)` : ''}. `
            + 'That is enough for the smallest models, but a larger one may be slow or fail to load — '
            + 'close some applications or pick the 3B model.';
    }
    return gate;
}

/** One sentence for every place that has to refuse: the same words in the panel, a toast and the log. */
export function hostBlockMessage(gate: HostGate): string {
    const why = gate.reasons[0] ?? `This machine does not meet the local model requirements (${AI_MIN_AVAILABLE_GB} GB available memory).`;
    return `The AI assist is disabled on this machine: ${why} `
        + 'You can override the check in the designer\'s Code Fix/AI-Assist Settings (⚙ in the toolbar) → AI assist.';
}

// ---------------- the probe (the only part that touches the machine) ----------------

function run(cmd: string, args: string[], timeout = 4000): Promise<string | undefined> {
    return new Promise((resolve) => {
        try {
            cp.execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
                resolve(err && !stdout ? undefined : String(stdout ?? '').trim() || undefined);
            });
        } catch {
            resolve(undefined);
        }
    });
}

/** Highest VRAM any DRM card reports (GB). Readable without root on most systems; absent on many. */
function sysfsVramGb(): number {
    let best = 0;
    try {
        for (const card of fs.readdirSync('/sys/class/drm').filter((c) => /^card\d+$/.test(c))) {
            try {
                const bytes = Number(fs.readFileSync(`/sys/class/drm/${card}/device/mem_info_vram_total`, 'utf8').trim());
                if (Number.isFinite(bytes)) best = Math.max(best, bytes / 1024 ** 3);
            } catch { /* not every card exposes it, and it can be root-only */ }
        }
    } catch { /* not Linux, or no DRM */ }
    return best;
}

/** What the platform tools say. Linux is the supported platform; the others are best effort. */
export async function probeGpu(): Promise<GpuFacts> {
    const platform = process.platform;
    const cpuModel = os.cpus()[0]?.model ?? '';
    const raw: GpuProbeOutput = { platform, cpuModel };
    raw.nvidiaSmi = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader']);
    if (platform === 'linux') {
        raw.lspci = await run('lspci', ['-mm']);
        raw.sysfsVramGb = sysfsVramGb();
    } else if (platform === 'win32') {
        const out = await run('powershell', ['-NoProfile', '-Command',
            '(Get-CimInstance Win32_VideoController) | ForEach-Object { "$($_.Name)|$($_.AdapterRAM)" }']);
        raw.winControllers = (out ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    } else if (platform === 'darwin') {
        raw.macDisplays = await run('system_profiler', ['-json', 'SPDisplaysDataType'], 8000);
    }
    return classifyGpu(raw);
}

let cached: HostGate | undefined;
let probing: Promise<HostGate> | undefined;

/** The escape hatch (`assistant.ignoreHostCheck`), read the same way everywhere. */
export function hostCheckIgnored(): boolean {
    try {
        return vscode.workspace.getConfiguration('rustyPlatform').get<boolean>('assistant.ignoreHostCheck', false);
    } catch {
        return false;
    }
}

/**
 * The verdict, probed once per session and then cached — the GPU probe spawns up to three processes, and the
 * answer cannot change while VS Code is running. `fresh` re-probes (the status dialog and the "re-check" link).
 */
export async function hostGate(fresh = false): Promise<HostGate> {
    if (fresh) {
        cached = undefined;
        probing = undefined;
    }
    if (cached) return cached;
    if (!probing) {
        probing = (async () => {
            const gpu = await probeGpu();
            const gate = assessHost(readHardwareFacts(), gpu, hostCheckIgnored());
            cached = gate;
            return gate;
        })();
    }
    return probing;
}

/** The verdict when it is already known (the webview may ask before the probe finished). */
export function hostGateIfKnown(): HostGate | undefined {
    return cached;
}

/** Test seam. */
export function clearHostGate(): void {
    cached = undefined;
    probing = undefined;
}
