/* The hand-off flow: consent, run, report — the part that talks to the user.
 *
 * `ai/scope.ts` decides that a request is beyond the local model, and `ai/pool.ts` knows how to run the Poolside
 * agent. This is the piece in between: it reads the settings, asks the developer what may leave the machine,
 * runs the agent with the request on its stdin, and says what came back.
 *
 * THE DISCLOSURE IS THE POINT. A hand-off sends the developer's own code to Poolside's inference service
 * (`inference.poolside.ai` — pool's own configured API), and with auto-allow on it lets an agent change files
 * without asking. Both are things a person is entitled to know *before* the run, per run, so the consent dialog
 * says them in plain sentences rather than burying them in a setting nobody reads. The user's own answer, when
 * asked how a hand-off should behave, was *"ask every time, showing what will be sent"* — which is what this
 * implements, and why there is no "remember my answer" path out of it.
 *
 * THE CONVERSATION CONTINUES. Each run leaves a Run ID (see `pool.ts`), which is remembered per workspace, so a
 * second hand-off adds to what the agent already did instead of starting over — that is the "continue the
 * process" the feature was asked for.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { log, logError } from './log';
import { configView } from './settings';
import { extensionContext } from './runtime';
import { normalizeAssistantConfig, type AssistantConfig } from './assistant';
import {
    handoffPrompt,
    newestRunId,
    normalizeHandoff,
    poolToolLine,
    poolVersion,
    runPool,
    trajectoryDir,
    handoffKeyName,
    envFileKey,
    importableKeyFiles,
    type HandoffConfig,
    type PoolOutcome,
    type PoolRun
} from './pool';
import { chooseAgent, scanAgents, whyNoAgent, describeAgent, agentShortName, type AgentCandidate } from './agents';
import {
    jcodeToolLine,
    jcodeVersion,
    runJcode,
    sessionIdForDirectory,
    type JcodeOutcome,
    type JcodeRun
} from './jcode';
import { bundledRuntimeRunning } from './runtime';
import { chatDetailed, describeEmptyAnswer, describeProgress } from './assistant';

export const SETTINGS = 'rustyPlatform.assistant';

/**
 * The assistant's configuration, read here rather than imported from `editor.ts`.
 *
 * `editor.ts` imports *this* module, so importing its `assistantConfig` back would be a cycle — and the local
 * read is the house pattern anyway (`panel.ts`, `llamaServer.ts` and `localModelSetup.ts` each build the config
 * they need the same way). The field list is the same as `editor.ts`'s, because `normalizeAssistantConfig` is
 * what decides what the setting names mean; only the reading is repeated.
 */
function assistantConfig(): AssistantConfig {
    const cfg = configView(SETTINGS);
    return normalizeAssistantConfig({
        enabled: cfg.get('enabled'),
        stopServersAtStartup: cfg.get('stopServersAtStartup'),
        backend: cfg.get('backend'),
        endpoint: cfg.get('endpoint'),
        model: cfg.get('model'),
        modelPath: cfg.get('modelPath'),
        threads: cfg.get('threads'),
        contextSize: cfg.get('contextSize'),
        gpuLayers: cfg.get('gpuLayers'),
        bundledBackend: cfg.get('bundledBackend'),
        timeoutSeconds: cfg.get('timeoutSeconds'),
        maxTokens: cfg.get('maxTokens'),
        temperature: cfg.get('temperature'),
        showDiff: cfg.get('showDiff')
    });
}

/** The hand-off settings as they are configured right now. */
export function handoffConfig(): HandoffConfig {
    const raw = configView(SETTINGS);
    return normalizeHandoff({
        handoff: raw.get('handoff'),
        handoffAgent: raw.get('handoffAgent'),
        cloudEndpoint: raw.get('cloudEndpoint'),
        cloudModel: raw.get('cloudModel'),
        poolCommand: raw.get('poolCommand'),
        poolAgent: raw.get('poolAgent'),
        poolAutoAllow: raw.get('poolAutoAllow'),
        poolTimeoutSeconds: raw.get('poolTimeoutSeconds'),
        poolResume: raw.get('poolResume')
    });
}

