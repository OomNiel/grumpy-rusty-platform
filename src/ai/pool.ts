/* The hand-off: when the local model cannot take a request, give it to the `pool` agent instead.
 * WHY THIS EXISTS (asked 2026-10-12). The scope gate (`ai/scope.ts`) refuses a prompt the local model cannot
 * answer. A refusal on its own is a dead end, so this is the other half: *"can we hand off the prompt ... to a
 * listening cloud api agent?"* — and the answer on this machine is `pool`, Poolside's CLI agent, which is
 * already installed, already authenticated and already has the big model the small one lacks.
 *
 * THE CONTRACT, MEASURED RATHER THAN ASSUMED (all of it verified against `pool` 1.0.16, 2026-10-12):
 *   - `pool exec` runs non-interactively, which is the only mode that can be spawned from an editor;
 *   - `-o json` is NDJSON on stdout: `{"message":"OK","type":"assistantMessage"}` for the answer,
 *     `{"name":"toolCall", ...}`-shaped entries for the work, and a closing `exit` tool call whose `args.success`
 *     is the agent's own verdict;
 *   - exit code **0** is task success and **4** is the agent saying it could not do it; anything else is an
 *     unexpected error, and the three are reported differently;
 *   - `-p -` reads the prompt from **stdin**. That is the one that matters most: the scripted prompt carries the
 *     developer's own code, with newlines, quotes and `$`, and passing it through a shell would be a quoting
 *     minefield — and `-p "…"` would put the whole prompt in the process list for anything on the machine to
 *     read;
 *   - `--continue <Run ID>` resumes a conversation, and the Run ID is the UUID in the run's own trajectory file
 *     name (`~/.local/state/poolside/trajectories/trajectory-standalone_<uuid>.ndjson`), which is how the second
 *     hand-off of a session carries on rather than starting over.
 *
 * WHAT IS *NOT* HERE. There is no model selection: `-m` is obsolete on `exec` (it errors and points at
 * `--agent-name`), because the platform's agent owns the model choice. So a user who wants a particular model
 * sets it in pool's own configuration, not here — and the settings this module reads name an *agent*, not a
 * model.
 *
 * PURE AND EFFECTFUL, split the way the rest of `ai/` splits it: building the arguments, reading the NDJSON,
 * naming a tool call and scripting the prompt are all pure and asserted in the suite; only the spawn and the
 * trajectory lookup touch the world.
 */

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isMissingExecutable } from './sys';
import type { Progress } from './localModelCore';

/**
 * Diagnostics, loaded on demand rather than imported.
 *
 * `ai/log.ts` reaches for `vscode`, and this module is asserted in the t2 layer against a fake `pool` executable
 * — a real child process, real stdin, no editor running. A top-level `import { log } from './log'` would make
 * the module unloadable there (it failed exactly that way on 2026-10-12, "Cannot find module 'vscode'"), and the
 * dependency is only ever a log line, so it is paid for at the moment one is written.
 */
function log(message: string): void {
    try {
        (require('./log') as { log: (text: string) => void }).log(message);
    } catch {
        /* no editor to log into: the message is diagnostics, and losing it costs nothing */
    }
}

/** `pool exec`'s own exit code for "I ran and I could not do it" (0 is success; anything else is an error). */
export const POOL_TASK_FAILED = 4;

/** Refuse a run that produces more than this much output: an agent in a loop must not eat the editor's memory. */
export const POOL_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** Where pool keeps one NDJSON file per run. The fallback for when `pool config` cannot say. */
export function defaultTrajectoryDir(home = os.homedir()): string {
    return path.join(home, '.local', 'state', 'poolside', 'trajectories');
}

/** What a hand-off asks `pool exec` to do. */
export interface PoolRunOptions {
    /** The scripted prompt, written to the process's stdin. */
    prompt: string;
    /** The project the agent works in (`-d`). */
    directory: string;
    /** Resume this conversation (`--continue`), when a previous hand-off left a Run ID. */
    continueId?: string;
    /**
     * Pass `--unsafe-auto-allow`.
     *
     * Without it a non-interactive run cannot approve its own tool use, so a task that needs to edit a file
     * stops and asks nobody. This is the flag that makes the hand-off *do* something, which is also why the
     * consent dialog says so in as many words before the run starts.
     */
    autoAllow?: boolean;
    /** `-a`: the platform agent to use. Empty means pool's own default. */
    agent?: string;
}

