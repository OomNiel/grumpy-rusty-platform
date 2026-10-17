/**
 * What the extension asks about when it loads.
 *
 * The health check has always been *there* — a status-bar row, a sidebar row and the `Check Toolchain` command —
 * but it never said anything unless the user went looking. A window could open with no cargo, no probe-rs, or an
 * ESP project and no Xtensa toolchain, and the extension waited to be asked.
 *
 * It asks now, on load (asked for on 2026-10-16: *"The extension must prompt for any missing requirements when
 * it loads."*). The rules live here, pure and without a `vscode` import, for the same reason the health report
 * does: the t1 layer can pin what is asked, when it is not asked, and what "don't show again" remembers.
 *
 * Three decisions worth stating, because each one is a way to be annoying:
 *
 * 1. **The prompt is the health report**, not a second list of requirements. So it follows the family rules
 *    already learned the hard way (2026-10-05): an ESP project is never nagged about a probe it can never use,
 *    and an RP project is never nagged about the Xtensa toolchain.
 * 2. **Nothing is asked before detection has finished.** "The toolchain has not been detected yet" is a
 *    transient state, not a missing requirement, and a modal about it would be a modal on every single load.
 * 3. **"Don't show again" remembers a *set* of problems, not the act of prompting.** So dismissing "no cargo" does
 *    not silence "ESP toolchain missing" tomorrow, while the same unchanged set never comes back.
 */

import type { HealthAction, HealthReport } from './health';

export interface RequirementsInput {
    /** The verdict of the health check — the single source of what is missing. */
    report: HealthReport;
    /**
     * Whether detection has produced a status yet.
     *
     * False during the first moments of activation, and false if detection failed outright; either way there is
     * nothing honest to ask about.
     */
    detected: boolean;
    /** The signatures the user has said "don't show again" for, as last stored. */
    dismissed?: string;
    /** The `rustyPlatform.promptMissingRequirements` setting. */
    enabled: boolean;
}

export interface Requirements {
    /** Whether to put a prompt on screen. */
    ask: boolean;
    /**
     * The identity of this set of missing pieces, or `''` when there is nothing missing.
     *
     * Stored when the user says "don't show again", and compared against later: a set that has changed is a
     * *different* requirement, so it is worth announcing even if the last one was dismissed.
     */
    signature: string;
    /** The message to show, or `''` when there is nothing to say. */
    message: string;
    /** The fixes to offer as buttons, in the report's own order. */
    actions: HealthAction[];
}

/**
 * The identity of a set of problems: order-independent, so the same requirements reached in a different order
 * are recognised as the same, and a *change* in the set is what makes the prompt appear again.
 */
export function missingSignature(problems: readonly string[]): string {
    return problems
        .map((problem) => problem.trim())
        .filter((problem) => problem !== '')
        .sort()
        .join(' | ');
}

/** What to ask about, if anything, right now. */
export function missingRequirements(input: RequirementsInput): Requirements {
    const nothing: Requirements = { ask: false, signature: '', message: '', actions: [] };
    if (!input.enabled || !input.detected || input.report.ok) {
        return nothing;
    }
    // A report with problems but no way to fix them is not a prompt: there would be nothing to press. (It is
    // still a problem for the health row and the log, which is where the user reads the words.)
    if (input.report.problems.length === 0 || input.report.actions.length === 0) {
        return nothing;
    }

    const signature = missingSignature(input.report.problems);
    if (input.dismissed === signature) {
        return nothing;
    }

    return {
        ask: true,
        signature,
        message:
            "Grumpy's Rusty Platform needs the following before it can build:\n" +
            input.report.problems.map((problem) => `• ${problem}`).join('\n'),
        actions: [...input.report.actions],
    };
}

/** The button text for a fix, and the command it runs — re-exported so a caller needs one import. */
export { HEALTH_ACTION_COMMANDS, HEALTH_ACTION_LABELS } from './health';