/**
 * The version of the configured `pool`, or undefined when there is not one to run.
 *
 * Asked once per session: this is on the path of a dialog the user is waiting for, and the answer cannot change
 * while the window is open. `pool --version` costs about 15 ms, which is not the point — the point is that it
 * spawns a process, and doing that on every warning would be rude.
 */
let probed: { command: string; version?: string } | undefined;
export async function poolStatus(command: string): Promise<string | undefined> {
    if (probed?.command === command) return probed.version;
    const version = await poolVersion(command);
    probed = { command, version };
    log(version ? `handoff: ${command} is version ${version}` : `handoff: ${command} was not found`);
    return version;
}

/** Forget the probed version — the settings panel calls this after a save, when the command may have changed. */
export function forgetPoolStatus(): void {
    probed = undefined;
}

/**
 * The version of the configured `jcode`, on the same terms as `poolStatus` — asked once, cached, and silent about
 * a command that is not there (which the agent scan reports as "not found" with the rest of them).
 */
let probedJcode: { command: string; version?: string } | undefined;
export async function jcodeStatus(command: string): Promise<string | undefined> {
    if (probedJcode?.command === command) return probedJcode.version;
    const version = await jcodeVersion(command);
    probedJcode = { command, version };
    log(version ? `handoff: ${command} is version ${version}` : `handoff: ${command} was not found`);
    return version;
}

/** Forget the probed jcode version — the same reason as `forgetPoolStatus`. */
export function forgetJcodeStatus(): void {
    probedJcode = undefined;
}

/**
 * The agents on this machine, scanned at most once every `AGENT_SCAN_TTL_MS`.
 *
 * The scan knocks on four local ports and runs `--version` on every agent it finds, and it is asked for whenever
 * the panel refreshes — so it is cached rather than repeated, and the ports are probed in parallel so the
 * ordinary case (nothing listening) costs one timeout instead of four. The library's own refresh paths call
 * this, so it must stay cheap; the picker forces a fresh one.
 */
const AGENT_SCAN_TTL_MS = 20_000;
let agentCache: { at: number; candidates: AgentCandidate[] } | undefined;

export async function agentScan(force = false): Promise<AgentCandidate[]> {
    if (!force && agentCache && Date.now() - agentCache.at < AGENT_SCAN_TTL_MS) return agentCache.candidates;
    const cfg = assistantConfig();
    const handoff = handoffConfig();
    const running = bundledRuntimeRunning();
    const cloudKey = handoff.cloudEndpoint ? await handoffKey(handoff.cloudEndpoint) : undefined;
    const candidates = await scanAgents({
        configuredEndpoint: cfg.endpoint,
        bundledEndpoint: running.running ? running.endpoint : undefined,
        cloud: handoff.cloudEndpoint
            ? { endpoint: handoff.cloudEndpoint, model: handoff.cloudModel || undefined, hasKey: Boolean(cloudKey) }
            : undefined,
        probeVersions: true
    });
    agentCache = { at: Date.now(), candidates };
    log(`handoff: scanned for agents — ${candidates.filter((a) => a.available).map((a) => a.id).join(', ') || 'none'}`);
    return candidates;
}

/**
 * The API key stored for an endpoint, when there is one.
 *
 * VS Code's secret storage rather than a setting: settings are plain JSON that is synced between machines,
 * exported in a profile and readable by anything with the workspace open, which is not where a bearer token
 * belongs. A key is looked up by endpoint, so the value sent to `apihub.agnes-ai.com` is the one stored for it
 * and cannot leak to another provider (2026-10-13).
 */
export async function handoffKey(endpoint: string): Promise<string | undefined> {
    if (!endpoint) return undefined;
    try {
        return (await extensionContext()?.secrets.get(handoffKeyName(endpoint))) || undefined;
    } catch (error) {
        logError(error);
        return undefined;
    }
}

