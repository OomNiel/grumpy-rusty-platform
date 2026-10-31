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
import type { BoardProfile, EspBoardProfile, EspDisplay, EspTouch, RpBoardProfile } from '../boards/types';
import { displayForProject, hasBacklight, touchFor } from '../boards/esp';
import {
    panelModule,
    parseWiring,
    panelModuleOrDefault,
    planWiring,
    reservedPins,
    validateWiring,
    wiringFile,
    wiringHasErrors,
    type PanelWiring,
    type WiringProblem,
} from '../boards/panels';
import { emitPanelRs } from '../generate/rp-panel';
import { readActiveProject, readProjectAt } from '../project/activeProject';
import { pickSerialPort, serialPortCandidates, serialPortEntriesForPlatform } from '../flash/espFlash';
import { runShellCommand, updateClock } from '../flash/clockSync';
import { clockHostPlan } from '../flash/clockHost';
import { closeTerminal, openTerminalNames, runInTerminal } from '../commands/terminal';
import { lcdRotationFromConfig, setLcdRotationInConfig, type LcdRotation } from '../display/rotation';
import { setTouchInConfig, touchFromConfig, touchNeededBy } from '../display/touchSetting';
import {
    brightnessFromConfig,
    clampBrightness,
    setBrightnessInConfig,
} from '../display/backlight';
import {
    DESIGNER_DOCUMENT_PATH,
    DESIGNER_HANDLERS_PATH,
    DESIGNER_HARDWARE_PATH,
    DESIGNER_KDL_PATH,
    DESIGNER_MODULE_PATH,
    createDocument,
    designCanvasSize,
    pinKeypads,
    screenIdFrom,
    type DesignerDocument,
} from './model';
import { loadDocument, missingAssets, planAssetImport, renderDesign } from './store';
import { collectImageAssets, imageSourcesOf, type DesignerImageAsset } from './imageAssets';
import { parseBdfFont, type DesignFontPixels } from './bitmapFont';
import { bdfFromRaster, fontIdFromFile, isBitmapFontFile, type RasterisedFont } from './fontImport';
import { emitUiRs, handlerName, syncHandlerStubs, designHasClock, ESP_LOG_MACRO, RP_LOG_MACRO } from './generate';
import { emitHandlersCppHeader, emitUiCpp, emitUiCppHeader, syncHandlerStubsCpp } from './lvgl';
import { emitArduinoPanel } from '../generate/arduino';
import { sdImagesNeedingCard } from './model';
import { isFeatureInDefault, setFeatureInDefault } from './features';
import {
    copyVendoredCrates,
    hasVendoredCrates,
    readVendoredMarker,
    vendoredDescription,
    vendoredState,
    vendoredUpdateNeeded,
} from './vendored';
import type {
    DesignerActionId,
    DesignerAssetKind,
    DesignerHardware,
    DesignerInbound,
    DesignerReport,
} from './protocol';
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
        {
            stem: string;
            pixelSize: number;
            /** The face the glyphs are drawn from, now in the project: what a later resize redraws. */
            source?: string;
            /** Set when a field asked, so the answer goes back to that field rather than as a declaration. */
            assetRequestId?: string;
        }
    >();

    /**
     * Whether the clock listener has already been started for this panel.
     *
     * One attempt per open: a design with a clock starts the listener as soon as it is on screen, and
     * the button in the pane is the way to try again. Repeated starts would stack commands in the same
     * terminal, and the listener owns the port while it runs.
     */
    private clockServed = false;

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly context: vscode.ExtensionContext,
        private readonly output: vscode.OutputChannel,
        private readonly folder: vscode.Uri,
        private readonly board: BoardProfile | undefined,
        private readonly display: EspDisplay | undefined,
        document: DesignerDocument,
        private touchEnabled: boolean,
        private sdEnabled: boolean,
        private brightness: number,
        private backlightPwm: boolean,
        private readonly loadError: string | undefined,
        private readonly loadNotes: string[],
        private readonly loadProblems: string[],
        written: string,
        /**
         * The GPIO wiring, on a Pico project, and `undefined` on an ESP one.
         *
         * A Pico's panel is wired to the board, so its module and its pins are project facts the Hardware
         * panel edits. On an ESP board the panel is a property of the board and there is nothing to wire.
         */
        private wiring: PanelWiring | undefined,
        /** Everything wrong with `wiring`, as the panel shows it. */
        private wiringProblems: WiringProblem[],
        /** The file the project's compile-time settings live in, relative to the project root. */
        private readonly configRelative: string,
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
     * The touch controller this project can drive, if any.
     *
     * The panel's own controller or the board's: a DevKitC carries whatever module is plugged in, and only
     * some of those bring an XPT2046. A board with no controller has no touch code to compile and no switch.
     */
    private get touchController(): EspTouch | undefined {
        if (this.wiring !== undefined) {
            // A Pico's XPT2046 is part of the module, so the wiring is the authority: a module with a
            // controller and both of its pins is a touchscreen, whatever the shape of any board record.
            const module = panelModule(this.wiring.panel);
            if (module?.touch !== true || this.wiring.touchCs === null || this.wiring.touchIrq === null) {
                return undefined;
            }
            return {
                controller: 'XPT2046',
                cs: this.wiring.touchCs,
                irq: this.wiring.touchIrq,
                spiHz: 1_000_000,
            };
        }
        return this.board?.kind === 'esp' ? touchFor(this.board, this.display) : undefined;
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
        const isEspWithPanel = board !== undefined && board.kind === 'esp' && board.displays.length > 0;
        // A Pico always *can* drive a panel, so the marker is the project's own document: a blinky project
        // has no design to draw, and opening a canvas over it would write files its `main.rs` never calls.
        const isRp = board !== undefined && board.kind === 'rp' && project.designer;
        if (board === undefined || (!isEspWithPanel && !isRp)) {
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
        // A sketch builds with arduino-cli and has no `codegen/`: the crates are Rust's answer to a problem LVGL
        // does not have.
        if (project.language === 'rust') {
            await ensureVendoredCrates(context, project.folder, output);
        }

        // --- where this project's compile-time settings live.
        //
        // The two families keep them in different files for the same reason: each already has a file that is
        // read at build time. An ESP project has `.cargo/esp-config.toml` (esp-hal's own mechanism); a Pico has
        // cargo's `[env]` table in `.cargo/config.toml`, which is what `option_env!` sees.
        const configRelative = isEspWithPanel ? '.cargo/esp-config.toml' : '.cargo/config.toml';
        const configPath = vscode.Uri.joinPath(project.folder, ...configRelative.split('/'));
        const config = (await readText(configPath)) ?? '';
        const rotation = lcdRotationFromConfig(config);

        // SD is a cargo feature rather than an env key, so it is read out of `Cargo.toml`'s `default` rather
        // than out of the config file.
        const cargoToml = (await readText(vscode.Uri.joinPath(project.folder, 'Cargo.toml'))) ?? '';
        const sdEnabled = isFeatureInDefault(cargoToml, 'sd');
        const stored = await readText(vscode.Uri.joinPath(project.folder, DESIGNER_DOCUMENT_PATH));
        const loaded = loadDocument(stored ?? '');
        const folderName = project.folder.path.split('/').pop() ?? 'Panel';

        // --- the panel.
        //
        // An ESP board's panel is a property of the board (or of the module in its `panel-<id>` feature); a
        // Pico's is a wiring the project itself records, which is what the Hardware panel edits.
        let wiring: PanelWiring | undefined;
        let wiringProblems: WiringProblem[] = [];
        if (isRp) {
            const hardwareText = await readText(vscode.Uri.joinPath(project.folder, DESIGNER_HARDWARE_PATH));
            const parsed = parseWiring(
                hardwareText === undefined ? {} : safeJson(hardwareText),
                board as RpBoardProfile,
            );
            wiring = parsed.wiring;
            wiringProblems = validateWiring(board as RpBoardProfile, wiring);
            if (parsed.notes.length > 0) {
                output.appendLine(`[designer] ${folderName}: ${parsed.notes.join('; ')}`);
            }
        }
        const module = wiring === undefined ? undefined : panelModule(wiring.panel);
        // The panel this project was generated for. A board like the DevKitC takes any module plugged into it,
        // and the modules differ in size and in whether they bring a touch controller, so the manifest's own
        // `panel-<id>` feature is what settles it -- the generated `main.rs` is not something this can read
        // back. An older project with no such feature falls back to the board's own first panel.
        const display = isEspWithPanel ? displayForProject(board as EspBoardProfile, cargoToml) : undefined;
        const panelSize = module === undefined ? undefined : { width: module.width, height: module.height };
        // A panel with no controller has no touch code, whatever the config says: reading the key alone
        // generated pointer plumbing that nothing could call -- and a warning in the user's own project.
        const hasController = wiring === undefined
            ? touchFor(board as EspBoardProfile, display) !== undefined
            : module?.touch === true && wiring.touchCs !== null && wiring.touchIrq !== null;
        const touchEnabled = hasController ? touchFromConfig(config) : false;
        // The backlight is PWM in the firmware this version generates: a project from before that holds the
        // pin on, and the setting cannot reach it. Detected rather than assumed, because a slider that writes
        // a line nothing reads is worse than a disabled slider that says why. A Pico project generated by this
        // version always dims by PWM when BL is wired, which the wiring says.
        const mainRs = (await readText(vscode.Uri.joinPath(project.folder, 'src', 'main.rs'))) ?? '';
        const backlightPwm = wiring === undefined
            ? mainRs.includes('BACKLIGHT_DUTY_PCT')
            : wiring.backlight !== null;
        const brightness = brightnessFromConfig(config);
        const document =
            loaded.document ??
            createDocument({
                boardId: board.id,
                panelWidth: display?.width ?? panelSize?.width ?? 320,
                panelHeight: display?.height ?? panelSize?.height ?? 480,
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
            display,
            document,
            touchEnabled,
            sdEnabled,
            brightness,
            backlightPwm,
            loaded.error,
            loaded.notes ?? [],
            rendered.problems,
            // The cleaned design has just been written, so the first edit is a change rather than a rewrite.
            loaded.notes === undefined ? '' : rendered.documentJson,
            wiring,
            wiringProblems,
            configRelative,
        );
        // The code-behind is tidied on *opening* as well as on every save.
        //
        // A stub for an event the design no longer raises is a `dead_code` warning in the user's own crate,
        // and waiting for the next edit to remove it means the project keeps warning about a function whose
        // reason has already gone. Same rule as the document's own cleanup a few lines up: the file is put
        // right the moment the Designer looks at it, rather than on the user's first accidental nudge.
        await current.syncHandlers(document);

        output.appendLine(
            `[designer] ${folderName}: canvas ${designCanvasSize(document.panelWidth, document.panelHeight, document.rotation).width}x` +
            `${designCanvasSize(document.panelWidth, document.panelHeight, document.rotation).height} at rotation ${document.rotation}`,
        );
        // Automatic time setup: a design with a clock needs a host listening, and opening the design is
        // the first moment there is one to ask. It is one attempt, and the pane's button repeats it.
        current.autoServeClock();
    }

    /** The webview document: a shell with the bundle and the styles, and a strict policy. */
    private shell(): string {
        // The bundle's URL is stable across extension updates, and a webview resource at an unchanged URL can
        // be served from the panel's cache -- which looks exactly like a fix that never shipped. The stamp is
        // the version plus the file's mtime, so it changes on every install and reads as `0.15.0-1761…`.
        const bundle = vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview', 'designer.js');
        const version = (this.context.extension.packageJSON as { version?: string }).version ?? '0';
        let stamp = version;
        try {
            stamp = `${version}-${Math.round(fs.statSync(bundle.fsPath).mtimeMs)}`;
        } catch {
            // No bundle on disk: the URI is left as it is and the panel reports the missing script itself.
        }
        const script = this.panel.webview.asWebviewUri(bundle).with({ query: `v=${stamp}` });
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
        if (message.type === 'setWiring') {
            await this.setWiring(message.wiring, message.note);
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
        if (message.type === 'setSd') {
            await this.setSd(message.enabled);
        }
        if (message.type === 'setBrightness') {
            await this.setBrightness(message.percent);
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
            // The face is brought in before it is drawn: the BDF is a bitmap, and a resize has to be able to
            // draw the original again. A few hundred kilobytes is worth a size box that works.
            const source = await this.bringInSource(file);
            const bytes = await vscode.workspace.fs.readFile(file);
            const requestId = `${stem}-${pixelSize}-${Date.now()}`;
            this.fontImports.set(requestId, { stem, pixelSize, source, assetRequestId });
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
            const extras = request.source === undefined
                ? {}
                : { source: request.source, size: font.pixelSize };
            if (request.assetRequestId !== undefined) {
                // A field asked, so the answer is the file: the panel declares it and points the widget at it.
                await this.panel.webview.postMessage({
                    type: 'assetPicked',
                    requestId: request.assetRequestId,
                    path: relative,
                    ...(request.source === undefined
                        ? {}
                        : { font: { source: request.source, size: font.pixelSize } }),
                });
                return;
            }
            await this.panel.webview.postMessage({
                type: 'declareFont',
                path: relative,
                // No "pick it in the Font list" here: the panel points the selected widget at the font as
                // well, so naming the file and its cell is the whole of what the import did.
                note: `${name}.bdf is declared: ${font.width}x${font.height} at ${font.pixelSize}px.`,
                ...extras,
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

    /**
     * Brings a font face into the project under its own name, reusing an identical copy.
     *
     * The name is kept rather than deduped so a resize has one obvious file to redraw, and an identical
     * already-here face is reused instead of copied again -- importing the same face at two sizes would
     * otherwise leave two copies of a few hundred kilobytes each.
     */
    private async bringInSource(file: vscode.Uri): Promise<string> {
        const relative = `assets/${path.basename(file.fsPath)}`;
        try {
            const here = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.folder, relative));
            const there = await vscode.workspace.fs.readFile(file);
            if (
                here.length === there.length
                && Buffer.compare(Buffer.from(here), Buffer.from(there)) === 0
            ) {
                return relative;
            }
        } catch {
            // Not in the project yet, which is the ordinary case.
        }
        return this.bringIn(file);
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
            problems: this.touchController === undefined
                ? []
                : touchNeededBy(this.document.widgets, enabled),
            note: enabled
                ? 'Touch enabled. Rebuild for it to take effect.'
                : 'Touch disabled. Rebuild for it to take effect.',
            kdl: undefined,
        });
    }

    /**
     * Writes the panel's brightness, and says that a rebuild is what makes it real.
     *
     * The same arrangement as touch: a compile-time environment variable in `.cargo/esp-config.toml`, so the
     * running firmware keeps whatever it was built with. The value is clamped rather than refused -- a slider
     * cannot send anything out of range, and a stray value must not silently lose the setting.
     *
     * A project whose `src/main.rs` predates the PWM backlight has nothing that reads the line. It is still
     * written (the file is the project's truth), and the panel is told in so many words, because a control
     * that appears to work and changes nothing on the glass is the worst of the three outcomes.
     */
    private async setBrightness(percent: number): Promise<void> {
        const value = clampBrightness(percent);
        const configUri = vscode.Uri.joinPath(this.folder, ...this.configRelative.split('/'));
        const existing = (await readText(configUri)) ?? '';
        const updated = setBrightnessInConfig(existing, value);
        if (updated !== existing) {
            await writeProjectFile(this.folder, this.configRelative, updated);
        }
        this.brightness = value;
        this.output.appendLine(`[designer] backlight brightness ${value}% for this project`);
        await this.panel.webview.postMessage({
            type: 'report',
            problems: [],
            brightness: value,
            note: this.backlightPwm
                ? `Brightness ${value}%. Rebuild for it to take effect.`
                : `Brightness ${value}% is saved, but this project's src/main.rs still holds the backlight on. `
                + 'Recreate the project with this version of the extension (or drive the pin by PWM) for the '
                + 'setting to reach the panel.',
            kdl: undefined,
        });
    }

    /**
     * Switches the SD card on or off for the project.
     *
     * The card is a cargo feature (see `../generate/esp` and `./sdFeature`), so this is the cargo-toggle analogue
     * of `setTouch`: a project setting that changes the firmware, not the markup, written here because only the
     * extension can edit `Cargo.toml`. Enabling brings `embedded-sdmmc` (FAT) and `critical-section` back into
     * the build; disabling drops them again. Either way the board needs a rebuild before the change shows up.
     */
    private async setSd(enabled: boolean): Promise<void> {
        const cargoTomlUri = vscode.Uri.joinPath(this.folder, 'Cargo.toml');
        const existing = (await readText(cargoTomlUri)) ?? '';
        const { text, note } = setFeatureInDefault(existing, 'sd', enabled);
        // `none` means the manifest is already where it was asked to be -- or that it has no `[features]`
        // table to edit at all, which is every project generated before the card became a feature. Saying
        // "enabled" while nothing was written would be a lie the next build would expose.
        if (note === 'none' && isFeatureInDefault(existing, 'sd') !== enabled) {
            await this.refuseFeature(
                'sd',
                'This Cargo.toml has no `[features]` table, so the SD card cannot be switched here -- ' +
                'recreate the project with this version of the extension, or add the `sd` feature by hand.',
            );
            return;
        }
        if (note !== 'none') {
            await writeProjectFile(this.folder, 'Cargo.toml', text);
            this.output.appendLine(`[designer] SD ${enabled ? 'enabled' : 'disabled'} for this project`);
        }
        this.sdEnabled = enabled;
        // The pins follow the switch: on, the card is given the other bus's four; off, they are left free for
        // whatever comes next. Planned here rather than in the panel so that flipping the toolbar switch with
        // nothing else open still leaves the Hardware panel's numbers true.
        const moved = await this.planCardPins(enabled);
        const problems =
            !enabled && this.hasCardSocket
                ? sdImagesNeedingCard(this.document.widgets).map((id) =>
                    `"${id}": this image comes from the SD card, and SD is switched off -- turn it on in the toolbar and rebuild.`,
                )
                : [];
        await this.panel.webview.postMessage({
            type: 'report',
            problems,
            sdEnabled: this.sdEnabled,
            hardware: this.hardwareReport(),
            note:
                (enabled
                    ? 'SD card enabled. The FAT filesystem (embedded-sdmmc) is now compiled in; rebuild for it to take effect.'
                    : 'SD card disabled. The FAT filesystem (embedded-sdmmc) is no longer compiled in; rebuild for it to take effect.') +
                (moved.length > 0 ? ` ${moved.join('. ')}.` : ''),
            kdl: undefined,
        });
    }

    /**
     * Re-plans the card's pins for the SD switch, and rewrites the hardware file when they changed.
     *
     * Turning the card on gives it the bus the panel is *not* on; turning it off frees those four pins so the
     * panes read "Free" rather than showing a socket nothing is compiled against. Everything else keeps the
     * pin it already had -- the bus did not change, so nothing else should move.
     *
     * Returns the planner's notes, so the caller can say what moved.
     */
    private async planCardPins(enabled: boolean): Promise<string[]> {
        const board = this.board;
        if (this.wiring === undefined || board === undefined || board.kind !== 'rp') {
            return [];
        }
        const { wiring, notes } = planWiring({
            panel: this.wiring.panel,
            bus: this.wiring.bus,
            alt: this.wiring.alt,
            sd: enabled,
            reserved: reservedPins(board),
            timeSource: this.wiring.timeSource,
            backlightActiveLow: this.wiring.backlightActiveLow,
            keep: this.wiring,
        });
        const changed = notes.length > 0 || wiringFile(wiring) !== wiringFile(this.wiring);
        this.wiring = wiring;
        this.wiringProblems = validateWiring(board, wiring);
        if (changed) {
            await writeProjectFile(this.folder, DESIGNER_HARDWARE_PATH, wiringFile(wiring));
            await this.syncPanelRs();
        }
        return notes;
    }

    private async refuseFeature(_name: 'sd', reason: string): Promise<void> {
        this.output.appendLine(`[designer] ${this.folder.fsPath}: ${reason}`);
        await this.panel.webview.postMessage({
            type: 'report',
            problems: [reason],
            sdEnabled: this.sdEnabled,
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

    /** What the Hardware panel draws, and what a report sends back after an edit. */
    private hardwareReport(): DesignerHardware | undefined {
        if (this.wiring === undefined) {
            return undefined;
        }
        return {
            wiring: this.wiring,
            problems: this.wiringProblems,
            board: this.board?.name ?? '',
            wireless: this.board?.kind === 'rp' && this.board.wireless === 'cyw43',
            reserved: this.board?.kind === 'rp' ? reservedPins(this.board) : [],
        };
    }

    /**
     * Applies the Hardware panel's wiring.
     *
     * The wiring is a *project* fact, not part of the design: it says what the panel is plugged into, and the
     * firmware compiles it. So this writes two files -- `designer/panel.hardware.json`, which the Designer
     * reads back, and `src/panel.rs`, which the build reads -- and refuses to write the second while the
     * first has an error. The rules in the validator are the same rules embassy-rp's typed pins enforce; a
     * file written past them would be a project that cannot compile for a reason nothing on screen explains.
     */
    private async setWiring(wiring: PanelWiring, planned?: string): Promise<void> {
        const board = this.board;
        if (wiring === undefined || board?.kind !== 'rp') {
            return;
        }
        const previousPanel = this.wiring?.panel;
        this.wiring = wiring;
        this.wiringProblems = validateWiring(board, wiring);
        await writeProjectFile(this.folder, DESIGNER_HARDWARE_PATH, wiringFile(wiring));
        await this.syncPanelRs();

        // Touch and the backlight are facts of the module, so they follow the wiring rather than the other way
        // round: a module with a controller is a touchscreen, and one that wires BL is dimmable.
        this.touchEnabled = this.touchController === undefined ? false : this.touchEnabled;
        this.backlightPwm = wiring.backlight !== null;

        // A different module is a different size, which is a canvas change. The document carries the size, so
        // it is written here and the panel is told: reopening the Designer re-lays the canvas against it.
        const module = panelModuleOrDefault(wiring.panel);
        if (previousPanel !== wiring.panel && (this.document.panelWidth !== module.width || this.document.panelHeight !== module.height)) {
            this.document = { ...this.document, panelWidth: module.width, panelHeight: module.height };
            await writeProjectFile(
                this.folder,
                DESIGNER_DOCUMENT_PATH,
                `${JSON.stringify(this.document, null, 2)}\n`,
            );
            this.output.appendLine(
                `[designer] the module is now ${module.label}: the canvas is ${module.width}x${module.height} ` +
                'when the Designer is reopened',
            );
        }

        const notes = this.wiringProblems.map((problem) => `${problem.severity}: ${problem.message}`);
        if (notes.length > 0) {
            this.output.appendLine(`[designer] wiring: ${notes.join('; ')}`);
        }
        await this.panel.webview.postMessage({
            type: 'report',
            problems: [],
            kdl: undefined,
            hardware: this.hardwareReport(),
            note:
                previousPanel !== wiring.panel
                    ? `Module changed to ${module.label}. Reopen the Designer to lay the canvas out for it.`
                    : planned,
        });
    }

    /**
     * Regenerates `src/panel.rs` from the wiring.
     *
     * The file is the Designer's, like `src/ui.rs`: the firmware's pins come from here and nowhere else. A
     * wiring with an error leaves the previous file in place, because the alternative is a project that stops
     * building while the user is half way through typing a GPIO number.
     */
    private async syncPanelRs(): Promise<void> {
        const board = this.board;
        if (this.wiring === undefined || board?.kind !== 'rp') {
            return;
        }
        if (wiringHasErrors(this.wiringProblems)) {
            this.output.appendLine('[designer] the wiring has errors, so the panel file was left as it was');
            return;
        }
        if (this.isCppProject()) {
            // A sketch's panel is C++: same wiring, same rule -- the Hardware panel is the one source of pins.
            const generated = emitArduinoPanel(this.wiring, this.document.rotation, 'rp');
            const sourceUri = vscode.Uri.joinPath(this.folder, 'src', 'panel.cpp');
            if ((await readText(sourceUri)) !== generated.source) {
                await writeProjectFile(this.folder, 'src/panel.cpp', generated.source);
                this.output.appendLine('[designer] src/panel.cpp rewritten from the wiring');
            }
            const headerUri = vscode.Uri.joinPath(this.folder, 'src', 'panel.h');
            if ((await readText(headerUri)) !== generated.header) {
                await writeProjectFile(this.folder, 'src/panel.h', generated.header);
            }
            return;
        }
        const module = panelModuleOrDefault(this.wiring.panel);
        const touch = module.touch && this.wiring.touchCs !== null && this.wiring.touchIrq !== null;
        // The card module only exists in a project generated with a socket: a wiring that adds one afterwards
        // would otherwise name `crate::sd` in a crate that has no such module.
        const cardModule = this.wiring.sdCs !== null && fs.existsSync(path.join(this.folder.fsPath, 'src', 'sd.rs'));
        if (this.wiring.sdCs !== null && !cardModule) {
            this.wiringProblems = [
                ...this.wiringProblems,
                {
                    field: 'sdCs',
                    severity: 'warning',
                    message:
                        'This project was generated without a card module (no src/sd.rs), so the socket pins ' +
                        'are recorded but nothing mounts the card. Recreate the project to get src/sd.rs.',
                },
            ];
        }
        const next = emitPanelRs({ board, wiring: this.wiring, touch, sd: cardModule });
        const uri = vscode.Uri.joinPath(this.folder, 'src', 'panel.rs');
        if ((await readText(uri)) !== next) {
            await writeProjectFile(this.folder, 'src/panel.rs', next);
            this.output.appendLine('[designer] src/panel.rs rewritten from the Hardware panel');
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
            touchBoard: this.touchController !== undefined,
            touchEnabled: this.touchEnabled,
            sdBoard: this.sdEnabled || this.hasCardSocket,
            sdEnabled: this.sdEnabled,
            backlight: this.wiring === undefined ? hasBacklight(this.display) : this.wiring.backlight !== null,
            backlightPwm: this.backlightPwm,
            brightness: this.brightness,
            hardware: this.wiring === undefined
                ? undefined
                : {
                    wiring: this.wiring,
                    problems: this.wiringProblems,
                    board: this.board?.name ?? '',
                    wireless: this.board?.kind === 'rp' && this.board.wireless === 'cyw43',
                    reserved: this.board?.kind === 'rp' ? reservedPins(this.board) : [],
                },
            loadError: this.loadError,
            loadNotes: this.loadNotes,
            loadProblems: this.loadProblems,
            fonts: declared.fonts,
            fontNotes: declared.fontNotes,
            images: await this.canvasImages(),
        });
    }

    /** What the canvas needs in order to draw the design's pictures, and the signature it was last sent under. */
    private imageSignature = '';

    /** Whether the board/module combination has a card socket at all -- the reason `sd` is offered. */
    private get hasCardSocket(): boolean {
        if (this.wiring !== undefined) {
            // The *socket*, not the pins: with the SD switch off the four pins are left free, and judging the
            // socket by them would make the switch impossible to turn back on.
            return panelModule(this.wiring.panel)?.sd === true;
        }
        return this.board?.kind === 'esp' && this.board.sd !== undefined;
    }

    /**
     * The design's image files, so the canvas can draw them instead of an empty box.
     *
     * Read here rather than in the panel because the panel is a webview with no access to the project; decoded
     * there rather than here because the browser already has every decoder that matters. Missing and oversized
     * files are simply not sent -- the panel reports a missing asset in its own words, and a file too big to
     * ship through a message is not a preview.
     */
    private async canvasImages(): Promise<DesignerImageAsset[]> {
        const read = (relative: string): Uint8Array | undefined => {
            try {
                return fs.readFileSync(vscode.Uri.joinPath(this.folder, relative).fsPath);
            } catch {
                return undefined;
            }
        };
        const assets = collectImageAssets(this.document, read);
        this.imageSignature = imageSourcesOf(this.document).join('\n');
        return assets;
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
        // is allowed to make -- a half-built design, or placeholder buttons -- but not a silent one. On a panel
        // with no controller at all there is nothing to switch on, so there is nothing to say either.
        const touch = this.touchController === undefined
            ? []
            : touchNeededBy(document.widgets, this.touchEnabled);
        // An image from the card has two requirements the design cannot state: the board must have a socket, and
        // the project must have the module that mounts it. Both are reported here because both fail at build
        // time otherwise -- `crate::sd::with_file` is named by the generated markup, so a project without it does
        // not compile, which is a much worse way to find out than a line in the panel.
        const sd = sdImagesNeedingCard(document.widgets).flatMap((id) => {
            if (!this.hasCardSocket) {
                return [
                    `"${id}": this image comes from the SD card, and ${this.board?.name ?? 'this board'
                    } has no card socket`,
                ];
            }
            if (!this.sdEnabled) {
                return [
                    `"${id}": this image comes from the SD card, but the \`sd\` cargo feature is switched off -- turn it on in the toolbar and rebuild.`,
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
        if (rendered.kdl !== undefined && !this.isCppProject()) {
            // A Rust design compiles through `ui.kdl`; a C++ one has no markup at all -- its object tree is
            // ui.cpp itself, written by `syncModule` below.
            await writeProjectFile(this.folder, DESIGNER_KDL_PATH, rendered.kdl);
        }
        await this.syncRotation(document.rotation);
        await this.syncHandlers(document);
        // The markup is what `include_gui!` compiles, and it is only written for a design that validates -- so
        // the Rust, which names the widgets that markup builds, may only be regenerated alongside it. Writing
        // it from a document whose markup was refused is how a project ends up with a `ui.rs` that mentions a
        // widget the compiled markup does not have: `E0609: no field image on type RustyPanelWidgets`, found on
        // a real project on 2026-10-24 (an image widget whose asset had not been chosen yet). The last good pair
        // stays, and the project keeps building while the design is finished.
        //
        // The test is "the document validated", not "markup came out": a C++ project has no markup at all --
        // its `src/ui.cpp` *is* the object tree -- so keying this on `rendered.kdl` meant `syncModule` never ran
        // for a sketch. The handlers were rewritten on every save (that call is unconditional) and the screen
        // never was, which left a project whose `src/ui.cpp` called a handler its freshly written
        // `src/ui_handlers.h` did not declare: `'on_screen_tapped' was not declared in this scope`, the first
        // build of a real C++ project (bench, 2026-10-31). `rendered.problems.length === 0` is the same question
        // for both languages.
        if (rendered.problems.length === 0) {
            await this.syncModule(document);
        }
        // A clock dropped into a design that is already open is the other moment the automatic
        // hand-over becomes relevant; the flag makes this a no-op after the first attempt.
        this.autoServeClock();

        // A declared font's pixels are only resent when the declarations changed: a report follows every
        // edit, and shipping a hundred glyph bitmaps per keystroke would be work done for nothing.
        const declared = this.declaredFonts();
        const fontsChanged = declared.signature !== this.fontSignature;
        this.fontSignature = declared.signature;
        // The same for pictures: a widget added, removed or re-pointed at another file changes the set.
        const imagesChanged = imageSourcesOf(this.document).join('\n') !== this.imageSignature;
        const report: DesignerReport = {
            type: 'report',
            problems,
            kdl: rendered.kdl,
            wroteDocument: true,
            ...(fontsChanged ? { fonts: declared.fonts, fontNotes: declared.fontNotes } : {}),
            ...(imagesChanged ? { images: await this.canvasImages() } : {}),
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
        if (this.isCppProject()) {
            await this.syncCppHandlers(document);
            return;
        }
        const uri = vscode.Uri.joinPath(this.folder, DESIGNER_HANDLERS_PATH);
        const existing = await readText(uri);
        if (existing === undefined) {
            return;
        }
        // The macro is what tells a stub from the user's own code: the pruner only removes a body that is
        // still exactly the line this extension wrote. A Pico project's stubs say `defmt::info!`, so judging
        // them by the ESP spelling kept every stub of every event the design had ever asked for -- found on
        // a real project (2026-10-27) as "function on_go_clicked is never used", after the button's event
        // had been unticked and the call had left src/ui.rs.
        const log = this.wiring === undefined ? ESP_LOG_MACRO : RP_LOG_MACRO;
        const next = syncHandlerStubs(existing, document, this.touchEnabled, log);
        if (next !== existing) {
            await writeProjectFile(this.folder, DESIGNER_HANDLERS_PATH, next);
            this.output.appendLine('[designer] src/ui_handlers.rs tidied: a stub the design no longer asks for');
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
        if (this.isCppProject()) {
            await this.syncCppModule(document);
            return;
        }
        const uri = vscode.Uri.joinPath(this.folder, DESIGNER_MODULE_PATH);
        const next = emitUiRs(document, this.touchEnabled);
        if ((await readText(uri)) !== next) {
            await writeProjectFile(this.folder, DESIGNER_MODULE_PATH, next);
        }
    }

    /** Whether this is an Arduino (C++) project: a sketch, not a crate. */
    private isCppProject(): boolean {
        return fs.existsSync(path.join(this.folder.fsPath, 'sketch.yaml'));
    }

    /**
     * Rewrites a C++ project's screen from the design.
     *
     * `src/ui.cpp` is the object tree and `src/ui.h` its contract, exactly as `src/ui.rs` is on the Rust side:
     * generated, rewritten on every save, and never the place for a person's code.
     */
    private async syncCppModule(document: DesignerDocument): Promise<void> {
        const source = emitUiCpp(document);
        const sourceUri = vscode.Uri.joinPath(this.folder, 'src', 'ui.cpp');
        if ((await readText(sourceUri)) !== source) {
            await writeProjectFile(this.folder, 'src/ui.cpp', source);
        }
        const header = emitUiCppHeader();
        const headerUri = vscode.Uri.joinPath(this.folder, 'src', 'ui.h');
        if ((await readText(headerUri)) !== header) {
            await writeProjectFile(this.folder, 'src/ui.h', header);
        }
    }

    /**
     * Keeps a C++ project's handler file and its prototypes in step with the design.
     *
     * Same rules as the Rust side: a stub is appended once and never rewritten, and one the design no longer
     * asks for is removed only while it is still exactly the stub this wrote.
     */
    private async syncCppHandlers(document: DesignerDocument): Promise<void> {
        const handlersUri = vscode.Uri.joinPath(this.folder, 'src', 'ui_handlers.cpp');
        const existing = await readText(handlersUri);
        if (existing !== undefined) {
            const next = syncHandlerStubsCpp(existing, document);
            if (next !== existing) {
                await writeProjectFile(this.folder, 'src/ui_handlers.cpp', next);
                this.output.appendLine('[designer] src/ui_handlers.cpp tidied: stubs the design no longer asks for');
            }
        }
        const headerUri = vscode.Uri.joinPath(this.folder, 'src', 'ui_handlers.h');
        const header = emitHandlersCppHeader(document);
        if ((await readText(headerUri)) !== header) {
            await writeProjectFile(this.folder, 'src/ui_handlers.h', header);
        }
    }

    /** Keeps the project's own rotation setting in step with the design it was drawn for. */
    private async syncRotation(rotation: LcdRotation): Promise<void> {
        if (this.isCppProject()) {
            // A C++ project's rotation lives in src/panel.cpp (the MADCTL bits), which the project generator
            // writes; rewriting it from a design save is the panel-rewrite step that is not in yet.
            return;
        }
        const configUri = vscode.Uri.joinPath(this.folder, ...this.configRelative.split('/'));
        const existing = (await readText(configUri)) ?? '';
        const updated = setLcdRotationInConfig(existing, rotation);
        if (updated !== existing) {
            await writeProjectFile(this.folder, this.configRelative, updated);
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
        } else if (action === 'serveClockTime') {
            await this.serveClockTime();
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
        const hasClock = designHasClock(this.document);
        const port = hasClock ? this.clockPort() : undefined;
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

    /**
     * Keeps the port open and answers the board when its firmware asks for the time.
     *
     * The firmware asks once a second while its RTC has never been set (`TIME?`), because a board
     * cannot know what a PC's clock says. The rules live in `../flash/clockHost`; this opens the
     * terminal the loop runs in, the same way Monitor owns its port. The terminal is deliberate: the
     * developer can watch the answers and close it to stop.
     */
    private async serveClockTime(): Promise<void> {
        const hasClock = designHasClock(this.document);
        const port = hasClock ? this.clockPort() : undefined;
        const plan = clockHostPlan({ hasClock, port });
        if (plan.kind === 'refuse') {
            this.output.appendLine(`[designer] answer time requests: ${plan.message}`);
            void vscode.window.showWarningMessage(plan.message);
            await this.panel.webview.postMessage({ type: 'report', problems: [], note: plan.message });
            return;
        }
        this.output.appendLine(`[designer] answering time requests on ${plan.port}`);
        runInTerminal('Rusty: clock', plan.command, this.folder);
        const note =
            `Answering time requests on ${plan.port}. The listener stays open while this design is, so a ` +
            'cold-booted board gets its time back too; closing the designer, a flash or Monitor takes the port.';
        void vscode.window.showInformationMessage(note);
        await this.panel.webview.postMessage({ type: 'report', problems: [], note });
    }

    /** The port a clock hand-over would use: the setting first, otherwise the only serial port there is. */
    private clockPort(): string | undefined {
        const configured = vscode.workspace.getConfiguration('rustyPlatform').get<string>('serialPort');
        return pickSerialPort(serialPortCandidates(serialPortEntriesForPlatform()), configured);
    }

    /**
     * Starts the clock listener as soon as a design with a clock is opened.
     *
     * The board cannot learn the time on its own, so "automatic" means something on this PC has to be
     * listening when it asks -- and it asks again after every cold boot, because the RTC loses the
     * time with the power. The listener therefore stays open for the life of the panel; the panel's
     * dispose, a flash and Monitor each close it to take the port. One attempt per open, and the
     * pane's button is the way to try again.
     */
    private autoServeClock(): void {
        if (this.clockServed || !designHasClock(this.document)) {
            return;
        }
        // A Pico has no serial hand-over: its clock starts from the build's own time and is corrected over
        // Wi-Fi (the `time-wifi` feature), so there is no port to listen on and nothing to start.
        if (this.wiring !== undefined) {
            this.clockServed = true;
            return;
        }
        this.clockServed = true;
        const port = this.clockPort();
        if (port === undefined) {
            this.output.appendLine(
                '[designer] the design has a clock, but no board is on a serial port: the time cannot be handed over yet',
            );
            return;
        }
        const plan = clockHostPlan({ hasClock: true, port });
        if (plan.kind !== 'serve') {
            this.output.appendLine(`[designer] clock listener: ${plan.message}`);
            return;
        }
        this.output.appendLine(`[designer] listening for the board's time request on ${plan.port}`);
        runInTerminal('Rusty: clock', plan.command, this.folder);
    }

    /**
     * Starts the listener again after something took the port for a while -- a flash closes it, and
     * the board's next cold boot needs it back. Called from `rearmClockListener` when the flash
     * command in its terminal ends.
     */
    restartClockListener(): void {
        // A listener that is already open is the one we want: two would fight for the port.
        if (openTerminalNames().includes('Rusty: clock')) {
            return;
        }
        this.clockServed = false;
        this.autoServeClock();
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
        // The clock listener owns the serial port while the design is open (it is how a cold-booted
        // board gets its time back), so closing the panel is what hands the port over.
        closeTerminal('Rusty: clock');
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
    }
}

/** Opens (or reveals) the designer, for the active project or for a named folder. */
/**
 * Puts the clock listener back after something else had to borrow the serial port.
 *
 * A flash closes the listener so `espflash` can own the port; the board's later cold boot needs a
 * listener again, and the flash command's end is the moment the port is free. A no-op when no
 * designer with a clock is open.
 */
export function rearmClockListener(): void {
    current?.restartClockListener();
}
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

/**
 * Reads a JSON file the Designer owns, or nothing when a hand edit broke it.
 *
 * A hardware file that cannot be parsed must not take the Designer down: it is read as "no wiring yet" and
 * the defaults take over, which the panel then shows as the starting point. The alternative -- an exception
 * out of `show()` -- leaves the user with a command that does nothing and no reason written anywhere.
 */
function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}
