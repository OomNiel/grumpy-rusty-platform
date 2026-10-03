/**
 * The AI assist's prompt, written **where the work is** — in the editor, at the caret.
 *
 * WHY THIS EXISTS (asked 2026-09-18): *"place the prompt input box next to the current cursor position and make
 * the prompt entry box a multi-line (at least 5 lines) input area"*. Neither half is possible with the prompt
 * widget the extension used until then: `vscode.window.showInputBox` is single-line by design (`InputBoxOptions`
 * has `value`, `valueSelection`, `prompt`, `placeHolder` — no `multiline`, no `rows`), and VS Code always draws
 * it at the top of the window; there is no API to anchor it at the caret. The Comments API is not an alternative
 * either: a `CommentThread` has `canReply` and a `label`, but no `input` and no submit event, so a reply typed
 * into one goes nowhere an extension can read (checked against the shipped `@types/vscode`, 2026-09-18).
 *
 * So the editor itself is the input. `AI: Implement in Function…` inserts a *marker block* at the caret:
 *
 *     // ✎ AI: begin — write what you want below, as many lines as you like
 *     |
 *     // ✎ AI: end
 *
 * the caret is placed between the two markers (`$0` in the snippet, so it is where the user is already looking),
 * and the two commands a code lens offers — **Send to AI assist** and **Cancel** — read the block, remove it, and
 * hand the text to the same flow the single-line box used to feed. That gives the request what the dialog could
 * not: the caret's own position, as many lines as the user needs, `Ctrl+Z` to abandon it, and no length limit
 * that has to be guessed before typing starts.
 *
 * Everything here is pure text handling — the module imports nothing — so the parsing, the prefix per language
 * and the "leave the file exactly as it was" property are all pinned by the suite rather than by a screenshot.
 */

/** The marker that opens the block. Kept verbatim in one place: the parser and the snippet cannot drift. */
export const PROMPT_BEGIN = '✎ AI: begin — write what you want below, as many lines as you like';

/** The marker that closes it. */
export const PROMPT_END = '✎ AI: end';

/** Where the block is, and what the user wrote in it. Line numbers are 0-based. */
export interface PromptBlock {
    begin: number;
    end: number;
    /** The prompt, comment prefixes stripped, blank lines kept as blank lines. */
    prompt: string;
}

/** Either the block, or the reason there is none — so "Send" can say something true. */
export type PromptBlockResult =
    | { ok: true; block: PromptBlock }
    | { ok: false; why: string };

/**
 * The comment prefix for a language. Every file this port touches is Rust, and a Rust line comment is `//` —
 * so the marker block is always a legal comment in the buffered editor. The function stays (rather than the
 * prefix being inlined) because an unknown language still gets `//`: a marker that is not a comment is still
 * *findable*, which is the property that matters.
 */
export function commentPrefix(_languageId: string): string {
    return '//';
}

/**
 * What is inserted at the caret: the two markers with an empty line between them, and `$0` on that line so the
 * caret lands there and typing starts immediately. The trailing newline keeps the block self-contained — the
 * line after the marker is the line that was at the caret before.
 */
export function promptSnippet(languageId: string): string {
    const prefix = commentPrefix(languageId);
    return `${prefix} ${PROMPT_BEGIN}\n$0\n${prefix} ${PROMPT_END}\n`;
}

/** Strips one comment prefix (and one optional space) so `// buy milk` and `'buy milk` both read as the text. */
function stripPrefix(line: string): string {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) return trimmed.slice(2).trim();
    if (trimmed.startsWith("'")) return trimmed.slice(1).trim();
    return trimmed;
}

/** A line that is one of the two markers, whatever comment prefix it carries. */
function markerIndex(lines: string[], marker: string, from: number): number {
    for (let i = from; i < lines.length; i++) {
        if (stripPrefix(lines[i] ?? '') === marker) return i;
    }
    return -1;
}

/**
 * Finds the block in a document's text.
 *
 * The reasons for "no" are separate and specific because each one is a different thing for the user to fix: a
 * block whose end marker was deleted (they edited inside it and removed a line) is not the same as a block they
 * never made, and "Send" must not answer both with "no prompt".
 */
export function findPromptBlock(text: string): PromptBlockResult {
    const lines = text.split(/\r?\n/);
    const begin = markerIndex(lines, PROMPT_BEGIN, 0);
    if (begin < 0) {
        return { ok: false, why: `There is no ✎ AI block in this file — run "AI: Implement in Function…" to start one.` };
    }
    const end = markerIndex(lines, PROMPT_END, begin + 1);
    if (end < 0) {
        return { ok: false, why: 'The ✎ AI block has lost its closing marker, so there is nothing to send.' };
    }
    const prompt = lines.slice(begin + 1, end).map(stripPrefix).join('\n').trim();
    if (!prompt) {
        return { ok: false, why: 'The ✎ AI block is empty — write what the code should do between the markers.' };
    }
    return { ok: true, block: { begin, end, prompt } };
}

/**
 * The document text with the block taken out — the whole point of the markers being *ours*: a request that is
 * sent, cancelled or refused leaves the file byte-identical to how it was before the block was inserted, so a
 * prompt can never quietly become a comment in someone's source.
 */
export function stripPromptBlock(text: string, block: PromptBlock): string {
    // The file's own line ending is restored on the way out: splitting on `\r?\n` drops it, and joining
    // with `\n` would rewrite every line of a CRLF document just because a prompt block was removed.
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    lines.splice(block.begin, block.end - block.begin + 1);
    return lines.join(eol);
}

/** True when the text contains a marker at all — the cheap check the lens provider runs on every document. */
export function hasPromptBlock(text: string): boolean {
    return text.includes(PROMPT_BEGIN) || text.includes(PROMPT_END);
}
