/* The Rust half of the assistant: the prompts, the parsing of the answer, and the edits that put a
 * function back into a `.rs` file.
 *
 * WHY THIS IS SEPARATE FROM `assistant.ts`. That module is the model-agnostic core — the OpenAI client,
 * the SSE parser, the token arithmetic, the code extractor — and it has no idea what language it is
 * helping with. This one knows exactly: it is Rust, it is `no_std` on a Pico or an ESP32, it is embassy,
 * and the thing being edited is a **function** (an `fn`), not a C# method. Keeping the two apart is what
 * lets the core stay provable with the same tests it had in the designer while this half carries all the
 * language-specific judgement.
 *
 * THE THREE RULES, inherited from the designer and re-stated for Rust (see `assistant.ts`):
 *
 *  1. **The model edits exactly one function.** The prompt asks for the *complete replacement of the
 *     function the caret is in* and nothing else. A small local model asked to "fix my file" rewrites
 *     half of it; asked to return one `fn`, it is graded by `cargo build` in seconds.
 *  2. **The signature and the attributes are not the model's to change.** `#[embassy_executor::main]`,
 *     `#[embassy_executor::task]`, `unsafe extern "C" fn` for an interrupt handler and the exact
 *     parameter list are preserved from the original text — a model that drops the attribute produces a
 *     firmware that links nowhere, and the mistake is invisible until the linker says so.
 *  3. **`use` goes inside the body.** In Rust a `use` declaration is legal inside a block, and it resolves
 *     from the crate root, so a function that needs a path can name it without a module-level edit. That
 *     is why "do not add imports" is a *safe* instruction here rather than a limitation: the model has a
 *     legal place to put every path it needs, and the file header is never touched behind a diff.
 *
 * WHAT IS PURE. Everything in this file: it takes strings and line numbers and returns strings,
 * signatures and edits. The VS Code side (`editor.ts`) gathers the facts and shows the diff, which is
 * what lets the whole feature — prompts, parsers, brace matching, insertion, signature preservation — be
 * pinned by the t1 suite without an editor, a model or a board.
 */

import type { ChatMessage } from './assistant';

// ---------------- prompts ----------------

/** The `.rs` code fence every answer is asked to use. */
const FENCE = '```rust';

/**
 * The marker that separates module-level `use` lines a *new* item needs from the item itself.
 *
 * A new item (as opposed to a rewrite) may genuinely need a path the file has not imported. Rust shares
 * the designer's problem here: `use` lines belong at the top of the module, so the answer has to be split
 * into "header additions" and "the item", and a small model is unreliable about doing that split itself.
 * The marker makes the split explicit; `parseNewItemAnswer` also copes when the model ignores it.
 */
export const NEW_ITEM_MARKER = '--- new item ---';

/** Everything a rewrite prompt needs, already read from the file by the caller. */
export interface RewritePromptInput {
    /** What the developer typed, or the finding verbatim. */
    description: string;
    /** The whole function the caret is in, attributes and body included. */
    func: string;
    /** `use …` lines, module attributes, `#![no_std]`, and any `impl`/`mod` line the function sits in. */
    header: string;
    /** What the project is: board, chip, embassy version, `no_std`. One short block, or empty. */
    target?: string;
    /** The crates and features in `Cargo.toml` — the API surface the model may use. */
    crates?: string;
    /** Optional second function from the same file, as a style reference. */
    sibling?: string;
    /**
     * The developer's own house rules, already rendered as a block. Put last before the task on purpose:
     * a small model follows the thing it read most recently.
     */
    rules?: string;
    /** Facts the compiler would otherwise have to catch (which pin does what, what the board has). */
    facts?: string;
}

/** A new item (a function that does not exist yet) needs the class-level context instead of one function. */
export interface GeneratePromptInput {
    description: string;
    header: string;
    /** The items the file already has, one per line — so the model does not duplicate them. */
    members: string;
    /** One short existing function, as a style reference. */
    style?: string;
    target?: string;
    crates?: string;
    rules?: string;
    facts?: string;
}

/** The system message: the role, and the two things a small Rust model gets wrong most often. */
function systemMessage(): ChatMessage {
    return {
        role: 'system',
        content:
            'You are a precise Rust coding assistant for embedded, often `no_std`, firmware built on the ' +
            'Embassy async framework. You return complete, compilable Rust and nothing else. You never ' +
            'invent APIs: every type, trait, function and pin name you use must already appear in the code ' +
            'you are given or in the dependency list — if it is not there, use something that is. You keep ' +
            'the function\'s attributes, signature and indentation exactly as they are. You respect ' +
            '`no_std`: no `std::`, no `String`, no `Vec`, no blocking calls unless the code you were given ' +
            'already uses them.'
    };
}

/** Shared tail of the rewrite prompts: the hard contract on the answer. */
function rewriteContract(): string {
    return (
        'Reply with the COMPLETE replacement for that function — its attributes and its `fn` signature ' +
        `line included, with the same name, parameters, return type and indentation — inside one ${FENCE} ` +
        'code block, and nothing else outside it. Put any `use` a new path needs INSIDE the function body ' +
        '(that is legal Rust); do not add `use` lines to the top of the file. Do not add other functions. ' +
        'Do not explain.'
    );
}

/** Where the developer asks for an existing function to be changed. */
export function buildImplementPrompt(input: RewritePromptInput): ChatMessage[] {
    const ask =
        `The developer wants the function below to do this:\n"""${input.description.trim()}"""\n\n` +
        'Implement it inside this function, changing nothing else:';
    return [systemMessage(), { role: 'user', content: body(input, ask, input.func) }];
}

/** Where a compiler or flash error is the specification. */
export function buildFixPrompt(input: RewritePromptInput): ChatMessage[] {
    const ask =
        `The Rust compiler (or the flash tool) reported this problem in the function below:\n` +
        `${input.description.trim()}\n\nFix exactly that problem by rewriting this function:`;
    return [systemMessage(), { role: 'user', content: body(input, ask, input.func) }];
}

