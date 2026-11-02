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
    codeBlocks,
    describeEmptyAnswer,
    describeModel,
    selectionContext,
    type ChatMessage
} from '../ai/assistant';
import { describeProgress } from '../ai/assistant';
import {
    assistLanguageOfDocument,
    assistLanguageOfProject,
    chatSystemPrompt,
    codeFenceFor,
    cppAssistExamples,
    isCodeBlockFor,
    sketchBrief,
    type AssistLanguage
} from '../ai/assistLanguage';
import { boardFacts } from '../ai/boardFacts';
import { formatProblems, type PaneDiagnostic } from '../ai/panes';
import { debugConsoleBlock } from '../ai/debugConsole';
import { conventionsBlock, normaliseConventions } from '../ai/conventions';
import { codeBlockLabel, completeAlternative, crateList } from '../ai/rustCode';
import { log, logError } from '../ai/log';
import { readActiveProject } from '../project/activeProject';
import { panelState } from '../ai/panel';
import { applyChatCode, assistantConfig, chatWithRescue } from '../ai/editor';
import { describeWrites, planWrites, type SettingSpec } from '../ai/panelSettings';
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
/**
 * The request in flight, so the panel's Abort button can stop it (asked 2026-10-31). One at a time, because
 * `ask` refuses a second question while `busy`; the `finally` in `ask` is what clears it, so a stopped request
 * cannot leave the panel believing something is still running.
 */
let abortable: AbortController | undefined;

/** Code Assist mode: watch the active editor for `//~ keyword` triggers. */
let rustAssistDisposable: vscode.Disposable | undefined;

/**
 * The language the project in front of us is written in.
 *
 * Cached rather than passed down because three of the places that need it are synchronous -- the history the
 * view is sent, the file block, the code-block guard -- and asking the filesystem from each of them would make
 * a list of turns a series of `stat`s. It is refreshed wherever the project is already read, and defaults to
 * Rust, which is what a workspace with no project of ours is.
 */
let assistLanguage: AssistLanguage = 'rust';

