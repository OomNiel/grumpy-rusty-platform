/* The AI assist's VS Code side — everything the developer actually runs.
 *
 * WHAT LIVES HERE. The prompt written at the caret (`✎ AI`), "implement this in the function I am in", the
 * diff that shows the proposal before it is written, the build-driven repair loop, the house-rules
 * learning, and the status dialog. The *decisions* are not here: the prompts, the Rust parsing, the
 * signature preservation and the edits are pure functions in `rustCode.ts`, and the model client, token
 * arithmetic and answer parsing are in `assistant.ts`. This module gathers facts from the editor, calls
 * those, and puts the answer in front of the developer.
 *
 * THE RULE THAT KEEPS THE FEATURE HONEST: **nothing is written behind the developer's back.** Every
 * proposal — a rewritten function, a new one, a compiler fix — goes through `showProposal`, which opens a
 * diff of the *whole file* with the model's text applied. The developer applies it (a normal, undoable
 * edit), discards it, or edits it first. The one exception is deliberate and opt-out: with
 * `rustyPlatform.assistant.showDiff` off the same text is applied directly, still as a normal edit and
 * still undoable with Ctrl+Z.
 *
 * WHY THE WRITE IS A WHOLE-FILE REPLACE. The proposal text is already computed against the file's exact
 * bytes (BOM, CRLF, indentation), so replacing the document with that text is the only edit that cannot
 * disagree with what the diff showed. A `Range`-based splice would need the document not to have changed
 * between the diff and the apply — which is exactly the window a user types in.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    assistantEnabled,
    chatDetailed,
    describeEmptyAnswer,
    describeModel,
    describeProgress,
    estimateTokens,
    extractCode,
    looksLikeEmbeddingModel,
    MAX_METHOD_LINES,
    methodTooLong,
    normalizeAssistantConfig,
    probeServer,
    type AssistantConfig,
    type ChatMessage,
    type ChatOutcome,
    type ChatOptions
} from './assistant';
import {
    addItemToFile,
    buildFixPrompt,
    buildGeneratePrompt,
    buildImplementPrompt,
    crateList,
    detectEol,
    enclosingFnSpan,
    enclosingItemSpan,
    fnSignatures,
    itemOffsets,
    moduleHeader,
    parseNewItemAnswer,
    preserveSignature,
    spliceItem,
    unwrapItem,
    type ItemSpan,
    type RewritePromptInput
} from './rustCode';
import { boardFacts } from './boardFacts';
import { findPromptBlock, hasPromptBlock, promptSnippet, stripPromptBlock } from './prompt';
import {
    buildProject,
    clearBuildDiagnostics,
    disposeBuildDiagnostics,
    publishBuildDiagnostics,
    type CompilerDiagnostic
} from './cargoBuild';
import { describeError as describeCompilerError, repairUntilClean, type RepairReport } from './repair';
import { conventionsBlock, deriveConventions, normaliseConventions } from './conventions';
import { hostBlockMessage, hostGate } from './hostCheck';
import { configView, updateSetting } from './settings';
import { configWithEndpoint } from './runtime';
import { readActiveProject, type ActiveProject } from '../project/activeProject';
import { log, logError } from './log';

/** The settings section every AI key lives under. */
export const SETTINGS = 'rustyPlatform.assistant';

/** The scheme of the virtual document a proposal is shown in. */
export const PROPOSAL_SCHEME = 'rusty-ai-proposal';

/** Tokens reserved for the chat template and the stop marker, as in `assistant.promptRoom`. */
const PROMPT_SLACK = 64;

/** The prompt facts that are optional, in the order they are dropped when the window is tight. */
type OptionalFacts = Omit<RewritePromptInput, 'description' | 'func'>;

