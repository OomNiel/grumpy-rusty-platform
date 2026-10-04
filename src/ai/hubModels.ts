/* Adding a model from Hugging Face — the door for anyone whose machine is not this one.
 *
 * WHY THIS EXISTS (asked 2026-10-04). *"The weight size of the local models are restricted to the specs of
 * this pc. However, this extension is bound to be used by other users who might have much better hardware.
 * This extension must allow users with high spec hardware to select models that suit their environment."*
 *
 * The mechanism had been ported from the designer (0.10.x) and never wired: `parseHubUrl`, `hubGgufFiles`,
 * `hubFileSpec`, `addCustomModelSpec` and `customModelSpecs` all existed, all tested, and **nothing called
 * them**. So the only models anyone could choose were the two 4.4 GB entries in `MODEL_SPECS` — a catalogue
 * written around one 28 GB laptop. A user with 128 GB of RAM and a 24 GB card had no way to say so.
 *
 * WHAT THIS ADDS. A command (and an entry in the model picker) that takes `owner/repo` or any Hugging Face
 * link, lists that repo's `.gguf` files **with their sizes** straight from the Hub, and adds the one the user
 * picks to their own list — stored in `user-models.json` beside the weights, so it behaves exactly like a
 * built-in entry from then on: it appears in the picker, in the panel's dropdown, downloads with progress and
 * a SHA-256 check, and is gated by *its own* size against *this* machine, with the arithmetic shown.
 *
 * The parsing, the Hub answer and the spec arithmetic are pure functions in `modelSpecs.ts`; what is here is
 * the network call, the question and the file.
 */

import * as vscode from 'vscode';
import { log, logError } from './log';
import { formatBytes, hubFileSpec, parseHubUrl, specFit, type HubFile, type ModelSpec } from './modelSpecs';
import { readHardwareFacts } from './assistant';
import { canImportFile } from './localModels';
import {
    addCustomModelSpec,
    customModelSpecs,
    fetchHubFiles,
    modelFileFor,
    removeCustomModelSpec,
    extensionContext
} from './runtime';

/** The Hub's own example, used as the placeholder: a real repo whose name says what it holds. */
const EXAMPLE = 'https://huggingface.co/bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF';

/**
 * "Rusty AI: Add a Model from Hugging Face…" — pick a repo, pick a file, and it is yours to load.
 *
 * Returns the spec that was added, or undefined when the user changed their mind. The spec is returned rather
 * than downloaded on the spot: someone exploring sizes may want three of them listed, and the download is one
 * click away in the picker once the model is in the list.
 */
export async function addModelFromHub(context: vscode.ExtensionContext): Promise<ModelSpec | undefined> {
    const typed = await vscode.window.showInputBox({
        title: 'Add a model from Hugging Face',
        prompt: 'The repository that holds the .gguf files — a link or `owner/repo`. The file list comes from the Hub, with sizes.',
        placeHolder: EXAMPLE,
        ignoreFocusOut: true,
        validateInput: (value) => (parseHubUrl(value) ? undefined : 'That does not look like a huggingface.co address (or owner/repo).')
    });
    if (!typed) return undefined;
    const ref = parseHubUrl(typed);
    if (!ref) {
        void vscode.window.showWarningMessage('That does not look like a Hugging Face address.');
        return undefined;
    }

    let files: HubFile[];
    try {
        files = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Asking Hugging Face about ${ref.repo}`, cancellable: false },
            () => fetchHubFiles(ref.repo, ref.revision)
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError(`Hub: ${message}`);
        void vscode.window.showErrorMessage(`Could not read ${ref.repo}: ${message}`);
        return undefined;
    }

    const facts = readHardwareFacts();
    // `mmproj-*.gguf` files are the *vision projectors*: they sit beside the weights in the same repo and
    // loading one produces a failure that says nothing about the real problem. The rule is `canImportFile`'s —
    // the same one the on-disk scan uses, so both lists agree about what a chat model is.
    const chatFiles = files.filter((file) => canImportFile(file.file));
    if (!chatFiles.length) {
        void vscode.window.showWarningMessage(`${ref.repo} has no .gguf weights to load (only projectors or other files).`);
        return undefined;
    }
    const items = chatFiles.map((file) => {
        const spec = hubFileSpec({ repo: ref.repo, file: file.file, revision: ref.revision, bytes: file.bytes, sha256: file.sha256 });
        const verdict = specFit(spec, { totalRamGb: facts.totalRamGb, freeRamGb: facts.freeRamGb });
        const quantisation = /(q\d[_a-z0-9]*|iq\d[_a-z0-9]*|f16|bf16|f32)/i.exec(file.file)?.[1]?.toUpperCase();
        return {
            label: `${verdict.fits ? '$(cloud-download)' : '$(warning)'} ${file.file}`,
            // The quantisation is the choice that matters to someone shopping on the Hub, and it is in the name
            // — pulled out so two files differ in more than the tail of a long string.
            description: `${formatBytes(file.bytes)}${quantisation ? ` · ${quantisation}` : ''}`,
            detail: verdict.fits
                ? `needs about ${verdict.neededGb.toFixed(1)} GB free — this machine has ${facts.freeRamGb.toFixed(1)} GB free now`
                : `may not fit — ${verdict.reason}`,
            spec
        };
    });

    const picked = await vscode.window.showQuickPick(items, {
        title: `Which file from ${ref.repo}?`,
        placeHolder: `${facts.totalRamGb.toFixed(0)} GB RAM · every file here can be added; the ones that may not fit are marked`,
        ignoreFocusOut: true,
        matchOnDescription: true
    });
    if (!picked) return undefined;

    addCustomModelSpec(picked.spec);
    log(`Hub: added ${picked.spec.fileName} from ${ref.repo} (${formatBytes(picked.spec.bytes)})`);
    const where = modelFileFor(context, picked.spec);
    const next = await vscode.window.showInformationMessage(
        `Added ${picked.spec.fileName} — ${formatBytes(picked.spec.bytes)}. It is in the model list now; choosing it there downloads it to ${where}.`,
        'Choose a Local Model…',
        'Done'
    );
    if (next === 'Choose a Local Model…') {
        await vscode.commands.executeCommand('rustyPlatform.assistant.setupModel');
    }
    return picked.spec;
}

/** "Rusty AI: Remove a Model I Added…" — the one thing an added model needs that a built-in does not. */
export async function removeAddedModel(): Promise<void> {
    const added = customModelSpecs();
    if (!added.length) {
        void vscode.window.showInformationMessage('No models have been added from Hugging Face — the list is the extension\'s own.');
        return;
    }
    const picked = await vscode.window.showQuickPick(
        added.map((spec) => ({
            label: spec.fileName,
            description: formatBytes(spec.bytes),
            detail: spec.url,
            spec
        })),
        { title: 'Remove an added model', placeHolder: 'The weights stay on disk — this removes it from the list', ignoreFocusOut: true }
    );
    if (!picked) return;
    const context = extensionContext();
    const file = context ? modelFileFor(context, picked.spec) : '';
    const answer = await vscode.window.showWarningMessage(
        `Remove ${picked.spec.fileName} from the model list?`
        + (file ? `\n\nThe downloaded file (${file}) is left alone — delete it yourself to reclaim the space.` : ''),
        { modal: true },
        'Remove it'
    );
    if (answer !== 'Remove it') return;
    removeCustomModelSpec(picked.spec.id);
    log(`Hub: removed ${picked.spec.fileName} from the added list`);
    void vscode.window.showInformationMessage(`Removed ${picked.spec.fileName}.`);
}
