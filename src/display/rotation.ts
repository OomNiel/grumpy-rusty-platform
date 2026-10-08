/**
 * The LCD rotation a generated project is built with.
 *
 * Why this is not a line in `src/main.rs`: that file is generated once, and from then on it belongs to you --
 * it is where your own code goes. A rotation stored there could only ever be changed by editing the file by
 * hand, and anything the extension rewrote would take your work with it. So the value lives in the project's
 * `.cargo/esp-config.toml` as an environment variable, and the generated firmware reads it at compile time
 * (`option_env!`). Changing the rotation is then a setting change or a one-line edit to a config file, and
 * `src/main.rs` is never touched again.
 *
 * This module is deliberately free of `vscode` imports, so the t1 layer can test the mapping and the file
 * rewrite.
 */

/** The four orientations. The numbers are the setting's own values, not an enum. */
export const LCD_ROTATIONS = [0, 1, 2, 3] as const;

export type LcdRotation = (typeof LCD_ROTATIONS)[number];

/** The value the firmware reads. Kept in step with the generated `main.rs` and `esp_config.toml`. */
export const LCD_ROTATION_ENV = 'LCD_ROTATION';

/** How each value reads in a prompt, the README and the log. */
export const LCD_ROTATION_LABELS: Record<LcdRotation, string> = {
    0: 'No rotation (default)',
    1: '90° clockwise',
    2: '180° clockwise',
    3: '270° clockwise',
};

/** The order the prompt offers them in, which is the order of the values. */
export const LCD_ROTATION_CHOICES: LcdRotation[] = [...LCD_ROTATIONS];

export function isLcdRotation(value: unknown): value is LcdRotation {
    return typeof value === 'number' && (LCD_ROTATIONS as readonly number[]).includes(value);
}

/**
 * Anything unexpected becomes "no rotation" rather than an error.
 *
 * A stored setting can be edited by hand in `settings.json`, and a wrong number there must not be able to
 * stop a project from being generated; the rotation is a cosmetic choice and 0 is what the panel does
 * without being told otherwise.
 */
export function asLcdRotation(value: unknown): LcdRotation {
    return isLcdRotation(value) ? value : 0;
}

/**
 * The templates that drive a panel, and therefore have a rotation worth asking about.
 *
 * A string rather than the `AppTemplate` type so that this module stays free of the generator's imports.
 * `designer` is here because the designer draws its canvas for the rotation the project is built with: the
 * markup it writes is sized to the turned panel, so the two have to be chosen together rather than separately.
 */
export function templateUsesPanel(template: string): boolean {
    return template === 'display' || template === 'touch' || template === 'board' || template === 'designer';
}

/** The `[env]` line itself. */
export function lcdRotationLine(rotation: LcdRotation): string {
    return `${LCD_ROTATION_ENV} = "${rotation}"`;
}

/**
 * Puts the rotation into a `.cargo/esp-config.toml`, replacing an existing entry or adding one.
 *
 * Rewritten line-wise rather than regenerated: by the time the setting changes, the project may well have
 * `[env]` entries of its own, and rewriting the whole file would throw them away. A missing `[env]` section
 * is created, and an existing one is added to in place; anything else in the file is left exactly as it is.
 */
export function setLcdRotationInConfig(content: string, rotation: LcdRotation): string {
    const line = lcdRotationLine(rotation);
    const lines = content.split('\n');
    const existing = lines.findIndex((candidate) => /^\s*LCD_ROTATION\s*=/.test(candidate));
    if (existing !== -1) {
        lines[existing] = line;
        return lines.join('\n');
    }

    const envSection = lines.findIndex((candidate) => /^\s*\[env\]\s*$/.test(candidate));
    if (envSection !== -1) {
        lines.splice(envSection + 1, 0, line);
        return lines.join('\n');
    }

    const separator = content.endsWith('\n') || content === '' ? '' : '\n';
    return `${content}${separator}\n[env]\n${line}\n`;
}

/** True when the file already carries the rotation, so a rewrite can be skipped. */
export function configHasRotation(content: string, rotation: LcdRotation): boolean {
    return content.split('\n').some((candidate) => candidate.trim() === lcdRotationLine(rotation));
}

/**
 * The rotation a `.cargo/esp-config.toml` asks for, or "no rotation" when it does not say.
 *
 * The counterpart to `setLcdRotationInConfig`, and needed for the same reason: the designer draws its canvas
 * for the rotation the project is built with, so it has to read the setting rather than assume it. A file
 * with no entry, a value that is not one of the four, or a hand-edit that left a comment in place all mean
 * the same thing -- the panel is not rotated -- rather than an error, since 0 is what the panel does without
 * being told otherwise.
 */
export function lcdRotationFromConfig(content: string): LcdRotation {
    for (const line of content.split('\n')) {
        const match = /^\s*LCD_ROTATION\s*=\s*"?'?(\d)'?"?\s*(?:#.*)?$/.exec(line);
        if (match !== null) {
            const value = Number(match[1]);
            return asLcdRotation(value);
        }
    }
    return 0;
}