/** Reads the settings and normalises them: the one place "what does backend X mean" has an answer. */
export function assistantConfig(): AssistantConfig {
    const cfg = configView(SETTINGS);
    return normalizeAssistantConfig({
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

// ---------------- the proposal (the diff that is applied) ----------------

interface Proposal {
    original: vscode.Uri;
    text: string;
    title: string;
}

const proposals = new Map<string, Proposal>();
let proposalSeq = 0;

/** The virtual documents the diff editor reads. A provider because `vscode.diff` needs a URI. */
class ProposalContentProvider implements vscode.TextDocumentContentProvider {
    private readonly changed = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this.changed.event;

    provideTextDocumentContent(uri: vscode.Uri): string {
        return proposals.get(uri.toString())?.text ?? '';
    }

    fire(uri: vscode.Uri): void {
        this.changed.fire(uri);
    }

    dispose(): void {
        this.changed.dispose();
    }
}

const proposalContent = new ProposalContentProvider();

function proposalUri(name: string): vscode.Uri {
    proposalSeq += 1;
    return vscode.Uri.from({
        scheme: PROPOSAL_SCHEME,
        path: `/${name.replace(/[^\w.-]/g, '_')}.proposed`,
        query: String(proposalSeq)
    });
}

/** The proposal the active diff editor is showing, or undefined. */
function activeProposal(): { uri: vscode.Uri; proposal: Proposal } | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== PROPOSAL_SCHEME) return undefined;
    const proposal = proposals.get(editor.document.uri.toString());
    return proposal ? { uri: editor.document.uri, proposal } : undefined;
}

/**
 * Shows the model's text as a diff against the file, and offers Apply / Discard.
 *
 * `vscode.diff` is used rather than a custom webview because the diff editor already has the one thing a
 * review needs — the original on the left, the proposal on the right — and because apply is then a command
 * the user can key-bind.
 */
export async function showProposal(original: vscode.Uri, text: string, title: string): Promise<void> {
    const uri = proposalUri(path.basename(original.fsPath));
    proposals.set(uri.toString(), { original, text, title });
    proposalContent.fire(uri);
    await vscode.commands.executeCommand('vscode.diff', original, uri, title);
    await vscode.commands.executeCommand('setContext', 'rustyPlatform.proposalPending', true);
    const pick = await vscode.window.showInformationMessage(
        `${title} — review the diff, then apply it.`,
        'Apply',
        'Discard'
    );
    if (pick === 'Apply') await applyProposal();
    else if (pick === 'Discard') await discardProposal();
}

/** Replaces a whole document with `text` — one edit, so the diff and the result cannot disagree. */
async function writeDocument(uri: vscode.Uri, text: string): Promise<boolean> {
    const document = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    const ok = await vscode.workspace.applyEdit(edit);
    if (ok) {
        try {
            await document.save();
        } catch (error) {
            logError(error);
        }
    }
    return ok;
}

/** Writes the proposal into the file it came from. A normal edit: Ctrl+Z undoes it. */
export async function applyProposal(): Promise<void> {
    const active = activeProposal();
    if (!active) {
        void vscode.window.showWarningMessage('There is no AI proposal open — generate one first.');
        return;
    }
    const { uri, proposal } = active;
    const ok = await writeDocument(proposal.original, proposal.text);
    proposals.delete(uri.toString());
    await vscode.commands.executeCommand('setContext', 'rustyPlatform.proposalPending', false);
    await closeDiffEditors();
    if (ok) {
        log(`assistant: applied proposal (${proposal.title})`);
        // `verifyAfterApply` is the user's answer to "should every applied proposal cost a build?" — a
        // cold embedded check is slow, so it is offered rather than forced, and the setting can turn even
        // the offer off.
        if (configView(SETTINGS).get<boolean>('verifyAfterApply') === false) {
            void vscode.window.showInformationMessage(`Applied: ${proposal.title}.`);
        } else {
            const pick = await vscode.window.showInformationMessage(
                `Applied: ${proposal.title}.`,
                'Check (cargo check)',
                'Later'
            );
            if (pick === 'Check (cargo check)') await checkProject();
        }
    } else {
        void vscode.window.showErrorMessage('The proposal could not be applied — the file may be read-only.');
    }
}

export async function discardProposal(): Promise<void> {
    const active = activeProposal();
    if (active) proposals.delete(active.uri.toString());
    await vscode.commands.executeCommand('setContext', 'rustyPlatform.proposalPending', false);
    await closeDiffEditors();
}

async function closeDiffEditors(): Promise<void> {
    // Closing the active editor closes the proposal side of the diff; the original is what is left, which is
    // exactly where the developer wants to be.
    if (vscode.window.activeTextEditor?.document.uri.scheme === PROPOSAL_SCHEME) {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
}

// ---------------- reading the editor and the project ----------------

interface EditContext {
    document: vscode.TextDocument;
    text: string;
    project?: ActiveProject;
}

async function rustContext(): Promise<EditContext | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        void vscode.window.showWarningMessage('Open a Rust file first — the AI assist edits the file you are in.');
        return undefined;
    }
    const document = editor.document;
    if (document.languageId !== 'rust') {
        void vscode.window.showWarningMessage(`The AI assist edits Rust files; this one is "${document.languageId}".`);
        return undefined;
    }
    return { document, text: document.getText(), project: await readActiveProject() };
}

