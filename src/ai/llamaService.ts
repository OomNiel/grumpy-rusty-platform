/* The user's **own** `llama-server` as a *service* — asked about, started and stopped from here.
 *
 * WHY THIS EXISTS (asked 2026-09-17). *"I don't know who started the llama server (could have been me!).
 * Could you add a control in the Settings panel to start and stop the llama server?"* The extension could
 * already detect that *something* was answering on port 8080, and `llamaServer.ts` could start a
 * `llama-server` of its own — but for a server it did not start it said only *"Started outside this window
 * — Stop and Unload leave it alone on purpose"*. That sentence is honest and useless: a server holding
 * 19 GB of RAM is something the user wants a button for, and "who started it?" is a question about their
 * own machine that the extension can answer instead of shrugging at.
 *
 * THE CASE THAT SHAPED EVERY DECISION HERE is this machine's: the server is a **systemd user unit**
 * (`~/.config/systemd/user/llama-server.service`, `WantedBy=default.target`), so it comes up at login and
 * had been serving a 30 B Qwen3-Coder for a day and a half when the question was asked. Nobody mysterious
 * started it; the unit is enabled. So:
 *
 *   - **"Who started it?" is read from the kernel and systemd, never guessed.** The cgroup of the process
 *     holding the port names its unit (`/user.slice/user-1000.slice/user@1000.service/app.slice/
 *     llama-server.service`) and `systemctl --user show` says since when, and whether it returns at login.
 *   - **Starting honours the user's choice and falls back.** *"Option 3, but with fallback to the free one
 *     if the chosen one fails"* — a control that only works when the guess was right is not a control, so
 *     the failed route's own words are carried into the message that reports the fallback.
 *   - **Stopping always asks first, whatever it is** (the user's decision), and the dialog says *what* it
 *     is about to stop: the unit and its uptime, or the pid and command line of a plain process. A unit is
 *     stopped with `systemctl --user stop` — a clean stop, which is what `Restart=on-failure` honours.
 *   - **A *system* unit is never acted on.** It needs root, the extension cannot escalate, and a feature
 *     that pretends otherwise would fail silently: the exact `sudo systemctl stop …` line is printed
 *     instead, for the user to run in a terminal.
 *   - **Nothing is ever killed that is not a llama-server.** A port held by something else is reported,
 *     not signaled.
 *
 * WHAT IS PURE. Every parser here — `parseListeners`, `unitFromCgroup`, `llamaUnitsFromUnitFiles`,
 * `parseSystemctlShow`, `describeOwner`, `endpointPort` — takes text and returns a value, so the decisions
 * are testable with no systemd, no `ss` and no server. What touches the machine is a handful of one-line
 * `run()` calls, and every one of them is allowed to fail by returning nothing.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { log, logError } from './log';
import { configView } from './settings';
import {
    findRunningLlamaServer,
    forgetRunningProbe,
    ownLlamaServerStatus,
    startOwnLlamaServer,
    stopOwnLlamaServer,
    useRunningLlamaServer
} from './llamaServer';

const SETTINGS = 'rustyPlatform.assistant';

/** How long a started service gets to put its weights in RAM before we report it as not answering. */
const READY_TIMEOUT_MS = 5 * 60 * 1000;

/** How long a stop gets to release the port before we say it did not. */
const STOP_TIMEOUT_MS = 20 * 1000;

// ---------------- who is holding that port? ----------------

/** One listening TCP socket, as `ss -ltnp` describes it. */
export interface Listener {
    port: number;
    pid?: number;
    /** The process name `ss` printed, e.g. `llama-server`. Absent when the socket belongs to someone else. */
    name?: string;
}

/**
 * Every listening socket in `ss -ltnp` output.
 *
 * Only `LISTEN` lines carry a process, and only *this user's* processes carry a pid at all (`ss` without
 * root prints `users:(("name",pid=N,fd=M))` for its own and nothing for anyone else's) — which is exactly
 * the right default here: a pid we cannot see is a process we would not be allowed to signal.
 */
