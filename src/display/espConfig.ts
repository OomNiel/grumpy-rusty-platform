/**
 * The `[env]` settings a generated ESP project carries, and the line-wise rewriting that maintains them.
 *
 * Both settings the extension keeps in `.cargo/esp-config.toml` -- the panel rotation and whether touch is
 * enabled -- are edited the same way: find the key's line and replace it, or add one to `[env]`, or create the
 * section. Doing that line-wise rather than regenerating the file matters because by the time a setting changes
 * the project may have `[env]` entries of its own, and rewriting the whole thing would throw them away.
 *
 * The two settings live here together because the *mechanism* is the same and only the names differ; the
 * rotation module keeps its own public API on top of this, so nothing that used it had to change.
 *
 * No `vscode` import: this is text handling, and the t1 layer tests it.
 */

/** The value line for a key, as cargo's `[env]` wants it. Values are quoted: they are read as strings. */
export function configLine(key: string, value: string): string {
    return `${key} = "${value}"`;
}

/**
 * Puts a value into a `.cargo/esp-config.toml`, replacing an existing entry or adding one.
 *
 * A missing `[env]` section is created, an existing one is added to in place, and anything else in the file is
 * left exactly as it is -- comments, other keys, `[env.NAME]` subtables and all.
 */
export function setConfigValue(content: string, key: string, value: string): string {
    const line = configLine(key, value);
    const lines = content.split('\n');
    const pattern = new RegExp(`^\\s*${key}\\s*=`);
    const existing = lines.findIndex((candidate) => pattern.test(candidate));
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

/** The value a key carries, or `undefined` when the file does not mention it. */
export function readConfigValue(content: string, key: string): string | undefined {
    const pattern = new RegExp(`^\\s*${key}\\s*=\\s*"?([^"#]*?)"?\\s*(?:#.*)?$`);
    for (const line of content.split('\n')) {
        const match = pattern.exec(line);
        if (match !== null && match[1] !== undefined) {
            return match[1].trim();
        }
    }
    return undefined;
}

/** True when the file already carries the value, so a rewrite can be skipped. */
export function configHasValue(content: string, key: string, value: string): boolean {
    return content.split('\n').some((candidate) => candidate.trim() === configLine(key, value));
}
