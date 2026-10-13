/* The J-Code driver — a second agent that can work *in* the project.
 *
 * WHY A DRIVER, AND NOT AN ENDPOINT (asked 2026-10-13: *"the Agnes model has a dedicated CLI agent called Agnes
 * Code CLI … Why don't we implement this agent in a similar fashion than the Pool agent was implemented?"*).
 * The cloud hand-off can only *answer* — it has no files, so its result is text to review. `jcode` works in the
 * project: it reads, writes and runs commands. So the hand-off can be a real one, with the machinery `pool`
 * already has — consent, a report of what it did, a conversation turn whose code can be reviewed as a diff, and
 * `--resume` so a second hand-off continues the first.
 *
 * THE CONTRACT IS MEASURED, NOT GUESSED. Recorded 2026-10-13 against jcode **v0.75.0** (`~/.local/bin/jcode` →
 * `~/.jcode/builds/stable/jcode`) by running one prompt in a scratch directory and keeping its output as
 * `tests/layers/t2-cli/fixtures/jcode-run.ndjson`:
 *
 *     jcode run -p openai-compatible -m agnes-2.5-flash --quiet --no-update --ndjson -C <dir> "<message>"
 *
 *   - the message is **argv**, the one positional argument (`jcode run [OPTIONS] <MESSAGE>`) — the opposite of
 *     pool's `-p -`, where the prompt goes in on stdin;
 *   - stdout is one JSON object per line: `start` (model / provider / **session_id**), `connection_phase`
 *     (progress), `text_delta` (the answer streaming), `tool_start` / `tool_input` / `tool_exec` / `tool_done`,
 *     `tokens`, `message_end` (`stop_reason`) and a closing `done` that carries the whole answer in `text`, the
 *     usage, and the session id again;
 *   - **a `tool_input` carries no id**: its `delta` belongs to the most recent `tool_start`, and a large argument
 *     arrives in several deltas — so they have to be concatenated, in order, onto the call that opened it;
 *   - **tools run with no approval prompt**: a `write` call created a file without asking anything. That is why
 *     the consent dialog says so in as many words — the same disclosure pool's auto-allow needs, and here there
 *     is no setting to hold it back;
 *   - exit **0** means the run finished; no daemon is needed (`serve` exists, but `run` worked standalone);
 *   - the run is saved as `~/.jcode/sessions/session_<animal>_<ms>_<hex>.json`, whose `id` is the `--resume` id
 *     and whose `working_dir` says which project it belongs to — which is how "the last run in *this* project"
 *     can be found without guessing.
 *
 * PURE AND EFFECTFUL, split the way the rest of `ai/` splits it: the arguments, the NDJSON record, a tool line,
 * the outcome and the session-file naming are pure and asserted by the suite; only the spawn and the directory
 * scan touch the world.
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
 * `ai/log.ts` reaches for `vscode`, and this module is asserted in the t2 layer against a fake `jcode`
 * executable — a real child process, no editor running. A top-level `import { log } from './log'` would make the
 * module unloadable there (exactly how `pool.ts` failed on 2026-10-12), and the dependency is only ever a log
 * line, so it is paid for when one is written.
 */
function log(message: string): void {
    try {
        (require('./log') as { log: (text: string) => void }).log(message);
    } catch {
        /* no editor to log into: the message is diagnostics, and losing it costs nothing */
    }
}

/** Refuse a run that produces more than this much output: an agent in a loop must not eat the editor's memory. */
export const JCODE_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** Where jcode keeps one saved session per conversation. */
export function defaultSessionDir(home = os.homedir()): string {
    return path.join(home, '.jcode', 'sessions');
}