export function parseListeners(stdout: string): Listener[] {
    const found: Listener[] = [];
    for (const line of String(stdout ?? '').split(/\r?\n/)) {
        if (!/\bLISTEN\b/.test(line)) continue;
        const address = /^\S+\s+\d+\s+\d+\s+(\S+)\s/.exec(line);
        const port = address ? Number(/(\d+)$/.exec(address[1]!)?.[1]) : NaN;
        if (!Number.isFinite(port)) continue;
        const owner = /\(\("([^"]+)",pid=(\d+)/.exec(line);
        found.push({ port, pid: owner ? Number(owner[2]) : undefined, name: owner ? owner[1] : undefined });
    }
    return found;
}

/** The port an endpoint points at (`http://127.0.0.1:8080/v1` → 8080). */
export function endpointPort(endpoint: string): number | undefined {
    const m = /:(\d+)(?:\/|$)/.exec(String(endpoint ?? '').trim());
    if (!m) return undefined;
    const port = Number(m[1]);
    return Number.isFinite(port) && port > 0 && port < 65536 ? port : undefined;
}

/**
 * The systemd unit a process belongs to, from its own cgroup — the only trustworthy answer to "who started
 * it?", because it is the kernel's record of what launched the process and not an inference from its name.
 *
 * `scope` matters: a *user* unit can be started and stopped by this extension (`systemctl --user`), a
 * *system* one cannot be touched without root.
 */
export function unitFromCgroup(text: string): { unit: string; scope: 'user' | 'system' } | undefined {
    const cgroup = String(text ?? '').trim();
    if (!cgroup) return undefined;
    // The **last** `.service` in the path, not the first: a user service's cgroup is
    // `/user.slice/user-1000.slice/user@1000.service/app.slice/llama-server.service`, and a first-match
    // regex happily answers `user@1000.service` — the *manager's* unit, which would have the panel offer to
    // stop systemd's own user manager (caught by this module's tests before it ever ran).
    const matches = [...cgroup.matchAll(/([A-Za-z0-9@._:-]+\.service)(?=\/|$)/g)];
    const unit = matches.at(-1)?.[1];
    if (!unit || unit.startsWith('user@')) return undefined;
    const scope: 'user' | 'system' = /\/user@\d+\.service/.test(cgroup) || /user-\d+\.slice/.test(cgroup)
        ? 'user'
        : 'system';
    return { unit, scope };
}

/** What `systemctl show` says about a unit, in the three facts a user actually asks about. */
export interface UnitFacts {
    since?: string;
    /** True when the unit is enabled — i.e. it comes back by itself at the next login. */
    enabled?: boolean;
    pid?: number;
}

/**
 * `systemctl show` output as facts. `ActiveEnterTimestamp` is preferred over `ExecMainStartTimestamp`
 * because it is the one that also survives a restart; `n/a` is what systemd prints for a unit that has
 * never run, and it is not a date.
 */
export function parseSystemctlShow(stdout: string): UnitFacts {
    const facts: UnitFacts = {};
    for (const raw of String(stdout ?? '').split(/\r?\n/)) {
        const m = /^([A-Za-z]+)=(.*)$/.exec(raw.trim());
        if (!m) continue;
        const value = m[2]!.trim();
        if (m[1] === 'ActiveEnterTimestamp' || m[1] === 'ExecMainStartTimestamp') {
            if (!facts.since && value && !/^n\/a$/i.test(value)) facts.since = value.replace(/\s+/g, ' ');
        }
        if (m[1] === 'UnitFileState') facts.enabled = /^enabled/.test(value);
        if (m[1] === 'MainPID') {
            const pid = Number(value);
            if (Number.isFinite(pid) && pid > 0) facts.pid = pid;
        }
    }
    return facts;
}

/**
 * The unit files that start a `llama-server`, by reading `ExecStart` — how a *stopped* service can still be
 * found. A unit is only run when nothing is answering, so "ask the running process" cannot be the only way
 * to know the unit exists; the file on disk is.
 *
 * Continuation lines are joined first: this machine's own unit writes its `ExecStart` over nine lines with
 * trailing backslashes, and a parser that only read the first line would find `-m` and no `llama-server`.
 */
