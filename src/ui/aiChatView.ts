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
import {
    assistantEnabled,
    chatDetailed,
    describeEmptyAnswer,
    describeModel,
    type ChatMessage
} from '../ai/assistant';
import { describeProgress } from '../ai/assistant';
import { boardFacts } from '../ai/boardFacts';
import { crateList } from '../ai/rustCode';
import { log, logError } from '../ai/log';
import { readActiveProject } from '../project/activeProject';
import { panelState } from '../ai/panel';
import { assistantConfig } from '../ai/editor';
import { configWithEndpoint } from '../ai/runtime';
import { chooseLocalModel, unloadLoadedModel } from '../ai/localModelSetup';
import { configView } from '../ai/settings';

/** One turn of the conversation, as the webview renders it. */
interface Turn {
    role: 'user' | 'assistant';
    text: string;
}

/** The transcript: memory only, capped so a long session cannot grow without bound. */
const transcript: Turn[] = [];
const MAX_TRANSCRIPT = 40;

let view: vscode.WebviewView | undefined;
let busy = false;

function nonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i += 1) out += chars[Math.floor(Math.random() * chars.length)] ?? 'a';
    return out;
}

/** Posts one message to the view, if it is open. */
function post(message: unknown): void {
    void view?.webview.postMessage(message);
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
    transcript.push({ role: 'user', text });
    trimTranscript();
    post({ type: 'turn', role: 'user', text });
    post({ type: 'busy', busy: true, message: 'thinking…' });

    busy = true;
    try {
        const context = await contextBlock();
        const messages: ChatMessage[] = [
            chatSystem(context),
            ...transcript.map((t) => ({ role: t.role, content: t.text }))
        ];
        const controller = new AbortController();
        // `bundled` gets its endpoint only once the runtime is up; sending to the settings' default would ask
        // LM Studio's port instead (reported as "No server answered", 2026-10-04).
        const outcome = await chatDetailed(await configWithEndpoint(cfg), messages, {
            signal: controller.signal,
            onToken: (t) => post({ type: 'token', text: t }),
            // Tokens, elapsed and context, on the same half-second heartbeat the editor's notification uses.
            onProgress: (info) => post({ type: 'busy', busy: true, message: describeProgress(info) })
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
        transcript.push({ role: 'assistant', text: answer });
        trimTranscript();
        post({ type: 'turn', role: 'assistant', text: answer, final: true });
    } catch (error) {
        logError(error);
        post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
        busy = false;
        post({ type: 'busy', busy: false });
    }
}

/** A chat answer is capped by the same `maxTokens` as a code answer; nothing extra to decide here. */
function trimTranscript(): void {
    while (transcript.length > MAX_TRANSCRIPT) transcript.shift();
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
    if (!view) return;
    await pushState(fresh);
    post({ type: 'status', text: await statusLine() });
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
    <div id="log"></div>
    <div id="progress" class="busy" hidden></div>
    <textarea id="prompt" placeholder="Ask about this project, or describe a change — e.g. &quot;blink the on-board LED once a second&quot;"></textarea>
    <div class="row">
        <button id="ask">Ask</button>
        <button id="implement" class="secondary" title="Insert a ✎ AI block at the caret">Implement in Function…</button>
        <button id="repair" class="secondary" title="Run cargo check and fix what it can">Fix the Build…</button>
        <button id="clear" class="secondary">Clear</button>
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

    function addTurn(role, text, live) {
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
        log.appendChild(div);
        current = div;
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

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg.type === 'state') {
            const s = msg.state || {};
            setting('backend', s.backend);
            setting('endpoint', s.endpoint);
            setting('model', s.model);
            setting('showDiff', s.showDiff);
        } else if (msg.type === 'status') {
            document.getElementById('status').textContent = msg.text || '';
        } else if (msg.type === 'turn') {
            addTurn(msg.role, msg.text, !msg.final);
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
    document.getElementById('clear').addEventListener('click', () => {
        log.innerHTML = '';
        current = null;
        vscode.postMessage({ type: 'clear' });
    });
    document.getElementById('implement').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'rustyPlatform.assistant.implement' }));
    document.getElementById('repair').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'rustyPlatform.assistant.repair' }));
    document.getElementById('statusBtn').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'rustyPlatform.assistant.status' }));
    document.getElementById('choose').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'rustyPlatform.assistant.setupModel' }));
    document.getElementById('unload').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'rustyPlatform.assistant.unloadModel' }));
    document.getElementById('save').addEventListener('click', () => {
        vscode.postMessage({
            type: 'save',
            settings: {
                backend: document.getElementById('backend').value,
                endpoint: document.getElementById('endpoint').value,
                model: document.getElementById('model').value,
                showDiff: document.getElementById('showDiff').checked
            }
        });
    });

    vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

/** The provider VS Code asks for the view's HTML and forwards its messages to. */
export class AiChatViewProvider implements vscode.WebviewViewProvider {
    resolveWebviewView(webviewView: vscode.WebviewView): void {
        view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = html(webviewView.webview);
        webviewView.webview.onDidReceiveMessage((message: {
            type?: string;
            text?: string;
            command?: string;
            settings?: Record<string, unknown>;
        }) => {
            void this.handle(message);
        });
        void refreshAiChat(true);
    }

    private async handle(message: { type?: string; text?: string; command?: string; settings?: Record<string, unknown> }): Promise<void> {
        switch (message.type) {
            case 'ready':
                post({ type: 'history', turns: transcript });
                await refreshAiChat(true);
                return;
            case 'ask':
                if (message.text) await ask(message.text);
                return;
            case 'clear':
                transcript.length = 0;
                return;
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
        vscode.commands.registerCommand('rustyPlatform.assistant.unloadModel', () => unloadLoadedModel()),
        { dispose: () => { view = undefined; } }
    ];
}
