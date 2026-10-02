import type { ExecFn, ExecResult } from '../util/exec';
import { execFileFn, findExecutable } from '../util/exec';
import { boardById } from '../boards/catalog';

/**
 * Toolchain detection. No `vscode` import: everything here runs in plain Node and
 * is exercised by the t2-cli test layer using fake `cargo` / `rustup` / `probe-rs`
 * shims placed on PATH.
 */

export interface ToolStatus {
    name: string;
    found: boolean;
    version?: string;
    path?: string;
    detail?: string;
}

export interface ProbeInfo {
    index: number;
    name: string;
    /** probe-rs selector, usable with `--probe`. */
    selector: string;
    protocol: string;
}

export type ProbeDiagnosisKind =
    | 'ok'
    | 'chip-not-autodetected'
    | 'none-connected'
    | 'firmware-outdated'
    | 'permission-denied'
    | 'no-target'
    | 'unknown';

export interface ProbeDiagnosis {
    kind: ProbeDiagnosisKind;
    message: string;
    /** Raw tool output, kept for the "Show log" affordance. */
    raw?: string;
}

export interface ToolchainStatus {
    platform: NodeJS.Platform;
    rustup: ToolStatus;
    cargo: ToolStatus;
    probeRs: ToolStatus;
    installedTargets: string[];
    /** Targets required by the boards we support that are not installed. */
    missingTargets: string[];
    probes: ProbeInfo[];
    probeDiagnosis: ProbeDiagnosis;
    /** Linux only: whether a probe-rs udev rule is present. */
    udevRulesPresent: boolean;
    /** True when a project can be built and flashed. */
    ready: boolean;
}

export interface DetectOptions {
    cargoPath?: string;
    rustupPath?: string;
    probeRsPath?: string;
    /** Target triples that must be installed (defaults to the board catalog). */
    requiredTargets: string[];
    /** Injectable for tests; defaults to a real `fs.existsSync` check. */
    udevRulesPresent?: () => boolean;
}

const UDEV_RULE_PATHS = ['/etc/udev/rules.d/69-probe-rs.rules', '/etc/udev/rules.d/99-probe-rs.rules'];

function firstLine(text: string): string {
    return text.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';
}

/** `cargo 1.99.0 (5f94df478 2026-08-27)` -> `1.99.0`. */
export function parseVersion(output: string): string | undefined {
    const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output);
    return match?.[1];
}

/** Parses `rustup target list --installed` (one triple per line). */
export function parseTargetList(output: string): string[] {
    return output
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('info:') && l.includes('-'));
}

/**
 * Parses `probe-rs list`:
 *
 *   The following debug probes were found:
 *   [0]: Debug Probe (CMSIS-DAP) -- 2e8a:000c-0:E6614103E74B072F (CMSIS-DAP)
 */
export function parseProbeList(output: string): ProbeInfo[] {
    const probes: ProbeInfo[] = [];
    const re = /^\[(\d+)\]:\s+(.+?)\s+--\s+(\S+)\s*\(([^)]*)\)\s*$/;
    for (const line of output.split(/\r?\n/)) {
        const match = re.exec(line.trim());
        if (!match) {
            continue;
        }
        const [, index, name, selector, protocol] = match;
        probes.push({
            index: Number(index),
            name: (name ?? '').trim(),
            selector: selector ?? '',
            protocol: (protocol ?? '').trim(),
        });
    }
    return probes;
}

/**
 * Turns `probe-rs info` / probe-open failures into an actionable diagnosis.
 * Strings are matched against real probe-rs output; see NOTES.md for samples.
 */