/**
 * Stores (or, with an empty string, clears) the API key for a cloud endpoint.
 *
 * Returns whether the secret store now really holds what was asked for, and that return value is the point: the
 * store can refuse (a locked keyring, a storage backend that is not there), and a command that said "key stored"
 * when nothing was stored would leave a developer with a hand-off that fails with a 401 and no reason to suspect
 * the key was never saved. So the value is **read back** and compared — the only way to know is to ask.
 */
export async function setHandoffKey(endpoint: string, key: string): Promise<boolean> {
    const secrets = extensionContext()?.secrets;
    if (!secrets || !endpoint) {
        log('handoff: no secret storage is available — the API key was NOT stored');
        return false;
    }
    const name = handoffKeyName(endpoint);
    try {
        if (key) await secrets.store(name, key);
        else await secrets.delete(name);
        const now = await secrets.get(name);
        const ok = key ? now === key : now === undefined;
        // The scan's answer depends on whether a key is stored, so the cache is no longer true either way.
        forgetAgentScan();
        log(`handoff: API key for ${endpoint} ${key ? 'stored' : 'cleared'} — ${ok ? 'verified' : 'NOT verified'}`);
        return ok;
    } catch (error) {
        logError(error);
        return false;
    }
}

/**
 * A key already sitting in an env file on this machine, with the path it came from.
 *
 * The path is returned so the dialog can name the file it would read; the key itself is only ever passed to the
 * request that needs it, never logged and never shown.
 */
export async function findImportableKey(): Promise<{ path: string; key: string } | undefined> {
    for (const file of importableKeyFiles()) {
        try {
            const text = await fs.promises.readFile(file, 'utf8');
            const key = envFileKey(text);
            if (key) return { path: file, key };
        } catch {
            /* not there, or not readable — try the next one */
        }
    }
    return undefined;
}

/** Forget the scan. For the picker, and for a settings change that could add an agent. */
export function forgetAgentScan(): void {
    agentCache = undefined;
}

/** What the caller knows about the request being handed over. */
export interface HandoffRequest {
    /** What the developer asked for, in their own words. */
    request: string;
    /** The scope verdict's message: why the local model would not take it. Passed on as context. */
    refused?: string;
    /** The context block the local prompt would have carried (target, crates, rules, board facts). */
    facts?: string;
    /** The file in focus, when there is one. */
    target?: { path: string; text: string };
    /** The project the agent works in. */
    directory: string;
    /**
     * Skip the consent dialog.
     *
     * Only ever true when the user has *just* been asked and answered — the chat panel asks with a button of its
     * own, which is the consent. Nothing may set this to true on the user's behalf.
     */
    consented?: boolean;
}

/** What a hand-off did, for the caller to render wherever the request came from. */
export interface HandoffReport {
    kind: PoolOutcome['kind'] | JcodeOutcome['kind'] | 'declined' | 'off' | 'answered';
    ok: boolean;
    /** The agent that ran it, described in full (`describeAgent`). */
    agent?: string;
    /** The same agent in as few words as a sentence allows: what the report's own header names. */
    agentName?: string;
    /** The agent's closing paragraph, when it wrote one. */
    answer: string;
    /** Everything the agent said, in order: the narration that goes in a transcript. */
    full: string;
    /** The work it did, as lines a developer reads: `edit_file: src/main.rs`. */
    work: string[];
    /** One sentence for the user. */
    message: string;
    /** The Run ID, when this run can be continued. */
    runId?: string;
    /** How much was sent, so the report can say the number rather than "some code". */
    promptTokens: number;
    seconds: number;
    /**
     * Whether the agent could act without asking, where such a switch exists (pool's auto-allow).
     *
     * Left undefined for the agents where the question does not arise — an endpoint cannot act at all, and jcode
     * runs its tools without a prompt by design — so a report can never carry a caveat that does not apply.
     */
    autoAllow?: boolean;
}

/** The Run ID of the last hand-off in this workspace, for `--continue`. */
export function lastRunId(): string | undefined {
    const context = extensionContext();
    const stored = context?.workspaceState.get<string>('assistant.poolLastRun');
    return stored || undefined;
}