/** The shared middle of a rewrite prompt: target, header, optional sibling, then the function. */
function body(input: RewritePromptInput, ask: string, func: string): string {
    const lines: string[] = [];
    if (input.target?.trim()) lines.push(`Target: ${input.target.trim()}`, '');
    lines.push(
        'File header (context only — do not change it, do not repeat it):',
        FENCE,
        input.header.trimEnd(),
        FENCE,
        ''
    );
    if (input.crates?.trim()) {
        lines.push(
            'Dependencies the project has (these, and only these, are available — a crate that is not ' +
            'listed does not exist for this project):',
            FENCE + 'toml',
            input.crates.trimEnd(),
            FENCE,
            ''
        );
    }
    if (input.sibling?.trim()) {
        lines.push(
            'Another function from the same file (style reference only — do not change it):',
            FENCE,
            input.sibling.trimEnd(),
            FENCE,
            ''
        );
    }
    // Facts before rules: they are about *what the hardware is*, not about style, and they answer the
    // questions the compiler would otherwise have to.
    if (input.facts?.trim()) {
        lines.push(
            'Facts about this board and its pins (authoritative — never invent a pin, a peripheral or a ' +
            'method that is not in the code above or in this list):',
            input.facts.trimEnd(),
            ''
        );
    }
    if (input.rules?.trim()) lines.push(input.rules.trimEnd(), '');
    lines.push(ask, FENCE, func.trimEnd(), FENCE, '', rewriteContract());
    return lines.join('\n');
}

/** Where a brand-new function is asked for, at the caret. */
export function buildGeneratePrompt(input: GeneratePromptInput): ChatMessage[] {
    const lines: string[] = [];
    if (input.target?.trim()) lines.push(`Target: ${input.target.trim()}`, '');
    lines.push(
        'The file these items belong to (context only — do not change it, do not repeat it):',
        FENCE,
        input.header.trimEnd(),
        FENCE,
        ''
    );
    if (input.crates?.trim()) {
        lines.push(
            'Dependencies the project has (these, and only these, are available):',
            FENCE + 'toml',
            input.crates.trimEnd(),
            FENCE,
            ''
        );
    }
    if (input.members.trim()) {
        lines.push(
            'Functions the file already has (context only — do not change them, do not write them again; ' +
            'you may call them):',
            FENCE,
            input.members.trimEnd(),
            FENCE,
            ''
        );
    }
    if (input.style?.trim()) {
        lines.push(
            'One of those functions in full, as a style reference (do not change it):',
            FENCE,
            input.style.trimEnd(),
            FENCE,
            ''
        );
    }
    if (input.facts?.trim()) lines.push(input.facts.trimEnd(), '');
    if (input.rules?.trim()) lines.push(input.rules.trimEnd(), '');
    lines.push(
        `The developer wants a NEW function, which does not exist yet:\n"""${input.description.trim()}"""`,
        '',
        'Write that function — its attributes, its `fn` declaration and its complete body, nothing else. ' +
        'Start on the declaration itself, indented one level (four spaces) if it goes inside an `impl` or ' +
        'a `mod`, at the left margin otherwise:',
        FENCE,
        '(make it private — plain `fn` — unless something outside this file must call it)',
        `(if the body needs a path this file does not import yet, put those \`use\` lines FIRST, then a ` +
        `line containing exactly ${NEW_ITEM_MARKER}, then the function)`,
        FENCE,
        '',
        `Reply with ONE ${FENCE} code block and nothing outside it. The block must contain the complete new ` +
        'function with a real body rather than a comment like "TODO". Do not wrap it in a `mod` or an ' +
        '`impl` that already exists, do not repeat the items listed above, and do not explain anything.'
    );
    return [systemMessage(), { role: 'user', content: lines.join('\n') }];
}

// ---------------- parsing the answer ----------------

/** A `use …;` line, as Rust spells it. */
function isUseLine(line: string): boolean {
    return /^\s*(?:pub\s+)?use\s+[^;]+;\s*$/.test(line);
}

/** One `use` line the file already has, so a duplicate is never added. */
export function alreadyImported(header: string, line: string): boolean {
    const wanted = normalizeUse(line);
    return header.split(/\r?\n/).some((l) => normalizeUse(l) === wanted);
}

function normalizeUse(line: string): string {
    return String(line ?? '').trim().replace(/;+$/, '').replace(/\s+/g, ' ');
}

/** The split of a new-item answer into the imports it asked for and the item itself. */
export interface NewItemAnswer {
    /** `use …;` lines the item asked for (may be empty). */
    uses: string[];
    /** The item itself, complete. */
    item: string;
    /** Anything the model said outside the code — carried for the log, never written. */
    note: string;
}

/**
 * Separates the `use` lines a new item needs from the item itself.
 *
 * The marker may arrive commented out (`// --- new item ---`) because models do that when the ask itself
 * was inside a code block; accepting it costs nothing. Without a marker the `use` lines are whatever leads
 * the block — in Rust a top-level `use` cannot appear inside a function, but it *can* appear at the start
 * of the answer, and that is exactly what we are looking for.
 */