/** The facts the prompt may use: target, crates, header, a sibling function, house rules, board facts. */
function promptFacts(ctx: EditContext, span: ItemSpan | undefined): OptionalFacts {
    const cfg = configView(SETTINGS);
    const project = ctx.project;
    const board = project?.board;
    const triple = project ? /^\s*target\s*=\s*["']([^"']+)["']/m.exec(project.cargoConfigToml)?.[1] : undefined;
    const target = board
        ? `${board.vendor} ${board.name} (${board.family})${triple ? `, building for ${triple}` : `, target ${board.target}`}`
        : triple
            ? `Rust target ${triple}`
            : '';
    return {
        header: moduleHeader(ctx.text, span),
        crates: project ? crateList(project.cargoToml) : '',
        target,
        sibling: siblingFunction(ctx.text, span),
        rules: conventionsBlock(normaliseConventions(cfg.get('conventions'))),
        facts: boardFacts(board, project?.chip)
    };
}

/** The first other function in the file, trimmed to something a small model can afford: a style reference. */
function siblingFunction(text: string, span: ItemSpan | undefined): string {
    const other = fnSignatures(text).find((f) => f.name !== span?.name && !f.attrs.some((a) => a.includes('main')));
    if (!other) return '';
    const item = enclosingItemSpan(text, other.line);
    if (!item || item.kind !== 'fn' || item.name !== other.name) return '';
    const { start, end } = itemOffsets(text, item);
    const lines = text.slice(start, end).split(/\r?\n/);
    return lines.length <= 40 ? lines.join('\n') : '';
}

// ---------------- the request ----------------

/** One streamed request, with the model's progress in a notification the user can cancel. */
async function runChat(cfg: AssistantConfig, messages: ChatMessage[], title: string): Promise<ChatOutcome> {
    // A `bundled` request has no endpoint until the runtime is up, and the settings' default endpoint is LM
    // Studio's. Resolving it here means implement, fix and repair all go through one place.
    return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        async (progress, token) => {
            const controller = new AbortController();
            token.onCancellationRequested(() => controller.abort());
            return chatWithRescue(cfg, messages, {
                signal: controller.signal,
                // The line is `describeProgress`'s: tokens written, elapsed time, tokens/s, and how much of
                // the window the prompt took. It arrives on a half-second heartbeat too, so a long prompt
                // read and a hang no longer look the same.
                onProgress: (info) => progress.report({ message: describeProgress(info) }),
                // The rescue's own steps (finding/starting a llama-server) on the same line, so a wait that
                // is not generation is never mistaken for one.
                onStep: (message) => progress.report({ message })
            });
        }
    );
}

/**
 * Sends a chat, and when there was **nowhere to send it**, gets a llama-server up and sends it again.
 *
 * *"This extension must not rely on the user to have a llama.cpp server installed. If the server is installed
 * on the host, just start it and use it. If not, offer installation to the user."* Every request path goes
 * through here — the chat view and implement/fix/repair — so the promise is kept at the moment it matters
 * rather than only in the model picker.
 *
 * Two guards, both learned the hard way:
 *   - nothing is retried once part of an answer has been **streamed**. A connection that dies mid-answer is
 *     also "fetch failed", and retrying it would print the beginning of the answer twice (2026-10-04);
 *   - the retry re-reads the settings instead of reusing the first request's config: the rescue *writes* the
 *     new endpoint and model, and the retry must send exactly what they now say.
 *
 * `rescueUnreachableEndpoint` decides whether this failure is one a started server could fix at all, and it
 * asks before installing anything (`ensureLlamaServerBinary`) or fetching weights (`chooseLlamaServerModel`).
 * When it declines — a remote address, a `400`, a cancelled request — the original error is rethrown
 * untouched.
 */
export async function chatWithRescue(
    cfg: AssistantConfig,
    messages: ChatMessage[],
    opts: ChatOptions & { onStep?: (message: string) => void } = {}
): Promise<ChatOutcome> {
    const request = await configWithEndpoint(cfg);
    let streamed = false;
    const tracked: ChatOptions = {
        ...opts,
        onToken: (text) => { streamed = true; opts.onToken?.(text); }
    };
    try {
        return await chatDetailed(request, messages, tracked);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (streamed) throw error;
        const { rescueUnreachableEndpoint } = await import('./llamaServer');
        const endpoint = await rescueUnreachableEndpoint(
            { endpoint: request.endpoint, backend: request.backend },
            message,
            opts.onStep
        );
        if (!endpoint) throw error;
        return await chatDetailed(await configWithEndpoint(assistantConfig()), messages, tracked);
    }
}

/** The gate: refuse early, with the reason, on a machine that cannot run the feature — unless overridden. */
async function hostAllows(): Promise<boolean> {
    const gate = await hostGate();
    if (gate.aiAllowed) {
        if (gate.warning) log(`assistant: ${gate.warning}`);
        return true;
    }
    const pick = await vscode.window.showWarningMessage(hostBlockMessage(gate), 'Use it anyway', 'Cancel');
    if (pick !== 'Use it anyway') return false;
    await updateSetting(vscode.workspace.getConfiguration(SETTINGS), 'ignoreHostCheck', true);
    log('assistant: host check overridden by the user');
    return true;
}

