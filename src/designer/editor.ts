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
import { pickSerialPort, serialPortCandidates, serialPortEntriesForPlatform } from '../flash/espFlash';
import { runShellCommand, updateClock } from '../flash/clockSync';
import { lcdRotationFromConfig, setLcdRotationInConfig, type LcdRotation } from '../display/rotation';
import { setTouchInConfig, touchFromConfig, touchNeededBy } from '../display/touchSetting';
import {
    DESIGNER_DOCUMENT_PATH,
    DESIGNER_HANDLERS_PATH,
    DESIGNER_KDL_PATH,
    DESIGNER_MODULE_PATH,
    createDocument,
    designCanvasSize,
    pinKeypads,
    screenIdFrom,
    type DesignerDocument,
} from './model';
import { loadDocument, missingAssets, planAssetImport, renderDesign } from './store';
import { parseBdfFont, type DesignFontPixels } from './bitmapFont';
import { bdfFromRaster, fontIdFromFile, isBitmapFontFile, type RasterisedFont } from './fontImport';
import { emitUiRs, handlerName, syncHandlerStubs } from './generate';
import { sdImagesNeedingCard } from './model';
import {
    copyVendoredCrates,
    hasVendoredCrates,
    readVendoredMarker,
    vendoredDescription,
    vendoredState,
    vendoredUpdateNeeded,
} from './vendored';
import type { DesignerActionId, DesignerAssetKind, DesignerInbound, DesignerReport } from './protocol';
import { designerStyles } from './styles';

/**
 * The file dialog's filters, one per kind of asset.
 *
 * These are the formats the build actually reads: BDF for fonts, OBJ and STL for meshes (the crate's own error
 * message lists them), and for images whatever the `image` crate decodes, which is the common raster set.
 *
 * A font field offers the system formats too. It cannot use them as they are -- the crate reads BDF -- but a
 * picker that refuses them only sends the user looking for a converter, and the importer is right here.
 */
const FONT_FILTERS: Record<string, string[]> = { 'Font files': ['bdf', 'ttf', 'otf', 'ttc'] };

