/**
 * The cargo features the Designer switches, and the line-wise editing that maintains them.
 *
 * Two project settings are features rather than `.cargo/esp-config.toml` keys, for the same reason: the
 * requirement is that *enabling* them adds code to the build. `sd` brings in the FAT filesystem
 * (`embedded-sdmmc` + `critical-section`, both optional). Only a feature can switch a dependency or a module in or out.
 *
 * It is in `default` when it is on -- the card starts on for a board with a socket -- and the toolbar's switch
 * is what moves it in and out. That is
 * a local edit to the generated manifest, which a regeneration will overwrite; the manifest's `[features]`
 * and `default = [...]` are owned by the generator, so this editor touches those lines and leaves every other
 * table, key and comment alone.
 */

/** Matches `default = [...]`, capturing the prefix, the array, and any trailing comment. */
const DEFAULT_RE = /^(\s*default\s*=\s*)(\[[^\]]*\])(.*)$/;

/** `"name"` -- the string a feature appears as inside `default`. */
function quoted(name: string): string {
    return `"${name}"`;
}

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

/** The index of the `[features]` header line, or -1 when the manifest has no feature set at all. */
function featuresHeader(cargoToml: string): number {
    const lines = cargoToml.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
        const header = /^\s*\[([^\]]+)\]\s*$/.exec(lines[index] ?? '');
        if (header !== null && (header[1] ?? '').trim() === 'features') {
            return index;
        }
    }
    return -1;
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

/** True when the project's `default` feature list enables `name`. */
export function isFeatureInDefault(cargoToml: string, name: string): boolean {
    const lines = cargoToml.split('\n');
    const index = defaultLine(cargoToml);
    if (index === -1) {
        return false;
    }
    const match = DEFAULT_RE.exec(lines[index] ?? '');
    return itemsOf(match?.[2] ?? '[]').includes(quoted(name));
}

/**
 * Turns `name` on or off in `default`, returning the new manifest and what changed.
 *
 * `none` when the file has no `[features]` of its own (a project generated before this feature existed) or
 * when the setting is already where it was asked to be. Other features -- the LilyGo panel switch, `sd`, and
 * any a user added by hand -- are left exactly as they are.
 */
export function setFeatureInDefault(
    cargoToml: string,
    name: string,
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
    const item = quoted(name);
    const items = itemsOf(match[2] ?? '[]');
    const has = items.includes(item);
    if (enabled === has) {
        return { text: cargoToml, note: 'none' };
    }
    const next = enabled
        ? items.length === 0
            ? `[${item}]`
            : `[${items.join(', ')}, ${item}]`
        : `[${items.filter((candidate) => candidate !== item).join(', ')}]`;
    lines[index] = `${match[1] ?? ''}${next}${match[3] ?? ''}`;
    return { text: lines.join('\n'), note: enabled ? 'added' : 'removed' };
}

/**
 * Makes sure the manifest *defines* `name = [...]`, adding the table if it has none.
 *
 * A project generated before a feature existed has no definition to switch. Appending a new `[features]` table is
 * valid TOML wherever the last table ended, and every existing byte is left alone.
 */
export function ensureFeatureDefinition(
    cargoToml: string,
    name: string,
): { text: string; note: 'added' | 'present' } {
    const lines = cargoToml.split('\n');
    const header = featuresHeader(cargoToml);
    const line = `${name} = []`;
    if (header === -1) {
        const separator = cargoToml === '' || cargoToml.endsWith('\n') ? '' : '\n';
        return { text: `${cargoToml}${separator}\n[features]\ndefault = []\n${line}\n`, note: 'added' };
    }
    const definition = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
    let insertAt = header + 1;
    for (let index = header + 1; index < lines.length; index += 1) {
        const current = lines[index] ?? '';
        if (/^\s*\[[^\]]+\]\s*$/.test(current)) {
            break;
        }
        if (definition.test(current)) {
            return { text: cargoToml, note: 'present' };
        }
        if (/^\s*default\s*=/.test(current)) {
            insertAt = index + 1;
        }
    }
    lines.splice(insertAt, 0, line);
    return { text: lines.join('\n'), note: 'added' };
}