function rustAssistExamples(keyword: string): string {
    if (keyword === 'let') {
        return [
            'Example `let` bindings for every Rust data type:',
            '```rust',
            'let b: bool = true;',
            'let i: i32 = 42;',
            'let u: u32 = 42;',
            'let f: f32 = 3.14;',
            'let c: char = \'a\';',
            'let s: &str = "hello";',
            'let v: Vec<i32> = vec![1, 2, 3];',
            'let o: Option<i32> = Some(1);',
            'let r: Result<i32, &str> = Ok(1);',
            '```',
        ].join('\n');
    }
    if (keyword === 'loop') {
        return [
            'Loop variations:',
            '```rust',
            '// infinite loop',
            'loop {',
            '    // work',
            '    if done { break; }',
            '}',
            '',
            '// while loop',
            'while condition {',
            '    // work',
            '}',
            '',
            '// for loop over a range (exclusive end)',
            'for i in 0..10 {',
            '    // work',
            '}',
            '',
            '// for loop over an inclusive range (end included, =x)',
            'for i in 0..=10 {',
            '    // work',
            '}',
            '',
            '// for loop over an iterator',
            'for item in collection.iter() {',
            '    // work',
            '}',
            '```',
        ].join('\n');
    }
    if (keyword === 'if') {
        return [
            'If decision variations:',
            '```rust',
            '// simple if',
            'if condition {',
            '    // work',
            '}',
            '',
            '// if / else',
            'if condition {',
            '    // work',
            '} else {',
            '    // otherwise',
            '}',
            '',
            '// if / else if / else',
            'if a {',
            '    // a',
            '} else if b {',
            '    // b',
            '} else {',
            '    // neither',
            '}',
            '',
            '// if as expression (let)',
            'let x = if condition { 1 } else { 2 };',
            '',
            '// if let (pattern matching)',
            'if let Some(v) = option {',
            '    // use v',
            '}',
            '```',
        ].join('\\n');
    }
    if (keyword === 'match') {
        return [
            'Match decision variations:',
            '```rust',
            '// basic match',
            'match value {',
            '    0 => { /* zero */ }',
            '    1 | 2 => { /* one or two */ }',
            '    3..=5 => { /* range */ }',
            '    _ => { /* default */ }',
            '}',
            '',
            '// match as expression',
            'let result = match value {',
            '    0 => "zero",',
            '    _ => "other",',
            '};',
            '',
            '// match with guards',
            'match value {',
            '    x if x > 0 => { /* positive */ }',
            '    _ => { /* non-positive */ }',
            '}',
            '',
            '// match on enum',
            'match msg {',
            '    Message::Quit => { /* quit */ }',
            '    Message::Move { x, y } => { /* move */ }',
            '    Message::Write(s) => { /* write */ }',
            '}',
            '```',
        ].join('\\n');
    }
    if (keyword === 'fn') {
        return [
            'Function declaration variations:',
            '```rust',
            '// basic function',
            'fn greet() {',
            '    // work',
            '}',
            '',
            '// function with parameters and return type',
            'fn add(a: i32, b: i32) -> i32 {',
            '    a + b',
            '}',
            '',
            '// generic function',
            'fn identity<T>(x: T) -> T {',
            '    x',
            '}',
            '',
            '// function with lifetime',
            'fn longest<\'a>(x: &\'a str, y: &\'a str) -> &\'a str {',
            '    if x.len() > y.len() { x } else { y }',
            '}',
            '',
            '// async function',
            'async fn fetch() -> Result<(), Error> {',
            '    Ok(())',
            '}',
            '',
            '// const fn',
            'const fn square(x: i32) -> i32 {',
            '    x * x',
            '}',
            '',
            '// unsafe fn',
            'unsafe fn raw_ptr() {',
            '    // work',
            '}',
            '',
            '// pub fn',
            'pub fn public_api() {',
            '    // work',
            '}',
            '```',
        ].join('\\n');
    }
    if (keyword === 'array') {
        return [
            'Array declaration variations:',
            '```rust',
            '// fixed-size array',
            'let a: [i32; 3] = [1, 2, 3];',
            '',
            '// array with default value',
            'let b = [0; 5];',
            '',
            '// array of strings',
            'let c: [&str; 2] = ["hi", "bye"];',
            '',
            '// mutable array',
            'let mut d = [1, 2, 3];',
            '',
            '// array indexing',
            'let first = a[0];',
            '',
            '// array slice from array',
            'let s = &a[1..];',
            '```',
        ].join('\\n');
    }
    if (keyword === 'slice') {
        return [
            'Slice declaration variations:',
            '```rust',
            '// slice reference',
            'let s: &[i32] = &[1, 2, 3];',
            '',
            '// mutable slice',
            'let ms: &mut [i32] = &mut [1, 2, 3];',
            '',
            '// slice from array',
            'let arr = [1, 2, 3, 4];',
            'let sl = &arr[1..3];',
            '',
            '// inclusive slice range',
            'let sl2 = &arr[1..=2];',
            '',
            '// open-ended slice',
            'let tail = &arr[2..];',
            'let head = &arr[..2];',
            '',
            '// empty slice',
            'let empty: &[i32] = &[];',
            '```',
        ].join('\\n');
    }
    if (keyword === 'string') {
        return [
            'String declaration variations:',
            '```rust',
            '// string slice (&str)',
            'let s: &str = "hello";',
            '',
            '// owned String',
            'let owned: String = String::from("hello");',
            'let owned2 = "hello".to_string();',
            '',
            '// mutable String',
            'let mut m = String::from("hi");',
            'm.push_str(" there");',
            '',
            '// empty strings',
            'let empty_str: &str = "";',
            'let empty_owned = String::new();',
            '',
            '// string with capacity',
            'let mut cap = String::with_capacity(16);',
            '',
            '// raw string literal',
            'let raw: &str = r#"line1\nline2"#;',
            '',
            '// byte string',
            'let bytes: &[u8] = b"hello";',
            '```',
        ].join('\\n');
    }
    if (keyword === 'struct') {
        return [
            'Struct declaration variations:',
            '```rust',
            '// unit struct',
            'struct Unit;',
            '',
            '// tuple struct',
            'struct Point(i32, i32);',
            '',
            '// named-field struct',
            'struct User {',
            '    name: String,',
            '    age: u32,',
            '}',
            '',
            '// generic struct',
            'struct Wrapper<T> {',
            '    value: T,',
            '}',
            '',
            '// struct with lifetime',
            'struct Ref<\'a> {',
            '    data: &\'a str,',
            '}',
            '',
            '// public struct',
            'pub struct Public {',
            '    pub field: i32,',
            '}',
            '',
            '// struct update syntax',
            'let u2 = User { age: 30, ..u };',
            '```',
        ].join('\\n');
    }
    if (keyword === 'enum') {
        return [
            'Enum declaration variations:',
            '```rust',
            '// simple enum',
            'enum Color { Red, Green, Blue }',
            '',
            '// enum with data',
            'enum Message {',
            '    Quit,',
            '    Move { x: i32, y: i32 },',
            '    Write(String),',
            '    ChangeColor(i32, i32, i32),',
            '}',
            '',
            '// generic enum',
            'enum Option<T> {',
            '    Some(T),',
            '    None,',
            '}',
            '',
            '// enum with discriminants',
            'enum HttpStatus {',
            '    Ok = 200,',
            '    NotFound = 404,',
            '}',
            '',
            '// public enum',
            'pub enum Visibility { Public, Private }',
            '```',
        ].join('\\n');
    }
    if (keyword === 'option') {
        return [
            'Option variations:',
            '```rust',
            '// Some / None',
            'let some: Option<i32> = Some(5);',
            'let none: Option<i32> = None;',
            '',
            '// if let',
            'if let Some(v) = some {',
            '    // use v',
            '}',
            '',
            '// match',
            'match some {',
            '    Some(v) => v,',
            '    None => 0,',
            '}',
            '',
            '// unwrap / expect',
            'let v = some.unwrap();',
            'let v2 = some.expect("missing");',
            '',
            '// unwrap_or / unwrap_or_else',
            'let v3 = none.unwrap_or(0);',
            'let v4 = none.unwrap_or_else(|| compute());',
            '',
            '// map / and_then',
            'let doubled = some.map(|x| x * 2);',
            'let chained = some.and_then(|x| Some(x + 1));',
            '',
            '// is_some / is_none',
            'if some.is_some() { /* ... */ }',
            '```',
        ].join('\\n');
    }
    if (keyword === 'result') {
        return [
            'Result variations:',
            '```rust',
            '// Ok / Err',
            'let ok: Result<i32, &str> = Ok(5);',
            'let err: Result<i32, &str> = Err("fail");',
            '',
            '// match',
            'match result {',
            '    Ok(v) => v,',
            '    Err(e) => { /* handle */ 0 },',
            '}',
            '',
            '// ? operator',
            'fn run() -> Result<i32, &str> {',
            '    let v = parse()?;',
            '    Ok(v + 1)',
            '}',
            '',
            '// unwrap / expect',
            'let v = result.unwrap();',
            'let v2 = result.expect("failed");',
            '',
            '// unwrap_or / unwrap_or_else',
            'let v3 = result.unwrap_or(0);',
            'let v4 = result.unwrap_or_else(|e| recover(e));',
            '',
            '// map / map_err',
            'let mapped = result.map(|x| x * 2);',
            'let mapped_err = result.map_err(|e| format!("{}", e));',
            '',
            '// is_ok / is_err',
            'if result.is_ok() { /* ... */ }',
            '```',
        ].join('\\n');
    }
    if (keyword === 'module' || keyword === 'mod') {
        return [
            'Module creation variations:',
            '```rust',
            '// inline module',
            'mod utils {',
            '    pub fn helper() {}',
            '}',
            '',
            '// module in separate file (mod.rs or utils.rs)',
            'mod utils;',
            '',
            '// public module',
            'pub mod api;',
            '',
            '// nested module',
            'mod outer {',
            '    pub mod inner {',
            '        pub fn f() {}',
            '    }',
            '}',
            '',
            '// module with re-export',
            'mod inner;',
            'pub use inner::Item;',
            '',
            '// crate root module (lib.rs / main.rs)',
            '// (file itself is the crate root)',
            '```',
        ].join('\\n');
    }
    return `No examples yet for keyword "${keyword}".`;
}