/**
 * The argument list for one hand-off — pure, so the shape can be asserted without running an agent.
 *
 * The order is pool's own: `exec`, the output format, the working directory, the optional flags, then `-p -`
 * last. The prompt is never an argument.
 */
export function poolArgs(opts: PoolRunOptions): string[] {
    const args = ['exec', '-o', 'json', '-d', opts.directory];
    if (opts.agent) args.push('-a', opts.agent);
    if (opts.continueId) args.push('--continue', opts.continueId);
    if (opts.autoAllow) args.push('--unsafe-auto-allow');
    args.push('-p', '-');
    return args;
}

/** One tool call the agent made, as the agent reported it. */
export interface PoolToolCall {
    name: string;
    args: Record<string, unknown>;
}

/** What a run's NDJSON adds up to. */
export interface PoolRecord {
    /** Every `assistantMessage` in the run, in order: the agent narrating its own work. */
    answer: string;
    /** Only what the agent said after its **last** tool call — the closes-the-loop summary, when there is one. */
    final: string;
    toolCalls: PoolToolCall[];
    /** The agent's own `exit` call, when it sent one: its verdict on whether the task is done. */
    exitSuccess?: boolean;
    /** Which message types appeared and how often, so a shape this parser does not know is visible. */
    types: Record<string, number>;
}

/**
 * Reads a run's NDJSON.
 *
 * A line that is not JSON is skipped rather than fatal: pool writes its logs elsewhere, but a future version
 * could print a warning on stdout, and losing a whole run's answer to one unexpected line would be a poor trade.
 * Unknown *types* are counted in `types` so the suite (and a bug report) can see them instead of this parser
 * quietly ignoring a message that mattered.
 */
export function parsePoolNdjson(text: string): PoolRecord {
    const record: PoolRecord = { answer: '', final: '', toolCalls: [], types: {} };
    let afterLastTool = '';
    const parts: string[] = [];
    for (const raw of String(text ?? '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        let message: { type?: unknown; message?: unknown; name?: unknown; args?: unknown };
        try {
            message = JSON.parse(line);
        } catch {
            record.types['(unparsed)'] = (record.types['(unparsed)'] ?? 0) + 1;
            continue;
        }
        const type = typeof message.type === 'string' ? message.type : '(untyped)';
        record.types[type] = (record.types[type] ?? 0) + 1;

        if (type === 'assistantMessage' && typeof message.message === 'string') {
            parts.push(message.message);
            afterLastTool = `${afterLastTool}${message.message}`;
            continue;
        }
        if (type === 'toolCall' && typeof message.name === 'string') {
            const args = (typeof message.args === 'object' && message.args ? message.args : {}) as Record<string, unknown>;
            record.toolCalls.push({ name: message.name, args });
            if (message.name === 'exit' && typeof args.success === 'boolean') record.exitSuccess = args.success;
            // Everything the agent says *before* the next tool call is preamble; `final` is what it says once it
            // has stopped touching the project. The `exit` call does not count as work: pool sends it *after*
            // the closing paragraph, so treating it as a tool call threw the summary away (found by the suite).
            if (message.name !== 'exit') afterLastTool = '';
        }
    }
    record.answer = parts.join('\n').trim();
    record.final = afterLastTool.trim();
    return record;
}

/** The argument keys that name something the developer would recognise, in the order worth trying. */
const TOOL_DETAIL_KEYS = [
    'path',
    'file',
    'file_path',
    'filepath',
    'command',
    'cmd',
    'pattern',
    'query',
    'url',
    'name'
] as const;

/**
 * One tool call as a line of progress.
 *
 * Deliberately generic: this does not know pool's tool vocabulary, and inventing meanings for names it has never
 * seen would be worse than showing the name it sent plus the first argument that looks like a filename or a
 * command. Unknown tools therefore read as themselves rather than as "unknown tool".
 */
export function poolToolLine(call: PoolToolCall): string {
    for (const key of TOOL_DETAIL_KEYS) {
        const value = call.args[key];
        if (typeof value === 'string' && value.trim()) return `${call.name}: ${value.trim()}`;
    }
    return call.name;
}

/** The Run ID out of a trajectory file name, or undefined for anything that is not one. */
export function runIdFromTrajectory(fileName: string): string | undefined {
    const uuid = /^trajectory-.*_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.ndjson$/i.exec(
        path.basename(String(fileName ?? ''))
    );
    return uuid?.[1];
}

/** The trajectory directory out of `pool config`'s output — the file itself is the fallback. */
export function trajectoryDirFromConfig(text: string): string | undefined {
    const m = /^\s*trajectory directory:\s*(.+?)\s*$/m.exec(String(text ?? ''));
    return m?.[1];
}

/** What a run ended up meaning. Three outcomes, because pool distinguishes them and so must the report. */
export interface PoolOutcome {
    /** True when the task is done: exit 0, or a clean `exit` tool call when the code is unhelpful. */
    ok: boolean;
    kind: 'done' | 'task-failed' | 'error' | 'missing' | 'timeout' | 'cancelled';
    /** One sentence for the user. */
    message: string;
}

/**
 * Turns an exit code and the run's own record into an outcome.
 *
 * Exit 0 is the task succeeding and 4 is the agent saying it could not — that difference is worth keeping, since
 * "the agent could not do this" and "the hand-off is broken" need different reactions from the developer. A
 * missing binary and a timeout get their own kinds for the same reason.
 */
export function describePoolRun(input: {
    code: number;
    timedOut?: boolean;
    cancelled?: boolean;
    missing?: boolean;
    record: PoolRecord;
    stderr?: string;
    seconds?: number;
}): PoolOutcome {
    if (input.missing) {
        return {
            ok: false,
            kind: 'missing',
            message: 'The `pool` command was not found — install the Poolside CLI, or point the hand-off at it.'
        };
    }
    if (input.cancelled) {
        return {
            ok: false,
            kind: 'cancelled',
            message: 'You stopped the run. Whatever it had already changed is still on disk.'
        };
    }
    if (input.timedOut) {
        return {
            ok: false,
            kind: 'timeout',
            message:
                `The agent was still working after ${input.seconds ?? '?'} s and was stopped. Its changes up to ` +
                `then are on disk; continue the conversation to let it carry on.`
        };
    }
    const tail = String(input.stderr ?? '').trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300);
    if (input.code === 0) {
        return { ok: true, kind: 'done', message: 'The agent reported the task complete.' };
    }
    if (input.code === POOL_TASK_FAILED) {
        return {
            ok: false,
            kind: 'task-failed',
            message: `The agent ran and reported that it could not complete the task.${tail ? ` Its own words: ${tail}` : ''}`
        };
    }
    return {
        ok: false,
        kind: 'error',
        message: `pool exited with code ${input.code}${tail ? `: ${tail}` : '.'}`
    };
}

