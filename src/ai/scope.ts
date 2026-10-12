/* The pre-flight check: is this prompt inside what the model on this machine can actually do?
 *
 * WHY THIS EXISTS (asked 2026-10-12). *"The extension must inspect each ask prompt to verify that it is within
 * the scope of the ai model capabilities. If not, warn the user and abort."*
 *
 * THE CASE THAT PROMPTED IT. A test project's `main.rs` is 41,542 bytes — roughly 10,000–11,500 tokens of Rust
 * against a window of 8192 with 4096 of that reserved for the answer, which leaves about 3.8k for the prompt.
 * The developer asked for a change and got a *whole file* back: the model could not fit the file it was told to
 * edit into its own window, so it filled the gap by inventing the rest, and every item it did not reproduce was
 * deleted. No wording of that request could have worked. It was not a bad prompt, it was arithmetic — and
 * nothing in the extension said so before the file was overwritten.
 *
 * TWO KINDS OF CHECK, and they are deliberately not treated as equally trustworthy:
 *   - **Arithmetic** — `prompt-overflow`, `file-too-big`, `item-too-long`, `answer-starved` — compares a
 *     measured size against the window the model was really started with. When one fires, the request genuinely
 *     cannot be answered well, and the numbers in the message are the evidence for saying so.
 *   - **Intent** — `whole-file-intent`, `beyond-model` — reads the developer's own sentence for the shapes a
 *     small local model cannot hold ("rewrite the whole file", "refactor the project"). This is a *heuristic*:
 *     it can be wrong in both directions, which is why the wording quotes what was read rather than asserting
 *     what is true, and why every verdict is an abort the user may override rather than a refusal.
 *
 * WHAT THIS MODULE IS NOT. It sends nothing and decides nothing about sending. It returns a verdict; the caller
 * chooses how to say it — the chat panel posts a warning into the transcript, the editor flows ask with a modal
 * — and that split is what lets every branch here be asserted in the suite instead of discovered in a dialog.
 */

import { MAX_METHOD_LINES, estimateTokens, methodTooLong, promptRoom } from './assistant';

/** Which check refused the request. Also the string the suite asserts on, so it is part of the contract. */
export type ScopeProblem =
    /** The prompt alone does not fit the window, so the model cannot read what it is being sent. */
    | 'prompt-overflow'
    /** The file the request would have to reproduce whole does not fit the window either. */
    | 'file-too-big'
    /** One item is longer than a small local model can rewrite reliably. */
    | 'item-too-long'
    /** What is left for the answer after the prompt cannot hold a function. */
    | 'answer-starved'
    /** The sentence asks for a whole file to be rewritten. */
    | 'whole-file-intent'
    /** The sentence asks for work across files that this model cannot verify. */
    | 'beyond-model';

/** What the caller knows about the request it is about to make. */
export interface ScopeFacts {
    /** Everything that will be sent, exactly as the model will read it. */
    messages: { role: string; content: string }[];
    /** The window the model actually runs with — `cfg.contextSize`, not a wish. */
    contextSize: number;
    /** The answer budget this request will ask for — `cfg.maxTokens`. */
    maxTokens: number;
    /** The developer's own sentence, when the request has one: the only thing intent can be read from. */
    request?: string;
    /** A file the request would have to reproduce whole, when there is one (a named `.rs`, say). */
    target?: { path: string; text: string };
    /** The single item the request is scoped to, when it is scoped to one. */
    item?: { name: string; text: string };
    /** The user has seen this warning and chosen to send it anyway. */
    forced?: boolean;
}

/** A verdict, ready for a surface to render. */
export interface ScopeVerdict {
    /** True when the request may be sent. */
    ok: boolean;
    problem?: ScopeProblem;
    /** The warning, with the numbers that justify it. */
    message?: string;
    /** What the developer can do instead. */
    advice?: string;
    /**
     * True when a more capable hand-off target could take the request on — which is every verdict that is not
     * ok. The caller decides whether a target is configured and available at all.
     */
    handoff: boolean;
    /** True when this is an abort the user overrode (the verdict is `ok`, with the reason kept for the log). */
    overridden?: boolean;
    /** The numbers behind the verdict, for the log and for the suite. */
    facts: {
        promptTokens: number;
        room: number;
        answerTokens: number;
        targetTokens?: number;
        itemLines?: number;
    };
}

/** Below this the answer cannot hold a rewritten item — the same floor `squeezedAnswerNotice` interrupts at. */
export const MIN_ANSWER_TOKENS = 512;

/**
 * The phrases that ask for a whole file. Deliberately narrow: naming a file is *not* one of these, because
 * "rewrite ui_handlers.rs" is a perfectly good request for a 20-line file — that case belongs to the arithmetic
 * check, which measures the file it names (see `namedRustFile`).
 */
