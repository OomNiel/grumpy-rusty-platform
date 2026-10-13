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
    answerBudget,
    assistantEnabled,
    chatDetailed,
    contextForBudget,
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
    rustCodeBlocks,
    squeezedAnswerNotice,
    type AssistantConfig,
    type ChatMessage,
    type ChatOutcome,
    type ChatOptions,
    type CodeBlock
} from './assistant';
import {
    addItemToFile,
    buildFixPrompt,
    buildGeneratePrompt,
    buildImplementPrompt,
    changeSummary,
    chatCodeProblem,
    codeBlockLabel,
    crateList,
    detectEol,
    enclosingFnSpan,
    enclosingItemSpan,
    fnSignatures,
    itemOffsets,
    insertChatCode,
    looksLikeWholeFile,
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
import { espEnv } from '../commands/terminal';
import { log, logError } from './log';
import { checkScope, scopeLogLine } from './scope';
import { handOff, handoffConfig, lastRunId, forgetRunId, agentScan, forgetAgentScan, handoffKey, setHandoffKey, findImportableKey, type HandoffReport } from './handoff';
import { describeAgent, chooseAgent, handoffButtonLabel, type AgentCandidate } from './agents';

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
 * The proposal to apply, whichever editor is in front.
 *
 * `activeProposal` is right when the user is *in* the diff, which is all the notification needed, because it
 * only offered Apply while it was on screen. The status bar button can be pressed with the cursor anywhere --
 * which is the point of it -- so when the diff is not focused the newest open proposal is the one it means.
 */
function anyProposal(): { uri: vscode.Uri; proposal: Proposal } | undefined {
    const active = activeProposal();
    if (active) return active;
    const newest = [...proposals.entries()].pop();
    return newest === undefined ? undefined : { uri: vscode.Uri.parse(newest[0]), proposal: newest[1] };
}

/**
 * The status bar button that applies the open proposal.
 *
 * The notification offering Apply is transient: the next notification dismisses it, and reading a diff takes
 * longer than it stays. That left a reviewed proposal with no way to accept it except the Command Palette, so
 * the button appears with the proposal and leaves with it.
 */
let proposalBar: vscode.StatusBarItem | undefined;

function showProposalBar(summary: string): void {
    if (proposalBar === undefined) {
        proposalBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 93);
        proposalBar.command = 'rustyPlatform.assistant.applyProposal';
        proposalBar.text = '$(diff) Implement Diff';
    }
    proposalBar.tooltip =
        `${summary}\nWrite the AI proposal that is open in the diff into its file. An ordinary edit: Ctrl+Z ` +
        'undoes it. Discard it instead from the Command Palette.';
    proposalBar.show();
}

/**
 * One line saying what a proposal does, before it is opened.
 *
 * The diff shows *what* changes; this is what tells the reviewer whether it is a change at all. A proposal
 * that removes far more than it adds is a rewrite, and a rewrite is what a request like "add this to the main
 * loop" never asked for (2026-10-12).
 */
async function describeProposal(original: vscode.Uri, text: string): Promise<string> {
    const where = path.basename(original.fsPath);
    try {
        const before = (await vscode.workspace.openTextDocument(original)).getText();
        const change = changeSummary(before, text);
        return (
            `${where}: +${change.added} / -${change.removed} lines` +
            `${change.lossy ? ' — this replaces most of the file' : ''}`
        );
    } catch (error) {
        logError(error);
        return `${where}: a proposed change`;
    }
}