/** The facts a hand-off may carry, asked for in the developer's terms rather than the model's. */
export interface HandoffInput {
    /** What the developer asked for, verbatim. */
    request: string;
    /** Why it did not go to the local model — the scope verdict's own message, when there is one. */
    refused?: string;
    /** The same context block the local prompt would have carried (target, crates, rules, board). */
    facts?: string;
    /** The file the request is about, when there is one. */
    target?: { path: string; text: string };
    /** True when this continues an earlier run, so the request must not be scripted again. */
    resuming?: boolean;
}

/**
 * The scripted prompt a hand-off sends.
 *
 * It is written for an *agent* rather than a model: the agent has the project on disk and can run commands, so
 * the script gives it the request, why it is here, the facts it cannot look up cheaply, and — the part that
 * makes the hand-off worth doing — an instruction to **verify** the change rather than assert it. The one thing
 * it must never do is hand over a whole file with a note to "keep the rest unchanged"; that habit is what
 * destroyed a file in the first place, and an agent that understands the request never needs to be told it.
 */
export function handoffPrompt(input: HandoffInput): string {
    const request = String(input.request ?? '').trim();
    if (input.resuming) {
        return [
            'Continuing the change in progress in this project.',
            '',
            'WHAT IS ASKED FOR NOW',
            request,
            '',
            'Carry on from where you stopped, and verify the work in the same way (build it and fix what the',
            'compiler reports) before you report back.'
        ].join('\n');
    }
    const lines: string[] = [
        'You are taking over a change in this project from a smaller local model that could not complete it.',
        'Work directly in this project and make the change; do not ask questions, and do not wait for approval.',
        '',
        'WHAT IS ASKED FOR',
        request,
        ''
    ];
    if (input.refused) {
        lines.push(
            'WHY IT COMES TO YOU',
            input.refused,
            '',
            '(This is context, not an excuse: the request itself stands as written above.)',
            ''
        );
    }
    lines.push(
        'THE PROJECT',
        'It is an embedded Rust project (Raspberry Pi Pico / ESP32 class hardware, often `no_std`, built on the',
        'Embassy async framework). Follow the conventions it already uses.',
        ''
    );
    if (input.facts) lines.push(input.facts.trim(), '');
    if (input.target) {
        lines.push(
            `THE FILE IN FOCUS — ${input.target.path}`,
            '```rust',
            input.target.text.trim(),
            '```',
            ''
        );
    }
    lines.push(
        'WHAT TO DO',
        '1. Make the change described above, changing only what the request needs and leaving the rest of the',
        '   project alone.',
        '2. Build it (`cargo build` for RP2040/RP2350; an ESP32 project needs `source ~/export-esp.sh` first)',
        '   and fix what the compiler reports. Do not report success on a build that fails.',
        '3. Finish with one short paragraph: what you changed, and what you ran to check it.'
    );
    return lines.join('\n');
}

