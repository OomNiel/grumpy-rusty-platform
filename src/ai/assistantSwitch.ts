/**
 * The AI Assistant's on/off switch: the doing half of `assistantSwitchPlan.ts`.
 *
 * OFF — the default — means what it says: every model that can be named is unloaded and the `llama-server`
 * serving the configured endpoint is stopped, whether this window started it or not. The one deference to
 * other people's work is the consent rule: a server this window did **not** start is stopped only after the
 * user is told exactly what it is and what stopping it costs, and that answer is remembered for the rest of
 * the window (either way — a "leave it" must not turn into the same question at every reload).
 *
 * ON starts what the settings say to start, and asks nothing it can work out for itself: a server already
 * answering the endpoint is adopted, the configured unit is started, and the bundled runtime is started with
 * the model the settings already name. Only a completely unpinned setup falls back to the model picker,
 * because there is genuinely nothing to start.
 *
 * The three entry points are the switch (`toggleAssistant`), the palette command, and the startup check
 * (`enforceOffAtStartup`) that a window runs once when it opens with the switch off.
 */

import * as vscode from 'vscode';
import type { AssistantConfig } from './assistant';
import { assistantConfig, refreshPanels } from './editor';
import { log, logError } from './log';
import { chooseLocalModel } from './localModelSetup';
import { findLmsCli, loadedNow, unloadAll } from './localModelCore';
import {
    findRunningLlamaServer,
    forgetRunningProbe,
    knownOwnServerModelPath,
    ownLlamaServerStatus,
    startMyLlamaServerFlow,
    startOwnLlamaServer,
    stopOwnLlamaServer,
    useRunningLlamaServer
} from './llamaServer';
import {
    detectServerOwner,
    disableLlamaUnit,
    forgetOwnerCache,
    resolveLlamaUnit,
    startLlamaServerByChoice,
    startTarget,
    stopLlamaServerConfirmed,
    type ServerOwner
} from './llamaService';
import { configView } from './settings';
import {
    describeOffStep,
    disableOfferFor,
    offPlan,
    startupShouldStop,
    type OffFacts,
    type EndpointOwner,
    type OffStep
} from './assistantSwitchPlan';

const SETTINGS = 'rustyPlatform.assistant';

/**
 * What the user has decided about foreign servers **in this window**.
 *
 * `true` = may stop it without asking again; `false` = leave it, and do not ask again. Session-scoped on
 * purpose: consent to stop a process is about the process that is running now, and a fresh window has to ask
 * again because the machine may be in a different state by then.
 */
const decided = new Map<string, boolean>();

/** Forgets every consent decision. Exported for the tests and for a window that wants to ask again. */
export function forgetOffDecisions(): void {
    decided.clear();
}

/** The stop flow's own owner type, narrowed to what the plan needs. */
function toEndpointOwner(owner: ServerOwner): EndpointOwner {
    switch (owner.kind) {
        case 'ours':
            return { kind: 'ours', pid: owner.pid, model: owner.model };
        case 'unit':
            return { kind: 'unit', unit: owner.unit, scope: owner.scope, pid: owner.pid, enabled: owner.enabled };
        case 'process':
            return { kind: 'process', pid: owner.pid, command: owner.command };
        case 'unknown':
            return { kind: 'unknown', why: owner.why };
        case 'none':
            return { kind: 'none' };
        default:
            return { kind: 'none' };
    }
}

/** Reads the machine: which models are held, whether we have a server of our own, and who answers. */
async function gatherOffFacts(cfg: AssistantConfig): Promise<{ facts: OffFacts; owner: ServerOwner }> {
    const own = ownLlamaServerStatus();
    const owner = await detectServerOwner({ endpoint: cfg.endpoint });
    const cli = findLmsCli();
    // `probeCli: false`: turning the assistant off must never be what starts LM Studio's service.
    const loaded = cli ? await loadedNow(cli, { probeCli: false }) : { known: true, ids: [] };
    return {
        facts: {
            // Only a *known* answer is used: "we could not tell" must not become "nothing to unload", nor
            // an invented list of things to unload.
            loadedModelIds: loaded.known ? loaded.ids : [],
            ownServer: own.running,
            owner: toEndpointOwner(owner)
        },
        owner
    };
}

