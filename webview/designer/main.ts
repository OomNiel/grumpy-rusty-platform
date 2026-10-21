/**
 * The designer's frontend: the shell, the message channel, and the wiring.
 *
 * The panel owns the editing state. The extension owns the disk. This file is where the two meet, and it is
 * deliberately thin: every rule about what an edit *means* lives in `src/designer/` beside the tests, and this
 * only decides what to redraw and what to post.
 *
 * Two habits are worth naming. The document is posted to the extension on a short timer rather than on every
 * pointer move, because a drag produces an edit per frame and the extension validates and writes files --
 * so a lag of a tenth of a second keeps dragging smooth while still saving continuously. And the property
 * panel is *not* rebuilt during a drag, because rebuilding it under the pointer would take focus away from
 * whatever the user is typing in.
 */

import { widgetSpec } from '../../src/designer/catalog';
import { registerDesignFont } from './glyphs';
import { rasteriseFont } from './rasterise';
import { CanvasView } from './canvas';
import {
    fontMenu,
    hideContextMenu,
    renderProperties,
    renderToolbox,
    showContextMenu,
    widgetMenu,
} from './panels';
import {
    type DesignerState,
    addFontDeclaration,
    addWidget,
    declareFontFromPath,
    canRedo,
    canUndo,
    canvasOf,
    initialState,
    moveWidget,
    redo,
    removeWidget,
    setRotation,
    undo,
    widgetById,
} from '../../src/designer/state';
import type {
    DesignerActionId,
    DesignerAssetKind,
    DesignerAssetPicked,
    DesignerDeclareFont,
    DesignerInbound,
    DesignerInit,
    DesignerRasteriseFont,
    DesignerReport,
} from '../../src/designer/protocol';
import type { LcdRotation } from '../../src/display/rotation';

