/* House rules — the idioms this project's own Rust already uses, measured and then put in the prompt.
 *
 * WHERE THIS CAME FROM. In the Avalonia Designer the user asked *"is it possible to 'train' the model in
 * the extension as it gains experience from the user?"* — and the honest answer was no: fine-tuning needs
 * hardware this machine does not have and produces a model file to version and verify. This is the cheap,
 * deterministic version of the same wish, and it transfers to Rust unchanged: the *things* a reviewer
 * would keep correcting are facts about the code in front of us, and they can be **counted** rather than
 * guessed.
 *
 * WHAT MAKES A FACT WORTH KEEPING. Every rule here is counted, not judged:
 *
 *   - it needs a minimum number of samples (`MIN_SAMPLES`) — "logging is `defmt::info!`" means nothing
 *     when the file has two log lines;
 *   - it needs the share to be overwhelming (`MIN_SHARE`) — a codebase split 60/40 has no convention, and
 *     telling the model to follow one of them would be inventing a house style;
 *   - it says how sure it is, out loud (`samples`/`total`), so the dialog can show *"41 of 41 functions"*
 *     instead of asking the user to trust a sentence.
 *
 * NOTHING HERE CALLS A MODEL, AND NOTHING HERE IS PERSISTED. The facts are derived from the user's files
 * on demand; the ones the user accepts are stored as a setting and the prompt gets the accepted list. That
 * is also why this file has no `vscode` import — the rules are a function of text, so the suite can drive
 * them with strings instead of an editor.
 *
 * WHY THE RULES ARE RUST RULES. The designer's counters looked for `private`/`Public`, `Sub`/`Function`
 * and `<Control>_<Event>` names. Rust has none of those; what it has instead — indentation width, `pub`
 * on helpers, `?` versus `.unwrap()`, `defmt` versus `log`, `#[cfg(test)] mod tests` — is what the rules
 * below measure. A rule that does not apply to the files present simply produces no fact.
 */

/** One measured pattern, with the evidence behind it. */
export interface ConventionFact {
    /** Stable id, so an accepted fact can be recognised across runs. */
    id: string;
    /** The rule as it will be put in the prompt — one short, actionable sentence. */
    text: string;
    /** How many places agreed with it. */
    samples: number;
    /** How many places were looked at. */
    total: number;
    /** Which language it was measured in. Rust today; the field is kept so a UI can group. */
    language: 'rust';
}

/** Below this many samples, a pattern is a coincidence. */
export const MIN_SAMPLES = 5;

/** …and below this share of the samples, it is not a convention but a habit-in-transition. */
export const MIN_SHARE = 0.8;

/** A single rule longer than this is a paragraph, and the prompt is not the place for one. */
export const MAX_CONVENTION_CHARS = 200;

/** The most rules that are ever sent: a prompt is not a style guide. */
export const MAX_CONVENTIONS = 12;

/** One file the rules are measured over. */
export interface ConventionFile {
    name: string;
    text: string;
}

/** The shape every rule returns before it is filtered by confidence. */
interface Counted {
    samples: number;
    total: number;
}

function fact(id: string, text: string, c: Counted): ConventionFact | undefined {
    return { id, text, samples: c.samples, total: c.total, language: 'rust' };
}

/** Keeps only the facts that are frequent enough and one-sided enough to be a rule. */
function confident(facts: (ConventionFact | undefined)[]): ConventionFact[] {
    return facts.filter(
        (f): f is ConventionFact =>
            !!f && f.total >= MIN_SAMPLES && f.samples / f.total >= MIN_SHARE && f.text.length <= MAX_CONVENTION_CHARS
    );
}

/** Every non-blank, non-comment line of a Rust file with its leading whitespace, for the counters below. */
function codeLines(files: ConventionFile[]): { line: string; indent: string }[] {
    const out: { line: string; indent: string }[] = [];
    for (const file of files) {
        for (const raw of String(file.text ?? '').split(/\r?\n/)) {
            const t = raw.trim();
            if (!t || t.startsWith('//')) continue;
            out.push({ line: t, indent: /^[ \t]*/.exec(raw)?.[0] ?? '' });
        }
    }
    return out;
}

