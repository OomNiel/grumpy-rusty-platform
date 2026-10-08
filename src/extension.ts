import * as vscode from 'vscode';
import { RustyState } from './state';
import { BoardsViewProvider } from './ui/boardsView';
import { ProjectViewProvider } from './ui/projectView';
import { ControlsViewProvider } from './ui/controlsView';
import { StatusBarView } from './ui/statusBar';
import { registerNewProjectCommand } from './commands/newProject';
import { registerDesignerCommands } from './commands/designerCommands';
import { registerLcdRotationSync } from './display/rotationSync';
import { registerProjectCommands } from './commands/projectCommands';
import { registerDebugCommand } from './commands/debugProject';
import { trackDebugSessions } from './project/debugSessions';
import { registerLibraryCommands } from './commands/libraryCommands';
import { registerWifiCommands } from './commands/wifiCommands';
import { registerToolchainCommands } from './commands/toolchainCommands';
import { disposeTerminals } from './commands/terminal';
import { initAiLog } from './ai/log';
import { initPickerFolders } from './ai/pickers';
import { registerAssistantEditorCommands } from './ai/editor';
import { publishDeb, installDeb } from './commands/debCommands';
import { backupProject } from './commands/backupCommand';
import { registerAiChatView } from './ui/aiChatView';
import { initModelRuntime } from './ai/runtime';
import { initLlamaServer, registerLlamaServerCommands } from './ai/llamaServer';

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
        registerLcdRotationSync(output),
        ...registerProjectCommands(state, output, context),
        ...registerDesignerCommands(context, output),
        ...registerDebugCommand(state, output, context),
        ...registerWifiCommands(context, output),
        trackDebugSessions(),
        ...registerLibraryCommands(state, output),
        ...registerToolchainCommands(state, output),
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

    // Kick off detection in the background so activation stays fast.
    void state.refresh();
}

export function deactivate(): void {
    disposeTerminals();
}
