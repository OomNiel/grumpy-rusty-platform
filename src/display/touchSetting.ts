/**
 * Whether a generated project drives its touch controller.
 *
 * Touch is a *choice*, not a property of the board: the same ESP32-035 can be a display or a touchscreen, and a
 * design that is only ever looked at has no business carrying a driver, a flash read and a calibration screen
 * for a controller nobody touches. So the answer lives in the project's `.cargo/esp-config.toml` beside the
 * rotation, is read at compile time with `option_env!`, and the firmware contains both paths with one folded
 * away -- which is what lets the setting be flipped without regenerating `src/main.rs`.
 *
 * The default, for a file that does not mention it, is **enabled**. That is the backwards-compatible answer
 * rather than the tidy one: projects generated before this setting existed had a working touchscreen, and a
 * default of "off" would silently take it away from them on their next build. The wizard writes the key
 * explicitly for every new project, so the default only ever applies to the ones that predate it.
 */

import { configHasValue, configLine, readConfigValue, setConfigValue } from './espConfig';

/** The value the firmware reads. Kept in step with the generated `main.rs`. */
export const TOUCH_ENV = 'TOUCH_ENABLED';

/** The value the firmware compares against; only "0" means off, so anything else (including absent) is on. */
export const TOUCH_OFF_VALUE = '0';
export const TOUCH_ON_VALUE = '1';

/** The `[env]` line itself. */
export function touchLine(enabled: boolean): string {
    return configLine(TOUCH_ENV, enabled ? TOUCH_ON_VALUE : TOUCH_OFF_VALUE);
}

/** Puts the setting into a `.cargo/esp-config.toml`, replacing an existing entry or adding one. */
export function setTouchInConfig(content: string, enabled: boolean): string {
    return setConfigValue(content, TOUCH_ENV, enabled ? TOUCH_ON_VALUE : TOUCH_OFF_VALUE);
}

/** True when the file already carries the setting, so a rewrite can be skipped. */
export function configHasTouch(content: string, enabled: boolean): boolean {
    return configHasValue(content, TOUCH_ENV, enabled ? TOUCH_ON_VALUE : TOUCH_OFF_VALUE);
}

/**
 * Whether a project asks for touch.
 *
 * Absent means yes -- see the note at the top: projects that predate the setting had a working touchscreen, and
 * this must not be the thing that turns it off.
 */
export function touchFromConfig(content: string): boolean {
    return readConfigValue(content, TOUCH_ENV) !== TOUCH_OFF_VALUE;
}

/**
 * The line the generated firmware reads it with.
 *
 * `option_env!` is a compile-time read, so the value is baked in and flipping the setting needs a rebuild. Only
 * `"0"` is off: a typo, an empty value or a missing key all leave touch on, which is the same reasoning as the
 * default above.
 *
 * The comparison is a length and a byte rather than `matches!(value, "0")`, because matching a `&str` in a
 * `const` is not stable Rust -- `PartialEq` for `str` is not a const trait, and the first version of this line
 * did not compile (E0658, found by building a generated project).
 */
export function touchFirmwareLine(): string {
    return [
        'const TOUCH: bool = match option_env!("TOUCH_ENABLED") {',
        '    Some(value) => !(value.len() == 1 && value.as_bytes()[0] == b\'0\'),',
        '    None => true,',
        '};',
    ].join('\n');
}

/**
 * The problems a design has because touch is switched off.
 *
 * Reported rather than enforced: switching touch off with controls in the design is a decision the user is
 * allowed to make -- a half-built design, or one whose buttons are placeholders -- but it must not be a silent
 * one, because those controls will simply do nothing on the board.
 */
export function touchNeededBy(
    widgets: readonly { id: string; events: readonly string[] }[],
    touchEnabled: boolean,
): string[] {
    if (touchEnabled) {
        return [];
    }
    const withEvents = widgets.filter((widget) => widget.events.length > 0);
    if (withEvents.length === 0) {
        return [];
    }
    const names = withEvents.map((widget) => widget.id).join(', ');
    return [
        `touch is switched off, so ${withEvents.length === 1 ? 'this control' : 'these controls'} cannot ` +
            `respond: ${names}. Turn touch on in the toolbar; the design still saves either way.`,
    ];
}
