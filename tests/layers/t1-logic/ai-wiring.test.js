'use strict';

/**
 * The wiring between the source and `package.json`: commands that exist, settings that exist, and the two
 * being true at the same time.
 *
 * WHY THIS TEST EXISTS (2026-10-04). The user asked why selecting **My own llama-server** did nothing. It did
 * nothing because the command the picker ran — `rustyPlatform.assistant.startLlamaServer` — was **never
 * registered**, and the six settings that path writes (`llamaServerPath`, `llamaServerArgs`,
 * `llamaServerService`, `llamaServerStartTarget`, `loadContextLength`, `loadGpu`) were never declared in
 * `package.json`. Both failures are invisible until the moment a user clicks: an unregistered command raises
 * "command '…' not found", and `WorkspaceConfiguration.update()` on an undeclared key throws "… is not a
 * registered configuration" — inside a webview handler, where it shows up as a one-line error toast at best.
 *
 * A whole feature can sit in `src/` looking finished and be unreachable this way, and TypeScript cannot see
 * it: `executeCommand('anything')` and `update('anything')` both type-check.
 *
 * HOW IT CHECKS. The compiled sources are not involved — this is a *textual* audit of `src/**` against
 * `package.json`, deliberately: the whole point is to read what the code promises and compare it with what the
 * extension declares. Two directions, because both bugs are real:
 *
 *   - a command **declared** but never registered is a palette entry that fails when chosen;
 *   - a command **executed** but never declared is the same failure one step removed (and the one this report
 *     was about), unless it is a view's own auto-generated `<viewId>.focus`.
 *
 * The setting half is a suffix match, because the source writes section-relative keys (`'llamaServerArgs'`)
 * while `package.json` holds fully qualified ones (`rustyPlatform.assistant.llamaServerArgs`). A key that no
 * declared property ends with is one `update()` would refuse.
 */

const fs = require('fs');
const path = require('path');
const { test, ok, equal, contains } = require('../../lib/harness');
const { repoRoot } = require('../../lib/harness');

const ASSISTANT = 'rustyPlatform.assistant.';

/** Every `.ts` file under `src/`, as text — the audit reads the source, not the build output. */
function sourceFiles() {
    const out = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (full.endsWith('.ts')) out.push({ file: path.relative(repoRoot(), full), text: fs.readFileSync(full, 'utf8') });
        }
    };
    walk(path.join(repoRoot(), 'src'));
    return out;
}

const PACKAGE = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf8'));
const SOURCES = sourceFiles();
const ALL_TEXT = SOURCES.map((s) => s.text).join('\n');

const declaredCommands = new Set(PACKAGE.contributes.commands.map((c) => c.command));
const declaredSettings = new Set(Object.keys(PACKAGE.contributes.configuration.properties));
const viewIds = new Set(Object.values(PACKAGE.contributes.views).flat().map((v) => v.id));