export function parseNewItemAnswer(code: string, note = ''): NewItemAnswer {
    const text = String(code ?? '').replace(/\r\n/g, '\n');
    const markerRe = new RegExp(`^[ \\t]*(?://+|/\\*+|\\*)?\\s*${escapeRe(NEW_ITEM_MARKER)}\\s*\\*?/?\\s*$`, 'mi');
    const at = markerRe.exec(text);
    const head = at ? text.slice(0, at.index) : '';
    const tail = at ? text.slice(at.index + at[0].length) : text;

    const uses: string[] = [];
    const bodyLines = tail.split('\n');
    while (bodyLines.length && !(bodyLines[0] ?? '').trim()) bodyLines.shift();
    while (bodyLines.length && isUseLine(bodyLines[0] ?? '')) uses.push((bodyLines.shift() ?? '').trim().replace(/;$/, ';'));
    for (const line of head.split('\n')) {
        if (isUseLine(line)) uses.push(line.trim());
    }
    return { uses, item: bodyLines.join('\n').replace(/^\n+/, '').replace(/\s+$/, ''), note };
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------- reading a Rust file ----------------

/**
 * A function declaration, as the prompt's member list and the duplicate check need it.
 *
 * Deliberately line-based, for the same reason the designer's C# reader is: it only ever *suggests* —
 * prompt context, a duplicate check, an insertion point — and the diff is what the developer approves. A
 * real `syn` parse would be better and is not available to a TypeScript extension; this is the honest
 * approximation, and the tests pin the shapes it must get right.
 */
export interface FnInfo {
    name: string;
    /** The declaration line, trimmed (attributes are reported separately). */
    declaration: string;
    /** `pub` or `pub(crate)` — for the prompt's member list and the duplicate check. */
    isPub: boolean;
    /** The attributes immediately above the declaration, verbatim. */
    attrs: string[];
    /** 1-based line of the `fn` line. */
    line: number;
}

const FN_RE = /^(\s*)((?:(?:pub(?:\s*\([^)]*\))?|async|unsafe|const)\s+)*)fn\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/;

/** Every `fn` in the text, with the attributes directly above each one. */
export function fnSignatures(text: string): FnInfo[] {
    const out: FnInfo[] = [];
    const lines = stripBom(text).split(/\r?\n/);
    lines.forEach((raw, index) => {
        const m = FN_RE.exec(raw);
        if (!m) return;
        const attrs: string[] = [];
        for (let i = index - 1; i >= 0; i -= 1) {
            const prev = (lines[i] ?? '').trim();
            if (prev.startsWith('#[') || prev.startsWith('#![')) attrs.unshift(prev);
            else if (prev) break;
        }
        out.push({
            name: m[3] ?? '',
            declaration: raw.trim(),
            isPub: /\bpub\b/.test(m[2] ?? ''),
            attrs,
            line: index + 1
        });
    });
    return out;
}

/** A braced item in the file (a `fn`, `impl`, `mod`, `trait`), with the span an edit needs. */
export interface ItemSpan {
    name: string;
    kind: 'fn' | 'impl' | 'mod' | 'trait';
    /** 1-based line of the declaration (the `fn`/`impl`/`mod` line, not its attributes). */
    declLine: number;
    /** 1-based line of the closing brace. */
    endLine: number;
    /** The `fn` line's own text, for the function case. */
    declaration: string;
}

const ITEM_RE = /^\s*(?:(?:pub(?:\s*\([^)]*\))?|async|unsafe|const|default|extern(?:\s+"[^"]*")?)\s+)*(fn|impl|mod|trait)\b\s*([A-Za-z_]\w*)?/;

/**
 * Every braced item in the file, computed by brace counting that understands Rust trivia.
 *
 * Attributes are *not* part of the span: an edit that replaces a function must replace the `fn …` and its
 * body and leave the `#[…]` above it where it is — which is exactly what makes an attribute impossible
 * for a small model to drop (see rule 2 at the top of this file).
 */
export function itemSpans(text: string): ItemSpan[] {
    const lines = stripBom(text).split(/\r?\n/);
    const out: ItemSpan[] = [];
    for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i] ?? '';
        const m = ITEM_RE.exec(raw);
        if (!m) continue;
        // `let impl_trait = …;` and calls must not match: an item's own line may not end in `;` before its
        // body, and must contain the `{` the block needs (on this line or a later one).
        const kind = m[1] as ItemSpan['kind'];
        const name = m[2] ?? kind;
        const end = braceBlockEnd(lines, i);
        if (end < 0) continue;
        out.push({ name, kind, declLine: i + 1, endLine: end + 1, declaration: raw.trim() });
    }
    return out;
}

/**
 * Index of the line holding the `}` that closes the block opening at or after `declIndex` (0-based),
 * with comments, strings, raw strings, char literals and lifetimes skipped.
 *
 * Skipping is the whole difficulty: a brace inside a string, a byte literal, a raw string or a block
 * comment is not a brace, and a lifetime like `'a` is not a char literal (so its quote does not swallow
 * the rest of the line).
 */
export function braceBlockEnd(lines: string[], declIndex: number): number {
    let depth = 0;
    let seenOpen = false;
    for (let i = declIndex; i < lines.length; i += 1) {
        const code = stripTrivia(lines[i] ?? '');
        for (let c = 0; c < code.length; c += 1) {
            const ch = code[c];
            if (ch === '{') {
                depth += 1;
                seenOpen = true;
                continue;
            }
            if (ch === '}') {
                depth -= 1;
                if (seenOpen && depth <= 0) return i;
                continue;
            }
            // Whichever comes first decides: a `;` before any `{` is a bodyless declaration (a trait
            // method), and reporting a block for it would swallow the `impl` written below it.
            if (ch === ';' && !seenOpen) return -1;
        }
    }
    return -1;
}

/**
 * Removes the parts of a line that are not code: line comments, block comments (which nest in Rust),
 * string and raw-string bodies, byte strings, char literals — but not lifetimes.
 *
 * Block comments that open and close across lines are handled by the caller's line loop only for the
 * common single-line case; a `/*` that opens and does not close leaves the rest of the line dropped,
 * which is the conservative direction (a `}` inside a comment is never read as a brace).
 */