/** The examples for a `//~` keyword, in the language of the file it was typed in. */
function assistExamples(language: AssistLanguage, keyword: string): string {
    return language === 'cpp' ? cppAssistExamples(keyword) : rustAssistExamples(keyword);
}

/**
 * Code Assist mode: `//~ keyword` on its own line in an assistable file answers with examples of that construct.
 *
 * The language comes from the document rather than from the project, because the trigger is typed in a file: a
 * `.cpp` in a sketch gets C++ examples, and a `.rs` anywhere gets Rust ones, whatever the workspace looks like.
 */
function enableRustAssist(): void {
    rustAssistDisposable?.dispose();
    rustAssistDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document !== event.document) return;
        const language = assistLanguageOfDocument(event.document.languageId);
        if (language === undefined) return;
        for (const change of event.contentChanges) {
            const startLine = change.range.start.line;
            const lines = change.text.split('\n');
            for (let i = 0; i < lines.length; i += 1) {
                const lineNo = startLine + i;
                if (lineNo >= event.document.lineCount) continue;
                const text = event.document.lineAt(lineNo).text;
                const match = text.match(/^\s*\/\/~\s*(\w+)\s*$/);
                if (!match) continue;
                const keyword = match[1] ?? '';
                const chat = ensureActive();
                const answer = assistExamples(language, keyword);
                chat.turns.push({ role: 'assistant', text: answer });
                remember();
                postChats();
                post({ type: 'turn', role: 'assistant', text: answer, final: true, index: chat.turns.length - 1 });
            }
        }
    });
}

