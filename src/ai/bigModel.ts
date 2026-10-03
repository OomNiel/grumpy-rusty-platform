/* The 30 B step-up: what happens when the small model cannot finish the job.
 *
 * WHY THIS EXISTS (asked 2026-09-17, verbatim). *"We know we may need something better if the Qwen cant fix the
 * current issues. When it fails the system must ask the user if it should re-try a fix with the 30B model. If
 * the user agree the system should unload the Qwen and then automatically start the llama server and load the
 * 30B weigths, and attempt the fix. The user must stay informed all the time. Please realise that the average
 * user is not an AI tech user, just a simple novice programmer."*
 *
 * THE FOUR DECISIONS, which are the user's own answers given the same day:
 *   - it is offered **when a repair run ends without a clean build** — one question, at the point where the
 *     extension has genuinely run out of ideas, rather than after every individual fix attempt;
 *   - the big model is **their own systemd unit** (`llama-server.service`), because its `ExecStart` already
 *     names the 30 B: starting the unit *is* loading the model, so there is no path to configure and nothing
 *     for the user to remember;
 *   - the 7 B is **unloaded first**, which is the whole point — two models this size do not fit in 28 GB, and
 *     that is what wedged the server earlier the same day;
 *   - **every step is announced** — unloading, starting, waiting for the weights with the seconds counting,
 *     then the retry — because that waiting time is time the user spends staring at the panel.
 *
 * WHAT IS PURE. `parseExecStartModel` (which `.gguf` a unit serves) and `bigModelOffer` (is it worth offering,
 * and why not) take text and numbers and return a value, so the decision is testable without systemd, without
 * a 30 B on disk and without the user's machine. What is left is a handful of calls into `llamaService`, which
 * already knows how to start a unit and wait for it (0.10.3).
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from './log';
import { bundledRuntimeRunning, stopModelServer } from './runtime';
import { resolveLlamaUnit, startLlamaServerByChoice, unitSearchDirs } from './llamaService';

/** A file has to be this much larger than the local model to count as "something better". */
const STEP_UP_RATIO = 1.5;

/** Memory left for the editor and the OS on top of the big model's own size. */
const HEADROOM_GB = 3;

/**
 * The `.gguf` a unit serves, from its own `ExecStart` — continuation lines joined first, because a real unit
 * writes its command over nine lines with trailing backslashes (this machine's does).
 */
export function parseExecStartModel(unitText: string): string | undefined {
    const joined = String(unitText ?? '').replace(/\\\s*\r?\n\s*/g, ' ');
    for (const line of joined.split(/\r?\n/)) {
        const m = /^\s*ExecStart\s*=\s*(.+)$/i.exec(line);
        if (!m) continue;
        const file = /(?:^|\s)"?([^\s"]+\.gguf)"?/.exec(m[1]!);
        if (file) return file[1];
    }
    return undefined;
}

export interface BigModelOffer {
    ok: boolean;
    unit?: string;
    modelPath?: string;
    sizeGb?: number;
    /** Why it will not be offered. Logged, never shown as a failure: this is an offer, not a step. */
    why?: string;
}

/**
 * Is there a bigger model behind the unit, and will it fit?
 *
 * Both halves matter. A unit whose model is the same size as the local one is not a step up (it would cost a
 * minute of loading for the same answers), and a 19 GB model that cannot fit in the free RAM would turn a
 * failed repair into a wedged machine — which is exactly what happened to this machine's own server earlier
 * the same day.
 */
export function bigModelOffer(input: {
    unit?: string;
    unitText?: string;
    /** Size of the model the extension would unload — the 7 B's file. */
    localBytes: number;
    /** Memory free *before* unloading it. */
    freeGb: number;
    /** True when the unit is already answering: then there is nothing to start and no memory to find. */
    running?: boolean;
}): BigModelOffer {
    if (!input.unit || !input.unitText) {
        return { ok: false, why: 'no systemd user unit that starts a llama-server was found' };
    }
    const modelPath = parseExecStartModel(input.unitText);
    if (!modelPath) return { ok: false, why: `${input.unit} does not name a .gguf in its ExecStart` };
    let bytes = 0;
    try {
        bytes = fs.statSync(modelPath).size;
    } catch {
        return { ok: false, why: `the model ${modelPath} is not on disk` };
    }
    const sizeGb = Math.round((bytes / 1024 ** 3) * 10) / 10;
    const localGb = Math.round((input.localBytes / 1024 ** 3) * 10) / 10;
    if (bytes < input.localBytes * STEP_UP_RATIO) {
        return {
            ok: false,
            why: `${input.unit} serves ${sizeGb} GB — not a step up from the local ${localGb} GB model`
        };
    }
    if (!input.running && input.freeGb < sizeGb + HEADROOM_GB) {
        return {
            ok: false,
            why: `${sizeGb} GB would not fit in the ${Math.round(input.freeGb)} GB of memory that would be free`
        };
    }
    return { ok: true, unit: input.unit, modelPath, sizeGb };
}

/** The unit file's text, for the offer above. Missing or unreadable is "no offer", not an error. */
export function llamaUnitText(unit: string): string | undefined {
    for (const dir of unitSearchDirs()) {
        try {
            return fs.readFileSync(path.join(dir, unit), 'utf8');
        } catch { /* not here — try the next folder, then give up */ }
    }
    return undefined;
}

export interface EscalationResult {
    ok: boolean;
    message: string;
    unit?: string;
    modelPath?: string;
    sizeGb?: number;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Unload the local model, then start the unit and wait until it answers — announcing each step.
 *
 * The order is the user's, and it is not arbitrary: the weights have to leave RAM before a 19 GB one arrives.
 * `startLlamaServerByChoice('unit')` is the same path the panel's *Start server* button uses, so it waits for
 * `/props` to answer, pins the settings at the running server and reports the failed route's own words if the
 * unit cannot start.
 */
export async function escalateToBigModel(opts: { onStep: (message: string) => void }): Promise<EscalationResult> {
    const resolved = await resolveLlamaUnit();
    if (!resolved.unit) {
        return { ok: false, message: `There is no bigger model to switch to: ${resolved.why ?? 'no unit was found'}.` };
    }
    const unit = resolved.unit;
    const text = llamaUnitText(unit);
    const modelPath = text ? parseExecStartModel(text) : undefined;
    let sizeGb: number | undefined;
    try {
        sizeGb = modelPath ? Math.round((fs.statSync(modelPath).size / 1024 ** 3) * 10) / 10 : undefined;
    } catch { /* the offer already checked it; a file that vanished just means no size to report */ }
    log(`bigModel: escalating to ${unit}${modelPath ? ` (${modelPath})` : ''}`);

    if (bundledRuntimeRunning().running) {
        opts.onStep('unloading the 7B to make room for the big model…');
        stopModelServer();
        // Bounded wait: the sidecar says it is gone when it is gone, and the port it held is freed with it.
        for (let i = 0; i < 60 && bundledRuntimeRunning().running; i += 1) await delay(250);
        opts.onStep(bundledRuntimeRunning().running
            ? 'the 7B did not unload in time — starting the big model anyway'
            : 'the 7B is unloaded, its memory is free again');
    }

    opts.onStep(`starting ${unit}…`);
    const started = await startLlamaServerByChoice('unit', { onProgress: opts.onStep });
    if (!started.ok) return { ok: false, message: started.message };
    return { ok: true, unit, modelPath, sizeGb, message: started.message };
}
