import * as vscode from 'vscode';
import { BOARDS } from '../boards/catalog';
import { BoardProfile } from '../boards/types';
import { crateNameFrom, generateProjectFiles, isAcceptableProjectName } from '../generate/files';
import { runInTerminal } from './terminal';

async function pickBoard(preferredId: string | undefined): Promise<BoardProfile | undefined> {
    const defaultId = preferredId ?? vscode.workspace.getConfiguration('rustyPlatform').get<string>('defaultBoard');
    const ordered = [...BOARDS].sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId));

    const picked = await vscode.window.showQuickPick(
        ordered.map((board) => ({
            label: board.name,
            description: `${board.family} · ${board.target}`,
            detail: board.notes,
            board,
        })),
        { title: "Grumpy's Rusty Platform — select a board", placeHolder: 'Board', ignoreFocusOut: false },
    );
    return picked?.board;
}

async function pickParentFolder(): Promise<vscode.Uri | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        const chosen = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Create project here',
            title: 'Select the parent folder for the new project',
        });
        return chosen?.[0];
    }

    const options = [
        ...folders.map((folder) => ({
            label: `$(folder) ${folder.name}`,
            description: folder.uri.fsPath,
            uri: folder.uri,
        })),
        { label: '$(folder-opened) Choose another folder…', description: 'Pick a location outside this window', uri: undefined },
    ];

    const picked = await vscode.window.showQuickPick(options, {
        title: 'Where should the project go?',
        placeHolder: 'Parent folder',
    });
    if (!picked) {
        return undefined;
    }
    if (picked.uri) {
        return picked.uri;
    }
    const chosen = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Create project here',
    });
    return chosen?.[0];
}

async function ensureWritableTarget(target: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(target);
    } catch {
        return true; // does not exist: good
    }
    const choice = await vscode.window.showWarningMessage(
        `The folder already exists: ${target.fsPath}`,
        { modal: true },
        'Overwrite generated files',
    );
    return choice === 'Overwrite generated files';
}

export function registerNewProjectCommand(): vscode.Disposable {
    return vscode.commands.registerCommand('rustyPlatform.newProject', async (boardId?: string) => {
        const board = await pickBoard(boardId);
        if (!board) {
            return;
        }

        const projectName = await vscode.window.showInputBox({
            title: `${board.name} — project name`,
            prompt: 'Folder name and crate name for the new project',
            value: `blinky-${board.id}`,
            validateInput: (value) => {
                const verdict = isAcceptableProjectName(value);
                return verdict === true ? undefined : verdict;
            },
        });
        if (!projectName) {
            return;
        }

        const parent = await pickParentFolder();
        if (!parent) {
            return;
        }

        const target = vscode.Uri.joinPath(parent, projectName.trim());
        if (!(await ensureWritableTarget(target))) {
            return;
        }

        const files = generateProjectFiles({ board, projectName });
        for (const file of files) {
            const segments = file.path.split('/');
            const directory = vscode.Uri.joinPath(target, ...segments.slice(0, -1));
            await vscode.workspace.fs.createDirectory(directory);
            await vscode.workspace.fs.writeFile(
                vscode.Uri.joinPath(target, ...segments),
                Buffer.from(file.content, 'utf8'),
            );
        }

        const crateName = crateNameFrom(projectName);
        const action = await vscode.window.showInformationMessage(
            `Created ${crateName} for ${board.name} (${files.length} files).`,
            'Open Project',
            'Build Now',
            'Later',
        );

        if (action === 'Open Project') {
            await vscode.commands.executeCommand('vscode.openFolder', target, { forceNewWindow: false });
        } else if (action === 'Build Now') {
            runInTerminal(`Rusty: ${board.id}`, 'cargo build', target);
        }
    });
}