interface VsCodeApi {
    postMessage(message: DesignerInbound): void;
    getState(): unknown;
    setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const host = acquireVsCodeApi();

/**
 * The asset requests waiting for an answer, keyed by the id that came with the request.
 *
 * A file dialog is modal and can take as long as the user takes, so the answer carries the id back rather than
 * relying on there being only one request in flight. Each entry is the *edit* to make, which is what keeps the
 * document and its undo history in this pane.
 */
const pendingAssets = new Map<
    string,
    (path: string, font?: { source: string; size: number }) => void
>();
let assetRequest = 0;

/** How long edits are batched before being sent, in milliseconds. */
const POST_DELAY_MS = 120;

let state: DesignerState;
let selectedId: string | undefined;
let canvasWidth = 0;
let canvasHeight = 0;
/** Whether the board has a touch controller at all: without one, the setting is not a choice. */
let touchBoard = false;
/** Whether this project is built with touch, which the toolbar shows and writes. */
let touchEnabled = true;
let postTimer: number | undefined;

const root = document.getElementById('designer');
if (root === null) {
    throw new Error('the designer shell is missing its root element');
}

// ---------------------------------------------------------------- the shell

const toolbar = document.createElement('header');
toolbar.className = 'toolbar';

const body = document.createElement('div');
body.className = 'body';

const toolbox = document.createElement('aside');
toolbox.className = 'pane toolbox';

const stage = document.createElement('section');
stage.className = 'pane stage';
const canvasElement = document.createElement('canvas');
canvasElement.className = 'canvas';
canvasElement.id = 'canvas';
stage.append(canvasElement);

const properties = document.createElement('aside');
properties.className = 'pane properties';

const footer = document.createElement('footer');
footer.className = 'footer';

body.append(toolbox, stage, properties);
root.append(toolbar, body, footer);

// ---------------------------------------------------------------- messages

const view = new CanvasView(canvasElement, {
    onEdit(next) {
        state = next;
        view.setState(next);
        schedulePost();
    },
    onSelect(id) {
        selectedId = id;
        refreshProperties();
    },
    onCommit() {
        refreshProperties();
        flushPost();
    },
    onContextMenu(id, x, y) {
        // The menu is offered for the widget under the pointer, which onContextMenu has already selected.
        root.addEventListener('click', () => hideContextMenu(root), { once: true });
        showContextMenu(root, x, y, widgetMenu(state, id, panels));
    },
    onRevealHandler(id) {
        // A middle-click asks for the widget's own code. Opening the file is the extension's to do -- the panel
        // has no filesystem -- so it travels as a message like every other action.
        host.postMessage({ type: 'action', action: 'revealHandler', widgetId: id });
    },
});

const panels = {
    onEdit(next: DesignerState) {
        state = next;
        view.setState(next);
        refreshProperties();
        // Sent at once rather than on the timer a drag uses: a property edit is discrete -- a field's change
        // event, a click on the Toolbox, a layer button -- and a user who edits and immediately closes the
        // panel must not lose it to a debounce. Found by the panel test, which asserted the post and got
        // nothing because it was still waiting out the timer.
        flushPost();
    },
    onSelect(id: string | undefined) {
        selectedId = id;
        view.select(id);
        refreshProperties();
    },
    onBrowseAsset(
        kind: DesignerAssetKind,
        apply: (path: string, font?: { source: string; size: number }) => void,
    ) {
        assetRequest += 1;
        const requestId = `asset-${assetRequest}`;
        pendingAssets.set(requestId, apply);
        host.postMessage({ type: 'pickAsset', requestId, kind });
    },
    onAction(action: DesignerActionId) {
        // The extension owns the serial port and the terminal, so the panel only asks.
        host.postMessage({ type: 'action', action });
    },
    onFontMenu(fontId: string, x: number, y: number) {
        // Positioned against the page, because the menu is an overlay and not part of the field's flow.
        root.addEventListener('click', () => hideContextMenu(root), { once: true });
        showContextMenu(root, x, y, fontMenu(state, fontId, panels));
    },
};

window.addEventListener('message', (event: MessageEvent<
    | DesignerInit
    | DesignerReport
    | DesignerAssetPicked
    | DesignerRasteriseFont
    | DesignerDeclareFont
>) => {
    const message = event.data;
    if (message.type === 'init') {
        canvasWidth = message.canvas.width;
        canvasHeight = message.canvas.height;
        touchBoard = message.touchBoard;
        touchEnabled = message.touchEnabled;
        // Before the first paint: a declared font's glyphs are not in the design, so they arrive with the
        // document and the canvas has to know them before it draws a widget that uses one.
        for (const [name, pixels] of Object.entries(message.fonts ?? {})) {
            registerDesignFont(name, {
                advance: pixels.advance,
                lineHeight: pixels.lineHeight,
                width: pixels.width,
                height: pixels.height,
                table: -1,
                firstChar: pixels.firstChar,
                lastChar: pixels.lastChar,
                rows: pixels.rows,
            });
        }
        selectedId = undefined;
        state = initialState(message.document);
        view.select(undefined);
        view.setState(state);
        document.title = `${message.document.screenId} - ${canvasWidth}x${canvasHeight}`;
        renderToolbox(toolbox, (tag) => drop(tag));
        refreshProperties();
        refreshToolbar();
        const problems = message.loadProblems ?? [];
        if (message.loadError === undefined) {
            // What the load tidied up, then the verdict. The notes are drawn once, here: a later save must not
            // clear them, because "this file was cleaned up when you opened it" is not news a save can replace.
            setList('load-notes', message.loadNotes ?? []);
            showVerdict(problems, `${message.paths.document} -> ${message.paths.kdl}`);
        } else {
            // The file could not be read at all, so there is no design to have a verdict on: the error is the
            // whole story and the paths would be beside the point.
            status(message.loadError, true);
        }
        return;
    }
    if (message.type === 'report') {
        // The declarations changed, so the pixels did: a font that was just named becomes drawable, and one
        // that was renamed keeps its old entry only until the next paint.
        if (message.fonts !== undefined) {
            for (const [name, pixels] of Object.entries(message.fonts)) {
                registerDesignFont(name, {
                    advance: pixels.advance,
                    lineHeight: pixels.lineHeight,
                    width: pixels.width,
                    height: pixels.height,
                    table: -1,
                    firstChar: pixels.firstChar,
                    lastChar: pixels.lastChar,
                    rows: pixels.rows,
                });
            }
            view.setState(state);
            refreshProperties();
        }
        report(message);
    }
    if (message.type === 'assetPicked') {
        applyPickedAsset(message);
    }
    if (message.type === 'rasteriseFont') {
        void rasteriseAndAnswer(message);
    }
    if (message.type === 'declareFont') {
        declareImportedFont(message);
    }
});

/**
 * Draws a face the extension handed over and answers with its pixels.
 *
 * This is the half of "adapt a system font" that needs a renderer, and the renderer is here -- so the drawing
 * happens in the panel and the *file* is written by the extension, which is the side that knows where the
 * project is. An answer, not an edit: nothing about the document changes until the file exists and comes back
 * as a declaration.
 */
async function rasteriseAndAnswer(message: DesignerRasteriseFont): Promise<void> {
    const binary = atob(message.bytes);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    const result = await rasteriseFont(bytes, message.name, message.pixelSize);
    if ('error' in result) {
        host.postMessage({ type: 'fontRasterised', requestId: message.requestId, error: result.error });
        return;
    }
    host.postMessage({ type: 'fontRasterised', requestId: message.requestId, font: result.font });
}

/**
 * Declares a font file that is now part of the project.
 *
 * A declaration is a document edit, so it goes through the same path every other edit does -- undo covers it,
 * the file is rewritten, and the pixels are measured and sent back to the canvas from the extension.
 */
function declareImportedFont(message: DesignerDeclareFont): void {
    // Importing a file the design already names would list one face twice under two names; picking the same
    // file from a widget's Font list is a different thing, and that is allowed to make a second declaration.
    if ((state.document.fonts ?? []).some((font) => font.src === message.path)) {
        status(`${message.path} is already declared.`, false);
        return;
    }
    const extras = { source: message.source, size: message.size };
    // The command runs from the palette, where a widget is very often selected and the font was picked *for*
    // it: point that widget at the new font, exactly as the Font field's `...` does. With nothing selected --
    // or something that draws no text -- the font is declared alone and appears in every Font list.
    const target = selectedId === undefined ? undefined : widgetById(state.document, selectedId);
    const takesFont =
        target !== undefined
        && (widgetSpec(target.tag)?.props ?? []).some((property) => property.kind === 'font');
    panels.onEdit(
        takesFont && target !== undefined
            ? declareFontFromPath(state, target.id, message.path, extras)
            : addFontDeclaration(state, message.path, extras),
    );
    if (message.note !== undefined) {
        status(message.note, false);
    }
}

/** Tells the extension the panel is ready for its document. */
host.postMessage({ type: 'ready' });

// ---------------------------------------------------------------- posting

function schedulePost(): void {
    if (postTimer !== undefined) {
        window.clearTimeout(postTimer);
    }
    postTimer = window.setTimeout(flushPost, POST_DELAY_MS);
}

function flushPost(): void {
    if (postTimer !== undefined) {
        window.clearTimeout(postTimer);
        postTimer = undefined;
    }
    host.postMessage({ type: 'changed', document: state.document });
}

// ---------------------------------------------------------------- actions

/**
 * Switches touch on or off for the project.
 *
 * The firmware reads it at compile time, so this writes the setting and says as much: the board keeps doing
 * whatever it was built with until it is built again.
 */
function setTouch(enabled: boolean, why?: string): void {
    if (enabled === touchEnabled) {
        return;
    }
    touchEnabled = enabled;
    host.postMessage({ type: 'setTouch', enabled });
    refreshToolbar();
    status(why ?? (enabled ? 'Touch enabled. Rebuild for it to take effect.' : 'Touch disabled. Rebuild for it to take effect.'), false);
}

/** A tag dropped or clicked in the Toolbox: put it in the middle of the canvas. */
function drop(tag: string): void {
    // A control that raises events is a control that needs touch, so dropping one turns it on rather than
    // leaving a button that can never be pressed. The catalogue decides which those are: a widget is
    // interactive exactly when it declares an event.
    const dropped = widgetSpec(tag);
    if (touchBoard && !touchEnabled && dropped !== undefined && dropped.events.length > 0) {
        setTouch(true, `${dropped.label} needs touch, so it is now on. Rebuild to use it.`);
    }
    const next = addWidget(state, tag, Math.round(canvasWidth / 2 - 24), Math.round(canvasHeight / 2 - 12));
    state = next;
    const added = next.document.widgets[next.document.widgets.length - 1];
    if (added !== undefined) {
        selectedId = added.id;
        view.select(added.id);
    }
    view.setState(next);
    refreshProperties();
    refreshToolbar();
    flushPost();
}

function refreshProperties(): void {
    renderProperties(properties, state, selectedId, panels);
}

/** The toolbar's buttons and selects, rebuilt whenever something they show may have changed. */
function refreshToolbar(): void {
    toolbar.replaceChildren();

    const undoButton = toolButton('Undo', () => {
        state = undo(state);
        view.setState(state);
        refreshProperties();
        refreshToolbar();
        flushPost();
    });
    undoButton.disabled = !canUndo(state);

    const redoButton = toolButton('Redo', () => {
        state = redo(state);
        view.setState(state);
        refreshProperties();
        refreshToolbar();
        flushPost();
    });
    redoButton.disabled = !canRedo(state);

    const remove = toolButton('Delete', () => {
        if (selectedId !== undefined) {
            state = removeWidget(state, selectedId);
            selectedId = undefined;
            view.select(undefined);
            view.setState(state);
            refreshProperties();
            refreshToolbar();
            flushPost();
        }
    });
    remove.disabled = selectedId === undefined;

    const zoom = document.createElement('select');
    zoom.className = 'tool-select';
    for (const factor of [0.5, 1, 1.5, 2]) {
        const option = document.createElement('option');
        option.value = String(factor);
        option.textContent = `${factor * 100}%`;
        zoom.append(option);
    }
    zoom.value = String(view.getZoom());
    zoom.addEventListener('change', () => {
        view.setZoom(Number(zoom.value));
    });

    const rotation = document.createElement('select');
    rotation.className = 'tool-select';
    for (const value of [0, 1, 2, 3]) {
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = `Rotation ${value}`;
        rotation.append(option);
    }
    rotation.value = String(state.document.rotation);
    rotation.title = 'The designed area turns with the panel; the project setting is updated to match.';
    rotation.addEventListener('change', () => {
        state = setRotation(state, Number(rotation.value) as LcdRotation);
        view.setState(state);
        refreshProperties();
        flushPost();
    });

    // Touch, beside the rotation: both are project settings the firmware reads at compile time, and both are
    // asked about in the wizard -- so this is where a later change of mind goes.
    const touch = document.createElement('select');
    touch.className = 'tool-select';
    for (const [label, value] of [
        ['Touch: on', 'true'],
        ['Touch: off', 'false'],
    ] as const) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        touch.append(option);
    }
    touch.value = String(touchEnabled);
    touch.disabled = !touchBoard;
    touch.title = touchBoard
        ? 'Whether the firmware drives the touch controller. Changing it needs a rebuild.'
        : 'This board has no touch controller, so there is nothing to drive.';
    touch.addEventListener('change', () => setTouch(touch.value === 'true'));