/** Everything that must be true before a request is sent: the feature on, and a machine that can run it. */
async function ready(title: string): Promise<AssistantConfig | undefined> {
    const cfg = assistantConfig();
    if (!assistantEnabled(cfg)) {
        const pick = await vscode.window.showWarningMessage(
            'The AI assist is off. Turn it on and choose a model in the AI panel.',
            'Open the AI panel'
        );
        if (pick === 'Open the AI panel') void vscode.commands.executeCommand('rustyPlatform.assistant.openPanel');
        return undefined;
    }
    if (!(await hostAllows())) return undefined;
    const fresh = assistantConfig();
    log(`assistant: ${title} — backend=${fresh.backend} model=${fresh.model || '(server decides)'}`);
    return fresh;
}

/** Drops the optional parts of a prompt, in value order, until it fits the window. */
function fitMessages(
    build: (facts: OptionalFacts) => ChatMessage[],
    facts: OptionalFacts,
    room: number
): { messages: ChatMessage[]; dropped: string[] } {
    const order: (keyof OptionalFacts)[] = ['sibling', 'crates', 'facts', 'rules'];
    let current = { ...facts };
    let messages = build(current);
    const dropped: string[] = [];
    for (const key of order) {
        const user = messages.find((m) => m.role === 'user')?.content ?? '';
        if (estimateTokens(user) <= Math.max(0, room - PROMPT_SLACK)) break;
        if (!current[key]) continue;
        current = { ...current, [key]: '' };
        dropped.push(String(key));
        messages = build(current);
    }
    return { messages, dropped };
}

/** Turns a model answer into code, or explains why there is none. Shared by every flow. */
function extractAndCheck(answer: ChatOutcome): string | undefined {
    const { code, note } = extractCode(answer.text);
    if (!code.trim()) {
        void vscode.window.showWarningMessage(
            describeEmptyAnswer(answer.text, {
                reasoningChars: answer.reasoning.length,
                reasoningTokens: answer.reasoningTokens,
                finishReason: answer.finishReason
            })
        );
        return undefined;
    }
    if (note) log(`assistant: ${note}`);
    if (answer.finishReason === 'length') {
        void vscode.window.showWarningMessage(
            'The answer hit the token limit and may be cut short — the end of the function is worth checking.'
        );
    }
    return code;
}

/** The failure sentence for a request that never reached a model. */
function unreachable(error: unknown): string {
    return `The model could not be reached: ${error instanceof Error ? error.message : String(error)}`;
}

// ---------------- the flows ----------------

/**
 * `AI: Implement in Function…` — inserts the marker block at the caret.
 *
 * The caret is where the developer is already looking, and Ctrl+Z abandons the block, which is why the
 * editor is the input rather than a dialog (see `prompt.ts`).
 */
export async function implementInFunction(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'rust') {
        void vscode.window.showWarningMessage('Put the caret in a Rust file and try again.');
        return;
    }
    await editor.insertSnippet(new vscode.SnippetString(promptSnippet(editor.document.languageId)), editor.selection.active);
    log('assistant: ✎ AI block inserted at the caret');
}

/** `AI: Send the Prompt in the ✎ AI Block` — reads the block, removes it, and asks the model. */
export async function sendAiPrompt(): Promise<boolean> {
    const ctx = await rustContext();
    if (!ctx) return false;
    const found = findPromptBlock(ctx.text);
    if (!found.ok) {
        void vscode.window.showWarningMessage(found.why);
        return false;
    }
    const block = found.block;
    if (!(await writeDocument(ctx.document.uri, stripPromptBlock(ctx.text, block)))) return false;
    log(`assistant: ✎ AI block at line ${block.begin + 1} — "${block.prompt.split(/\r?\n/)[0] ?? ''}"`);
    return runImplement(ctx.document, block.begin, block.prompt);
}

/** `AI: Discard the ✎ AI Block` — removes it without asking anything. */
export async function cancelAiPrompt(): Promise<void> {
    const ctx = await rustContext();
    if (!ctx) return;
    const found = findPromptBlock(ctx.text);
    if (!found.ok) {
        void vscode.window.showWarningMessage(found.why);
        return;
    }
    await writeDocument(ctx.document.uri, stripPromptBlock(ctx.text, found.block));
    log('assistant: ✎ AI block discarded');
}

/**
 * The shared body of "do this here": rewrite the function at `line0`, or write a new one when the caret is
 * outside every function.
 */