export function stripTrivia(line: string): string {
    let out = '';
    let i = 0;
    while (i < line.length) {
        const two = line.slice(i, i + 2);
        if (two === '//') break;
        if (two === '/*') {
            const close = line.indexOf('*/', i + 2);
            if (close < 0) break;
            i = close + 2;
            continue;
        }
        const ch = line[i] ?? '';
        // Raw strings: r"…", r#"…"#, r##"…"##, and their byte forms br#""#.
        const raw = /^(?:b?r)(#*)"/.exec(line.slice(i));
        if (raw) {
            const hashes = raw[1] ?? '';
            const end = line.indexOf(`"${hashes}`, i + raw[0].length);
            i = end < 0 ? line.length : end + hashes.length + 1;
            continue;
        }
        if (ch === '"') {
            i = skipQuoted(line, i + 1, '"');
            continue;
        }
        if (ch === 'b' && line[i + 1] === '"') {
            i = skipQuoted(line, i + 2, '"');
            continue;
        }
        if (ch === "'") {
            // A lifetime is `'` followed by an identifier and NOT a closing quote; a char literal is
            // `'x'`, `'\n'` or `'\u{1F600}'`. Only the char literal is skipped.
            if (line[i + 1] === '\\') {
                i = skipQuoted(line, i + 1, "'");
                continue;
            }
            if (line[i + 2] === "'") {
                i += 3;
                continue;
            }
            i += 1; // a lifetime: drop the quote, keep reading code
            continue;
        }
        out += ch;
        i += 1;
    }
    return out;
}

/** Index just past the closing quote, walking escapes. */
function skipQuoted(line: string, from: number, quote: string): number {
    let i = from;
    while (i < line.length) {
        const ch = line[i];
        if (ch === '\\') {
            i += 2;
            continue;
        }
        if (ch === quote) return i + 1;
        i += 1;
    }
    return line.length;
}

function stripBom(text: string): string {
    return String(text ?? '').replace(/\uFEFF/g, '');
}

/**
 * The innermost item whose body contains `line` — what an insertion is snapped to and where a new item
 * goes. `line` is 1-based. A caret on the declaration line itself counts as inside; a caret on the closing
 * brace also counts, because that is still "in this impl".
 */
export function enclosingItemSpan(text: string, line: number): ItemSpan | undefined {
    const spans = itemSpans(text);
    const hits = spans.filter((s) => s.declLine <= line && line <= s.endLine);
    if (!hits.length) return undefined;
    return hits.sort((a, b) => b.declLine - a.declLine)[0];
}

/**
 * The innermost *container* — an `impl`, `mod` or `trait` — whose body contains `line`.
 *
 * Kept apart from `enclosingItemSpan` because "where does a new item go" and "what wraps this answer" are
 * different questions: the first wants the innermost thing of any kind (a method is a fine place to be
 * inside), the second wants the container, so that unwrapping a model's `impl Foo { ... }` reads *that*
 * block rather than the first `fn` inside it.
 */
export function enclosingContainerSpan(text: string, line: number): ItemSpan | undefined {
    const spans = itemSpans(text).filter((s) => s.kind !== 'fn');
    const hits = spans.filter((s) => s.declLine <= line && line <= s.endLine);
    if (!hits.length) return undefined;
    return hits.sort((a, b) => b.declLine - a.declLine)[0];
}

/** The `fn` whose body contains `line`, or undefined when the caret is not inside one. */
export function enclosingFnSpan(text: string, line: number): ItemSpan | undefined {
    const spans = itemSpans(text).filter((s) => s.kind === 'fn');
    const hits = spans.filter((s) => s.declLine <= line && line <= s.endLine);
    if (!hits.length) return undefined;
    return hits.sort((a, b) => b.declLine - a.declLine)[0];
}

/**
 * The character offsets of the item's text — what gets replaced, and what gets read to be sent as the
 * prompt's "the function below". Offsets, because the caller is a string splice and never a line edit.
 */
export function itemOffsets(text: string, span: ItemSpan): { start: number; end: number } {
    // Offsets are found by walking the real text, not by adding one character per line: a CRLF file spends
    // two characters on every terminator, and an arithmetic that assumes otherwise silently leaves a stray
    // `\r` (and then a stray `}`) behind in the spliced file.
    const body = stripBom(text);
    const starts: number[] = [0];
    for (let i = 0; i < body.length; i += 1) {
        if (body[i] === '\n') starts.push(i + 1);
    }
    const start = starts[span.declLine - 1] ?? 0;
    // The slice is exactly the item's own text, terminator excluded: the caller sends it to a model (a
    // trailing blank line is noise) and `spliceItem` leaves the file's own line break in the tail, so the
    // blank line that separated the item from the next one survives without being part of the span.
    let end = starts[span.endLine - 1] ?? body.length;
    while (end < body.length && body[end] !== '\n' && body[end] !== '\r') end += 1;
    return { start, end };
}

/** The indentation a new item should get: the first existing item's, else one level inside the parent. */
export function itemIndent(text: string, span: ItemSpan | undefined): string {
    const lines = stripBom(text).split(/\r?\n/);
    // Start *after* the container's declaration: that line matches ITEM_RE too, and using it would return
    // the `impl`'s own indentation instead of one level inside it.
    const from = span ? span.declLine : 0;
    const to = span ? span.endLine - 1 : lines.length;
    for (let i = from; i < to && i < lines.length; i += 1) {
        if (ITEM_RE.test(lines[i] ?? '')) return /^[ \t]*/.exec(lines[i] ?? '')?.[0] ?? '';
    }
    if (span) {
        const declIndent = /^[ \t]*/.exec(lines[span.declLine - 1] ?? '')?.[0] ?? '';
        return declIndent + '    ';
    }
    return '';
}

export interface InsertItemInput {
    text: string;
    /** 1-based line the caret is on. The item goes after it, never inside it. */
    caretLine: number;
    item: string;
    /** The `impl`/`mod` it goes into, when the caret is inside one. */
    span?: ItemSpan;
}

/**
 * Inserts a new function just below the caret, on its own lines, with one blank line of separation.
 *
 * "At the caret" is snapped to a line boundary on purpose: inserting *at* the caret character would split
 * whatever line it is on. The insertion is clamped to the parent item's body, so a caret parked on the
 * closing `}` still means "inside this impl" and never lands after it.
 */
export function insertItem(input: InsertItemInput): string {
    const eol = input.text.includes('\r\n') ? '\r\n' : '\n';
    const hadBom = input.text.charCodeAt(0) === 0xFEFF;
    const body = stripBom(input.text);
    const lines = body.split(/\r\n|\n/);
    const indent = itemIndent(body, input.span);
    const itemLines = reindent(unwrapItem(input.item).item || input.item, indent, '\n').split('\n');

    const bodyStart = input.span
        ? Math.max(input.span.declLine, lines.findIndex((l, i) => i >= input.span!.declLine - 1 && l.includes('{')) + 1)
        : 1;
    const bodyEnd = input.span ? input.span.endLine - 1 : lines.length;
    const after = Math.min(Math.max(input.caretLine, bodyStart), Math.max(bodyStart, bodyEnd));
    const at = Math.min(Math.max(after, 0), lines.length);

    const prev = at > 0 ? (lines[at - 1] ?? '') : '';
    const next = lines[at] ?? '';
    const closesItem = /^\s*\}/.test(next);
    const leading = prev.trim() ? [''] : [];
    const trailing = next.trim() && !closesItem ? [''] : [];
    const result = [...lines.slice(0, at), ...leading, ...itemLines, ...trailing, ...lines.slice(at)].join(eol);
    return (hadBom ? '\uFEFF' : '') + result;
}

