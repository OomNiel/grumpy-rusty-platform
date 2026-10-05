import type { BoardProfile } from '../boards/types';
import type { BuildProfile } from '../project/launchConfig';

/**
 * Which build every route that writes the chip uses — and therefore the build a probe-rs debug session
 * loads.
 *
 * These two used to disagree: Flash wrote `release` (it was `cargo run --release`, whose runner is
 * `probe-rs run`) while every debug configuration loaded the `debug` build. So Flash followed by a
 * no-flash debug session mismatched *by construction*, and the chip check that exists to catch a
 * stale image reported it every time — correctly, but as a permanent condition rather than a fault.
 *
 * Grumpy set the rule that decides it: *"When clicking on the 'Debug' button, the user expects the
 * system to run a debug build so that break points can be set at will."* A release image is
 * optimised, so breakpoints there show up hollow, which means the build a session can debug is the
 * only build worth flashing from here.
 */
export const FLASH_PROFILE: BuildProfile = 'debug';

/**
 * What the user asked for, as the `rustyPlatform.flashProfile` setting spells it.
 *
 * `auto` is the default and means "let the board decide"; `debug` and `release` are the explicit
 * choices, both as a setting and as their own one-shot controls.
 */
export type FlashProfileChoice = 'auto' | 'debug' | 'release';

export const FLASH_PROFILE_CHOICES: readonly FlashProfileChoice[] = ['auto', 'debug', 'release'];

/** A setting value, however it was typed, turned into a choice. Anything unknown means `auto`. */
export function parseFlashProfileChoice(value: unknown): FlashProfileChoice {
    return FLASH_PROFILE_CHOICES.includes(value as FlashProfileChoice)
        ? (value as FlashProfileChoice)
        : 'auto';
}

/**
 * The profile a Flash writes, for a given board and an explicit choice.
 *
 * `auto` — the default, and the only branch that looks at the board — is `release` for an ESP chip and
 * `debug` for everything else. `debug` exists so that a probe-rs debug session can bind breakpoints in
 * the image the chip is running; that has a subject only on Raspberry Pi, where the session loads the
 * same build. An Xtensa chip is flashed over USB serial and has no session at all (`Debug` there is
 * flash + monitor), so a debug build buys nothing and costs a great deal: the diagnostic screen the ESP
 * template draws took **28 834 ms** to paint as a debug build and **221 ms** as a release one, the same
 * source (measured on a 3.5" CYD, 2026-10-05, NOTES §54). ESP projects therefore flash `release` by
 * default, which is also what "Publish .deb" has always built.
 *
 * The explicit choices win over the board, deliberately: they are the user saying "I know, do it
 * anyway", and a control that second-guesses that is worse than no control.
 */
export function flashProfileFor(
    board: BoardProfile | undefined,
    choice: FlashProfileChoice = 'auto',
): BuildProfile {
    if (choice === 'debug' || choice === 'release') {
        return choice;
    }
    return board?.kind === 'esp' ? 'release' : FLASH_PROFILE;
}

/**
 * What is worth saying out loud about a profile before it is written.
 *
 * Only a *deliberate* choice gets a line: `auto` is the extension's own recommendation and reading it
 * back to the user would be noise. Empty when there is nothing to warn about.
 */
export function profileWarnings(
    board: BoardProfile | undefined,
    profile: BuildProfile,
    choice: FlashProfileChoice,
): string[] {
    if (choice === 'auto') {
        return [];
    }
    if (profile === 'debug' && board?.kind === 'esp') {
        return [
            'a debug build paints a panel far slower than a release one — 28 834 ms against 221 ms for '
            + 'the generated display screen on a 3.5" CYD, measured 2026-10-05 (NOTES 54). The chip is '
            + 'still debuggable over JTAG, which needs separate hardware.',
        ];
    }
    if (profile === 'release' && board?.kind === 'rp') {
        return [
            'a release build is optimised, so breakpoints in a probe-rs session will be hollow and '
            + 'stepping will behave oddly. Choose the debug profile when you intend to step.',
        ];
    }
    return [];
}
