import * as vscode from 'vscode';
import { detectBoardFromProject } from '../boards/detect';
import { BoardProfile } from '../boards/types';
import { DESIGNER_DOCUMENT_PATH } from '../designer/model';

export interface ActiveProject {
    folder: vscode.Uri;
    /** The contents of `Cargo.toml`, which is also what makes a folder a project of ours at all. */
    cargoToml: string;
    cargoConfigToml: string;
    board?: BoardProfile;
    chip?: string;
    /**
     * Whether this is a Designer (WYSIWYG) template project.
     *
     * The designer's own document is the marker: `designer/panel.ui.json` is written by the wizard for the
     * `designer` template and for no other, and it is the file the canvas reads back. A project without one
     * has no design to draw, which is what the sidebar's Open Designer row is gated on.
     */
    designer: boolean;
}

const CONFIG_RELATIVE = '.cargo/config.toml';

async function readFileIfPresent(uri: vscode.Uri): Promise<string | undefined> {
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(bytes).toString('utf8');
    } catch {
        return undefined;
    }
}

/** Whether the path exists at all; a `stat` rather than a read, since the design can be a large document. */
async function exists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

/**
 * Reads one folder as a project, or `undefined` when it holds no `Cargo.toml`.
 *
 * Separate from `readActiveProject` because a project the extension has just generated may not be a
 * workspace folder yet -- the designer is opened on the folder the wizard wrote, not on whatever happens to
 * be open in the window.
 */
export async function readProjectAt(folder: vscode.Uri): Promise<ActiveProject | undefined> {
    const cargoToml = await readFileIfPresent(vscode.Uri.joinPath(folder, 'Cargo.toml'));
    if (cargoToml === undefined) {
        return undefined;
    }
    const cargoConfigToml = (await readFileIfPresent(vscode.Uri.joinPath(folder, CONFIG_RELATIVE))) ?? '';
    const board = detectBoardFromProject({ cargoToml, cargoConfigToml });
    const chip =
        (board === undefined ? undefined : board.kind === 'rp' ? board.probeChip : board.espChip) ??
        /probe-rs\s+run\s+--chip\s+["']?([^\s"']+)["']?/.exec(cargoConfigToml)?.[1];
    const designer = await exists(vscode.Uri.joinPath(folder, DESIGNER_DOCUMENT_PATH));
    return { folder, cargoToml, cargoConfigToml, board, chip, designer };
}

/** First workspace folder that looks like an embedded project of ours. */
export async function readActiveProject(): Promise<ActiveProject | undefined> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const project = await readProjectAt(folder.uri);
        if (project !== undefined) {
            return project;
        }
    }
    return undefined;
}