function hideProposalBar(): void {
    proposalBar?.hide();
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
    // Worked out before the diff opens, so the count is in the tab's title and in the button's tooltip as well
    // as in the message: the numbers are what a reviewer needs, and they should not scroll away.
    const summary = await describeProposal(original, text);
    await vscode.commands.executeCommand('vscode.diff', original, uri, `${title} · ${summary}`);
    await vscode.commands.executeCommand('setContext', 'rustyPlatform.proposalPending', true);
    showProposalBar(summary);
    const pick = await vscode.window.showInformationMessage(
        `${title} — ${summary}. Review the diff, then apply it.`,
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
    const active = anyProposal();
    if (!active) {
        void vscode.window.showWarningMessage('There is no AI proposal open — generate one first.');
        return;
    }
    const { uri, proposal } = active;
    const ok = await writeDocument(proposal.original, proposal.text);
    proposals.delete(uri.toString());
    await vscode.commands.executeCommand('setContext', 'rustyPlatform.proposalPending', false);
    hideProposalBar();
    await closeProposal(uri);
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
    const active = anyProposal();
    if (active) proposals.delete(active.uri.toString());
    await vscode.commands.executeCommand('setContext', 'rustyPlatform.proposalPending', false);
    hideProposalBar();
    if (active) await closeProposal(active.uri);
}

/**
 * Closes the diff that shows one proposal, wherever it is.
 *
 * Closing the *active* editor was enough while the notification was the only way in, because that meant the
 * diff was focused. The status bar button can be pressed with the cursor anywhere, so the tab holding this
 * proposal is what is looked for -- the original file is what is left, which is where the user wants to be.
 */
async function closeProposal(uri: vscode.Uri): Promise<void> {
    try {
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const input = tab.input;
                if (input instanceof vscode.TabInputTextDiff && input.modified.toString() === uri.toString()) {
                    await vscode.window.tabGroups.close(tab);
                }
            }
        }
    } catch (error) {
        logError(error);
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

/**
 * The optional prompt facts as one block, for a hand-off to carry.
 *
 * The agent gets the same facts the local prompt would have had, in the same words: it can read the project
 * itself, but the conventions measured from the developer's own code and the board's pin facts are expensive to
 * rediscover and cheap to pass on.
 */
function factsText(facts: OptionalFacts | undefined): string | undefined {
    if (!facts) return undefined;
    const parts = [
        facts.target ? `TARGET\n${facts.target}` : '',
        facts.crates ? `CRATES IN THIS PROJECT\n${facts.crates}` : '',
        facts.header ? `THE FILE'S OWN HEADER\n${facts.header}` : '',
        facts.rules ? `HOUSE RULES MEASURED FROM THIS CODE\n${facts.rules}` : '',
        facts.facts ? `THE BOARD\n${facts.facts}` : ''
    ].filter(Boolean);
    return parts.length ? parts.join('\n\n') : undefined;
}

/**
 * The label of the hand-off action, naming whichever agent this machine would actually use.
 *
 * Asked once per offer rather than written down: the scan is cached, `chooseAgent` is the same decision the
 * hand-off itself makes, and the wording therefore cannot promise one agent and deliver another (reported
 * 2026-10-13: *"the prompt in the response box reads: Hand to the Pool agent"* — after pool had stopped being the
 * only answer).
 */
async function handoffAction(): Promise<string> {
    return handoffButtonLabel(chooseAgent(await agentScan(), handoffConfig().agentId));
}

/** Says what a hand-off did, and offers the only thing worth doing next: check the build. */
async function showHandoff(report: HandoffReport): Promise<void> {
    for (const step of report.work) log(`handoff:   ${step}`);
    if (report.full) log(`handoff: the agent said: ${report.full.slice(0, 2000)}`);
    if (report.kind === 'declined' || report.kind === 'off') return;
    if (report.kind === 'answered') {
        // An endpoint wrote nothing, so the answer is the whole result — and "the answer is in the conversation"
        // is a dead end on its own: the code would have to be selected, copied and pasted by hand. The blocks it
        // returned are offered here, through the same path a local answer takes (asked 2026-10-13: *"Can we
        // equip it with the ability to generate diffs and on permission implement it?"*).
        const blocks = rustCodeBlocks(report.answer || report.full || '');
        const pick = await vscode.window.showInformationMessage(
            `The hand-off answered (${report.agent ?? 'an endpoint'}). Nothing was written yet — the answer is in ` +
            'the AI Assist conversation, and its code can be reviewed as a diff from here.',
            ...(blocks.length ? ['Review and implement…'] : [])
        );
        if (pick === 'Review and implement…') await implementHandoffCode(blocks);
        return;
    }
    if (report.kind === 'done') {
        const closing = report.answer ? ` ${report.answer.replace(/\s+/g, ' ').slice(0, 160)}` : '';
        const pick = await vscode.window.showInformationMessage(
            `The pool agent finished in ${report.seconds} s (${report.work.length} step(s)).${closing}`,
            'Check the build'
        );
        if (pick === 'Check the build') await checkProject();
        return;
    }
    void vscode.window.showWarningMessage(`The hand-off did not finish: ${report.message}`);
}

/**
 * Offers the code an agent returned, as a diff, and writes nothing until that diff is applied.
 *
 * The chat's own buttons and this call run the same path (`applyChatCode`), which is the point: one rule for
 * "implement this code", so the guards cannot apply to a local answer and not to a handed-off one. A hand-off
 * that wrote nothing should still end in a usable change — otherwise its answer is only readable.
 */
async function implementHandoffCode(blocks: readonly CodeBlock[]): Promise<void> {
    const chosen = blocks.length === 1 ? blocks[0] : await pickCodeBlock(blocks);
    if (!chosen) return;
    await applyChatCode(chosen.code, { label: codeBlockLabel(chosen.code) });
}

/** Which of several blocks to implement, labelled exactly as the chat labels them. */
async function pickCodeBlock(blocks: readonly CodeBlock[]): Promise<CodeBlock | undefined> {
    const pick = await vscode.window.showQuickPick(
        blocks.map((block, index) => ({
            label: codeBlockLabel(block.code),
            description: `${index + 1} of ${blocks.length}${block.language ? ` · ${block.language}` : ''}`,
            block
        })),
        {
            title: 'Which block should be implemented?',
            placeHolder: 'The diff follows — nothing is written until you apply it'
        }
    );
    return pick?.block;
}

/** What a scope check needs from the caller, beyond the settings. */
interface ScopeGuardInput {
    cfg: AssistantConfig;
    /** The messages that would be sent — measured, not estimated from the sentence. */
    messages: ChatMessage[];
    /** The developer's own words: what the request is, and the only thing intent can be read from. */
    request: string;
    /** The facts the prompt carries, passed on to a hand-off. */
    facts?: OptionalFacts;
    /** The item the answer must reproduce, when the request is scoped to one. */
    item?: { name: string; text: string };
    /** The file the answer would have to be written into, when it is a whole file. */
    target?: { path: string; text: string };
    /** The project a hand-off would work in. */
    directory?: string;
}

/**
 * The pre-flight scope check, as a dialog the developer can answer.
 *
 * *"The extension must inspect each ask prompt to verify that it is within the scope of the ai model
 * capabilities. If not, warn the user and abort."* This is the warning and the abort, with the third answer the
 * user asked for as well: a **hand-off** to the pool agent, which is what makes the refusal useful rather than
 * merely correct.
 *
 * The three buttons mean three different things and are worth keeping distinct:
 *   - *Hand it to the pool agent* — the request and its context go to an agent that can hold them, after a
 *     consent dialog that names what leaves the machine;
 *   - *Send it anyway* — the developer outranks the check, and the reason is logged so a puzzling answer can be
 *     traced to the fact that the model never saw the whole prompt;
 *   - *Cancel* — nothing is sent.
 *
 * A check with nothing to hand off to (the setting is `off`, or `pool` is not installed) still refuses: the
 * point of the gate is that the developer is told *before* an answer arrives that looks authoritative and is
 * not.
 */
async function guardScope(input: ScopeGuardInput): Promise<boolean> {
    const verdict = checkScope({
        messages: input.messages,
        contextSize: input.cfg.contextSize,
        maxTokens: input.cfg.maxTokens,
        request: input.request,
        item: input.item,
        target: input.target
    });
    log(`assistant: ${scopeLogLine(verdict)}`);
    if (verdict.ok) return true;

    const canHandOff = handoffConfig().target !== 'off';
    // Named per offer: the button says which agent it will use, because "pool" stopped being the only answer.
    const action = await handoffAction();
    const buttons = canHandOff ? [action, 'Send it anyway', 'Cancel'] : ['Send it anyway', 'Cancel'];
    const pick = await vscode.window.showWarningMessage(
        `This is beyond what the local model can do here. ${verdict.message ?? ''}`,
        {
            modal: true,
            detail:
                `${verdict.advice ?? ''}\n\n` +
                'Sending it anyway asks the model for an answer about code it cannot see all of, which is how a ' +
                'file comes back shorter than it went in.'
        },
        ...buttons
    );
    if (pick === 'Send it anyway') {
        log(`assistant: scope override — ${verdict.problem} accepted by the developer`);
        return true;
    }
    if (pick === action) {
        await showHandoff(
            await handOff({
                request: input.request,
                refused: verdict.message,
                facts: factsText(input.facts),
                target: input.target,
                directory: input.directory ?? (await readActiveProject())?.folder.fsPath ?? process.cwd()
            })
        );
    }
    return false;
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
    const project = await readActiveProject();
    const facts = promptFacts({ document, text, project }, span);
    const room = Math.max(0, cfg.contextSize - cfg.maxTokens - PROMPT_SLACK);

    let messages: ChatMessage[];
    let dropped: string[];
    let apply: (code: string) => string;
    /** The item the answer must reproduce, when the request is scoped to one: what the scope check measures. */
    let item: { name: string; text: string } | undefined;

    if (span) {
        const offsets = itemOffsets(text, span);
        const func = text.slice(offsets.start, offsets.end);
        item = { name: span.name, text: func };
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

    // The gate (2026-10-12). An item longer than the model can rewrite is already refused above with its own
    // message; this is the rest of it — a prompt that does not fit the window at all, a sentence asking for a
    // whole file or the whole project — and it is the one place that can offer the hand-off instead.
    if (!(await guardScope({
        cfg,
        messages,
        request: description,
        facts,
        item,
        directory: project?.folder.fsPath
    }))) {
        return false;
    }

    // The window is shared: the prompt is read first and the answer gets what is left. Worked out here rather
    // than left to the server, because a prompt that fills the window is the ordinary reason an answer stops
    // mid-function, and the fix is a setting the developer can only act on if told the numbers.
    const contextSize = contextForBudget(cfg.contextSize, cfg.maxTokens);
    const promptTokens = estimateTokens(messages.map((message) => message.content).join('\n'));
    const budget = answerBudget(cfg.maxTokens, contextSize, promptTokens);
    const squeezed = squeezedAnswerNotice(budget, contextSize, promptTokens);
    if (squeezed !== undefined) {
        log(`assistant: answer budget ${budget.maxTokens} of ${cfg.maxTokens} tokens — prompting ${promptTokens}`);
        void vscode.window.showWarningMessage(squeezed);
    }

    let answer: ChatOutcome;
    try {
        answer = await runChat(
            { ...cfg, maxTokens: budget.maxTokens },
            messages,
            span ? `Rewriting ${span.name}…` : 'Writing a new function…'
        );
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

// ---------------- "implement this code" from the chat (asked 2026-10-04) ----------------
//
// *"In the ai assist chat box, if the response contains refactored code, add the option to implement that code
// in the project."* The chat is where a *question* gets answered — "how should this be structured", "why does
// this deadlock" — and a good answer often ends with the code, which the user then had to copy out by hand,
// find the file for, and paste. The button that appears under such an answer is that copy-paste, done with the
// rules the rest of the extension already follows: the right file, the right place in it, a **diff** to review,
// and one undoable edit.

/**
 * Where a chat answer's code should go, and what the file looks like afterwards.
 *
 * The target is the file in front of the user when it is a Rust file (that is what "implement this in my
 * project" almost always means), and otherwise a short list of the project's own sources plus "a new file…".
 * Never the *proposal* diff editor: applying code into a preview of a change would be a write to nowhere.
 */
async function chatCodeTarget(): Promise<vscode.Uri | undefined> {
    // The file in front of the user, without a question. "Implement this in my project" means this file in
    // every case but one, and the **diff names the file** before anything is written — so the quiet path is
    // still a visible choice, and a wrong one costs a Discard. (Asking here was the first version; it made a
    // two-item picker appear for every answer even with the target on screen, which is noise, not consent.)
    const active = vscode.window.activeTextEditor;
    if (active && active.document.languageId === 'rust' && active.document.uri.scheme === 'file') {
        return active.document.uri;
    }

    // No Rust file open (or the active editor is the proposal *preview*, which is a write to nowhere): offer
    // the project's own sources. Bounded, with the build output excluded — a `.rs` under `target/` is an
    // artifact, not a file to edit.
    type Item = vscode.QuickPickItem & { uri?: vscode.Uri; create?: boolean };
    const items: Item[] = [];
    let sources: vscode.Uri[] = [];
    try {
        sources = await vscode.workspace.findFiles('**/src/**/*.rs', '**/{target,.git,.dsh-worktrees,node_modules}/**', 25);
    } catch (error) {
        logError(error);
    }
    for (const uri of sources) {
        let short = uri.fsPath;
        try { short = vscode.workspace.asRelativePath(uri); } catch { /* keep the absolute path */ }
        items.push({ label: `$(file-code) ${short}`, uri });
    }
    items.push({ label: '$(new-file) A new file…', detail: 'pick a name and it is created', create: true });

    const pick = items.length === 1
        ? items[0]
        : await vscode.window.showQuickPick(items, {
            title: 'Where should this code go?',
            placeHolder: 'No Rust file is open — the diff shows the result before anything is written',
            ignoreFocusOut: true,
            matchOnDescription: true
        });
    if (!pick) return undefined;
    if (!pick.create) return pick.uri;

    const folder = sources[0] ? vscode.Uri.joinPath(sources[0], '..') : undefined;
    const chosen = await vscode.window.showSaveDialog({
        title: 'New Rust file for this code',
        saveLabel: 'Create it',
        filters: { Rust: ['rs'] },
        defaultUri: folder ? vscode.Uri.joinPath(folder, 'new_item.rs') : undefined
    });
    if (!chosen) return undefined;
    await vscode.workspace.fs.writeFile(chosen, new Uint8Array());
    return chosen;
}

/**
 * Puts one code block from a chat answer into a project file, after showing the diff.
 *
 * `showDiff` (on by default) is honoured exactly as the editor flows honour it: with it on the user reviews
 * the change and presses Apply; with it off the edit is written and a check is offered. Either way the write is
 * a normal undoable edit, and the diff names the file — which is why choosing the target can be quiet.
 */
export async function applyChatCode(code: string, opts: { label?: string } = {}): Promise<boolean> {
    const snippet = String(code ?? '').replace(/\s+$/, '');
    if (!snippet.trim()) return false;
    const target = await chatCodeTarget();
    if (!target) return false;

    let proposed: string;
    try {
        const document = await vscode.workspace.openTextDocument(target);
        const text = document.getText();
        // Before anything is proposed: an answer that leaves code out, or that claims to be the file but has
        // dropped items from it, is refused here rather than shown and applied (2026-10-12).
        const problem = chatCodeProblem(text, `${snippet}\n`);
        if (problem !== undefined) {
            log(`assistant: refused a chat answer — ${problem}`);
            void vscode.window.showWarningMessage(problem, { modal: true }, 'OK');
            return false;
        }
        proposed = insertChatCode(text, `${snippet}\n`);
        if (proposed === text) {
            void vscode.window.showInformationMessage(`That code is already in ${path.basename(target.fsPath)}.`);
            return false;
        }
    } catch (error) {
        logError(error);
        void vscode.window.showErrorMessage(`Could not read ${path.basename(target.fsPath)}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }

    // The file is in the title on purpose: the target was chosen without a question, so the diff is where the
    // user sees *which* file this is about.
    const title = `AI: ${opts.label ?? 'from the chat'} → ${path.basename(target.fsPath)}`;
    const isNew = (await vscode.workspace.openTextDocument(target)).getText().trim() === '';

    // A whole-file answer is the one case that replaces rather than changes, so it is asked about by name. The
    // button under the answer already says "the whole file"; this is the same fact at the moment it matters,
    // when the answer is in hand and the file it would overwrite has a size the user can recognise.
    if (!isNew && looksLikeWholeFile(`${snippet}\n`) && proposed !== `${snippet}\n`) {
        const lines = (await vscode.workspace.openTextDocument(target)).getText().split(/\r?\n/).length;
        const pick = await vscode.window.showWarningMessage(
            `This answer is a whole file, so applying it replaces all ${lines} lines of ` +
            `${path.basename(target.fsPath)} rather than changing one thing in it.`,
            { modal: true },
            'Replace the file',
            'Cancel'
        );
        if (pick !== 'Replace the file') return false;
    }

    if (configView(SETTINGS).get<boolean>('showDiff') === false) {
        if (!(await writeDocument(target, proposed))) {
            void vscode.window.showErrorMessage('The code could not be written — the file may be read-only.');
            return false;
        }
        void vscode.window.showInformationMessage(
            isNew ? `Created ${path.basename(target.fsPath)} with the code from the answer.` : `Rephrased into ${path.basename(target.fsPath)}.`
        );
        await checkProject();
        return true;
    }
    await showProposal(target, proposed, title);
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
    const project = await readActiveProject();
    const facts = promptFacts({ document, text, project }, span);
    const room = Math.max(0, cfg.contextSize - cfg.maxTokens - PROMPT_SLACK);
    const { messages } = fitMessages((f) => buildFixPrompt({ ...f, description: message, func }), facts, room);

    if (!(await guardScope({
        cfg,
        messages,
        request: message,
        facts,
        item: { name: span.name, text: func },
        directory: project?.folder.fsPath
    }))) {
        return false;
    }

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
        () => buildProject(project.folder.fsPath, { mode: 'check', env: espEnv() })
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
    /**
     * Why errors were skipped, one per error.
     *
     * The loop counts a skip as `no-fix` and moves on, which is right — but "nothing-fixable" then reads as
     * "these errors are not the kind anything can fix", when the usual reason is duller: the error sits in a
     * function larger than a small local model can rewrite. Found on a real project (2026-10-12) whose every
     * error was inside an 852-line `main`, so the report said nothing helpful about any of them.
     */
    const skipped: string[] = [];

    const report = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Fixing the build…', cancellable: true },
        async (progress, token) => {
            token.onCancellationRequested(() => {
                cancelled = true;
            });
            return repairUntilClean(
                {
                    build: async () => {
                        // `espEnv()` for the same reason the terminal path uses it: an ESP project cannot build
                        // without the Xtensa linker, and it is only on the PATH after espup's
                        // `~/export-esp.sh` — which the extension host has never sourced. Without this the
                        // build died in `build.rs`, reported no diagnostics, and the loop had nothing to fix
                        // (found on a real project, 2026-10-12).
                        const result = await buildProject(dir, { mode: 'check', env: espEnv() });
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
                        }, () => cancelled, skipped);
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
        // "Nothing was attempted" is the case that reads as a broken feature, so it says why.
        const why = report.applied === 0 && report.reverted === 0 && skipped.length > 0
            ? ` Nothing was attempted: ${skipped.slice(0, 3).join('; ')}.`
            : '';
        // The end of a failed repair run is the one place a hand-off is worth *offering* rather than waiting to
        // be asked for: every fix this loop could attempt has been attempted, the build is still broken, and the
        // errors it could not touch are usually exactly the ones that did not fit a small local model — an
        // 852-line `main`, most often (2026-10-12). One question, at the point the extension has genuinely run
        // out of ideas, rather than one dialog per error in the loop. The button, and the comparison against
        // what was clicked, are both the agent's own name — asked once, so no string is written twice.
        const canHandOff = handoffConfig().target !== 'off';
        const repairAction = await handoffAction();
        const pick = await vscode.window.showWarningMessage(
            `Stopped with ${report.remaining.length} error(s) left (${report.stoppedBecause}). ${rest.join('; ')}${why}`,
            ...(canHandOff ? [repairAction] : [])
        );
        if (pick === repairAction) {
            const repairFacts: OptionalFacts = {
                header: '',
                crates: crateList(project.cargoToml),
                target: '',
                sibling: '',
                rules: conventionsBlock(normaliseConventions(configView(SETTINGS).get('conventions'))),
                facts: boardFacts(project.board, project.chip)
            };
            await showHandoff(
                await handOff({
                    request: handOffForRepair(report.remaining),
                    refused: skipped.length
                        ? `The local model could not attempt these: ${skipped.slice(0, 5).join('; ')}`
                        : 'The local model tried and the build is still not clean.',
                    facts: factsText(repairFacts),
                    directory: dir
                })
            );
        }
    }
    return report;
}

/**
 * The scripted request for a build the local model could not fix.
 *
 * Written as a *goal with evidence* rather than as an instruction list: the errors are what the compiler said,
 * and the one constraint that matters — fix the cause, do not silence it — is the thing a rushed agent does
 * wrong (an `#[allow]`, or deleting the code that needs to work).
 */
function handOffForRepair(remaining: CompilerDiagnostic[]): string {
    const shown = remaining.slice(0, 10).map((d) => `- ${describeCompilerError(d)}: ${d.message}`);
    const rest = remaining.length > shown.length ? [`(and ${remaining.length - shown.length} more from the same build)`] : [];
    return [
        'Make this project build, without changing what the project is for.',
        '',
        '`cargo check` reports:',
        ...shown,
        ...rest,
        '',
        'Fix the cause of each error rather than silencing it: no `#[allow]` to hide it, and no deleting the code ' +
        'that needs to work. Keep the project\'s existing conventions.'
    ].join('\n');
}

/** One pass of the repair loop: locate the error, ask, write the edit. */
async function fixOne(
    cfg: AssistantConfig,
    error: CompilerDiagnostic,
    project: ActiveProject,
    remember: (uri: vscode.Uri, before: string) => void,
    cancelled: () => boolean,
    /** Collects the reason, for the summary the user reads when nothing could be attempted. */
    skipped: string[]
): Promise<'fixed' | 'no-fix' | 'failed'> {
    try {
        const uri = vscode.Uri.file(error.file);
        const document = await vscode.workspace.openTextDocument(uri);
        const text = document.getText();
        const span = enclosingFnSpan(text, Math.max(1, error.line));
        if (!span) {
            skipped.push(`${describeCompilerError(error)}: no function around it`);
            return 'no-fix';
        }
        const offsets = itemOffsets(text, span);
        const func = text.slice(offsets.start, offsets.end);
        if (methodTooLong(func)) {
            skipped.push(
                `${describeCompilerError(error)}: its function \`${span.name}\` is ` +
                `${func.split(/\r?\n/).length} lines, over the ${MAX_METHOD_LINES}-line limit a small local ` +
                'model can rewrite reliably'
            );
            return 'no-fix';
        }
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
/**
 * `Rusty AI: Forget the Handed-off Conversation` — the next hand-off starts a new conversation.
 *
 * A hand-off continues the last one by default (`poolResume`), which is what makes a second request add to what
 * the agent already did. The other half of that promise is being able to stop it: a conversation whose context
 * has gone stale — a different task, or a wrong turn the agent keeps defending — needs a way out that is not
 * "turn off the hand-off". Saying so when there is nothing to forget is worth a sentence: a command that
 * silently does nothing reads as broken.
 */
export async function forgetPoolRun(): Promise<void> {
    const had = lastRunId();
    await forgetRunId();
    log(`assistant: pool conversation ${had ? `forgotten (${had})` : 'was already empty'}`);
    void vscode.window.showInformationMessage(
        had
            ? 'The next hand-off to the pool agent will start a new conversation.'
            : 'There was no handed-off conversation to forget.'
    );
}

/**
 * `Rusty AI: Set the Hand-off API Key…` — the bearer token a cloud hand-off provider needs.
 *
 * The key never touches a setting, this file, the log, or the transcript: it is asked for with `password: true`
 * and stored in VS Code's **secret storage**, keyed by the endpoint it belongs to, so the value sent to one
 * provider cannot be sent to another. A prompt that could only be satisfied by pasting a secret into a chat
 * window is worse than no feature, so the key is typed here or read from a file the developer already has — and
 * when it is read from a file the dialog **names the file** first, because reading a credential the user did not
 * offer would be the wrong kind of helpful.
 */
export async function setHandoffApiKey(): Promise<void> {
    let cfg = handoffConfig();
    if (!cfg.cloudEndpoint) {
        // ASK, DO NOT WARN (reported 2026-10-13): *"Nothing happens when I click 'Open the AI settings' after 'Set
        // API key...'"*. The old version told the developer to go and set a setting first, and the button it
        // offered revealed a panel whose settings were collapsed — a dead end at the very start of the setup.
        // The endpoint is the first half of that setup, so it is asked for here, where the developer already is.
        const endpoint = await vscode.window.showInputBox({
            title: 'Cloud API for hand-offs',
            prompt: 'The OpenAI-compatible base URL of the provider. A trailing /v1 is added if you leave it off.',
            placeHolder: 'https://apihub.agnes-ai.com/v1',
            ignoreFocusOut: true
        });
        if (endpoint === undefined) return;
        if (!endpoint.trim()) {
            void vscode.window.showWarningMessage('A cloud API needs a URL, so nothing was saved.');
            return;
        }
        await updateSetting(configView(SETTINGS), 'cloudEndpoint', endpoint.trim());
        cfg = handoffConfig();
        log(`handoff: cloud endpoint set to ${cfg.cloudEndpoint || '(none)'}`);
        // And the model, which the provider chooses for itself if this is left empty.
        const model = await vscode.window.showInputBox({
            title: 'Model for the cloud API',
            prompt: `The model id ${cfg.cloudEndpoint} should answer with. Leave it empty to let the provider choose.`,
            placeHolder: 'agnes-2.5-flash',
            ignoreFocusOut: true
        });
        if (model?.trim()) {
            await updateSetting(configView(SETTINGS), 'cloudModel', model.trim());
            cfg = handoffConfig();
            log(`handoff: cloud model set to ${cfg.cloudModel}`);
        }
        // The scan's cached answer was taken before this provider existed.
        forgetAgentScan();
        await refreshPanels();
    }
    const existing = await handoffKey(cfg.cloudEndpoint);
    if (!existing) {
        const found = await findImportableKey();
        if (found) {
            const pick = await vscode.window.showInformationMessage(
                `A key for an OpenAI-compatible API is in ${found.path}. Use it for ${cfg.cloudEndpoint}?`,
                {
                    modal: true,
                    detail:
                        'The file is read once, now, and only if you agree. The key is kept in VS Code secret ' +
                        'storage — not in settings.json — and it is never displayed.'
                },
                'Use that key',
                'Type one instead',
                'Cancel'
            );
            if (pick === 'Cancel' || pick === undefined) return;
            if (pick === 'Use that key') {
                const stored = await setHandoffKey(cfg.cloudEndpoint, found.key);
                log(`handoff: API key imported from an env file — ${stored ? 'stored' : 'NOT stored'}`);
                if (stored) {
                    void vscode.window.showInformationMessage(
                        `Key stored for ${cfg.cloudEndpoint}. Hand-offs will use it.`
                    );
                } else {
                    void vscode.window.showErrorMessage(
                        "The key could not be stored — VS Code's secret storage did not accept it, so nothing was " +
                        'saved. A locked keyring is the usual reason; unlock it and try again.'
                    );
                }
                await refreshPanels();
                return;
            }
        }
    }
    const typed = await vscode.window.showInputBox({
        title: `API key for ${cfg.cloudEndpoint}`,
        prompt: existing
            ? 'A key is stored already. Type a new one to replace it, or leave the box empty to remove it.'
            : 'Paste the API key. It goes into VS Code secret storage, never into settings.json.',
        password: true,
        ignoreFocusOut: true
    });
    if (typed === undefined) return;
    const value = typed.trim();
    const stored = await setHandoffKey(cfg.cloudEndpoint, value);
    if (!stored) {
        void vscode.window.showErrorMessage(
            "The key could not be stored — VS Code's secret storage did not accept it, so nothing was saved. A " +
            'locked keyring is the usual reason; unlock it and try again.'
        );
    } else {
        void vscode.window.showInformationMessage(
            value ? `Key stored for ${cfg.cloudEndpoint}.` : `The stored key for ${cfg.cloudEndpoint} was removed.`
        );
    }
    await refreshPanels();
}

/**
 * `Rusty AI: Choose the Hand-off Agent…` — which of this machine's agents a refusal hands the job to.
 *
 * Asked for on 2026-10-13: *"The system must scan the machine to find and list all available API agents to allow
 * the user to select the one to hand off to."* The list **is** the scan, so it says what each one can actually
 * do rather than presenting a menu of names: an agent that can work in the project, one that can only answer a
 * prompt, one that is installed without a verified way to run it, and one that is not there at all are four
 * different situations and the picker spells each out. Choosing one the extension cannot drive is refused with
 * the reason instead of being saved and failing later.
 */
export async function chooseHandoffAgent(): Promise<void> {
    const cfg = handoffConfig();
    const candidates = await agentScan(true);
    const usable = (agent: AgentCandidate) => agent.available && agent.drivable;
    type Item = vscode.QuickPickItem & { id: string };
    const items: Item[] = [
        {
            id: '',
            label: '$(wand) Automatic',
            description: cfg.agentId ? 'let the extension choose' : 'in use',
            detail: 'Takes the first agent that can work in your project, and falls back to one that can answer.'
        },
        {
            id: '__rescan',
            label: '$(refresh) Rescan this machine',
            description: 'look again for CLI agents and listening servers'
        },
        ...candidates.map((agent) => ({
            id: agent.id,
            label: usable(agent) ? agent.label : `$(circle-slash) ${agent.label}`,
            description: agent.id === cfg.agentId ? 'chosen' : undefined,
            detail: describeAgent(agent)
        }))
    ];
    const runnable = candidates.filter(usable).length;
    const pick = await vscode.window.showQuickPick(items, {
        title: 'Which agent should a hand-off use?',
        placeHolder:
            runnable > 0
                ? `${runnable} agent(s) this extension can run`
                : 'nothing found that the extension can run — the list says why'
    });
    if (!pick) return;
    if (pick.id === '__rescan') return chooseHandoffAgent();
    const chosen = candidates.find((agent) => agent.id === pick.id);
    if (chosen && !usable(chosen)) {
        void vscode.window.showWarningMessage(`That agent cannot be used yet — ${describeAgent(chosen)}`);
        return;
    }
    await updateSetting(configView(SETTINGS), 'handoffAgent', pick.id);
    forgetAgentScan();
    log(`assistant: hand-off agent set to ${pick.id || '(automatic)'}`);
    void vscode.window.showInformationMessage(
        pick.id ? `Hand-offs will go to ${chosen?.label ?? pick.id}.` : 'Hand-offs will use the best agent available.'
    );
    await refreshPanels();
}

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
        vscode.commands.registerCommand('rustyPlatform.assistant.forgetPoolRun', () => forgetPoolRun()),
        vscode.commands.registerCommand('rustyPlatform.assistant.chooseAgent', () => chooseHandoffAgent()),
        vscode.commands.registerCommand('rustyPlatform.assistant.setHandoffKey', () => setHandoffApiKey()),
        new vscode.Disposable(() => {
            proposalContent.dispose();
            proposalBar?.dispose();
            proposalBar = undefined;
            disposeBuildDiagnostics();
            proposals.clear();
        })
    ];
}