    const revealKdl = toolButton('Markup', () => host.postMessage({ type: 'action', action: 'revealKdl' }));
    const revealDocument = toolButton('Design file', () => host.postMessage({ type: 'action', action: 'revealDocument' }));
    const build = toolButton('Build', () => host.postMessage({ type: 'action', action: 'build' }));
    const smtp = toolButton('SMTP…', () => host.postMessage({ type: 'action', action: 'setupSmtp' }));
    smtp.title = 'Set up an SMTP client over Wi-Fi (keep-alive posts)';

    const spacer = document.createElement('span');
    spacer.className = 'toolbar-spacer';

    const size = document.createElement('span');
    size.className = 'toolbar-note';
    const canvas = canvasOf(state.document);
    size.textContent = `${canvas.width}x${canvas.height}${touchBoard ? '' : ' (no touch)'}`;

    toolbar.append(
        undoButton,
        redoButton,
        remove,
        separator(),
        zoom,
        rotation,
        touch,
        separator(),
        revealDocument,
        revealKdl,
        build,
        smtp,
        spacer,
        size,
    );
}

function toolButton(label: string, onClick: () => void): HTMLButtonElement {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'tool-button';
    node.textContent = label;
    node.addEventListener('click', onClick);
    return node;
}

function separator(): HTMLElement {
    const node = document.createElement('span');
    node.className = 'toolbar-separator';
    return node;
}

