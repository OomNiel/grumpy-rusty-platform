/* Which agents are on this machine, and which one a hand-off should go to.
 *
 * WHY THIS EXISTS (asked 2026-10-13). *"The AI Assist is currently hard-wired for using the pool agent. The
 * system must scan the machine to find and list all available API agents to allow the user to select the one to
 * hand off to."* So this module answers two questions and nothing else: **what is on this machine**, and
 * **which of those can this extension actually drive**.
 *
 * WHY THOSE ARE TWO QUESTIONS. They are not the same list, and conflating them is how a hand-off silently does
 * nothing. A binary being installed says nothing about its *non-interactive* contract — the flags that make an
 * agent take one prompt, work unattended, and exit are different in every one of them. This extension knows
 * exactly one such contract by heart because it was measured (`pool exec`, see `ai/pool.ts`), and it knows the
 * OpenAI-compatible `/chat/completions` shape because the rest of the assistant already speaks it. Anything else
 * is *reported*, never guessed at: an invented flag list for an agent nobody on this machine has installed would
 * be untestable, and the first person to try it would get a hand-off that appears to run and does nothing.
 * `drivable` is that distinction, and it is the field the picker is built on.
 *
 * THE SHELL-BUILTIN TRAP (found on 2026-10-13, on this machine). `command -v continue` prints `continue` — a
 * **bash builtin** — for a machine with no such program, and `command -v` on a name that is also a builtin
 * answers about the *shell*, not the disk. A scan built on that would have listed an "agent" that cannot be
 * spawned. So the lookup here walks `$PATH` itself with an explicit executable test: no shell, no builtins, no
 * surprises — and it is the part the suite drives with a temporary folder full of fake binaries.
 *
 * PURE AND EFFECTFUL, as everywhere else in `ai/`: the preset tables, the id parsing, the choice between
 * candidates and every line of wording are pure and asserted; only the PATH walk, the `--version` probe and the
 * HTTP probe touch the world.
 */

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** How a prompt is handed to an agent, which is the only thing that decides how to run it. */
export type AgentKind =
    /** The Poolside CLI: measured, `-o json` NDJSON on stdout, exit 4 means "I could not". */
    | 'pool'
    /**
     * J-Code — `jcode`, the Agnes Code CLI: measured, `run --ndjson` events on stdout, the session id in
     * `start`, and tools that run without an approval prompt.
     */
    | 'jcode'
    /** Another CLI agent. Listed when found; only usable once the extension has a verified invocation. */
    | 'cli'
    /** An OpenAI-compatible endpoint: it answers a prompt, it cannot touch the project. */
    | 'openai';

/** One agent this machine might have. */
export interface AgentCandidate {
    /** Stable id, and what `rustyPlatform.assistant.handoffAgent` stores: `pool`, `cli:aider`, `openai:1234`. */
    id: string;
    /** What the picker calls it. */
    label: string;
    kind: AgentKind;
    /** Absolute path of the executable, when it is a CLI. */
    command?: string;
    /**
     * The argument list to run it with, with `{dir}` standing for the project folder (only where `drivable`).
     * The prompt is never in here — see `CliPreset.args`.
     */
    args?: string[];
    /** Its version, when the probe could ask (CLI agents). */
    version?: string;
    /** The model it offers, when it is an endpoint. */
    model?: string;
    /** Base URL, when it is an endpoint. */
    endpoint?: string;
    /** True when this machine has it. */
    available: boolean;
    /** True when the extension knows how to drive it unattended — see the header. */
    drivable: boolean;
    /** Why it is not available, in the user's words. */
    why?: string;
}

/** A CLI agent the extension can run: everything needed to build its command line. */
export interface CliPreset {
    /** The executable to look for on `$PATH`. */
    command: string;
    label: string;
    /** `pool` for the one CLI whose contract is measured; `cli` for every other one found. */
    kind?: AgentKind;
    /**
     * The argument list, with `{dir}` replaced by the project folder. The prompt is **never** in here: pool
     * takes it on stdin and jcode as its last argument, and each driver builds its own call (`ai/pool.ts`,
     * `ai/jcode.ts`) — so a display of this list is never a runnable command line for the one that needs argv.
     */
    args?: string[];
    /** True only where the invocation has been measured. */
    drivable: boolean;
    /** What makes this one drivable, for the picker's own sentence. */
    note?: string;
}

/**
 * The CLI agents worth looking for.
 *
 * The two the extension can **drive** come first, in the order an automatic hand-off should try them: pool, then
 * jcode. Both work in the project; pool's model is the platform's, while jcode reaches a cloud model through its
 * own configuration, which is a choice worth leaving to the developer (`handoffAgent`). The rest are here so that
 * the answer to "what is on my machine?" is honest rather than a single name: a preset with `drivable: false` is
 * still worth finding, because "the extension can see your agent and cannot yet use it" is a different message
 * from silence.
 */
