/**
 * What `cargo build` says, as data — the pure half of the build oracle.
 *
 * WHY THIS IS SPLIT FROM `cargoBuild.ts`. That module owns the VS Code side (the diagnostic collection)
 * and therefore imports `vscode`, which the t1 suite cannot load. The parsing, the file filter and the
 * error picker are a function of text and belong on this side of the line, so the suite can drive them
 * with real cargo output instead of a compiler.
 *
 * WHY `--message-format=json` IS THE FORMAT PARSED. `cargo build` prints pretty, coloured, wrapped human
 * output, and a message can span several lines — the span it points at is not in the text at all. The JSON
 * form carries the level, the error code (`E0425`), the message AND the exact `line_start`/`column_start`,
 * so nothing is inferred. The plain-text parser below exists for the lines cargo emits *before* it starts
 * compiling: a broken `Cargo.toml`, a missing target, a linker error from `rust-lld`.
 */

/** One place the compiler pointed at, in a file the user can open. */
export interface CompilerDiagnostic {
    /** Absolute path of the file the compiler pointed at. */
    file: string;
    line: number;
    column: number;
    severity: 'error' | 'warning';
    /** `E0425`, `E0308`, `unused_variables`, … */
    code: string;
    message: string;
}

/** An error about the project itself rather than a place in the code. */
export interface ProjectError {
    code: string;
    message: string;
}

export interface BuildResult {
    /** True when `cargo build` exited 0. */
    ok: boolean;
    /** Diagnostics in the project's own source files (generated output is dropped). */
    diagnostics: CompilerDiagnostic[];
    /** Errors with no file or line (`error: could not compile`, `Cargo.toml` problems, linker failures). */
    projectErrors: ProjectError[];
    errors: number;
    warnings: number;
    /** Diagnostics that pointed outside the project (registry sources, `target/`, …). */
    skipped: number;
    /** Why no build could be run at all (`cargo` missing, a timeout, …). */
    failure?: string;
    /** The tail of cargo's own output, for the log and for a message that has no better wording. */
    stderr?: string;
}

/** How long a cold embedded build is allowed to take before it is called a timeout. */
export const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

/** Diagnostics whose file is not the project's own source (dependencies, `target/`, …). */
export function isProjectSource(file: string, projectDir: string): boolean {
    const rel = relativeInside(projectDir, file);
    if (rel === undefined) return false;
    return !rel.split('/').some((p) => p === 'target' || p === '.git');
}

