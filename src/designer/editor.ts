/**
 * The designer's host: the panel, the files, and the conversation with the frontend.
 *
 * The split is deliberate and matches `design/rotation.ts`: this file is the only one that touches `vscode`
 * and the filesystem, and everything it can be wrong about -- parsing a stored document, deciding what is
 * written when a design does not validate, spotting an asset that is not in the project -- lives in
 * `store.ts` where it is tested. What is left here is plumbing, and the two places where the panel and the
 * project must agree:
 *
 * - **The rotation.** The designed area is derived from the panel size and the rotation, and the rotation is
 *   a project setting the firmware reads at build time. So when the designer's rotation changes, the
 *   project's `.cargo/esp-config.toml` is rewritten to match, in the same place the wizard's prompt writes
 *   it. Two places holding the same number is a bug waiting to happen, and this is the seam that stops it.
 * - **The assets.** The crate's macro reads image and mesh files at compile time, so a design that passes
 *   every document-level check can still fail to build. The panel is told, while the design is open, rather
 *   than at the next compile.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BoardProfile } from '../boards/types';
import { readActiveProject, readProjectAt } from '../project/activeProject';
import { lcdRotationFromConfig, setLcdRotationInConfig, type LcdRotation } from '../display/rotation';
import {
    DESIGNER_DOCUMENT_PATH,
    DESIGNER_HANDLERS_PATH,
    DESIGNER_KDL_PATH,
    DESIGNER_MODULE_PATH,
    createDocument,
    designCanvasSize,
    screenIdFrom,
    type DesignerDocument,
} from './model';
import { loadDocument, missingAssets, renderDesign } from './store';
import type { DesignerInbound, DesignerReport } from './protocol';
import { designerStyles } from './styles';

/** The open panel, so a second invocation reveals the first rather than opening a duplicate. */
let current: DesignerPanel | undefined;