function disableRustAssist(): void {
    rustAssistDisposable?.dispose();
    rustAssistDisposable = undefined;
}

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
 * One function, because a live turn and the restored history have to agree: an answer that grew its "Implement"
 * buttons only after the panel was reloaded was this rule written twice, once live and once for the history,
 * and the two disagreed (2026-10-13).
 */
function codeLabels(role: string, text: string, language: AssistLanguage = 'rust'): string[] | undefined {
    const blocks = role === 'assistant' ? codeBlocks(text).filter((block) => isCodeBlockFor(language, block)) : [];
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
 * The project facts every prompt carries: the board, the crates, and the house rules.
 *
 * WHY THE RULES ARE PART OF THIS BLOCK. The house rules are the only standing instructions a developer can
 * give, and this is the one block the chat's prompts are built from — the setting promises "They are put in
 * every prompt", and this is what makes that true of the chat as well as of the editor's own flows.
 */
async function projectFacts(): Promise<string> {
    const project = await readActiveProject();
    assistLanguage = assistLanguageOfProject(project?.language);
    const parts: string[] = [];
    if (project?.board) parts.push(boardFacts(project.board, project.chip));
    if (assistLanguage === 'cpp') {
        // A sketch has no dependency list worth sending; what a model cannot guess is which files it may touch.
        parts.push(
            sketchBrief({
                board: project?.board?.name,
                kind: project?.board?.kind,
                designer: project?.designer,
            }),
        );
    } else if (project) {
        parts.push(`Cargo.toml dependencies:\n${crateList(project.cargoToml)}`);
    }
    parts.push(houseRules());
    return parts.filter(Boolean).join('\n\n');
}

/** The house rules as one block, or an empty string when the developer has accepted none. */
function houseRules(): string {
    return conventionsBlock(normaliseConventions(configView('rustyPlatform.assistant').get('conventions')));
}

/**
 * The editor a prompt is about.
 *
 * `activeTextEditor` covers the side-bar view: the chat takes the focus without a text editor losing it. When
 * the chat is an **editor tab** it is the active editor itself, and VS Code reports no active text editor at
 * all — so the last Rust editor that was active is remembered and used instead. Without that, the panel meant
 * for a second monitor had nothing to read a selection from (2026-10-31).
 */
let lastRustEditor: vscode.TextEditor | undefined;
vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor && assistLanguageOfDocument(editor.document.languageId) !== undefined) lastRustEditor = editor;
});

function promptEditor(): vscode.TextEditor | undefined {
    const active = vscode.window.activeTextEditor;
    if (active && assistLanguageOfDocument(active.document.languageId) !== undefined) return active;
    return lastRustEditor && !lastRustEditor.document.isClosed ? lastRustEditor : undefined;
}

/** The file the developer is looking at: the selection, or the file clipped to what a small model can afford. */
function fileBlock(): string {
    const editor = promptEditor();
    if (!editor) return '';
    const relative = vscode.workspace.asRelativePath(editor.document.uri);
    const selection = editor.selection;
    // What is selected is what the question is about, so it is sent instead of the file rather than beside it:
    // adding both spends the model's window twice on the same lines, and the file is the half that gets clipped
    // in any file bigger than a screen or two (see `selectionContext`).
    if (!selection.isEmpty) {
        const lines = editor.document.getText().split(/\r?\n/);
        // A selection ending at column 0 of a later line does not include that line, so the last selected line is
        // the one before it — one off, and the model is told the wrong line is the marked one.
        const lastLine = selection.end.character === 0 && selection.end.line > selection.start.line
            ? selection.end.line
            : selection.end.line + 1;
        return selectionContext(relative, lines, selection.start.line + 1, lastLine);
    }
    const text = editor.document.getText();
    const clipped = text.length > 12_000 ? `${text.slice(0, 12_000)}\n// … (file clipped)` : text;
    // The fence names the file's own language, not the project's: a sketch holds C++ and a crate holds Rust, and
    // a model told the wrong one writes the wrong one back.
    const fence = codeFenceFor(assistLanguageOfDocument(editor.document.languageId) ?? assistLanguage);
    return `The file the developer is looking at (${relative}):\n\`\`\`${fence}\n${clipped}\n\`\`\``;
}