async function rememberRunId(id: string): Promise<void> {
    await extensionContext()?.workspaceState.update('assistant.poolLastRun', id);
}

/**
 * The session id of the last jcode hand-off in this workspace, for `--resume`.
 *
 * Its own key, not pool's: the two agents keep conversations in different places and under different names, and
 * one setting holding "the last conversation" for both would continue the wrong one the moment a developer
 * switched agents.
 */
export function lastJcodeSession(): string | undefined {
    const context = extensionContext();
    const stored = context?.workspaceState.get<string>('assistant.jcodeLastSession');
    return stored || undefined;
}

async function rememberJcodeSession(id: string): Promise<void> {
    await extensionContext()?.workspaceState.update('assistant.jcodeLastSession', id);
}

/**
 * The conversation a hand-off would continue, if any.
 *
 * **One** decision, used both by the consent dialog (which shows the *resuming* script) and by the runner (which
 * passes the id). Two decisions here would mean the developer agreeing to one script and the agent being sent
 * another — and the difference between the two scripts is the whole first paragraph.
 */
function continueIdFor(cfg: HandoffConfig, agent: AgentCandidate, directory: string): string | undefined {
    if (!cfg.resume) return undefined;
    if (agent.kind === 'pool') return lastRunId();
    if (agent.kind === 'jcode') {
        // The remembered session first, and the saved ones as the fallback for a window that has forgotten it.
        // jcode records the project in each session file, so this asks a precise question rather than "newest".
        return lastJcodeSession() ?? sessionIdForDirectory(directory);
    }
    return undefined;
}

/** Where a hand-off's code goes, in the agent's own terms. */
function whereItGoes(cfg: HandoffConfig, request: HandoffRequest, agent: AgentCandidate): string {
    if (agent.kind === 'openai') {
        return (
            `Where it goes: ${agent.endpoint}. That endpoint answers the prompt; it cannot read or change your ` +
            'project, so whatever it writes comes back to you for review.'
        );
    }
    if (agent.kind === 'jcode') {
        // Named exactly as the run will name it: a provider the developer cannot see is a provider they cannot
        // check, and this CLI can be pointed at any of dozens of them.
        const target = cfg.jcodeProvider || cfg.jcodeModel
            ? `${cfg.jcodeProvider || 'its configured provider'}${cfg.jcodeModel ? ` with ${cfg.jcodeModel}` : ''}`
            : 'whatever provider and model jcode is configured with';
        return (
            `Where it goes: the agent runs in ${request.directory}, and its answers come from ${target} — not ` +
            'from this machine.'
        );
    }
    return (
        `Where it goes: the agent runs in ${request.directory}, and answers come from Poolside's own service ` +
        '(the API in your pool configuration), not from this machine.'
    );
}

/** Whether the agent will act in the project without asking — the second thing consent turns on. */
function actionDisclosure(cfg: HandoffConfig, agent: AgentCandidate): string {
    if (agent.kind === 'openai') return 'Nothing in your project is touched by the hand-off itself.';
    if (agent.kind === 'jcode') {
        // Measured 2026-10-13: a `write` tool call created a file with no approval prompt anywhere in the run, and
        // `jcode run` offers no brake for it. Saying so is the honest version of pool's auto-allow sentence —
        // promising a setting that does not exist is the one thing this dialog must never do.
        return (
            'The agent will read, write and run commands in your project without asking you first. jcode runs its ' +
            'tools that way: unlike the Poolside CLI there is no auto-allow setting to turn off.'
        );
    }
    return cfg.autoAllow
        ? 'The agent may use its tools — editing files and running commands — without asking you first.'
        : 'The agent will not be allowed to act without approval, so a run that needs to edit a file may stop.';
}

/** Forget the remembered conversation, so the next hand-off starts a new one. */
export async function forgetRunId(): Promise<void> {
    await extensionContext()?.workspaceState.update('assistant.poolLastRun', undefined);
    log('handoff: the remembered pool conversation was forgotten');
}

/** `1,234` — the numbers in the consent dialog are read by people, not parsed. */
function group(n: number): string {
    return n.toLocaleString('en-US');
}

