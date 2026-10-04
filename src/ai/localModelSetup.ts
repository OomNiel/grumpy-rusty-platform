/* The Command Palette front door for local models: the same operations the designer's ⚙ Code Fix/AI-Assist Settings panel
 * offers, asked for with quick picks and reported with notifications.
 *
 * WHAT THE SETUP REPLACES (2026-09-15). Doing it by hand meant knowing five things a developer should not
 * have to know: which port LM Studio serves on, the exact model id to pin, a context length, an offload
 * ratio, and that `Keep Model in Memory` has to be off because the kernel's lock limit is smaller than the
 * model. The user called that "way too complicated for a novice" and asked for a dropdown — this is that
 * dropdown, as a command (VS Code settings cannot enumerate models: `enum` is baked into the manifest at
 * build time).
 *
 * All the mechanics live in `localModelCore.ts` (NOTES.md §100–§101): `lms ls` for what is on disk, the
 * REST API's `state` for what is loaded, `lms server status` for the port, `--estimate-only` for what a
 * load would cost *before* paying it, and the newest server log to translate a failure. The two front
 * doors share them; this file only asks the questions and reports the answers.
 */

import * as vscode from 'vscode';
import { chatDetailed, describeEmptyAnswer, normalizeAssistantConfig } from './assistant';
import { refreshPanels } from './editor';
import { configView } from './settings';
import { log } from './log';
import { setupBundledModel, useModelFile } from './runtime';
import {
    chatModels,
    discover,
    findLmsCli,
    scanForModelFiles,
    load,
    setupFacts,
    unloadAll,
    type Discovery
} from './localModelCore';
import {
    filesOfferedForSelection,
    modelLabel,
    recommendedLoadOptions,
    type LoadOptions,
    type LocalModel,
    type SetupFacts
} from './localModels';

const SETTINGS = 'rustyPlatform.assistant';

/** The models a developer could pick, with the kind the REST API reported folded in. */
function modelsOf(found: Discovery): LocalModel[] {
    return chatModels(found);
}