/** What a hand-off asks `jcode run` to do. */
export interface JcodeRunOptions {
    /** The scripted prompt — the message, which this CLI takes as an argument. */
    prompt: string;
    /** The project the agent works in (`-C`). */
    directory: string;
    /** Resume this conversation (`--resume`), when a previous hand-off left a session id. */
    continueId?: string;
    /** `-p`: the provider. `openai-compatible` is how this machine's Agnes endpoint is reached. */
    provider?: string;
    /** `-m`: the model id. Empty lets jcode's own configuration decide. */
    model?: string;
}

/**
 * The argument list for one hand-off — pure, so the shape can be asserted without running an agent.
 *
 * The order is the order the probe used, and the prompt comes **last**: it is the one positional argument, so a
 * message that begins with a dash can never be read as a flag.
 *
 * `--quiet` and `--no-update` are not decoration. Quiet is what keeps stdout pure NDJSON ("suppress non-error
 * CLI/status output for scripting and wrappers"), and a hand-off that auto-updated the CLI underneath itself
 * mid-run would be a spectacular way to lose a run.
 */
export function jcodeArgs(opts: JcodeRunOptions): string[] {
    const args = ['run', '--quiet', '--no-update', '--ndjson', '-C', opts.directory];
    if (opts.provider) args.push('-p', opts.provider);
    if (opts.model) args.push('-m', opts.model);
    if (opts.continueId) args.push('--resume', opts.continueId);
    args.push(opts.prompt);
    return args;
}

/** One tool call the agent made, as the agent reported it. */
export interface JcodeToolCall {
    id: string;
    name: string;
    /** The raw argument JSON, reassembled from however many `tool_input` deltas it arrived in. */
    input: string;
    /** What the tool said it did, from `tool_done` — `Created …/probe.txt (1 lines)`. */
    output?: string;
    /** The tool's own error, when it failed. */
    error?: string;
}

/** What a run's NDJSON adds up to. */
export interface JcodeRecord {
    /** The closing `done` text — the answer this run stands behind. */
    answer: string;
    /** Every `text_delta` joined, for when a run died before sending `done`. */
    narration: string;
    toolCalls: JcodeToolCall[];
    /** The session id: what `--resume` takes, so the next hand-off continues this conversation. */
    runId?: string;
    model?: string;
    /** What the CLI called the route it used, reported verbatim rather than translated. */
    provider?: string;
    /** The last `stop_reason`. `stop` is a finished answer; `tool_calls` means it stopped mid-work. */
    stopReason?: string;
    /** The CLI's own note about the run, when it sent one. */
    statusDetail?: string;
    /** Tokens in the **last** request, which is the one carrying the whole conversation. */
    promptTokens: number;
    /** Tokens generated across the whole run — every round of tool use generates some. */
    completionTokens: number;
    /** Which message types appeared and how often, so a shape this parser does not know is visible. */
    types: Record<string, number>;
}