/** One sentence for the dialog and the report: what it is, and what stopping it costs. */
function consequenceOf(owner: EndpointOwner): string {
    switch (owner.kind) {
        case 'unit':
            return `systemctl --user stop ${owner.unit}`
                + (owner.enabled === true ? ' — the unit is enabled, so it comes back at your next login' : '');
        case 'process':
            return `the process holding the port${owner.command ? ` (${owner.command})` : ''} is asked to exit`;
        default:
            return 'it is stopped';
    }
}

/**
 * Runs the off plan: unloads the models, stops what may be stopped, and says what happened.
 *
 * Returns the human summary, so the switch can put it in the panel and the startup path can log it. Nothing
 * here is silent: a step that was skipped is reported with the reason, which is the difference between "the
 * assistant is off" and "the assistant is off and something is still holding four gigabytes".
 */
export async function turnAssistantOff(opts: { reason?: string } = {}): Promise<string> {
    const cfg = assistantConfig();
    const { facts } = await gatherOffFacts(cfg);
    const steps = offPlan(facts, decided);
    const done: string[] = [];
    const skipped: string[] = [];

    for (const step of steps) {
        try {
            switch (step.kind) {
                case 'unloadModels': {
                    const cli = findLmsCli();
                    if (!cli) {
                        skipped.push('LM Studio is not installed, so there was nothing to unload');
                        break;
                    }
                    const result = await unloadAll(cli);
                    if (result.ok) {
                        done.push(`unloaded ${step.modelIds.length} model${step.modelIds.length === 1 ? '' : 's'}`);
                    } else {
                        skipped.push(`could not unload the models: ${result.message ?? 'unknown reason'}`);
                    }
                    break;
                }
                case 'stopOwn': {
                    const stopped = stopOwnLlamaServer();
                    forgetRunningProbe();
                    if (stopped) done.push('stopped the server this window started');
                    else skipped.push('the server this window started was already gone');
                    break;
                }
                case 'stopForeign': {
                    const offer = disableOfferFor(step);
                    const consent = await askToStopForeign(step, offer);
                    if (consent === 'leave') {
                        skipped.push(`left ${describeForeign(step.owner)} running (you chose to)`);
                        break;
                    }
                    // The stop flow asks again by default; consent was just given here, so it is told not to.
                    const outcome = await stopLlamaServerConfirmed({
                        endpoint: cfg.endpoint,
                        confirm: async () => 'Stop it'
                    });
                    forgetOwnerCache();
                    forgetRunningProbe();
                    if (outcome.ok) done.push(outcome.message);
                    else skipped.push(outcome.message);
                    if (consent === 'disable' && offer !== undefined) {
                        // Both halves of what the button says, and the disable is reported whatever the stop did:
                        // taking it out of the login target is the part that survives this window.
                        const disabled = await disableLlamaUnit(offer.unit);
                        if (disabled.ok) done.push(disabled.message);
                        else skipped.push(disabled.message);
                    }
                    break;
                }
                case 'cannotStop': {
                    skipped.push(step.reason);
                    break;
                }
                default:
                    break;
            }
        } catch (error) {
            logError(error);
            skipped.push(`${describeOffStep(step)} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    const summary = describeOutcome(done, skipped, opts.reason);
    log(`assistant: ${summary}`);
    await refreshPanels();
    return summary;
}

/** What the thing is, in the words the stop flow itself uses, for the consent dialog. */
function whatItIs(owner: EndpointOwner): string {
    if (owner.kind === 'unit') {
        return `${owner.unit} — systemd ${owner.scope} unit`
            + `${owner.pid ? `, pid ${owner.pid}` : ''}`
            + (owner.enabled === true ? ', enabled at login' : '');
    }
    if (owner.kind === 'process') {
        return `a process started outside systemd`
            + `${owner.pid ? ` (pid ${owner.pid})` : ''}`
            + `${owner.command ? ` — ${owner.command}` : ''}`;
    }
    return 'a server';
}

/** A short name for a foreign owner inside a sentence. */
function describeForeign(owner: EndpointOwner): string {
    return owner.kind === 'unit' ? `${owner.unit}` : owner.kind === 'process' ? `the process on the port` : 'a server';
}

/**
 * Asks about one foreign server, once per window, and remembers the answer.
 *
 * "Stop asking at startup" is offered as a third choice because the question exists to protect work this
 * window does not own, and someone who has read it once does not need it at every launch — the panel has the
 * same option as a checkbox, and the dialog points at it rather than hiding it in the settings JSON.
 */
async function askToStopForeign(
    step: Extract<OffStep, { kind: 'stopForeign' }>,
    // The third button, computed by the caller from the same step so that the button and the action it takes
    // cannot disagree. It exists only where there is something to undo — an enabled user unit that follows the
    // login target. A server that reserves gigabytes while it is idle is the case for it (asked 2026-10-09):
    // "Stop it" ends this run, and this ends the question.
    offer: { unit: string; label: string } | undefined
): Promise<'stop' | 'leave' | 'disable'> {
    if (step.needsConsent === false) {
        return decided.get(step.key) === true ? 'stop' : 'leave';
    }
    const buttons = ['Stop it', 'Leave it running'];
    if (offer !== undefined) {
        buttons.push(offer.label);
    }
    buttons.push('Stop asking at startup');
    const pick = await vscode.window.showWarningMessage(
        `Turn the AI assistant off and stop ${describeForeign(step.owner)}?\n\n`
            + `${whatItIs(step.owner)}\n`
            + `Stopping it: ${consequenceOf(step.owner)}.\n\n`
            + (offer === undefined
                ? ''
                : `Disabling it stops it now and takes ${offer.unit} out of your login target, so it will not `
                    + 'start by itself again. The assistant can still start it on demand when it is on.\n\n')
            + 'This window did not start it, so it asks once. The answer is remembered until the window closes.',
        { modal: true },
        ...buttons
    );
    if (pick === 'Stop asking at startup') {
        decided.set(step.key, false);
        await configView(SETTINGS).update('stopServersAtStartup', false);
        return 'leave';
    }
    if (offer !== undefined && pick === offer.label) {
        // Stopping is part of it, so the same consent covers both: the caller stops it, then disables it.
        decided.set(step.key, true);
        return 'disable';
    }
    if (pick === 'Stop it') {
        decided.set(step.key, true);
        return 'stop';
    }
    // "Leave it running", or the dialog was dismissed: the answer is no for this window, and it is not asked
    // again — a question that comes back after the user answered it is a nag, not a safeguard.
    decided.set(step.key, false);
    return 'leave';
}

/** The line the panel and the log show after an off. */
function describeOutcome(done: readonly string[], skipped: readonly string[], reason?: string): string {
    const head = reason === 'startup' ? 'AI assist is off — nothing was started.' : 'AI assist is off.';
    const parts: string[] = [head];
    if (done.length > 0) parts.push(`Done: ${done.join('; ')}.`);
    if (skipped.length > 0) parts.push(`Left alone: ${skipped.join('; ')}.`);
    else if (done.length === 0) parts.push('Nothing was running, so there was nothing to stop.');
    return parts.join(' ');
}

/**
 * Turns the assistant on: the switch's other position.
 *
 * Answers the question the switch raises — "on *what*?" — from the settings first, and only asks when they
 * cannot: a server already answering is adopted as-is, a pinned model is started on the bundled runtime, the
 * configured unit is started for an external backend, and a completely unpinned setup opens the model picker,
 * because starting nothing and calling that "on" would be a lie.
 */
export async function turnAssistantOn(context: vscode.ExtensionContext): Promise<boolean> {
    const cfg = configView(SETTINGS);
    if (assistantConfig().backend === 'off') {
        // Nothing is pinned: the picker both chooses a model and writes the backend it belongs to.
        await chooseLocalModel(context);
        if (assistantConfig().backend === 'off') {
            log('assistant: switch-on cancelled — no backend was chosen');
            return false;
        }
    }

    const current = assistantConfig();
    const already = await findRunningLlamaServer(current.endpoint);
    if (already) {
        const outcome = await useRunningLlamaServer(already);
        if (outcome.ok) return await finishOn(cfg, outcome.message);
    }

    if (current.backend === 'bundled') {
        const modelPath = current.modelPath !== '' ? current.modelPath : knownOwnServerModelPath(context);
        if (modelPath === undefined || modelPath === '') {
            // Nothing pinned: the interactive flow is the only thing that can answer which weights to load.
            const started = await startMyLlamaServerFlow(context);
            return started ? await finishOn(cfg, 'The local runtime is up.') : false;
        }
        const outcome = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Starting the local runtime…', cancellable: false },
            async (progress) =>
                await startOwnLlamaServer({
                    modelPath,
                    contextLength: current.contextSize,
                    gpu: current.gpuLayers > 0 ? 'max' : 'off',
                    threads: current.threads,
                    extraArgs: configView(SETTINGS).get<string>('llamaServerArgs', ''),
                    reuseRunning: true,
                    onProgress: (message) => progress.report({ message })
                })
        );
        return outcome.ok ? await finishOn(cfg, outcome.message) : await failOn(outcome.message);
    }

    // External: a server the user runs. Nothing is answering, so the only honest thing to start is a
    // llama-server *they* have — normally a systemd unit. Without one this must not invent a server: the
    // endpoint may be LM Studio's, and starting a llama-server nobody asked for is not what "on" means.
    const unit = await resolveLlamaUnit();
    if (unit.unit === undefined && unit.candidates.length === 0) {
        return await failOn(
            `Nothing is answering ${current.endpoint}, and no llama-server was found to start (${unit.why ?? 'no unit found'}). `
                + 'Start your server — or use "AI: Start My llama-server…" — and turn the assistant on again.'
        );
    }
    const outcome = await startLlamaServerByChoice(startTarget());
    if (outcome.ok) return await finishOn(cfg, outcome.message);
    return await failOn(
        `${outcome.message} Start it, or choose a different backend, then turn the assistant on again.`
    );
}

async function finishOn(cfg: vscode.WorkspaceConfiguration, message?: string): Promise<boolean> {
    await cfg.update('enabled', true);
    log(`assistant: switched on${message ? ` — ${message}` : ''}`);
    await refreshPanels();
    return true;
}

async function failOn(message?: string): Promise<boolean> {
    const text = message ?? 'The assistant could not be started.';
    void vscode.window.showWarningMessage(text);
    log(`assistant: switch-on failed — ${text}`);
    await refreshPanels();
    return false;
}

/** The switch itself: on becomes off and off becomes on, with the work each direction implies. */
export async function toggleAssistant(context: vscode.ExtensionContext): Promise<void> {
    const cfg = configView(SETTINGS);
    const on = assistantConfig().enabled;
    if (on) {
        await cfg.update('enabled', false);
        void vscode.window.setStatusBarMessage('AI assist off — unloading and stopping…', 4000);
        const summary = await turnAssistantOff();
        void vscode.window.showInformationMessage(summary);
        return;
    }
    const started = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Turning the AI assistant on…', cancellable: false },
        async () => await turnAssistantOn(context)
    );
    void vscode.window.showInformationMessage(
        started
            ? 'AI assist is on — the model is loaded and answering.'
            : 'AI assist is still off — nothing could be started.'
    );
}

/**
 * A window that opens with the switch off enforces it, when the option says so.
 *
 * Run once at activation, and deliberately *not* awaited: it can put a question on screen (about a server the
 * window did not start), and activation must not stop for that.
 */
export async function enforceOffAtStartup(): Promise<void> {
    const cfg = assistantConfig();
    if (!startupShouldStop(cfg)) {
        return;
    }
    const { facts } = await gatherOffFacts(cfg);
    if (facts.loadedModelIds.length === 0 && facts.ownServer === false && facts.owner.kind === 'none') {
        // Nothing to enforce: no model is held and nothing answers. Not worth a word in the log.
        return;
    }
    log('assistant: the switch is off and this window enforces that at startup');
    await turnAssistantOff({ reason: 'startup' });
}

/** The palette entry, so the switch can be bound to a key or reached without the panel. */
export function registerAssistantSwitchCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
    return [vscode.commands.registerCommand('rustyPlatform.assistant.toggle', () => toggleAssistant(context))];
}