/**
 * The Problems pane as prompt text (asked 2026-10-31: *"enable the ai model to access (read) the Problems …
 * panes"*).
 *
 * The pane is a view of `vscode.languages.getDiagnostics()`, so this is a read rather than a scrape — and it
 * covers rust-analyzer's problems as well as the extension's own cargo run. Only **errors and warnings** are
 * sent: the pane also holds every hint rust-analyzer produces (unused imports, needless returns), which for a
 * small local model is noise that pushes the question out of its window.
 *
 * Not gated behind a setting, because the alternative is what the chat already did — answer "fix the build"
 * without ever looking at what the compiler said.
 */
function problemsBlock(): string {
    const entries: PaneDiagnostic[] = [];
    for (const [uri, list] of vscode.languages.getDiagnostics()) {
        if (uri.scheme !== 'file') continue;
        // Only this workspace: a folder that happens to be open is still the developer's problem list, but a
        // library outside it is not what they are asking about, and it is exactly what floods a big workspace.
        if (!vscode.workspace.getWorkspaceFolder(uri)) continue;
        const file = vscode.workspace.asRelativePath(uri);
        for (const diagnostic of list) {
            const severity = diagnostic.severity;
            if (severity !== vscode.DiagnosticSeverity.Error && severity !== vscode.DiagnosticSeverity.Warning) continue;
            entries.push({
                file,
                line: diagnostic.range.start.line + 1,
                column: diagnostic.range.start.character + 1,
                severity: severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
                message: diagnostic.message,
                source: diagnostic.source
            });
        }
    }
    return formatProblems(entries);
}

/** The project context a question is answered against: the board, the crates, the active file, the problems. */
async function contextBlock(consoleOnly = false): Promise<string> {
    // "Console only" (asked 2026-10-31): the one question that needs nothing else is "what does this console
    // output mean?", and it is the one that a defmt stream answers worst — the console is the longest block in
    // the prompt, so everything beside it is what gets pushed out of a small model's window.
    if (consoleOnly) return debugConsoleBlock() || 'The Debug Console has no lines in it yet.';
    return [await projectFacts(), fileBlock(), problemsBlock(), debugConsoleBlock()].filter(Boolean).join('\n\n');
}

/** The system message for a free-form question. */
function chatSystem(context: string): ChatMessage {
    return {
        role: 'system',
        content: `${chatSystemPrompt(assistLanguage)}\n\n${context}`
    };
}

