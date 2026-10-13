/* The AI assist's own surface: a chat, and the model settings under it.
 *
 * WHY A WEBVIEW VIEW AND NOT A TREE. The assistant is used by *talking to it* — a request, a streamed
 * answer, a follow-up — and by picking a model and watching it load. Neither is a list of things: a
 * `TreeDataProvider` cannot hold a transcript, a progress line or a settings form, and the designer's
 * experience (where the whole AI section lives inside a much larger designer webview) does not apply here
 * because there is no other webview to borrow.
 *
 * WHAT IT IS ALLOWED TO DO. Everything it shows comes from the same modules the Command Palette uses:
 * `panel.ts` owns the model state (`panelState`, `loadChoice`, `unloadEverything`), `editor.ts` owns the
 * editing flows, and this file is only the glass in front of them. That is deliberate — a second copy of
 * "which model is loaded" is how a panel ends up disagreeing with the commands.
 *
 * STREAMING IS THE POINT. A 3B model on a CPU needs 5-15 seconds for a short answer; the developer watches
 * characters arrive (posted per delta) instead of a frozen spinner. The transcript is in memory only: it is
 * a conversation about the code in front of you, not a document.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    assistantEnabled,
    describeEmptyAnswer,
    describeModel,
    rustCodeBlocks,
    type ChatMessage
} from '../ai/assistant';
import { describeProgress } from '../ai/assistant';
import { boardFacts } from '../ai/boardFacts';
import { conventionsBlock, normaliseConventions } from '../ai/conventions';
import { codeBlockLabel, crateList } from '../ai/rustCode';
import { log, logError } from '../ai/log';
import { readActiveProject } from '../project/activeProject';
import { panelState } from '../ai/panel';
import { applyChatCode, assistantConfig, chatWithRescue } from '../ai/editor';
import { checkScope, looksLikeChangeRequest, namedRustFile, scopeLogLine } from '../ai/scope';
import { handOff, handoffConfig, poolStatus, jcodeStatus, forgetPoolStatus, forgetJcodeStatus, reportText, agentScan, forgetAgentScan, onHandoffReport, type HandoffReport } from '../ai/handoff';
import { describeWrites, planWrites, type SettingSpec } from '../ai/panelSettings';
import { describeAgent, chooseAgent, handoffButtonLabel, agentShortName } from '../ai/agents';
import { findRunningLlamaServer } from '../ai/llamaServer';
import { endpointMismatchHint } from '../ai/localModels';

import { chooseLocalModel, unloadLoadedModel } from '../ai/localModelSetup';
import { registerAssistantSwitchCommands } from '../ai/assistantSwitch';
import { addModelFromHub, removeAddedModel } from '../ai/hubModels';
import { configView } from '../ai/settings';
import {
    chatsFor,
    emptyStore,
    newChat,
    parseStore,
    removeChat,
    upsertChat,
    type ChatStoreFile,
    type StoredChat
} from '../ai/chatStore';

/**
 * The chats on disk, the one being continued, and where the file lives — the "continue where I left off"
 * state (asked 2026-10-04). The data decisions are `chatStore.ts`; only the reading and writing are here.
 */
let store: ChatStoreFile = emptyStore();
let active: StoredChat | undefined;
let storeFile: string | undefined;
/**
 * The webviews showing this chat: the side-bar **view**, and any number of editor-**panel** tabs.
 *
 * WHY MORE THAN ONE (asked 2026-10-05): *"I would like the option to run the Chat window outside of the IDE on
 * a 2nd monitor. Is it possible to make it run in an editor pane which can be dragged outside of the IDE
 * window?"* A view is docked inside the window — VS Code has no way to drag one onto another monitor — while
 * an **editor tab can be dragged out into its own OS window**, which is what a second monitor is for. So the
 * chat is one piece of state broadcast to a set of surfaces: everything that renders goes to all of them, and
 * `post` is the only place that knows there is more than one. Two open surfaces are two mirrors of one
 * conversation, not two conversations.
 */
const surfaces = new Set<vscode.Webview>();
let busy = false;

/** Reads the chat file once, at registration. A missing or unreadable file is "no chats yet", not an error. */
function loadChats(context: vscode.ExtensionContext): void {
    storeFile = path.join(context.globalStorageUri.fsPath, 'ai-chats.json');
    try {
        store = parseStore(fs.readFileSync(storeFile, 'utf8'));
    } catch {
        store = emptyStore();
    }
}

/** Writes the chat file after a turn. A failed write must not break the conversation that caused it. */
function saveChats(): void {
    if (!storeFile) return;
    try {
        fs.mkdirSync(path.dirname(storeFile), { recursive: true });
        fs.writeFileSync(storeFile, JSON.stringify(store), 'utf8');
    } catch (error) {
        logError(error);
    }
}

