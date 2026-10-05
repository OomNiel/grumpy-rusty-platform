/**
 * What is wrong with this setup, given which silicon the open project is for.
 *
 * The health check used to be Raspberry Pi-shaped in both directions: it reported "no debug probe
 * detected" as a *problem* for every project — an Xtensa chip has no SWD at all and flashes over USB
 * serial, so a probe is not part of that route — and it reported a missing ESP toolchain as nothing
 * but a line of information, even when the open project was an ESP one and could not be built without
 * it. Pressing the health control on a Sunton CYD therefore produced a modal about a probe that board
 * can never use (2026-10-05).
 *
 * The decision lives here, pure and without a `vscode` import, so the t1 layer can pin it: the same
 * rules then drive the sidebar row, the status bar tooltip and the modal, instead of three of them
 * disagreeing.
 */

import type { ToolchainStatus } from './detect';
import { EspToolchainStatus, espToolchainSummary } from './espToolchain';

/** Which silicon the workspace's project is for. `unknown` means no recognisable project is open. */
export type HealthFamily = 'rp' | 'esp' | 'unknown';

/** Something the user can press to fix what the report found. */
export type HealthAction =
    | 'install-toolchain'
    | 'install-esp-toolchain'
    | 'add-cargo-path'
    | 'update-probe-firmware';

export interface HealthInput {
    status?: ToolchainStatus;
    /** The ESP toolchain, when it was detected (only worth the processes for an ESP project). */
    esp?: EspToolchainStatus;
    family: HealthFamily;
    /**
     * False when cargo is installed but is not on the shell's own PATH — a build we start works (we
     * add it ourselves), one the user types by hand does not.
     */
    cargoOnShellPath: boolean;
}

export interface HealthReport {
    ok: boolean;
    /** Things the user has to fix, in the order they are worth reading. */
    problems: string[];
    /** True but not actionable: printed for the log, never raised as a problem. */
    notes: string[];
    /** The fixes to offer, in button order. Empty when `ok`. */
    actions: HealthAction[];
}

/**
 * Is the directory cargo lives in on the shell's own PATH?
 *
 * The delimiter is passed in rather than read from `path.delimiter`, so this stays a pure function
 * that a test can hold against both shapes (':' on Linux, ';' on Windows).
 */
export function cargoVisibleOnShellPath(
    pathEnv: string | undefined,
    binDir: string,
    delimiter = ':',
): boolean {
    return binDir === '' ? true : (pathEnv ?? '').split(delimiter).includes(binDir);
}

/**
 * The verdict.
 *
 * The rule that matters is the split: for an ESP project the probe *diagnosis* is a note (the probe
 * route does not exist for Xtensa) and the ESP pieces are problems; for a Raspberry Pi project — or
 * with nothing open, where the old behaviour is the safe one — it is the other way round. Cargo is
 * shared by both and is always a problem when it is missing.
 */
export function healthReport(input: HealthInput): HealthReport {
    const problems: string[] = [];
    const notes: string[] = [];
    const actions: HealthAction[] = [];
    const status = input.status;

    if (status === undefined) {
        return { ok: false, problems: ['the toolchain has not been detected yet'], notes, actions };
    }

    if (!status.cargo.found) {
        problems.push('cargo is not installed');
        actions.push('install-toolchain');
    }
    if (!input.cargoOnShellPath) {
        problems.push(`cargo is not on this shell's PATH (${status.cargo.path ?? 'cargo'})`);
        actions.push('add-cargo-path');
    }

    if (input.family === 'esp') {
        // The Xtensa toolchain is the whole prerequisite: without it nothing builds, and espflash is
        // what writes the chip. A probe is not consulted anywhere on that route.
        if (input.esp !== undefined && !input.esp.ready) {
            problems.push(`ESP toolchain: ${espToolchainSummary(input.esp)} (chips: ${input.esp.chips.join(', ')})`);
            actions.push('install-esp-toolchain');
        }
        // Deliberately no note about the probe either way. On this route there is no probe to connect
        // and none to miss, so the only thing a probe line could do is send the user looking for one.
    } else {
        if (!status.probeRs.found) {
            problems.push('probe-rs is not installed');
            actions.push('install-toolchain');
        }
        if (status.missingTargets.length > 0) {
            problems.push(`missing targets: ${status.missingTargets.join(', ')}`);
            actions.push('install-toolchain');
        }
        // `chip-not-autodetected` is normal for RP235x and not a problem to fix.
        if (status.probeDiagnosis.kind !== 'ok' && status.probeDiagnosis.kind !== 'chip-not-autodetected') {
            problems.push(status.probeDiagnosis.message);
            if (status.probeDiagnosis.kind === 'firmware-outdated') {
                actions.push('update-probe-firmware');
            }
        }
        if (input.esp !== undefined) {
            notes.push(`ESP toolchain: ${espToolchainSummary(input.esp)}`);
        }
    }

    return { ok: problems.length === 0, problems, notes, actions: dedupe(actions) };
}

function dedupe(actions: HealthAction[]): HealthAction[] {
    return actions.filter((action, index) => actions.indexOf(action) === index);
}