export function llamaUnitsFromUnitFiles(files: { name: string; text: string }[]): string[] {
    const units: string[] = [];
    for (const file of files) {
        const joined = String(file.text ?? '').replace(/\\\s*\r?\n\s*/g, ' ');
        for (const line of joined.split(/\r?\n/)) {
            const m = /^\s*ExecStart\s*=\s*(.+)$/i.exec(line);
            if (!m) continue;
            if (/llama[-_]server/i.test(m[1]!)) {
                units.push(file.name);
                break;
            }
        }
    }
    return units;
}

/** How a running server got there. `none` means the port is free. */
export type ServerOwner =
    | { kind: 'ours'; pid?: number; model?: string }
    | { kind: 'unit'; unit: string; scope: 'user' | 'system'; pid?: number; since?: string; enabled?: boolean }
    | { kind: 'process'; pid?: number; since?: string; command?: string }
    | { kind: 'none' };

/**
 * One sentence for the panel and the status dialog — the answer to "who started it?", phrased so that it is
 * complete on its own: what it is, since when, and whether it comes back by itself.
 */
export function describeOwner(owner: ServerOwner): string {
    switch (owner.kind) {
        case 'ours':
            return `started by this window${owner.pid ? ` (pid ${owner.pid})` : ''}`
                + `${owner.model ? ` — serving ${owner.model}` : ''}`;
        case 'unit':
            return `${owner.unit} — systemd ${owner.scope} unit`
                + `${owner.since ? `, active since ${owner.since}` : ''}`
                + `${owner.pid ? `, pid ${owner.pid}` : ''}`
                + (owner.enabled === true ? ', enabled at login' : owner.enabled === false ? ', not enabled at login' : '')
                + (owner.scope === 'system' ? ' — stopping it needs root' : '');
        case 'process':
            return `started outside systemd (${owner.pid ? `pid ${owner.pid}` : 'pid not visible'}`
                + `${owner.since ? `, since ${owner.since}` : ''})`
                + `${owner.command ? ` — ${owner.command}` : ''}`;
        case 'none':
            return 'not running';
    }
}

// ---------------- the parts that touch the machine (all of them may fail silently) ----------------

function run(cmd: string, args: string[], timeout = 4000): Promise<string | undefined> {
    return new Promise((resolve) => {
        try {
            cp.execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
                resolve(err && !stdout ? undefined : String(stdout ?? '').trim() || undefined);
            });
        } catch {
            resolve(undefined);
        }
    });
}

/** A command whose *failure* is the answer, so the exit code and stderr are wanted rather than discarded. */
function runStatus(cmd: string, args: string[], timeout = 30000): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve) => {
        try {
            cp.execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
                const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : (err ? 1 : 0);
                resolve({ code, out: String(stdout ?? ''), err: String(stderr ?? '') });
            });
        } catch {
            resolve({ code: null, out: '', err: '' });
        }
    });
}

function readProc(pid: number, file: string): string | undefined {
    try {
        return fs.readFileSync(`/proc/${pid}/${file}`, 'utf8');
    } catch {
        return undefined;
    }
}

/** The listening socket on one port, or nothing. */
export async function listenerFor(port: number): Promise<Listener | undefined> {
    const out = await run('ss', ['-ltnp'], 3000);
    if (!out) return undefined;
    return parseListeners(out).find((l) => l.port === port);
}

/** The unit a pid belongs to, with the facts a user asks about. */
async function unitFacts(unit: string, scope: 'user' | 'system'): Promise<UnitFacts> {
    const args = ['show', '-p', 'UnitFileState', '-p', 'MainPID', '-p', 'ActiveEnterTimestamp', '--', unit];
    const out = scope === 'user'
        ? await run('systemctl', ['--user', ...args], 5000)
        : await run('systemctl', args, 5000);
    return out ? parseSystemctlShow(out) : {};
}