export async function runImplement(document: vscode.TextDocument, line0: number, description: string): Promise<boolean> {
    const cfg = await ready('implement in function');
    if (!cfg) return false;
    const text = document.getText();
    const lines = text.split(/\r?\n/);
    const caret = Math.min(Math.max(line0 + 1, 1), Math.max(1, lines.length));
    const span = enclosingFnSpan(text, caret);
    const facts = promptFacts({ document, text, project: await readActiveProject() }, span);
    const room = Math.max(0, cfg.contextSize - cfg.maxTokens - PROMPT_SLACK);

    let messages: ChatMessage[];
    let dropped: string[];
    let apply: (code: string) => string;

    if (span) {
        const offsets = itemOffsets(text, span);
        const func = text.slice(offsets.start, offsets.end);
        if (methodTooLong(func)) {
            void vscode.window.showWarningMessage(
                `That function is ${func.split(/\r?\n/).length} lines — more than the ${MAX_METHOD_LINES} a small local ` +
                'model can rewrite reliably. Pick a shorter one, or ask for a smaller helper function instead.'
            );
            return false;
        }
        const built = fitMessages((f) => buildImplementPrompt({ ...f, description, func }), facts, room);
        messages = built.messages;
        dropped = built.dropped;
        apply = (code) => spliceItem(text, span, preserveSignature(func, code).item, detectEol(text));
    } else {
        const built = fitMessages(
            (f) =>
                buildGeneratePrompt({
                    description,
                    header: f.header,
                    members: fnSignatures(text).map((m) => m.declaration).join('\n'),
                    style: f.sibling,
                    target: f.target,
                    crates: f.crates,
                    rules: f.rules,
                    facts: f.facts
                }),
            facts,
            room
        );
        messages = built.messages;
        dropped = built.dropped;
        apply = (code) => {
            const parsed = parseNewItemAnswer(code, '');
            const item = unwrapItem(parsed.item).item;
            return addItemToFile({ text, caretLine: caret, item, span: enclosingItemSpan(text, caret), uses: parsed.uses }).text;
        };
    }

    if (dropped.length) log(`assistant: prompt was over the window — dropped ${dropped.join(', ')}`);
    let answer: ChatOutcome;
    try {
        answer = await runChat(cfg, messages, span ? `Rewriting ${span.name}…` : 'Writing a new function…');
    } catch (error) {
        logError(error);
        void vscode.window.showErrorMessage(unreachable(error));
        return false;
    }
    const code = extractAndCheck(answer);
    if (!code) return false;

    const proposed = apply(code);
    if (proposed === text) {
        void vscode.window.showInformationMessage('The model returned the function unchanged.');
        return false;
    }
    if (cfg.showDiff) {
        await showProposal(document.uri, proposed, span ? `AI: ${span.name}` : 'AI: new function');
    } else {
        if (await writeDocument(document.uri, proposed)) {
            void vscode.window.showInformationMessage(span ? `Updated ${span.name}.` : 'Added the new function.');
            await checkProject();
        }
    }
    return true;
}

/**
 * `AI: Fix with AI` — rewrites the function a compiler diagnostic points at, and shows the proposal.
 *
 * The error text IS the prompt (`buildFixPrompt`), which is what lets the same flow repair an `E0425` and
 * an unused variable.
 */
export async function fixWithAI(uri: vscode.Uri, line: number, message: string): Promise<boolean> {
    const cfg = await ready('fix a compiler error');
    if (!cfg) return false;
    const document = await vscode.workspace.openTextDocument(uri);
    const text = document.getText();
    const span = enclosingFnSpan(text, Math.max(1, line));
    if (!span) {
        void vscode.window.showWarningMessage('That error is not inside a function, so there is nothing to rewrite.');
        return false;
    }
    const offsets = itemOffsets(text, span);
    const func = text.slice(offsets.start, offsets.end);
    const facts = promptFacts({ document, text, project: await readActiveProject() }, span);
    const room = Math.max(0, cfg.contextSize - cfg.maxTokens - PROMPT_SLACK);
    const { messages } = fitMessages((f) => buildFixPrompt({ ...f, description: message, func }), facts, room);

    let answer: ChatOutcome;
    try {
        answer = await runChat(cfg, messages, `Fixing ${span.name}…`);
    } catch (error) {
        logError(error);
        void vscode.window.showErrorMessage(unreachable(error));
        return false;
    }
    const code = extractAndCheck(answer);
    if (!code) return false;
    const proposed = spliceItem(text, span, preserveSignature(func, code).item, detectEol(text));
    if (proposed === text) {
        void vscode.window.showInformationMessage('The model returned the function unchanged.');
        return false;
    }
    await showProposal(uri, proposed, `AI fix: ${span.name}`);
    return true;
}