/**
 * Applies a chosen file, or says why it could not be used.
 *
 * A cancellation arrives with no path and no error, and is simply forgotten -- the field keeps whatever it had.
 */
function applyPickedAsset(message: DesignerAssetPicked): void {
    const apply = pendingAssets.get(message.requestId);
    pendingAssets.delete(message.requestId);
    if (message.error !== undefined) {
        status(`That file could not be used: ${message.error}`, true);
        return;
    }
    if (apply === undefined || message.path === undefined) {
        return;
    }
    // A system font answers with the face it was drawn from as well, so the declaration can be redrawn later.
    apply(message.path, message.font);
}

/**
 * Rebuilds one of the lists under the properties, removing it when there is nothing to hold.
 */
function setList(className: string, items: string[]): void {
    const existing = properties.querySelector(`.${className}`);
    if (existing !== null) {
        properties.removeChild(existing);
    }
    if (items.length === 0) {
        return;
    }
    const list = document.createElement('ul');
    list.className = className;
    for (const item of items) {
        const entry = document.createElement('li');
        entry.textContent = item;
        list.append(entry);
    }
    properties.append(list);
}

/**
 * Shows a verdict: the problems in the footer and the whole list of them under the properties.
 *
 * The list is rebuilt rather than appended to, because a verdict is shown on every save as well as on the
 * load: a list that only ever grew would leave a problem on screen that the design no longer has.
 *
 * What a load had to tidy up is a separate list, drawn by `setList('load-notes', ...)` when the panel opens,
 * and deliberately not a note appended to the footer: that is one clipped line (`overflow: hidden`, an
 * ellipsis), so anything appended to it can vanish -- and the load that dropped a property is exactly the one
 * whose board was out of step.
 */