/** `file` relative to `dir` with `/` separators, or undefined when it is outside `dir`. */
function relativeInside(dir: string, file: string): string | undefined {
    // `path.relative` needs node's `path`; a small hand-rolled version keeps this module dependency-free
    // and is enough for the two separators cargo emits on the three platforms it runs on.
    const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const a = norm(dir);
    const b = norm(file);
    if (!a) return b;
    if (b === a) return '';
    if (b.startsWith(`${a}/`)) return b.slice(a.length + 1);
    // A relative `file_name` (cargo emits `src/main.rs`) is inside the project by construction.
    if (!b.startsWith('/') && !/^[A-Za-z]:\//.test(b)) return b;
    return undefined;
}

/** Resolves a cargo `file_name` against the project directory, with `/` separators. */
export function resolveInProject(dir: string, file: string): string {
    const base = dir.replace(/\\/g, '/').replace(/\/+$/, '');
    const rel = file.replace(/\\/g, '/');
    if (rel.startsWith('/') || /^[A-Za-z]:\//.test(rel)) return rel;
    return `${base}/${rel}`;
}

/** One `compiler-message` record, as much of it as rustc's JSON promises. */
interface CargoMessage {
    reason?: unknown;
    message?: {
        message?: unknown;
        code?: { code?: unknown } | null;
        level?: unknown;
        spans?: { file_name?: unknown; line_start?: unknown; column_start?: unknown; is_primary?: unknown }[];
    };
}

/**
 * Every diagnostic in cargo's JSON stream, de-duplicated.
 *
 * Cargo prints a message per *target*, and with a workspace the same file can be compiled more than once,
 * so the same error can appear twice and would double the count the user is shown. The key is
 * file+line+column+code+message, which is stable across the duplicates.
 *
 * A message with no primary span is a `projectError` only when it is an error: `warning: unused manifest
 * key` is noise, and a build that succeeds must not be reported as broken by a warning.
 */
export function parseCargoMessages(text: string, projectDir?: string): {
    diagnostics: CompilerDiagnostic[];
    projectErrors: ProjectError[];
    skipped: number;
} {
    const diagnostics: CompilerDiagnostic[] = [];
    const projectErrors: ProjectError[] = [];
    const seen = new Set<string>();
    let skipped = 0;

    for (const line of String(text ?? '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        let record: CargoMessage;
        try {
            record = JSON.parse(trimmed) as CargoMessage;
        } catch {
            continue;
        }
        if (record.reason !== 'compiler-message' || !record.message) continue;
        const level = record.message.level;
        if (level !== 'error' && level !== 'warning') continue;
        const code = typeof record.message.code?.code === 'string' ? record.message.code.code : '';
        const message = typeof record.message.message === 'string' ? record.message.message.trim() : '';
        const spans = Array.isArray(record.message.spans) ? record.message.spans : [];
        const primary = spans.find((s) => s && s.is_primary === true) ?? spans[0];
        const file = typeof primary?.file_name === 'string' ? primary.file_name : '';
        if (!file || !projectDir || !isProjectSource(file, projectDir)) {
            if (level === 'error') {
                const where = file ? ` (in ${file})` : '';
                projectErrors.push({ code, message: `${message}${where}` });
            } else {
                skipped += 1;
            }
            continue;
        }
        const diagnostic: CompilerDiagnostic = {
            file: resolveInProject(projectDir, file),
            line: typeof primary?.line_start === 'number' ? primary.line_start : 1,
            column: typeof primary?.column_start === 'number' ? primary.column_start : 1,
            severity: level,
            code,
            message
        };
        const key = `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}:${code}:${message}`;
        if (seen.has(key)) {
            skipped += 1;
            continue;
        }
        seen.add(key);
        diagnostics.push(diagnostic);
    }
    return { diagnostics, projectErrors, skipped };
}

/**
 * `src/main.rs:12:5: error[E0425]: …` and `error: could not compile …` — the shapes rustc and cargo emit in
 * plain text, kept for the failures that happen before rustc starts.
 */
export function parseRustcText(text: string, projectDir?: string): {
    diagnostics: CompilerDiagnostic[];
    projectErrors: ProjectError[];
} {
    const diagnostics: CompilerDiagnostic[] = [];
    const projectErrors: ProjectError[] = [];
    const seen = new Set<string>();
    for (const rawLine of String(text ?? '').split(/\r?\n/)) {
        const line = rawLine.trim();
        const located = /^([^\s:][^:]*\.rs):(\d+):(\d+):\s+(error|warning)(?:\[([A-Za-z0-9_]+)\])?:\s+(.+)$/.exec(line);
        if (located && projectDir) {
            const file = resolveInProject(projectDir, located[1] ?? '');
            if (!isProjectSource(file, projectDir)) continue;
            const key = `${file}:${located[2]}:${located[3]}:${located[6]}`;
            if (seen.has(key)) continue;
            seen.add(key);
            diagnostics.push({
                file,
                line: Number(located[2]),
                column: Number(located[3]),
                severity: located[4] === 'warning' ? 'warning' : 'error',
                code: located[5] ?? '',
                message: (located[6] ?? '').trim()
            });
            continue;
        }
        const m = /^(error|warning)(?:\[([A-Za-z0-9_]+)\])?:\s+(.+)$/.exec(line);
        if (m && m[1] === 'error' && !/^(Compiling|Finished|Building|Blocking|Updating|Downloaded|Downloading)\b/.test(line)) {
            projectErrors.push({ code: m[2] ?? '', message: (m[3] ?? '').trim() });
        }
    }
    return { diagnostics, projectErrors };
}

/** Merges the JSON parse with the plain-text fallback, without counting anything twice. */
export function parseCargoOutput(text: string, projectDir?: string): {
    diagnostics: CompilerDiagnostic[];
    projectErrors: ProjectError[];
    skipped: number;
} {
    const json = parseCargoMessages(text, projectDir);
    const plain = parseRustcText(text, projectDir);
    const known = new Set(json.diagnostics.map((d) => `${d.file}:${d.line}:${d.column}:${d.code}:${d.message}`));
    for (const d of plain.diagnostics) {
        const key = `${d.file}:${d.line}:${d.column}:${d.code}:${d.message}`;
        if (!known.has(key)) {
            known.add(key);
            json.diagnostics.push(d);
        }
    }
    const seenError = new Set(json.projectErrors.map((p) => `${p.code}:${p.message}`));
    for (const p of plain.projectErrors) {
        const key = `${p.code}:${p.message}`;
        if (!seenError.has(key)) {
            seenError.add(key);
            json.projectErrors.push(p);
        }
    }
    return json;
}

/** The first `error: …` line of cargo's own output, for a message with no better wording. */
export function firstCargoError(stderr: string): string | undefined {
    for (const raw of String(stderr ?? '').split(/\r?\n/)) {
        const line = raw.trim();
        if (/^error(\[[A-Za-z0-9_]+\])?:/.test(line)) return line;
    }
    return undefined;
}
