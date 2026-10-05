import type { BoardProfile } from '../boards/types';
import type { BuildProfile } from '../project/launchConfig';

/**
 * The profile every route that writes the chip uses — and therefore the profile every debug session
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
 * The profile a Flash writes, for a given board.
 *
 * `debug` exists so that a probe-rs debug session can bind breakpoints in the image the chip is
 * running — a rule that only has a subject on Raspberry Pi, where the session loads that same build.
 * An Xtensa chip is flashed over USB serial and has no session at all (`Debug` there is flash +
 * monitor), so the debug build buys nothing and costs a great deal: the diagnostic screen this
 * template draws took **29.4 s** to paint on a 3.5" CYD as a debug build and **0.223 s** as a release
 * build — the same source, 132x (measured on the board, 2026-10-05). ESP projects therefore flash
 * `release`, which is also what "Publish .deb" has always built.
 */
export function flashProfileFor(board: BoardProfile | undefined): BuildProfile {
    return board?.kind === 'esp' ? 'release' : FLASH_PROFILE;
}