// An ESP project cannot build without espup's environment, and the extension host has never sourced
// `~/export-esp.sh`. A cargo the extension starts *itself* must be handed `espEnv()` or it dies inside
// `build.rs`, reports no diagnostics at all, and leaves the repair loop with nothing to fix — which is exactly
// how "Fix the Build" came to look broken on a real project (2026-10-12).
test('a build the extension starts itself is handed espup\'s environment', () => {
    const text = sourceOf('src/ai/editor.ts');
    ok(text !== '', 'the AI editor is where the in-process builds live');
    // The calls are one line each; the declaration carries no `mode:`, so it filters itself out.
    const calls = (text.match(/buildProject\([^\n]*/g) ?? []).filter((call) => /mode:\s*'(check|build)'/.test(call));
    ok(calls.length >= 2, `the check and the repair loop both build in-process (found ${calls.length})`);
    for (const call of calls) {
        ok(call.includes('espEnv()'), `every in-process build needs the ESP environment: ${call.trim()}`);
    }
});

// `src/ui.rs` names the widgets and calls their handlers, so it is part of the design and has to be rewritten
// with it. It used to be written only by the wizard, so a project whose design changed kept a module calling a
// handler the design no longer had — an `E0425` that nothing in the design explains (2026-10-12).
test('the designer regenerates src/ui.rs as well as the markup', () => {
    const text = sourceOf('src/designer/editor.ts');
    ok(text !== '', 'the designer host is where a save is written');
    contains(text, 'emitUiRs(document', 'the generated module comes from the design');
    contains(text, 'DESIGNER_MODULE_PATH', 'and is written to the module the project builds');
    contains(text, 'await this.syncModule(document)', 'on every save, beside the handlers and the rotation');
});

/** One source file, as text, for the checks that are about a particular place. */
function sourceOf(relative) {
    const entry = SOURCES.find((s) => s.file === relative);
    return entry === undefined ? '' : entry.text;
}

test('every AI command the source runs is one the extension declares', () => {
    const executed = new Set();
    for (const { text } of SOURCES) {
        for (const match of text.matchAll(/executeCommand\(\s*['"]([\w.]+)['"]/g)) executed.add(match[1]);
    }
    const missing = [...executed].filter((command) => {
        if (!command.startsWith(ASSISTANT)) return false;
        if (declaredCommands.has(command)) return false;
        // `rustyPlatform.assistant.focus` is generated by VS Code for the contributed view of the same name —
        // `openPanel` reveals the container and then focuses the view — so it needs no `contributes.commands`
        // entry of its own. It is allowed only when that view really is contributed.
        const viewCommand = /^(.+)\.focus$/.exec(command);
        return !(viewCommand && viewIds.has(viewCommand[1]) && `${viewCommand[1]}.focus` === command && viewCommand[1] === 'rustyPlatform.assistant');
    });
    equal(missing, [], `commands the source runs but package.json does not declare: ${missing.join(', ')}`);
    ok(executed.size > 10, 'the audit actually found the assistant commands');
});

test('every declared AI command is registered by the extension', () => {
    const registered = new Set();
    for (const { text } of SOURCES) {
        for (const match of text.matchAll(/registerCommand\(\s*['"]([\w.]+)['"]/g)) registered.add(match[1]);
    }
    const missing = [...declaredCommands]
        .filter((command) => command.startsWith(ASSISTANT) && !registered.has(command));
    // A palette entry nobody registered is a click that fails with "command not found" — which is exactly what
    // "My own llama-server" did before this test existed.
    equal(missing, [], `declared but never registered: ${missing.join(', ')}`);
});

test('every AI setting the source reads or writes is declared', () => {
    const used = new Map();
    const pattern = /(?:cfg|config|configView\([^)]*\)|getConfiguration\([^)]*\))\.(?:get|update)(?:<[^>]*>)?\(\s*['"]([\w.]+)['"]/g;
    for (const { file, text } of SOURCES) {
        for (const match of text.matchAll(pattern)) if (!used.has(match[1])) used.set(match[1], file);
    }
    ok(used.size > 15, `the audit found the settings (${used.size})`);
    const undeclared = [...used]
        .filter(([key]) => {
            const last = key.split('.').pop();
            // Suffix match: the source writes `llamaServerArgs`, the manifest holds
            // `rustyPlatform.assistant.llamaServerArgs`.
            return ![...declaredSettings].some((declared) => declared === key || declared.endsWith(`.${last}`));
        })
        .map(([key, file]) => `${key} (${file})`);
    // `WorkspaceConfiguration.update()` on one of these throws "… is not a registered configuration", which is
    // how the panel's own settings handler failed.
    equal(undeclared, [], `settings used in the source but declared nowhere: ${undeclared.join(', ')}`);
});

test('every declared AI setting says what it does', () => {
    // House style, and the reason the six new ones are worth reading in the Settings UI at all: a bare name
    // like "llamaServerStartTarget" tells a novice nothing.
    const bare = Object.entries(PACKAGE.contributes.configuration.properties)
        .filter(([key, value]) => key.startsWith('rustyPlatform.assistant.') && !value.markdownDescription && !value.description)
        .map(([key]) => key);
    equal(bare, [], `settings with no description: ${bare.join(', ')}`);
});

test('the llama-server settings the new flow writes are the declared ones', () => {
    // Named explicitly as well as by the audit above, because these are the six that were missing and the
    // failure they caused was a silent no-op rather than a compile error.
    for (const key of ['llamaServerPath', 'llamaServerModelPath', 'llamaServerArgs', 'llamaServerService', 'llamaServerStartTarget', 'loadContextLength', 'loadGpu', 'loadTtlSeconds']) {
        ok(declaredSettings.has(`rustyPlatform.assistant.${key}`), `rustyPlatform.assistant.${key} is declared`);
    }
    for (const command of ['rustyPlatform.assistant.startLlamaServer', 'rustyPlatform.assistant.stopLlamaServer']) {
        ok(declaredCommands.has(command), `${command} is declared`);
        ok(ALL_TEXT.includes(`registerCommand('${command}'`), `${command} is registered`);
    }
});

test('the settings form sends only what the user changed', () => {
    // A textual guard, and deliberately so: this is a live-webview rule that no unit test can run. On
    // 2026-10-04 the view still showed LM Studio's 1234 after "use the llama-server already running on 8080"
    // (the palette flow pinned 8080 and nothing told the view), the user pressed Save to try to fix it, and
    // that stale form wrote 1234 back over the pin — after which every prompt failed with "No server
    // answered". Sending the whole form, changed or not, is how a settings panel overwrites a fresh pin.
    const chat = fs.readFileSync(path.join(repoRoot(), 'src/ui/aiChatView.ts'), 'utf8');
    ok(chat.includes('let applied ='), 'the form remembers what it was last told');
    ok(chat.includes('String(now[key]) !== String(applied[key])'), 'Save posts the diff, not the whole form');
    ok(chat.includes("if (Object.keys(settings).length === 0)"), 'and an empty diff is not a write');
});

test('the chat offers to implement the code in an answer', () => {
    // A textual guard, like the settings-form one: this is a live-webview contract no unit test can click.
    // The rule "is there code in this answer" must stay in ONE place — the extension computes the labels and
    // the view only draws them — or the button and the apply would disagree about which block was meant.
    const chat = fs.readFileSync(path.join(repoRoot(), 'src/ui/aiChatView.ts'), 'utf8');
    ok(chat.includes('rustCodeBlocks'), 'the view is told which answers carry code');
    ok(chat.includes("type: 'applyCode'"), 'and the button posts the turn it belongs to');
    ok(chat.includes('await applyChatCode('), 'which the extension applies through the one diff-and-write path');
    // The dangerous half: applying into the *proposal* preview would be a write to nowhere.
    const editor = fs.readFileSync(path.join(repoRoot(), 'src/ai/editor.ts'), 'utf8');
    ok(editor.includes("active.document.uri.scheme === 'file'"), 'a proposal diff is never a target file');
    ok(editor.includes('insertChatCode'), 'an item is placed, a whole file replaces');
});

test('the chat can be an editor tab, which is the only shape that leaves the window', () => {
    // Asked 2026-10-05: "run the Chat window outside of the IDE on a 2nd monitor … in an editor pane which can
    // be dragged outside of the IDE window?" A side-bar *view* cannot leave the window in VS Code; an *editor*
    // tab can be moved into its own OS window. So the panel must exist, and both surfaces must share one
    // transcript — a second copy of the state would be two conversations pretending to be one.
    const chat = fs.readFileSync(path.join(repoRoot(), 'src/ui/aiChatView.ts'), 'utf8');
    ok(chat.includes('createWebviewPanel'), 'the editor-tab panel exists');
    ok(chat.includes('const surfaces = new Set<vscode.Webview>()'), 'and it is one of a set of surfaces');
    ok(chat.includes('for (const surface of surfaces)'), 'posting goes to every open surface');
    ok(chat.includes('function attach('), 'both surfaces are wired through one function');
    ok(chat.includes('registerWebviewViewProvider') && chat.includes('attach(this, webviewView.webview)'),
        'the view still works and shares that function');
    for (const command of ['rustyPlatform.assistant.openEditor']) {
        ok(declaredCommands.has(command), `${command} is declared`);
        ok(chat.includes(`registerCommand('${command}'`), `${command} is registered`);
    }
});

test('the editor-tab chat comes back after a reload', () => {
    // Asked 2026-10-05: the tab (and the copy dragged onto a second monitor) must return where it was. VS Code
    // restores a custom panel only if a serializer is registered for its view type — and the type must be the
    // very one `createWebviewPanel` was called with, or the tab is silently dropped.
    const chat = fs.readFileSync(path.join(repoRoot(), 'src/ui/aiChatView.ts'), 'utf8');
    ok(chat.includes('registerWebviewPanelSerializer'), 'a serializer is registered');
    ok(/const CHAT_PANEL_TYPE = 'rustyPlatform\.assistantChat'/.test(chat), 'the view type is a named constant');
    ok((chat.match(/CHAT_PANEL_TYPE/g) || []).length >= 3, 'and the same constant is used to create and to restore it');
    ok(chat.includes('function wireChatPanel('), 'a restored panel is wired by the same code as a new one');
    ok((chat.match(/wireChatPanel\(/g) || []).length >= 3, 'both paths call it');
});

test('the side panel itself can move the chat into an editor pane', () => {
    // Asked 2026-10-05: the move must be reachable from the Rusty Platform side panel, not only from the
    // Command Palette — a button in the view's own footer and an action in its title bar, both running the one
    // command (so there is no second path to keep in step).
    const chat = fs.readFileSync(path.join(repoRoot(), 'src/ui/aiChatView.ts'), 'utf8');
    ok(chat.includes('id="openEditorTab"'), 'the view renders the button');
    ok(chat.includes("command: 'rustyPlatform.assistant.openEditor'"), 'and it runs the same command');
    const titles = PACKAGE.contributes.menus['view/title'];
    ok(titles.some((m) => m.command === 'rustyPlatform.assistant.openEditor' && m.when === 'view == rustyPlatform.assistant'),
        'the view title bar offers it too');
});

test('a long line in the chat wraps instead of scrolling sideways', () => {
    // Asked 2026-10-25: "change the chat box in the AI ASSIST section to do auto-wrapping of long text lines."
    // A fenced block is what widened the log: `pre` keeps `white-space: pre` and `overflow-x: auto`, so one
    // long Rust line scrolled the chat box rather than wrapping in it. Plain prose already wrapped (a browser
    // measurement showed `scrollWidth === clientWidth` for every turn), which is why only these rules change.
    // Measured in a real browser at 709 px and at 320 px: the log, every turn and the `pre` all end at
    // `scrollWidth === clientWidth` once these are in place.
    const chat = fs.readFileSync(path.join(repoRoot(), 'src/ui/aiChatView.ts'), 'utf8');
    const rule = (selector) => {
        const at = chat.indexOf(selector + ' {');
        ok(at >= 0, `${selector} is styled`);
        return chat.slice(at, chat.indexOf('}', at));
    };
    for (const selector of ['#log', '.turn']) {
        ok(rule(selector).includes('overflow-wrap: anywhere'), `${selector} breaks a long word`);
    }
    const pre = rule('.turn pre');
    ok(pre.includes('white-space: pre-wrap'), 'a fenced block wraps its own lines');
    ok(pre.includes('overflow-wrap: anywhere'), 'even a token with no space in it');
    ok(!pre.includes('overflow-x: auto'), 'and the sideways scrollbar is gone');
    ok(rule('.error').includes('overflow-wrap: anywhere'), 'a compiler message carrying a long path wraps too');
});

test('the chat follows the newest row, and stops when the reader scrolls up', () => {
    // Asked 2026-10-31: "In the AI Assist chat windows: make the chat panel scroll down automatically as new
    // rows are added at the bottom." There were already three `log.scrollTop = log.scrollHeight` lines, so the
    // missing piece is not one more of them: the *streamed* token path returned before its scroll (the panel
    // showed the top of an answer while the rest was written below the fold), and `#log` sized itself from its
    // content (`flex: 1 1 auto`), so the page could grow rather than the log scroll.
    const chat = fs.readFileSync(path.join(repoRoot(), 'src/ui/aiChatView.ts'), 'utf8');
    const at = chat.indexOf('#log {');
    ok(at >= 0, '#log is styled');
    const logRule = chat.slice(at, chat.indexOf('}', at));
    ok(logRule.includes('flex: 1 1 0'), 'the log takes the space left over, so it is the element that scrolls');

    ok(chat.includes('function scrollToEnd()'), 'there is one helper that jumps to the bottom');
    ok(chat.includes('if (!follow) return;'), 'and it leaves the view alone once the reader has scrolled up');
    // Every write to the log funnels through it: a turn, a streamed token, the settled answer, an error, the
    // code buttons and a restored history are all child or text changes inside the log.
    ok(chat.includes('new MutationObserver(() => scrollToEnd())'), 'a single observer covers all of them');
    ok(/\.observe\(log, \{ childList: true, subtree: true, characterData: true \}\)/.test(chat),
        'it watches added rows, nested tokens and text replacements');
    // Reading "is it at the bottom" after a token arrives would see the answer growing and mistake it for the
    // reader scrolling away. Only a *decrease* in scrollTop is the reader moving up.
    ok(/if \(top < lastTop - 4\) follow = false;/.test(chat), 'scrolling up stops the follow');
    ok(/else if \(atBottom\(\)\) follow = true;/.test(chat), 'and reaching the bottom again resumes it');
    ok((chat.match(/follow = true;/g) || []).length >= 3,
        'asking, and opening a conversation, start following again');
});

test('the status line says the model is loaded once it has answered', () => {
    // Reported 2026-10-31: after a whole working conversation the AI Assist line still read "not in memory
    // yet; the next request loads it". Two things were wrong and both are pinned here — the fact (it took
    // LM Studio's registry as the only evidence of a load, so anything else never showed as loaded) and the
    // moment (the line is drawn when the panel opens or the settings save, so an answer never redrew it).
    const panel = fs.readFileSync(path.join(repoRoot(), 'src/ai/panel.ts'), 'utf8');
    ok(panel.includes('Model loaded and active'), 'the wording the user asked for');
    ok(/answeredHere\(endpoint, model\)/.test(panel), 'and an answer at this address counts as loaded');
    const assistant = fs.readFileSync(path.join(repoRoot(), 'src/ai/assistant.ts'), 'utf8');
    ok(assistant.includes('noteModelAnswered(cfg.endpoint, cfg.model)'),
        'every reply records which model answered where');
    const chat = fs.readFileSync(path.join(repoRoot(), 'src/ui/aiChatView.ts'), 'utf8');
    ok(chat.includes("void statusLine().then((text) => post({ type: 'status', text }))"),
        'and the line is redrawn after the reply, not only at the next open or save');
});

test('Enter sends the prompt and Shift+Enter starts a new line', () => {
    // Asked 2026-10-31: "I also want to launch the prompt when pressing the 'Enter' key and, 'Shift+Enter' for
    // doing a 'New Line' in the prompt entry box." Before this, Enter was a newline and only Ctrl/Cmd+Enter
    // sent — which the panel never said anywhere. Checked in a real browser: Shift+Enter leaves the box holding
    // "first line\nsecond line" and posts nothing; Enter then posts that exact text, newline included, and
    // clears the box; Enter on an empty box posts nothing.
    const chat = fs.readFileSync(path.join(repoRoot(), 'src/ui/aiChatView.ts'), 'utf8');
    ok(chat.includes("if (e.key !== 'Enter' || e.shiftKey) return;"), 'a bare Enter is the only one that sends');
    ok(chat.includes('e.isComposing'), 'an IME accepting a candidate is not a send');
    ok(chat.includes("document.getElementById('ask').click();"), 'sending is the button\'s own path, not a second copy');
    ok(chat.includes('title="Enter sends · Shift+Enter starts a new line"'), 'and the box says so');
});

test('the prompt carries the selection, from either chat surface', () => {
    // Asked 2026-10-31: "enable the AI Assist model to be able to read selected text in the active editor tab".
    // `fileBlock` is the one place the active file entered a prompt, and it read the whole document and nothing
    // else. The second half is the surface: as an editor tab the chat *is* the active editor, so VS Code reports
    // no `activeTextEditor` while it has the focus — the remembered Rust editor is what the selection comes from.
    const chat = fs.readFileSync(path.join(repoRoot(), 'src/ui/aiChatView.ts'), 'utf8');
    ok(chat.includes('editor.selection'), 'the selection is read');
    ok(chat.includes('selectionContext('), 'and turned into a prompt block by the tested helper');
    ok(/if \(!selection\.isEmpty\)/.test(chat), 'a selection replaces the whole file rather than joining it');
    ok(chat.includes('selection.end.character === 0'),
        'a selection that ends at the start of a line does not claim that line');
    ok(chat.includes('onDidChangeActiveTextEditor'), 'the last Rust editor is remembered');
    ok(chat.includes('lastRustEditor.document.isClosed'), 'and a closed document is not used');
    const assistant = fs.readFileSync(path.join(repoRoot(), 'src/ai/assistant.ts'), 'utf8');
    ok(assistant.includes('export function selectionContext('), 'the block builder lives with the rest of the prompt maths');
});

test('the prompt carries the Problems pane, and only the parts worth sending', () => {
    // Asked 2026-10-31: "enable the ai model to access (read) the Problems … panes". The pane is a view of
    // `getDiagnostics()`, so this is a read, not a scrape — but it also holds every rust-analyzer hint, and a
    // small model given those answers the lint instead of the question.
    const chat = fs.readFileSync(path.join(repoRoot(), 'src/ui/aiChatView.ts'), 'utf8');
    ok(chat.includes('vscode.languages.getDiagnostics()'), 'the pane is read through its API');
    ok(/getWorkspaceFolder\(uri\)/.test(chat), 'only this workspace is quoted');
    ok(chat.includes('vscode.DiagnosticSeverity.Error'), 'errors are collected');
    ok(chat.includes('vscode.DiagnosticSeverity.Warning'), 'warnings are too');
    ok(!/DiagnosticSeverity\.(Hint|Information)/.test(chat), 'and hints/info are left in the pane');
    ok(chat.includes('formatProblems('), 'the text is built by the tested formatter');
    ok(/projectFacts\(\), fileBlock\(\), problemsBlock\(\)/.test(chat), 'and every question carries it');
});

test('the Debug Console is read through a tracker registered before any session', () => {
    // Asked 2026-10-31: "enable the ai model to access (read) the … Debug Console … panes". A pane's text has no
    // API; the console is made of the adapter's own messages, and a tracker only sees what happens after it is
    // attached — so the factory is registered at activation, not when a question is asked.
    const reader = fs.readFileSync(path.join(repoRoot(), 'src/ai/debugConsole.ts'), 'utf8');
    ok(reader.includes("registerDebugAdapterTrackerFactory('*'"), 'the factory is registered for every adapter');
    ok(reader.includes("session.type.startsWith('probe-rs')"), 'but only probe-rs sessions are recorded');
    ok(reader.includes("message.event === 'output'"), 'console output is collected');
    ok(reader.includes("message.event === 'stopped'") && reader.includes("message.event === 'exited'"),
        'and a stop or an exit is kept where it happened');
    ok(/lines = \[\];/.test(reader), 'a new session starts with an empty console');
    ok(reader.includes('formatDebugConsole('), 'the text is built by the tested formatter');
    const extension = fs.readFileSync(path.join(repoRoot(), 'src/extension.ts'), 'utf8');
    ok(extension.includes('registerDebugConsoleReader()'), 'and it is registered when the extension activates');
    const chat = fs.readFileSync(path.join(repoRoot(), 'src/ui/aiChatView.ts'), 'utf8');
    ok(/problemsBlock\(\), debugConsoleBlock\(\)/.test(chat), 'every question carries the console too');
});

test('the "Console only" toggle sends the console and nothing else', () => {
    // Asked 2026-10-31, after the console was wired in: a defmt stream is the longest block in the prompt, so
    // "what does this output mean?" was answered with the file, the Problems pane and the board facts taking up
    // the window. The toggle is per question, not a setting: the next question usually wants everything again.
    const chat = fs.readFileSync(path.join(repoRoot(), 'src/ui/aiChatView.ts'), 'utf8');
    ok(chat.includes('id="consoleOnly"'), 'the box has the switch');
    ok(chat.includes("consoleOnly: document.getElementById('consoleOnly').checked"),
        'and every way of asking (the button and Enter) sends its state');
    ok(chat.includes('async function contextBlock(consoleOnly = false)'), 'the context builder takes the flag');
    ok(chat.includes('if (consoleOnly) return debugConsoleBlock()'), 'and a console-only question gets only that');
    ok(chat.includes('The Debug Console has no lines in it yet.'), 'an empty console says so rather than sending nothing');
    ok(/message\.consoleOnly === true/.test(chat), 'the host reads the flag from the message');
    ok(!chat.includes("getConfiguration('rustyPlatform').update('consoleOnly'"),
        'and it is not written to settings');
});

test('a chat answer that would empty a function is questioned before the diff', () => {
    // Reported 2026-10-31 by the user, with a screenshot of the diff: a stray character in `main()` was
    // answered with a two-line `main`, and applying it would have erased the body. The rule lives with the other
    // answer checks; the question is asked in `applyChatCode`, where the file being replaced is known.
    const editor = fs.readFileSync(path.join(repoRoot(), 'src/ai/editor.ts'), 'utf8');
    ok(editor.includes('itemReplacementRisk(text,'), 'the answer is weighed against the function it replaces');
    ok(/risk !== undefined/.test(editor), 'and a risky one is asked about');
    ok(editor.includes("'Show the diff',") && editor.includes("'Cancel'"),
        'with the diff still available — a wholesale rewrite can be a real request');
    // It has to be *before* the proposal, or the user meets the deletion in the diff with no explanation.
    ok(editor.indexOf('itemReplacementRisk(text,') < editor.indexOf('proposed = insertChatCode(text,'),
        'before anything is proposed');
    const rustCode = fs.readFileSync(path.join(repoRoot(), 'src/ai/rustCode.ts'), 'utf8');
    ok(rustCode.includes('export function itemReplacementRisk('), 'and the rule itself is pure and tested');
});

test('the "not a complete piece of Rust" refusal offers the answer\'s other block', () => {
    // Reported 2026-10-31: "when clicking on 'Ok' nothing happens". A refusal with one button is a dead end when
    // the change is in the same answer, so the view finds the complete block and the host offers it by name —
    // offered, never applied silently, because the user clicked the quote.
    const chat = fs.readFileSync(path.join(repoRoot(), 'src/ui/aiChatView.ts'), 'utf8');
    ok(chat.includes('completeAlternative(blocks.map((b) => b.code), chosen)'),
        'the view looks for the stand-in among that answer\'s blocks');
    ok(chat.includes('applyChatCode(block.code, {'), 'and passes it with the block that was clicked');
    ok(/label: codeBlockLabel\(block\.code\),\s*\n\s*alternative,/.test(chat), 'including its own label and the stand-in');
    const editor = fs.readFileSync(path.join(repoRoot(), 'src/ai/editor.ts'), 'utf8');
    ok(editor.includes('alternative?: { code: string; label: string }'), 'the host takes it as an option');
    ok(editor.includes('const take = `Apply ${what}`'), 'and asks with a button that names it');
    ok(editor.includes('return applyChatCode(alternative.code, { label: alternative.label, retry: opts.retry });'),
        'the accepted offer goes through the same path as a normal answer, retry and all');
    ok(editor.indexOf('unbalancedAnswer(`${snippet}\\n`) !== undefined ? opts.alternative') <
        editor.indexOf("void vscode.window.showWarningMessage(problem, { modal: true }, 'OK')"),
        'the offer comes before the dead end');
    // And when neither block can be applied, the refusal still leads somewhere: a button that asks the chat for
    // the whole function, instead of a modal whose only button is OK (reported 2026-10-31: "i dont see any
    // changes" — nothing was applied, and nothing said what to do next).
    ok(chat.includes('retry: (question) => ask(question)'), 'the chat hands the refusal a way to ask again');
    ok(editor.includes("const again = 'Ask for it in full'"), 'the refusal offers it by name');
    ok(editor.includes('if (pick === again && opts.retry) await opts.retry(retryQuestion('), 'and sends the pinned question');
});

test('a diagnostic offers a one-line fix beside the whole-function one', () => {
    // Asked 2026-10-31: "Do the 'Fix this line' option". It is the answer to a model that cannot be trusted to
    // reproduce a function — the line fix structurally cannot delete anything, because its answer is one line.
    ok(declaredCommands.has('rustyPlatform.assistant.fixLine'), 'the command is declared');
    const editor = fs.readFileSync(path.join(repoRoot(), 'src/ai/editor.ts'), 'utf8');
    ok(editor.includes("registerCommand('rustyPlatform.assistant.fixLine'"), 'and registered');
    ok(editor.includes('export async function fixLineWithAI('), 'the flow exists');
    ok(editor.includes("'Fix this line with the AI assist'"), 'the quick fix is offered on a diagnostic');
    ok(editor.indexOf("'Fix this line with the AI assist'") < editor.indexOf("'Fix with the AI assist'"),
        'above the function rewrite, because it is the smaller change');
    ok(/oneLineAnswer\(answer\.text\)/.test(editor), 'the answer is parsed as one line');
    ok(/replacementLine\(original, fixed\.line\)/.test(editor), 'and checked before it replaces anything');
    ok(editor.includes('AI: line ${at}'), 'the diff names the line it changes');
    // The proposal is the file with exactly one line swapped — nothing else can move.
    ok(/\[\.\.\.lines\.slice\(0, at - 1\), checked\.line, \.\.\.lines\.slice\(at\)\]\.join\(/.test(editor),
        'one line out, one line in');
});

test('the chat has an Abort button for the answer in flight', () => {
    // Asked 2026-10-31: "add an 'Abort' button to stop the current AI response".
    const chat = fs.readFileSync(path.join(repoRoot(), 'src/ui/aiChatView.ts'), 'utf8');
    ok(chat.includes('id="abort"'), 'the button is in the panel');
    ok(chat.includes("vscode.postMessage({ type: 'abort' })"), 'and it posts abort');
    ok(/stop\.disabled = !busy/.test(chat), 'it is only enabled while a request runs');
    ok(/case 'abort'/.test(chat), 'the host handles it');
    ok(/abortable\.abort\(\)/.test(chat), 'the request in flight is aborted');
    ok(/if \(abortable === controller\) abortable = undefined/.test(chat), 'and the reference is cleared when it ends');
    ok(chat.includes('⏹ Stopped'), 'the panel says the answer was stopped rather than reporting an error');
    ok(/controller\?\.signal\.aborted === true/.test(chat), 'an abort is not treated as a failure');
});

test('the line fix cannot answer with a function: prompt, budget and entry point', () => {
    // Asked 2026-10-31: "Why will the model not just replace a single line containing the error. It is rewriting
    // the complete function." Four reasons, and each is closed here: the system message now says patcher (see the
    // rust-code test), the enclosing function is no longer sent, the answer budget cannot hold a function, and
    // the way in is offered where the user actually got stuck — the chat's refusal.
    const editor = fs.readFileSync(path.join(repoRoot(), 'src/ai/editor.ts'), 'utf8');
    ok(editor.includes('const LINE_FIX_TOKENS = 200'), 'the budget is a number, not a hope');
    ok(/maxTokens: Math\.min\(cfg\.maxTokens, LINE_FIX_TOKENS\), temperature: 0/.test(editor),
        'and it is enforced, greedily, on the request itself');
    ok(!/buildLineFixPrompt\(\{[\s\S]{0,400}?item:/.test(editor), 'the enclosing function is not sent at all');
    ok(editor.includes('firstErrorIn(target)'), 'a refused chat answer can be set aside for the compiled line');
    ok(editor.includes("const justLine = 'Fix just that line'"), 'offered by name in the refusal');
    ok(/if \(pick === justLine && lineFix\)[\s\S]{0,200}?fixLineWithAI\(target/.test(editor),
        'and it runs the one-line fix on the diagnosed line');
});

test('the one-line answer budget belongs to the line fix, not to the chat', () => {
    // Asked 2026-10-31: "Is the response capped at 200 tokens only for fixing problems, or … for general prompts
    // as well? 'Longest answer' is 5120 in my test app." It is only for the line fix — and the two ways it could
    // have leaked are pinned here.
    const editor = fs.readFileSync(path.join(repoRoot(), 'src/ai/editor.ts'), 'utf8');
    const chat = fs.readFileSync(path.join(repoRoot(), 'src/ui/aiChatView.ts'), 'utf8');
    ok(!chat.includes('LINE_FIX_TOKENS'), 'the chat never sees the one-line budget');
    ok(chat.includes('chatWithRescue(cfg, messages'), 'it sends the settings as they are');
    // Exactly one request is built with the cap: the line fix. (`LINE_FIX_TOKENS` appears in its comment, its
    // constant and the one `maxTokens:` expression, nothing else.)
    ok((editor.match(/LINE_FIX_TOKENS/g) || []).length <= 5, 'and the constant is used in one place');
    ok(!/maxTokens: Math\.min\(cfg\.maxTokens, LINE_FIX_TOKENS\)[\s\S]{0,2000}?export async function fixWithAI/.test(editor),
        'the function-level fix keeps the settings budget — it has to rewrite a function');
    // The rescue retry must keep the caller's shape: it re-reads settings for the address, but `maxTokens` and
    // `temperature` belong to the request. Without this a rescued line fix went out with 5120 tokens.
    ok(/const fresh = await configWithEndpoint\(assistantConfig\(\)\)/.test(editor), 'the retry re-reads the address');
    ok(/maxTokens: cfg\.maxTokens, temperature: cfg\.temperature/.test(editor),
        'and keeps the request\'s own answer budget');
});
