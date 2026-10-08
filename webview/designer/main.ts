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

import { CanvasView } from './canvas';
import { renderProperties, renderToolbox } from './panels';
import {
    type DesignerState,
    addWidget,
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
import type { DesignerInbound, DesignerInit, DesignerReport } from '../../src/designer/protocol';
import type { LcdRotation } from '../../src/display/rotation';

interface VsCodeApi {
    postMessage(message: DesignerInbound): void;
    getState(): unknown;
    setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const host = acquireVsCodeApi();

/** How long edits are batched before being sent, in milliseconds. */
const POST_DELAY_MS = 120;

let state: DesignerState;
let selectedId: string | undefined;
let canvasWidth = 0;
let canvasHeight = 0;
let touchBoard = false;
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
});

const panels = {
    onEdit(next: DesignerState) {
        state = next;
        view.setState(next);
        refreshProperties();
        schedulePost();
    },
    onSelect(id: string | undefined) {
        selectedId = id;
        view.select(id);
        refreshProperties();
    },
};

window.addEventListener('message', (event: MessageEvent<DesignerInit | DesignerReport>) => {
    const message = event.data;
    if (message.type === 'init') {
        canvasWidth = message.canvas.width;
        canvasHeight = message.canvas.height;
        touchBoard = message.touch;
        selectedId = undefined;
        state = initialState(message.document);
        view.select(undefined);
        view.setState(state);
        document.title = `${message.document.screenId} - ${canvasWidth}x${canvasHeight}`;
        renderToolbox(toolbox, (tag) => drop(tag));
        refreshProperties();
        refreshToolbar();
        status(message.loadError === undefined ? `${message.paths.document} -> ${message.paths.kdl}` : message.loadError, message.loadError !== undefined);
        return;
    }
    if (message.type === 'report') {
        report(message);
    }
});

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

/** A tag dropped or clicked in the Toolbox: put it in the middle of the canvas. */
function drop(tag: string): void {
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

    const revealKdl = toolButton('Markup', () => host.postMessage({ type: 'action', action: 'revealKdl' }));
    const revealDocument = toolButton('Design file', () => host.postMessage({ type: 'action', action: 'revealDocument' }));
    const build = toolButton('Build', () => host.postMessage({ type: 'action', action: 'build' }));

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
        separator(),
        revealDocument,
        revealKdl,
        build,
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

/** Shows the extension's verdict: the problems, or a note that the markup was written. */
function report(message: DesignerReport): void {
    const problems = message.problems;
    if (problems.length === 0) {
        status(message.kdl === undefined ? 'Saved.' : `Saved. Markup is ${message.kdl.split('\n').length} lines.`, false);
        return;
    }
    status(`${problems.length} problem${problems.length === 1 ? '' : 's'}: ${problems[0]}`, true);
    if (properties.querySelector('.problem-list') === null) {
        const list = document.createElement('ul');
        list.className = 'problem-list';
        for (const problem of problems) {
            const item = document.createElement('li');
            item.textContent = problem;
            list.append(item);
        }
        properties.append(list);
    }
}

function status(text: string, isProblem: boolean): void {
    footer.textContent = text;
    footer.classList.toggle('is-problem', isProblem);
}

// ---------------------------------------------------------------- keyboard

window.addEventListener('keydown', (event) => {
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
