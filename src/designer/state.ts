/**
 * The designer's editing state: a document, and the undo history around it.
 *
 * Everything the canvas does to a design goes through here, and it is a pure module -- no DOM, no `vscode` --
 * for two reasons. The obvious one is that the rules are then testable in the t1 layer rather than only by
 * clicking. The less obvious one is that the canvas and the extension both need them: the frontend decides
 * what a drag means, and the extension has to validate and write what comes back, so a single implementation
 * is the only way the two cannot disagree.
 *
 * Undo is a stack of whole documents. That is more memory than a command log and it is worth it: documents
 * are small (a widget is a dozen numbers), and "replace the document" cannot get *partially* applied the way
 * an inverted operation can. Since a drag produces an edit per mouse-move, consecutive edits to the same
 * widget and the same kind coalesce into one undo step -- otherwise dragging a button once would take forty
 * presses of Ctrl+Z to undo.
 */

import {
    type DesignerChildren,
    type DesignerDocument,
    type DesignerFont,
    type DesignerIconPart,
    type DesignerWidget,
    type TriangleBox,
    TRIANGLE_POINT_NAMES,
    createDocument,
    defaultChildren,
    defaultProps,
    designCanvasSize,
    isFontId,
    placeWidget,
    triangleFromVertices,
    triangleVertices,
    uniqueWidgetId,
} from './model';
import type { DesignerEvent } from './catalog';
import type { LcdRotation } from '../display/rotation';
import type { Rect } from './grid';

export interface DesignerState {
    document: DesignerDocument;
    /** Earlier documents, oldest first. The last entry is what one undo restores. */
    past: DesignerDocument[];
    /** Documents undone and not yet re-done. */
    future: DesignerDocument[];
    /**
     * What the last edit was, in the form `kind:id`. A new edit with the same key replaces the top of the
     * undo stack instead of pushing, which is what keeps a drag to one undo step.
     */
    lastKey?: string;
}

export function initialState(document: DesignerDocument): DesignerState {
    return { document, past: [], future: [] };
}

/** A new document for a board, with the screen id derived from the project name. */
export function newDocument(options: {
    boardId: string;
    panelWidth: number;
    panelHeight: number;
    rotation: LcdRotation;
    screenId: string;
}): DesignerState {
    return initialState(createDocument(options));
}

export function canUndo(state: DesignerState): boolean {
    return state.past.length > 0;
}

export function canRedo(state: DesignerState): boolean {
    return state.future.length > 0;
}

export function undo(state: DesignerState): DesignerState {
    const previous = state.past[state.past.length - 1];
    if (previous === undefined) {
        return state;
    }
    return {
        document: previous,
        past: state.past.slice(0, -1),
        future: [state.document, ...state.future],
        // Undoing ends any coalescing run, so the next edit starts a new step.
        lastKey: undefined,
    };
}

export function redo(state: DesignerState): DesignerState {
    const next = state.future[0];
    if (next === undefined) {
        return state;
    }
    return {
        document: next,
        past: [...state.past, state.document],
        future: state.future.slice(1),
        lastKey: undefined,
    };
}

/**
 * Applies an edit, recording it for undo.
 *
 * `key` is what coalesces a run of edits: while consecutive edits share it, they collapse into one undo
 * step. Pass `undefined` for edits that are always their own step, such as adding or deleting a widget.
 */
function edit(
    state: DesignerState,
    key: string | undefined,
    change: (document: DesignerDocument) => DesignerDocument,
): DesignerState {
    const document = change(state.document);
    if (document === state.document) {
        // Nothing changed: recording it would make Ctrl+Z appear to do nothing.
        return state;
    }
    const coalesce = key !== undefined && key === state.lastKey;
    return {
        document,
        past: coalesce ? state.past : [...state.past, state.document],
        // Any edit at all invalidates the redo branch.
        future: [],
        lastKey: key,
    };
}

/**
 * Replaces one widget, leaving every other and the screen alone.
 *
 * A replacement that changes nothing hands the *original* document back, which is what lets `edit` notice
 * there was no edit. Without it, every operation that rebuilt a widget would look like a change: a drag that
 * ends where it started, or a property set to the value it already had, would each take a place in the undo
 * history and make Ctrl+Z appear to do nothing.
 */
function withWidget(
    document: DesignerDocument,
    id: string,
    change: (widget: DesignerWidget) => DesignerWidget,
): DesignerDocument {
    const index = document.widgets.findIndex((widget) => widget.id === id);
    if (index === -1) {
        return document;
    }
    const existing = document.widgets[index];
    if (existing === undefined) {
        return document;
    }
    const changed = change(existing);
    if (JSON.stringify(changed) === JSON.stringify(existing)) {
        return document;
    }
    const widgets = [...document.widgets];
    widgets[index] = changed;
    return { ...document, widgets };
}

