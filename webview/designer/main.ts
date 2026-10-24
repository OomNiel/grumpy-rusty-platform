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
import { startViewId } from '../../src/designer/model';
import { registerDesignFont } from './glyphs';
import { rasteriseFont } from './rasterise';
import { CanvasView } from './canvas';
import { clearBitmaps, setBitmap } from './bitmaps';
import type { DesignerImageAsset } from '../../src/designer/imageAssets';
import {
    type ContextMenuItem,
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
    addView,
    addWidget,
    assignView,
    declareFontFromPath,
    canRedo,
    canUndo,
    canvasOf,
    duplicateView,
    freeViewId,
    initialState,
    moveWidget,
    redo,
    removeView,
    removeWidget,
    renameView,
    setRotation,
    setStartView,
    setViewLabel,
    undo,
    viewsOf,
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
/** Whether the board has an SD-card socket, which is what makes an SD switch a choice. */
let sdBoard = false;
/** Whether the project is built with the `sd` cargo feature, which the toolbar shows and writes. */
let sdEnabled = true;
/** Whether the SMTP wizard has written `src/smtp.rs` -- without it the SMTP switch has nothing to compile. */
let smtpAvailable = false;
/** Whether the project is built with the `smtp` cargo feature (the keep-alive client). */
let smtpEnabled = false;
/** Whether the chosen panel has a backlight pin wired, which is what makes a Brightness setting possible. */
let backlightBoard = false;
/** Whether the project's `src/main.rs` already dims the backlight by PWM, i.e. whether a change can reach it. */
let backlightPwm = false;
/** The brightness the project asks for, 0-100. */
let brightness = 100;
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
// The view tabs sit above the canvas, in the pane that holds it: they say which screenful of the design is
// being edited, which is the same thing the canvas is showing.
const viewTabs = document.createElement('div');
viewTabs.className = 'view-tabs';
const canvasElement = document.createElement('canvas');
canvasElement.className = 'canvas';
canvasElement.id = 'canvas';
stage.append(viewTabs, canvasElement);

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
        sdBoard = message.sdBoard;
        sdEnabled = message.sdEnabled;
        smtpAvailable = message.smtpAvailable;
        smtpEnabled = message.smtpEnabled;
        // Optional on purpose: the panel tests build init messages by hand, and a missing flag has to read as
        // "no backlight" rather than leave a control that writes a setting the panel cannot honour.
        backlightBoard = message.backlight === true;
        backlightPwm = message.backlightPwm === true;
        brightness = message.brightness ?? 100;
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
        // Pictures before the first paint when they are already here; the redraw each one triggers is cheap and
        // happens once, so the canvas is never left showing an asset placeholder over a file it did receive.
        clearBitmaps();
        loadBitmaps(message.images);
        // The design opens on the view the board starts on, which is what the glass shows when it powers up.
        // Set before the first state, so the first paint is already the right view and the design is drawn once.
        activeViewTab = startViewId(state.document);
        view.setActiveView(currentView());
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
        // A picture the design has just started to use arrives with the report that mentions it.
        loadBitmaps(message.images);
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
        if (
            (message.sdEnabled !== undefined && message.sdEnabled !== sdEnabled)
            || (message.smtpEnabled !== undefined && message.smtpEnabled !== smtpEnabled)
            || (message.smtpAvailable !== undefined && message.smtpAvailable !== smtpAvailable)
            || (message.brightness !== undefined && message.brightness !== brightness)
        ) {
            // The switches are reported as the manifest actually is, not as the click assumed: a project
            // whose Cargo.toml cannot carry the feature refuses it, and the toolbar goes back to the truth.
            sdEnabled = message.sdEnabled ?? sdEnabled;
            smtpEnabled = message.smtpEnabled ?? smtpEnabled;
            smtpAvailable = message.smtpAvailable ?? smtpAvailable;
            brightness = message.brightness ?? brightness;
            refreshToolbar();
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

/**
 * Switches the SD card on or off for the project.
 *
 * The firmware reads the setting at compile time, so this writes the `sd` cargo feature in `Cargo.toml` and
 * says as much: the board keeps doing whatever it was built with until it is built again. It is the cargo-toggle
 * sibling of `setTouch` -- which writes an `.cargo/esp-config.toml` key -- because enabling the card is what
 * adds the FAT filesystem (embedded-sdmmc), and only a feature can add or drop a dependency.
 */
function setSd(enabled: boolean, why?: string): void {
    if (enabled === sdEnabled) {
        return;
    }
    sdEnabled = enabled;
    host.postMessage({ type: 'setSd', enabled });
    refreshToolbar();
    status(why ?? (enabled ? 'SD enabled. Rebuild for it to take effect.' : 'SD disabled. Rebuild for it to take effect.'), false);
}

/**
 * Switches the SMTP keep-alive client on or off for the project.
 *
 * It is the `smtp` cargo feature: switching it off takes `src/smtp.rs` and its radio work out of the build
 * without deleting the file, and switching it back on returns them. Like touch and SD, the firmware reads it
 * at compile time, so a rebuild is what makes it real.
 */
function setSmtp(enabled: boolean, why?: string): void {
    if (enabled === smtpEnabled) {
        return;
    }
    smtpEnabled = enabled;
    host.postMessage({ type: 'setSmtp', enabled });
    refreshToolbar();
    status(why ?? (enabled ? 'SMTP enabled. Rebuild for it to take effect.' : 'SMTP disabled. Rebuild for it to take effect.'), false);
}

/**
 * Asks for a new backlight brightness.
 *
 * Posted on `change` (the thumb released), not on `input`: a drag would otherwise write the project's config
 * file on every pixel the pointer moves. The label under the pointer follows on `input`, so the control still
 * feels live while nothing is written.
 */
function setBrightness(percent: number): void {
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    if (value === brightness) {
        return;
    }
    brightness = value;
    host.postMessage({ type: 'setBrightness', percent: value });
    refreshToolbar();
    status(`Brightness ${value}%. Rebuild for it to take effect.`, false);
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
        // A widget dropped while a view is being edited belongs to that view: `addWidget` puts it on the first.
        state = assignView(state, added.id, currentView());
        selectedId = added.id;
        view.select(added.id);
    }
    view.setState(state);
    refreshProperties();
    refreshToolbar();
    flushPost();
}

// ---------------------------------------------------------------- views

/** The view being edited. UI state, not document state: which tab you have open is not saved. */
let activeViewTab: string | undefined;

/**
 * Whether the other views are drawn as outlines.
 *
 * Also UI state, and off to begin with: the point of a view is that what is on the glass is what is on the
 * canvas, so the ghosts are something to ask for rather than something to explain away.
 */
let showOtherViews = false;

/** The view being edited, defaulting to the one the board starts on. */
function currentView(): string {
    const views = viewsOf(state.document);
    if (activeViewTab !== undefined && views.some((entry) => entry.id === activeViewTab)) {
        return activeViewTab;
    }
    return startViewId(state.document);
}

/** Switches the canvas to a view. */
function switchView(viewId: string): void {
    activeViewTab = viewId;
    view.setActiveView(viewId);
    refreshProperties();
}

/** Rebuilds the tab strip: one tab per view, the one that adds another, and the all-views overlay toggle. */
function refreshViewTabs(): void {
    const views = viewsOf(state.document);
    const current = currentView();
    const start = startViewId(state.document);
    viewTabs.replaceChildren();
    for (const entry of views) {
        const tab = document.createElement('button');
        tab.type = 'button';
        const classes = ['view-tab'];
        if (entry.id === current) {
            classes.push('view-tab-active');
        }
        if (start === entry.id && views.length > 1) {
            classes.push('view-tab-start');
        }
        tab.className = classes.join(' ');
        tab.textContent = entry.label === '' ? entry.id : entry.label;
        tab.title =
            `View "${entry.id}"` +
            (start === entry.id && views.length > 1 ? ' (the board starts here)' : '') +
            ' -- right-click to rename, copy or delete it';
        tab.addEventListener('click', () => switchView(entry.id));
        tab.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            // The menu is an overlay over the whole shell, so it is positioned against it -- the body stands in
            // when the shell is missing, which the module check at load time has already refused.
            const overlay: HTMLElement = root ?? document.body;
            overlay.addEventListener('click', () => hideContextMenu(overlay), { once: true });
            showContextMenu(overlay, event.clientX, event.clientY, viewMenu(entry.id));
        });
        viewTabs.append(tab);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'view-tab view-tab-add';
    add.textContent = '+';
    add.title = 'Add a view: another screenful of widgets, one tap apart';
    add.addEventListener('click', addEmptyView);
    viewTabs.append(add);

    // The overlay: the other views' widgets, as outlines. Off by default, because the design on the glass is
    // the active view and nothing else.
    const all = document.createElement('button');
    all.type = 'button';
    all.className = showOtherViews ? 'view-tab view-tab-overlay view-tab-active' : 'view-tab view-tab-overlay';
    all.textContent = 'All';
    all.title = showOtherViews
        ? 'Drawing the other views as outlines -- click to show only this view'
        : 'Draw the other views as outlines, to find a widget that is not on this one';
    all.addEventListener('click', () => {
        showOtherViews = !showOtherViews;
        view.setOverlay(showOtherViews);
        refreshViewTabs();
    });
    if (views.length > 1) {
        viewTabs.append(all);
    }
}