/** A run's raw result, before it is interpreted. */
export interface PoolRun {
    code: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    missing: boolean;
    ms: number;
    record: PoolRecord;
    outcome: PoolOutcome;
}

/** The `--version` of a pool build, e.g. `1.0.16`, or undefined when it cannot be asked. */
export function parsePoolVersion(text: string): string | undefined {
    return /(\d+\.\d+(?:\.\d+)?)/.exec(String(text ?? ''))?.[1];
}

/** Runs `pool --version`. Never throws: a pool that cannot answer is reported as no version. */
export async function poolVersion(command: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        child_process.execFile(command, ['--version'], { timeout: 10000 }, (err, stdout, stderr) => {
            if (err && isMissingExecutable(err)) return resolve(undefined);
            resolve(parsePoolVersion(`${stdout ?? ''}${stderr ?? ''}`));
        });
    });
}

/**
 * The trajectory folder, asked of pool once per session and remembered.
 *
 * `pool config` is the authority (it prints the directory), and the documented default is the fallback — a
 * version that changes its mind about the path must not silently cost the run-ID lookup.
 */
let cachedTrajectoryDir: string | undefined;
export async function trajectoryDir(command: string, home = os.homedir()): Promise<string> {
    if (cachedTrajectoryDir) return cachedTrajectoryDir;
    const printed = await new Promise<string>((resolve) => {
        child_process.execFile(command, ['config'], { timeout: 10000 }, (err, stdout) => resolve(err ? '' : String(stdout ?? '')));
    });
    cachedTrajectoryDir = trajectoryDirFromConfig(printed) ?? defaultTrajectoryDir(home);
    return cachedTrajectoryDir;
}

/** Forget the remembered trajectory folder. For the suite, and for a user who moved their state dir. */
export function forgetTrajectoryDir(): void {
    cachedTrajectoryDir = undefined;
}

/**
 * The Run ID of the trajectory written since `afterMs`.
 *
 * The run ID is not in the NDJSON, so it is found the only way pool offers: the newest trajectory file whose
 * mtime is not older than the run's own start. The tolerance is a second, because a file created in the same
 * moment as the run can carry an mtime a fraction earlier than the timestamp taken before the spawn.
 *
 * Two files can share a millisecond (a test writes them back to back; a fast machine can too), so the tie is
 * broken by the id itself — pool's run ids are UUIDv7, which are time-ordered by construction, so the greater
 * string is the later run. Without that, the read order of the directory decides, which is how this picked a
 * file written *before* the run it was reported for.
 */
export function newestRunId(dir: string, afterMs: number, toleranceMs = 2000): string | undefined {
    let entries: string[];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return undefined;
    }
    let best: { id: string; mtime: number } | undefined;
    for (const entry of entries) {
        const id = runIdFromTrajectory(entry);
        if (!id) continue;
        let stat: fs.Stats;
        try {
            stat = fs.statSync(path.join(dir, entry));
        } catch {
            continue;
        }
        if (stat.mtimeMs + toleranceMs < afterMs) continue;
        const later = !best || stat.mtimeMs > best.mtime || (stat.mtimeMs === best.mtime && id > best.id);
        if (later) best = { id, mtime: stat.mtimeMs };
    }
    return best?.id;
}

/** Everything `runPool` needs beyond the arguments. */
export interface RunPoolOptions extends PoolRunOptions {
    /** The binary: the setting's value, defaulting to `pool` on the PATH. */
    command: string;
    /** Stop the run after this many seconds. */
    timeoutMs: number;
    /** Cancels the run when it is aborted — the progress notification's own Cancel button. */
    signal?: AbortSignal;
    /** Called as the agent's tool calls arrive, so a long run is visibly working. */
    onProgress?: Progress;
    /** Extra environment for the child, when the caller has any. */
    env?: NodeJS.ProcessEnv;
}