/**
 * The two edits that add a new item: the item itself, and the `use` lines it asked for.
 *
 * The item goes in first, so the line numbers it was computed from still mean what they meant; the `use`
 * lines are then inserted above it, after the last top-level `use` (or after the last `#![…]`/`//!` line,
 * or after any leading `//` banner). A line the file already has is never added twice.
 */
export function addItemToFile(input: InsertItemInput & { uses: string[] }): { text: string; added: string[] } {
    const withItem = insertItem(input);
    const missing = (input.uses ?? [])
        .map((u) => String(u ?? '').trim())
        .filter((u) => u.length > 0 && isUseLine(u) && !alreadyImported(withItem, u));
    if (!missing.length) return { text: withItem, added: [] };

    const eol = input.text.includes('\r\n') ? '\r\n' : '\n';
    const hadBom = input.text.charCodeAt(0) === 0xFEFF;
    const lines = stripBom(withItem).split(/\r\n|\n/);
    // Only the lines above the insertion are searched. Inner `use` (inside a `mod` or a `fn`) must not be
    // used as the anchor, which is what the brace-depth test keeps out.
    // Above the item when there is one (a `use` inside an `impl` is not a header); otherwise the whole file,
    // which the loop stops scanning at the first real item anyway. A zero limit here used to put a new `use`
    // above `#![no_std]`, which is not a legal place for it.
    const limit = input.span ? Math.max(0, Math.min(lines.length, input.span.declLine - 1)) : lines.length;
    let anchor = -1;
    let depth = 0;
    for (let i = 0; i < limit; i += 1) {
        const t = (lines[i] ?? '').trim();
        if (depth === 0) {
            if (/^(?:pub\s+)?use\b/.test(t) || /^#!\[/.test(t) || /^\/\//.test(t) || /^\/\*!/.test(t)) anchor = i;
            else if (t && !/^$/.test(t)) break; // the first real item ends the header
        }
        depth += (stripTrivia(lines[i] ?? '').match(/\{/g) ?? []).length;
        depth -= (stripTrivia(lines[i] ?? '').match(/\}/g) ?? []).length;
    }
    const at = anchor >= 0 ? anchor + 1 : 0;
    const merged = [...lines.slice(0, at), ...missing, ...lines.slice(at)].join(eol);
    return { text: (hadBom ? '\uFEFF' : '') + merged, added: missing };
}

/** Re-indents a proposal to the item's original indentation, keeping relative nesting. */
export function reindent(code: string, indent: string, eol: string): string {
    const lines = String(code ?? '').replace(/\r\n/g, '\n').split('\n');
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    if (!nonEmpty.length) return '';
    const current = Math.min(...nonEmpty.map((l) => (/^[ \t]*/.exec(l)?.[0] ?? '').replace(/\t/g, '    ').length), 99);
    return lines
        .map((l) => (l.trim() ? indent + l.replace(/\t/g, '    ').slice(current) : ''))
        .join(eol)
        .replace(/\s+$/, '');
}

// ---------------- the answer, made safe ----------------

export interface UnwrappedItem {
    item: string;
    /** True when a wrapper had to be removed — worth a log line, since it means the prompt was ignored. */
    unwrapped: boolean;
    /** How many items the answer declared inside that wrapper. */
    count: number;
    names: string[];
}

/**
 * The item a model returned, with a `mod`/`impl`/`trait` wrapper removed when it added one.
 *
 * Asked for a helper, a small model tends to answer with a complete `mod` or `impl` block, and it would
 * be inserted *inside* the existing `impl` — `expected one of …` at best, a duplicated block at worst.
 * The prompt says not to; the model copies the context it was shown anyway, so the answer is unwrapped
 * here instead of trusted. Only a wrapper declared **before** the first `fn` counts, which is what keeps
 * a nested `mod` written on purpose from being mistaken for one.
 */
export function unwrapItem(item: string): UnwrappedItem {
    const text = String(item ?? '').replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
    if (!text.trim()) return { item: '', unwrapped: false, count: 0, names: [] };
    const declared = fnSignatures(text);
    const names = declared.map((m) => m.name);
    const lines = text.split('\n');
    const declIndex = lines.findIndex((l) => /^\s*(?:pub\s+)?(?:mod|impl|trait)\b/.test(l));
    if (declIndex < 0 || (declared.length > 0 && declIndex > (declared[0]?.line ?? 0) - 1)) {
        return { item: text, unwrapped: false, count: names.length, names };
    }
    const span = enclosingContainerSpan(text, declIndex + 2);
    if (!span) return { item: text, unwrapped: false, count: names.length, names };
    const body = lines.slice(span.declLine, span.endLine - 1).join('\n');
    const fns = fnSignatures(body);
    if (!fns.length) return { item: '', unwrapped: true, count: 0, names: [] };
    const bodyLines = body.split('\n');
    const first = fns[0]!;
    const end = fns.length > 1 ? (fns[1]?.line ?? bodyLines.length + 1) - 1 : bodyLines.length;
    return {
        item: bodyLines.slice(first.line - 1, end).join('\n').replace(/\s+$/, ''),
        unwrapped: true,
        count: fns.length,
        names: fns.map((m) => m.name)
    };
}

/** A function's declared name, from the answer. Used for the duplicate check, so it must not guess. */
export function itemNameOf(item: string): string | undefined {
    return fnSignatures(item)[0]?.name;
}

/**
 * The declaration region of a function: its attributes plus its `fn …` up to and including the `{` that
 * opens the body (or the `;` of a bodyless declaration).
 */
export interface DeclRegion {
    /** The text of the declaration (attributes included), normalised to single spaces per line. */
    text: string;
    /** Where the declaration ends in the source, as a character offset. */
    end: number;
}

/** Finds the declaration of the first function in `text`, attributes and `{` included. */
export function declarationRegion(text: string): DeclRegion | undefined {
    const src = String(text ?? '');
    const lines = src.split(/\r?\n/);
    let offset = 0;
    let attrsStart = -1;
    for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i] ?? '';
        const lineStart = offset;
        offset += raw.length + 1;
        const t = raw.trim();
        if (t.startsWith('#[')) {
            if (attrsStart < 0) attrsStart = lineStart;
            continue;
        }
        if (!t || t.startsWith('//')) continue;
        if (!FN_RE.test(raw)) continue;
        const start = attrsStart >= 0 ? attrsStart : lineStart;
        // The declaration ends at the `{` (or the `;`) — beyond it is the body, which is not ours.
        const brace = src.indexOf('{', lineStart);
        const semi = src.indexOf(';', lineStart);
        const end = brace < 0 ? (semi < 0 ? offset : semi + 1) : brace + 1;
        const decl = src.slice(start, end);
        return { text: decl.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' '), end };
    }
    return undefined;
}