export const CLI_PRESETS: readonly CliPreset[] = [
    {
        command: 'pool',
        label: 'Poolside CLI agent',
        kind: 'pool',
        args: ['exec', '-o', 'json', '-d', '{dir}', '-p', '-'],
        drivable: true,
        note: 'measured against pool 1.0.16: NDJSON on stdout, exit 4 = could not finish'
    },
    {
        // Two names on purpose: the executable is `jcode` and its own banner calls it J-Code, but the agent it
        // reaches here is Agnes, and "Agnes Code CLI" is what the developer looking for it calls it.
        command: 'jcode',
        label: 'Agnes Code CLI (jcode)',
        kind: 'jcode',
        args: ['run', '--quiet', '--no-update', '--ndjson', '-C', '{dir}'],
        drivable: true,
        note:
            'measured against jcode 0.75.0: NDJSON events on stdout, the session id in `start`, tools run ' +
            'without an approval prompt'
    },
    { command: 'claude', label: 'Claude Code', drivable: false },
    { command: 'codex', label: 'OpenAI Codex CLI', drivable: false },
    { command: 'aider', label: 'Aider', drivable: false },
    { command: 'goose', label: 'Goose', drivable: false },
    { command: 'opencode', label: 'opencode', drivable: false },
    { command: 'gemini', label: 'Gemini CLI', drivable: false },
    { command: 'crush', label: 'Crush', drivable: false },
    { command: 'amp', label: 'Amp', drivable: false },
    { command: 'cursor-agent', label: 'Cursor agent', drivable: false },
    { command: 'qwen', label: 'Qwen Code', drivable: false }
];

/**
 * The local ports worth knocking on, in the order a developer is likely to have one running.
 *
 * An endpoint is not an agent with tools — it answers a prompt and knows nothing about the project — so a
 * hand-off to one is a *proposal* rather than an edit, and the picker says so (`kind: 'openai'`).
 */
export const ENDPOINT_PRESETS: readonly { port: number; label: string }[] = [
    { port: 1234, label: 'LM Studio' },
    { port: 8080, label: 'llama-server' },
    { port: 11434, label: 'Ollama' },
    { port: 8000, label: 'vLLM' }
];

/** The endpoint of a local preset: its own `/v1`, which is what every one of them mounts. */
export function presetEndpoint(port: number): string {
    return `http://127.0.0.1:${port}/v1`;
}

/** The id of a discovered CLI agent. */
export function cliAgentId(command: string): string {
    return `cli:${command}`;
}

/** The id of a discovered endpoint, keyed by port so it stays the same across restarts. */
export function endpointAgentId(port: number): string {
    return `openai:${port}`;
}

/**
 * The executable at `command`, or undefined.
 *
 * Written as an explicit walk rather than `which`/`command -v` for the reason in the header: those answer about
 * the *shell* when a name is also a builtin (`continue` is the one that would have been listed here), and they
 * cost a process. Only an absolute or relative path in the entry is accepted, so a passing `command` is
 * reusable by `spawn` without a second lookup.
 */
export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (command.includes('/')) {
        return isExecutable(command) ? command : undefined;
    }
    for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, command);
        if (isExecutable(candidate)) return candidate;
    }
    return undefined;
}

