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

/** First workspace folder that looks like an embedded Rust project. */
export async function readActiveProject(): Promise<ActiveProject | undefined> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const cargoToml = await readFileIfPresent(vscode.Uri.joinPath(folder.uri, 'Cargo.toml'));
        if (cargoToml === undefined) {
            continue;
        }
        const cargoConfigToml = (await readFileIfPresent(vscode.Uri.joinPath(folder.uri, CONFIG_RELATIVE))) ?? '';
        const board = detectBoardFromProject({ cargoToml, cargoConfigToml });
        const chip =
            (board === undefined ? undefined : board.kind === 'rp' ? board.probeChip : board.espChip) ??
            /probe-rs\s+run\s+--chip\s+["']?([^\s"']+)["']?/.exec(cargoConfigToml)?.[1];
        return { folder: folder.uri, cargoToml, cargoConfigToml, board, chip };
    }
    return undefined;
}
