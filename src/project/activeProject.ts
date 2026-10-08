import * as vscode from 'vscode';
import { detectBoardFromProject } from '../boards/detect';
import { BoardProfile } from '../boards/types';

export interface ActiveProject {
    folder: vscode.Uri;
    cargoToml: string;
    cargoConfigToml: string;
    board?: BoardProfile;
    chip?: string;
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

/**
 * Reads one folder as a project, or `undefined` when it does not hold a `Cargo.toml`.
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
    return { folder, cargoToml, cargoConfigToml, board, chip };
}

/** First workspace folder that looks like an embedded Rust project. */
export async function readActiveProject(): Promise<ActiveProject | undefined> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const project = await readProjectAt(folder.uri);
        if (project !== undefined) {
            return project;
        }
    }
    return undefined;
}