/** "AI: Choose a Local Model…" — the whole setup, with two confirmations and no jargon. */
export async function chooseLocalModel(context: vscode.ExtensionContext): Promise<void> {
    // The wait is announced, not left to look like a dead button. Two things happen before one word of the
    // picker can be built: `setupFacts()` reads the machine, and `discover()` asks LM Studio's `lms` helper —
    // whose FIRST call of a session also starts LM Studio's service, measured at ~4.3 s (see `localModelCore`
    // and NOTES). Reported 2026-10-04: "the system takes a while to present the picker dialog, causing the
    // user to wonder if something is happening".
    //
    // The notification is deliberately not cancellable: the work is a handful of CLI calls that a cancel
    // could not stop, and a Cancel button that does nothing is worse than no button.
    const prepared = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Looking for local models…',
            cancellable: false
        },
        async (progress) => {
            progress.report({ message: 'asking LM Studio and checking this machine — the first check can take a few seconds…' });
            const facts = setupFacts();
            const found = await discover();
            // A machine can have models and no working LM Studio at all: the `lms` binary present but its
            // daemon refusing to start leaves `found.list` empty while `~/.lmstudio/models` is full. The scan
            // is the answer to "but they are right there on my disk" (reported 2026-10-04).
            progress.report({ message: 'looking for .gguf files already on this machine…' });
            const files = await scanForModelFiles({ onProgress: (message) => progress.report({ message }) });
            return { facts, found, files };
        }
    );
    const { facts, found, files } = prepared;
    const items: (vscode.QuickPickItem & {
        model?: LocalModel;
        action?: 'bundled' | 'custom' | 'llama' | 'file';
        file?: string;
    })[] = [];

    for (const model of modelsOf(found)) {
        const loaded = found.loaded.some((id) => id === model.key || id.endsWith(model.key));
        items.push({
            label: `${loaded ? '$(circle-filled) ' : '$(circle-outline) '}${modelLabel(model)}`,
            description: loaded ? 'loaded' : '',
            detail: `LM Studio · ${model.arch}${loaded ? ' · already in memory' : ''}`,
            model
        });
    }

    // The model files already on this machine, so "use the one I have" does not require knowing where the
    // file browser starts. Capped: a picker is not a directory listing, and the panel has the full list.
    for (const file of filesOfferedForSelection(files, found.list.chat.length > 0).slice(0, 25)) {
        items.push({
            label: `$(file) ${file.name}`,
            description: `${file.sizeGb.toFixed(1)} GB`,
            detail: `${file.inLmStudio ? 'inside LM Studio\'s folder' : 'found on this machine'} · ${file.folder}`
                + ' · runs on the extension\'s own runtime',
            action: 'file',
            file: file.file
        });
    }

    items.push({
        label: '$(package) This extension\'s own model',
        description: 'no LM Studio needed',
        detail: 'Downloads a code-specialised 3B/7B model once and runs it locally',
        action: 'bundled'
    });
    // The user's own llama.cpp server (asked 2026-09-16). Offered here as well as in its own command because
    // this is the picker a developer opens when they want "a local model", and their own binary is often the
    // fastest of the three engines. Since 2026-10-04 it is also the one entry that sets itself up: the command
    // offers to install llama.cpp when the machine has none, and to fetch the known 27B when that is missing.
    items.push({
        label: '$(server-process) My own llama-server',
        description: 'llama.cpp you have installed',
        detail: 'Starts your own llama-server and loads the weights for you — installs llama.cpp and downloads '
            + 'the 27B model if this machine does not have them yet',
        action: 'llama'
    });
    items.push({
        label: '$(globe) A server I run myself',
        description: 'any OpenAI-compatible address',
        detail: 'Ollama, llama.cpp or anything else already running on this machine',
        action: 'custom'
    });

    const pick = await vscode.window.showQuickPick(items, {
        title: 'Which local model should write the code?',
        placeHolder: found.cli
            ? `LM Studio found · ${found.list.chat.length} chat model(s) on disk · ${facts.freeRamGb.toFixed(0)} GB RAM free`
            : 'LM Studio is not installed — its own model needs nothing but the .NET SDK',
        ignoreFocusOut: true,
        matchOnDetail: true
    });
    if (!pick) return;

    if (pick.action === 'bundled') {
        await setupBundledModel(context);
        // The built-in path changes `backend`/`modelPath` just like the others, and it returns early — without
        // this, loading the extension's own model from the palette left an open panel naming the old one
        // (reported 2026-09-15).
        void refreshPanels();
        return;
    }
    if (pick.action === 'file') {
        const file = (pick as { file?: string }).file;
        if (!file) return;
        await useModelFile(context, file);
        void refreshPanels();
        return;
    }
    if (pick.action === 'custom') {
        await askForEndpoint();
        void refreshPanels();
        return;
    }
    if (pick.action === 'llama') {
        // Runs the shared command instead of importing the flow: the process and its own file picker live in
        // `llamaServer.ts`, and the command is registered by then (this picker only runs after activation).
        await vscode.commands.executeCommand('rustyPlatform.assistant.startLlamaServer');
        return;
    }

    const model = pick.model;
    if (!model || !found.cli) return;
    await setUpLmStudioModel(model, facts, found);
}

/** Recommended values, one confirmation, with everything visible that a novice is trusting us with. */
async function askLoadOptions(model: LocalModel, facts: SetupFacts): Promise<LoadOptions | undefined> {
    const recommended = recommendedLoadOptions(model, facts);
    const detail = recommended.reasons.join('\n');
    const pick = await vscode.window.showQuickPick(
        [
            { label: '$(check) Use the recommended settings', detail, use: true },
            { label: '$(settings-gear) Change them…', detail: 'Context length, GPU offload, when to unload', use: false }
        ],
        { title: `${model.label} — how should it run?`, ignoreFocusOut: true }
    );
    if (!pick) return undefined;
    if (pick.use) return recommended;

    const context = await vscode.window.showInputBox({
        title: 'Context length (tokens)',
        value: String(recommended.contextLength),
        prompt: 'How much text the model can hold at once. Bigger costs memory.',
        validateInput: (v) => (/^\d{3,7}$/.test(v.trim()) ? undefined : 'A number, e.g. 8192')
    });
    if (!context) return undefined;
    const gpu = await vscode.window.showQuickPick(
        [
            { label: 'off', detail: 'CPU only — safest, and usually faster on a shared-memory GPU' },
            { label: 'max', detail: 'Push everything to the GPU' },
            { label: '0.5', detail: 'Half of the layers on the GPU' }
        ],
        { title: 'GPU offload', ignoreFocusOut: true }
    );
    if (!gpu) return undefined;
    const ttl = await vscode.window.showQuickPick(
        [
            { label: '15 minutes', detail: 'Frees the memory when you stop working', seconds: 900 },
            { label: '1 hour', detail: '', seconds: 3600 },
            { label: 'keep loaded', detail: 'Never unload automatically', seconds: 0 }
        ],
        { title: 'Unload the model when idle for…', ignoreFocusOut: true }
    );
    if (!ttl) return undefined;
    return { ...recommended, contextLength: Number(context), gpu: gpu.label, ttlSeconds: ttl.seconds };
}