const WHOLE_FILE_INTENT: RegExp[] = [
    /\b(?:re-?write|replace|regenerate|reproduce)\s+(?:me\s+)?(?:the\s+)?(?:whole|entire|complete|full)\s+file\b/i,
    /\b(?:re-?write|replace)\s+the\s+file\b/i,
    /\b(?:give|show)\s+me\s+the\s+(?:whole|entire|complete|full)\s+file\b/i,
    /\b(?:start|begin)\s+(?:over|from\s+scratch)\b/i
];

/** The phrases that ask for work a small local model cannot hold or verify. */
const BEYOND_MODEL_INTENT: RegExp[] = [
    /\bre-?factor\s+(?:the\s+)?(?:whole\s+|entire\s+)?(?:project|codebase|app(?:lication)?|crate)\b/i,
    /\b(?:migrate|port)\s+(?:the\s+)?(?:whole\s+|entire\s+)?(?:project|codebase|app(?:lication)?)\b/i,
    /\bacross\s+(?:the\s+)?(?:whole\s+)?(?:project|codebase)\b/i,
    /\b(?:in|into)\s+(?:every|all)\s+(?:the\s+)?(?:file|module|crate)s?\b/i,
    /\badd\s+(?:a\s+)?(?:new\s+)?(?:crate|dependency|dependencies)\b/i,
    /\b(?:write|build|create)\s+(?:me\s+)?(?:a|an|the)\s+(?:whole\s+|entire\s+|complete\s+)?(?:app|application|project|game|firmware)\b/i
];

/**
 * The `.rs` file a sentence names, if it names one.
 *
 * A named file turns an intent guess into an arithmetic fact: the caller reads that file and passes it as
 * `target`, so "rewrite main.rs" is refused because 41 KB does not fit a 3.8k prompt, rather than because a
 * pattern disliked the verb. Only the first path-looking hit is taken, and a bare name counts — `main.rs` is
 * unambiguous enough in a project whose crate has one.
 */
export function namedRustFile(request: string): string | undefined {
    const text = String(request ?? '');
    // The first character has to be a name character, so a bare ".rs" in prose (or a sentence *about* `.rs`
    // files) is not mistaken for one — there would be nothing to measure anyway.
    const paths = text.match(/[A-Za-z0-9_][\w.-]*(?:\/[\w.-]+)*\.rs\b/g);
    if (!paths?.length) return undefined;
    // Prefer the longest hit: `src/main.rs` over a stray `rs` fragment, and either over nothing.
    return paths.reduce((best, p) => (p.length > best.length ? p : best), paths[0]!);
}

/** The phrase that made an intent check fire, quoted so the warning can show what was read. */
export function intentHit(patterns: RegExp[], request: string): string | undefined {
    for (const pattern of patterns) {
        const hit = pattern.exec(String(request ?? ''));
        if (hit) return hit[0].replace(/\s+/g, ' ').trim();
    }
    return undefined;
}

/**
 * The verbs that ask for a *change* rather than an explanation.
 *
 * A heuristic, and the reason the chat can tell "why does this deadlock?" from "add a timeout to this loop":
 * the first is answerable from a clipped view of the file, the second is not — a change has to be written into
 * the file it changes, and a file that does not fit the window cannot be changed safely however the question is
 * worded. Only the chat needs this distinction; the editor's own flows are always changes.
 */
const CHANGE_VERBS =
    /\b(add|change|fix|update|implement|rewrite|remove|delete|replace|make|set|wire|connect|refactor|adjust|insert|rename|move|convert|switch)\b/i;

/** True when a sentence reads as a request to change code. Deliberately broad: it only gates a size check. */
export function looksLikeChangeRequest(request: string): boolean {
    return CHANGE_VERBS.test(String(request ?? ''));
}

function okVerdict(facts: ScopeVerdict['facts'], overridden?: { problem: ScopeProblem; message: string }): ScopeVerdict {
    return {
        ok: true,
        handoff: false,
        facts,
        ...(overridden ? { overridden: true, problem: overridden.problem, message: overridden.message } : {})
    };
}

/**
 * The check itself: measure, then judge. Never sends, never asks, never throws.
 *
 * The order is worst-first, because the first thing that is wrong is the thing worth saying: a prompt that does
 * not fit is not improved by also being asked to refactor the project, and reporting both buries the one that
 * can be fixed by a setting.
 */