/** Adds a widget of the given tag at a point, keeping it inside the canvas. */
export function addWidget(
    state: DesignerState,
    tag: string,
    x: number,
    y: number,
): DesignerState {
    const canvas = canvasOf(state.document);
    const placed = placeWidget(tag, x, y, canvas);
    return edit(state, undefined, (document) => {
        const widget: DesignerWidget = {
            id: uniqueWidgetId(document, tag),
            tag,
            ...placed,
            props: defaultProps(tag),
            events: [],
            children: defaultChildren(tag),
        };
        return { ...document, widgets: [...document.widgets, widget] };
    });
}

/** Moves a widget. Consecutive moves of the same widget are one undo step. */
export function moveWidget(state: DesignerState, id: string, x: number, y: number): DesignerState {
    const canvas = canvasOf(state.document);
    return edit(state, `move:${id}`, (document) =>
        withWidget(document, id, (widget) => ({
            ...widget,
            x: clamp(Math.round(x), 0, canvas.width - widget.width),
            y: clamp(Math.round(y), 0, canvas.height - widget.height),
        })),
    );
}

/** Resizes a widget, refusing anything smaller than a pixel or outside the canvas. */
export function resizeWidget(state: DesignerState, id: string, rect: Rect): DesignerState {
    const canvas = canvasOf(state.document);
    return edit(state, `resize:${id}`, (document) =>
        withWidget(document, id, (widget) => ({
            ...widget,
            x: clamp(Math.round(rect.x), 0, canvas.width - 1),
            y: clamp(Math.round(rect.y), 0, canvas.height - 1),
            width: clamp(Math.round(rect.width), 1, canvas.width - clamp(Math.round(rect.x), 0, canvas.width - 1)),
            height: clamp(Math.round(rect.height), 1, canvas.height - clamp(Math.round(rect.y), 0, canvas.height - 1)),
        })),
    );
}

/**
 * Places a triangle's three points, moving and growing its box to hold them.
 *
 * The box is the points' bounding rectangle, so this is how a vertex drag works: the dragged point is
 * wherever the pointer is, the other two stay on the pixels they were on, and the box follows them all. Doing
 * it in one operation rather than a move-then-resize pair keeps the document consistent at every step -- there
 * is no moment where a vertex is outside its own box -- and gives the whole drag one undo step.
 *
 * Every vertex is clamped into the canvas first, which is the one place a point could otherwise go: outside
 * it the widget is clipped by the engine, so a point placed there could never be reached again. Because the
 * box is then measured from the clamped pixels, the box cannot hang over the edge either.
 */
export function setTriangleGeometry(state: DesignerState, id: string, box: TriangleBox): DesignerState {
    const canvas = canvasOf(state.document);
    const pixels = triangleVertices({
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.max(1, Math.round(box.width)),
        height: Math.max(1, Math.round(box.height)),
        points: box.points,
    }).map((vertex) => ({
        x: clamp(vertex.x, 0, canvas.width - 1),
        y: clamp(vertex.y, 0, canvas.height - 1),
    }));
    const geometry = triangleFromVertices(pixels);
    const props: Record<string, string | number | boolean> = {};
    TRIANGLE_POINT_NAMES.forEach((name, index) => {
        const value = geometry.points[index];
        if (value !== undefined) {
            props[name] = value;
        }
    });
    return edit(state, `triangle:${id}`, (document) =>
        withWidget(document, id, (widget) => ({
            ...widget,
            x: geometry.x,
            y: geometry.y,
            width: geometry.width,
            height: geometry.height,
            props: { ...widget.props, ...props },
        })),
    );
}

export function removeWidget(state: DesignerState, id: string): DesignerState {
    return edit(state, undefined, (document) => ({
        ...document,
        widgets: document.widgets.filter((widget) => widget.id !== id),
    }));
}

/**
 * Copies a widget, placing the copy a little down and right of the original.
 *
 * The offset is what makes the copy visible: on top of the original it would look like nothing happened, and a
 * drag from there would then move the wrong one of the two. The name is made free the same way a new widget's
 * is.
 */