/**
 * The consent dialog: what will be sent, where it goes, and what the agent may do when it gets there.
 *
 * A modal, because this is a decision about the developer's own code leaving the machine — and because the
 * alternative (a notification that can be missed and then auto-dismissed) would make "ask every time" a
 * formality rather than a gate.
 */
export async function askConsent(
    cfg: HandoffConfig,
    request: HandoffRequest,
    agent: AgentCandidate,
    verdict?: { message?: string }
): Promise<boolean> {
    const continueId = continueIdFor(cfg, agent, request.directory);
    const prompt = handoffPrompt({
        request: request.request,
        refused: request.refused ?? verdict?.message,
        facts: request.facts,
        target: request.target,
        resuming: Boolean(continueId)
    });
    // The disclosure has to be true of *this* agent — see the two helpers below, which is where that knowledge
    // lives so the dialog and the report cannot describe the same agent differently.
    const where = whereItGoes(cfg, request, agent);
    const detail = [
        request.refused ?? verdict?.message
            ? `Why it is not going to the local model: ${request.refused ?? verdict?.message}`
            : 'This request is being handed over deliberately.',
        '',
        `The agent: ${describeAgent(agent)}`,
        '',
        'What is sent:',
        '  • your request, as you wrote it',
        request.target ? `  • ${request.target.path}, in full` : '  • the facts the editor had about the file in focus',
        `  • about ${group(Math.ceil(prompt.length / 4))} tokens in total`,
        '',
        where,
        actionDisclosure(cfg, agent),
        continueId
            ? 'This continues the previous conversation, so the agent already knows what it did last time.'
            : 'This starts a new conversation.'
    ].join('\n');
    const pick = await vscode.window.showWarningMessage(
        `Hand this to ${agent.label}?`,
        { modal: true, detail },
        'Hand it over',
        'Cancel'
    );
    const yes = pick === 'Hand it over';
    log(`handoff: consent ${yes ? 'given' : 'declined'} for ${agent.id} (${group(prompt.length)} bytes of script)`);
    return yes;
}

/**
 * Hand a request to the pool agent and report what came back.
 *
 * The whole flow in one place, because both callers — the chat panel and the editor's implement/fix flows — must
 * behave identically: the same consent, the same scripted prompt, the same progress and the same report. When
 * there is nothing to hand off *to* (the setting is off, or `pool` is not installed) this returns a report that
 * says exactly that rather than throwing, since the callers are in the middle of warning the user already.
 */

/**
* Everyone who wants to hear that a hand-off finished.
*
* The chat surface is the listener, and the reason is that an answer which never becomes a conversation turn
* cannot be implemented: the buttons under an answer are built from the turn the extension *stores*. A hand-off
* starts in two different places — the chat's refusal button and the repair loop's last offer — and "put the
* answer in the conversation" written in both of them would be two rules to keep true, so the report is
* announced here, once, at the end of every hand-off (asked 2026-10-13: *"Can we equip it with the ability to
* generate diffs and on permission implement it?"*).
*/
const reportListeners: ((report: HandoffReport) => void)[] = [];

/** Registers a listener for finished hand-offs. */
export function onHandoffReport(listener: (report: HandoffReport) => void): void {
    reportListeners.push(listener);
}

/** Drops every listener — for a re-registered view, and for tests. */
export function forgetReportListeners(): void {
    reportListeners.length = 0;
}

/**
 * Runs a hand-off and tells the listeners what came back.
 *
 * The wrapper is what lets *every* caller be covered without any of them repeating the announcement. A listener
 * that throws is not allowed to break the hand-off: the report is the result, and the caller is waiting for it.
 */
