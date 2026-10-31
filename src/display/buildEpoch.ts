/**
 * The time a Pico project is built at, written where the firmware can read it.
 *
 * A Pico has no RTC on the chip, so a Clock design needs a starting point. The user's answer (2026-10-26)
 * was "set it when flashing", and this is what that means in practice: the extension rewrites one line of
 * the project's `.cargo/config.toml` before every build, and the generated firmware reads it with
 * `option_env!` as `BUILD_EPOCH`. The board then powers up knowing the date and time of the build, to the
 * second the compiler started -- and on a W board the network corrects the drift afterwards.
 *
 * Why the config file rather than a line in `main.rs`: that file is written once and belongs to the user.
 * Why a build-time value rather than a serial hand-over: the RP route has no serial console (flashing is
 * SWD through probe-rs and monitoring is RTT), so there is no cable for a host to send the time down.
 *
 * Pure: no `vscode` import, so the rewrite is unit-testable and the caller owns the file.
 */

import { configHasValue, configLine, readConfigValue, setConfigValue } from './espConfig';

/** The environment variable the generated `src/MainHeader.rs` reads. */
export const BUILD_EPOCH_ENV = 'RUSTY_EPOCH';

/** The `[env]` line itself, in whole seconds. */
export function epochLine(seconds: number): string {
    return configLine(BUILD_EPOCH_ENV, String(Math.max(0, Math.floor(seconds))));
}

/**
 * Puts the build time into a `.cargo/config.toml`, replacing an existing entry or adding one.
 *
 * The same line-wise editor the rotation and the brightness use, so a file's comments, tables and ordering
 * are never touched: only the value of one key changes.
 */
export function setBuildEpochInConfig(content: string, seconds: number): string {
    return setConfigValue(content, BUILD_EPOCH_ENV, String(Math.max(0, Math.floor(seconds))));
}

/** Whether the file carries a build time at all -- the mark of a project that has a clock to feed. */
export function configHasBuildEpoch(content: string): boolean {
    return readConfigValue(content, BUILD_EPOCH_ENV) !== undefined;
}

/**
 * Whether the file already says exactly this second.
 *
 * A rewrite per build is cheap, but a *no-op* build should not show as a modified file in source control,
 * which is what an unconditional write would do.
 */
export function configHasEpochSecond(content: string, seconds: number): boolean {
    return configHasValue(content, BUILD_EPOCH_ENV, String(Math.max(0, Math.floor(seconds))));
}