export function duplicateWidget(state: DesignerState, id: string): DesignerState {
    const canvas = canvasOf(state.document);
    return edit(state, undefined, (document) => {
        const source = document.widgets.find((widget) => widget.id === id);
        if (source === undefined) {
            return document;
        }
        const offset = 8;
        const copy: DesignerWidget = {
            ...source,
            // Named after the widget it copies, not after its kind: a copy of `title` becoming `label` reads as
            // a different thing entirely. (A test caught exactly that.)
            id: uniqueWidgetId(document, source.id),
            x: Math.min(source.x + offset, Math.max(0, canvas.width - source.width)),
            y: Math.min(source.y + offset, Math.max(0, canvas.height - source.height)),
            // Deep enough that editing the copy cannot touch the original.
            props: { ...source.props },
            events: [...source.events],
            children:
                source.children === undefined
                    ? undefined
                    : source.children.kind === 'parts'
                      ? { kind: 'parts', parts: source.children.parts.map((part) => ({ ...part })) }
                      : source.children.kind === 'options'
                        ? { kind: 'options', values: [...source.children.values] }
                        : {
                              kind: 'table',
                              headers: [...source.children.headers],
                              rows: source.children.rows.map((row) => [...row]),
                          },
        };
        return { ...document, widgets: [...document.widgets, copy] };
    });
}

/** Renames a widget. The validator is what rejects a name the generated code cannot carry. */
export function renameWidget(state: DesignerState, id: string, newId: string): DesignerState {
    return edit(state, undefined, (document) =>
        withWidget(document, id, (widget) => ({ ...widget, id: newId })),
    );
}

/** Sets one property. Typing in a field coalesces into one undo step per property. */
export function setProperty(
    state: DesignerState,
    id: string,
    name: string,
    value: string | number | boolean,
): DesignerState {
    return edit(state, `prop:${id}:${name}`, (document) =>
        withWidget(document, id, (widget) => ({
            ...widget,
            props: { ...widget.props, [name]: value },
        })),
    );
}

/** Adds or removes the code-behind handler for one event. */
export function toggleEvent(state: DesignerState, id: string, event: DesignerEvent): DesignerState {
    return edit(state, undefined, (document) =>
        withWidget(document, id, (widget) => ({
            ...widget,
            events: widget.events.includes(event)
                ? widget.events.filter((candidate) => candidate !== event)
                : [...widget.events, event],
        })),
    );
}

/**
 * Moves a widget one place up or down the drawing order.
 *
 * The array *is* the z-order: the markup is emitted in this order and the engine draws in the order it reads,
 * so the last widget is on top. Reordering the array is therefore the whole operation, and it keeps the
 * document free of a separate z field that could disagree with it.
 */
export function reorderWidget(state: DesignerState, id: string, direction: 'up' | 'down'): DesignerState {
    return edit(state, undefined, (document) => {
        const index = document.widgets.findIndex((widget) => widget.id === id);
        const target = direction === 'up' ? index + 1 : index - 1;
        if (index === -1 || target < 0 || target >= document.widgets.length) {
            return document;
        }
        const widgets = [...document.widgets];
        const moved = widgets[index];
        const displaced = widgets[target];
        if (moved === undefined || displaced === undefined) {
            return document;
        }
        widgets[index] = displaced;
        widgets[target] = moved;
        return { ...document, widgets };
    });
}

/**
 * Adds a font declaration, with a free name.
 *
 * The name is what widgets refer to and what the generated Rust constant is made from, so it is given a plain
 * identifier rather than anything derived from the file path.
 */
export function addFont(state: DesignerState): DesignerState {
    return edit(state, undefined, (document) => {
        const fonts = document.fonts ?? [];
        const taken = new Set(fonts.map((font) => font.id));
        let id = 'font';
        for (let n = 2; taken.has(id); n += 1) {
            id = `font_${n}`;
        }
        const font: DesignerFont = { id, src: '', chars: '' };
        return { ...document, fonts: [...fonts, font] };
    });
}

/**
 * Declares a font from a chosen BDF file and points a widget at it, in one undo step.
 *
 * This is what the `...` next to a widget's Font dropdown does. It is one step rather than two because the
 * declaration and the reference are only meaningful together: half of it would be a font nothing uses, or a
 * reference to a font that does not exist yet, and Ctrl+Z on either alone would be a puzzle.
 *
 * The id is derived from the file name so the declaration list reads like the folder it came from, and made
 * unique rather than refused -- choosing the same file twice is a duplicate the user meant to make.
 */
export function declareFontFromPath(
    state: DesignerState,
    widgetId: string,
    path: string,
): DesignerState {
    return edit(state, undefined, (document) => {
        const { document: declared, id } = withFontDeclaration(document, path);
        return {
            ...declared,
            widgets: declared.widgets.map((widget) =>
                widget.id === widgetId ? { ...widget, props: { ...widget.props, font: id } } : widget,
            ),
        };
    });
}

/**
 * Declares a font file on the screen, without pointing any widget at it.
 *
 * The importer's case: the file is new, and the panel should list it so the user can pick it. `chars` is
 * empty, which the code generator reads as "every character" -- an imported face is not a shot counter.
 */