/** The command line of a process, shortened to "binary first-arg" — enough to recognise it. */
function processCommand(pid: number): string | undefined {
    const raw = readProc(pid, 'cmdline');
    if (!raw) return undefined;
    const parts = raw.split('\0').filter(Boolean);
    if (!parts.length) return undefined;
    return [path.basename(parts[0]!), ...parts.slice(1, 2)].join(' ');
}

async function processStart(pid: number): Promise<string | undefined> {
    const out = await run('ps', ['-o', 'lstart=', '-p', String(pid)], 3000);
    return out ? out.replace(/\s+/g, ' ') : undefined;
}

/** How much memory a pid is holding right now (GB) — quoted when a stop frees it. */
function rssGb(pid: number | undefined): number | undefined {
    if (!pid) return undefined;
    const raw = readProc(pid, 'status');
    const m = raw ? /VmRSS:\s+(\d+)\s+kB/.exec(raw) : undefined;
    if (!m) return undefined;
    const gb = Number(m[1]) / (1024 * 1024);
    return Number.isFinite(gb) && gb > 0 ? Math.round(gb * 10) / 10 : undefined;
}

/**
 * Who is serving the configured endpoint.
 *
 * Order matters. Our own child first (we know it without asking the machine), then the socket, then the
 * cgroup. `port` is passed in when the caller already knows which port answered — `findRunningLlamaServer`
 * returns it — because guessing from the endpoint alone would describe a *different* server when the user's
 * own runs on 8080 while the settings point at 1234.
 */
export async function detectServerOwner(query: { port?: number; endpoint?: string } = {}): Promise<ServerOwner> {
    const own = ownLlamaServerStatus();
    if (own.running && own.info) {
        return { kind: 'ours', pid: own.info.pid, model: path.basename(own.info.modelPath) };
    }
    const port = query.port ?? endpointPort(query.endpoint ?? '') ?? undefined;
    if (!port) return { kind: 'none' };
    const listener = await listenerFor(port);
    if (!listener) return { kind: 'none' };
    if (!listener.pid) return { kind: 'process' };
    const cgroup = readProc(listener.pid, 'cgroup');
    const unit = cgroup ? unitFromCgroup(cgroup) : undefined;
    if (unit) {
        const facts = await unitFacts(unit.unit, unit.scope);
        return {
            kind: 'unit',
            unit: unit.unit,
            scope: unit.scope,
            pid: facts.pid ?? listener.pid,
            since: facts.since,
            enabled: facts.enabled
        };
    }
    return {
        kind: 'process',
        pid: listener.pid,
        since: await processStart(listener.pid),
        command: processCommand(listener.pid)
    };
}

// ---------------- which unit would be started? ----------------

/** Where a user unit lives. Only Linux with systemd has this folder; elsewhere the list is empty. */
export function unitSearchDirs(): string[] {
    return [path.join(os.homedir(), '.config', 'systemd', 'user')];
}