/** The folder a chat belongs to; undefined in an empty window, which is its own group. */
function workspaceId(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function freshChat(): StoredChat {
    return newChat(`chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, workspaceId(), Date.now());
}

/** The chat to continue: the newest for this workspace, or a new empty one. */
function ensureActive(): StoredChat {
    const workspace = workspaceId();
    if (active && active.workspace === workspace) return active;
    const existing = chatsFor(store, workspace)[0];
    if (existing) {
        active = existing;
        return active;
    }
    active = freshChat();
    store = upsertChat(store, active);
    saveChats();
    return active;
}

/** Stores the chat that just changed, and renames it from its first question once there is one. */
function remember(): void {
    if (!active) return;
    active.updatedAt = Date.now();
    store = upsertChat(store, active);
    saveChats();
}

/**
 * The turns as the view wants them: each answer with the code blocks it carries, so the view can offer
 * "implement this" under it (asked 2026-10-04).
 *
 * The *detection* stays here rather than in the webview's own script: `rustCodeBlocks` is the pure, tested
 * rule for "is there code in this answer", and a second copy of it inside an HTML string would be a second
 * thing to keep true. The view receives labels and an index, and posts the index back.
 */
function turnsForView(turns: readonly { role: string; text: string }[]): { role: string; text: string; index: number; code?: string[] }[] {
    return turns.map((turn, index) => {
        const code = codeLabels(turn.role, turn.text);
        return code ? { role: turn.role, text: turn.text, index, code } : { role: turn.role, text: turn.text, index };
    });
}

/**
 * The code blocks to offer under a turn, or `undefined` when there is nothing to implement.
 *
 * One function, because a live turn and the restored history have to agree: a hand-off answer that grew its
 * "Implement" buttons only after the panel was reloaded was this rule written twice, once live and once for the
 * history, and the two disagreed (2026-10-13).
 */
function codeLabels(role: string, text: string): string[] | undefined {
    const blocks = role === 'assistant' ? rustCodeBlocks(text) : [];
    return blocks.length ? blocks.map((b) => codeBlockLabel(b.code)) : undefined;
}

/** The chat picker's contents, for the workspace being worked in. */
function postChats(): void {
    post({
        type: 'chats',
        chats: chatsFor(store, workspaceId()).map((chat) => ({
            id: chat.id,
            title: chat.title,
            updatedAt: chat.updatedAt
        })),
        activeId: active?.id ?? ''
    });
}

function nonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i += 1) out += chars[Math.floor(Math.random() * chars.length)] ?? 'a';
    return out;
}

/** Posts one message to every open surface (the view and any tab). */
function post(message: unknown): void {
    for (const surface of surfaces) void surface.postMessage(message);
}

/**
 * The project facts both the local prompt and a hand-off carry: the board, the crates, and the house rules.
 *
 * WHY THE RULES ARE PART OF THIS BLOCK (asked 2026-10-13: *"how to set up the rules for the cloud agents?"*). The
 * house rules are the only standing instructions a developer can give, and this is the one block that every prompt
 * is built from — the local chat, and every hand-off. For a cloud agent it is also the *only* place they can be
 * said: it never sees the project, so it cannot read a file of rules even if one existed. They were missing from
 * here, which made the setting's own description ("They are put in every prompt") true of the editor flows and
 * the repair hand-off and false of the chat's.
 */
async function projectFacts(): Promise<string> {
    const project = await readActiveProject();
    const parts: string[] = [];
    if (project?.board) parts.push(boardFacts(project.board, project.chip));
    if (project) parts.push(`Cargo.toml dependencies:\n${crateList(project.cargoToml)}`);
    parts.push(houseRules());
    return parts.filter(Boolean).join('\n\n');
}

/** The house rules as one block, or an empty string when the developer has accepted none. */
function houseRules(): string {
    return conventionsBlock(normaliseConventions(configView('rustyPlatform.assistant').get('conventions')));
}

/** The file the developer is looking at, clipped to what a small local model can afford to read. */
function fileBlock(): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'rust') return '';
    const text = editor.document.getText();
    const clipped = text.length > 12_000 ? `${text.slice(0, 12_000)}\n// … (file clipped)` : text;
    return `The file the developer is looking at (${vscode.workspace.asRelativePath(editor.document.uri)}):\n\`\`\`rust\n${clipped}\n\`\`\``;
}

/** The project context a question is answered against: the board, the crates, and the active file. */
async function contextBlock(): Promise<string> {
    return [await projectFacts(), fileBlock()].filter(Boolean).join('\n\n');
}

/**
 * The file a size check — or a hand-off — should measure, when there is one worth measuring.
 *
 * Three cases, and the reason they are separated is that measuring the wrong thing is worse than measuring
 * nothing:
 *   - a **selection** is the request's own scope: the prompt carries the selection, so a 41 KB file around it is
 *     irrelevant and nothing is refused;
 *   - a file **named in the sentence** is measured from disk, whether or not it is open — that is the arithmetic
 *     behind "rewrite src/main.rs" being a refusal rather than an instruction to guess;
 *   - a **change request with no selection** is measured against the file in front of the developer, because the
 *     answer has to be written *into* that file. A question is not measured at all: a clipped view is enough to
 *     explain something, and refusing explanations would be the wrong kind of strict (2026-10-12).
 */
async function askTarget(text: string): Promise<{ path: string; text: string } | undefined> {
    const editor = vscode.window.activeTextEditor;
    const openRust = editor && editor.document.languageId === 'rust';
    if (openRust && !editor.selection.isEmpty) return undefined;

    const named = namedRustFile(text);
    if (named) {
        const found = await vscode.workspace.findFiles(
            `**/${named}`,
            '**/{target,.git,.dsh-worktrees,node_modules}/**',
            1
        );
        const uri = found[0];
        if (!uri) return undefined;
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            return { path: named, text: Buffer.from(bytes).toString('utf8') };
        } catch {
            return undefined;
        }
    }

    if (openRust && looksLikeChangeRequest(text)) {
        return {
            path: vscode.workspace.asRelativePath(editor.document.uri),
            text: editor.document.getText()
        };
    }
    return undefined;
}

/**
 * The refusal the view's hand-off button refers to.
 *
 * Held here rather than sent to the webview and back, so what leaves the machine is what the extension decided
 * to refuse — not a round trip through HTML that a stale page could get wrong.
 */
let pendingHandoff: { request: string; refused: string; target?: { path: string; text: string } } | undefined;

/**
 * Puts what a hand-off returned into the conversation.
 *
 * WHY IT EXISTS (asked 2026-10-13: *"Can we equip it with the ability to generate diffs and on permission
 * implement it?"*). The buttons under an answer are built from the turn the extension **stores**, so an answer
 * that never becomes a turn can only be copied out by hand. Both ways of handing off — the chat's refusal button
 * and the repair loop's last offer — therefore arrive here, and get exactly what a local answer gets: the code
 * blocks travel with the turn, "Implement …" opens a diff against the file, and nothing is written until that
 * diff is applied (`applyChatCode`). The diff is also where a whole-file answer is refused or confirmed by name.
 *
 * A declined, switched-off or unstartable hand-off is not a turn: nothing was sent, so there is nothing to
 * implement, and the conversation should not fill with "nothing was sent".
 */
function addHandoffTurn(report: HandoffReport): void {
    if (report.kind !== 'answered' && report.kind !== 'done') return;
    const text = reportText(report);
    if (!text.trim()) return;
    const chat = ensureActive();
    chat.turns.push({ role: 'assistant', text });
    remember();
    postChats();
    post({ type: 'turn', role: 'assistant', text, final: true, index: chat.turns.length - 1, code: codeLabels('assistant', text) });
}

/** Runs the hand-off the developer asked for from a refusal. The turn it produces comes from `addHandoffTurn`. */
async function runHandoff(): Promise<void> {
    if (!pendingHandoff) {
        post({ type: 'error', message: 'That offer is no longer current — ask again and it will be back.' });
        return;
    }
    const pending = pendingHandoff;
    pendingHandoff = undefined;
    post({ type: 'busy', busy: true, message: `handing this to ${agentShortName(chooseAgent(await agentScan(), handoffConfig().agentId))}…` });
    try {
        // The report is announced by `handOff` itself, and the listener above turns it into a normal assistant
        // turn — so this flow no longer writes the turn, and a second caller gets the same entry for free.
        await handOff({
            request: pending.request,
            refused: pending.refused,
            facts: await projectFacts(),
            target: pending.target,
            directory: (await readActiveProject())?.folder.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
        });
    } catch (error) {
        logError(error);
        post({ type: 'error', message: `The hand-off failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
        post({ type: 'busy', busy: false });
    }
}

/** The system message for a free-form question. */
function chatSystem(context: string): ChatMessage {
    return {
        role: 'system',
        content:
            'You are a precise Rust coding assistant for embedded, often `no_std`, firmware built on the ' +
            'Embassy async framework. Answer in short, concrete Rust. Never invent a crate, a pin or an ' +
            'API that is not in the context below; if something is missing, say what is missing. Prefer ' +
            'showing the code to describing it.\n\n' +
            // The shape of the answer, spelled out because the shape is what decides whether applying it is
            // safe. A model that answers "add this to the loop" with a reconstructed whole file deletes
            // everything it did not feel like reproducing (2026-10-12), and a placeholder is the same mistake
            // with a comment on it.
            'When asked to change code, return ONLY the item that changes — the one `fn`, `impl` or `struct` — ' +
            'and leave every other item out of your answer entirely. Do not return the whole file unless the ' +
            'developer asks for the whole file. Never write `...`, `// ...` or any other placeholder for code ' +
            'you did not write: if something is too long to include, say so in a sentence instead of guessing. ' +
            'Never reproduce a file from the context to "keep it unchanged" — leaving it out is how it stays ' +
            'unchanged. Keep the file\'s own attributes, signature and names as they are; put any `use` a new ' +
            'path needs inside the function body, which is legal Rust.\n\n' +
            context
    };
}

async function ask(text: string): Promise<void> {
    if (busy) {
        post({ type: 'error', message: 'A request is already running — wait for it, or cancel it.' });
        return;
    }
    const cfg = assistantConfig();
    if (!assistantEnabled(cfg)) {
        post({
            type: 'error',
            message: 'The AI assist is off. Choose a backend and a model in the settings above.'
        });
        return;
    }
    const chat = ensureActive();
    chat.turns.push({ role: 'user', text });
    remember();
    postChats();
    post({ type: 'turn', role: 'user', text });

    busy = true;
    try {
        const context = await contextBlock();
        const messages: ChatMessage[] = [
            chatSystem(context),
            ...chat.turns.map((t) => ({ role: t.role, content: t.text }))
        ];

        // THE GATE (asked 2026-10-12): *"the extension must inspect each ask prompt to verify that it is within
        // the scope of the ai model capabilities. If not, warn the user and abort."* It runs before anything is
        // sent and before the "thinking…" line appears, because a request that is going nowhere should not
        // first look like it is going somewhere. The refusal is drawn as its own block with a hand-off button;
        // `pendingHandoff` holds what the button will send.
        const target = await askTarget(text);
        const verdict = checkScope({
            messages,
            contextSize: cfg.contextSize,
            maxTokens: cfg.maxTokens,
            request: text,
            target
        });
        log(`assistant: chat ${scopeLogLine(verdict)}`);
        if (!verdict.ok) {
            pendingHandoff = { request: text, refused: verdict.message ?? '', target };
            // The refusal is stored too, not only posted: a transcript with a question and no answer looks like a
            // lost reply when the panel is reopened, and it is also useful context for the next question.
            chat.turns.push({
                role: 'assistant',
                text: `⛔ ${verdict.message ?? ''}${verdict.advice ? `\n\n${verdict.advice}` : ''}`
            });
            remember();
            postChats();
            // The action names the agent this machine would really use, rather than saying "pool" whatever the
            // settings say (reported 2026-10-13).
            const handoff = handoffConfig();
            post({
                type: 'scope',
                problem: verdict.problem,
                message: verdict.message,
                advice: verdict.advice,
                handoff: handoff.target !== 'off',
                action: handoffButtonLabel(chooseAgent(await agentScan(), handoff.agentId))
            });
            return;
        }
        pendingHandoff = undefined;
        post({ type: 'busy', busy: true, message: 'thinking…' });

        const controller = new AbortController();
        // `chatWithRescue` resolves `bundled`'s endpoint (it only exists once the runtime is up) and, when the
        // address has nothing behind it, gets a llama-server up and sends the question again — the extension is
        // not allowed to end at "No server answered" while llama.cpp is on the disk (asked 2026-10-04).
        const outcome = await chatWithRescue(cfg, messages, {
            signal: controller.signal,
            onToken: (t) => post({ type: 'token', text: t }),
            // Tokens, elapsed and context, on the same half-second heartbeat the editor's notification uses.
            onProgress: (info) => post({ type: 'busy', busy: true, message: describeProgress(info) }),
            // The rescue's steps (starting or installing a llama-server) are progress, not silence.
            onStep: (message) => post({ type: 'busy', busy: true, message })
        });
        const answer = outcome.text.trim();
        if (!answer) {
            post({
                type: 'error',
                message: describeEmptyAnswer(outcome.text, {
                    reasoningChars: outcome.reasoning.length,
                    reasoningTokens: outcome.reasoningTokens,
                    finishReason: outcome.finishReason
                })
            });
            return;
        }
        chat.turns.push({ role: 'assistant', text: answer });
        remember();
        postChats();
        // The code blocks travel with the answer, so the buttons under it are the extension's decision and not
        // a second guess by the view (see `turnsForView`).
        const shown = turnsForView([{ role: 'assistant', text: answer }])[0];
        post({ type: 'turn', role: 'assistant', text: answer, final: true, index: chat.turns.length - 1, code: shown?.code });
    } catch (error) {
        logError(error);
        let message = error instanceof Error ? error.message : String(error);
        // The one failure where knowing what *is* running changes everything: "No server answered at
        // http://127.0.0.1:1234/v1" is a puzzle until the next sentence says a llama-server is answering on
        // 8080 (the exact report of 2026-10-04, where a stale form had overwritten the endpoint).
        if (/No server answered/i.test(message)) {
            const running = await findRunningLlamaServer(cfg.endpoint, { cacheMs: 0 }).catch(() => undefined);
            message += endpointMismatchHint(cfg.endpoint, running);
        }
        post({ type: 'error', message });
    } finally {
        busy = false;
        post({ type: 'busy', busy: false });
    }
}

/** Posts the model/settings state the panel renders. */
async function pushState(fresh = false): Promise<void> {
    try {
        const state = await panelState(fresh);
        const cfg = assistantConfig();
        const handoff = handoffConfig();
        // The probe is cached per command (see `handoff.poolStatus`), so this is one spawn per session rather
        // than one per refresh — and the answer is what lets the form say "not installed" before a hand-off is
        // ever attempted.
        const poolVersionText = handoff.target === 'off' ? '' : ((await poolStatus(handoff.command)) ?? '');
        // The same probe for the other CLI agent, on the same terms: asked once, cached, and only when a hand-off
        // is actually possible.
        const jcodeVersionText = handoff.target === 'off' ? '' : ((await jcodeStatus(handoff.jcodeCommand)) ?? '');
        post({
            type: 'state',
            state: {
                backend: cfg.backend,
                endpoint: cfg.endpoint,
                model: cfg.model,
                showDiff: cfg.showDiff,
                assistantOn: cfg.enabled,
                stopAtStartup: cfg.stopServersAtStartup,
                contextSize: cfg.contextSize,
                maxTokens: cfg.maxTokens,
                handoff: handoff.target,
                handoffAgent: handoff.agentId,
                cloudEndpoint: handoff.cloudEndpoint,
                cloudModel: handoff.cloudModel,
                poolCommand: handoff.command,
                poolAutoAllow: handoff.autoAllow,
                poolVersion: poolVersionText,
                jcodeCommand: handoff.jcodeCommand,
                jcodeProvider: handoff.jcodeProvider,
                jcodeModel: handoff.jcodeModel,
                jcodeVersion: jcodeVersionText,
                hint: state.hint,
                pinned: state.pinned,
                enabled: state.enabled,
                hostAllowed: state.host.aiAllowed,
                hostWarning: state.host.warning ?? (state.host.reasons[0] ?? '')
            } satisfies SettingsSnapshot
        });
        // The agent list arrives separately, because finding it means knocking on four ports and running
        // `--version`, and the panel must not wait for that to draw. The select is filled when it lands.
        void agentScan().then((list) =>
            post({
                type: 'agents',
                chosen: handoff.agentId,
                // Which agent the extension would really use. Decided here rather than in the view, so the
                // panel never grows a second copy of the choice — and so each agent's own settings can be shown
                // exactly when that agent is the one that will run (asked 2026-10-13).
                effective: chooseAgent(list, handoff.agentId)?.id ?? '',
                agents: list.map((agent) => ({
                    id: agent.id,
                    text: describeAgent(agent),
                    usable: agent.available && agent.drivable
                }))
            })
        );
    } catch (error) {
        logError(error);
        post({ type: 'error', message: `Could not read the model state: ${error instanceof Error ? error.message : String(error)}` });
    }
}

/** What the panel's settings block is rendered from. */
interface SettingsSnapshot {
    /** The switch itself, as the settings hold it (not "does the endpoint answer"). */
    assistantOn: boolean;
    stopAtStartup: boolean;
    backend: string;
    endpoint: string;
    model: string;
    showDiff: boolean;
    /**
     * The model's own two numbers (asked 2026-10-13). They are editable in the form because they are not
     * trivia: the scope gate measures every prompt against `contextSize` and every answer against `maxTokens`,
     * so between them they decide what can be asked for at once.
     */
    contextSize: number;
    maxTokens: number;
    /** Where a request the local model cannot take is handed off to, and how (`2026-10-12`). */
    handoff: string;
    /** Which agent was chosen (`2026-10-13`); empty means the best one available. */
    handoffAgent: string;
    /** A cloud OpenAI-compatible API offered as a hand-off provider (`2026-10-13`). The key is NOT here. */
    cloudEndpoint: string;
    cloudModel: string;
    poolCommand: string;
    poolAutoAllow: boolean;
    /** The version `pool --version` reported, or `''` when the command is not there. */
    poolVersion: string;
    /** The Agnes Code CLI's own three (`2026-10-13`): the executable, and what `-p` / `-m` should say. */
    jcodeCommand: string;
    jcodeProvider: string;
    jcodeModel: string;
    /** The version `jcode --version` reported, or `''` when the command is not there. */
    jcodeVersion: string;
    hint: string;
    pinned: string;
    enabled: boolean;
    hostAllowed: boolean;
    hostWarning: string;
}

/** The status line shown under the title: what is configured and whether it is answering. */
export async function statusLine(): Promise<string> {
    const cfg = assistantConfig();
    const project = await readActiveProject();
    const bits = [describeModel(cfg)];
    if (cfg.backend === 'external') {
        const state = await panelState();
        bits.push(state.pinned || 'nothing loaded now');
    }
    if (project?.chip) bits.push(`target ${project.chip}`);
    return bits.join(' · ');
}

/** Re-renders the panel, when one is open. Called after a model load or a settings change. */
export async function refreshAiChat(fresh = false): Promise<void> {
    if (surfaces.size === 0) return;
    await pushState(fresh);
    post({ type: 'status', text: await statusLine() });
}

/**
 * Wires one webview up as a chat surface, and takes it out of the set when it goes away.
 *
 * Both surfaces (the view and a panel tab) go through this, so they cannot drift: the same HTML, the same
 * message handling, the same transcript. The fresh `refreshAiChat(true)` at the end is what draws the
 * conversation into a surface that just opened — including one that was dragged onto another monitor.
 */
function attach(provider: AiChatViewProvider, webview: vscode.Webview): void {
    surfaces.add(webview);
    webview.options = { enableScripts: true };
    webview.html = html(webview);
    webview.onDidReceiveMessage((message: {
        type?: string;
        text?: string;
        command?: string;
        settings?: Record<string, unknown>;
    }) => {
        void provider.handle(message);
    });
    void refreshAiChat(true);
}

/**
 * "Open the Assistant in an Editor Tab" — the chat as an editor tab, which can be dragged onto a second monitor.
 *
 * *"Is it possible to make it run in an editor pane which can be dragged outside of the IDE window?"* Yes, and
 * this is the only shape that can: VS Code moves an **editor** into its own window when its tab is dragged out
 * (or `View: Move Editor into New Window`), while a side-bar view cannot leave the window at all. The panel is
 * a singleton — asking twice reveals the one that exists rather than stacking copies — and `retainContextWhen
 * Hidden` keeps the transcript alive while it is collapsed or behind another tab.
 */
let chatPanel: vscode.WebviewPanel | undefined;

/** The view type VS Code needs to recognise the tab it is asked to restore. */
const CHAT_PANEL_TYPE = 'rustyPlatform.assistantChat';

/** What a restored panel is told about itself. The transcript is not here: it lives in the chat store. */
interface ChatPanelState {
    title?: string;
}

/**
 * Wires a panel — new or restored — up as a chat surface.
 *
 * One function for both paths, because the restored one is exactly as real as the new one: it needs the icon,
 * it needs to be in the surface set or the transcript would not reach it, and it must clear `chatPanel` when it
 * is closed or the next "open the tab" would reveal a dead tab.
 */
function wireChatPanel(context: vscode.ExtensionContext, panel: vscode.WebviewPanel): void {
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.svg');
    chatPanel = panel;
    attach(new AiChatViewProvider(), panel.webview);
    panel.onDidDispose(() => {
        surfaces.delete(panel.webview);
        if (chatPanel === panel) chatPanel = undefined;
    });
    // What VS Code hands back to the serializer on the next start: the user may have renamed the tab, and a
    // title that resets itself every reload is a small rudeness.
}

/**
 * "Open the Assistant in an Editor Tab" — the chat as an editor tab, which can be dragged onto a second monitor.
 *
 * *"Is it possible to make it run in an editor pane which can be dragged outside of the IDE window?"* Yes, and
 * this is the only shape that can: VS Code moves an **editor** into its own window when its tab is dragged out
 * (or `View: Move Editor into New Window`), while a side-bar view cannot leave the window at all. The panel is
 * a singleton — asking twice reveals the one that exists rather than stacking copies — and `retainContextWhen
 * Hidden` keeps the transcript alive while it is collapsed or behind another tab.
 */
export function openChatPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
    if (chatPanel) {
        chatPanel.reveal(undefined, false);
        return chatPanel;
    }
    const panel = vscode.window.createWebviewPanel(
        CHAT_PANEL_TYPE,
        'Rusty AI Assistant',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] }
    );
    wireChatPanel(context, panel);
    log('assistant: the chat was opened as an editor tab (it can be dragged onto another monitor)');
    return panel;
}