export interface SignatureFix {
    item: string;
    /** What was changed, for the log — empty when the answer already matched. */
    changed: string[];
}

/**
 * Puts the original function's attributes and signature back on the model's body.
 *
 * Rule 2 at the top of the file, mechanised. `#[embassy_executor::main]`, `#[embassy_executor::task]`,
 * `unsafe extern "C"` and the parameter list decide whether the firmware builds *and links*; a model that
 * rewords them produces an error that points nowhere near the model's edit. The body is left exactly as
 * the model wrote it — the signature is the part it may not touch.
 *
 * A declaration that carries no `{` on the first line (a long parameter list over several lines) is
 * handled by taking everything up to the `{` from the original, so multi-line signatures survive too.
 */
export function preserveSignature(original: string, answer: string): SignatureFix {
    const changed: string[] = [];
    const body = String(answer ?? '');
    const answerDecl = declarationRegion(body);
    const originalDecl = declarationRegion(original);
    if (!answerDecl) return { item: body, changed };
    if (!originalDecl) return { item: body, changed };

    const strip = (s: string): string => s.replace(/\s+/g, ' ').replace(/\s*([(),:])\s*/g, '$1').trim();
    if (strip(answerDecl.text) === strip(originalDecl.text)) return { item: body, changed };

    // Keep the model's body: everything from its own declaration end, prefixed with the original line's
    // indentation so a re-indent below still has something to measure from.
    const indent = /^[ \t]*/.exec(body)?.[0] ?? '';
    const rebuilt = originalDecl.text.replace(/\s+/g, ' ').trimEnd() + body.slice(answerDecl.end);
    changed.push('kept the original attributes/signature (the model had changed them)');
    return { item: indent ? rebuilt : rebuilt, changed };
}