/** The build oracle: runs `cargo check`, publishes the diagnostics, and summarises. */
export async function checkProject(): Promise<void> {
    const project = await readActiveProject();
    if (!project) {
        void vscode.window.showWarningMessage('Open a Rust project (a folder with a Cargo.toml) and try again.');
        return;
    }
    const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'cargo check…', cancellable: false },
        () => buildProject(project.folder.fsPath, { mode: 'check' })
    );
    publishBuildDiagnostics(result.diagnostics);
    if (result.failure) {
        void vscode.window.showErrorMessage(result.failure);
        return;
    }
    if (result.ok) {
        void vscode.window.showInformationMessage(
            `The project compiles${result.warnings ? ` (${result.warnings} warning(s))` : ''}.`
        );
        return;
    }
    const pick = await vscode.window.showWarningMessage(
        `${result.errors} error(s)${result.warnings ? ` and ${result.warnings} warning(s)` : ''}.`,
        'Fix them with AI',
        'Show the details'
    );
    if (pick === 'Fix them with AI') await repairProjectWithAI();
    else if (pick === 'Show the details') log(`cargo: ${result.stderr ?? '(no stderr)'}`);
}

/**
 * `AI: Fix the Build` — the build-driven repair loop.
 *
 * One error at a time, one build between each, because every edit shifts line numbers. A fix that does not
 * help is reverted; an error nothing can fix is skipped and the rest are tried. The designer's
 * `repairLoop.ts` driven with cargo as the oracle.
 */
export async function repairProjectWithAI(maxPasses = 6): Promise<RepairReport | undefined> {
    const project = await readActiveProject();
    if (!project) {
        void vscode.window.showWarningMessage('Open a Rust project (a folder with a Cargo.toml) and try again.');
        return undefined;
    }
    const cfg = await ready('repair the build');
    if (!cfg) return undefined;
    const dir = project.folder.fsPath;
    let cancelled = false;
    /** The last edit, so `revert()` can put it back. */
    let last: { uri: vscode.Uri; before: string } | undefined;

    const report = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Fixing the build…', cancellable: true },
        async (progress, token) => {
            token.onCancellationRequested(() => {
                cancelled = true;
            });
            return repairUntilClean(
                {
                    build: async () => {
                        const result = await buildProject(dir, { mode: 'check' });
                        clearBuildDiagnostics();
                        publishBuildDiagnostics(result.diagnostics);
                        return {
                            errors: result.diagnostics.filter((d) => d.severity === 'error'),
                            warnings: result.diagnostics.filter((d) => d.severity === 'warning'),
                            failure: result.failure
                        };
                    },
                    fix: async (error: CompilerDiagnostic) => {
                        progress.report({ message: describeCompilerError(error) });
                        return fixOne(cfg, error, project, (uri, before) => {
                            last = { uri, before };
                        }, () => cancelled);
                    },
                    revert: async () => {
                        if (last) await writeDocument(last.uri, last.before);
                        last = undefined;
                    },
                    progress: (text) => log(`assistant: ${text}`),
                    cancelled: () => cancelled
                },
                maxPasses
            );
        }
    );

    if (report.failure) {
        void vscode.window.showErrorMessage(report.failure);
        return report;
    }
    if (report.stoppedBecause === 'clean') {
        void vscode.window.showInformationMessage(
            report.reverted > 0
                ? `The build is clean (${report.applied} fix(es) kept, ${report.reverted} undone).`
                : `The build is clean (${report.applied} fix(es) applied).`
        );
    } else {
        const rest = report.remaining.slice(0, 5).map((d) => `${describeCompilerError(d)}: ${d.message.slice(0, 80)}`);
        void vscode.window.showWarningMessage(
            `Stopped with ${report.remaining.length} error(s) left (${report.stoppedBecause}). ${rest.join('; ')}`
        );
    }
    return report;
}