const ASSET_FILTERS: Record<DesignerAssetKind, Record<string, string[]>> = {
    font: FONT_FILTERS,
    image: { Images: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp', 'tif', 'tiff'] },
    mesh: { '3D models': ['obj', 'stl'] },
    icon: { Images: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp', 'tif', 'tiff'] },
};

/** The open panel, so a second invocation reveals the first rather than opening a duplicate. */
let current: DesignerPanel | undefined;

/** The panel's own state: where it writes, what it is designed for, and the webview showing it. */
class DesignerPanel {
    private document: DesignerDocument;
    private disposables: vscode.Disposable[] = [];
    /** Set once the document has been written, so the first edit is a change and not a rewrite. */
    private lastWritten = '';
    /** What the canvas was last sent as its declared fonts, so a report does not resend them. */
    private fontSignature = '';
    /** Rasterisations in flight, keyed by request: the panel answers with the id it was given. */
    private readonly fontImports = new Map<
        string,
        { stem: string; pixelSize: number; assetRequestId?: string }
    >();

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly context: vscode.ExtensionContext,
        private readonly output: vscode.OutputChannel,
        private readonly folder: vscode.Uri,
        private readonly board: BoardProfile | undefined,
        document: DesignerDocument,
        private touchEnabled: boolean,
        private readonly loadError: string | undefined,
        private readonly loadNotes: string[],
        private readonly loadProblems: string[],
        written: string,
    ) {
        this.document = document;
        this.lastWritten = written;
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

        // The project's `codegen/` copy is what its Cargo.toml builds against, and a copy from an older version
        // may not know the markup this designer writes -- a triangle's six points, for one -- and would render
        // something else without complaining. Asked here, once, before anything is drawn on that promise.
        await ensureVendoredCrates(context, project.folder, output);

        const configPath = vscode.Uri.joinPath(project.folder, '.cargo', 'esp-config.toml');
        const config = (await readText(configPath)) ?? '';
        const rotation = lcdRotationFromConfig(config);

        const touchEnabled = touchFromConfig(config);
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

        // The design's own verdict, taken once, before anything is drawn: it decides both what gets written
        // back and what the panel says about the design it has just been handed.
        const rendered = renderDesign(document);

        // A design that had to be cleaned up on the way in is written back at once, markup and all. The cleanup
        // is usually what was *blocking* the markup: one property this version has no place for fails the whole
        // design, and a design that does not validate never has its markup written -- so the board went on
        // compiling the last save that worked while the canvas went on accepting edits. Waiting for the user's
        // first edit would leave that trap armed until they touched the canvas, which is the moment they had
        // already been tripped by it.
        if (loaded.notes !== undefined) {
            await writeProjectFile(project.folder, DESIGNER_DOCUMENT_PATH, rendered.documentJson);
            if (rendered.kdl !== undefined) {
                await writeProjectFile(project.folder, DESIGNER_KDL_PATH, rendered.kdl);
            }
            output.appendLine(`[designer] ${folderName}: ${loaded.notes.join('; ')}`);
        }

        // A design that does not validate is said out loud at *open* rather than only after the first edit. The
        // markup is not written for one, so the board is compiling an older design than the canvas shows -- and
        // a user who is told nothing has no reason to touch the canvas and find out.
        if (rendered.problems.length > 0) {
            output.appendLine(
                `[designer] ${folderName}: the design does not validate, so its markup was not written: ` +
                `${rendered.problems.join('; ')}`,
            );
        }

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
        current = new DesignerPanel(
            panel,
            context,
            output,
            project.folder,
            board,
            document,
            touchEnabled,
            loaded.error,
            loaded.notes ?? [],
            rendered.problems,
            // The cleaned design has just been written, so the first edit is a change rather than a rewrite.
            loaded.notes === undefined ? '' : rendered.documentJson,
        );
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
            if (message.action === 'revealHandler') {
                await this.revealHandler(message.widgetId);
            } else {
                await this.act(message.action);
            }
        }
        if (message.type === 'pickAsset') {
            await this.pickAsset(message.requestId, message.kind);
        }
        if (message.type === 'setTouch') {
            await this.setTouch(message.enabled);
        }
        if (message.type === 'fontRasterised') {
            await this.writeRasterisedFont(message);
        }
    }

    /**
     * Asks the panel to draw a font file, so it can be written out as a BDF.
     *
     * The round trip exists because the renderer does: the panel draws the face at the size asked for and
     * measures it, and this side writes the answer to `assets/` as a plain BDF. A `.bdf` picked here skips
     * the trip entirely -- it is already the format the pipeline wants, so it is copied in and declared.
     *
     * Refused politely rather than half-done: without an open panel there is no renderer, and without a
     * project folder there is nowhere to put the result.
     */
    async importFont(): Promise<void> {
        const chosen = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            openLabel: 'Import this font',
            filters: FONT_FILTERS,
        });
        const file = chosen?.[0];
        if (file === undefined) {
            return;
        }

        if (isBitmapFontFile(file.fsPath)) {
            try {
                const relative = await this.bringIn(file);
                await this.panel.webview.postMessage({
                    type: 'declareFont',
                    path: relative,
                    note: `${path.basename(relative)} is declared. Pick it in a widget's Font list.`,
                });
            } catch (error) {
                await this.reportImport(error);
            }
            return;
        }
        await this.rasterise(file);
    }

    /**
     * Draws a system font at a size the user picks, and answers whoever asked.
     *
     * `assetRequestId` is set when the request came from a widget's Font field: the answer is then the BDF that
     * was written, and the panel applies it as it does any other picked file -- which declares the font and
     * points the widget at it in one undo step. Without it the request came from the command, so the font is
     * declared and no widget is touched.
     */
    private async rasterise(file: vscode.Uri, assetRequestId?: string): Promise<void> {
        const stem = path.basename(file.fsPath).replace(/\.[^.]+$/, '');
        const sizeText = await vscode.window.showInputBox({
            title: `Draw ${stem} at how many pixels?`,
            prompt: 'A LCD face is usually 10 to 20 pixels tall; the glyph cell grows with the size.',
            value: '16',
            validateInput: (value) => {
                const size = Number(value);
                return Number.isFinite(size) && size >= 6 && size <= 64
                    ? undefined
                    : 'A size between 6 and 64 pixels';
            },
        });
        if (sizeText === undefined) {
            if (assetRequestId !== undefined) {
                // Cancelled. Answering with no path is what tells the panel to forget the request.
                await this.panel.webview.postMessage({ type: 'assetPicked', requestId: assetRequestId });
            }
            return;
        }
        const pixelSize = Math.round(Number(sizeText));

        try {
            const bytes = await vscode.workspace.fs.readFile(file);
            const requestId = `${stem}-${pixelSize}-${Date.now()}`;
            this.fontImports.set(requestId, { stem, pixelSize, assetRequestId });
            await this.panel.webview.postMessage({
                type: 'rasteriseFont',
                requestId,
                name: `rusty-import-${requestId}`,
                pixelSize,
                bytes: Buffer.from(bytes).toString('base64'),
            });
        } catch (error) {
            await this.reportImport(error, assetRequestId);
        }
    }

    /** The panel's answer: write it as a BDF, then hand it back to whoever asked for it. */
    private async writeRasterisedFont(message: {
        requestId: string;
        font?: RasterisedFont;
        error?: string;
    }): Promise<void> {
        const request = this.fontImports.get(message.requestId);
        this.fontImports.delete(message.requestId);
        if (request === undefined) {
            return;
        }
        if (message.font === undefined) {
            await this.reportImport(message.error ?? 'the font could not be drawn', request.assetRequestId);
            return;
        }
        try {
            const font = message.font;
            const text = bdfFromRaster(font, fontIdFromFile(request.stem));
            const relative = await this.writeBdf(`${request.stem}-${font.pixelSize}`, text);
            const name = path.basename(relative, '.bdf');
            this.output.appendLine(
                `[designer] imported ${request.stem} at ${font.pixelSize}px as ${relative} `
                + `(${font.width}x${font.height} cell, ${font.glyphs.length} glyphs)`,
            );
            if (request.assetRequestId !== undefined) {
                // A field asked, so the answer is the file: the panel declares it and points the widget at it.
                await this.panel.webview.postMessage({
                    type: 'assetPicked',
                    requestId: request.assetRequestId,
                    path: relative,
                });
                return;
            }
            await this.panel.webview.postMessage({
                type: 'declareFont',
                path: relative,
                note: `${name}.bdf is declared: ${font.width}x${font.height} at ${font.pixelSize}px. `
                    + 'Pick it in a widget\'s Font list.',
            });
        } catch (error) {
            await this.reportImport(error, request.assetRequestId);
        }
    }

    /**
     * Writes the BDF under `assets/<base>.bdf`, or reuses the file that already holds exactly these pixels.
     *
     * Picking the same face at the same size twice is easy to do -- the size prompt offers the same default
     * both times -- and a second identical file under a `_2` name is clutter in a folder the user keeps.
     */
    private async writeBdf(base: string, text: string): Promise<string> {
        let name = base;
        for (let n = 2; ; n += 1) {
            const relative = `assets/${name}.bdf`;
            const uri = vscode.Uri.joinPath(this.folder, relative);
            const existing = await readText(uri);
            if (existing === undefined) {
                const destination = path.join(this.folder.fsPath, ...relative.split('/'));
                await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destination)));
                await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
                return relative;
            }
            if (existing === text) {
                this.output.appendLine(`[designer] ${relative} already holds these pixels; reusing it`);
                return relative;
            }
            name = `${base}_${n}`;
        }
    }

    /** Copies a file into the project if it lives outside it, and returns its project-relative path. */
    private async bringIn(file: vscode.Uri): Promise<string> {
        const plan = planAssetImport({
            chosen: file.fsPath,
            projectRoot: this.folder.fsPath,
            taken: (relative) => this.assetExists(relative),
            separator: '/',
        });
        if (plan.copyFrom !== undefined) {
            const destination = path.join(this.folder.fsPath, ...plan.relativePath.split('/'));
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destination)));
            await vscode.workspace.fs.copy(
                vscode.Uri.file(plan.copyFrom),
                vscode.Uri.file(destination),
                { overwrite: false },
            );
            this.output.appendLine(`[designer] copied ${plan.copyFrom} in as ${plan.relativePath}`);
        }
        return plan.relativePath;
    }

    /** One sentence in the panel, and a line in the output channel -- no modal, since nothing was lost. */
    private async reportImport(error: unknown, assetRequestId?: string): Promise<void> {
        const text = error instanceof Error ? error.message : String(error);
        this.output.appendLine(`[designer] font import failed: ${text}`);
        if (assetRequestId !== undefined) {
            // A field is holding the request: answering it is what puts the reason beside the field and
            // clears it, instead of leaving the Font list waiting.
            await this.panel.webview.postMessage({
                type: 'assetPicked',
                requestId: assetRequestId,
                error: text.split('\n')[0],
            });
            return;
        }
        await this.panel.webview.postMessage({
            type: 'report',
            problems: [],
            note: `Font import failed: ${text.split('\n')[0]}`,
            kdl: undefined,
        });
    }

    /**
     * Writes the touch setting, and says that a rebuild is what makes it real.
     *
     * It is a compile-time environment variable, so the running firmware is unchanged until it is built again --
     * which the panel is told rather than left to discover.
     */
    private async setTouch(enabled: boolean): Promise<void> {
        const configUri = vscode.Uri.joinPath(this.folder, '.cargo', 'esp-config.toml');
        const existing = (await readText(configUri)) ?? '';
        const updated = setTouchInConfig(existing, enabled);
        if (updated !== existing) {
            await writeProjectFile(this.folder, '.cargo/esp-config.toml', updated);
        }
        this.touchEnabled = enabled;
        this.output.appendLine(`[designer] touch ${enabled ? 'enabled' : 'disabled'} for this project`);
        await this.panel.webview.postMessage({
            type: 'report',
            problems: touchNeededBy(this.document.widgets, enabled),
            note: enabled
                ? 'Touch enabled. Rebuild for it to take effect.'
                : 'Touch disabled. Rebuild for it to take effect.',
            kdl: undefined,
        });
    }

    /**
     * Chooses a file for an asset field and brings it into the project if it came from outside.
     *
     * The dialog is the extension's job (only it can open a native one, and only it knows the project folder);
     * the *edit* stays the panel's, which applies the returned path through its own undo history. A file from
     * outside is copied into `assets/` rather than referenced, because a design's paths are relative to the
     * project root and `../../somewhere/x.bdf` stops working the moment the folder moves.
     */
    private async pickAsset(requestId: string, kind: DesignerAssetKind): Promise<void> {
        const chosen = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            openLabel: 'Use this file',
            filters: ASSET_FILTERS[kind],
        });
        const file = chosen?.[0];
        if (file === undefined) {
            // Cancelled. Said explicitly rather than left hanging, so the panel forgets the request.
            await this.panel.webview.postMessage({ type: 'assetPicked', requestId });
            return;
        }
        if (kind === 'font' && !isBitmapFontFile(file.fsPath)) {
            // A system face cannot go in the project as it is: draw it, write the BDF, and answer the field
            // with the written file as though that were what had been picked.
            await this.rasterise(file, requestId);
            return;
        }

        try {
            const plan = planAssetImport({
                chosen: file.fsPath,
                projectRoot: this.folder.fsPath,
                taken: (relative) => this.assetExists(relative),
                separator: '/',
            });
            if (plan.copyFrom !== undefined) {
                const destination = path.join(this.folder.fsPath, ...plan.relativePath.split('/'));
                await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destination)));
                await vscode.workspace.fs.copy(
                    vscode.Uri.file(plan.copyFrom),
                    vscode.Uri.file(destination),
                    { overwrite: false },
                );
                this.output.appendLine(`[designer] copied ${plan.copyFrom} in as ${plan.relativePath}`);
            }
            await this.panel.webview.postMessage({
                type: 'assetPicked',
                requestId,
                path: plan.relativePath,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.output.appendLine(`[designer] could not use that file: ${message}`);
            await this.panel.webview.postMessage({
                type: 'assetPicked',
                requestId,
                error: message.split('\n')[0],
            });
        }
    }

    private async sendInit(): Promise<void> {
        const canvas = designCanvasSize(this.document.panelWidth, this.document.panelHeight, this.document.rotation);
        // A keypad is pinned to the bottom strip, and a design saved under another rotation has the
        // old shape's box: re-solve it before the canvas sees it, or the first drag is what fixes it.
        this.document = pinKeypads(this.document, canvas);
        const declared = this.declaredFonts();
        this.fontSignature = declared.signature;
        await this.panel.webview.postMessage({
            type: 'init',
            document: this.document,
            canvas,
            paths: { document: DESIGNER_DOCUMENT_PATH, kdl: DESIGNER_KDL_PATH },
            touchBoard: (this.board?.kind === 'esp' && this.board.touch !== undefined) || false,
            touchEnabled: this.touchEnabled,
            loadError: this.loadError,
            loadNotes: this.loadNotes,
            loadProblems: this.loadProblems,
            fonts: declared.fonts,
            fontNotes: declared.fontNotes,
        });
    }

    /**
     * The pixels of every BDF font the design declares, for the canvas to draw with.
     *
     * The panel cannot read a file, so a declared font is the one thing in a design whose appearance lives
     * outside the design -- and the canvas used to approximate it with the packed default, which made a
     * widget's preview a lie the moment a real face was involved. The conversion here is the crate's own
     * (`parse_bdf`), mirrored in `./bitmapFont`, so what the canvas draws is what the board will.
     *
     * A font that cannot be read is a note rather than a problem: the design still builds if the file is
     * there for the *code generator*, and this is only about the preview.
     */
    private declaredFonts(): Pick<DesignerReport, 'fonts' | 'fontNotes'> & { signature: string } {
        const fonts: Record<string, DesignFontPixels> = {};
        const notes: string[] = [];
        const signature: string[] = [];
        for (const font of this.document.fonts) {
            signature.push(`${font.id}:${font.src}:${font.chars}`);
            const relative = font.src.trim();
            if (relative === '') {
                notes.push(`"${font.id}" names no file, so the canvas draws it in the default face.`);
                continue;
            }
            let source: string;
            try {
                source = fs.readFileSync(path.join(this.folder.fsPath, ...relative.split('/')), 'utf8');
            } catch {
                notes.push(`"${font.id}" cannot be read at ${relative}, so the canvas draws it in the default face.`);
                continue;
            }
            const parsed = parseBdfFont(source, font.chars === '' ? undefined : font.chars);
            if ('error' in parsed) {
                notes.push(`"${font.id}" is not a font the canvas can read (${parsed.error}).`);
                continue;
            }
            fonts[font.id] = parsed.font;
        }
        return {
            fonts: Object.keys(fonts).length > 0 ? fonts : undefined,
            fontNotes: notes.length > 0 ? notes : undefined,
            signature: signature.join('|'),
        };
    }

    /**
     * Validates a document and writes what may be written.
     *
     * The document is written even when it does not validate -- it is the user's work -- and the markup is
     * only written when it does, so a half-finished canvas never breaks the next build. Both are skipped when
     * the text has not changed, because a drag would otherwise rewrite the same files dozens of times.
     */
    private async save(document: DesignerDocument): Promise<void> {
        const canvas = designCanvasSize(document.panelWidth, document.panelHeight, document.rotation);
        this.document = pinKeypads(document, canvas);
        const rendered = renderDesign(this.document);
        const assets = missingAssets(document, (relative) => this.assetExists(relative));
        // Reported, never enforced: a design with controls in it and touch switched off is a decision the user
        // is allowed to make -- a half-built design, or placeholder buttons -- but not a silent one.
        const touch = touchNeededBy(document.widgets, this.touchEnabled);
        // An image from the card has two requirements the design cannot state: the board must have a socket, and
        // the project must have the module that mounts it. Both are reported here because both fail at build
        // time otherwise -- `crate::sd::with_file` is named by the generated markup, so a project without it does
        // not compile, which is a much worse way to find out than a line in the panel.
        const sd = sdImagesNeedingCard(document.widgets).flatMap((id) => {
            // `sd` is a property of an ESP board profile, like `touch`, so the union has to be narrowed first.
            if (this.board?.kind !== 'esp' || this.board.sd === undefined) {
                return [
                    `"${id}": this image comes from the SD card, and ${this.board?.name ?? 'this board'
                    } has no card socket`,
                ];
            }
            const module = path.join(this.folder.fsPath, 'src', 'sd.rs');
            if (!fs.existsSync(module)) {
                return [
                    `"${id}": this project has no src/sd.rs, so nothing can read the card. Recreate the project ` +
                    'with this version of the extension, or add the module and its init call to src/main.rs',
                ];
            }
            return [];
        });
        const problems = [...rendered.problems, ...assets, ...touch, ...sd];

        if (rendered.documentJson !== this.lastWritten) {
            await writeProjectFile(this.folder, DESIGNER_DOCUMENT_PATH, rendered.documentJson);
            this.lastWritten = rendered.documentJson;
        }
        if (rendered.kdl !== undefined) {
            await writeProjectFile(this.folder, DESIGNER_KDL_PATH, rendered.kdl);
        }
        await this.syncRotation(document.rotation);
        await this.syncHandlers(document);
        await this.syncModule(document);

        // A declared font's pixels are only resent when the declarations changed: a report follows every
        // edit, and shipping a hundred glyph bitmaps per keystroke would be work done for nothing.
        const declared = this.declaredFonts();
        const fontsChanged = declared.signature !== this.fontSignature;
        this.fontSignature = declared.signature;
        const report: DesignerReport = {
            type: 'report',
            problems,
            kdl: rendered.kdl,
            wroteDocument: true,
            ...(fontsChanged ? { fonts: declared.fonts, fontNotes: declared.fontNotes } : {}),
        };
        await this.panel.webview.postMessage(report);
    }

    /**
     * Keeps the project's code-behind in step with the design.
     *
     * A handler is *appended* for an event the design has gained and never rewritten, so a function the user has
     * already filled in survives every save. A handler the design has *lost* -- a deleted widget, an unticked
     * event -- has its stub removed, but only while it is still exactly the stub this wrote, because deleting a
     * widget must not delete someone's work.
     *
     * The wizard owns creating this file. A project without one is left alone rather than handed a stub file
     * with no header, which would be a worse file than none at all.
     */
    private async syncHandlers(document: DesignerDocument): Promise<void> {
        const uri = vscode.Uri.joinPath(this.folder, DESIGNER_HANDLERS_PATH);
        const existing = await readText(uri);
        if (existing === undefined) {
            return;
        }
        const next = syncHandlerStubs(existing, document, this.touchEnabled);
        if (next !== existing) {
            await writeProjectFile(this.folder, DESIGNER_HANDLERS_PATH, next);
        }
    }

    /**
     * Keeps the generated Rust module in step with the design.
     *
     * `src/ui.rs` is generated, carries no user code, and is the file that *names* the widgets and calls their
     * handlers — so it has to be rewritten whenever the design changes. Only the wizard ever wrote it, which
     * left a project whose markup and module disagreed as soon as a widget was renamed or its events changed.
     * Found on a real project (2026-10-12): a stale `crate::ui_handlers::on_go_clicked()` call for a widget
     * that had become a `busy_wheel`, which is an `E0425` the moment that handler is pruned. The markup and
     * the module have to move together or the project stops building for a reason nothing in the design says.
     */
    private async syncModule(document: DesignerDocument): Promise<void> {
        const uri = vscode.Uri.joinPath(this.folder, DESIGNER_MODULE_PATH);
        const next = emitUiRs(document, this.touchEnabled);
        if ((await readText(uri)) !== next) {
            await writeProjectFile(this.folder, DESIGNER_MODULE_PATH, next);
        }
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

    private async act(action: DesignerActionId): Promise<void> {
        if (action === 'revealKdl') {
            await this.reveal(DESIGNER_KDL_PATH);
        } else if (action === 'revealDocument') {
            await this.reveal(DESIGNER_DOCUMENT_PATH);
        } else if (action === 'build') {
            await vscode.commands.executeCommand('rustyPlatform.build');
        } else if (action === 'updateClockTime') {
            await this.updateClockTime();
        } else {
            await vscode.commands.executeCommand('revealInExplorer', this.folder);
        }
    }

    /**
     * Sets the module's RTC to this PC's time, without a flash.
     *
     * The rules live in `../flash/clockSync`, where they are tested without a board: a design with no clock
     * is refused, a machine with no board on a port is refused, and a write that fails comes back as a
     * sentence rather than an exception -- a Monitor terminal holding the port is the usual cause. The
     * port is the same one Flash would use, so a configured `rustyPlatform.serialPort` is honoured.
     */
    private async updateClockTime(): Promise<void> {
        const hasClock = this.document.widgets.some((widget) => widget.tag === 'clock');
        const configured = vscode.workspace.getConfiguration('rustyPlatform').get<string>('serialPort');
        const port = hasClock
            ? pickSerialPort(serialPortCandidates(serialPortEntriesForPlatform()), configured)
            : undefined;
        const result = updateClock({
            hasClock,
            port,
            run: (command) => runShellCommand(command),
        });
        this.output.appendLine(`[designer] update time: ${result.message}`);
        if (result.ok) {
            void vscode.window.showInformationMessage(result.message);
        } else {
            void vscode.window.showWarningMessage(result.message);
        }
        // Said in the panel too: the developer's eye is on the canvas, not the notification corner.
        await this.panel.webview.postMessage({ type: 'report', problems: [], note: result.message });
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

    /**
     * Opens the code behind one widget's event, with the cursor on the handler.
     *
     * The panel asks for this when a widget is middle-clicked. A handler is a function in the project's own
     * `src/ui_handlers.rs` -- the one generated file the designer only ever appends to -- so "the code behind
     * this widget" means opening that file at `on_<widget>_<event>`. The first event is the one a widget was
     * given first, which is the order the handler stubs were appended in.
     */
    private async revealHandler(widgetId: string): Promise<void> {
        const widget = this.document.widgets.find((candidate) => candidate.id === widgetId);
        const event = widget?.events[0];
        if (widget === undefined || event === undefined) {
            return;
        }
        const name = handlerName(widget.id, event);
        const uri = vscode.Uri.joinPath(this.folder, DESIGNER_HANDLERS_PATH);
        let text: string;
        try {
            text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        } catch {
            void vscode.window.showWarningMessage(
                `${DESIGNER_HANDLERS_PATH} is written when the design is saved, and it is not there yet.`,
            );
            return;
        }
        // The same test `appendHandlerStubs` uses to decide a handler exists, so "it is in the file" and "the
        // designer will not add a second copy" cannot disagree.
        const line = text
            .split('\n')
            .findIndex((candidate) => new RegExp(`\\bfn\\s+${name}\\s*[(<]`).test(candidate));
        const editor = await vscode.window.showTextDocument(uri, { preview: false });
        if (line >= 0) {
            const position = new vscode.Position(line, 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
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
/**
 * Offers to refresh a project's vendored crates when they are not this extension's.
 *
 * Asked rather than done silently: `codegen/` is inside the user's project, and while it is our copy of our own
 * crates, overwriting files in someone's folder without a word is not something a plugin should do. "Later"
 * only means the next thing the user does is not this; the check will ask again next time the designer opens.
 */
async function ensureVendoredCrates(
    context: vscode.ExtensionContext,
    project: vscode.Uri,
    output: vscode.OutputChannel,
): Promise<void> {
    const version = String(context.extension.packageJSON.version ?? '');
    const marker = readVendoredMarker(project);
    const state = vendoredState({ hasCrates: hasVendoredCrates(project), marker, version });
    if (!vendoredUpdateNeeded(state)) {
        return;
    }
    output.appendLine(`[designer] ${vendoredDescription(state, marker)}`);
    const choice = await vscode.window.showInformationMessage(
        `The shapes this project builds with are not this extension's copy (${vendoredDescription(
            state,
            marker,
        )}). The designer can draw a shape the old copy will not render on the glass. Update them?`,
        'Update Crates',
        'Later',
    );
    if (choice !== 'Update Crates') {
        output.appendLine('[designer] vendored crates left as they are');
        return;
    }
    try {
        copyVendoredCrates(context, project, output);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[designer] could not update the vendored crates: ${message}`);
        void vscode.window.showErrorMessage(
            `The vendored crates could not be updated: ${message.split('\n')[0]}`,
        );
    }
}

export async function showDesigner(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    projectRoot?: vscode.Uri,
): Promise<void> {
    await DesignerPanel.show(context, output, projectRoot);
}

/**
 * Imports a font into the open designer.
 *
 * A command rather than a panel button, because the file dialog is the extension's and a menu entry is where
 * people look for it. Saying so plainly when no designer is open is the whole of the graceful handling: there
 * is no panel to draw the face, and a font imported into nothing would be a file in a folder nobody declared.
 */
export async function importFontIntoDesigner(): Promise<void> {
    if (current === undefined) {
        void vscode.window.showWarningMessage(
            'Open the designer first: an imported font is declared in a design, and needs its canvas to be drawn.',
        );
        return;
    }
    await current.importFont();
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
