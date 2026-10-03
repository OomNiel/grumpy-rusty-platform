/**
 * Dependency editing for `Cargo.toml` — pure text in, pure text out.
 *
 * The Library Manager writes the dependency itself instead of shelling out to `cargo add`
 * (decided 2026-10-03), which means this file has to be careful: it runs against a file the
 * user may have hand-edited, and it must leave every byte it does not own exactly as it
 * found it. Hence the strict rules below.
 *
 * What it understands in `[dependencies]`:
 *
 *   foo = "1.2"                                            plain
 *   foo = { version = "1.2", features = ["a"] }             single-line inline table
 *   foo = { git = "…", features = ["a"] }                   same, any keys we do not own
 *   [dependencies.foo]                                      section form (old `cargo add`)
 *
 * Multi-line inline tables are recognised but never rewritten — Cargo accepts them, this
 * module does not pretend to understand them (`opaque`), and the caller says so instead of
 * mangling the file.
 *
 * Everything here is `vscode`-free so the t1 layer can cover it, including the byte-for-byte
 * "the rest of the file did not move" assertions.
 */

export type DependencyForm = 'plain' | 'table' | 'section' | 'opaque';

export interface ParsedDependency {
    name: string;
    form: DependencyForm;
    /** Version requirement as written, without quotes. */
    version?: string;
    features: string[];
    defaultFeatures?: boolean;
    /** Every line the entry occupies, verbatim (1 line, except for `section`). */
    lines: string[];
    /** 0-based index of the entry's first line in the file. */
    startLine: number;
}

export interface CargoTomlModel {
    dependencies: ParsedDependency[];
    /** 0-based index of the `[dependencies]` header, when the table exists. */
    dependenciesHeaderLine?: number;
    eol: '\n' | '\r\n';
}

export interface DependencyRequest {
    name: string;
    version?: string;
    features: string[];
    /** `undefined` leaves the key alone / omits it. */
    defaultFeatures?: boolean;
}

export type ApplyOutcome =
    | { ok: true; text: string; action: 'added' | 'updated'; line: string; previous?: string }
    | { ok: false; reason: string };

const HEADER_RE = /^\s*\[([^\]]+)\]\s*$/;
const ENTRY_RE = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/;

/** Split the file into lines, remembering which line ending it uses. */
function splitLines(text: string): { lines: string[]; eol: '\n' | '\r\n'; trailingNewline: boolean } {
    const eol: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n';
    const trailingNewline = /\r?\n$/.test(text);
    const body = trailingNewline ? text.replace(/\r?\n$/, '') : text;
    return { lines: body.split(/\r?\n/), eol, trailingNewline };
}

/** Quote-aware split of an inline table body on top-level commas. */
function splitTopLevel(body: string): string[] {
    const parts: string[] = [];
    let current = '';
    let quote: string | undefined;
    let depth = 0;
    for (let i = 0; i < body.length; i += 1) {
        const ch = body[i];
        if (quote !== undefined) {
            current += ch;
            if (ch === '\\' && quote === '"') {
                current += body[i + 1] ?? '';
                i += 1;
            } else if (ch === quote) {
                quote = undefined;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === '[' || ch === '{') {
            depth += 1;
        } else if (ch === ']' || ch === '}') {
            depth -= 1;
        } else if (ch === ',' && depth === 0) {
            parts.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim() !== '') {
        parts.push(current);
    }
    return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** A quoted string literal, or `undefined` when the text is not one. */
function asString(value: string): string | undefined {
    const match = /^"((?:[^"\\]|\\.)*)"$/.exec(value.trim()) ?? /^'([^']*)'$/.exec(value.trim());
    return match?.[1];
}

/** The quoted strings of an array literal, or `undefined` when it is not one. */
function asStringArray(value: string): string[] | undefined {
    const trimmed = value.trim();
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
        return undefined;
    }
    return splitTopLevel(trimmed.slice(1, -1))
        .map((item) => asString(item))
        .filter((item): item is string => item !== undefined);
}

interface InlineTable {
    /** Keys in the order they appear, so a rewrite can preserve them. */
    entries: Array<{ key: string; value: string }>;
}

function parseInlineTable(rhs: string): InlineTable | undefined {
    const trimmed = rhs.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        return undefined;
    }
    const body = trimmed.slice(1, -1);
    if (body.includes('{') && body.includes('}') && splitTopLevel(body).some((part) => !part.includes('='))) {
        return undefined;
    }
    const entries: Array<{ key: string; value: string }> = [];
    for (const part of splitTopLevel(body)) {
        const eq = part.indexOf('=');
        if (eq === -1) {
            return undefined;
        }
        entries.push({ key: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() });
    }
    return { entries };
}

/**
 * Parse the dependency tables of a `Cargo.toml`.
 *
 * Deliberately line-based rather than a general TOML parser: the module has no dependencies
 * (this extension ships none), and the only thing that must be perfect is not disturbing
 * text we do not understand.
 */