/** One pass of the repair loop: locate the error, ask, write the edit. */
async function fixOne(
    cfg: AssistantConfig,
    error: CompilerDiagnostic,
    project: ActiveProject,
    remember: (uri: vscode.Uri, before: string) => void,
    cancelled: () => boolean
): Promise<'fixed' | 'no-fix' | 'failed'> {
    try {
        const uri = vscode.Uri.file(error.file);
        const document = await vscode.workspace.openTextDocument(uri);
        const text = document.getText();
        const span = enclosingFnSpan(text, Math.max(1, error.line));
        if (!span) return 'no-fix';
        const offsets = itemOffsets(text, span);
        const func = text.slice(offsets.start, offsets.end);
        if (methodTooLong(func)) return 'no-fix';
        const heading = error.code ? `${error.code}: ${error.message}` : error.message;
        const finding = `${heading}\n(at ${path.basename(error.file)}:${error.line}:${error.column})`;
        const facts = promptFacts({ document, text, project }, span);
        const room = Math.max(0, cfg.contextSize - cfg.maxTokens - PROMPT_SLACK);
        const { messages } = fitMessages((f) => buildFixPrompt({ ...f, description: finding, func }), facts, room);
        if (cancelled()) return 'no-fix';
        const answer = await runChat(cfg, messages, `Fixing ${describeCompilerError(error)}…`);
        const code = extractAndCheck(answer);
        if (!code) return 'no-fix';
        const proposed = spliceItem(text, span, preserveSignature(func, code).item, detectEol(text));
        if (proposed === text) return 'no-fix';
        remember(uri, text);
        const ok = await writeDocument(uri, proposed);
        log(`assistant: fix for ${describeCompilerError(error)} — ${ok ? 'written' : 'could not be written'}`);
        return ok ? 'fixed' : 'failed';
    } catch (err) {
        logError(err);
        return 'failed';
    }
}

// ---------------- house rules ----------------

const IGNORED_DIRS = new Set(['target', '.git', '.github', 'node_modules', '.dsh-worktrees']);
const MAX_RULE_FILES = 60;
const MAX_RULE_BYTES = 200 * 1024;

/** The project's own `.rs` files, bounded, for the convention measurement. */
function rustFiles(root: string): { name: string; text: string }[] {
    const out: { name: string; text: string }[] = [];
    const queue = [path.join(root, 'src'), root];
    let bytes = 0;
    while (queue.length && out.length < MAX_RULE_FILES) {
        const dir = queue.pop();
        if (!dir) break;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (out.length >= MAX_RULE_FILES) break;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!IGNORED_DIRS.has(entry.name)) queue.push(full);
                continue;
            }
            if (!entry.name.endsWith('.rs')) continue;
            try {
                const text = fs.readFileSync(full, 'utf8');
                if (text.length > MAX_RULE_BYTES) continue;
                bytes += text.length;
                out.push({ name: full, text });
            } catch {
                /* unreadable file: not a rule, not an error */
            }
            if (bytes > MAX_RULE_BYTES * 8) return out;
        }
    }
    return out;
}

/** `AI: Learn the House Rules from My Code…` — measure the project, let the user keep what is true. */
export async function learnConventions(): Promise<void> {
    const project = await readActiveProject();
    if (!project) {
        void vscode.window.showWarningMessage('Open a Rust project first — the rules are measured from its own code.');
        return;
    }
    const files = rustFiles(project.folder.fsPath);
    const facts = deriveConventions(files);
    if (!facts.length) {
        void vscode.window.showInformationMessage(
            `Not enough code yet to see a pattern (looked at ${files.length} Rust file(s)). Add a few functions and try again.`
        );
        return;
    }
    const picked = await vscode.window.showQuickPick(
        facts.map((f) => ({ label: f.text, description: `${f.samples} of ${f.total}`, picked: true })),
        {
            canPickMany: true,
            title: 'House rules measured from your own Rust',
            placeHolder: 'Uncheck anything that is not a rule you want followed'
        }
    );
    if (!picked) return;
    await updateSetting(vscode.workspace.getConfiguration(SETTINGS), 'conventions', picked.map((p) => p.label));
    log(`assistant: kept ${picked.length} house rule(s) from ${files.length} file(s)`);
    void vscode.window.showInformationMessage(`Kept ${picked.length} house rule(s) — they go into every prompt now.`);
}

// ---------------- status ----------------

/** The lines the status dialog shows: what is configured, what the server offers, what the machine has. */
export async function statusLines(): Promise<string[]> {
    const cfg = assistantConfig();
    const project = await readActiveProject();
    const gate = await hostGate();
    const lines: string[] = [];
    lines.push(`Backend: ${cfg.backend}`);
    lines.push(`Endpoint: ${cfg.endpoint}`);
    lines.push(describeModel(cfg));
    if (cfg.backend === 'external') {
        const probe = await probeServer(cfg);
        if (probe.ok) {
            const chat = probe.models.filter((m) => !looksLikeEmbeddingModel(m.id));
            lines.push(`Server: answering, ${chat.length} chat model(s)${chat.length ? `: ${chat.map((m) => m.id).join(', ')}` : ''}`);
        } else {
            lines.push(`Server: ${probe.error ?? 'not answering'}`);
        }
    }
    lines.push(
        `Machine: ${gate.hardware.totalRamGb.toFixed(1)} GB RAM, ${gate.hardware.freeRamGb.toFixed(1)} GB free, ` +
        `${gate.hardware.cpuCount} threads, ${gate.hardware.arch}${gate.gpu.name ? `, ${gate.gpu.name}` : ''}`
    );
    lines.push(`Local inference: ${gate.aiAllowed ? 'allowed' : 'not allowed'}${gate.overridden ? ' (overridden)' : ''}`);
    for (const reason of gate.reasons) lines.push(`  · ${reason}`);
    if (gate.warning) lines.push(`  ! ${gate.warning}`);
    if (project?.chip) lines.push(`Target chip: ${project.chip}`);
    lines.push(`Diff before applying: ${cfg.showDiff ? 'yes' : 'no (edits apply directly; Ctrl+Z undoes them)'}`);
    return lines;
}