export async function handOff(request: HandoffRequest): Promise<HandoffReport> {
    const report = await performHandOff(request);
    for (const listener of reportListeners) {
        try {
            listener(report);
        } catch (error) {
            logError(error);
        }
    }
    return report;
}
async function performHandOff(request: HandoffRequest): Promise<HandoffReport> {
    const cfg = handoffConfig();
    /** What every early return has in common: nothing was sent. */
    const nothing = { answer: '', full: '', work: [], promptTokens: 0, seconds: 0 };
    if (cfg.target === 'off') {
        return {
            kind: 'off',
            ok: false,
            ...nothing,
            message: 'The hand-off is switched off. Set "rustyPlatform.assistant.handoff" to `pool` to use it.'
        };
    }

    // WHICH agent, decided by what is on this machine (asked 2026-10-13): *"The system must scan the machine to
    // find and list all available API agents to allow the user to select the one to hand off to."* The scan is
    // cached, the choice is the user's when they have made one, and when nothing can run this says so rather
    // than failing at the end of a request.
    const candidates = await agentScan();
    const agent = chooseAgent(candidates, cfg.agentId);
    if (!agent) {
        const why = whyNoAgent(candidates);
        const pick = await vscode.window.showWarningMessage(why, 'Choose an agent…', 'Open the AI settings', 'Cancel');
        if (pick === 'Choose an agent…') void vscode.commands.executeCommand('rustyPlatform.assistant.chooseAgent');
        else if (pick === 'Open the AI settings') void vscode.commands.executeCommand('rustyPlatform.assistant.openSettings');
        return { kind: 'missing', ok: false, ...nothing, message: why };
    }

    if (!request.consented && !(await askConsent(cfg, request, agent))) {
        return { kind: 'declined', ok: false, ...nothing, message: 'Nothing was sent.' };
    }

    // An endpoint answers a prompt; it cannot work in the project. That is a different hand-off, and pretending
    // otherwise would be the extension telling the developer their files had been changed when they had not.
    if (agent.kind === 'openai') return askEndpoint(request, agent, nothing);
    // The Agnes Code CLI does work in the project, like pool, and has its own measured driver (`ai/jcode.ts`).
    // No `nothing` report is needed here: the run always comes back with its own record, even when it fails.
    if (agent.kind === 'jcode') return askJcode(request, agent);

    const continueId = continueIdFor(cfg, agent, request.directory);
    const script = handoffPrompt({
        request: request.request,
        refused: request.refused,
        facts: request.facts,
        target: request.target,
        resuming: Boolean(continueId)
    });
    const startedAt = Date.now();
    const controller = new AbortController();
    const command = agent.command ?? cfg.command;
    log(
        `handoff: sending ${script.length} bytes to ${agent.id} (${command})` +
        `${continueId ? ` (continuing ${continueId})` : ' (a new conversation)'}` +
        `${cfg.autoAllow ? ' with auto-allow' : ' without auto-allow'}`
    );

    const run: PoolRun = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `${agentShortName(agent)} is working on this project`,
            cancellable: true
        },
        async (progress, token) => {
            token.onCancellationRequested(() => controller.abort());
            return runPool({
                command,
                directory: request.directory,
                prompt: script,
                continueId,
                autoAllow: cfg.autoAllow,
                agent: cfg.agent || undefined,
                timeoutMs: cfg.timeoutSeconds * 1000,
                signal: controller.signal,
                onProgress: (line) => progress.report({ message: line })
            });
        }
    );

    const dir = await trajectoryDir(command);
    const runId = newestRunId(dir, startedAt);
    if (runId) await rememberRunId(runId);
    const report: HandoffReport = {
        kind: run.outcome.kind,
        ok: run.outcome.ok,
        agent: describeAgent(agent),
        agentName: agentShortName(agent),
        answer: run.record.final || run.record.answer,
        full: run.record.answer,
        // The `exit` call is the agent's bookkeeping, not work it did, so it is left out of the list.
        work: run.record.toolCalls.filter((call) => call.name !== 'exit').map(poolToolLine),
        message: run.outcome.message,
        runId,
        promptTokens: Math.ceil(script.length / 4),
        seconds: Math.round(run.ms / 1000),
        // Carried, not re-read: the report explains a run that has already happened.
        autoAllow: cfg.autoAllow
    };
    log(
        `handoff: ${report.kind} in ${report.seconds} s — ${report.work.length} step(s)` +
        `${runId ? `, run ${runId}` : ', no run id (the conversation cannot be continued)'}`
    );
    return report;
}