function allLines(files: ConventionFile[]): string[] {
    return files.flatMap((f) => String(f.text ?? '').split(/\r?\n/));
}

/** 4 spaces, 2 spaces or tabs — the one thing rustfmt leaves to a config file. */
export function countIndent(files: ConventionFile[]): { four: number; two: number; tabs: number; total: number } {
    let four = 0;
    let two = 0;
    let tabs = 0;
    let total = 0;
    for (const { indent } of codeLines(files)) {
        if (!indent) continue;
        total += 1;
        if (indent.includes('\t')) tabs += 1;
        else if (indent.length % 4 === 0) four += 1;
        else two += 1;
    }
    return { four, two, tabs, total };
}

/** `fn name(` declarations with and without `pub` — what a helper's visibility looks like here. */
export function countVisibility(files: ConventionFile[]): { private: number; pub: number; total: number } {
    let priv = 0;
    let pubCount = 0;
    for (const { line } of codeLines(files)) {
        if (!/^(?:(?:pub(?:\s*\([^)]*\))?|async|unsafe|const|extern(?:\s+"[^"]*")?)\s+)*fn\s/.test(line)) continue;
        if (/^pub\b/.test(line)) pubCount += 1;
        else priv += 1;
    }
    return { private: priv, pub: pubCount, total: priv + pubCount };
}

/** `?` propagation against `.unwrap()`/`.expect(` — how this project says "this cannot fail", or does not. */
export function countErrorStyle(files: ConventionFile[]): { question: number; unwrap: number; total: number } {
    const text = files.map((f) => String(f.text ?? '')).join('\n');
    const question = (text.match(/\?(?=\s*[;),.]|\s*$)/gm) ?? []).length;
    const unwrap = (text.match(/\.unwrap\s*\(\s*\)|\.expect\s*\(/g) ?? []).length;
    return { question, unwrap, total: question + unwrap };
}

/** `defmt` macros against `log`/`println!` — which of the two logging worlds this project lives in. */
export function countLogging(files: ConventionFile[]): { defmt: number; other: number; total: number } {
    const text = files.map((f) => String(f.text ?? '')).join('\n');
    const defmt = (text.match(/(?<![\w:])(?:defmt::)?(?:trace|debug|info|warn|error)!\s*\(/g) ?? []).length;
    const other = (text.match(/\b(?:log::\w+|println!)\s*\(/g) ?? []).length;
    return { defmt, other, total: defmt + other };
}

/** `///` doc comments against the number of functions — whether this code documents what it declares. */
export function countDocComments(files: ConventionFile[]): { documented: number; total: number } {
    const lines = allLines(files);
    let documented = 0;
    let total = 0;
    for (let i = 0; i < lines.length; i += 1) {
        if (!/^\s*(?:(?:pub(?:\s*\([^)]*\))?|async|unsafe|const|extern(?:\s+"[^"]*")?)\s+)*fn\s+[A-Za-z_]/.test(lines[i] ?? '')) continue;
        total += 1;
        let k = i - 1;
        while (k >= 0) {
            const prev = (lines[k] ?? '').trim();
            if (prev.startsWith('///')) {
                documented += 1;
                break;
            }
            if (prev.startsWith('#[') || prev.startsWith('//!') || prev === '') {
                k -= 1;
                continue;
            }
            break;
        }
    }
    return { documented, total };
}

/** `#[cfg(test)]` modules — where this project puts its tests. */
export function countTestModules(files: ConventionFile[]): { withTests: number; total: number } {
    let withTests = 0;
    for (const file of files) {
        if (/#\[cfg\s*\(\s*test\s*\)\]/.test(String(file.text ?? ''))) withTests += 1;
    }
    return { withTests, total: files.length };
}

/** `const`/`static` names in SCREAMING_SNAKE_CASE against everything else this project calls a constant. */
export function countConstNaming(files: ConventionFile[]): { screaming: number; other: number; total: number } {
    let screaming = 0;
    let other = 0;
    for (const { line } of codeLines(files)) {
        const m = /^(?:pub\s+)?(?:const|static)\s+([A-Za-z_]\w*)/.exec(line);
        if (!m) continue;
        if (/^[A-Z][A-Z0-9_]*$/.test(m[1] ?? '')) screaming += 1;
        else other += 1;
    }
    return { screaming, other, total: screaming + other };
}

/** `struct`/`enum`/`trait` names in CamelCase against everything else. */
export function countTypeNaming(files: ConventionFile[]): { camel: number; other: number; total: number } {
    let camel = 0;
    let other = 0;
    for (const { line } of codeLines(files)) {
        const m = /^(?:pub(?:\s*\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/.exec(line);
        if (!m) continue;
        if (/^[A-Z][A-Za-z0-9]*$/.test(m[1] ?? '')) camel += 1;
        else other += 1;
    }
    return { camel, other, total: camel + other };
}

/** `pub(crate)`/`pub(super)` against a bare `pub` — how wide this project's exported surface is. */
export function countPubStyle(files: ConventionFile[]): { scoped: number; bare: number; total: number } {
    let scoped = 0;
    let bare = 0;
    for (const { line } of codeLines(files)) {
        if (/\bpub\s*\(\s*(?:crate|super|self|in)\b/.test(line)) scoped += 1;
        else if (/\bpub\b/.test(line)) bare += 1;
    }
    return { scoped, bare, total: scoped + bare };
}

/**
 * The facts a set of files supports, strongest first.
 *
 * Order matters: the prompt takes the list in order and stops at `MAX_CONVENTIONS`, so the rules that say
 * the most about a line of code (visibility, error style, logging, indentation) come before the ones that
 * are merely tidy (naming).
 */
export function deriveConventions(files: ConventionFile[]): ConventionFact[] {
    const src = (files ?? []).filter((f) => f && typeof f.text === 'string');
    if (!src.length) return [];

    const indentation = countIndent(src);
    const indentRule = (() => {
        const total = indentation.four + indentation.two + indentation.tabs;
        if (total < MIN_SAMPLES) return undefined;
        if (indentation.tabs / total >= MIN_SHARE) {
            return fact('indent-tabs', `Indent with tab characters (${indentation.tabs} of ${total} indented lines).`, {
                samples: indentation.tabs,
                total
            });
        }
        if (indentation.four / total >= MIN_SHARE) {
            return fact('indent-4', `Indent with 4 spaces per level (${indentation.four} of ${total} indented lines).`, {
                samples: indentation.four,
                total
            });
        }
        if (indentation.two / total >= MIN_SHARE) {
            return fact('indent-2', `Indent with 2 spaces per level (${indentation.two} of ${total} indented lines).`, {
                samples: indentation.two,
                total
            });
        }
        return undefined;
    })();

    const visibility = countVisibility(src);
    const visibilityRule =
        visibility.total >= MIN_SAMPLES && visibility.private / visibility.total >= MIN_SHARE
            ? fact('fn-private', `Keep functions private — no \`pub\` (${visibility.private} of ${visibility.total} functions are).`, {
                samples: visibility.private,
                total: visibility.total
            })
            : undefined;

    const pubStyle = countPubStyle(src);
    const pubRule =
        pubStyle.total >= MIN_SAMPLES && pubStyle.scoped / pubStyle.total >= MIN_SHARE
            ? fact('pub-scoped', `Expose things narrowly: \`pub(crate)\`/\`pub(super)\` rather than a bare \`pub\` (${pubStyle.scoped} of ${pubStyle.total}).`, {
                samples: pubStyle.scoped,
                total: pubStyle.total
            })
            : undefined;

    const errorStyle = countErrorStyle(src);
    const errorRule =
        errorStyle.total >= MIN_SAMPLES && errorStyle.question / errorStyle.total >= MIN_SHARE
            ? fact('error-question', `Propagate failures with \`?\` rather than \`.unwrap()\`/\`.expect()\` (${errorStyle.question} of ${errorStyle.total}).`, {
                samples: errorStyle.question,
                total: errorStyle.total
            })
            : errorStyle.total >= MIN_SAMPLES && errorStyle.unwrap / errorStyle.total >= MIN_SHARE
                ? fact('error-unwrap', `This code uses \`.unwrap()\`/\`.expect()\` freely (${errorStyle.unwrap} of ${errorStyle.total}) — match that rather than adding \`Result\` plumbing.`, {
                    samples: errorStyle.unwrap,
                    total: errorStyle.total
                })
                : undefined;

    const logging = countLogging(src);
    const loggingRule =
        logging.total >= MIN_SAMPLES && logging.defmt / logging.total >= MIN_SHARE
            ? fact('log-defmt', `Log with \`defmt\` macros — \`defmt::info!(…)\` (${logging.defmt} of ${logging.total} log calls).`, {
                samples: logging.defmt,
                total: logging.total
            })
            : undefined;

    const docs = countDocComments(src);
    const docRule =
        docs.total >= MIN_SAMPLES && docs.documented / docs.total >= MIN_SHARE
            ? fact('doc-comments', `Document functions with \`///\` comments (${docs.documented} of ${docs.total} have one).`, {
                samples: docs.documented,
                total: docs.total
            })
            : undefined;

    const tests = countTestModules(src);
    const testRule =
        tests.withTests >= 2 && tests.withTests / tests.total >= 0.5
            ? fact('cfg-test', `Put unit tests in a \`#[cfg(test)] mod tests\` block at the end of the file (${tests.withTests} of ${tests.total} files).`, {
                samples: tests.withTests,
                total: tests.total
            })
            : undefined;

    const consts = countConstNaming(src);
    const constRule =
        consts.total >= MIN_SAMPLES && consts.screaming / consts.total >= MIN_SHARE
            ? fact('const-screaming', `Name constants in SCREAMING_SNAKE_CASE (${consts.screaming} of ${consts.total}).`, {
                samples: consts.screaming,
                total: consts.total
            })
            : undefined;

    const types = countTypeNaming(src);
    const typeRule =
        types.total >= MIN_SAMPLES && types.camel / types.total >= MIN_SHARE
            ? fact('type-camel', `Name types in CamelCase (${types.camel} of ${types.total}).`, {
                samples: types.camel,
                total: types.total
            })
            : undefined;

    return confident([visibilityRule, pubRule, errorRule, loggingRule, indentRule, docRule, constRule, typeRule, testRule]).slice(
        0,
        MAX_CONVENTIONS
    );
}

// ---------------- storing and rendering the accepted ones ----------------

/** Whatever the setting holds → a usable list: strings, trimmed, deduped, capped. */
export function normaliseConventions(raw: unknown): string[] {
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? parseConventionsText(raw) : [];
    const out: string[] = [];
    for (const item of list) {
        const text = String(item ?? '').trim().replace(/\s+/g, ' ');
        if (!text || text.length > MAX_CONVENTION_CHARS) continue;
        if (!out.includes(text)) out.push(text);
        if (out.length >= MAX_CONVENTIONS) break;
    }
    return out;
}

/** The checkbox list as text (what a panel's textarea holds) → a list. */
export function parseConventionsText(text: string): string[] {
    return String(text ?? '')
        .split(/\r?\n/)
        .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
        .filter((l) => l.length > 0);
}

/** The list back to one-per-line text, for a setting's textarea. */
export function conventionsText(list: string[]): string {
    return normaliseConventions(list).join('\n');
}

/**
 * The block the prompt gets, or an empty string when the user accepted nothing.
 *
 * The second parameter is accepted and ignored so a caller that still passes a language does not have to
 * change: this port only knows Rust, and the rules are already Rust's.
 */
export function conventionsBlock(list: string[], _language?: string): string {
    const rules = normaliseConventions(list);
    if (!rules.length) return '';
    return [
        'House rules measured from this project\'s own Rust (follow them; they are how the surrounding code is written):',
        ...rules.map((r) => `- ${r}`)
    ].join('\n');
}

/** Roughly what the block costs in tokens (`characters / 4`) — the same estimate the prompt budget uses. */
export function conventionsTokens(block: string): number {
    return Math.ceil(String(block ?? '').length / 4);
}