function isExecutable(file: string): boolean {
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) return false;
        fs.accessSync(file, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** The version out of a `--version` banner, e.g. `1.0.16`. */
export function parseVersion(text: string): string | undefined {
    return /(\d+\.\d+(?:\.\d+)?)/.exec(String(text ?? ''))?.[1];
}

/**
 * One line for the picker: what it is, whether this machine has it, and whether it can be driven.
 *
 * The three states read differently on purpose, because they need different actions from the developer: *ready*
 * (pick it), *found but not drivable* (the extension cannot use it yet), and *not installed* (it is not there).
 */
export function describeAgent(agent: AgentCandidate): string {
    // An agent that is not usable says why in its own words, and the reason *is* the sentence: "`codex` is not on
    // the PATH" and "no API key stored yet" need different actions from the developer, and a fixed prefix like
    // "not found" would be wrong for the second (a configured cloud API is not lost, it is unauthenticated).
    if (!agent.available) return `${agent.label} — ${agent.why ?? 'not found'}`;
    if (!agent.drivable) {
        return agent.kind === 'cli'
            ? `${agent.label}${agent.version ? ` ${agent.version}` : ''} — found, but this extension has no verified way to run it unattended yet`
            : `${agent.label} — answers only; it cannot change your project`;
    }
    if (agent.kind === 'openai') {
        return `${agent.label}${agent.model ? ` (${agent.model})` : ''} — answers a prompt, then you review the code`;
    }
    return `${agent.label}${agent.version ? ` ${agent.version}` : ''} — works in your project and can build what it changes`;
}

/**
 * The agent to use, given what the scan found and what the user asked for.
 *
 * `preferred` wins whenever it is usable, because a choice the user made by hand must not be quietly
 * overridden. Otherwise the first *drivable and available* candidate in scan order is taken — an agent that
 * works in the project (pool) before one that only answers (an endpoint) — and when nothing qualifies the
 * answer is `undefined` rather than a hopeful guess.
 */
export function chooseAgent(
    candidates: readonly AgentCandidate[],
    preferred?: string
): AgentCandidate | undefined {
    const usable = (a: AgentCandidate) => a.available && a.drivable;
    if (preferred) {
        const wanted = candidates.find((a) => a.id === preferred);
        if (wanted && usable(wanted)) return wanted;
    }
    return candidates.find(usable);
}

/** Why a hand-off cannot run, when none of the candidates can. */
export function whyNoAgent(candidates: readonly AgentCandidate[]): string {
    const found = candidates.filter((a) => a.available);
    const endpoint = candidates.find((a) => a.kind === 'openai' && a.available);
    if (endpoint) {
        return 'The only agent answering is an endpoint, which cannot change files — it can still be used to answer.';
    }
    if (found.length) {
        return (
            `This machine has ${found.map((a) => a.label).join(', ')}, but not one this extension knows how to run ` +
            'unattended yet. Set "rustyPlatform.assistant.handoff" to `off` to stop being offered it.'
        );
    }
    return (
        'No agent was found on this machine. Install the Poolside CLI (`pool`), or start a local ' +
        'OpenAI-compatible server, and the offer will come back.'
    );
}

/** The scan, as the picker's own lines. */
export function agentScanLines(candidates: readonly AgentCandidate[]): string[] {
    return candidates.map(describeAgent);
}

/**
 * A short name for an agent — short enough to put on a button.
 *
 * The full label of a cloud provider is `Cloud API (https://apihub.agnes-ai.com/v1)`, which is right in a list and
 * far too long in a sentence like "Hand it to …". A remote endpoint is therefore named by its host, which is what
 * a person calls it (agnes-ai.com, not "the cloud API"), while anything local keeps its own label because that is
 * already short and tells them *which* local thing it is (2026-10-13).
 */
export function agentShortName(agent: AgentCandidate | undefined): string {
    if (!agent) return 'an agent';
    if (agent.kind === 'pool') return 'the Poolside agent';
    if (agent.kind === 'jcode') return 'the Agnes Code CLI';
    if (agent.kind === 'cli') return agent.label;
    const endpoint = agent.endpoint ?? '';
    try {
        const host = new URL(endpoint).host;
        const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
        // A local server is named as the list names it (`LM Studio on port 1234`); a remote one by its host.
        return local ? agent.label : host.replace(/^www\./, '');
    } catch {
        return agent.label;
    }
}

/**
 * The verb of every hand-off action, naming the agent it will really go to.
 *
 * One wording, used by the chat's refusal block, the editor's dialog and the repair loop's offer, so they cannot
 * drift apart — and so none of them keeps saying "pool" after pool stopped being the only answer
 * (reported 2026-10-13: *"the prompt in the response box reads: Hand to the Pool agent"*).
 */
export function handoffButtonLabel(agent: AgentCandidate | undefined): string {
    return `Hand it to ${agentShortName(agent)}…`;
}

/** One agent's `--version`, or undefined when it cannot be asked. Never throws. */
export function probeVersion(command: string, timeoutMs = 5000): Promise<string | undefined> {
    return new Promise((resolve) => {
        child_process.execFile(command, ['--version'], { timeout: timeoutMs }, (error, stdout, stderr) => {
            if (error && !stdout && !stderr) return resolve(undefined);
            resolve(parseVersion(`${stdout ?? ''}${stderr ?? ''}`));
        });
    });
}

/** What an HTTP endpoint answers about itself: the model ids it offers, or undefined when nothing answers. */
export async function probeEndpoint(
    endpoint: string,
    timeoutMs = 1500,
    fetchImpl: typeof fetch = fetch
): Promise<string[] | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetchImpl(`${endpoint}/models`, { signal: controller.signal });
        if (!res.ok) return undefined;
        const body = (await res.json()) as { data?: { id?: unknown }[] };
        const ids = (body.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean);
        return ids.length ? ids : undefined;
    } catch {
        return undefined;
    } finally {
        clearTimeout(timer);
    }
}