/**
 * Spawn `pool exec` and read its NDJSON as it arrives.
 *
 * `spawn` rather than `execFile` because the prompt goes in on **stdin**, and `-p -` is what makes that legal.
 * Nothing is inherited: the run is captured so its answer can be shown, its tool calls can be reported, and a
 * cancel can kill it — a hand-off that cannot be stopped is not something an editor should start.
 *
 * Progress is reported per *line* rather than per byte, since a partial NDJSON line parses to nothing useful.
 */
export function runPool(opts: RunPoolOptions): Promise<PoolRun> {
    return new Promise((resolve) => {
        const startedAt = Date.now();
        let stdout = '';
        let stderr = '';
        let pending = '';
        let timedOut = false;
        let overLimit = false;
        let cancelled = false;
        let settled = false;
        // Declared before `finish` reads them: a spawn that fails *synchronously* (a working directory that is
        // not there, a file that is not executable) finishes before the timers below exist, and clearing a
        // `const` still in its dead zone would throw out of the promise instead of reporting the failure.
        let timer: ReturnType<typeof setTimeout> | undefined;
        let hardKill: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        const record = () => parsePoolNdjson(stdout);
        const finish = (code: number, missing = false) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (hardKill) clearTimeout(hardKill);
            if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
            const parsed = record();
            const outcome = describePoolRun({
                code,
                timedOut,
                cancelled,
                missing,
                record: parsed,
                stderr,
                seconds: Math.round(opts.timeoutMs / 1000)
            });
            log(
                `pool: exec finished in ${Date.now() - startedAt} ms — code=${missing ? 'missing' : code}` +
                `${timedOut ? ' (stopped at the timeout)' : ''}${cancelled ? ' (stopped by the user)' : ''}, ` +
                `${parsed.toolCalls.length} tool call(s), ` +
                `${Object.entries(parsed.types).map(([t, n]) => `${t}×${n}`).join(' ') || 'no output'}`
            );
            resolve({
                code,
                stdout,
                stderr,
                timedOut,
                missing,
                ms: Date.now() - startedAt,
                record: parsed,
                outcome
            });
        };

        const args = poolArgs(opts);
        log(`pool: ${opts.command} ${args.slice(0, -2).join(' ')} -p - (${opts.prompt.length} bytes on stdin)`);
        let child: child_process.ChildProcessWithoutNullStreams;
        try {
            // `detached` puts the run in its own process *group*, and that is what makes it stoppable: `pool` is a
            // wrapper, so the process this handle names is not the only one holding the pipes — a `sleep` or a
            // compiler it started inherits them, and killing the wrapper alone leaves the promise waiting for the
            // grandchild. Measured on 2026-10-12: a 1.5 s timeout took 30 s, because the SIGTERM killed `pool`
            // while the `sleep` underneath it kept the stdout pipe open.
            child = child_process.spawn(opts.command, args, {
                cwd: opts.directory,
                env: { ...process.env, ...opts.env },
                stdio: ['pipe', 'pipe', 'pipe'],
                detached: true
            });
        } catch (error) {
            log(`pool: could not start ${opts.command} — ${error instanceof Error ? error.message : String(error)}`);
            return finish(1, isMissingExecutable(error));
        }

        /** Stop the whole group, falling back to the wrapper alone when the group is already gone. */
        const stop = (signal: NodeJS.Signals) => {
            const pid = child.pid;
            if (pid === undefined) return;
            try {
                process.kill(-pid, signal);
            } catch {
                try {
                    child.kill(signal);
                } catch {
                    /* already dead, which is what we wanted */
                }
            }
        };

        timer = setTimeout(() => {
            timedOut = true;
            log(`pool: stopping the run after ${Math.round(opts.timeoutMs / 1000)} s`);
            stop('SIGTERM');
        }, Math.max(1000, opts.timeoutMs));
        // A SIGTERM it ignores must not leave a wedged process behind.
        hardKill = setTimeout(() => stop('SIGKILL'), Math.max(2000, opts.timeoutMs) + 5000);

        // The Cancel button on the progress notification. Registered after `stop`, which it needs, and after
        // the spawn — but an already-aborted signal is honoured immediately rather than ignored.
        onAbort = () => {
            cancelled = true;
            log('pool: the run was stopped from the editor');
            stop('SIGTERM');
        };
        if (opts.signal) {
            if (opts.signal.aborted) onAbort();
            else opts.signal.addEventListener('abort', onAbort);
        }

        child.on('error', (error) => {
            if (isMissingExecutable(error)) return finish(1, true);
            stderr += `\n${error.message}`;
            finish(1);
        });
        // A run that was stopped finishes on `exit`, not on `close`: `close` waits for every inherited handle to
        // be released, and a grandchild that outlived the kill can hold one. A run that ended by itself still
        // waits for `close`, because the last of its output is worth having.
        child.on('exit', (code) => {
            if (!timedOut && !overLimit && !cancelled) return;
            setTimeout(() => finish(code ?? 1), 250);
        });
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
            if (stdout.length > POOL_MAX_OUTPUT_BYTES) {
                overLimit = true;
                log('pool: the run produced more output than the hand-off allows — stopping it');
                stop('SIGTERM');
            }
            if (!opts.onProgress) return;
            pending += chunk.toString();
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim().startsWith('{')) continue;
                const parsed = parsePoolNdjson(line);
                for (const call of parsed.toolCalls) {
                    if (call.name !== 'exit') opts.onProgress(poolToolLine(call));
                }
            }
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
            if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
        });
        child.on('close', (code) => finish(overLimit && !timedOut ? 1 : code ?? 1));

        // The prompt: written, then closed, because `pool` reads it to EOF.
        child.stdin.on('error', () => {
            /* the child may exit before the prompt is fully written; its exit code is the real signal */
        });
        child.stdin.end(opts.prompt, 'utf8');
    });
}