export function classifyProbeError(stderr: string): ProbeDiagnosis {
    const text = stderr.trim();
    if (text === '') {
        return { kind: 'ok', message: 'Debug probe is reachable.' };
    }
    if (/firmware on the probe is outdated|minimum supported firmware version/i.test(text)) {
        const min = /minimum supported firmware version is ([0-9.]+)/i.exec(text)?.[1];
        return {
            kind: 'firmware-outdated',
            message: min
                ? `Debug Probe firmware is older than ${min}. Update it from raspberrypi/debugprobe (BOOTSEL + debugprobe.uf2).`
                : 'Debug Probe firmware is outdated and must be updated.',
            raw: text,
        };
    }
    if (/permission denied|access denied/i.test(text)) {
        return {
            kind: 'permission-denied',
            message: 'No permission to open the USB device. Install the probe-rs udev rules and reconnect the probe.',
            raw: text,
        };
    }
    // A dead SWD link. This is the only message that actually means "the probe is
    // fine, the target is not answering" — keep it *before* the more generic
    // chip-detection failure below, which shares the same first line.
    if (/No target responded to the debug port/i.test(text)) {
        return {
            kind: 'no-target',
            message:
                'The probe was opened but no target answered over SWD. Check the wiring, the pins '
                + '(SWCLK/GND/SWDIO) and that the target is powered.',
            raw: text,
        };
    }
    // The probe opened successfully but probe-rs could not work out which chip is
    // attached. Verified on real hardware: `probe-rs info` fails this way for
    // RP235x (which has no auto-detect) while `probe-rs read --chip RP235x` works.
    // So this is NOT a probe fault and must not be reported as one.
    if (/Unable to load specification for chip|could not automatically be determined|Connecting to the chip was unsuccessful/i.test(text)) {
        return {
            kind: 'chip-not-autodetected',
            message:
                'The Debug Probe is working. probe-rs cannot identify this chip automatically, so a chip id '
                + '(e.g. RP235x) is required when flashing.',
            raw: text,
        };
    }
    return { kind: 'unknown', message: firstLine(text) || 'Unknown probe error.', raw: text };
}

async function detectTool(
    exec: ExecFn,
    name: string,
    args: readonly string[],
    explicitPath: string | undefined,
): Promise<ToolStatus> {
    const resolved = findExecutable(name, explicitPath);
    if (!resolved) {
        return { name, found: false, detail: 'not found on PATH or in ~/.cargo/bin' };
    }
    const result: ExecResult = await exec(resolved, args);
    if (result.code !== 0) {
        return { name, found: false, path: resolved, detail: firstLine(result.stderr || result.stdout) };
    }
    return { name, found: true, path: resolved, version: parseVersion(result.stdout || result.stderr) };
}

export async function detectToolchain(
    exec: ExecFn = execFileFn,
    options: DetectOptions,
): Promise<ToolchainStatus> {
    const cargo = await detectTool(exec, 'cargo', ['--version'], options.cargoPath);
    const rustup = await detectTool(exec, 'rustup', ['--version'], options.rustupPath);
    const probeRs = await detectTool(exec, 'probe-rs', ['--version'], options.probeRsPath);

    let installedTargets: string[] = [];
    if (rustup.found && rustup.path) {
        const result = await exec(rustup.path, ['target', 'list', '--installed']);
        if (result.code === 0) {
            installedTargets = parseTargetList(result.stdout);
        }
    }

    const required = [...new Set(options.requiredTargets)].sort();
    const missingTargets = required.filter((t) => !installedTargets.includes(t));

    let probes: ProbeInfo[] = [];
    let probeDiagnosis: ProbeDiagnosis = {
        kind: 'none-connected',
        message: 'No debug probe detected.',
    };

    if (probeRs.found && probeRs.path) {
        const listResult = await exec(probeRs.path, ['list']);
        probes = parseProbeList(listResult.stdout);
        if (probes.length === 0) {
            // probe-rs reports an empty list on stdout; a failure shows on stderr.
            probeDiagnosis = listResult.code === 0
                ? { kind: 'none-connected', message: 'No debug probe detected. Connect a Debug Probe or picoprobe.' }
                : classifyProbeError(listResult.stderr || listResult.stdout);
        } else {
            const infoResult = await exec(probeRs.path, ['info'], { timeoutMs: 30_000 });
            probeDiagnosis =
                infoResult.code === 0
                    ? { kind: 'ok', message: 'Debug probe is reachable.' }
                    : classifyProbeError(infoResult.stderr || infoResult.stdout);
        }
    }

    const udevRulesPresent =
        process.platform !== 'linux'
            ? true
            : (options.udevRulesPresent?.() ?? UDEV_RULE_PATHS.some(pathExists));

    const ready = cargo.found && probeRs.found && missingTargets.length === 0;

    return {
        platform: process.platform,
        rustup,
        cargo,
        probeRs,
        installedTargets,
        missingTargets,
        probes,
        probeDiagnosis,
        udevRulesPresent,
        ready,
    };
}

function pathExists(candidate: string): boolean {
    try {
        // Deferred require keeps this module import-safe in tests.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs') as typeof import('fs');
        return fs.existsSync(candidate);
    } catch {
        return false;
    }
}

/** Chip id a connected probe should be paired with, for a given board id. */
export function chipForBoard(boardId: string): string | undefined {
    return boardById(boardId)?.probeChip;
}