function showVerdict(problems: string[], clean: string): void {
    setList('problem-list', problems);
    if (problems.length === 0) {
        status(clean, false);
        return;
    }
    status(`${problems.length} problem${problems.length === 1 ? '' : 's'}: ${problems[0]}`, true);
}

/** Shows the extension's verdict on an edit: the problems, or a note that the markup was written. */
function report(message: DesignerReport): void {
    showVerdict(
        message.problems,
        message.note ??
        (message.kdl === undefined ? 'Saved.' : `Saved. Markup is ${message.kdl.split('\n').length} lines.`),
    );
}

function status(text: string, isProblem: boolean): void {
    footer.textContent = text;
    footer.classList.toggle('is-problem', isProblem);
}

// ---------------------------------------------------------------- keyboard

window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        hideContextMenu(root);
        return;
    }
    const target = event.target as HTMLElement | null;
    // Never steal a key from a field the user is typing in.
    if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
        return;
    }
    const meta = event.ctrlKey || event.metaKey;

    if (meta && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault();
        state = undo(state);
    } else if ((meta && event.key.toLowerCase() === 'z' && event.shiftKey) || (meta && event.key.toLowerCase() === 'y')) {
        event.preventDefault();
        state = redo(state);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedId === undefined) {
            return;
        }
        event.preventDefault();
        state = removeWidget(state, selectedId);
        selectedId = undefined;
        view.select(undefined);
    } else if (selectedId !== undefined && event.key.startsWith('Arrow')) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const widget = widgetById(state.document, selectedId);
        if (widget === undefined) {
            return;
        }
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        state = moveWidget(state, selectedId, widget.x + dx, widget.y + dy);
    } else {
        return;
    }

    view.setState(state);
    refreshProperties();
    refreshToolbar();
    flushPost();
});