/** What a view tab's right-click offers. */
function viewMenu(viewId: string): ContextMenuItem[] {
    const items: ContextMenuItem[] = [{ label: 'Rename view...', action: () => renameViewTab(viewId) }];
    const views = viewsOf(state.document);
    if (views.length > 1 && startViewId(state.document) !== viewId) {
        items.push({
            label: 'Start the board on this view',
            action: () => {
                const next = setStartView(state, viewId);
                if (next === state) {
                    return;
                }
                state = next;
                refreshProperties();
                refreshViewTabs();
                flushPost();
            },
        });
    }
    items.push({ label: 'Duplicate view', action: () => duplicateViewTab(viewId) });
    if (views.length > 1) {
        items.push({
            label: 'Delete view',
            danger: true,
            action: () => {
                const next = removeView(state, viewId);
                if (next === state) {
                    return;
                }
                state = next;
                // The view that was on screen is gone, so go where the board would start rather than to
                // whichever tab happens to be first.
                activeViewTab = startViewId(state.document);
                view.setActiveView(currentView());
                view.setState(state);
                refreshProperties();
                refreshViewTabs();
                flushPost();
            },
        });
    }
    return items;
}

/** Copies a view and everything on it, and goes to the copy -- which is how a variant gets made. */
function duplicateViewTab(viewId: string): void {
    const before = viewsOf(state.document).map((entry) => entry.id);
    const next = duplicateView(state, viewId);
    if (next === state) {
        return;
    }
    state = next;
    // The copy is inserted right after its original, so the one id that was not there before is it.
    activeViewTab = viewsOf(state.document).find((entry) => !before.includes(entry.id))?.id;
    view.setActiveView(currentView());
    view.setState(state);
    refreshProperties();
    refreshViewTabs();
    flushPost();
}