/** Reads a number out of a shape that may use either the event's or the closing usage's field names. */
function tokenCount(source: Record<string, unknown> | undefined, ...names: string[]): number | undefined {
    for (const name of names) {
        const value = source?.[name];
        if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return undefined;
}

/**
 * Reads a run's NDJSON.
 *
 * A line that is not JSON is skipped rather than fatal — losing a whole run's answer to one unexpected line
 * would be a poor trade — and unknown *types* are counted in `types`, so the suite (and a bug report) can see a
 * message that mattered instead of this parser quietly ignoring it.
 */
export function parseJcodeNdjson(text: string): JcodeRecord {
    const record: JcodeRecord = {
        answer: '',
        narration: '',
        toolCalls: [],
        promptTokens: 0,
        completionTokens: 0,
        types: {}
    };
    // The call a `tool_input` delta belongs to: those events carry no id (measured), so the most recent
    // `tool_start` owns whatever deltas follow it.
    let open: JcodeToolCall | undefined;
    const byId = new Map<string, JcodeToolCall>();

    for (const raw of String(text ?? '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        let message: Record<string, unknown>;
        try {
            const parsed = JSON.parse(line) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                record.types['(not an object)'] = (record.types['(not an object)'] ?? 0) + 1;
                continue;
            }
            message = parsed as Record<string, unknown>;
        } catch {
            record.types['(unparsed)'] = (record.types['(unparsed)'] ?? 0) + 1;
            continue;
        }
        const type = typeof message.type === 'string' ? message.type : '(untyped)';
        record.types[type] = (record.types[type] ?? 0) + 1;

        switch (type) {
            case 'start': {
                if (typeof message.model === 'string') record.model = message.model;
                if (typeof message.provider === 'string') record.provider = message.provider;
                if (typeof message.session_id === 'string') record.runId = message.session_id;
                break;
            }
            case 'text_delta': {
                if (typeof message.text === 'string') record.narration += message.text;
                break;
            }
            case 'tool_start': {
                const call: JcodeToolCall = {
                    id: typeof message.id === 'string' ? message.id : '',
                    name: typeof message.name === 'string' ? message.name : '(unnamed tool)',
                    input: ''
                };
                record.toolCalls.push(call);
                if (call.id) byId.set(call.id, call);
                open = call;
                break;
            }
            case 'tool_input': {
                // A hard limit on one tool's arguments: a runaway agent streaming into a single call must not
                // grow an unbounded string in the editor's memory.
                if (open && typeof message.delta === 'string' && open.input.length < 256 * 1024) {
                    open.input += message.delta;
                }
                break;
            }
            case 'tool_done': {
                const id = typeof message.id === 'string' ? message.id : '';
                const call = (id ? byId.get(id) : undefined) ?? open;
                if (call) {
                    if (typeof message.output === 'string') call.output = message.output;
                    if (typeof message.error === 'string' && message.error.trim()) call.error = message.error;
                }
                break;
            }
            case 'message_end': {
                if (typeof message.stop_reason === 'string') record.stopReason = message.stop_reason;
                break;
            }
            case 'tokens': {
                // Per request, and a run makes one request per round of tool use. What was *sent* is therefore
                // the biggest prompt (the last request carries the whole conversation), while what was
                // *generated* is the sum — saying otherwise would report a multi-round run as a small one.
                const input = tokenCount(message, 'input', 'input_tokens', 'prompt_tokens');
                if (input !== undefined) record.promptTokens = Math.max(record.promptTokens, input);
                const output = tokenCount(message, 'output', 'output_tokens', 'completion_tokens');
                if (output !== undefined) record.completionTokens += output;
                break;
            }
            case 'done': {
                if (typeof message.text === 'string' && message.text.trim()) record.answer = message.text.trim();
                if (typeof message.session_id === 'string') record.runId = message.session_id;
                if (typeof message.model === 'string') record.model = message.model;
                if (typeof message.provider === 'string') record.provider = message.provider;
                if (typeof message.status_detail === 'string' && message.status_detail.trim()) {
                    record.statusDetail = message.status_detail;
                }
                const usage = (typeof message.usage === 'object' && message.usage ? message.usage : undefined) as
                    | Record<string, unknown>
                    | undefined;
                const input = tokenCount(usage, 'input_tokens', 'input', 'prompt_tokens');
                if (input !== undefined) record.promptTokens = Math.max(record.promptTokens, input);
                // Only when no `tokens` event was seen: the closing usage covers the last request alone, and
                // adding it to a sum that already holds every round would count one round twice.
                const output = tokenCount(usage, 'output_tokens', 'output', 'completion_tokens');
                if (output !== undefined && record.completionTokens === 0) record.completionTokens = output;
                break;
            }
            default:
                break;
        }
    }

    if (!record.answer) record.answer = record.narration.trim();
    return record;
}

/** The argument keys that name something a developer would recognise, in the order worth trying. */
const TOOL_DETAIL_KEYS = ['file_path', 'filepath', 'path', 'file', 'command', 'cmd', 'pattern', 'query', 'url'] as const;

/** The first recognised argument in a tool call's raw input, or an empty string. */
function toolDetail(input: string): string {
    if (!input.trim()) return '';
    try {
        const args = JSON.parse(input) as Record<string, unknown>;
        for (const key of TOOL_DETAIL_KEYS) {
            const value = args?.[key];
            if (typeof value === 'string' && value.trim()) return value.trim();
        }
    } catch {
        /* half-written or streaming arguments: the tool's own name is still worth showing */
    }
    return '';
}

/**
 * One tool call as a line of progress, and as a line of the report's "what it did".
 *
 * Deliberately generic, like pool's: this does not know jcode's tool vocabulary, and inventing meanings for
 * names it has never seen would be worse than showing the name it sent plus the argument that looks like a
 * filename — or the tool's own words about what it changed, which is the best line of the three.
 */
export function jcodeToolLine(call: JcodeToolCall): string {
    const target = toolDetail(call.input);
    const head = `${call.name}${target ? `: ${target}` : ''}`;
    if (call.error) return `${head} — failed: ${call.error.replace(/\s+/g, ' ').slice(0, 200)}`;
    const said = String(call.output ?? '').split(/\r?\n/).find((line) => line.trim());
    return said ? `${head} — ${said.trim().slice(0, 200)}` : head;
}

/** What a run ended up meaning. */
export interface JcodeOutcome {
    ok: boolean;
    kind: 'done' | 'error' | 'missing' | 'timeout' | 'cancelled';
    /** One sentence for the user. */
    message: string;
}

/**
 * Turns an exit code and the run's own record into an outcome.
 *
 * Exit 0 is the run finishing; there is no measured second code to read the way pool's `4` means "I could not do
 * it", so nothing is invented here — but what the record itself says (a failed tool call, a last message that
 * was a tool call rather than a conclusion) is reported, because "it finished" and "it finished the job" are not
 * the same claim and only the compiler can settle the difference.
 */
export function describeJcodeRun(input: {
    code: number;
    timedOut?: boolean;
    cancelled?: boolean;
    missing?: boolean;
    record: JcodeRecord;
    stderr?: string;
    seconds?: number;
}): JcodeOutcome {
    if (input.missing) {
        return {
            ok: false,
            kind: 'missing',
            message:
                'The `jcode` command was not found — install the Agnes Code CLI, or set its command to its full path.'
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
                'then are on disk; continue the conversation to let it carry on.'
        };
    }
    const tail = String(input.stderr ?? '').trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300);
    if (input.code !== 0) {
        return {
            ok: false,
            kind: 'error',
            message: `jcode exited with code ${input.code}${tail ? `: ${tail}` : '.'}`
        };
    }
    // Exit 0, so the run finished. The caveats below are the record's own, and each one changes what the
    // developer should do next.
    const failed = input.record.toolCalls.filter((call) => call.error);
    const notes: string[] = [];
    if (input.record.statusDetail) notes.push(input.record.statusDetail);
    if (failed.length) {
        notes.push(`${failed.length} of its ${input.record.toolCalls.length} tool call(s) failed`);
    }
    if (input.record.stopReason && input.record.stopReason !== 'stop') {
        notes.push(`it stopped on \`${input.record.stopReason}\``);
    }
    return {
        ok: true,
        kind: 'done',
        message: notes.length
            ? `The agent finished — ${notes.join('; ')}.`
            : 'The agent reported the task complete.'
    };
}