export function addFontDeclaration(state: DesignerState, path: string): DesignerState {
    return edit(state, undefined, (document) => withFontDeclaration(document, path).document);
}

/**
 * Appends a declaration to a document, and says what it was called.
 *
 * The pure half of both entry points above, so a caller that has more to change in the same step -- pointing
 * a widget at the font, which is what choosing a file from the Font list means -- stays one undo away from
 * where it started rather than two.
 */
function withFontDeclaration(
    document: DesignerDocument,
    path: string,
): { document: DesignerDocument; id: string } {
    const stem = path.split(/[\\/]/).pop() ?? path;
    const cleaned = stem.replace(/\.(bdf|ttf|otf)$/i, '').replace(/[^A-Za-z0-9_]/g, '_');
    const base = isFontId(cleaned) ? cleaned : `font_${cleaned}`;
    const taken = new Set((document.fonts ?? []).map((font) => font.id));
    let id = isFontId(base) ? base : 'font';
    for (let n = 2; taken.has(id); n += 1) {
        id = `${base}_${n}`;
    }
    const font: DesignerFont = { id, src: path, chars: '' };
    return { document: { ...document, fonts: [...(document.fonts ?? []), font] }, id };
}

/** Removes a font, and clears the reference from any widget that named it. */
export function removeFont(state: DesignerState, id: string): DesignerState {
    return edit(state, undefined, (document) => ({
        ...document,
        fonts: (document.fonts ?? []).filter((font) => font.id !== id),
        // A widget left pointing at a font that no longer exists would be a validation error the user has to
        // find; clearing it is what deleting the font meant.
        widgets: document.widgets.map((widget) =>
            widget.props.font === id ? { ...widget, props: { ...widget.props, font: '' } } : widget,
        ),
    }));
}

/** Sets one field of a font declaration. */
export function setFontField(
    state: DesignerState,
    id: string,
    field: keyof DesignerFont,
    value: string,
): DesignerState {
    return edit(state, `font:${id}:${field}`, (document) => ({
        ...document,
        fonts: (document.fonts ?? []).map((font) => {
            if (font.id !== id) {
                return font;
            }
            if (field !== 'id') {
                return { ...font, [field]: value };
            }
            // Renaming a font has to rename it for the widgets that use it, or every reference breaks at once.
            return { ...font, id: value };
        }),
        widgets:
            field === 'id'
                ? document.widgets.map((widget) =>
                      widget.props.font === id
                          ? { ...widget, props: { ...widget.props, font: value } }
                          : widget,
                  )
                : document.widgets,
    }));
}

/** Sets the option list, table body or icon parts of a widget that has one. */
export function setChildren(state: DesignerState, id: string, children: DesignerChildren): DesignerState {
    return edit(state, undefined, (document) =>
        withWidget(document, id, (widget) => ({ ...widget, children })),
    );
}

/** Replaces the icon parts. Coalesces, since a part's coordinates are edited like any other number. */
export function setIconParts(state: DesignerState, id: string, parts: DesignerIconPart[]): DesignerState {
    return edit(state, `parts:${id}`, (document) =>
        withWidget(document, id, (widget) => ({ ...widget, children: { kind: 'parts', parts } })),
    );
}

/** The screen-level fields: its id and theme. */
export function setScreenField(
    state: DesignerState,
    field: 'screenId' | 'theme',
    value: string,
): DesignerState {
    return edit(state, `screen:${field}`, (document) => ({ ...document, [field]: value }));
}

/** The rotation, which changes the canvas the document is designed against. */
export function setRotation(state: DesignerState, rotation: LcdRotation): DesignerState {
    return edit(state, undefined, (document) => ({ ...document, rotation }));
}

export function canvasOf(document: DesignerDocument): { width: number; height: number } {
    return designCanvasSize(document.panelWidth, document.panelHeight, document.rotation);
}

export function widgetById(document: DesignerDocument, id: string): DesignerWidget | undefined {
    return document.widgets.find((widget) => widget.id === id);
}

/**
 * The topmost widget containing a point.
 *
 * Topmost is the *last* widget in document order, because that is the order the engine draws in, so clicking
 * where two widgets overlap must select the one the user can see.
 */
export function widgetAt(document: DesignerDocument, x: number, y: number): DesignerWidget | undefined {
    for (let index = document.widgets.length - 1; index >= 0; index -= 1) {
        const widget = document.widgets[index];
        if (
            widget !== undefined &&
            x >= widget.x &&
            x < widget.x + widget.width &&
            y >= widget.y &&
            y < widget.y + widget.height
        ) {
            return widget;
        }
    }
    return undefined;
}

function clamp(value: number, low: number, high: number): number {
    return Math.max(low, Math.min(value, Math.max(low, high)));
}