/** Adds a view, and goes to it: a tab nobody is looking at would make the button look broken. */
function addEmptyView(): void {
    const next = addView(state, freeViewId(state.document));
    if (next === state) {
        return;
    }
    state = next;
    const views = viewsOf(state.document);
    const added = views[views.length - 1];
    if (added !== undefined) {
        activeViewTab = added.id;
    }
    view.setActiveView(currentView());
    view.setState(state);
    refreshProperties();
    refreshViewTabs();
    flushPost();
}

/**
 * Renames a view in place: its tab becomes a field.
 *
 * The *id* is what is edited, because that is what the generated `View::` variant is made from; a view whose
 * caption was its id follows it, so the tab does not keep the old name.
 */
function renameViewTab(viewId: string): void {
    const views = viewsOf(state.document);
    const index = views.findIndex((entry) => entry.id === viewId);
    const tab: unknown = viewTabs.children[index];
    if (index === -1 || !(tab instanceof HTMLButtonElement)) {
        return;
    }
    const input = document.createElement('input');
    input.className = 'view-tab-input';
    input.value = viewId;
    tab.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const commit = (): void => {
        if (done) {
            return;
        }
        done = true;
        const next = input.value.trim();
        const label = views.find((entry) => entry.id === viewId)?.label;
        if (next !== '' && next !== viewId) {
            const renamed = renameView(state, viewId, next);
            if (renamed !== state) {
                // A caption that was the id was a placeholder; follow the new name rather than keep the old.
                state = label === viewId ? setViewLabel(renamed, next, next) : renamed;
                activeViewTab = next;
                view.setActiveView(currentView());
                view.setState(state);
                flushPost();
            }
        }
        refreshProperties();
        refreshViewTabs();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            commit();
        } else if (event.key === 'Escape') {
            done = true;
            refreshViewTabs();
        }
    });
}