/** A run's raw result, before it is interpreted. */
export interface JcodeRun {
    code: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    missing: boolean;
    ms: number;
    record: JcodeRecord;
    outcome: JcodeOutcome;
}

export interface RunJcodeOptions extends JcodeRunOptions {
    /** The binary: the setting's value, defaulting to `jcode` on the PATH. */
    command: string;
    /** Stop the run after this many seconds. */
    timeoutMs: number;
    /** Cancels the run when it is aborted — the progress notification's own Cancel button. */
    signal?: AbortSignal;
    /** Called as the run narrates itself, so a long hand-off is visibly working. */
    onProgress?: Progress;
    /** Extra environment for the child, when the caller has any. */
    env?: NodeJS.ProcessEnv;
}

/**
 * Spawn `jcode run` and read its NDJSON as it arrives.
 *
 * The prompt is an **argument** here, not stdin — that is what the CLI's own usage says, and passing it any
 * other way would be this driver inventing a contract. Nothing is inherited: the run is captured so its answer
 * can be shown, its tool calls can be reported, and a cancel can kill it.
 *
 * Progress is reported per *line* rather than per byte, since a partial NDJSON line parses to nothing useful.
 */
export function runJcode(opts: RunJcodeOptions): Promise<JcodeRun> {
    return new Promise((resolve) => {
        const startedAt = Date.now();
        let stdout = '';
        let stderr = '';
        let pending = '';
        let timedOut = false;
        let overLimit = false;
        let cancelled = false;
        let settled = false;
        // Declared before `finish` reads them: a spawn that fails *synchronously* finishes before the timers
        // below exist, and clearing a `const` still in its dead zone would throw out of the promise.
        let timer: ReturnType<typeof setTimeout> | undefined;
        let hardKill: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        const finish = (code: number, missing = false) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (hardKill) clearTimeout(hardKill);
            if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
            const parsed = parseJcodeNdjson(stdout);
            const outcome = describeJcodeRun({
                code,
                timedOut,
                cancelled,
                missing,
                record: parsed,
                stderr,
                seconds: Math.round(opts.timeoutMs / 1000)
            });
            log(
                `jcode: run finished in ${Date.now() - startedAt} ms — code=${missing ? 'missing' : code}` +
                `${timedOut ? ' (stopped at the timeout)' : ''}${cancelled ? ' (stopped by the user)' : ''}, ` +
                `${parsed.toolCalls.length} tool call(s), session=${parsed.runId ?? 'none'}, ` +
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

        const args = jcodeArgs(opts);
        log(
            `jcode: ${opts.command} run --quiet --no-update --ndjson -C ${opts.directory}` +
            `${opts.provider ? ` -p ${opts.provider}` : ''}${opts.model ? ` -m ${opts.model}` : ''}` +
            `${opts.continueId ? ` --resume ${opts.continueId}` : ''} (${opts.prompt.length} bytes as the message)`
        );
        // stdin is `ignore` rather than a pipe: this CLI takes its message as an argument and never reads stdin,
        // so there is nothing to write and nothing it could wait for. The type says so (`ChildProcessByStdio`),
        // because a `ChildProcessWithoutNullStreams` would promise a stdin that does not exist.
        let child: child_process.ChildProcessByStdio<null, import('stream').Readable, import('stream').Readable>;
        try {
            // `detached` puts the run in its own process *group*, and that is what makes it stoppable: the
            // binary this handle names is a launcher, and a compiler or a `cargo` it started inherits the
            // pipes — killing the wrapper alone leaves the promise waiting for the grandchild (measured on the
            // pool side on 2026-10-12: a 1.5 s timeout took 30 s).
            child = child_process.spawn(opts.command, args, {
                cwd: opts.directory,
                env: { ...process.env, ...opts.env },
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: true
            });
        } catch (error) {
            log(`jcode: could not start ${opts.command} — ${error instanceof Error ? error.message : String(error)}`);
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
            log(`jcode: stopping the run after ${Math.round(opts.timeoutMs / 1000)} s`);
            stop('SIGTERM');
        }, Math.max(1000, opts.timeoutMs));
        // A SIGTERM it ignores must not leave a wedged process behind.
        hardKill = setTimeout(() => stop('SIGKILL'), Math.max(2000, opts.timeoutMs) + 5000);

        onAbort = () => {
            cancelled = true;
            log('jcode: the run was stopped from the editor');
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
            if (stdout.length > JCODE_MAX_OUTPUT_BYTES) {
                overLimit = true;
                log('jcode: the run produced more output than the hand-off allows — stopping it');
                stop('SIGTERM');
            }
            if (!opts.onProgress) return;
            pending += chunk.toString();
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() ?? '';
            for (const line of lines) {
                const text = line.trim();
                if (!text.startsWith('{')) continue;
                let message: Record<string, unknown>;
                try {
                    message = JSON.parse(text) as Record<string, unknown>;
                } catch {
                    continue;
                }
                if (message.type === 'connection_phase' && typeof message.phase === 'string') {
                    opts.onProgress(message.phase);
                } else if (message.type === 'tool_start' && typeof message.name === 'string') {
                    opts.onProgress(message.name);
                } else if (message.type === 'tool_done' && typeof message.name === 'string') {
                    opts.onProgress(`${message.name} done`);
                }
            }
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
            if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
        });
        child.on('close', (code) => finish(overLimit && !timedOut ? 1 : code ?? 1));
    });
}

