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
import { codeBlockLabel, crateList } from '../ai/rustCode';
import { log, logError } from '../ai/log';
import { readActiveProject } from '../project/activeProject';
import { panelState } from '../ai/panel';
import { applyChatCode, assistantConfig, chatWithRescue } from '../ai/editor';
import { findRunningLlamaServer } from '../ai/llamaServer';
import { endpointMismatchHint } from '../ai/localModels';

import { chooseLocalModel, unloadLoadedModel } from '../ai/localModelSetup';
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
        const blocks = turn.role === 'assistant' ? rustCodeBlocks(turn.text) : [];
        // An answer is offered only when it has Rust in it: a question, and an answer that is all prose, get no
        // button — and a `Cargo.toml` block is not Rust to implement.
        return blocks.length ? { role: turn.role, text: turn.text, index, code: blocks.map((b) => codeBlockLabel(b.code)) } : { role: turn.role, text: turn.text, index };
    });
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

/** The project context a question is answered against: the board, the crates, and the active file. */
async function contextBlock(): Promise<string> {
    const project = await readActiveProject();
    const parts: string[] = [];
    if (project?.board) parts.push(boardFacts(project.board, project.chip));
    if (project) parts.push(`Cargo.toml dependencies:\n${crateList(project.cargoToml)}`);
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'rust') {
        const text = editor.document.getText();
        const clipped = text.length > 12_000 ? `${text.slice(0, 12_000)}\n// … (file clipped)` : text;
        parts.push(`The file the developer is looking at (${vscode.workspace.asRelativePath(editor.document.uri)}):\n\`\`\`rust\n${clipped}\n\`\`\``);
    }
    return parts.join('\n\n');
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
    post({ type: 'busy', busy: true, message: 'thinking…' });

    busy = true;
    try {
        const context = await contextBlock();
        const messages: ChatMessage[] = [
            chatSystem(context),
            ...chat.turns.map((t) => ({ role: t.role, content: t.text }))
        ];
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
        post({
            type: 'state',
            state: {
                backend: cfg.backend,
                endpoint: cfg.endpoint,
                model: cfg.model,
                showDiff: cfg.showDiff,
                hint: state.hint,
                pinned: state.pinned,
                enabled: state.enabled,
                hostAllowed: state.host.aiAllowed,
                hostWarning: state.host.warning ?? (state.host.reasons[0] ?? '')
            } satisfies SettingsSnapshot
        });
    } catch (error) {
        logError(error);
        post({ type: 'error', message: `Could not read the model state: ${error instanceof Error ? error.message : String(error)}` });
    }
}

/** What the panel's settings block is rendered from. */
interface SettingsSnapshot {
    backend: string;
    endpoint: string;
    model: string;
    showDiff: boolean;
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
        <div class="row" style="margin-top:8px">
            <button id="save">Save</button>
            <button id="choose" class="secondary">Choose a local model…</button>
            <button id="unload" class="secondary">Unload</button>
            <button id="statusBtn" class="secondary">Status…</button>
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
    let applied = { backend: '', endpoint: '', model: '', showDiff: false };

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg.type === 'state') {
            const s = msg.state || {};
            setting('backend', s.backend);
            setting('endpoint', s.endpoint);
            setting('model', s.model);
            setting('showDiff', s.showDiff);
            applied = {
                backend: s.backend === undefined || s.backend === null ? '' : String(s.backend),
                endpoint: s.endpoint === undefined || s.endpoint === null ? '' : String(s.endpoint),
                model: s.model === undefined || s.model === null ? '' : String(s.model),
                showDiff: !!s.showDiff
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
        } else if (msg.type === 'turn') {
            if (msg.final) settleTurn(msg.role, msg.text, msg);
            else addTurn(msg.role, msg.text, false, msg);
        } else if (msg.type === 'token') {
            addTurn('assistant', msg.text, true);
        } else if (msg.type === 'busy') {
            setBusy(msg.busy, msg.message);
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
    document.getElementById('unload').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'rustyPlatform.assistant.unloadModel' }));
    document.getElementById('save').addEventListener('click', () => {
        const now = {
            backend: document.getElementById('backend').value,
            endpoint: document.getElementById('endpoint').value,
            model: document.getElementById('model').value,
            showDiff: document.getElementById('showDiff').checked
        };
        // Only the fields the user actually changed. Sending all four would make a form that is showing
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
                await refreshAiChat(true);
                return;
            }
            case 'ask':
                if (message.text) await ask(message.text);
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

    private async save(settings: Record<string, unknown>): Promise<void> {
        // The view sends only the fields the user actually changed (see its Save handler). An empty diff is
        // not an error and not a write: it means the form agrees with the settings, which is the common case
        // when someone presses Save to check.
        if (Object.keys(settings).length === 0) {
            post({ type: 'status', text: 'Nothing changed — the settings already say that.' });
            return;
        }
        // `configView` writes each key to the scope that already supplies it. Writing to `Global` here would
        // be shadowed by a value the project pinned in `.vscode/settings.json` — the designer's bug, kept
        // fixed: the panel would then save, refresh from the effective value, and appear to have done
        // nothing.
        const cfg = configView('rustyPlatform.assistant');
        try {
            if (typeof settings.backend === 'string') await cfg.update('backend', settings.backend);
            if (typeof settings.endpoint === 'string') await cfg.update('endpoint', settings.endpoint);
            if (typeof settings.model === 'string') await cfg.update('model', settings.model);
            if (typeof settings.showDiff === 'boolean') await cfg.update('showDiff', settings.showDiff);
            log('assistant: panel settings saved');
            await refreshAiChat(true);
        } catch (error) {
            logError(error);
            post({ type: 'error', message: `Could not save the settings: ${error instanceof Error ? error.message : String(error)}` });
        }
    }
}

/** Registers the view and the commands that reveal it or change the model. */
export function registerAiChatView(context: vscode.ExtensionContext): vscode.Disposable[] {
    loadChats(context);
    const provider = new AiChatViewProvider();
    return [
        vscode.window.registerWebviewViewProvider('rustyPlatform.assistant', provider, {
            webviewOptions: { retainContextWhenHidden: true }
        }),
        vscode.commands.registerCommand('rustyPlatform.assistant.openPanel', async () => {
            await vscode.commands.executeCommand('workbench.view.extension.rustyPlatform');
            await vscode.commands.executeCommand('rustyPlatform.assistant.focus');
        }),
        vscode.commands.registerCommand('rustyPlatform.assistant.setupModel', () => chooseLocalModel(context)),
        // The Hub: how a user says "my machine is bigger than the one this list was written for".
        vscode.commands.registerCommand('rustyPlatform.assistant.addModel', () => addModelFromHub(context)),
        vscode.commands.registerCommand('rustyPlatform.assistant.removeAddedModel', () => removeAddedModel()),
        vscode.commands.registerCommand('rustyPlatform.assistant.unloadModel', () => unloadLoadedModel()),
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