async function ask(text: string, consoleOnly = false): Promise<void> {
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
    let controller: AbortController | undefined;
    try {
        const context = await contextBlock(consoleOnly);
        const messages: ChatMessage[] = [
            chatSystem(context),
            ...chat.turns.map((t) => ({ role: t.role, content: t.text }))
        ];
        post({ type: 'busy', busy: true, message: 'thinking…' });

        controller = new AbortController();
        abortable = controller;
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
        // The status line was drawn before this request, when nothing had answered yet, so it could only guess
        // whether the model was in memory. The reply is the answer to that question, so the line is redrawn from
        // the same state the panel uses — not left saying "not in memory yet; the next request loads it" for the
        // rest of the conversation (reported 2026-10-31). Not awaited: the panel has its answer already.
        void statusLine().then((text) => post({ type: 'status', text })).catch(logError);
    } catch (error) {
        // Stopping is not a failure: the user asked for it, so the panel says so and the partial answer is not
        // kept — half a function in the transcript is the thing the next question would be answered against.
        if (controller?.signal.aborted === true) {
            log('assistant: the request was stopped from the chat');
            post({ type: 'turn', role: 'assistant', text: '⏹ Stopped — no answer was saved.' });
            return;
        }
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
        if (abortable === controller) abortable = undefined;
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
                assistantOn: cfg.enabled,
                stopAtStartup: cfg.stopServersAtStartup,
                contextSize: cfg.contextSize,
                maxTokens: cfg.maxTokens,
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
    /** The switch itself, as the settings hold it (not "does the endpoint answer"). */
    assistantOn: boolean;
    stopAtStartup: boolean;
    backend: string;
    endpoint: string;
    model: string;
    showDiff: boolean;
    /**
     * The model's own two numbers (asked 2026-10-13). Editable in the form because they are not trivia: the
     * prompt is measured against `contextSize` and the answer against `maxTokens`, so between them they decide
     * how much can be asked for at once.
     */
    contextSize: number;
    maxTokens: number;
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
    #status { opacity: .85; font-size: .92em; overflow-wrap: anywhere; }
    /* flex-basis 0 rather than auto: the log takes exactly the space left over, so it is this box that
       scrolls and never the page. With auto its height started at the height of the whole transcript and the
       page grew instead, which put the newest row below the visible area (2026-10-31). */
    #log { flex: 1 1 0; overflow-y: auto; border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px; min-height: 120px; overflow-wrap: anywhere; word-break: break-word; }
    .turn { margin: 0 0 10px; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
    .turn.user { color: var(--vscode-textLink-foreground); }
    .turn pre { background: var(--vscode-textCodeBlock-background); padding: 6px; border-radius: 4px; overflow-x: hidden; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
    .busy { opacity: .8; font-style: italic; }
    .error { color: var(--vscode-errorForeground); white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
    textarea, input, select { width: 100%; box-sizing: border-box; background: var(--vscode-input-background);
        color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 4px; }
    textarea { resize: vertical; min-height: 64px; white-space: pre-wrap; overflow-wrap: break-word; word-break: break-word; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none;
        border-radius: 3px; padding: 5px 10px; cursor: pointer; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .row { display: flex; gap: 6px; align-items: center; }
    .row > * { flex: 1 1 auto; }
    .row > button { flex: 0 0 auto; }
    /* Four actions in a narrow side bar: Ask, Abort, Implement, Fix. They wrap rather than run off the edge. */
    #actions { flex-wrap: wrap; }
    /* The mode radios: the button on top, its name centred directly beneath it (measured in a browser --
       the input width rule above put the radio alone on its own line and left the text at the far left). */
    #assistMode label { display: flex; flex-direction: column; align-items: center; gap: 2px; margin: 0; text-align: center; }
    #assistMode input { width: auto; }
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
    <div class="row" id="assistMode">
        <label><input type="radio" name="assistMode" id="fullAssist" value="full" checked><span>Full Assist</span></label>
        <label><input type="radio" name="assistMode" id="rustAssist" value="rust"><span>Rust Assist</span></label>
    </div>
    <div class="row" id="chatbar">
        <select id="chats" title="Earlier conversations in this project"></select>
        <button id="newChat" class="secondary" title="Start a new conversation">New</button>
        <button id="deleteChat" class="secondary" title="Delete this conversation">Delete</button>
    </div>
    <div id="log"></div>
    <div id="progress" class="busy" hidden></div>
    <div class="row" id="contextRow">
        <label title="Send only the Debug Console to the model — not the file, the Problems pane or the board facts. For &quot;what does this console output mean?&quot;, where a defmt stream would otherwise be drowned out by everything else.">
            <input id="consoleOnly" type="checkbox" style="width:auto"> <span>Console only</span>
        </label>
    </div>
    <textarea id="prompt" title="Enter sends · Shift+Enter starts a new line" placeholder="Ask about this project, or describe a change — e.g. &quot;blink the on-board LED once a second&quot;"></textarea>
    <div class="row" id="actions">
        <button id="ask">Ask</button>
        <button id="abort" class="secondary" title="Stop the answer that is being written — it is not kept">Abort</button>
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
        <label title="The context window the bundled runtime is started with, in tokens. 0 lets the extension size it to hold the answer budget plus 2048.">Context window (tokens)</label>
        <input id="contextSize" type="number" min="0" max="262144" step="512" title="The window, in tokens. 0 = size it to fit the answer budget.">
        <label title="The longest answer the model may write. Raising it for a thinking model leaves less room for the prompt inside the same window, so the two numbers belong together.">Longest answer (tokens)</label>
        <input id="maxTokens" type="number" min="64" max="8192" step="64" title="The answer budget, in tokens.">
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

    // Following the newest row (asked 2026-10-31: "make the chat panel scroll down automatically as new rows
    // are added at the bottom"). It is a decision rather than a constant: the panel jumps to the bottom while
    // the reader is already there, and stays put once they scroll up to read something earlier — being pulled
    // away mid-answer is worse than missing a line. The reader's intent is tracked here, not at each append
    // site, because content growing is not a scroll.
    let follow = true;
    let lastTop = 0;
    const NEAR_BOTTOM = 32;
    function atBottom() {
        return log.scrollHeight - log.scrollTop - log.clientHeight <= NEAR_BOTTOM;
    }
    log.addEventListener('scroll', () => {
        // Growing the log leaves scrollTop where it is, so only a *decrease* means the reader moved up.
        // Asking "is it at the bottom now" instead would read an answer arriving below as a scroll away, and
        // stop following exactly when the answer was being written.
        const top = log.scrollTop;
        if (top < lastTop - 4) follow = false;
        else if (atBottom()) follow = true;
        lastTop = top;
    });
    function scrollToEnd() {
        if (!follow) return;
        // Twice: now, because that is the frame being looked at, and on the next frame too, because a fenced
        // block or a wrapped line settles its final height after this handler has returned.
        log.scrollTop = log.scrollHeight;
        requestAnimationFrame(() => { if (follow) log.scrollTop = log.scrollHeight; });
    }
    // One observer instead of a call at each place that writes: a turn, a streamed token, the settled answer,
    // an error, the code buttons and a restored history all change this element. The path that had no scroll
    // at all was the streamed token, so the panel showed the top of an answer while the rest was written below
    // the fold.
    new MutationObserver(() => scrollToEnd()).observe(log, { childList: true, subtree: true, characterData: true });

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
        scrollToEnd();
    }

    function settleTurn(role, text, turn) {
        // The completed turn — not another one. The streamed pieces already drew this answer, so the
        // authoritative text replaces them; appending it is what rendered every answer twice (2026-10-04).
        if (current && current.dataset.role === role) {
            current.dataset.text = text;
            current.innerHTML = render(text);
            if (role === 'assistant') addCodeActions(current, turn);
            scrollToEnd();
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
        // Abort is only meaningful while something is running. Disabling rather than hiding keeps the row the
        // same width, so Ask does not jump sideways when a request starts.
        const stop = document.getElementById('abort');
        if (stop) stop.disabled = !busy;
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
    let applied = { backend: '', endpoint: '', model: '', showDiff: false, contextSize: '', maxTokens: '' };

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
                maxTokens: s.maxTokens === undefined || s.maxTokens === null ? '' : String(s.maxTokens)
            };
        } else if (msg.type === 'status') {
            document.getElementById('status').textContent = msg.text || '';
        } else if (msg.type === 'history') {
            // A restored conversation: the turns already happened, so they are drawn at once, not streamed.
            // A conversation opened here is read from its newest row, so following starts again — clearing the
            // log clamps scrollTop to 0, which the scroll listener would otherwise read as the reader moving
            // up and stop following.
            log.innerHTML = '';
            current = null;
            follow = true;
            lastTop = 0;
            for (const turn of msg.turns || []) addTurn(turn.role, turn.text, false, turn);
        } else if (msg.type === 'chats') {
            setChats(msg.chats, msg.activeId);
        } else if (msg.type === 'openSettings') {
            openSettingsBlock();
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
        // Asking is a request to see the answer, so it starts following again even when the reader had scrolled
        // up to re-read something earlier.
        follow = true;
        // "Console only" is read here rather than kept in the extension: it is a property of this question, not
        // of the assistant, and both ways of asking (the button and Enter) come through this handler.
        vscode.postMessage({ type: 'ask', text, consoleOnly: document.getElementById('consoleOnly').checked });
    });
    // Enter sends, Shift+Enter is the line break (asked 2026-10-31: "I also want to launch the prompt when
    // pressing the 'Enter' key and 'Shift+Enter' for doing a 'New Line'"). Shift is checked first because the
    // plain Enter case is the one that must be swallowed — leaving it to the textarea would insert a newline and
    // then this handler would send a prompt with that newline trailing it. Ctrl/Cmd+Enter keeps working: it is
    // what the status bar and the docs have pointed at, and there is no reason to take it away.
    document.getElementById('prompt').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.shiftKey) return;
        // An IME uses Enter to accept its candidate; sending there would fire a half-written question.
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        document.getElementById('ask').click();
    });
    // Opens the settings section and puts the caret in it. The block is a details element that starts closed, so
    // without this the panel can be revealed and still show nothing that answers "where are the settings?".
    function openSettingsBlock() {
        const block = document.querySelector('details');
        if (block) {
            block.open = true;
            if (block.scrollIntoView) block.scrollIntoView({ block: 'start' });
        }
        // The backend is the first field of the settings, so it is the one worth landing on.
        const field = document.getElementById('backend');
        if (field && field.focus) field.focus();
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
    // Stop the answer that is being written. Enabled only while there is one (see setBusy below), so it cannot
    // be clicked into a "nothing to stop" surprise.
    const abortButton = document.getElementById('abort');
    abortButton.addEventListener('click', () => vscode.postMessage({ type: 'abort' }));
    abortButton.disabled = true;
    document.getElementById('deleteChat').addEventListener('click', () => vscode.postMessage({ type: 'deleteChat' }));
    document.getElementById('implement').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'rustyPlatform.assistant.implement' }));
    document.getElementById('repair').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'rustyPlatform.assistant.repair' }));
    document.getElementById('statusBtn').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'rustyPlatform.assistant.status' }));
    document.getElementById('choose').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'rustyPlatform.assistant.setupModel' }));
    document.getElementById('unload').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'rustyPlatform.assistant.unloadModel' }));
    // The switch. The checkbox is not the state — the host's snapshot is — so a failed turn-on snaps it back
    // when the panel is refreshed rather than leaving a checkbox that claims something untrue.
    document.getElementById('assistOn').addEventListener('change', () => vscode.postMessage({ type: 'command', command: 'rustyPlatform.assistant.toggle' }));
    document.getElementById('stopAtStartup').addEventListener('change', (event) => {
        vscode.postMessage({ type: 'save', settings: { stopServersAtStartup: event.target.checked } });
    });
    document.getElementById('openEditorTab').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'rustyPlatform.assistant.openEditor' }));
    document.querySelectorAll('input[name="assistMode"]').forEach((el) => {
        el.addEventListener('change', (e) => {
            vscode.postMessage({ type: 'setMode', mode: e.target.value });
        });
    });
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
            maxTokens: numberBox('maxTokens', applied.maxTokens)
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
        mode?: string;
        /** "Console only": the question is answered from the Debug Console and nothing else. */
        consoleOnly?: boolean;
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
                if (message.text) await ask(message.text, message.consoleOnly === true);
                return;
            case 'abort': {
                // The Abort button. Nothing to stop is not an error: the request may have finished between the
                // click and this message.
                if (!abortable) return;
                log('assistant: the panel asked to stop the request');
                abortable.abort();
                return;
            }
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
                const blocks =
                    turn && turn.role === 'assistant'
                        ? codeBlocks(turn.text).filter((block) => isCodeBlockFor(assistLanguage, block))
                        : [];
                const chosen = message.block ?? 0;
                const block = blocks[chosen];
                if (!block) {
                    post({ type: 'error', message: 'That code is no longer in this conversation — ask again and it will be.' });
                    return;
                }
                // A before/after answer names both blocks after the same item. If the one clicked is the quote,
                // the answer already holds the change — offer it rather than a modal that only says no. And if
                // neither block can be applied, the refusal's button asks the chat for the whole function, so a
                // refusal always leads somewhere (2026-10-31: "i dont see any changes").
                const alternative = completeAlternative(blocks.map((b) => b.code), chosen);
                await applyChatCode(block.code, {
                    label: codeBlockLabel(block.code),
                    alternative,
                    retry: (question) => ask(question)
                });
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
            case 'setMode': {
                if (message.mode === 'rust') {
                    if (!assistantEnabled(assistantConfig())) {
                        post({ type: 'status', text: 'Rust Assist needs AI Assist enabled first.' });
                        return;
                    }
                    enableRustAssist();
                    post({
                        type: 'status',
                        text: 'Code Assist on — type //~ let in a .rs file, or //~ struct or //~ lvgl in a .cpp file',
                    });
                } else {
                    disableRustAssist();
                    post({ type: 'status', text: 'Full Assist on' });
                }
                return;
            }
            default:
                return;
        }
    }

    /**
     * Writes the panel's settings, whatever the form sent.
     *
     * THE BUG THIS REPLACES (reported 2026-10-13, *"it is not in the list"*). This method listed the keys it
     * would write **by hand** — five of them — so `contextSize`, `maxTokens` and every field added afterwards
     * were sent by the form, compared by `applied`, and then **dropped here**. The panel refreshed from
     * settings that had never been written, the field reverted, and the feature that field configures never saw
     * the value. A developer's reasonable reading of that is "the extension did not save my setting", which is
     * exactly what they reported.
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
