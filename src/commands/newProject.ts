import * as vscode from 'vscode';
import { BOARDS } from '../boards/catalog';
import { BoardProfile } from '../boards/types';
import {
    AppTemplate,
    crateNameFrom,
    defaultTemplateFor,
    generateProjectFiles,
    isAcceptableProjectName,
    requiredFirmware,
    templatesFor,
} from '../generate/files';
import {
    LCD_ROTATION_CHOICES,
    LCD_ROTATION_LABELS,
    LcdRotation,
    templateUsesPanel,
} from '../display/rotation';
import { installFirmwareIntoProject } from '../toolchain/cyw43FirmwareRunner';
import { ensureEspToolchain } from './espToolchainCommands';
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

/**
 * Wireless boards can generate more than one kind of application, so ask which one.
 * Wired boards have a single option and are not asked about at all.
 */
async function pickTemplate(board: BoardProfile): Promise<AppTemplate | undefined> {
    const options = templatesFor(board);
    if (options.length === 1) {
        return options[0]?.id ?? defaultTemplateFor(board);
    }
    const picked = await vscode.window.showQuickPick(
        options.map((info) => ({
            label: info.label,
            detail: info.description,
            template: info.id,
        })),
        {
            title: `${board.name} — what should it do?`,
            placeHolder: 'Application template',
        },
    );
    return picked?.template;
}

/**
 * How far to turn the panel.
 *
 * Only asked when the template actually drives one, and asked with the four values spelled out rather than
 * as 0-3: the number is what the firmware reads, but nobody thinks in it. The answer is written into the
 * project's config and settings, never into `src/main.rs`.
 */
async function pickRotation(board: BoardProfile, template: AppTemplate): Promise<LcdRotation | undefined> {
    if (!templateUsesPanel(template)) {
        return 0;
    }
    const picked = await vscode.window.showQuickPick(
        LCD_ROTATION_CHOICES.map((rotation) => ({
            label: LCD_ROTATION_LABELS[rotation],
            description: rotation === 0 ? 'recommended' : `${rotation}`,
            rotation,
        })),
        {
            title: `${board.name} — how is the panel mounted?`,
            placeHolder: 'LCD rotation',
        },
    );
    return picked?.rotation;
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

export function registerNewProjectCommand(output: vscode.OutputChannel): vscode.Disposable {
    return vscode.commands.registerCommand('rustyPlatform.newProject', async (boardId?: string) => {
        const board = await pickBoard(boardId);
        if (!board) {
            return;
        }

        const template = await pickTemplate(board);
        if (!template) {
            return;
        }

        const rotation = await pickRotation(board, template);
        if (rotation === undefined) {
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

        const files = generateProjectFiles({ board, projectName, template, rotation });
        for (const file of files) {
            const segments = file.path.split('/');
            const directory = vscode.Uri.joinPath(target, ...segments.slice(0, -1));
            await vscode.workspace.fs.createDirectory(directory);
            await vscode.workspace.fs.writeFile(
                vscode.Uri.joinPath(target, ...segments),
                Buffer.from(file.content, 'utf8'),
            );
        }

        // An ESP project cannot be built or flashed without the Xtensa toolchain, and the
        // natural moment to set it up is here, when the project that needs it appears.
        if (board.kind === 'esp') {
            await ensureEspToolchain(output);
        }

        // Wireless boards need the CYW43 blobs next to the generated firmware/README.md.
        // Only RP boards have a CYW43, so an ESP project has nothing to copy here.
        const blobNames =
            board.kind === 'rp'
                ? requiredFirmware(board, template).map((blob) => blob.fileName)
                : [];
        if (blobNames.length > 0) {
            try {
                await installFirmwareIntoProject(target, blobNames, { output });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                output.appendLine(`CYW43 firmware failed: ${message}`);
                output.show(true);
                const choice = await vscode.window.showErrorMessage(
                    `Project created, but the wireless firmware could not be fetched: ${message.split('\n')[0]}`,
                    'Show Log',
                );
                if (choice === 'Show Log') {
                    output.show(true);
                }
            }
        }

        const crateName = crateNameFrom(projectName);
        const action = await vscode.window.showInformationMessage(
            `Created ${crateName} for ${board.name} (${template}, ${files.length} files).`,
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