/** `AI: Status and Hardware Check` — the same lines, in a dialog. */
export async function showStatus(): Promise<void> {
    const lines = await statusLines();
    await vscode.window.showInformationMessage('Rusty AI status', { modal: true, detail: lines.join('\n') }, 'OK');
}

// ---------------- the ✎ block's code lens ----------------

/** Offers Send / Discard on the marker block, so the request is submitted from where it was written. */
export class PromptBlockLensProvider implements vscode.CodeLensProvider {
    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        if (document.languageId !== 'rust') return [];
        const text = document.getText();
        if (!hasPromptBlock(text)) return [];
        const found = findPromptBlock(text);
        if (!found.ok) return [];
        const range = new vscode.Range(found.block.begin, 0, found.block.begin, 0);
        return [
            new vscode.CodeLens(range, {
                title: '$(sparkle) Send to the AI assist',
                command: 'rustyPlatform.assistant.sendPrompt'
            }),
            new vscode.CodeLens(range, { title: '$(x) Discard', command: 'rustyPlatform.assistant.cancelPrompt' })
        ];
    }
}

/** Offers "Fix with AI" on the compiler's own diagnostics. */
export class AssistantCodeActionProvider implements vscode.CodeActionProvider {
    provideCodeActions(
        document: vscode.TextDocument,
        _range: vscode.Range,
        context: vscode.CodeActionContext
    ): vscode.CodeAction[] {
        if (document.languageId !== 'rust') return [];
        const actions: vscode.CodeAction[] = [];
        for (const diagnostic of context.diagnostics) {
            const action = new vscode.CodeAction('Fix with the AI assist', vscode.CodeActionKind.QuickFix);
            action.command = {
                command: 'rustyPlatform.assistant.fixFinding',
                title: 'Fix with the AI assist',
                arguments: [document.uri, diagnostic.range.start.line + 1, diagnostic.message]
            };
            action.diagnostics = [diagnostic];
            action.isPreferred = true;
            actions.push(action);
        }
        return actions;
    }
}

/** Refreshes the AI panel, when one is open. Kept here so the model layer has one place to call. */
export async function refreshPanels(): Promise<void> {
    const chat = await import('../ui/aiChatView');
    await chat.refreshAiChat();
}

/** Everything this layer registers with the extension context. */
export function registerAssistantEditorCommands(): vscode.Disposable[] {
    return [
        vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, proposalContent),
        vscode.languages.registerCodeLensProvider({ language: 'rust' }, new PromptBlockLensProvider()),
        vscode.languages.registerCodeActionsProvider({ language: 'rust' }, new AssistantCodeActionProvider(), {
            providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
        }),
        vscode.commands.registerCommand('rustyPlatform.assistant.implement', () => implementInFunction()),
        vscode.commands.registerCommand('rustyPlatform.assistant.sendPrompt', () => sendAiPrompt()),
        vscode.commands.registerCommand('rustyPlatform.assistant.cancelPrompt', () => cancelAiPrompt()),
        vscode.commands.registerCommand('rustyPlatform.assistant.applyProposal', () => applyProposal()),
        vscode.commands.registerCommand('rustyPlatform.assistant.discardProposal', () => discardProposal()),
        vscode.commands.registerCommand('rustyPlatform.assistant.fixFinding', (uri: vscode.Uri, line: number, message: string) =>
            fixWithAI(uri, line, message)
        ),
        vscode.commands.registerCommand('rustyPlatform.assistant.repair', () => repairProjectWithAI()),
        vscode.commands.registerCommand('rustyPlatform.assistant.check', () => checkProject()),
        vscode.commands.registerCommand('rustyPlatform.assistant.learnConventions', () => learnConventions()),
        vscode.commands.registerCommand('rustyPlatform.assistant.status', () => showStatus()),
        new vscode.Disposable(() => {
            proposalContent.dispose();
            disposeBuildDiagnostics();
            proposals.clear();
        })
    ];
}