/** The `llama-server` units on this machine, by name, in the order they were found. */
export function discoverLlamaUnits(dirs: string[] = unitSearchDirs()): string[] {
    const files: { name: string; text: string }[] = [];
    for (const dir of dirs) {
        let names: string[];
        try {
            names = fs.readdirSync(dir);
        } catch {
            continue;
        }
        for (const name of names) {
            if (!name.endsWith('.service')) continue;
            try {
                files.push({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') });
            } catch { /* unreadable: treated as absent, like a missing folder */ }
        }
    }
    return llamaUnitsFromUnitFiles(files);
}

/**
 * The unit to act on: the setting first (an explicit choice is not overruled), then the unit the running
 * server belongs to, then the only `llama-server` unit on the machine.
 *
 * Two candidates and no setting is deliberately *not* a guess: stopping the wrong service is worse than
 * asking, so the caller is told there is a choice to make.
 */
export async function resolveLlamaUnit(detected?: ServerOwner): Promise<{ unit?: string; candidates: string[]; why?: string }> {
    const cfg = configView(SETTINGS);
    const configured = String(cfg.get<string>('llamaServerService', '') ?? '').trim();
    const found = discoverLlamaUnits();
    const candidates = [...new Set([configured, ...(detected?.kind === 'unit' ? [detected.unit] : []), ...found].filter(Boolean))];
    if (configured) return { unit: configured, candidates };
    if (detected?.kind === 'unit' && detected.scope === 'user') return { unit: detected.unit, candidates };
    if (found.length === 1) return { unit: found[0], candidates };
    if (found.length > 1) {
        return { candidates, why: `this machine has ${found.length} systemd user units that start a llama-server (${found.join(', ')}), so set "llamaServerService" to the one to use` };
    }
    return { candidates, why: 'no systemd user unit that starts a llama-server was found' };
}

// ---------------- starting ----------------

/** How the user wants it started. Persisted, because it is a preference about *their* machine. */
export type StartTarget = 'unit' | 'process';

export function startTarget(): StartTarget {
    const configured = String(configView(SETTINGS).get<string>('llamaServerStartTarget', 'unit') ?? '').trim().toLowerCase();
    return configured === 'process' ? 'process' : 'unit';
}

export interface StartChoice {
    ok: boolean;
    used?: StartTarget;
    /** True when the chosen route failed and the other one did it. */
    fellBack?: boolean;
    /** The failed route's own words, so the fallback is reported rather than hidden. */
    why?: string;
    message: string;
    endpoint?: string;
    modelId?: string;
}

/**
 * Wait until *something* is answering on the ports the settings point at.
 *
 * `/props` identifies a llama-server (see `findRunningLlamaServer`), so a plain HTTP server on the wrong
 * port is not mistaken for a service that just came up. The probe's cache is cleared on every attempt:
 * a cached "nothing there" from the reload before is exactly the wrong answer to this question.
 */
async function waitForAnswer(endpoint: string, onProgress?: (message: string) => void, timeoutMs = READY_TIMEOUT_MS): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    let said = 0;
    while (Date.now() < deadline) {
        forgetRunningProbe();
        const running = await findRunningLlamaServer(endpoint, { cacheMs: 0 });
        if (running) return running.endpoint;
        const waited = Math.round((Date.now() - (deadline - READY_TIMEOUT_MS)) / 1000);
        if (onProgress && waited && waited % 10 === 0 && waited !== said) {
            said = waited;
            onProgress(`waiting for the weights to load… (${waited} s)`);
        }
        await delay(1000);
    }
    return undefined;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long a unit gets to answer before it is treated as wedged and restarted. */
const QUICK_ANSWER_MS = 25 * 1000;

/**
 * Is that user unit up, by systemd's own answer?
 *
 * Exported because "is it already running?" changes what a caller should do, not just what it should say:
 * a unit that is up needs no `start` (a no-op) and no memory to be found for it (its weights may already be
 * resident, or swapped out — the state that made this machine's 30 B look dead on 2026-09-17).
 */
export async function unitIsActive(unit: string): Promise<boolean> {
    return (await run('systemctl', ['--user', 'is-active', unit], 5000))?.trim() === 'active';
}

/** Start (or reuse) the service the settings name, then pin the settings at whatever answers. */
async function startViaUnit(opts: { onProgress?: (message: string) => void }): Promise<StartChoice> {
    const endpoint = configView(SETTINGS).get<string>('endpoint', '');
    const owner = await detectServerOwner({ endpoint });
    const resolved = await resolveLlamaUnit(owner);
    if (!resolved.unit) return { ok: false, message: `A systemd unit cannot be used here: ${resolved.why}.` };
    const unit = resolved.unit;
    opts.onProgress?.(`starting ${unit}…`);
    const result = await runStatus('systemctl', ['--user', 'start', unit], 60000);
    if (result.code === null) {
        return { ok: false, message: 'systemctl is not available on this machine, so a systemd unit cannot be started.' };
    }
    if (result.code !== 0) {
        const why = (result.err || result.out).trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' · ');
        return { ok: false, message: `systemctl --user start ${unit} failed${why ? `: ${why}` : ` (exit ${result.code})`}.` };
    }
    forgetOwnerCache();

    // `systemctl start` is a NO-OP on a unit that is already active — and "active" is a state a llama-server can
    // sit in while being completely unusable: its weights swapped out, so `/props` never answers and a request
    // just hangs. Measured on this machine 2026-09-17: a unit "running" for two days reported `Memory: 50.4M
    // (peak: 17.9G, swap: 1.7G)` while every request failed — the panel said "starting…", systemd said fine, and
    // nothing ever answered. That is exactly what *"the llama 30B is not starting"* looks like from outside, so
    // the answer is a short wait followed by a **restart**, which is what puts the weights back in RAM.
    opts.onProgress?.(`${unit} started — waiting for it to answer…`);
    let answered = await waitForAnswer(endpoint, opts.onProgress, QUICK_ANSWER_MS);
    if (!answered) {
        const active = await unitIsActive(unit);
        if (!active) {
            return { ok: false, message: `${unit} is not running after a start request — see "systemctl --user status ${unit}".` };
        }
        opts.onProgress?.(`${unit} was already running but not answering — restarting it to bring its weights back into memory…`);
        const restarted = await runStatus('systemctl', ['--user', 'restart', unit], 60000);
        if (restarted.code === null || restarted.code !== 0) {
            const why = (restarted.err || restarted.out).trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' · ');
            return { ok: false, message: `systemctl --user restart ${unit} failed${why ? `: ${why}` : ''}.` };
        }
        forgetOwnerCache();
        answered = await waitForAnswer(endpoint, opts.onProgress);
    }
    if (!answered) return { ok: false, message: `${unit} was started but nothing answered on the configured address within ${Math.round(READY_TIMEOUT_MS / 60000)} minutes.` };
    forgetRunningProbe();
    const running = await findRunningLlamaServer(endpoint, { cacheMs: 0 });
    if (running) await useRunningLlamaServer(running);
    const name = running?.modelPath ? path.basename(running.modelPath) : running?.modelId;
    return {
        ok: true,
        used: 'unit',
        endpoint: answered,
        modelId: running?.modelId,
        message: `${unit} is running${name ? ` — it serves ${name}` : ''} on ${answered}.`
    };
}