async function setUpLmStudioModel(model: LocalModel, facts: SetupFacts, found: Discovery): Promise<void> {
    const options = await askLoadOptions(model, facts);
    if (!options) return;

    const report = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Loading ${model.label}…`, cancellable: false },
        async (progress) =>
            load({
                model,
                options,
                facts,
                server: found.server,
                onProgress: (message) => progress.report({ message }),
                confirmOverBudget: async (estimate) => {
                    const answer = await vscode.window.showWarningMessage(
                        `${model.label} needs about ${estimate.totalGiB.toFixed(1)} GB and only ${facts.freeRamGb.toFixed(1)} GB is free. `
                        + 'Loading it may push the machine into swap.',
                        { modal: true },
                        'Load anyway',
                        'Cancel'
                    );
                    return answer === 'Load anyway';
                }
            })
    );
    if (report.cancelled) return;
    if (!report.ok || !report.endpoint) {
        const pick = await vscode.window.showErrorMessage(
            `Loading ${model.label} failed. ${report.message ?? ''}`,
            'Copy details',
            'Show status'
        );
        if (pick === 'Copy details') {
            await vscode.env.clipboard.writeText(`lms load failed\n${report.message ?? ''}\n\n${report.logTail ?? ''}`);
        }
        if (pick === 'Show status') await vscode.commands.executeCommand('rustyPlatform.assistant.status');
        return;
    }

    await wireSettings(report.endpoint, options.identifier);

    // Prove it before the user touches code.
    const proof = await proveItWorks();
    const raised = proof.raisedBudget
        ? ` It thinks before it answers, so the answer budget was raised to ${proof.raisedBudget}`
        + `${proof.thinkingTokens ? ` (it spent ${proof.thinkingTokens} tokens thinking about a one-word reply)` : ''}.`
        : '';
    const pick = await vscode.window.showInformationMessage(
        proof.ok
            ? `Ready — ${model.label} is answering on ${report.endpoint}.${raised} Try "AI: Implement in Function…" in a code-behind file.`
            : `The model is loaded on ${report.endpoint}, but the test request came back empty. ${proof.why ?? ''}`
            + ' Try "AI: Status and Hardware Check".',
        'Show status',
        'OK'
    );
    if (pick === 'Show status') await vscode.commands.executeCommand('rustyPlatform.assistant.status');

    // An open designer panel has to hear about this: the model just changed under it, and it is the panel — not
    // the notification — that the user looks at next (reported 2026-09-15).
    void refreshPanels();
}

/**
 * Writes the three settings that make the feature work.
 *
 * Shared with the designer's ⚙ Code Fix/AI-Assist Settings panel, which performs exactly this step after a successful load
 * — one implementation, so the two front doors cannot end up pointing at different addresses.
 */
export async function wireSettings(endpoint: string, modelIdentifier: string): Promise<void> {
    const cfg = configView(SETTINGS);
    await cfg.update('backend', 'external', vscode.ConfigurationTarget.Global);
    await cfg.update('endpoint', endpoint, vscode.ConfigurationTarget.Global);
    await cfg.update('model', modelIdentifier, vscode.ConfigurationTarget.Global);
    log(`AI assist wired to ${endpoint} with model "${modelIdentifier}"`);
}

/**
 * A one-line round trip, so "ready" means ready rather than "the CLI exited 0".
 *
 * It also **measures whether the model thinks**, because that is not visible from the model list and it
 * is the difference between working and silence: measured 2026-09-15, `qwen/qwen3.5-9b` spent 837 reasoning
 * tokens before answering a one-line question, so with a 900-token budget it wrote `content: ""` and the
 * extension reported "0 characters". When thinking is detected the answer budget is raised here, because
 * that is precisely the setting a novice would never know to change.
 */
export interface ProofResult {
    ok: boolean;
    /** Characters of thinking the test request produced (0 for a model that answers directly). */
    thinkingChars: number;
    thinkingTokens?: number;
    /** Set when the answer budget had to be raised, and to what. */
    raisedBudget?: number;
    /** Why the test came back empty, when it did. */
    why?: string;
}

export async function proveItWorks(): Promise<ProofResult> {
    const cfg = configView(SETTINGS);
    const start = cfg.get<number>('maxTokens', 4096);
    const ask = async (budget: number) => {
        const live = normalizeAssistantConfig({
            backend: 'external',
            endpoint: cfg.get<string>('endpoint', ''),
            model: cfg.get<string>('model', ''),
            maxTokens: budget,
            timeoutSeconds: 180
        });
        return chatDetailed(live, [{ role: 'user', content: 'Reply with the single word: ready' }], {});
    };

    try {
        let outcome = await ask(start);
        // A thinking model needs room to think *and* to answer. Retry once at the working floor, then at
        // the maximum — only ever when an empty answer is explained by thinking. Never guess otherwise.
        let raised: number | undefined;
        for (const budget of [4096, 8192]) {
            if (outcome.text.trim() || !outcome.reasoning || budget <= start || budget <= (raised ?? 0)) break;
            log(`The test request produced no answer but ${outcome.reasoning.length} characters of thinking `
                + `— retrying with maxTokens = ${budget}.`);
            raised = budget;
            outcome = await ask(budget);
        }
        const thinkingChars = outcome.reasoning.length;
        log(`Test request: ${outcome.text.trim().slice(0, 60) || '(no answer)'}`
            + `${thinkingChars ? ` after ${thinkingChars} characters of thinking` : ''}`
            + `${outcome.reasoningTokens ? ` (${outcome.reasoningTokens} thinking tokens)` : ''}`
            + `, finish reason "${outcome.finishReason ?? 'unknown'}".`);

        if (!outcome.text.trim()) {
            return {
                ok: false,
                thinkingChars,
                thinkingTokens: outcome.reasoningTokens,
                raisedBudget: raised,
                why: describeEmptyAnswer(outcome.text, {
                    reasoningChars: thinkingChars,
                    reasoningTokens: outcome.reasoningTokens,
                    finishReason: outcome.finishReason
                })
            };
        }
        // It answered — but if it thinks, keep the budget at the floor so real methods are not cut off.
        if (thinkingChars > 0 && start < 4096) {
            await cfg.update('maxTokens', 4096, vscode.ConfigurationTarget.Global);
            raised = 4096;
        }
        return { ok: true, thinkingChars, thinkingTokens: outcome.reasoningTokens, raisedBudget: raised };
    } catch (err) {
        log(`Test request failed: ${err instanceof Error ? err.message : String(err)}`);
        return { ok: false, thinkingChars: 0, why: err instanceof Error ? err.message : String(err) };
    }
}

/** "A server I run myself" — for Ollama, a hand-built llama-server, or anything else. */
async function askForEndpoint(): Promise<void> {
    const cfg = configView(SETTINGS);
    const endpoint = await vscode.window.showInputBox({
        title: 'Address of your local server',
        value: cfg.get<string>('endpoint', 'http://127.0.0.1:1234/v1'),
        placeHolder: 'http://127.0.0.1:11434/v1',
        prompt: 'The OpenAI-compatible base URL, ending in /v1',
        ignoreFocusOut: true,
        validateInput: (v) => (/^https?:\/\/\S+$/i.test(v.trim()) ? undefined : 'An http:// or https:// address')
    });
    if (!endpoint) return;
    await cfg.update('backend', 'external', vscode.ConfigurationTarget.Global);
    await cfg.update('endpoint', endpoint.trim(), vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(
        'Endpoint saved. Run "AI: Status and Hardware Check" to see the models it offers, and to pin one.'
    );
}

/** "AI: Unload the Loaded Model" — frees the memory without hunting for the GUI. */
export async function unloadLoadedModel(): Promise<void> {
    if (!findLmsCli()) {
        void vscode.window.showWarningMessage('LM Studio is not installed on this machine.');
        return;
    }
    const result = await unloadAll();
    if (!result.ok) {
        void vscode.window.showErrorMessage(`Could not unload: ${result.message ?? ''}`);
        return;
    }
    log('LM Studio models unloaded');
    // Same reason as the load path: the panel would otherwise keep naming the model that is gone.
    void refreshPanels();
    void vscode.window.showInformationMessage('Every model is unloaded — its memory is free again.');
}