export function checkScope(facts: ScopeFacts): ScopeVerdict {
    const promptTokens = estimateTokens(facts.messages.map((m) => m.content).join('\n'));
    const room = promptRoom(facts.contextSize, facts.maxTokens);
    const answerTokens = Math.max(64, Math.min(facts.maxTokens, Math.floor(facts.contextSize - promptTokens - 64)));
    const targetTokens = facts.target ? estimateTokens(facts.target.text) : undefined;
    const itemLines = facts.item ? facts.item.text.split('\n').length : undefined;

    const numbers: ScopeVerdict['facts'] = { promptTokens, room, answerTokens, targetTokens, itemLines };

    const refuse = (problem: ScopeProblem, message: string, advice: string): ScopeVerdict => {
        if (facts.forced) return { ...okVerdict(numbers, { problem, message }), handoff: true };
        return { ok: false, problem, message, advice, handoff: true, facts: numbers };
    };

    // 1. The prompt itself does not fit. Nothing else matters: the model is reading part of a request and
    //    filling the rest in from its imagination, which is the whole-file-replacement failure of 2026-10-12.
    if (promptTokens > room) {
        return refuse(
            'prompt-overflow',
            `This request is about ${promptTokens} tokens, and the model answering it has a ` +
            `${facts.contextSize}-token window with ${facts.maxTokens} of those reserved for the answer — ` +
            `about ${room} left for the prompt. It cannot read all of what it is being sent, and what it ` +
            `cannot read it invents: that is how a whole file comes back shorter than it went in.`,
            `Ask for a smaller piece (one function, one item), raise "rustyPlatform.assistant.contextSize", ` +
            `or lower "rustyPlatform.assistant.maxTokens".`
        );
    }

    // 2. The file it would have to reproduce whole does not fit either — the `main.rs` case, and the reason a
    //    request to "change one thing" in a 41 KB file cannot be answered as a diff over the file.
    if (facts.target && targetTokens !== undefined && targetTokens > room) {
        return refuse(
            'file-too-big',
            `${facts.target.path} is about ${targetTokens} tokens, which is already more than the ~${room} this ` +
            `model has for its whole prompt. Changing it means reproducing it, and it cannot see all of it.`,
            `Point the request at one function rather than the file, or hand it off.`
        );
    }

    // 3. One item, over the line limit. The model can be *shown* such a function; it cannot be asked to give the
    //    whole thing back, because the answer budget cannot hold it.
    if (facts.item && itemLines !== undefined && methodTooLong(facts.item.text)) {
        return refuse(
            'item-too-long',
            `${facts.item.name} is ${itemLines} lines — more than the ${MAX_METHOD_LINES} a small local model can ` +
            `rewrite reliably.`,
            `Pick a shorter item, ask for a helper next to it, or hand it off.`
        );
    }

    // 4. A whole file asked for by name in the sentence (the arithmetic above could not judge it if the caller
    //    had no file to measure).
    const wholeFile = intentHit(WHOLE_FILE_INTENT, facts.request ?? '');
    if (wholeFile) {
        return refuse(
            'whole-file-intent',
            `This asks for a whole file to be rewritten (read as: "${wholeFile}"). An answer of that shape is how ` +
            `a file silently loses every item the model did not feel like reproducing.`,
            `Ask for the one item that changes — leaving the rest out is how it stays unchanged.`
        );
    }

    // 5. Work that spans files, which this model can neither hold nor verify.
    const beyond = intentHit(BEYOND_MODEL_INTENT, facts.request ?? '');
    if (beyond) {
        return refuse(
            'beyond-model',
            `This asks for work across files (read as: "${beyond}"). A model this size cannot hold the project and ` +
            `the instruction at once, and it has no way to check its own changes.`,
            `Split it into one item at a time, or hand it off to the agent for this kind of work.`
        );
    }

    // 6. Last, and mildest: the prompt fits, but it has eaten so much that the answer cannot be a function.
    if (answerTokens < MIN_ANSWER_TOKENS) {
        return refuse(
            'answer-starved',
            `The prompt takes about ${promptTokens} of the ${facts.contextSize}-token window, so only about ` +
            `${answerTokens} are left for the answer — too few to write a function, and the usual reason one ` +
            `comes back cut short.`,
            `Raise "rustyPlatform.assistant.contextSize", lower "rustyPlatform.assistant.maxTokens", or ask for ` +
            `less at once.`
        );
    }

    return okVerdict(numbers);
}

/**
 * The one-line record of a verdict, for the log.
 *
 * Negative verdicts are the interesting ones and the numbers are what make them checkable later, so they are
 * always included; a positive verdict says nothing beyond "sent".
 */
export function scopeLogLine(verdict: ScopeVerdict): string {
    const { promptTokens, room, answerTokens } = verdict.facts;
    const base = `prompt=${promptTokens}/${room} tokens, answer=${answerTokens}`;
    if (verdict.ok) return verdict.overridden ? `scope: overridden (${verdict.problem}) — ${base}` : `scope: ok — ${base}`;
    return `scope: refused (${verdict.problem}) — ${base}`;
}