/** Start one of ours (a child of this window), exactly as the panel's Load Model does. */
async function startViaProcess(opts: { onProgress?: (message: string) => void }): Promise<StartChoice> {
    const cfg = configView(SETTINGS);
    const outcome = await startOwnLlamaServer({
        modelPath: cfg.get<string>('modelPath', ''),
        contextLength: cfg.get<number>('loadContextLength', 0),
        gpu: cfg.get<string>('loadGpu', 'auto'),
        threads: cfg.get<number>('threads', 0),
        onProgress: opts.onProgress
    });
    if (!outcome.ok) return { ok: false, message: outcome.message ?? 'the llama-server could not be started' };
    forgetOwnerCache();
    return { ok: true, used: 'process', endpoint: outcome.endpoint, modelId: outcome.modelId, message: outcome.message ?? 'started' };
}

/**
 * Start it the way the user chose, and the other way when that fails.
 *
 * The fallback is not silent: `why` carries the failed route's own words, so "started as a process instead"
 * arrives with the reason the unit did not work (`no systemd user unit…`, `systemctl --user start … failed:
 * Unit not found`). A silent fallback would leave the user believing the thing they chose is what ran.
 */
export async function startLlamaServerByChoice(target: StartTarget, opts: { onProgress?: (message: string) => void } = {}): Promise<StartChoice> {
    const chosen = target === 'process' ? startViaProcess : startViaUnit;
    const other = target === 'process' ? startViaUnit : startViaProcess;
    const otherName = target === 'process' ? 'as a systemd unit' : 'as this window\'s process';
    log(`llama-server: starting it ${target === 'process' ? 'as this window\'s process' : 'as a systemd unit'}`);
    const first = await chosen(opts);
    if (first.ok) return first;
    log(`llama-server: the chosen way failed (${first.message}) — trying the other one`);
    opts.onProgress?.(`that did not work — trying it ${otherName} instead…`);
    const second = await other(opts);
    if (second.ok) return { ...second, fellBack: true, why: first.message };
    return {
        ok: false,
        message: `${first.message} Starting it ${otherName} instead did not work either: ${second.message}`
    };
}