/**
 * Hands the request to the Agnes Code CLI (`jcode`), which works in the project the way pool does.
 *
 * The same shape as the pool path, for the same reasons, with two differences that come straight from the
 * measured contract (`ai/jcode.ts`):
 *
 *   - the prompt is this CLI's one positional argument, so it travels in `argv` rather than on stdin;
 *   - the session id arrives **in the run's own output** (`start` and `done`), so continuing a conversation needs
 *     no search afterwards. The saved session files are only the fallback for a window that has forgotten the id,
 *     and they are matched by the project each one records.
 */
async function askJcode(request: HandoffRequest, agent: AgentCandidate): Promise<HandoffReport> {
    const cfg = handoffConfig();
    const command = agent.command ?? cfg.jcodeCommand;
    const continueId = continueIdFor(cfg, agent, request.directory);
    const script = handoffPrompt({
        request: request.request,
        refused: request.refused,
        facts: request.facts,
        target: request.target,
        resuming: Boolean(continueId)
    });
    const controller = new AbortController();
    log(
        `handoff: sending ${script.length} bytes to ${agent.id} (${command})` +
        `${continueId ? ` (continuing ${continueId})` : ' (a new conversation)'}` +
        (cfg.jcodeProvider || cfg.jcodeModel
            ? ` as ${cfg.jcodeProvider || 'configured provider'}/${cfg.jcodeModel || 'configured model'}`
            : ' as jcode is configured')
    );

    const run: JcodeRun = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `${agentShortName(agent)} is working on this project`,
            cancellable: true
        },
        async (progress, token) => {
            token.onCancellationRequested(() => controller.abort());
            return runJcode({
                command,
                directory: request.directory,
                prompt: script,
                continueId,
                provider: cfg.jcodeProvider || undefined,
                model: cfg.jcodeModel || undefined,
                timeoutMs: cfg.timeoutSeconds * 1000,
                signal: controller.signal,
                onProgress: (line) => progress.report({ message: line })
            });
        }
    );

    // Remembered for the next hand-off. The id came out of the run itself, so there is nothing to look up.
    if (run.record.runId) await rememberJcodeSession(run.record.runId);
    const report: HandoffReport = {
        kind: run.outcome.kind,
        ok: run.outcome.ok,
        agent: describeAgent(agent),
        agentName: agentShortName(agent),
        answer: run.record.answer,
        // Every piece of prose it streamed, for the transcript: a run that died before `done` has narration and
        // no closing answer, and losing it would lose the only account of what it was doing.
        full: run.record.narration || run.record.answer,
        work: run.record.toolCalls.map(jcodeToolLine),
        message: run.outcome.message,
        runId: run.record.runId,
        // The run's own counts when it sent them, and the same `characters / 4` estimate as the pool path when it
        // did not — never a number invented to look precise.
        promptTokens: run.record.promptTokens || Math.ceil(script.length / 4),
        seconds: Math.round(run.ms / 1000)
    };
    log(
        `handoff: ${report.kind} in ${report.seconds} s — ${report.work.length} step(s), ` +
        `${report.promptTokens} prompt / ${run.record.completionTokens} answer tokens` +
        `${run.record.runId ? `, session ${run.record.runId}` : ', no session id (it cannot be continued)'}`
    );
    return report;
}

/**
 * Hands the request to an OpenAI-compatible endpoint, which answers but cannot act.
 *
 * The outcome is deliberately **not** `done`: nothing was written to the project, and a report that read like an
 * agent's would invite exactly the misreading this feature exists to avoid — a developer believing their files
 * had been changed when all that happened was a model answering. What comes back is the answer, in the
 * conversation, with its code available through the usual diff if it is wanted.
 *
 * The request is the same scripted prompt the agent gets, because it carries the facts the model cannot look up
 * for itself. What it does **not** carry is the promise of verification: an endpoint has no build to run, so the
 * prompt's "build it and fix what the compiler reports" is the developer's job in this path.
 */