/** What the scanner needs to know about the rest of the extension. */
export interface ScanInput {
    /** The endpoint the assistant is already pointed at, which is an agent too if it answers. */
    configuredEndpoint?: string;
    /** The bundled runtime's endpoint, when it is up. */
    bundledEndpoint?: string;
    /**
     * A cloud API the developer configured (`cloudEndpoint` / `cloudModel`), offered as a hand-off provider.
     *
     * `hasKey` decides whether it is usable, and the scan never probes it: a probe would be a request to a
     * third party's server every time the panel draws, which is both slow and something a person should agree
     * to. The picker forces a scan, and that is a deliberate act.
     */
    cloud?: { endpoint: string; model?: string; hasKey: boolean };
    /** Probe `--version` on everything found. Off in the suite, on in the panel. */
    probeVersions?: boolean;
    env?: NodeJS.ProcessEnv;
    /** Injected in the suite, so a scan can be asserted without a server to knock on. */
    fetchImpl?: typeof fetch;
}

/**
 * Scans the machine: the CLI agents on `$PATH`, the local ports that answer, and whatever the assistant is
 * already configured to talk to.
 *
 * Order matters downstream (`chooseAgent` takes the first usable candidate), so it is deliberate: the drivable
 * CLI first, then the other CLIs the user may be able to configure, then endpoints. Nothing here refuses
 * anything — the list is information, and the choice is the user's.
 */
export async function scanAgents(input: ScanInput = {}): Promise<AgentCandidate[]> {
    const candidates: AgentCandidate[] = [];

    for (const preset of CLI_PRESETS) {
        const command = findExecutable(preset.command, input.env);
        candidates.push({
            id: cliAgentId(preset.command),
            label: preset.label,
            kind: preset.kind ?? 'cli',
            command,
            args: preset.drivable ? preset.args : undefined,
            available: Boolean(command),
            drivable: preset.drivable,
            why: command ? undefined : `\`${preset.command}\` is not on the PATH`
        });
    }

    // The ports are knocked on **all at once**: four sequential 1.5 s timeouts spent six seconds finding
    // nothing, which is the ordinary case on a machine with no local server, and this scan runs when the panel
    // opens. The index keeps the order stable so `chooseAgent` still sees endpoints in a fixed sequence.
    const probed = await Promise.all(
        ENDPOINT_PRESETS.map(async (preset) => {
            const endpoint = presetEndpoint(preset.port);
            const models = await probeEndpoint(endpoint, 1500, input.fetchImpl);
            return { preset, endpoint, models };
        })
    );
    for (const { preset, endpoint, models } of probed) {
        candidates.push({
            id: endpointAgentId(preset.port),
            label: `${preset.label} on port ${preset.port}`,
            kind: 'openai',
            endpoint,
            model: models ? models[0] : undefined,
            available: Boolean(models),
            // An endpoint always answers a prompt; it is "drivable" as an answering agent, never as an editor.
            drivable: Boolean(models),
            why: models ? undefined : 'nothing is listening on that port'
        });
    }

    // The endpoint the assistant is already configured to use, and the bundled runtime when it is up: both are
    // agents the user has, and neither would be found by looking at ports and PATH alone.
    const extras = (
        [
            ['The server in "endpoint"', input.configuredEndpoint],
            ["The extension's own runtime", input.bundledEndpoint]
        ] as const
    ).filter(([, endpoint]) => Boolean(endpoint));
    const extraProbes = await Promise.all(
        extras.map(async ([label, endpoint]) => ({
            label,
            endpoint: String(endpoint),
            models: await probeEndpoint(String(endpoint), 1500, input.fetchImpl)
        }))
    );
    for (const { label, endpoint, models } of extraProbes) {
        candidates.push({
            id: `openai:${endpoint}`,
            label: `${label} (${endpoint})`,
            kind: 'openai',
            endpoint,
            model: models ? models[0] : undefined,
            available: Boolean(models),
            drivable: Boolean(models),
            why: models ? undefined : 'nothing answered there'
        });
    }

    if (input.cloud?.endpoint) {
        const { endpoint, model, hasKey } = input.cloud;
        candidates.push({
            id: `openai:${endpoint}`,
            label: `Cloud API (${endpoint})`,
            kind: 'openai',
            endpoint,
            model,
            // Configured is not the same as usable: without a key it is listed so the developer can see what is
            // missing, and `chooseAgent` passes over it.
            available: hasKey,
            drivable: hasKey,
            why: hasKey ? undefined : 'no API key stored yet — run "Rusty AI: Set the Hand-off API Key…"'
        });
    }

    if (input.probeVersions) {
        // All at once, for the same reason the ports are: each probe is a process, and they do not depend on
        // each other.
        await Promise.all(
            candidates.map(async (agent) => {
                if (!agent.available || !agent.command) return;
                agent.version = await probeVersion(agent.command);
            })
        );
    }
    return candidates;
}