// ---------------- stopping ----------------

export interface StopOutcome {
    ok: boolean;
    cancelled?: boolean;
    message: string;
}

/** The confirm dialog, injectable so the decision logic can be tested without a UI. */
export type Confirm = (message: string, ...actions: string[]) => Promise<string | undefined>;

async function defaultConfirm(message: string, ...actions: string[]): Promise<string | undefined> {
    return await vscode.window.showWarningMessage(message, { modal: true }, ...actions);
}

/**
 * Stop whatever is serving the endpoint, after asking — always, and about *that* thing.
 *
 * The question names what will be stopped and what it costs: the unit, its uptime and whether it comes back
 * at login; or a plain process's pid and command line. `systemctl --user stop` is used for a user unit so
 * systemd's own state stays true, and only a process `ss` named as a llama-server is ever signaled — a port
 * held by something else is reported instead.
 */
export async function stopLlamaServerConfirmed(
    opts: { port?: number; endpoint?: string; confirm?: Confirm; onProgress?: (message: string) => void } = {}
): Promise<StopOutcome> {
    const endpoint = opts.endpoint ?? configView(SETTINGS).get<string>('endpoint', '');
    const owner = await detectServerOwner({ port: opts.port, endpoint });
    const confirm = opts.confirm ?? defaultConfirm;
    if (owner.kind === 'none') {
        return { ok: false, message: 'No llama-server is running on the configured address, so there is nothing to stop.' };
    }
    const freed = rssGb(owner.pid);
    const consequence = owner.kind === 'unit' && owner.scope === 'user'
        ? `systemctl --user stop ${owner.unit} — it will not come back until it is started again`
        + `${owner.enabled ? ' (the unit is enabled, so it returns at your next login)' : ''}.`
        : owner.kind === 'process'
            ? 'The process is asked to exit (SIGTERM).'
            : 'It is this window\'s own process and will be killed.';
    const pick = await confirm(
        `Stop your llama-server?\n\n${describeOwner(owner)}${freed ? ` — holding ${freed} GB` : ''}\n\n${consequence}`,
        'Stop it',
        'Cancel'
    );
    if (pick !== 'Stop it') return { ok: false, cancelled: true, message: 'stop cancelled' };

    if (owner.kind === 'ours') {
        stopOwnLlamaServer();
        forgetRunningProbe();
        forgetOwnerCache();
        return { ok: true, message: `Your llama-server has been stopped${freed ? ` — ${freed} GB freed` : ''}.` };
    }
    if (owner.kind === 'unit' && owner.scope === 'system') {
        return {
            ok: false,
            message: `${owner.unit} belongs to the system manager, which needs root: run `
                + `"sudo systemctl stop ${owner.unit}" in a terminal. Nothing was changed.`
        };
    }
    if (owner.kind === 'unit') {
        opts.onProgress?.(`stopping ${owner.unit}…`);
        const result = await runStatus('systemctl', ['--user', 'stop', owner.unit], 30000);
        if (result.code === null || result.code !== 0) {
            const why = (result.err || result.out).trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' · ');
            return { ok: false, message: `systemctl --user stop ${owner.unit} failed${why ? `: ${why}` : ''}.` };
        }
        const gone = await waitForPortFree(owner.pid, opts.port ?? endpointPort(endpoint));
        forgetRunningProbe();
        forgetOwnerCache();
        return {
            ok: true,
            message: `${owner.unit} has been stopped${gone ? '' : ' (the port is still closing)'}`
                + `${freed ? ` — ${freed} GB freed` : ''}.`
        };
    }
    // A plain process: only a llama-server is ever signaled, and the name is checked rather than assumed.
    const looksLikeLlama = /llama[-_]server/i.test(owner.command ?? '');
    if (!owner.pid || !looksLikeLlama) {
        return {
            ok: false,
            message: `The port is held by something that does not look like a llama-server `
                + `(${owner.command ?? 'no command line visible'})${owner.pid ? `, pid ${owner.pid}` : ''}. Nothing was stopped.`
        };
    }
    try {
        process.kill(owner.pid, 'SIGTERM');
    } catch (err) {
        return { ok: false, message: `The process (pid ${owner.pid}) could not be signaled: ${err instanceof Error ? err.message : String(err)}` };
    }
    const gone = await waitForPortFree(owner.pid, opts.port ?? endpointPort(endpoint));
    forgetRunningProbe();
    forgetOwnerCache();
    return {
        ok: true, message: `The llama-server (pid ${owner.pid}) has been stopped${gone ? '' : ' (the port is still closing)'}`
            + `${freed ? ` — ${freed} GB freed` : ''}.`
    };
}