function refreshProperties(): void {
    renderProperties(properties, state, selectedId, panels);
    // The tabs are rebuilt with the panel because every path that can change the design -- a drop, a property,
    // an undo -- comes through here, and adding or deleting a view is one of those edits.
    refreshViewTabs();
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

    // SD and SMTP, beside touch: all are project settings the firmware reads at compile time. Both are
    // cargo features rather than env keys, because enabling them is what adds code -- the FAT filesystem
    // (embedded-sdmmc) and the keep-alive client -- so they are switches: on and off are both real states,
    // not a menu of values like the rotation.
    const sd = toggleSwitch({
        label: 'SD',
        checked: sdEnabled,
        disabled: !sdBoard,
        title: sdBoard
            ? 'Mount the SD card and compile its FAT filesystem (embedded-sdmmc) in. Changing it needs a rebuild.'
            : 'This board has no SD card socket, so there is nothing to switch.',
        onChange: (on) => setSd(on),
    });

    const smtpSwitch = toggleSwitch({
        label: 'SMTP',
        checked: smtpEnabled,
        disabled: !smtpAvailable,
        title: smtpAvailable
            ? 'Compile the SMTP keep-alive client (src/smtp.rs) in and send its posts. Changing it needs a rebuild.'
            : 'Run SMTP… first: the switch compiles the client the wizard writes, and there is none yet.',
        onChange: (on) => setSmtp(on),
    });

    // Brightness is a range rather than a switch, and it is only offered when the panel has a BL pin: a
    // module that leaves it unconnected has nothing to dim. The number in the project is the brightness a
    // person sees -- the firmware inverts it for an active-low transistor.
    const brightnessControl = backlightBoard ? brightnessSlider() : undefined;

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
        sd,
        smtpSwitch,
        ...(brightnessControl === undefined ? [] : [brightnessControl]),
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

/**
 * A labelled switch for a two-state project setting.
 *
 * The `<input type="checkbox">` is the control -- keyboard reachable, toggled by clicking the label -- and the
track and thumb are its drawing, so the state reads the same in a light and a dark window. A `<select>` was
wrong for this: "SD: on / SD: off" reads as a choice between two values, and these are one setting that is
on or off.
 */
function toggleSwitch(options: {
    label: string;
    checked: boolean;
    disabled: boolean;
    title: string;
    onChange: (checked: boolean) => void;
}): HTMLLabelElement {
    const wrap = document.createElement('label');
    wrap.className = 'tool-toggle';
    wrap.title = options.title;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'tool-toggle-input';
    input.checked = options.checked;
    input.disabled = options.disabled;
    input.addEventListener('change', () => options.onChange(input.checked));

    const track = document.createElement('span');
    track.className = 'tool-toggle-track';
    const thumb = document.createElement('span');
    thumb.className = 'tool-toggle-thumb';
    track.append(thumb);

    const text = document.createElement('span');
    text.className = 'tool-toggle-label';
    text.textContent = options.label;

    wrap.append(input, track, text);
    return wrap;
}

function separator(): HTMLElement {
    const node = document.createElement('span');
    node.className = 'toolbar-separator';
    return node;
}

/**
 * The backlight brightness: a labelled range with its value in text beside it.
 *
 * A slider rather than a menu because the setting is a percentage and every step between the ends is
 * meaningful. It is *disabled* when the project's `src/main.rs` still holds the pin on: the line would be
 * written but nothing would read it, and a control that appears to work is worse than one that explains
 * itself. The percentage is redrawn on `input` and only posted on `change`, so dragging writes nothing.
 */
function brightnessSlider(): HTMLLabelElement {
    const wrap = document.createElement('label');
    wrap.className = 'tool-slider';
    wrap.title = backlightPwm
        ? 'The panel backlight brightness, by PWM on its BL pin. It is compiled in: rebuild for a change to take effect.'
        : "This project's src/main.rs still holds the backlight on. Recreate the project (or drive the BL pin by "
        + 'PWM) for the setting to reach the panel.';

    const label = document.createElement('span');
    label.className = 'tool-toggle-label';
    label.textContent = 'Brightness';

    const value = document.createElement('span');
    value.className = 'tool-slider-value';
    value.textContent = `${brightness}%`;

    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'tool-slider-input';
    input.min = '0';
    input.max = '100';
    input.step = '5';
    input.value = String(brightness);
    input.disabled = !backlightPwm;
    // The label under the thumb follows the drag; only the release is written to the project.
    input.addEventListener('input', () => {
        value.textContent = `${input.value}%`;
    });
    input.addEventListener('change', () => setBrightness(Number(input.value)));

    wrap.append(label, input, value);
    return wrap;
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

// ---------------------------------------------------------------- pictures

/**
 * Decodes the image files the extension sent, and repaints as each one arrives.
 *
 * The bytes come in as a data URL, so the *browser* does the decoding: BMP, PNG, JPEG, GIF and WebP all arrive
 * through the same door, and there is no image parser in this codebase to get wrong. A file the browser cannot
 * read, or a panel with no `Image` (the test harness is one), simply leaves the asset placeholder in place.
 */
function loadBitmaps(assets: readonly DesignerImageAsset[] | undefined): void {
    if (assets === undefined || assets.length === 0 || typeof Image !== 'function') {
        return;
    }
    for (const asset of assets) {
        const image = new Image();
        image.src = `data:${asset.mime};base64,${asset.data}`;
        const ready = typeof image.decode === 'function' ? image.decode() : Promise.resolve();
        ready
            .then(() => {
                setBitmap(asset.src, image);
                view.draw();
            })
            .catch(() => {
                // A file the browser will not decode keeps its placeholder, which names it. The build would
                // refuse it too, so this is a preview losing a picture, not a design losing a widget.
            });
    }
}
