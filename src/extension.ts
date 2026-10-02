import * as vscode from 'vscode';
import { RustyState } from './state';
import { BoardsViewProvider } from './ui/boardsView';
import { ProjectViewProvider } from './ui/projectView';
import { StatusBarView } from './ui/statusBar';
import { registerNewProjectCommand } from './commands/newProject';
import { registerProjectCommands } from './commands/projectCommands';
import { registerToolchainCommands } from './commands/toolchainCommands';
import { disposeTerminals } from './commands/terminal';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const output = vscode.window.createOutputChannel("Grumpy's Rusty Platform");
    const state = new RustyState(output);
    const boardsView = new BoardsViewProvider();
    const projectView = new ProjectViewProvider(state);
    const statusBar = new StatusBarView(state);

    context.subscriptions.push(
        output,
        state,
        statusBar,
        vscode.window.registerTreeDataProvider('rustyPlatform.boards', boardsView),
        vscode.window.registerTreeDataProvider('rustyPlatform.project', projectView),
        registerNewProjectCommand(output),
        ...registerProjectCommands(state),
        ...registerToolchainCommands(state, output),
        state.onDidChange(() => {
            statusBar.update();
            projectView.refresh();
        }),
        vscode.commands.registerCommand('rustyPlatform.refresh', async () => {
            boardsView.refresh();
            await state.refresh();
        }),
    );

    // Kick off detection in the background so activation stays fast.
    void state.refresh();
}

export function deactivate(): void {
    disposeTerminals();
}