/** Wait until a stopped server has released its port (or is at least gone as a process). */
async function waitForPortFree(pid: number | undefined, port: number | undefined): Promise<boolean> {
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const alive = pid ? isAlive(pid) : false;
        const listening = port ? await listenerFor(port) : undefined;
        if (!alive && !listening) return true;
        await delay(500);
    }
    return false;
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

// ---------------- what the panel and the status dialog show ----------------

/** Everything the Settings panel needs to draw the llama-server row in one object. */
export interface LlamaServerState {
    owner: ServerOwner;
    ownerText: string;
    target: StartTarget;
    /** Candidate units, the configured one first — shown when the user needs to pick. */
    units: string[];
    configuredUnit: string;
    port?: number;
    canStop: boolean;
    canStart: boolean;
    /** Why starting may not work, when there is a reason worth saying up front. */
    note?: string;
}

/**
 * The owner, cached for a few seconds.
 *
 * `panelState()` runs on every panel open, save and focus, and answering this question costs three
 * subprocesses (`ss`, `systemctl show`, `ps`). So it is cached, and everything that can change the answer
 * clears the cache (`forgetOwnerCache`) rather than trusting the clock to have moved on.
 */
const OWNER_CACHE_MS = 5000;
let ownerCache: { at: number; port?: number; value?: ServerOwner } = { at: 0 };

/** Forget the cached owner — called after anything that changes who is running. */
export function forgetOwnerCache(): void {
    ownerCache = { at: 0 };
}

/**
 * The state of the user's own server: who is serving, how it would be started, and whether either is
 * possible. One call, because the panel and the status dialog must not be able to disagree.
 */
export async function llamaServerState(endpoint: string): Promise<LlamaServerState> {
    const cfg = configView(SETTINGS);
    const configuredUnit = String(cfg.get<string>('llamaServerService', '') ?? '').trim();
    const own = ownLlamaServerStatus();
    const runningElsewhere = own.running ? undefined : await findRunningLlamaServer(endpoint);
    const port = own.info?.port ?? runningElsewhere?.port ?? endpointPort(endpoint);
    let owner: ServerOwner;
    if (ownerCache.value && ownerCache.at && Date.now() - ownerCache.at < OWNER_CACHE_MS && ownerCache.port === port) {
        owner = ownerCache.value;
    } else {
        owner = await detectServerOwner({ port, endpoint });
        ownerCache = { at: Date.now(), port, value: owner };
    }
    const resolved = await resolveLlamaUnit(owner);
    return {
        owner,
        ownerText: describeOwner(owner),
        target: startTarget(),
        units: resolved.candidates,
        configuredUnit,
        port: owner.kind === 'none'
            ? undefined
            : owner.kind === 'ours' ? own.info?.port : runningElsewhere?.port ?? endpointPort(endpoint),
        canStop: owner.kind !== 'none',
        canStart: !!resolved.unit || !!String(cfg.get<string>('modelPath', '') ?? '').trim(),
        note: resolved.why
    };
}

/** Exposed for the log line the panel writes when a stop is refused or a start falls back. */
export function logService(message: string): void {
    log(`llama-server service: ${message}`);
}

/** Exposed for the failure path, so a systemctl that misbehaves is visible in the output channel. */
export function logServiceError(message: string): void {
    logError(`llama-server service: ${message}`);
}
