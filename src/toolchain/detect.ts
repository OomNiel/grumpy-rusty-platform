import type { ExecFn, ExecResult } from '../util/exec';
import { execFileFn, findExecutable } from '../util/exec';
import { boardById } from '../boards/catalog';
import * as fs from 'fs';
import * as path from 'path';

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
    /** Another program has the probe open - a `cargo run`, a Monitor terminal, a debug session. */
    | 'probe-busy'
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
    /** Linux only: whether this user can open a probe — see `probePermissionsWork`. */
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
    /** Injectable for tests: whether a rule file grants probe access. Defaults to reading the disk. */
    udevRulesPresent?: () => boolean;
}

/** Where Linux keeps its udev rules. */
export const UDEV_RULES_DIR = '/etc/udev/rules.d';

/**
 * Probe vendors the installer's rule file covers (`UDEV_RULES_CONTENT` in `installPlan.ts`), in the
 * same order. Listed here rather than imported from there because that module imports this one; a t1
 * test holds the two together.
 */
export const PROBE_USB_VENDORS = ['2e8a', '0d28', '1366', '0483', '1a86', '1209', '03eb'];

// `ATTR{idVendor}=="2e8a"` and `ATTRS{idVendor}=="2e8a"` are both seen in the wild, so the closing
// brace is optional and the spacing is not assumed.
const VENDOR_PATTERNS = PROBE_USB_VENDORS.map(
    (vendor) => new RegExp(`idVendor\\s*\\}?\\s*==\\s*"${vendor}"`, 'i'),
);
/** A rule that names a device but grants nothing (a symlink, say) changes no permissions. */
const ACCESS_GRANT = /(MODE|GROUP|OWNER)\s*=|TAG\s*\+?=/i;
/**
 * A rule scoped to another subsystem cannot be the probe's USB permission: the DataSafe alias grants
 * access to the Pico's serial port, which no debugger opens.
 */
const OTHER_SUBSYSTEM = /SUBSYSTEMS?\s*==\s*"(?!usb)/i;

export interface UdevRuleFile {
    name: string;
    text: string;
}

/**
 * True when one of these rule files grants access to a probe vendor's USB devices.
 *
 * The extension writes `69-probe-rs.rules`, but it is not the only thing that can grant that access:
 * Raspberry Pi's own installer drops `99-picoprobe.rules`, and a distro may ship its own. Accepting
 * only our own file name is what printed "MISSING" on a bench that had been flashing all day.
 */
export function udevRuleGrantsProbeAccess(files: readonly UdevRuleFile[]): boolean {
    return files.some((file) =>
        file.text.split('\n').some((rawLine) => {
            // Every one of these files carries commented-out examples; a `#` grants nothing.
            const line = rawLine.trimStart();
            if (line.startsWith('#')) {
                return false;
            }
            return (
                VENDOR_PATTERNS.some((pattern) => pattern.test(line))
                && ACCESS_GRANT.test(line)
                && !OTHER_SUBSYSTEM.test(line)
            );
        }),
    );
}

/**
 * True when probe-rs demonstrably got a probe open, which is the permission question that matters.
 *
 * Every kind listed here is only reached *after* the USB device was opened: the complaint is further
 * along the chain (chip id, firmware version, SWD link) and no udev rule can fix those.
 */
export function probePermissionsWork(diagnosis: ProbeDiagnosis): boolean {
    switch (diagnosis.kind) {
        case 'ok':
        case 'chip-not-autodetected':
        case 'firmware-outdated':
        case 'no-target':
            return true;
        default:
            // `permission-denied` says the opposite, and `none-connected`/`unknown` say nothing at all.
            return false;
    }
}

/** Reads `/etc/udev/rules.d/*.rules`. A missing directory or unreadable file yields no entries. */
export function readUdevRules(dir = UDEV_RULES_DIR): UdevRuleFile[] {
    const files: UdevRuleFile[] = [];
    let entries: string[];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return files;
    }
    for (const name of entries) {
        if (!name.endsWith('.rules')) {
            continue;
        }
        try {
            files.push({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') });
        } catch {
            // Unreadable: skip it rather than lose the rest of the list.
        }
    }
    return files;
}

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
    // The probe is in the list, so the device exists - it just cannot be opened, which is what a
    // second program trying to use it sees. Measured on the bench 2026-10-03, while `probe-rs run`
    // was streaming RTT:
    //
    //     Error: Connecting to the chip was unsuccessful.
    //     Caused by:
    //         0: The debug probe could not be created.
    //         1: The selected USB device could not be opened.
    //
    // It looks like a hardware fault and is only ever a program that did not let go.
    if (/USB device could not be opened|debug probe could not be created|resource busy|already in use/i.test(text)) {
        return {
            kind: 'probe-busy',
            message:
                'Another program is holding the debug probe - a Rusty: flash or Rusty: monitor terminal, '
                + 'or a debug session that is still running. Close or stop it, then try again.',
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

    const rulesFilePresent =
        process.platform !== 'linux'
            ? true
            : (options.udevRulesPresent?.() ?? udevRuleGrantsProbeAccess(readUdevRules()));
    // Opening a probe settles the question this check exists to answer, so it wins over the file
    // scan: a machine can be perfectly usable with no rule file of ours (Raspberry Pi's installer
    // writes its own), and telling that user to install what they already have is worse than useless.
    const udevRulesPresent = rulesFilePresent || probePermissionsWork(probeDiagnosis);

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

/** Chip id a connected probe should be paired with, for a given board id. */
export function chipForBoard(boardId: string): string | undefined {
    const board = boardById(boardId);
    return board === undefined ? undefined : board.kind === 'rp' ? board.probeChip : board.espChip;
}