/** ``Create a function named 'blink_task' …`` → `blink_task`, so an existing name is caught before a call. */
export function sniffItemName(description: string): string | undefined {
    return /\b(?:named|called)\s+['"`]?([A-Za-z_]\w{2,})['"`]?/i.exec(String(description ?? ''))?.[1];
}

/** A file `use` line and where an insertion should go, for the "add this dependency" offer later. */
export function useBlockStart(text: string): number {
    const lines = stripBom(text).split(/\r?\n/);
    let anchor = -1;
    for (let i = 0; i < lines.length; i += 1) {
        const t = (lines[i] ?? '').trim();
        if (/^(?:pub\s+)?use\b/.test(t) || /^#!\[/.test(t) || /^\/\//.test(t) || /^\/\*!/.test(t)) anchor = i;
        else if (t) break;
    }
    return anchor + 1;
}

/** The exact EOL the document uses, so a proposal never mixes line endings. */
/**
 * Does this code look like a whole file, rather than one item to put *into* a file?
 *
 * The two signals are the ones only a file can carry: an **inner attribute** (`#![no_std]`, `#![no_main]`) is
 * illegal anywhere but the top of a file, and `fn main` is the entry point. Everything else — a function, an
 * `impl`, a `struct` — is an item, and an item is spliced into the file it belongs to instead of replacing it
 * (asked 2026-10-04, for the chat's "implement this code" button: a refactor that returns one function must
 * not delete the rest of the file it came from).
 */
export function looksLikeWholeFile(code: string): boolean {
    const text = String(code ?? '');
    // An inner attribute cannot appear anywhere but the top of a file — the one unambiguous signal.
    if (/^\s*#!\[/m.test(text)) return true;
    // `fn main` alone is NOT enough, and that matters: a refactor of `main`'s body comes back as
    // `#[embassy_executor::main] async fn main(…) { … }` with no `use` line — treating that as a whole file
    // would replace `main.rs` with one function and silently delete every other item in it (found by the test
    // for exactly this case, 2026-10-04). With a `use` line beside it, the answer imports something, which a
    // single function never needs — that is a file.
    const hasMain = /(?:^|\n)\s*(?:pub\s+)?(?:async\s+)?fn\s+main\s*[(<]/.test(text);
    const imports = /(?:^|\n)\s*(?:pub\s+)?use\s+[^;]+;/.test(text);
    return hasMain && imports;
}

/**
 * What to call one code block in a chat answer — the label on the button that applies it.
 *
 * Cosmetic, but it is the only thing that tells two blocks in one answer apart ("Implement `fn flash_led`…"
 * against "Implement `struct Config`…"), and a model that returns a before/after pair is common enough that
 * the distinction has to exist.
 */
export function codeBlockLabel(code: string): string {
    const text = String(code ?? '');
    if (looksLikeWholeFile(text)) return 'the whole file';
    const item = /(?:^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?(fn|struct|enum|trait|impl|mod|const|static|type|union)\s+([A-Za-z_]\w*)/.exec(text);
    if (item) return `${item[1]} ${item[2]}`;
    const macro = /macro_rules!\s*([A-Za-z_]\w*)/.exec(text);
    return macro ? `macro ${macro[1]}` : 'the code';
}

/**
 * A placeholder where code should be — the model saying "and the rest stays as it is".
 *
 * This is the one thing that must never reach a file. A whole-file answer that leaves the existing code out as
 * `// ...` is not a file, and writing it deletes everything the answer did not bother to reproduce. That is
 * what happened to a real `main.rs` on 2026-10-12: the answer carried `// ... initialization code ...`, and the
 * guard that decides whether an answer *is* a file saw `use` lines beside `fn main` and said yes.
 *
 * Only comments and bare lines are matched. Three dots are legal Rust — `0..100`, `..Default::default()`, `..`
 * in a struct update — so a pattern that matched a dot anywhere would refuse half the language.
 */
export function elisionMarker(code: string): string | undefined {
    const text = String(code ?? '');
    const patterns: RegExp[] = [
        // A comment that is nothing but an ellipsis, with or without brackets.
        /^\s*\/\/\s*(\[\.\.\.\]|\.\.\.|…)\s*$/m,
        // An ellipsis *anywhere* in a comment. This is the shape a model reaches for when it does not want to
        // reproduce something — `// ... initialization code ...` — and prose is the only place three dots are
        // not legal Rust, so the trade is worth it: a false positive costs a re-ask, a miss costs a file.
        /\/\/[^\n]*(\.\.\.|…)/,
        // A comment that says, in words, that something was left out.
        /\/\/[^\n]*(\brest of (the )?(code|file|function|method)\b|\bexisting code\b|\bunchanged\b|\bsame as (before|above)\b|\bremainder of\b|\byour code here\b)/i,
        // A bare line of three dots, which is what an elided block becomes when the fence is stripped.
        /^\s*\.\.\.\s*$/m,
        /\/\*[^*]*(\.\.\.|…|\brest of\b|\bunchanged\b|\bexisting code\b)/,
        // A body that panics is a body that was not written.
        /\btodo!\(\s*\)/,
        /\bunimplemented!\(\s*\)/,
    ];
    for (const pattern of patterns) {
        const found = pattern.exec(text);
        if (found) return (found[0] ?? '...').trim().replace(/\s+/g, ' ').slice(0, 48);
    }
    return undefined;
}

/**
 * The names of the top-level items a block of Rust declares: `fn flash_led`, `struct Config`, `impl Display`.
 *
 * Used to *prove* a whole-file answer rather than to guess at one. A replacement that does not contain every
 * item the file already had is not a replacement; it is a rewrite that lost things.
 */
export function itemNames(text: string): string[] {
    const names: string[] = [];
    const pattern =
        /^[ \t]*(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+|unsafe\s+|extern\s+"[^"]*"\s+)?\b(fn|struct|enum|trait|impl|mod|union|type|const|static)\s+([A-Za-z_]\w*)/gm;
    for (const match of String(text ?? '').matchAll(pattern)) {
        const name = match[2];
        if (name !== undefined && !names.includes(name)) names.push(name);
    }
    return names;
}

/** True when `code` still carries every item `original` had. An empty original cannot lose anything. */
export function keepsEveryItem(original: string, code: string): boolean {
    const before = itemNames(original);
    if (before.length === 0) return true;
    const after = new Set(itemNames(code));
    return before.every((name) => after.has(name));
}

/**
 * Why an answer must not be applied as it stands, or `undefined` when it is safe.
 *
 * Two failures, both of them a file on disk losing code that nobody asked to lose:
 *  - the answer leaves code out behind a placeholder, so applying it deletes what the placeholder stands for;
 *  - the answer claims to be the file but has dropped items the file already had.
 *
 * Returned as a sentence rather than a boolean because every caller shows it to the developer, and the fix is
 * always the same advice: ask for the change, not for a rewritten file.
 */
export function chatCodeProblem(original: string, code: string): string | undefined {
    const marker = elisionMarker(code);
    if (marker !== undefined) {
        return (
            `The answer leaves code out (${marker}), so it is not the whole file it looks like — applying it ` +
            'would delete whatever that stands for. Ask again for the change only, or put the ✎ AI block inside ' +
            'the function you want changed.'
        );
    }
    if (!looksLikeWholeFile(code) || keepsEveryItem(original, code)) return undefined;
    const after = new Set(itemNames(code));
    const lost = itemNames(original).filter((name) => !after.has(name));
    return (
        `The answer looks like a whole file but is missing ${lost.length} of this file's own ` +
        `item(s): ${lost.slice(0, 5).join(', ')}${lost.length > 5 ? ', …' : ''}. Applying it would delete them. ` +
        'Ask for the change to one function instead.'
    );
}

/**
 * What a proposal does to a file, counted in lines.
 *
 * Line sets rather than a real diff: the question a review has to answer is "is this a change or a
 * replacement?", and for that a count of what goes and what arrives is enough. `lossy` is the warning line —
 * a proposal that removes far more than it adds is a rewrite, and a rewrite is what nobody asked for.
 */
export function changeSummary(before: string, after: string): { added: number; removed: number; lossy: boolean } {
    const lines = (text: string) =>
        new Set(String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== ''));
    const old = lines(before);
    const fresh = lines(after);
    let removed = 0;
    for (const line of old) if (!fresh.has(line)) removed += 1;
    let added = 0;
    for (const line of fresh) if (!old.has(line)) added += 1;
    return { added, removed, lossy: removed > 20 && removed > added };
}

/**
 * The file's text after `code` has been put into it.
 *
 * An **item** (the common case: the answer returns one function) goes where it belongs — replacing the
 * same-named function in place, attributes and all, or added to the file when there is no such name. A whole
 * file replaces the file. Pure, so which of the two happens is pinned by a test rather than by the model's
 * mood.
 */
export function insertChatCode(text: string, code: string): string {
    // Nothing is placed from an answer that left code out. Twice over, because the two placements destroy
    // different things: as a whole file it deletes every other item, and as an item it replaces the very
    // function the placeholder was vague about — the file survives, and the function's body does not. The
    // caller refuses first and explains (`chatCodeProblem`); this is the last line of defence.
    if (elisionMarker(code) !== undefined) return text;
    // Whole file only when it is *proven* to be one: it carries no placeholder, and it has not dropped an item
    // the file already had. Otherwise it is treated as items, which cannot lose the rest of the file.
    if (looksLikeWholeFile(code) && keepsEveryItem(text, code)) return code;
    const parsed = parseNewItemAnswer(code, '');
    const item = unwrapItem(parsed.item).item;
    const named = /(?:^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/.exec(item);
    if (named) {
        const existing = fnSignatures(text).find((f) => f.name === named[1]);
        const span = existing ? enclosingItemSpan(text, existing.line) : undefined;
        if (span) {
            const offsets = itemOffsets(text, span);
            const original = text.slice(offsets.start, offsets.end);
            // The signature and attributes are the *file's* business, not the model's: a refactor that drops
            // `#[embassy_executor::main]` would otherwise leave a program that never runs.
            return spliceItem(text, span, preserveSignature(original, item).item, detectEol(text));
        }
    }
    return addItemToFile({ text, caretLine: 1, item, uses: parsed.uses }).text;
}

export function detectEol(text: string): string {
    return String(text ?? '').includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Replaces one item with the model's version. Pure — the caller decides how to write the result — and it
 * restores a stripped BOM.
 *
 * The item's own leading whitespace is the target indentation, and the line break(s) that followed the
 * original are reproduced so the file's shape (and its line count) survives the edit. Attributes above the
 * `fn` are outside the span on purpose: they are never part of what the model returns, so they cannot be
 * lost.
 */
export function spliceItem(text: string, span: ItemSpan, code: string, eol = detectEol(text)): string {
    const body = stripBom(text);
    const { start, end } = itemOffsets(body, span);
    const raw = body.slice(start, end);
    const indent = /^[ \t]*/.exec(raw)?.[0] ?? '';
    const trailing = (/[\r\n]+$/.exec(raw)?.[0] ?? '').replace(/\r\n/g, '\n').length;
    const replacement = reindent(code, indent, eol) + eol.repeat(trailing);
    return (text.charCodeAt(0) === 0xFEFF ? '\uFEFF' : '') + body.slice(0, start) + replacement + body.slice(end);
}

/**
 * The `[dependencies]` table of a `Cargo.toml`, rendered as the prompt's "these crates exist" block.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. A small model writing embedded Rust invents APIs — it calls
 * `esp_hal::gpio::Output::new` with the wrong argument count, or reaches for `std::time` on a chip that
 * has no `std`. Telling it exactly which crates (and features) the project depends on is the cheapest,
 * most effective grounding available: a crate that is not in this list does not exist for the project, and
 * the model is told so in those words.
 */
export function crateList(cargoToml: string): string {
    const lines = String(cargoToml ?? '').split(/\r?\n/);
    const out: string[] = [];
    let inDeps = false;
    for (const raw of lines) {
        const t = raw.trim();
        if (/^\[/.test(t)) {
            inDeps = /^\[(?:target\.[^\]]+\.)?(?:dev-|build-)?dependencies\]$/.test(t);
            if (inDeps) out.push(t);
            continue;
        }
        if (inDeps && t && !t.startsWith('#')) out.push(t);
    }
    return out.join('\n');
}

/**
 * The file's header: module-level attributes, `#![…]`, `use` lines, and the `impl`/`mod` a function sits
 * in — the context the model must not change and must not repeat.
 */
export function moduleHeader(text: string, span?: ItemSpan): string {
    const lines = stripBom(text).split(/\r?\n/);
    const top: string[] = [];
    for (const raw of lines) {
        const t = raw.trim();
        if (/^(#!\[|\/\/!|\/\/|pub\s+)?use\b/.test(t) || /^#!\[/.test(t) || /^\/\/!?/.test(t) || /^#\[/.test(t)) {
            top.push(raw);
            continue;
        }
        if (!t) {
            if (top.length) top.push(raw);
            continue;
        }
        break;
    }
    if (span && span.kind !== 'fn' && span.kind !== 'mod') {
        const decl = lines[span.declLine - 1] ?? '';
        if (decl.trim()) top.push(decl.trim());
    } else if (span) {
        // A `fn` inside an `impl`/`mod`: name the enclosing item so the model knows where it lives.
        const outer = itemSpans(stripBom(text))
            .filter((s) => s.kind !== 'fn' && s.declLine <= span.declLine && span.endLine <= s.endLine)
            .sort((a, b) => b.declLine - a.declLine)[0];
        if (outer) top.push((lines[outer.declLine - 1] ?? '').trim());
    }
    return top.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}