export function parseCargoToml(text: string): CargoTomlModel {
    const { lines, eol } = splitLines(text);
    const dependencies: ParsedDependency[] = [];
    let dependenciesHeaderLine: number | undefined;
    let section: string | undefined;

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        const header = HEADER_RE.exec(line);
        if (header) {
            const name = (header[1] ?? '').trim();
            section = name;
            if (name === 'dependencies') {
                dependenciesHeaderLine = index;
            } else if (name.startsWith('dependencies.')) {
                // Section form: the entry owns every line up to the next header.
                const depName = name.slice('dependencies.'.length).trim();
                const end = findSectionEnd(lines, index);
                const body = lines.slice(index + 1, end);
                dependencies.push(parseSectionDependency(depName, lines, index, body));
                index = end - 1;
            }
            continue;
        }

        if (section !== 'dependencies') {
            continue;
        }
        if (line.trim() === '' || line.trimStart().startsWith('#')) {
            continue;
        }

        const entry = ENTRY_RE.exec(line);
        if (!entry) {
            continue;
        }
        const name = entry[1] ?? '';
        const rhs = (entry[2] ?? '').trim();

        const plain = asString(rhs);
        if (plain !== undefined) {
            dependencies.push({ name, form: 'plain', version: plain, features: [], lines: [line], startLine: index });
            continue;
        }

        // A table that opens but does not close on this line is a multi-line inline table:
        // valid TOML, but not something this module will rewrite.
        if (rhs.startsWith('{') && !rhs.endsWith('}')) {
            const end = findMultiLineTableEnd(lines, index);
            dependencies.push({
                name,
                form: 'opaque',
                features: [],
                lines: lines.slice(index, end),
                startLine: index,
            });
            index = end - 1;
            continue;
        }

        const table = parseInlineTable(rhs);
        if (!table) {
            dependencies.push({ name, form: 'opaque', features: [], lines: [line], startLine: index });
            continue;
        }
        dependencies.push({
            name,
            form: 'table',
            version: readKey(table, 'version', asString),
            features: readKey(table, 'features', asStringArray) ?? [],
            defaultFeatures: readKey(table, 'default-features', (value) => (value.trim() === 'true' ? true : value.trim() === 'false' ? false : undefined)),
            lines: [line],
            startLine: index,
        });
    }

    return { dependencies, dependenciesHeaderLine, eol };
}

function readKey<T>(table: InlineTable, key: string, parse: (value: string) => T | undefined): T | undefined {
    const found = table.entries.find((entry) => entry.key.toLowerCase() === key);
    return found === undefined ? undefined : parse(found.value);
}

function findSectionEnd(lines: string[], headerIndex: number): number {
    for (let index = headerIndex + 1; index < lines.length; index += 1) {
        if (HEADER_RE.test(lines[index] ?? '')) {
            return index;
        }
    }
    return lines.length;
}

/** A multi-line inline table ends at the first line whose braces balance. */
function findMultiLineTableEnd(lines: string[], startIndex: number): number {
    let depth = 0;
    for (let index = startIndex; index < lines.length; index += 1) {
        for (const ch of lines[index] ?? '') {
            if (ch === '{') {
                depth += 1;
            } else if (ch === '}') {
                depth -= 1;
            }
        }
        if (depth <= 0) {
            return index + 1;
        }
    }
    return lines.length;
}

function parseSectionDependency(name: string, lines: string[], startIndex: number, body: string[]): ParsedDependency {
    const version = body.map((line) => ENTRY_RE.exec(line)).find((match) => match?.[1] === 'version')?.[2];
    const features = body
        .map((line) => ENTRY_RE.exec(line))
        .find((match) => match?.[1] === 'features')?.[2];
    return {
        name,
        form: 'section',
        version: version === undefined ? undefined : asString(version) ?? version,
        features: features === undefined ? [] : asStringArray(features) ?? [],
        lines: lines.slice(startIndex, findSectionEnd(lines, startIndex)),
        startLine: startIndex,
    };
}

/** The canonical single-line form written for a new or updated dependency. */
export function formatDependencyLine(request: DependencyRequest): string {
    const keys: string[] = [];
    if (request.version !== undefined && request.version !== '') {
        keys.push(`version = "${request.version}"`);
    }
    if (request.defaultFeatures === false) {
        keys.push('default-features = false');
    }
    if (request.features.length > 0) {
        keys.push(`features = [${request.features.map((feature) => `"${feature}"`).join(', ')}]`);
    }
    return keys.length === 0 ? `${request.name} = "*"` : `${request.name} = { ${keys.join(', ')} }`;
}

/** Everything a caller needs to describe the change before it is written. */
export function describeDependency(request: DependencyRequest): string {
    return formatDependencyLine(request);
}

export function findDependency(model: CargoTomlModel, name: string): ParsedDependency | undefined {
    return model.dependencies.find((dependency) => dependency.name === name);
}