/** The panel's own state: where it writes, what it is designed for, and the webview showing it. */
class DesignerPanel {
    private document: DesignerDocument;
    private disposables: vscode.Disposable[] = [];
    /** Set once the document has been written, so the first edit is a change and not a rewrite. */
    private lastWritten = '';

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly context: vscode.ExtensionContext,
        private readonly output: vscode.OutputChannel,
        private readonly folder: vscode.Uri,
        private readonly board: BoardProfile | undefined,
        document: DesignerDocument,
        private readonly loadError: string | undefined,
    ) {
        this.document = document;
        this.panel.webview.html = this.shell();
        this.panel.webview.onDidReceiveMessage(
            (message: DesignerInbound) => void this.receive(message),
            undefined,
            this.disposables,
        );
        this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    }

    /**
     * Opens the designer for a project.
     *
     * `projectRoot` is the folder the designer is *about*: the wizard passes the folder it has just written,
     * which may not be a workspace folder at all. Without it the active project is used.
     */
    static async show(
        context: vscode.ExtensionContext,
        output: vscode.OutputChannel,
        projectRoot?: vscode.Uri,
    ): Promise<void> {
        const project = projectRoot === undefined ? await readActiveProject() : await readProjectAt(projectRoot);
        if (project === undefined) {
            void vscode.window.showWarningMessage('Open a Rusty Platform project before opening the designer.');
            return;
        }
        const board = project.board;
        if (board === undefined || board.kind !== 'esp' || board.displays.length === 0) {
            void vscode.window.showWarningMessage(
                `The designer needs a board with a panel, and ${board?.name ?? 'this project'} has none.`,
            );
            return;
        }

        if (current !== undefined) {
            current.panel.reveal();
            return;
        }

        const configPath = vscode.Uri.joinPath(project.folder, '.cargo', 'esp-config.toml');
        const config = (await readText(configPath)) ?? '';
        const rotation = lcdRotationFromConfig(config);

        const stored = await readText(vscode.Uri.joinPath(project.folder, DESIGNER_DOCUMENT_PATH));
        const loaded = loadDocument(stored ?? '');
        const folderName = project.folder.path.split('/').pop() ?? 'Panel';
        // The board's own panel: every display it ships has the same size on the boards here, and a board
        // whose revisions differed in size would have to say which one this project was generated for. The
        // chosen panel is recorded in the generated `main.rs`, which is not something this can read back, so
        // the first display is the answer and the document keeps its own copy of the size.
        const display = board.displays[0];
        const document =
            loaded.document ??
            createDocument({
                boardId: board.id,
                panelWidth: display?.width ?? 320,
                panelHeight: display?.height ?? 480,
                rotation,
                screenId: screenIdFrom(folderName),
            });

        const panel = vscode.window.createWebviewPanel(
            'rustyDesigner',
            `Designer: ${document.screenId}`,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')],
            },
        );
        current = new DesignerPanel(panel, context, output, project.folder, board, document, loaded.error);
        output.appendLine(
            `[designer] ${folderName}: canvas ${designCanvasSize(document.panelWidth, document.panelHeight, document.rotation).width}x` +
                `${designCanvasSize(document.panelWidth, document.panelHeight, document.rotation).height} at rotation ${document.rotation}`,
        );
    }

    /** The webview document: a shell with the bundle and the styles, and a strict policy. */
    private shell(): string {
        const script = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview', 'designer.js'),
        );
        const source = this.panel.webview.cspSource;
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${source} data:; style-src 'unsafe-inline'; script-src ${source};">
<title>Designer</title>
<style>${designerStyles()}</style>
</head>
<body>
<div id="designer"></div>
<script src="${script}"></script>
</body>
</html>`;
    }

    private async receive(message: DesignerInbound): Promise<void> {
        if (message.type === 'ready') {
            await this.sendInit();
            return;
        }
        if (message.type === 'changed') {
            await this.save(message.document);
            return;
        }
        if (message.type === 'action') {
            await this.act(message.action);
        }
    }

    private async sendInit(): Promise<void> {
        const canvas = designCanvasSize(this.document.panelWidth, this.document.panelHeight, this.document.rotation);
        await this.panel.webview.postMessage({
            type: 'init',
            document: this.document,
            canvas,
            paths: { document: DESIGNER_DOCUMENT_PATH, kdl: DESIGNER_KDL_PATH },
            touch: (this.board?.kind === 'esp' && this.board.touch !== undefined) || false,
            loadError: this.loadError,
        });
    }

    /**
     * Validates a document and writes what may be written.
     *
     * The document is written even when it does not validate -- it is the user's work -- and the markup is
     * only written when it does, so a half-finished canvas never breaks the next build. Both are skipped when
     * the text has not changed, because a drag would otherwise rewrite the same files dozens of times.
     */
    private async save(document: DesignerDocument): Promise<void> {
        this.document = document;
        const rendered = renderDesign(document);
        const assets = missingAssets(document, (relative) => this.assetExists(relative));
        const problems = [...rendered.problems, ...assets];

        if (rendered.documentJson !== this.lastWritten) {
            await writeProjectFile(this.folder, DESIGNER_DOCUMENT_PATH, rendered.documentJson);
            this.lastWritten = rendered.documentJson;
        }
        if (rendered.kdl !== undefined) {
            await writeProjectFile(this.folder, DESIGNER_KDL_PATH, rendered.kdl);
        }
        await this.syncRotation(document.rotation);

        const report: DesignerReport = {
            type: 'report',
            problems,
            kdl: rendered.kdl,
            wroteDocument: true,
        };
        await this.panel.webview.postMessage(report);
    }

    /** Keeps the project's own rotation setting in step with the design it was drawn for. */
    private async syncRotation(rotation: LcdRotation): Promise<void> {
        const configUri = vscode.Uri.joinPath(this.folder, '.cargo', 'esp-config.toml');
        const existing = (await readText(configUri)) ?? '';
        const updated = setLcdRotationInConfig(existing, rotation);
        if (updated !== existing) {
            await writeProjectFile(this.folder, '.cargo/esp-config.toml', updated);
            this.output.appendLine(`[designer] LCD_ROTATION set to ${rotation}`);
        }
    }

    /**
     * Whether an asset a design names is actually in the project.
     *
     * Synchronous on purpose: `missingAssets` is a pure function over a document, and turning it into
     * something that awaits would spread promises through the validation for one `stat` per asset. These are
     * a handful of local paths, resolved against a folder already known to exist.
     */
    private assetExists(relative: string): boolean {
        return fs.existsSync(path.join(this.folder.fsPath, relative));
    }

    private async act(action: 'revealKdl' | 'revealDocument' | 'build' | 'revealProject'): Promise<void> {
        if (action === 'revealKdl') {
            await this.reveal(DESIGNER_KDL_PATH);
        } else if (action === 'revealDocument') {
            await this.reveal(DESIGNER_DOCUMENT_PATH);
        } else if (action === 'build') {
            await vscode.commands.executeCommand('rustyPlatform.build');
        } else {
            await vscode.commands.executeCommand('revealInExplorer', this.folder);
        }
    }

    private async reveal(relative: string): Promise<void> {
        const uri = vscode.Uri.joinPath(this.folder, relative);
        try {
            await vscode.window.showTextDocument(uri, { preview: false });
        } catch {
            void vscode.window.showWarningMessage(
                `${relative} does not exist yet: it is written as soon as the design is valid. ` +
                    `The generated project also needs ${DESIGNER_MODULE_PATH} and ${DESIGNER_HANDLERS_PATH}.`,
            );
        }
    }

    private dispose(): void {
        current = undefined;
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
    }
}

/** Opens (or reveals) the designer, for the active project or for a named folder. */
export async function showDesigner(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    projectRoot?: vscode.Uri,
): Promise<void> {
    await DesignerPanel.show(context, output, projectRoot);
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
    try {
        return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
        return undefined;
    }
}

/**
 * Writes a file inside the project, creating whatever directories it needs.
 *
 * The parent is worked out with `path` rather than `Uri.joinPath(uri, '..')`, which does not promise to
 * normalise the way a filesystem path does -- and a directory literally named `..` is not what anyone means.
 */
async function writeProjectFile(folder: vscode.Uri, relative: string, content: string): Promise<void> {
    const uri = vscode.Uri.joinPath(folder, relative);
    const parent = path.dirname(uri.fsPath);
    if (!fs.existsSync(parent)) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(parent));
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
}
