/**
 * The panel backlight's brightness: a project setting the Designer writes and the firmware reads.
 *
 * It lives in `.cargo/esp-config.toml` beside the rotation and the touch switch, for the same reason: the
 * firmware reads it with `option_env!`, so it is baked into the image and changing it needs a rebuild -- and
 * nothing in `src/main.rs` (where the user's own code goes) has to be edited. Unlike the rotation it is a
 * *range*, not a choice, so the value is a percentage the slider can produce and a hand-edit can still make
 * sense of.
 *
 * Two things are deliberate. **Absent means fully on**, so a project generated before the setting existed --
 * or one whose line a user deleted -- keeps the panel lit instead of going dark. And the firmware does the
 * inversion for an active-low panel: the number in the file is always the brightness a person sees, never a
 * duty cycle, because "30 %" must not mean 70 % on the T-QT.
 *
 * No `vscode` import: this is text handling, and the t1 layer tests it.
 */

import { configHasValue, configLine, readConfigValue, setConfigValue } from './espConfig';

/** The key the generated firmware reads with `option_env!("…")`. */
export const BACKLIGHT_ENV = 'BACKLIGHT_BRIGHTNESS';

/** Fully on, which is also what a project that does not mention the key gets. */
export const DEFAULT_BRIGHTNESS = 100;

/** What the slider offers, inclusive. */
export const MIN_BRIGHTNESS = 0;
export const MAX_BRIGHTNESS = 100;

/**
 * A whole percentage in range, whatever was asked for.
 *
 * A non-number cannot become a slider position, so it becomes the default rather than `NaN` -- which would
 * stringify into the config file as `"NaN"` and be parsed by the firmware as "not a number, use 100" anyway.
 */
export function clampBrightness(percent: number): number {
    if (!Number.isFinite(percent)) {
        return DEFAULT_BRIGHTNESS;
    }
    return Math.min(MAX_BRIGHTNESS, Math.max(MIN_BRIGHTNESS, Math.round(percent)));
}

/** The `[env]` line the setting is written as. */
export function brightnessLine(percent: number): string {
    return configLine(BACKLIGHT_ENV, String(clampBrightness(percent)));
}

/** Puts the brightness into a `.cargo/esp-config.toml`, replacing an existing entry or adding one. */
export function setBrightnessInConfig(content: string, percent: number): string {
    return setConfigValue(content, BACKLIGHT_ENV, String(clampBrightness(percent)));
}

/** True when the file already carries the setting, so a rewrite can be skipped. */
export function configHasBrightness(content: string, percent: number): boolean {
    return configHasValue(content, BACKLIGHT_ENV, String(clampBrightness(percent)));
}

/**
 * The brightness a project asks for.
 *
 * Absent means fully on -- the answer for every project generated before the setting existed, and the one
 * that cannot leave a panel dark because of a missing line. A value that is not a number (a typo, a
 * hand-edit) is treated the same way rather than switching the light off.
 */
export function brightnessFromConfig(content: string): number {
    const raw = readConfigValue(content, BACKLIGHT_ENV);
    if (raw === undefined || raw.trim() === '') {
        return DEFAULT_BRIGHTNESS;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampBrightness(parsed) : DEFAULT_BRIGHTNESS;
}

/**
 * The duty cycle, in percent of the pin's high time, that gives the requested brightness.
 *
 * A panel whose backlight transistor is switched on by a LOW level is fully lit with the pin low, so its
 * duty is the complement of the brightness. The generated firmware computes this at compile time; the
 * function is here so the rule has one written-down answer the tests can read.
 */
export function backlightDuty(percent: number, activeLow: boolean): number {
    const brightness = clampBrightness(percent);
    return activeLow ? MAX_BRIGHTNESS - brightness : brightness;
}
