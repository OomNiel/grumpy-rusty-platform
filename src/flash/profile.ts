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