// ---------------- the hand-off settings (asked 2026-10-12) ----------------
//
// These live here, and not with the rest of the flow in `ai/handoff.ts`, for one reason: `handoff.ts` talks to
// `vscode` (dialogs, workspace state) and therefore cannot be loaded by the suite, while the *meaning* of a
// setting is exactly the kind of thing the suite should pin. Normalising a raw settings blob is pure arithmetic
// on unknown values, so it belongs beside the client whose arguments it decides.

/** Where a request may be handed off to. `off` means the scope gate's warning is the end of it. */
export type HandoffTarget = 'off' | 'pool';

/** The hand-off settings, after normalisation. */
export interface HandoffConfig {
    target: HandoffTarget;
    /** The `pool` executable. */
    command: string;
    /** The agent to ask for (`-a`); empty means pool's default. */
    agent: string;
    /**
     * `--unsafe-auto-allow`: the agent uses its tools without asking.
     *
     * On by default and disclosed in the consent dialog, because a non-interactive `pool exec` cannot answer an
     * approval prompt at all — with this off, a hand-off that needs to edit a file simply stops.
     */
    autoAllow: boolean;
    timeoutSeconds: number;
    /** Continue the last conversation rather than starting a fresh one. */
    resume: boolean;
}

/** Raw settings, every field possibly missing or wrong-typed. */
export interface RawHandoffSettings {
    handoff?: unknown;
    poolCommand?: unknown;
    poolAgent?: unknown;
    poolAutoAllow?: unknown;
    poolTimeoutSeconds?: unknown;
    poolResume?: unknown;
}

function clampSetting(value: unknown, fallback: number, min: number, max: number): number {
    const n = typeof value === 'string' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/**
 * Pure: the manifest, the panel and the suite all go through here, so "what does this setting mean" has one
 * answer.
 *
 * The asymmetries are deliberate and are the whole reason this is worth testing. `handoff` defaults to `pool`
 * because the feature is useless switched off, and only an explicit `"off"` turns it off — junk must never look
 * like consent, but it must also not silently disable what the user asked for. `autoAllow` and `resume` are the
 * other way round: only an explicit `false` turns them off, because a missing setting must not quietly turn a
 * working hand-off into one that stops at the first approval, or forget a conversation it was continuing.
 */
export function normalizeHandoff(raw: RawHandoffSettings): HandoffConfig {
    const target: HandoffTarget = raw.handoff === 'off' ? 'off' : 'pool';
    return {
        target,
        command: typeof raw.poolCommand === 'string' && raw.poolCommand.trim() ? raw.poolCommand.trim() : 'pool',
        agent: typeof raw.poolAgent === 'string' ? raw.poolAgent.trim() : '',
        autoAllow: raw.poolAutoAllow !== false,
        timeoutSeconds: clampSetting(raw.poolTimeoutSeconds, 900, 30, 7200),
        resume: raw.poolResume !== false
    };
}