/** The version out of `jcode --version`, e.g. `0.75.0` from `jcode v0.75.0 (5ae238574)`. */
export function parseJcodeVersion(text: string): string | undefined {
    return /(\d+\.\d+(?:\.\d+)?)/.exec(String(text ?? ''))?.[1];
}

/** Runs `jcode --version`. Never throws: a jcode that cannot answer is reported as no version. */
export function jcodeVersion(command: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        child_process.execFile(command, ['--version'], { timeout: 10000 }, (err, stdout, stderr) => {
            if (err && isMissingExecutable(err)) return resolve(undefined);
            resolve(parseJcodeVersion(`${stdout ?? ''}${stderr ?? ''}`));
        });
    });
}

/** The session id out of a session file name, or undefined for anything that is not one. */
export function sessionIdFromFile(fileName: string): string | undefined {
    const base = path.basename(String(fileName ?? ''));
    return /^session_[a-z0-9]+_\d+_[0-9a-f]+\.json$/i.test(base) ? base.slice(0, -'.json'.length) : undefined;
}

/**
 * The session a previous hand-off in **this project** left behind.
 *
 * The session id from the last run is remembered by the caller, and this is the fallback for the case where the
 * extension has forgotten it (a reload, another window on the same project). The saved files record
 * `working_dir`, so the answer is "the newest session that says it was working in this directory" — not merely
 * the newest session, which would continue a conversation about some other project. (Pool's trajectory files
 * carry no such field, which is why that driver has to fall back to the newest file instead.)
 *
 * Only the newest few files are read: each one holds a whole conversation, and scanning a year of them to answer
 * this question would be a poor trade for a better answer.
 */
export function sessionIdForDirectory(directory: string, options: { home?: string; limit?: number } = {}): string | undefined {
    const dir = defaultSessionDir(options.home ?? os.homedir());
    const wanted = path.resolve(String(directory ?? ''));
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return undefined;
    }
    const candidates = names
        .filter((name) => sessionIdFromFile(name) !== undefined)
        .map((name) => {
            try {
                return { name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs };
            } catch {
                return { name, mtimeMs: 0 };
            }
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, Math.max(1, options.limit ?? 20));
    for (const candidate of candidates) {
        try {
            const saved = JSON.parse(fs.readFileSync(path.join(dir, candidate.name), 'utf8')) as {
                id?: unknown;
                working_dir?: unknown;
            };
            const found = typeof saved.working_dir === 'string' ? path.resolve(saved.working_dir) : '';
            if (found && found === wanted) {
                const id = typeof saved.id === 'string' && saved.id ? saved.id : sessionIdFromFile(candidate.name);
                if (id) return id;
            }
        } catch {
            /* an unreadable or half-written session: the next one may answer */
        }
    }
    return undefined;
}