async function askEndpoint(
    request: HandoffRequest,
    agent: AgentCandidate,
    nothing: { answer: string; full: string; work: string[]; promptTokens: number; seconds: number }
): Promise<HandoffReport> {
    const cfg = assistantConfig();
    const script = handoffPrompt({
        request: request.request,
        refused: request.refused,
        facts: request.facts,
        target: request.target
    });
    const startedAt = Date.now();
    log(`handoff: asking ${agent.id} (${agent.endpoint}) — ${Math.ceil(script.length / 4)} tokens`);
    const apiKey = await handoffKey(agent.endpoint ?? '');
    try {
        const outcome = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `${agent.label} is answering`, cancellable: true },
            async (progress, token) => {
                const controller = new AbortController();
                token.onCancellationRequested(() => controller.abort());
                return chatDetailed(
                    {
                        ...cfg,
                        backend: 'external',
                        endpoint: agent.endpoint ?? cfg.endpoint,
                        model: agent.model ?? cfg.model
                    },
                    [{ role: 'user', content: script }],
                    {
                        signal: controller.signal,
                        apiKey,
                        // No answer cap on a hand-off: the cloud agent's own limit is the only true one, and this
                        // is the request the local model could not fit (asked 2026-10-13).
                        omitMaxTokens: true,
                        onProgress: (info) => progress.report({ message: describeProgress(info) })
                    }
                );
            }
        );
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        const answer = outcome.text.trim();
        if (!answer) {
            return {
                kind: 'error',
                ok: false,
                agent: describeAgent(agent),
                ...nothing,
                message: describeEmptyAnswer(outcome.text, {
                    reasoningChars: outcome.reasoning.length,
                    reasoningTokens: outcome.reasoningTokens,
                    finishReason: outcome.finishReason
                })
            };
        }
        return {
            kind: 'answered',
            ok: true,
            agent: describeAgent(agent),
            agentName: agentShortName(agent),
            answer,
            full: answer,
            work: [],
            message: `${agent.label} answered. It cannot change your project, so nothing was written.`,
            promptTokens: Math.ceil(script.length / 4),
            seconds
        };
    } catch (error) {
        logError(error);
        return {
            kind: 'error',
            ok: false,
            agent: describeAgent(agent),
            ...nothing,
            message: `${agent.label} could not be reached: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * The report as the transcript of a run, for a caller that has nowhere else to put it.
 *
 * No `cfg` parameter. The one setting this used to read was pool's auto-allow, and reading a *setting* to explain
 * a run that already happened is wrong twice: it would let a later settings change rewrite history, and it says
 * nothing about the two other kinds of agent. The fact travels on the report instead (`report.autoAllow`, set
 * only where such a switch exists).
 */
export function reportText(report: HandoffReport): string {
    const lines = [`**${report.agentName ?? 'the agent'}** — ${report.message}`, ''];
    if (report.work.length) {
        lines.push(`What it did (${report.work.length} step${report.work.length === 1 ? '' : 's'}):`, '');
        for (const step of report.work.slice(0, 40)) lines.push(`- \`${step}\``);
        if (report.work.length > 40) lines.push(`- …and ${report.work.length - 40} more (see the AI log)`);
        lines.push('');
    }
    if (report.answer) lines.push(report.answer, '');
    if (report.kind === 'answered') {
        lines.push(
            `That came from ${report.agent ?? 'an endpoint'}. Nothing in your project was changed — if the answer` +
            ' contains code you want, apply it as a proposal so you can see the diff first.'
        );
        return lines.join('\n');
    }
    if (report.kind === 'done') {
        lines.push(
            `It worked in your project for ${report.seconds} s. Build it and see for yourself — the agent says it` +
            ' verified the change, and a compiler is the only thing that can confirm that.' +
            // Only pool has an auto-allow switch, so only a pool report can be affected by it being off.
            `${report.autoAllow === false ? ' Note: with auto-allow off, it may not have been able to change anything.' : ''}`
        );
    }
    return lines.join('\n');
}
