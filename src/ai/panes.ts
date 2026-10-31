/* The panes the AI Assist is allowed to read, turned into prompt text.
 *
 * WHY THIS IS A MODULE OF ITS OWN. Reading a pane is two different jobs: asking VS Code for the facts (which
 * needs `vscode` and an active window) and saying them in a way a small local model can use (which is pure
 * text). Only the second half is interesting, and keeping it here means it can be pinned by a test with no
 * editor, no compiler and no window — the same split `selectionContext` uses.
 *
 * The Problems pane is the first source (asked 2026-10-31: *"enable the ai model to access (read) the
 * Problems … panes"*), and the only one of the four that has a real API: the pane is a view of
 * `vscode.languages.getDiagnostics()`, so nothing has to be scraped, buffered or listened to.
 */

/** One diagnostic as a prompt can carry it: 1-based positions, and no `vscode` types. */
export interface PaneDiagnostic {
    /** Workspace-relative where possible — what the developer sees in the pane. */
    file: string;
    /** 1-based line, or undefined for a problem that names only the file. */
    line?: number;
    /** 1-based column, or undefined. */
    column?: number;
    severity: 'error' | 'warning' | 'info' | 'hint';
    /** The first line of the message: rustc's explanations run for paragraphs and are not all quoted. */
    message: string;
    /** Who said it (`rustc`, `rust-analyzer`) — two providers can report the same spot. */
    source?: string;
}

/** How much of the pane a prompt carries. Both limits are small on purpose: it is a 7B model's window. */
export interface ProblemsOptions {
    /** Characters for the whole block, header included. */
    limit?: number;
    /** Diagnostics listed, at most. */
    maxItems?: number;
}

const SEVERITY_ORDER: PaneDiagnostic['severity'][] = ['error', 'warning', 'info', 'hint'];

const HEADLINE_MAX = 300;

/**
 * The Problems pane as one prompt block, or `''` when there is nothing to say.
 *
 * Three decisions worth knowing, because they are what makes the block usable rather than merely complete:
 * **errors first** (a truncated list that starts with hints is worthless), **deduplicated** (rust-analyzer and
 * rustc both report the same mistake, sometimes in different words — the same file/line/severity/message is
 * listed once), and **honest about what it left out** (`… 27 more are not shown`), so the model does not
 * conclude the project is clean past the cut.
 */
export function formatProblems(list: PaneDiagnostic[], options: ProblemsOptions = {}): string {
    const limit = options.limit ?? 2000;
    const maxItems = options.maxItems ?? 40;
    const unique: PaneDiagnostic[] = [];
    const seen = new Set<string>();
    for (const item of list) {
        const message = firstLine(item.message).slice(0, HEADLINE_MAX);
        if (!message) continue;
        const key = `${item.file}|${item.line ?? 0}|${item.column ?? 0}|${item.severity}|${message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push({ ...item, message });
    }
    if (unique.length === 0) return '';
    const order = [...unique].sort((a, b) =>
        (SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
        || a.file.localeCompare(b.file)
        || (a.line ?? 0) - (b.line ?? 0)
        || (a.column ?? 0) - (b.column ?? 0));
    const counts = { error: 0, warning: 0, info: 0, hint: 0 };
    for (const item of unique) counts[item.severity] += 1;
    const lines: string[] = [];
    let used = 0;
    for (const item of order) {
        if (lines.length >= maxItems) break;
        const where = item.line === undefined
            ? item.file
            : `${item.file}:${item.line}${item.column === undefined ? '' : `:${item.column}`}`;
        const line = `${where}: ${item.severity}: ${item.message}${item.source ? ` (${item.source})` : ''}`;
        // The header is reserved out of the budget, so a long list cannot push its own summary off the end.
        if (used + line.length + 1 > limit) break;
        lines.push(line);
        used += line.length + 1;
    }
    const hidden = order.length - lines.length;
    return `The Problems pane shows ${describeCounts(counts)}:`
        + (hidden > 0 ? ` the first ${lines.length} are below, errors first, and ${hidden} more are not shown.` : '')
        + `\n${lines.join('\n')}`;
}

/** `3 errors, 12 warnings` — in severity order, with only the kinds that actually occur. */
function describeCounts(counts: Record<PaneDiagnostic['severity'], number>): string {
    return SEVERITY_ORDER.filter((severity) => counts[severity] > 0)
        .map((severity) => `${counts[severity]} ${severity}${counts[severity] === 1 ? '' : 's'}`)
        .join(', ');
}

/** The first non-empty line, trimmed: a rustc message carries its explanation after a blank line. */
function firstLine(text: string): string {
    const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines[0] ?? '';
}

/** One line a debug session's console carried, as the DAP reported it. */
export interface DebugConsoleLine {
    /** `stderr` is marked in the block; everything else is ordinary console output. */
    category: 'stdout' | 'stderr' | 'console';
    text: string;
    /** What put it there, when it was not the program: `stopped`, `exited`, `terminated`. */
    event?: string;
}

/**
 * The Debug Console as prompt text, or `''` when the session said nothing.
 *
 * Two differences from `formatProblems`, both deliberate. It keeps the **tail**, not the head: the end of a
 * console is the failure (the panic, the exit code, the last line before the probe dropped), while the start
 * is the same boot banner every run. And it keeps the console's own shape — the program's lines in order,
 * `[stderr]` marked, with the adapter's `stopped`/`exited` events where they happened — because "the program
 * printed two lines and then stopped" is a fact about the sequence, not about any one line.
 */
export function formatDebugConsole(
    lines: DebugConsoleLine[],
    options: { limit?: number; of?: string } = {}
): string {
    const limit = options.limit ?? 2000;
    // One console line per line, whatever the adapter put in one message: a panic is `panicked at …:` followed
    // by its reason, and both belong in the block as separate lines (each marked, if it came on stderr).
    const flat: DebugConsoleLine[] = [];
    for (const entry of lines) {
        if (!entry) continue;
        for (const piece of String(entry.text ?? '').split(/\r?\n/)) {
            if (piece.trim()) flat.push({ ...entry, text: piece });
        }
    }
    const kept: string[] = [];
    let used = 0;
    for (let i = flat.length - 1; i >= 0; i -= 1) {
        const line = flat[i];
        if (!line) continue;
        const text = String(line.text ?? '').replace(/\s+$/, '');
        if (!text.trim()) continue;
        const rendered = `${line.category === 'stderr' ? '[stderr] ' : ''}${text}`;
        if (used + rendered.length + 1 > limit) break;
        kept.unshift(rendered);
        used += rendered.length + 1;
    }
    if (kept.length === 0) return '';
    const of = options.of ? ` of the ${options.of}` : '';
    const dropped = flat.length - kept.length;
    return `The Debug Console${of} shows ${kept.length} line${kept.length === 1 ? '' : 's'}`
        + `${dropped > 0 ? ` (the last ${kept.length} of ${flat.length}; the start is not shown)` : ''}:\n`
        + kept.join('\n');
}