function html(webview: vscode.Webview): string {
    const n = nonce();
    const csp = [
        `default-src 'none'`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${n}'`,
        `img-src ${webview.cspSource} https:`
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    :root { color-scheme: light dark; }
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground);
           padding: 8px; margin: 0; display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; gap: 8px; }
    h2 { font-size: 0.95em; margin: 0 0 4px; text-transform: uppercase; letter-spacing: .06em; opacity: .8; }
    #status { opacity: .85; font-size: .92em; }
    #log { flex: 1 1 auto; overflow-y: auto; border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px; min-height: 120px; }
    .turn { margin: 0 0 10px; white-space: pre-wrap; word-break: break-word; }
    .turn.user { color: var(--vscode-textLink-foreground); }
    .turn pre { background: var(--vscode-textCodeBlock-background); padding: 6px; border-radius: 4px; overflow-x: auto; }
    .busy { opacity: .8; font-style: italic; }
    .error { color: var(--vscode-errorForeground); white-space: pre-wrap; }
    /* A request the local model cannot take (2026-10-12). It is drawn as a block rather than as prose so it
       reads as the answer to the question, and the conversation does not look like it simply stopped. */
    .scope { border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border));
        border-left: 3px solid var(--vscode-editorWarning-foreground, #d7a12c); border-radius: 4px; padding: 8px; }
    .scope .advice { opacity: .9; margin-top: 6px; font-size: .95em; }
    .scope button { margin-top: 8px; }
    .scope button[disabled] { opacity: .6; cursor: default; }
    textarea, input, select { width: 100%; box-sizing: border-box; background: var(--vscode-input-background);
        color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 4px; }
    textarea { resize: vertical; min-height: 64px; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none;
        border-radius: 3px; padding: 5px 10px; cursor: pointer; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .row { display: flex; gap: 6px; align-items: center; }
    .row > * { flex: 1 1 auto; }
    .row > button { flex: 0 0 auto; }
    .codeActions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
    .codeActions button.applyCode { font-size: .9em; padding: 3px 8px; }
    details { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px; }
    summary { cursor: pointer; opacity: .9; }
    label { display: block; margin: 6px 0 2px; font-size: .9em; opacity: .9; }
</style>
</head>
<body>
    <div>
        <h2>AI Assist</h2>
        <div id="status">…</div>
    </div>
    <div class="row" id="assistSwitch">
        <label title="Off unloads every local model and stops the llama-server; on starts what the settings say to start">
            <input id="assistOn" type="checkbox" style="width:auto"> <span id="assistOnLabel">AI assist is off</span>
        </label>
    </div>
    <div class="row" id="chatbar">
        <select id="chats" title="Earlier conversations in this project"></select>
        <button id="newChat" class="secondary" title="Start a new conversation">New</button>
        <button id="deleteChat" class="secondary" title="Delete this conversation">Delete</button>
    </div>
    <div id="log"></div>
    <div id="progress" class="busy" hidden></div>
    <textarea id="prompt" placeholder="Ask about this project, or describe a change — e.g. &quot;blink the on-board LED once a second&quot;"></textarea>
    <div class="row">
        <button id="ask">Ask</button>
        <button id="implement" class="secondary" title="Insert a ✎ AI block at the caret">Implement in Function…</button>
        <button id="repair" class="secondary" title="Run cargo check and fix what it can">Fix the Build…</button>
    </div>
    <details>
        <summary>Model &amp; settings</summary>
        <label>Backend</label>
        <select id="backend">
            <option value="off">Off</option>
            <option value="external">A server I run (OpenAI-compatible)</option>
            <option value="bundled">The extension's own runtime</option>
        </select>
        <label>Endpoint</label>
        <input id="endpoint" type="text" placeholder="http://127.0.0.1:1234/v1">
        <label>Model id (empty = the server decides)</label>
        <input id="model" type="text" placeholder="qwen2.5-coder-7b-instruct">
        <label><input id="showDiff" type="checkbox" style="width:auto"> Show a diff before applying</label>
        <label title="A window that opens with the assistant off unloads the models and stops the llama-server"><input id="stopAtStartup" type="checkbox" style="width:auto"> Stop the local servers when a window starts with the assist off</label>
        <label title="The context window the bundled runtime is started with, in tokens. 0 lets the extension size it to hold the answer budget plus 2048. Every prompt is measured against this before it is sent, so it is also what decides whether a request is refused as too big for this model.">Context window (tokens)</label>
        <input id="contextSize" type="number" min="0" max="262144" step="512" title="The window, in tokens. 0 = size it to fit the answer budget.">
        <label title="The longest answer the model may write. Raising it for a thinking model leaves less room for the prompt inside the same window, so the two numbers belong together.">Longest answer (tokens)</label>
        <input id="maxTokens" type="number" min="64" max="8192" step="64" title="The answer budget, in tokens.">
        <label>When a request is beyond the local model</label>
        <select id="handoff" title="The switch, not the agent: whether a request the local model cannot take may be handed to another agent at all. Which agent is the next control.">
            <option value="off">Warn me and stop</option>
            <option value="pool">Hand it to an agent</option>
        </select>
        <label title="What the agent list below is: this machine's own agents, with what each one can actually do. Scanned from the PATH and from the usual local ports, so an agent that edits your project can be told apart from a server that only answers.">Which agent a hand-off uses</label>
        <select id="handoffAgent" title="The list is this machine's own agents, with what each one can actually do.">
            <option value="">Automatic — the best available</option>
        </select>
        <div class="row">
            <button id="chooseAgent" class="secondary" title="Scan this machine again and pick from the full list, with reasons for anything that cannot be used">Rescan and choose…</button>
        </div>
        <label title="A cloud OpenAI-compatible API offered as a hand-off provider, e.g. https://apihub.agnes-ai.com/v1. A trailing /v1 is added for you. It cannot be discovered by scanning, so it is named here — and it then appears in the agent list above. Its key is stored in VS Code secret storage, never in settings.json.">Cloud API (hand-off provider)</label>
        <input id="cloudEndpoint" placeholder="https://…/v1">
        <label title="The model id the cloud API should answer with, e.g. agnes-2.5-flash. Empty lets the provider choose.">Cloud model</label>
        <input id="cloudModel" placeholder="e.g. agnes-2.5-flash">
        <div class="row">
            <button id="setKey" class="secondary" title="Store the API key for the endpoint above in VS Code secret storage (it is never shown or logged). Until it is stored, the cloud agent appears in the list marked as unusable.">Set the cloud API key…</button>
        </div>
        <div id="poolSettings" hidden>
            <label title="Only used when the Poolside CLI is the chosen agent, which is why it is shown only then.">The pool command</label>
            <input id="poolCommand" placeholder="pool" title="The Poolside CLI executable. Its own model is the platform's choice, not a setting here.">
            <div id="poolStatus" class="busy" hidden></div>
            <label title="A non-interactive run cannot answer an approval prompt, so with this off a hand-off that needs to edit a file stops and does nothing"><input id="poolAutoAllow" type="checkbox" style="width:auto"> Let the handed-off agent use its tools without asking</label>
        </div>
        <div id="jcodeSettings" hidden>
            <label title="Only used when the Agnes Code CLI is the chosen agent, which is why it is shown only then.">The Agnes Code CLI command</label>
            <input id="jcodeCommand" placeholder="jcode" title="The jcode executable. It works in this project — reading, writing and running commands — and its tools run without asking you first.">
            <div id="jcodeStatus" class="busy" hidden></div>
            <label title="Passed as jcode's -p. Empty lets jcode's own configuration decide; the Agnes endpoint is reached through its openai-compatible provider.">Provider (-p)</label>
            <input id="jcodeProvider" placeholder="openai-compatible">
            <label title="Passed as jcode's -m. Empty lets jcode's own configuration decide.">Model (-m)</label>
            <input id="jcodeModel" placeholder="agnes-2.5-flash">
        </div>
        <div class="row" style="margin-top:8px">
            <button id="save">Save</button>
            <button id="choose" class="secondary">Choose a local model…</button>
            <button id="unload" class="secondary">Unload</button>
            <button id="statusBtn" class="secondary">Status…</button>
            <button id="openEditorTab" class="secondary" title="Open this chat in an editor tab, which can be dragged onto a second monitor">In Editor Tab…</button>
        </div>
        <div id="settingsMessage" class="busy" hidden></div>
    </details>
<script nonce="${n}">
    const vscode = acquireVsCodeApi();
    const log = document.getElementById('log');
    const progress = document.getElementById('progress');
    let current = null;

    function render(text) {
        // Very small renderer: fenced blocks become <pre>, everything else stays escaped text.
        const escaped = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        const parts = escaped.split(/\`\`\`/);
        return parts.map((part, i) => (i % 2 === 1 ? '<pre>' + part.replace(/^\\w*\\n/, '') + '</pre>' : part)).join('');
    }

    // The "implement this code" buttons under an answer (asked 2026-10-04). What is offered comes from the
    // extension (one label per Rust block, plus the turn index); the view only draws them and posts the index
    // back, so there is no second copy of the rule "is there code in this answer".
    function addCodeActions(div, turn) {
        if (!turn || !turn.code || !turn.code.length) return;
        const row = document.createElement('div');
        row.className = 'codeActions';
        turn.code.forEach((label, block) => {
            const button = document.createElement('button');
            button.className = 'applyCode';
            button.textContent = turn.code.length === 1
                ? 'Implement ' + label + ' in the project…'
                : 'Implement ' + label + ' (' + (block + 1) + ' of ' + turn.code.length + ')…';
            button.title = 'Shows a diff against the file, then applies it as a normal undoable edit';
            button.addEventListener('click', () => vscode.postMessage({ type: 'applyCode', index: turn.index, block: block }));
            row.appendChild(button);
        });
        div.appendChild(row);
    }

    function addTurn(role, text, live, turn) {
        if (live && current && current.dataset.role === role) {
            current.dataset.text += text;
            current.innerHTML = render(current.dataset.text);
            return;
        }
        const div = document.createElement('div');
        div.className = 'turn ' + role;
        div.dataset.role = role;
        div.dataset.text = text;
        div.innerHTML = render(text);
        if (role === 'assistant' && !live) addCodeActions(div, turn);
        log.appendChild(div);
        current = div;
        log.scrollTop = log.scrollHeight;
    }

    function settleTurn(role, text, turn) {
        // The completed turn — not another one. The streamed pieces already drew this answer, so the
        // authoritative text replaces them; appending it is what rendered every answer twice (2026-10-04).
        if (current && current.dataset.role === role) {
            current.dataset.text = text;
            current.innerHTML = render(text);
            if (role === 'assistant') addCodeActions(current, turn);
            log.scrollTop = log.scrollHeight;
            return;
        }
        addTurn(role, text, false, turn);
    }

    // The refusal block: what the model could not do, what to do instead, and the hand-off button when there is
    // somewhere to hand the job to. Clearing the current turn matters — without it the next streamed answer
    // would be appended into this block instead of replacing it.
    function showScope(msg) {
        const div = document.createElement('div');
        div.className = 'turn assistant scope';
        const head = document.createElement('div');
        head.textContent = '⛔ ' + (msg.message || 'That request is beyond what the local model can do.');
        div.appendChild(head);
        if (msg.advice) {
            const advice = document.createElement('div');
            advice.className = 'advice';
            advice.textContent = msg.advice;
            div.appendChild(advice);
        }
        if (msg.handoff) {
            const button = document.createElement('button');
            button.textContent = msg.action || 'Hand it to an agent…';
            button.addEventListener('click', () => {
                // One press is one hand-off: the server holds what to send, and asks for consent before it goes.
                button.disabled = true;
                vscode.postMessage({ type: 'handoff' });
            });
            div.appendChild(button);
        }
        log.appendChild(div);
        current = null;
        log.scrollTop = log.scrollHeight;
    }

    function setBusy(busy, message) {
        if (busy) {
            progress.hidden = false;
            progress.textContent = message || 'working…';
        } else {
            progress.hidden = true;
            progress.textContent = '';
            current = null;
        }
    }

    function setting(id, value) {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.type === 'checkbox') el.checked = !!value;
        else el.value = value === undefined || value === null ? '' : String(value);
    }

    // What the fields were last *told* the truth is. Save sends only the fields that differ from this, which
    // is what stops a form that has not caught up from writing a stale address over a fresh pin: on
    // 2026-10-04 the view still held LM Studio's 1234 after "use the llama-server on 8080", the user pressed
    // Save, and every prompt after that failed with "No server answered" (see refreshAssistantView).
    let applied = { backend: '', endpoint: '', model: '', showDiff: false, contextSize: '', maxTokens: '', handoff: '', handoffAgent: '', cloudEndpoint: '', cloudModel: '', poolCommand: '', poolAutoAllow: false, jcodeCommand: '', jcodeProvider: '', jcodeModel: '' };

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg.type === 'state') {
            const s = msg.state || {};
            setting('backend', s.backend);
            setting('endpoint', s.endpoint);
            setting('model', s.model);
            setting('showDiff', s.showDiff);
            // The switch: the checkbox shows the *setting*, and the label spells out what the position means,
            // because "off" here stops servers rather than merely pausing requests.
            setting('assistOn', s.assistantOn);
            setting('stopAtStartup', s.stopAtStartup);
            // The model's two numbers, and the reason they are on the form: a request the gate refuses is
            // usually refused because of one of them.
            setting('contextSize', s.contextSize);
            setting('maxTokens', s.maxTokens);
            // The hand-off fields, and the one piece of news about them: whether the command is actually there.
            setting('handoff', s.handoff);
            setting('poolCommand', s.poolCommand);
            setting('cloudEndpoint', s.cloudEndpoint);
            setting('cloudModel', s.cloudModel);
            setting('jcodeCommand', s.jcodeCommand);
            setting('jcodeProvider', s.jcodeProvider);
            setting('jcodeModel', s.jcodeModel);
            // The switch and the agent list decide whose own settings are worth showing at all.
            refreshAgentSettings();
            setting('poolAutoAllow', s.poolAutoAllow);
            const poolStatusEl = document.getElementById('poolStatus');
            if (poolStatusEl) {
                const show = s.handoff === 'pool';
                poolStatusEl.hidden = !show;
                poolStatusEl.textContent = !show
                    ? ''
                    : s.poolVersion
                        ? 'pool ' + s.poolVersion + ' found — a hand-off will run it in this project'
                        : 'Not found: install the Poolside CLI, or set the command above to its full path';
            }
            const jcodeStatusEl = document.getElementById('jcodeStatus');
            if (jcodeStatusEl) {
                // Same news as the pool line, in this agent's terms — and this one names the thing a user of it
                // most needs to know before agreeing: it works in the project.
                const show = s.handoff !== 'off';
                jcodeStatusEl.hidden = !show;
                jcodeStatusEl.textContent = !show
                    ? ''
                    : s.jcodeVersion
                        ? 'jcode ' + s.jcodeVersion + ' found — a hand-off will let it work in this project'
                        : 'Not found: install the Agnes Code CLI, or set the command above to its full path';
            }
            const switchLabel = document.getElementById('assistOnLabel');
            if (switchLabel) {
                switchLabel.textContent = s.assistantOn
                    ? 'AI assist is on — turn it off to unload and stop'
                    : 'AI assist is off — turn it on to start the model';
            }
            applied = {
                backend: s.backend === undefined || s.backend === null ? '' : String(s.backend),
                endpoint: s.endpoint === undefined || s.endpoint === null ? '' : String(s.endpoint),
                model: s.model === undefined || s.model === null ? '' : String(s.model),
                showDiff: !!s.showDiff,
                contextSize: s.contextSize === undefined || s.contextSize === null ? '' : String(s.contextSize),
                maxTokens: s.maxTokens === undefined || s.maxTokens === null ? '' : String(s.maxTokens),
                handoff: s.handoff === undefined || s.handoff === null ? '' : String(s.handoff),
                handoffAgent: s.handoffAgent === undefined || s.handoffAgent === null ? '' : String(s.handoffAgent),
                cloudEndpoint: s.cloudEndpoint === undefined || s.cloudEndpoint === null ? '' : String(s.cloudEndpoint),
                cloudModel: s.cloudModel === undefined || s.cloudModel === null ? '' : String(s.cloudModel),
                poolCommand: s.poolCommand === undefined || s.poolCommand === null ? '' : String(s.poolCommand),
                poolAutoAllow: !!s.poolAutoAllow,
                jcodeCommand: s.jcodeCommand === undefined || s.jcodeCommand === null ? '' : String(s.jcodeCommand),
                jcodeProvider: s.jcodeProvider === undefined || s.jcodeProvider === null ? '' : String(s.jcodeProvider),
                jcodeModel: s.jcodeModel === undefined || s.jcodeModel === null ? '' : String(s.jcodeModel)
            };
        } else if (msg.type === 'status') {
            document.getElementById('status').textContent = msg.text || '';
        } else if (msg.type === 'history') {
            // A restored conversation: the turns already happened, so they are drawn at once, not streamed.
            log.innerHTML = '';
            current = null;
            for (const turn of msg.turns || []) addTurn(turn.role, turn.text, false, turn);
        } else if (msg.type === 'chats') {
            setChats(msg.chats, msg.activeId);
        } else if (msg.type === 'agents') {
            setAgents(msg.agents, msg.chosen, msg.effective);
        } else if (msg.type === 'openSettings') {
            openSettingsBlock();
        } else if (msg.type === 'turn') {
            if (msg.final) settleTurn(msg.role, msg.text, msg);
            else addTurn(msg.role, msg.text, false, msg);
        } else if (msg.type === 'token') {
            addTurn('assistant', msg.text, true);
        } else if (msg.type === 'busy') {
            setBusy(msg.busy, msg.message);
        } else if (msg.type === 'scope') {
            showScope(msg);
        } else if (msg.type === 'error') {
            addTurn('assistant', '⚠ ' + msg.message, false);
            const div = log.lastElementChild;
            if (div) div.classList.add('error');
        }
    });

    document.getElementById('ask').addEventListener('click', () => {
        const box = document.getElementById('prompt');
        const text = box.value.trim();
        if (!text) return;
        box.value = '';
        vscode.postMessage({ type: 'ask', text });
    });
    document.getElementById('prompt').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) document.getElementById('ask').click();
    });
    // Opens the settings section and puts the caret in it. The block is a details element that starts closed, so
    // without this the panel can be revealed and still show nothing that answers "where are the settings?".
    function openSettingsBlock() {
        const block = document.querySelector('details');
        if (block) {
            block.open = true;
            if (block.scrollIntoView) block.scrollIntoView({ block: 'start' });
        }
        // The cloud endpoint is what the key flow needs first, so it is the field worth landing on; the same
        // function is harmless for the general "open the settings" case.
        const field = document.getElementById('cloudEndpoint') || document.getElementById('backend');
        if (field && field.focus) field.focus();
    }

    // THE CHOSEN AGENT'S OWN SETTINGS, shown only for the agent that will run (asked 2026-10-13: *"the 'The pool
    // command' entry box must not be visible when 'Hand it to the pool agent' is not selected"*, and the same
    // question applies the moment there are two CLI agents). With a cloud API chosen, a box asking which "pool"
    // executable to run is a question with no referent; with jcode chosen, pool's is. "effective" is the server's
    // answer to "which agent would really be used", so this view decides nothing about the choice itself.
    let effectiveAgent = '';
    /** The agent a hand-off would really use: an explicit pick, otherwise what the scan decided. */
    function willRun() {
        const select = document.getElementById('handoffAgent');
        return (select ? select.value : '') || effectiveAgent;
    }
    function refreshAgentSettings() {
        const who = document.getElementById('handoff').value === 'off' ? '' : willRun();
        const pool = document.getElementById('poolSettings');
        if (pool) pool.hidden = who !== 'cli:pool';
        const jcode = document.getElementById('jcodeSettings');
        if (jcode) jcode.hidden = who !== 'cli:jcode';
    }

    function setAgents(list, chosen, effective) {
        effectiveAgent = effective || '';
        const select = document.getElementById('handoffAgent');
        if (!select) return;
        select.innerHTML = '';
        const auto = document.createElement('option');
        auto.value = '';
        auto.textContent = 'Automatic — the best available';
        select.appendChild(auto);
        for (const agent of list || []) {
            const option = document.createElement('option');
            option.value = agent.id;
            option.textContent = agent.text;
            // Shown, but not selectable: an agent that is installed without a verified way to run it is worth
            // seeing — that is the difference between "the extension cannot see my agent" and "it can see it
            // and cannot drive it yet".
            option.disabled = !agent.usable;
            select.appendChild(option);
        }
        select.value = chosen || '';
        // The select is filled from the scan, so it is also what the Save diff compares against.
        applied.handoffAgent = String(chosen || '');
        refreshAgentSettings();
    }

    function setChats(list, activeId) {
        const select = document.getElementById('chats');
        select.innerHTML = '';
        for (const chat of list || []) {
            const option = document.createElement('option');
            option.value = chat.id;
            option.textContent = chat.title;
            if (chat.id === activeId) option.selected = true;
            select.appendChild(option);
        }
    }
    document.getElementById('chats').addEventListener('change', (event) => {
        vscode.postMessage({ type: 'selectChat', chatId: event.target.value });
    });
    document.getElementById('newChat').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
    document.getElementById('deleteChat').addEventListener('click', () => vscode.postMessage({ type: 'deleteChat' }));
    document.getElementById('implement').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'rustyPlatform.assistant.implement' }));
    document.getElementById('repair').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'rustyPlatform.assistant.repair' }));
    document.getElementById('statusBtn').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'rustyPlatform.assistant.status' }));
    document.getElementById('choose').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'rustyPlatform.assistant.setupModel' }));
    document.getElementById('chooseAgent').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'rustyPlatform.assistant.chooseAgent' }));
    // Picking another agent hides the pool fields before the settings are even saved, so the form cannot show a
    // control that has stopped being relevant.
    document.getElementById('handoffAgent').addEventListener('change', () => refreshAgentSettings());
    document.getElementById('handoff').addEventListener('change', () => refreshAgentSettings());
    document.getElementById('setKey').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'rustyPlatform.assistant.setHandoffKey' }));
    document.getElementById('unload').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'rustyPlatform.assistant.unloadModel' }));
    // The switch. The checkbox is not the state — the host's snapshot is — so a failed turn-on snaps it back
    // when the panel is refreshed rather than leaving a checkbox that claims something untrue.
    document.getElementById('assistOn').addEventListener('change', () => vscode.postMessage({ type: 'command', command: 'rustyPlatform.assistant.toggle' }));
    document.getElementById('stopAtStartup').addEventListener('change', (event) => {
        vscode.postMessage({ type: 'save', settings: { stopServersAtStartup: event.target.checked } });
    });
    document.getElementById('openEditorTab').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'rustyPlatform.assistant.openEditor' }));
    document.getElementById('save').addEventListener('click', () => {
        // A number box that was emptied must not become 0. For contextSize 0 is meaningful — it means "size the
        // window to fit the answer budget" — but for maxTokens it would clamp to 64 and quietly starve every
        // answer, which is the sort of silent change this form exists to avoid. A blank box therefore keeps
        // whatever the settings already say, so the diff is empty and nothing is written.
        const numberBox = (id, fallback) => {
            const raw = document.getElementById(id).value.trim();
            const value = Number(raw);
            return raw === '' || !Number.isFinite(value) ? fallback : value;
        };
        const now = {
            backend: document.getElementById('backend').value,
            endpoint: document.getElementById('endpoint').value,
            model: document.getElementById('model').value,
            showDiff: document.getElementById('showDiff').checked,
            contextSize: numberBox('contextSize', applied.contextSize),
            maxTokens: numberBox('maxTokens', applied.maxTokens),
            handoff: document.getElementById('handoff').value,
            handoffAgent: document.getElementById('handoffAgent').value,
            cloudEndpoint: document.getElementById('cloudEndpoint').value,
            cloudModel: document.getElementById('cloudModel').value,
            poolCommand: document.getElementById('poolCommand').value,
            poolAutoAllow: document.getElementById('poolAutoAllow').checked,
            jcodeCommand: document.getElementById('jcodeCommand').value,
            jcodeProvider: document.getElementById('jcodeProvider').value,
            jcodeModel: document.getElementById('jcodeModel').value
        };
        // Only the fields the user actually changed. Sending all of them would make a form that is showing
        // yesterday's endpoint overwrite the one a load just pinned.
        const settings = {};
        for (const key of Object.keys(now)) {
            if (String(now[key]) !== String(applied[key])) settings[key] = now[key];
        }
        vscode.postMessage({ type: 'save', settings });
    });

    vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

/** The provider VS Code asks for the view's HTML and forwards its messages to. */
export class AiChatViewProvider implements vscode.WebviewViewProvider {
    resolveWebviewView(webviewView: vscode.WebviewView): void {
        attach(this, webviewView.webview);
    }

    /** Public because both surfaces (the view and an editor-tab panel) funnel into the same handler. */
    async handle(message: {
        type?: string;
        text?: string;
        command?: string;
        chatId?: string;
        settings?: Record<string, unknown>;
        /** `applyCode`: which turn, and which of its code blocks. */
        index?: number;
        block?: number;
    }): Promise<void> {
        switch (message.type) {
            case 'ready': {
                // The chat is restored before anything else is drawn, so reopening the view shows the
                // conversation instead of an empty page (the server posted it before; the webview dropped it).
                const chat = ensureActive();
                post({ type: 'history', turns: turnsForView(chat.turns) });
                postChats();
                // A settings request that arrived while this surface was still loading is honoured now.
                if (pendingSettings) postSettingsOnce();
                await refreshAiChat(true);
                return;
            }
            case 'ask':
                if (message.text) await ask(message.text);
                return;
            case 'handoff':
                await runHandoff();
                return;
            case 'newChat': {
                active = freshChat();
                store = upsertChat(store, active);
                saveChats();
                post({ type: 'history', turns: [] });
                postChats();
                return;
            }
            case 'selectChat': {
                const wanted = store.chats.find((chat) => chat.id === message.chatId);
                if (!wanted) return;
                active = wanted;
                post({ type: 'history', turns: turnsForView(wanted.turns) });
                postChats();
                return;
            }
            case 'deleteChat': {
                if (active) store = removeChat(store, active.id);
                active = undefined;
                saveChats();
                const chat = ensureActive();
                post({ type: 'history', turns: turnsForView(chat.turns) });
                postChats();
                return;
            }
            case 'applyCode': {
                // The button under an answer: the block is taken from the *stored* turn, so what is applied is
                // what the conversation actually says — not a copy the view kept.
                const turn = active?.turns[message.index ?? -1];
                const blocks = turn && turn.role === 'assistant' ? rustCodeBlocks(turn.text) : [];
                const block = blocks[message.block ?? 0];
                if (!block) {
                    post({ type: 'error', message: 'That code is no longer in this conversation — ask again and it will be.' });
                    return;
                }
                await applyChatCode(block.code, { label: codeBlockLabel(block.code) });
                return;
            }
            case 'command':
                if (message.command) {
                    try {
                        await vscode.commands.executeCommand(message.command);
                    } catch (error) {
                        logError(error);
                    }
                }
                return;
            case 'save':
                await this.save(message.settings ?? {});
                return;
            default:
                return;
        }
    }

    /**
     * Writes the panel's settings, whatever the form sent.
     *
     * THE BUG THIS REPLACES (reported 2026-10-13, *"It is not in the hand-off agent list"*). This method listed
     * the keys it would write **by hand** — five of them — so `contextSize`, `maxTokens`, and the whole hand-off
     * group including the cloud endpoint were sent by the form, compared by `applied`, and then **dropped here**.
     * The panel refreshed from settings that had never been written, the field reverted, and the feature that
     * field configures never saw the value. A developer's reasonable reading of that is "the extension did not
     * save my setting", which is exactly what they reported.
     *
     * The list is gone: the manifest already says which settings exist and what type each is, so the payload is
     * checked against it (`planWrites`) and a key it does not declare is refused *out loud* rather than silently
     * ignored. Adding a field to the form is now enough to make it saveable.
     */
    private async save(settings: Record<string, unknown>): Promise<void> {
        // The view sends only the fields the user actually changed (see its Save handler). An empty diff is
        // not an error and not a write: it means the form agrees with the settings, which is the common case
        // when someone presses Save to check.
        if (Object.keys(settings).length === 0) {
            post({ type: 'status', text: 'Nothing changed — the settings already say that.' });
            return;
        }
        if (!settingSpecs) {
            // No manifest means no authority on what may be written, so nothing is written and the reason is
            // said in both places a person might look.
            log('assistant: the panel could not read the extension manifest, so the settings were not saved');
            post({ type: 'error', message: 'The settings could not be saved: the extension manifest was not readable.' });
            return;
        }
        const plan = planWrites(settings, settingSpecs!.properties);
        // `configView` writes each key to the scope that already supplies it. Writing to `Global` here would
        // be shadowed by a value the project pinned in `.vscode/settings.json` — the designer's bug, kept
        // fixed: the panel would then save, refresh from the effective value, and appear to have done
        // nothing.
        const cfg = configView('rustyPlatform.assistant');
        try {
            for (const [key, value] of Object.entries(plan.write)) await cfg.update(key, value);
            log(`assistant: panel settings saved — ${describeWrites(plan)}`);
            // A settings change can add or remove an agent (a cloud endpoint, or an endpoint the local scan
            // finds), and the scan's cached answer was taken before it.
            forgetAgentScan();
            // The same for the two CLI version probes: their answers are cached per command, so a corrected path
            // would otherwise keep being reported as "not found" until the window was reloaded.
            forgetPoolStatus();
            forgetJcodeStatus();
            if (plan.unknown.length || plan.wrongType.length) {
                post({ type: 'error', message: `Some settings were not saved — ${describeWrites(plan)}` });
                return;
            }
            await refreshAiChat(true);
        } catch (error) {
            logError(error);
            post({ type: 'error', message: `Could not save the settings: ${error instanceof Error ? error.message : String(error)}` });
        }
    }
}

/**
 * The manifest's own settings, read once when the view is registered.
 *
 * `ExtensionContext.extension.packageJSON` is the extension's manifest, so this is the extension asking itself
 * what it contributes — no setting names are written down a second time, which is what made the save path drop
 * every field added after it was written.
 */
let settingSpecs: { properties: Record<string, SettingSpec> } | undefined;

/** What this extension contributes, or undefined when the manifest cannot be read. */
function readSettingSpecs(context: vscode.ExtensionContext): { properties: Record<string, SettingSpec> } | undefined {
    const properties = (context.extension?.packageJSON as { contributes?: { configuration?: { properties?: Record<string, SettingSpec> } } })
        ?.contributes?.configuration?.properties;
    return properties ? { properties } : undefined;
}

/** Registers the view and the commands that reveal it or change the model. */
/**
 * Brings the AI Assist view to the front — and, when asked, opens its **settings section**.
 *
 * WHY THE SECOND PART EXISTS (reported 2026-10-13). *"Nothing happens when I click 'Open the AI settings' after
 * 'Set API key...'"* — and that is exactly right: the command revealed the view, and the view's settings live in a
 * collapsed `<details>` block. If the sidebar was already showing AI Assist, revealing it changed nothing at all
 * on screen, so a button that promised *settings* delivered nothing a person could see. Reaching the view is not
 * the same as arriving at the thing that was asked for.
 *
 * The reveal is one command (a view's own `.focus`, which reveals its container too) rather than two, and it is
 * no longer silent: if it fails, the log says which command failed and why, and the **editor-tab chat** is tried
 * instead — that one needs no sidebar, so it works in every layout. A button that does nothing is worse than one
 * that reports a problem.
 */
async function revealAssistantView(openSettings: boolean): Promise<void> {
    if (openSettings) {
        // The view may not exist yet: revealing it for the first time resolves the provider, which posts `ready`
        // *after* this message would have been sent — so the request is also remembered for that first `ready`.
        pendingSettings = true;
    }
    try {
        await vscode.commands.executeCommand('rustyPlatform.assistant.focus');
    } catch (error) {
        log(
            `assistant: the view could not be focused (${error instanceof Error ? error.message : String(error)}) ` +
            '— opening the chat as an editor tab instead'
        );
        try {
            await vscode.commands.executeCommand('rustyPlatform.assistant.openEditor');
        } catch (second) {
            logError(second);
            void vscode.window.showWarningMessage(
                'The AI Assist panel could not be opened. See the "Grumpy\'s Rusty Platform" output for the reason.'
            );
            return;
        }
    }
    if (openSettings) postSettingsOnce();
}

/**
 * Asks every open surface to open its settings, once.
 *
 * `pendingSettings` covers the first-open race (the message is sent before the webview is listening); clearing it
 * here means the `ready` handler below only re-sends it when the request has not been delivered yet.
 */
let pendingSettings = false;
function postSettingsOnce(): void {
    post({ type: 'openSettings' });
    pendingSettings = false;
}

export function registerAiChatView(context: vscode.ExtensionContext): vscode.Disposable[] {
    // Read once, here, where the context is: the panel's Save needs to know what the manifest declares.
    settingSpecs = readSettingSpecs(context);
    loadChats(context);
    // Every hand-off — the chat's refusal button, the repair loop's last offer, a command — is announced here,
    // so the answer reaches the conversation and its code can be reviewed as a diff and implemented (see
    // `addHandoffTurn`).
    onHandoffReport(addHandoffTurn);
    const provider = new AiChatViewProvider();
    return [
        vscode.window.registerWebviewViewProvider('rustyPlatform.assistant', provider, {
            webviewOptions: { retainContextWhenHidden: true }
        }),
        vscode.commands.registerCommand('rustyPlatform.assistant.openPanel', async () => {
            await revealAssistantView(false);
        }),
        // The same view, with its settings section open — what the buttons that say "Open the AI settings" mean.
        vscode.commands.registerCommand('rustyPlatform.assistant.openSettings', async () => {
            await revealAssistantView(true);
        }),
        vscode.commands.registerCommand('rustyPlatform.assistant.setupModel', () => chooseLocalModel(context)),
        // The Hub: how a user says "my machine is bigger than the one this list was written for".
        vscode.commands.registerCommand('rustyPlatform.assistant.addModel', () => addModelFromHub(context)),
        vscode.commands.registerCommand('rustyPlatform.assistant.removeAddedModel', () => removeAddedModel()),
        vscode.commands.registerCommand('rustyPlatform.assistant.unloadModel', () => unloadLoadedModel()),
        ...registerAssistantSwitchCommands(context),
        vscode.commands.registerCommand('rustyPlatform.assistant.openEditor', () => openChatPanel(context)),
        // Bring the editor-tab chat back after a reload or a restart — including the copy the user dragged onto
        // a second monitor, which VS Code re-opens as its own window and then asks for the panel's contents
        // again. Without this the tab simply vanished on every reload (asked 2026-10-05).
        vscode.window.registerWebviewPanelSerializer(CHAT_PANEL_TYPE, {
            deserializeWebviewPanel: async (panel: vscode.WebviewPanel, state: unknown) => {
                const saved = (state ?? {}) as ChatPanelState;
                panel.title = saved.title || 'Rusty AI Assistant';
                panel.webview.options = { enableScripts: true, localResourceRoots: [context.extensionUri] };
                wireChatPanel(context, panel);
                log('assistant: the editor-tab chat was restored');
            }
        }),
        // The `AiChatViewProvider` class is still registered as the view's provider above; a panel needs no
        // provider at all.
        { dispose: () => { surfaces.clear(); } }
    ];
}
