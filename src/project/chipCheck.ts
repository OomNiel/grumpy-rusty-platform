import { DebugChoice } from './launchConfig';

/**
 * "Is the chip really running the build this session is about to debug?"
 *
 * A `launch` configuration writes the chip before debugging, so its build is right by construction —
 * there is nothing to check. An attach session only *reads*: it debugs whatever happens to be in
 * flash, and when that is not the image `programBinary` names, breakpoints address code that is not
 * on the chip and defmt frames are decoded against the wrong string table. Both failures are silent,
 * which is why the question is put to `probe-rs verify` instead of being assumed.
 *
 * Kept free of `vscode` imports so the t1 layer can test it.
 */

export type ChipCheckVerdict = 'match' | 'mismatch' | 'unknown';

export interface ChipCheckResult {
    verdict: ChipCheckVerdict;
    /** The verdict in one line, for the output channel and the dialog. */
    reason: string;
}

/** Only a session that does not flash can be out of step with the chip. */
export function needsChipCheck(choice: DebugChoice): boolean {
    return !choice.flashing;
}

/**
 * Arguments for `probe-rs verify`, which compares the chip's flash with the loadable parts of an ELF
 * and prints a verdict.
 *
 * `--non-interactive` stops it asking a question we cannot answer, and `--disable-progressbars` keeps
 * the verdict lines clean. `--chip` is left out only when the project names no chip at all, which
 * leaves probe-rs guessing rather than passing it an empty argument.
 */
export function verifyArgs(chip: string | undefined, binaryPath: string): string[] {
    const args = ['verify', '--disable-progressbars', '--non-interactive'];
    if (chip !== undefined && chip.trim() !== '') {
        args.push('--chip', chip.trim());
    }
    args.push(binaryPath);
    return args;
}

/**
 * Reads the verdict out of a finished `probe-rs verify`.
 *
 * **The exit code is not usable.** probe-rs 0.32.0 exits 0 for a failed verification just as it does
 * for a successful one — measured on the bench 2026-10-03, "Verification failed: contents do not
 * match" came back with `$?` = 0 — so the words are the only signal there is.
 *
 * The cost is lopsided: a failed check stops at the first differing byte (~0.4 s here) while a
 * successful one reads the whole image (~10 s at the probe's default clock).
 */
export function classifyVerifyOutput(stdout: string, stderr: string): ChipCheckResult {
    const text = `${stdout}\n${stderr}`.replace(/\r/g, '');
    const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');

    if (/verification successful/i.test(text)) {
        return { verdict: 'match', reason: 'the chip matches this build byte for byte' };
    }

    const failed = lines.find((line) => /verification failed/i.test(line));
    if (failed !== undefined) {
        return { verdict: 'mismatch', reason: failed };
    }

    // Anything else is a probe, permission or timeout problem - not a verdict. Reporting it as
    // "unknown" keeps the check honest: it must never turn "I could not look" into "it is wrong".
    const complaint = lines.find((line) => /^(error|warning)/i.test(line));
    return {
        verdict: 'unknown',
        reason: complaint ?? lines[lines.length - 1] ?? 'probe-rs verify said nothing',
    };
}

/** Buttons of "the chip holds something else", most useful first. */
export const FLASH_THEN_DEBUG = 'Flash & Debug instead';
export const DEBUG_ANYWAY = 'Debug anyway';

/** The configuration that writes the chip, so a stale attach can be repaired in one click. */
export function flashingChoice(choices: readonly DebugChoice[]): DebugChoice | undefined {
    return choices.find((choice) => choice.flashing);
}

/**
 * What to tell the user when the chip and the session disagree. `canFlash` is false for a
 * hand-written launch.json that has no flashing configuration to fall back on.
 */
export function mismatchMessage(binary: string | undefined, reason: string, canFlash: boolean): string {
    const what = binary === undefined ? 'the build this session expects' : `the build in ${binary}`;
    return (
        `The chip is not running ${what}.\n\n` +
        `${reason}\n\n` +
        'Breakpoints would not bind and defmt output would be decoded against the wrong code, so this ' +
        'session would mislead you.\n\n' +
        (canFlash
            ? `Use "${FLASH_THEN_DEBUG}" to write that build first, or "${DEBUG_ANYWAY}" to start as it is.`
            : `Use "${DEBUG_ANYWAY}" to start as it is.`)
    );
}
