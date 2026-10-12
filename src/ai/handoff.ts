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

import * as vscode from 'vscode';
import { log } from './log';
import { configView } from './settings';
import { extensionContext } from './runtime';
import {
    handoffPrompt,
    newestRunId,
    normalizeHandoff,
    poolToolLine,
    poolVersion,
    runPool,
    trajectoryDir,
    type HandoffConfig,
    type PoolOutcome,
    type PoolRun
} from './pool';

export const SETTINGS = 'rustyPlatform.assistant';

/** The hand-off settings as they are configured right now. */
export function handoffConfig(): HandoffConfig {
    const raw = configView(SETTINGS);
    return normalizeHandoff({
        handoff: raw.get('handoff'),
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

/** Forget the probed version — for the settings panel, when the command may have just changed. */
export function forgetPoolStatus(): void {
    probed = undefined;
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
    kind: PoolOutcome['kind'] | 'declined' | 'off';
    ok: boolean;
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
    verdict?: { message?: string }
): Promise<boolean> {
    const prompt = handoffPrompt({
        request: request.request,
        refused: request.refused ?? verdict?.message,
        facts: request.facts,
        target: request.target,
        resuming: cfg.resume && Boolean(lastRunId())
    });
    const detail = [
        request.refused ?? verdict?.message
            ? `Why it is not going to the local model: ${request.refused ?? verdict?.message}`
            : 'This request is being handed over deliberately.',
        '',
        'What is sent to pool:',
        `  • your request, as you wrote it`,
        request.target ? `  • ${request.target.path}, in full` : '  • the facts the editor had about the file in focus',
        `  • about ${group(Math.ceil(prompt.length / 4))} tokens in total`,
        '',
        `Where it goes: the agent runs in ${request.directory}, and answers come from Poolside's own service`,
        '(the API in your pool configuration), not from this machine.',
        cfg.autoAllow
            ? 'The agent may use its tools — editing files and running commands — without asking you first.'
            : 'The agent will not be allowed to act without approval, so a run that needs to edit a file may stop.',
        cfg.resume && lastRunId()
            ? 'This continues the previous conversation, so the agent already knows what it did last time.'
            : 'This starts a new conversation.'
    ].join('\n');
    const pick = await vscode.window.showWarningMessage(
        'Hand this to the pool agent?',
        { modal: true, detail },
        'Hand off to pool',
        'Cancel'
    );
    const yes = pick === 'Hand off to pool';
    log(`handoff: consent ${yes ? 'given' : 'declined'} (${group(prompt.length)} bytes of script)`);
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
export async function handOff(request: HandoffRequest): Promise<HandoffReport> {
    const cfg = handoffConfig();
    if (cfg.target === 'off') {
        return {
            kind: 'off',
            ok: false,
            answer: '',
            full: '',
            work: [],
            message: 'The hand-off is switched off. Set "rustyPlatform.assistant.handoff" to `pool` to use it.',
            promptTokens: 0,
            seconds: 0
        };
    }
    if (!(await poolStatus(cfg.command))) {
        const pick = await vscode.window.showWarningMessage(
            `The \`${cfg.command}\` command was not found, so nothing can be handed off.`,
            'Open the AI settings',
            'Cancel'
        );
        if (pick === 'Open the AI settings') void vscode.commands.executeCommand('rustyPlatform.assistant.openPanel');
        return {
            kind: 'missing',
            ok: false,
            answer: '',
            full: '',
            work: [],
            message: `The \`${cfg.command}\` command was not found — install the Poolside CLI and run \`pool login\`.`,
            promptTokens: 0,
            seconds: 0
        };
    }
    if (!request.consented && !(await askConsent(cfg, request))) {
        return {
            kind: 'declined',
            ok: false,
            answer: '',
            full: '',
            work: [],
            message: 'Nothing was sent.',
            promptTokens: 0,
            seconds: 0
        };
    }

    const continueId = cfg.resume ? lastRunId() : undefined;
    const script = handoffPrompt({
        request: request.request,
        refused: request.refused,
        facts: request.facts,
        target: request.target,
        resuming: Boolean(continueId)
    });
    const startedAt = Date.now();
    const controller = new AbortController();
    log(
        `handoff: sending ${script.length} bytes to ${cfg.command}` +
        `${continueId ? ` (continuing ${continueId})` : ' (a new conversation)'}` +
        `${cfg.autoAllow ? ' with auto-allow' : ' without auto-allow'}`
    );

    const run: PoolRun = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'The pool agent is working on this project',
            cancellable: true
        },
        async (progress, token) => {
            token.onCancellationRequested(() => controller.abort());
            return runPool({
                command: cfg.command,
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

    const dir = await trajectoryDir(cfg.command);
    const runId = newestRunId(dir, startedAt);
    if (runId) await rememberRunId(runId);
    const report: HandoffReport = {
        kind: run.outcome.kind,
        ok: run.outcome.ok,
        answer: run.record.final || run.record.answer,
        full: run.record.answer,
        // The `exit` call is the agent's bookkeeping, not work it did, so it is left out of the list.
        work: run.record.toolCalls.filter((call) => call.name !== 'exit').map(poolToolLine),
        message: run.outcome.message,
        runId,
        promptTokens: Math.ceil(script.length / 4),
        seconds: Math.round(run.ms / 1000)
    };
    log(
        `handoff: ${report.kind} in ${report.seconds} s — ${report.work.length} step(s)` +
        `${runId ? `, run ${runId}` : ', no run id (the conversation cannot be continued)'}`
    );
    return report;
}

/** The report as the transcript of a run, for a caller that has nowhere else to put it. */
export function reportText(report: HandoffReport, cfg = handoffConfig()): string {
    const lines = [`**pool** — ${report.message}`, ''];
    if (report.work.length) {
        lines.push(`What it did (${report.work.length} step${report.work.length === 1 ? '' : 's'}):`, '');
        for (const step of report.work.slice(0, 40)) lines.push(`- \`${step}\``);
        if (report.work.length > 40) lines.push(`- …and ${report.work.length - 40} more (see the AI log)`);
        lines.push('');
    }
    if (report.answer) lines.push(report.answer, '');
    if (report.kind === 'done') {
        lines.push(
            `It worked in your project for ${report.seconds} s. Build it and see for yourself — the agent says it` +
            ' verified the change, and a compiler is the only thing that can confirm that.' +
            `${cfg.autoAllow ? '' : ' Note: with auto-allow off, it may not have been able to change anything.'}`
        );
    }
    return lines.join('\n');
}
