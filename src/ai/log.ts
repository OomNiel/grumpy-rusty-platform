import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/** A single shared output channel ("Grumpy's WYSIWYG Designer") for extension diagnostics.
 *  Visible in: View → Output → "Grumpy's WYSIWYG Designer" (more reliable than console.log,
 *  which only lands in the Extension Host output, not the exthost.log file). */
let channel: vscode.OutputChannel | undefined;

/**
 * The file every line is mirrored into as well, once something calls `mirrorLogTo`.
 *
 * This exists because the split was invisible for a whole afternoon: `aiLog` wrote the file while the AI
 * client called plain `log`, so `logs/ai.log` was 766 lines of panel and load chatter with **not one**
 * `AI request:` or failure line in it — and that file is what a report gets checked against. One sink, so
 * "which log do I read?" has one answer.
 */
let mirror: string | undefined;

/** Mirror every line to this file (the caller decides where; `aiLog` passes `logs/ai.log`). */
export function mirrorLogTo(file: string): void {
    mirror = file;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch {
        /* best effort: an unwritable log must not break a load */
    }
}

/**
 * Where the mirrored file stops growing, and what a trim leaves behind.
 *
 * Exported so the test asserts the real numbers instead of a copy of them.
 */
export const MIRROR_LIMITS = {
    /** Past this the file is cut back. */
    maxBytes: 512 * 1024,
    /** How much of the *newest* text a trim keeps — well under `maxBytes`, so a trim is rare rather than
     *  something that happens on every line. */
    keepBytes: 256 * 1024,
    /** One message longer than this is cut: a runaway compiler line must not own the whole budget. */
    maxLine: 2000,
    /** The file is measured once per this many lines, not once per line. */
    statEvery: 200
} as const;

let appendsSinceStat = 0;

function appendToMirror(msg: string): void {
    if (!mirror) return;
    try {
        const line = msg.length > MIRROR_LIMITS.maxLine
            ? `${msg.slice(0, MIRROR_LIMITS.maxLine)}… (${msg.length - MIRROR_LIMITS.maxLine} characters cut)`
            : msg;
        fs.appendFileSync(mirror, `[${new Date().toISOString()}] ${line}\n`);
        appendsSinceStat += 1;
        if (appendsSinceStat >= MIRROR_LIMITS.statEvery) {
            appendsSinceStat = 0;
            trimMirror();
        }
    } catch {
        /* logging must never be the reason something fails */
    }
}

/**
 * Keeps the log bounded **without throwing the history away**.
 *
 * It used to delete the whole file the moment it passed 512 KB (found 2026-09-18, asked as *"how large is
 * the log file? I think we should clamp it's length limited"*): the file was 504 KB holding three days of
 * work — every diagnosis of the 30B step-up, the CS1002 rule and the missing `;` — and one more line would
 * have erased all of it. The first line already showed that had happened once before.
 *
 * Now the oldest lines go, the newest `keepBytes` stay, the cut is made on a **line boundary** (half a line
 * at the top of a log reads as corruption), and a marker line says how much was dropped — so a report can
 * still be read against the tail that matters.
 */
export function trimMirror(): void {
    if (!mirror) return;
    let size = 0;
    try {
        size = fs.statSync(mirror).size;
    } catch {
        return;
    }
    if (size <= MIRROR_LIMITS.maxBytes) return;
    try {
        const all = fs.readFileSync(mirror, 'utf8');
        const tailStart = Math.max(0, all.length - MIRROR_LIMITS.keepBytes);
        const newline = all.indexOf('\n', tailStart);
        const tail = newline < 0 ? '' : all.slice(newline + 1);
        if (!tail) return;
        const kb = (n: number): number => Math.round(n / 1024);
        const marker = `[${new Date().toISOString()}] --- trimmed: the oldest ${kb(all.length - tail.length)} KB `
            + `were dropped to stay under ${kb(MIRROR_LIMITS.maxBytes)} KB; the newest ${kb(tail.length)} KB are `
            + `kept. The same lines are in View → Output → Grumpy's WYSIWYG Designer for this window. ---\n`;
        // Written beside the file and renamed over it, so a crash cannot leave half a log behind.
        const tmp = `${mirror}.tmp`;
        fs.writeFileSync(tmp, marker + tail, 'utf8');
        fs.renameSync(tmp, mirror);
    } catch {
        /* a trim that fails leaves the file as it was, and the next one tries again */
    }
}

/**
 * Points the AI subsystem at the extension's own output channel.
 *
 * Called once from `activate`, so a line about a model load and a line about a probe flash land in the same
 * place — the alternative (this module creating its own channel) is how an extension ends up with two Output
 * views and no answer to "which log do I read?".
 */
export function initAiLog(output: vscode.OutputChannel): void {
    channel = output;
}

export function log(msg: string): void {
    if (!channel) channel = vscode.window.createOutputChannel('Grumpy\'s Rusty Platform');
    const ts = new Date().toISOString().slice(11, 19);
    channel.appendLine(`[${ts}] ${msg}`);
    appendToMirror(msg);
}

export function logError(err: unknown): void {
    log('ERROR: ' + (err instanceof Error ? err.message : String(err)));
}