/**
 * Add or update one dependency, returning the whole new file.
 *
 * Rules, in order:
 *  - an entry this module cannot rewrite (`opaque`) is refused, with a reason;
 *  - a `plain` entry becomes an inline table, so features can be carried;
 *  - a `table` entry keeps its other keys (`git`, `path`, `optional`, `package`, …) in their
 *    original order, and only `version` / `features` / `default-features` are touched;
 *  - a `section` entry has its `version` line updated and its `features` line replaced or
 *    inserted;
 *  - otherwise the entry is inserted after the last entry of `[dependencies]`, or the whole
 *    table is appended when the file has none.
 */
export function applyDependency(text: string, request: DependencyRequest): ApplyOutcome {
    const { lines, eol, trailingNewline } = splitLines(text);
    const model = parseCargoToml(text);
    const existing = findDependency(model, request.name);
    const finish = (next: string[], action: 'added' | 'updated', line: string, previous?: string): ApplyOutcome => ({
        ok: true,
        text: next.join(eol) + (trailingNewline ? eol : ''),
        action,
        line,
        previous,
    });

    const features = [...new Set(request.features)];

    if (existing === undefined) {
        const line = formatDependencyLine({ ...request, features });
        if (model.dependenciesHeaderLine === undefined) {
            const appended = [...lines];
            while (appended.length > 0 && (appended[appended.length - 1] ?? '').trim() === '') {
                appended.pop();
            }
            appended.push('', '[dependencies]', line);
            return finish(appended, 'added', line);
        }
        let insertAt = model.dependenciesHeaderLine + 1;
        for (const dependency of model.dependencies) {
            insertAt = Math.max(insertAt, dependency.startLine + dependency.lines.length);
        }
        const next = [...lines];
        next.splice(insertAt, 0, line);
        return finish(next, 'added', line);
    }

    if (existing.form === 'opaque') {
        return {
            ok: false,
            reason:
                `${request.name} is written as something this editor will not rewrite ` +
                `(a multi-line or unrecognised table, line ${existing.startLine + 1}). ` +
                'Edit that entry by hand, or simplify it to a single line.',
        };
    }

    if (existing.form === 'section') {
        const next = [...lines];
        const bodyStart = existing.startLine + 1;
        const bodyEnd = existing.startLine + existing.lines.length;
        const versionLine = findKeyLine(lines, bodyStart, bodyEnd, 'version');
        const featuresLine = findKeyLine(lines, bodyStart, bodyEnd, 'features');
        const previous = existing.lines.join(eol);

        if (request.version !== undefined && request.version !== '') {
            if (versionLine !== undefined) {
                next[versionLine] = `version = "${request.version}"`;
            } else {
                next.splice(bodyStart, 0, `version = "${request.version}"`);
            }
        }
        const featuresText = `features = [${features.map((feature) => `"${feature}"`).join(', ')}]`;
        const shift = request.version !== undefined && request.version !== '' && versionLine === undefined ? 1 : 0;
        if (featuresLine !== undefined) {
            next[featuresLine + shift] = featuresText;
        } else if (features.length > 0) {
            const insertAfter = (versionLine ?? existing.startLine) + shift;
            next.splice(insertAfter + 1, 0, featuresText);
        }
        return finish(next, 'updated', `${existing.name} (in [dependencies.${existing.name}])`, previous);
    }

    const previous = existing.lines[0] ?? '';
    if (existing.form === 'plain') {
        const line = formatDependencyLine({ ...request, features });
        const next = [...lines];
        next[existing.startLine] = line;
        return finish(next, 'updated', line, previous);
    }

    // table: keep every key we do not own, in order.
    const table = parseInlineTable(previous.slice(previous.indexOf('=') + 1))!;
    const owned = new Set(['version', 'features', 'default-features']);
    const kept = table.entries.filter((entry) => !owned.has(entry.key.toLowerCase()));
    const rebuilt: Array<{ key: string; value: string }> = [];
    if (request.version !== undefined && request.version !== '') {
        rebuilt.push({ key: 'version', value: `"${request.version}"` });
    }
    if (request.defaultFeatures === false) {
        rebuilt.push({ key: 'default-features', value: 'false' });
    }
    if (features.length > 0) {
        rebuilt.push({ key: 'features', value: `[${features.map((feature) => `"${feature}"`).join(', ')}]` });
    }
    const entries = [...rebuilt, ...kept];
    const line = `${existing.name} = { ${entries.map((entry) => `${entry.key} = ${entry.value}`).join(', ')} }`;
    const next = [...lines];
    next[existing.startLine] = line;
    return finish(next, 'updated', line, previous);
}

function findKeyLine(lines: string[], start: number, end: number, key: string): number | undefined {
    for (let index = start; index < end && index < lines.length; index += 1) {
        const match = ENTRY_RE.exec(lines[index] ?? '');
        if (match && match[1] === key) {
            return index;
        }
    }
    return undefined;
}
