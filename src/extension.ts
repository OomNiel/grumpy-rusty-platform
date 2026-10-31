import * as vscode from 'vscode';
import { RustyState } from './state';
import { BoardsViewProvider } from './ui/boardsView';
import { ProjectViewProvider } from './ui/projectView';
import { ControlsViewProvider } from './ui/controlsView';
import { StatusBarView } from './ui/statusBar';
import { DESIGNER_PROJECT_CONTEXT } from './ui/controls';
import { registerNewProjectCommand } from './commands/newProject';
import { registerArduinoIntelliSenseCommand } from './commands/arduinoIntelliSenseCommand';
import { registerDesignerCommands } from './commands/designerCommands';
import { resumePendingDesigner } from './designer/pendingOpen';
import { registerLcdRotationSync } from './display/rotationSync';
import { registerProjectCommands } from './commands/projectCommands';
import { registerDebugCommand } from './commands/debugProject';
import { trackDebugSessions } from './project/debugSessions';
import { registerLibraryCommands } from './commands/libraryCommands';
import { registerWifiCommands } from './commands/wifiCommands';
import { registerToolchainCommands } from './commands/toolchainCommands';
import { registerRequirementsPrompt } from './commands/requirementsPrompt';
import { disposeTerminals } from './commands/terminal';
import { initAiLog } from './ai/log';
import { initPickerFolders } from './ai/pickers';
import { registerAssistantEditorCommands } from './ai/editor';
import { publishDeb, installDeb } from './commands/debCommands';
import { backupProject } from './commands/backupCommand';
import { registerAiChatView } from './ui/aiChatView';
import { registerDebugConsoleReader } from './ai/debugConsole';
import { initModelRuntime } from './ai/runtime';
import { initLlamaServer, registerLlamaServerCommands } from './ai/llamaServer';
import { enforceOffAtStartup } from './ai/assistantSwitch';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const output = vscode.window.createOutputChannel("Grumpy's Rusty Platform");
    // The AI subsystem logs through the same channel, so "which log do I read?" has one answer.
    initAiLog(output);
    initPickerFolders(context.globalState);
    // The two AI runtimes own child processes and per-window state, so they are created once here. Without
    // these calls `ensureBundledEndpoint` throws "the model runtime is not initialised", which is what the
    // chat's "No server answered" really was (2026-10-04).
    initModelRuntime(context);
    initLlamaServer(context);
    // A window that opens with the assistant switched off enforces that (unload the models, stop the server)
    // when the option says so. Not awaited: it can put a question on screen about a server this window did not
    // start, and activation must not wait for an answer.
    void enforceOffAtStartup();
    const state = new RustyState(output);
    const boardsView = new BoardsViewProvider();
    const projectView = new ProjectViewProvider(state);
    const controlsView = new ControlsViewProvider(state);
    const statusBar = new StatusBarView(state);

    context.subscriptions.push(
        output,
        state,
        statusBar,
        projectView,
        controlsView,
        vscode.window.registerTreeDataProvider('rustyPlatform.boards', boardsView),
        vscode.window.registerTreeDataProvider('rustyPlatform.project', projectView),
        vscode.window.registerTreeDataProvider('rustyPlatform.controls', controlsView),
        registerNewProjectCommand(context, output),
        registerArduinoIntelliSenseCommand(output),
        registerLcdRotationSync(output),
        ...registerProjectCommands(state, output, context),
        ...registerDesignerCommands(context, output),
        ...registerDebugCommand(state, output, context),
        ...registerWifiCommands(context, output),
        trackDebugSessions(),
        // The Debug Console as the AI Assist can read it: a debug adapter tracker must exist before a session
        // starts, so it is registered here and not when a question is asked (see `ai/debugConsole.ts`).
        registerDebugConsoleReader(),
        ...registerLibraryCommands(state, output),
        ...registerToolchainCommands(state, output),
        // Missing requirements are announced when the window loads, and again when the open project makes a
        // different set of them true (an ESP project in a window that had none). `state.refresh()` below is what
        // feeds it, so this only has to subscribe.
        registerRequirementsPrompt(context, state, output),
        // The two packaging controls, registered here because the Controls view runs them by id.
        vscode.commands.registerCommand('rustyPlatform.publishDeb', () => publishDeb()),
        vscode.commands.registerCommand('rustyPlatform.installDeb', () => installDeb()),
        vscode.commands.registerCommand('rustyPlatform.backupProject', () => backupProject()),
        ...registerAssistantEditorCommands(),
        ...registerAiChatView(context),
        ...registerLlamaServerCommands(context),
        state.onDidChange(() => {
            statusBar.update();
            projectView.refresh();
            controlsView.refresh();
            // The Project view's title-bar icon for the designer follows the same answer as the sidebar row,
            // and a `view/title` entry can only read a context key -- so it is published here, beside the two
            // views that already refresh from the state.
            void vscode.commands.executeCommand(
                'setContext',
                DESIGNER_PROJECT_CONTEXT,
                state.hasDesignerProject,
            );
        }),
        vscode.commands.registerCommand('rustyPlatform.refresh', async () => {
            boardsView.refresh();
            await state.refresh();
        }),
        // Which toolchain is *required* depends on the open project, so a change of folder changes the
        // verdict: opening the CYD project where a Pico one was open must stop reporting "no probe" and
        // start reporting the ESP toolchain (and the other way round). Without this the health row keeps
        // answering for the project that was open when the window started.
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            void state.refresh();
        }),
    );

    // Last: making a new project part of the window can restart this host, and the Designer that was asked for
    // in the session that asked for the folder has to come back on this side of that restart. Opening a panel
    // before the rest of the wiring exists would be a different bug, so it waits until everything is set up.
    void resumePendingDesigner(context, output);

    // Kick off detection in the background so activation stays fast.
    void state.refresh();
}

export function deactivate(): void {
    disposeTerminals();
}
