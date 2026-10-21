/**
 * The `sd` cargo feature of a Designer project, and the line-wise editing that maintains it.
 *
 * SD is gated behind a cargo feature rather than a `.cargo/esp-config.toml` key like touch or rotation: the
 * requirement is that *enabling* the card adds the file system to the build, and only a feature can switch a
 * dependency in or out. `designer/sd` is `embedded-sdmmc` (a FAT filesystem) and `critical-section` (the
 * mutex `sd.rs` keeps the mounted volume behind); both are declared `optional` and pulled in by `sd`. The
 * feature is in `default`, which is what ships every Designer project with the card on; the toolbar is what
 * moves it out of `default` to turn the card off, and back in to turn it on again.
 *
 * That is a local edit to the generated manifest, which a regeneration will overwrite -- the same trade-off
 * the SMTP wizard makes for `Cargo.toml`. The manifest's `[features]` and `default = [...]` are owned by the
 * generator, so this editor touches only that one line and leaves every other table, key and comment alone.
 */

/** Matches `default = [...]`, capturing the prefix, the array, and any trailing comment. */
const DEFAULT_RE = /^(\s*default\s*=\s*)(\[[^\]]*\])(.*)$/;

/** The string a feature appears as, exactly as it is written in `default`. */
const SD = '"sd"';

/** The quote-delimited feature names inside a `["a", "b"]` literal, in order, without spacing. */
function itemsOf(array: string): string[] {
    const trimmed = array.trim();
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
        return [];
    }
    return trimmed
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
}

/**
 * The index of the `default = [...]` line within `[features]`, or `-1` when the manifest has no feature set.
 *
 * Walked by section so a `default` key living under `[dependencies]` (it cannot, but the guard is cheap) is not
 * mistaken for the feature one.
 */
function defaultLine(cargoToml: string): number {
    const lines = cargoToml.split('\n');
    let inFeatures = false;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
        if (header !== null) {
            inFeatures = (header[1] ?? '').trim() === 'features';
            continue;
        }
        if (inFeatures && /^\s*default\s*=/.test(line)) {
            return index;
        }
    }
    return -1;
}

/** True when the project's `default` feature list enables `sd`. */
export function isSdEnabled(cargoToml: string): boolean {
    const lines = cargoToml.split('\n');
    const index = defaultLine(cargoToml);
    if (index === -1) {
        return false;
    }
    const match = DEFAULT_RE.exec(lines[index] ?? '');
    return itemsOf(match?.[2] ?? '[]').includes(SD);
}

/**
 * Turns the `sd` feature on or off in `default`, returning the new manifest and what changed.
 *
 * `none` when the file has no `[features]` of its own (a project whose board has no card) or when the setting
 * is already where it was asked to be. Other features -- the LilyGo panel switch, and any a user added by
 * hand -- are left exactly as they are.
 */
export function setSdEnabled(
    cargoToml: string,
    enabled: boolean,
): { text: string; note: 'added' | 'removed' | 'none' } {
    const lines = cargoToml.split('\n');
    const index = defaultLine(cargoToml);
    if (index === -1) {
        return { text: cargoToml, note: 'none' };
    }
    const original = lines[index] ?? '';
    const match = DEFAULT_RE.exec(original);
    if (match === null) {
        return { text: cargoToml, note: 'none' };
    }
    const items = itemsOf(match[2] ?? '[]');
    const has = items.includes(SD);
    if (enabled === has) {
        return { text: cargoToml, note: 'none' };
    }
    const next = enabled
        ? items.length === 0
            ? `[${SD}]`
            : `[${items.join(', ')}, ${SD}]`
        : `[${items.filter((item) => item !== SD).join(', ')}]`;
    lines[index] = `${match[1] ?? ''}${next}${match[3] ?? ''}`;
    return { text: lines.join('\n'), note: enabled ? 'added' : 'removed' };
}
