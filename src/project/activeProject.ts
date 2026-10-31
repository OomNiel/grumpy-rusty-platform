import * as vscode from 'vscode';
import { detectBoardFromProject } from '../boards/detect';
import { BoardProfile } from '../boards/types';
import { DESIGNER_DOCUMENT_PATH } from '../designer/model';
import { backendOrDefault } from '../generate/backends';
import { LANGUAGE_MARKER, SketchLanguage, isDesignerProject, readProjectLanguage } from './language';

export interface ActiveProject {
    folder: vscode.Uri;
    /**
     * The contents of the backend's marker file -- `Cargo.toml` for a Rust project, which is also what makes a
     * folder a project of ours at all.
     *
     * Empty for a project whose marker is a different file: the board is worked out from `Cargo.toml`, so a
     * project that has none simply has no board yet. Nothing generates such a project in this build.
     */
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
    /**
     * The language the sketch is in, resolved from the project's marker.
     *
     * A project with no marker is Rust, which is every project that existed before the Arduino backend was
     * planned; so is one whose marker names a language this build cannot generate. Nothing branches on this
     * yet -- it is read so that a project which *does* say what it is cannot be mistaken for one that says
     * nothing.
     */
    language: SketchLanguage;
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
 * Reads one folder as a project, or `undefined` when it holds no marker for its language.
 *
 * Separate from `readActiveProject` because a project the extension has just generated may not be a
 * workspace folder yet -- the designer is opened on the folder the wizard wrote, not on whatever happens to
 * be open in the window.
 */
export async function readProjectAt(folder: vscode.Uri): Promise<ActiveProject | undefined> {
    // The language first: it decides which file makes this a project at all. `Cargo.toml` is the Rust
    // backend's marker and the file the board is read out of, so for a Rust project this is one read for two
    // jobs; a project in another language has no Cargo.toml and therefore no board yet.
    const language = readProjectLanguage(
        await readFileIfPresent(vscode.Uri.joinPath(folder, LANGUAGE_MARKER)),
    );
    const backend = backendOrDefault(language);
    const marker = await readFileIfPresent(vscode.Uri.joinPath(folder, backend.markerFile));
    if (marker === undefined) {
        return undefined;
    }
    const cargoToml = backend.markerFile === 'Cargo.toml' ? marker : '';
    const cargoConfigToml = (await readFileIfPresent(vscode.Uri.joinPath(folder, CONFIG_RELATIVE))) ?? '';
    const board = detectBoardFromProject({ cargoToml, cargoConfigToml });
    const chip =
        (board === undefined ? undefined : board.kind === 'rp' ? board.probeChip : board.espChip) ??
        /probe-rs\s+run\s+--chip\s+["']?([^\s"']+)["']?/.exec(cargoConfigToml)?.[1];
    // The canvas's own markers: the design document, or -- for a sketch made before the C++ designer had one --
    // the generated screen it writes, which only the designer template produces.
    const designer = isDesignerProject({
        documentPresent: await exists(vscode.Uri.joinPath(folder, DESIGNER_DOCUMENT_PATH)),
        language: backend.id,
        hasCppScreen: await exists(vscode.Uri.joinPath(folder, 'src', 'ui.cpp')),
    });
    return { folder, cargoToml, cargoConfigToml, board, chip, designer, language: backend.id };
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
