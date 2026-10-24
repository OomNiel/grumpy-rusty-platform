/**
 * The designer's canvas: drawing, and the pointer.
 *
 * Everything here is consequence-free except the pointer handling, which is why the rules it applies --
 * hit testing, resize geometry, snapping, clamping -- live in `src/designer/hit.ts` and `state.ts` and are
 * tested there. This file is the part that cannot be tested without a browser: it turns events into calls on
 * those rules, and state into pixels.
 *
 * One detail is worth stating because it affects every coordinate: the canvas element is sized to the design
 * in device pixels and scaled *with CSS*, so a click's offset has to be divided by the zoom to become a
 * design coordinate. That keeps the 1:1 promise in the arithmetic rather than in a transform matrix, and
 * makes the zoom a presentation choice rather than something the document can be wrong about.
 */

import {
    type DesignerState,
    canvasOf,
    moveWidget,
    resizeWidget,
    setTriangleGeometry,
    addWidget,
} from '../../src/designer/state';
import {
    type Guide,
    type Handle,
    GRID_STEP,
    HANDLE_SIZE,
    hitTest,
    resizeFrom,
    snapMove,
    snapTargets,
} from '../../src/designer/hit';
import {
    type TriangleBox,
    type TriangleVertex,
    triangleBoxOf,
    triangleFromVertices,
    triangleVertices,
    widgetViewId,
} from '../../src/designer/model';
import type { Rect } from '../../src/designer/grid';
import { widgetSpec } from '../../src/designer/catalog';
import { DARK_PALETTE, drawSelection, drawWidget } from './theme';

export interface CanvasCallbacks {
    /** An edit happened. The panel forwards the whole document to the extension from here. */
    onEdit(state: DesignerState): void;
    /** The selection changed, including to nothing. */
    onSelect(id: string | undefined): void;
    /** A right-click on a widget, with where it happened so the menu can open there. */
    onContextMenu(id: string, x: number, y: number): void;
    /**
     * A middle-click on a widget, which asks for the code behind it.
     *
     * The handler lives in the project's own `src/ui_handlers.rs` and only the extension can open a file, so
     * this is a message like any other rather than something the canvas can do itself.
     */
    onRevealHandler(id: string): void;
    /**
     * A drag or a drop finished.
     *
     * Live edits arrive through `onEdit` while the pointer is down, and the panel deliberately does not
     * rebuild its fields during a drag. This is the moment to catch up.
     */
    onCommit(): void;
}

interface Drag {
    kind: 'move' | 'resize' | 'vertex';
    id: string;
    handle?: Handle;
    /** Which point of a triangle is being dragged. Present only for a `vertex` drag. */
    vertex?: TriangleVertex;
    /** Where the pointer went down, in design pixels. */
    fromX: number;
    fromY: number;
    /** The rectangle as it was, so a drag is always computed from the original rather than accumulating. */
    origin: Rect;
    /**
     * A triangle's box and points as they were, for the same reason as `origin`.
     *
     * A vertex drag moves the box, so the other two points have to be recovered from a snapshot: reading them
     * back out of the updated document each move would quantise them through the per-mille arithmetic again
     * and again, and a point would crawl across the canvas while the pointer stood still.
     */
    originTriangle?: TriangleBox;
}

/** Keeps a design coordinate inside the canvas, which is what a vertex drag has to respect. */
function clamp(value: number, low: number, high: number): number {
    return Math.max(low, Math.min(high, value));
}

export class CanvasView {
    private state?: DesignerState;
    private selected?: string;
    private drag?: Drag;
    private guides: Guide[] = [];
    private zoom = 1;
    /**
     * The view being edited, or `undefined` until the panel says which.
     *
     * The widgets of the other views are in the document but not on the glass, so they are not drawn, not hit
     * and not snapped to: the canvas shows what the board would show.
     */
    private activeView?: string;

    /**
     * Whether the other views are drawn as outlines.
     *
     * Off is the truthful picture: what is on the glass is what is on the canvas. On is a locating aid -- the
     * one way to see that a widget was dropped on the wrong view -- and the outlines are never hit, never
     * snapped to and never selected, so switching them on cannot change the design by accident.
     */
    private overlay = false;

    constructor(
        private readonly element: HTMLCanvasElement,
        private readonly callbacks: CanvasCallbacks,
    ) {
        this.element.addEventListener('pointerdown', (event) => this.pointerDown(event));
        this.element.addEventListener('pointermove', (event) => this.pointerMove(event));
        this.element.addEventListener('pointerup', (event) => this.pointerUp(event));
        this.element.addEventListener('pointercancel', (event) => this.pointerUp(event));
        this.element.addEventListener('dragover', (event) => {
            // Without this a drop never fires: the default is to refuse the drag.
            event.preventDefault();
        });
        this.element.addEventListener('drop', (event) => this.drop(event));
        this.element.addEventListener('contextmenu', (event) => this.contextMenu(event));
        this.element.addEventListener('auxclick', (event) => this.auxClick(event));
    }

    setState(state: DesignerState): void {
        this.state = state;
        if (this.selected !== undefined && !state.document.widgets.some((w) => w.id === this.selected)) {
            this.selected = undefined;
            this.callbacks.onSelect(undefined);
        }
        this.draw();
    }

    /**
     * Switches the view being edited.
     *
     * The selection is dropped when it belongs to another view: it would otherwise keep its handles on screen
     * with nothing under them, and the property panel would be editing a widget nobody can see.
     */
    setActiveView(viewId: string): void {
        this.activeView = viewId;
        if (this.state === undefined) {
            // Nothing drawn yet: the panel sets the view before its first state, and the first `setState` paints
            // with it. Drawing here as well would paint the design twice on every open.
            return;
        }
        if (this.selected !== undefined) {
            const widget = this.state.document.widgets.find((candidate) => candidate.id === this.selected);
            if (widget !== undefined && widgetViewId(this.state.document, widget) !== viewId) {
                this.selected = undefined;
                this.callbacks.onSelect(undefined);
            }
        }
        this.draw();
    }

    /** The view being edited, once the panel has said. */
    getActiveView(): string | undefined {
        return this.activeView;
    }

    /** Shows (or hides) the other views' widgets as outlines. Undoable in one click, nothing to save. */
    setOverlay(shown: boolean): void {
        this.overlay = shown;
        if (this.state === undefined) {
            return;
        }
        this.draw();
    }

    setZoom(zoom: number): void {
        this.zoom = zoom;
        this.draw();
    }

    getZoom(): number {
        return this.zoom;
    }

    select(id: string | undefined): void {
        this.selected = id;
        this.draw();
    }

    getSelection(): string | undefined {
        return this.selected;
    }

    /** The canvas viewport in design pixels, which is what the element must be sized to. */
    designSize(): { width: number; height: number } {
        return this.state === undefined ? { width: 0, height: 0 } : canvasOf(this.state.document);
    }

    draw(): void {
        const state = this.state;
        if (state === undefined) {
            return;
        }
        const { width, height } = canvasOf(state.document);
        if (this.element.width !== width || this.element.height !== height) {
            this.element.width = width;
            this.element.height = height;
        }
        this.element.style.width = `${width * this.zoom}px`;
        this.element.style.height = `${height * this.zoom}px`;

        const context = this.element.getContext('2d');
        if (context === null) {
            return;
        }
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.fillStyle = DARK_PALETTE.screen;
        context.fillRect(0, 0, width, height);
        this.drawGrid(context, width, height);

        for (const widget of state.document.widgets) {
            // Only the view on show: a layer that is not on the glass must not look like it is.
            if (this.activeView !== undefined && widgetViewId(state.document, widget) !== this.activeView) {
                continue;
            }
            drawWidget(context, widget, DARK_PALETTE);
        }

        if (this.overlay) {
            this.drawOtherViews(context);
        }

        const selected = state.document.widgets.find((widget) => widget.id === this.selected);
        if (selected !== undefined) {
            drawSelection(context, selected, DARK_PALETTE, HANDLE_SIZE);
        }

        context.save();
        context.strokeStyle = DARK_PALETTE.guide;
        context.lineWidth = 1;
        for (const guide of this.guides) {
            context.beginPath();
            if (guide.axis === 'x') {
                context.moveTo(guide.position + 0.5, 0);
                context.lineTo(guide.position + 0.5, height);
            } else {
                context.moveTo(0, guide.position + 0.5);
                context.lineTo(width, guide.position + 0.5);
            }
            context.stroke();
        }
        context.restore();
    }

    /**
     * The widgets of the views that are not on show, as dashed outlines.
     *
     * Not a preview of them: an outline says where a widget is, which is the question the overlay answers --
     * "where did that label go?" -- without suggesting the board would paint it here. A drop or a click on one
     * of these falls through to the canvas, because hit testing only ever looks at the active view.
     */
    private drawOtherViews(context: CanvasRenderingContext2D): void {
        const state = this.state;
        if (state === undefined) {
            return;
        }
        context.save();
        context.strokeStyle = DARK_PALETTE.guide;
        context.lineWidth = 1;
        context.setLineDash([4, 3]);
        for (const widget of state.document.widgets) {
            const view = widgetViewId(state.document, widget);
            if (this.activeView !== undefined && view === this.activeView) {
                continue;
            }
            context.strokeRect(
                widget.x + 0.5,
                widget.y + 0.5,
                Math.max(1, widget.width - 1),
                Math.max(1, widget.height - 1),
            );
        }
        context.restore();
    }

    /** A faint grid, so a widget's position is legible before anything has been dropped. */
    private drawGrid(context: CanvasRenderingContext2D, width: number, height: number): void {
        context.save();
        context.strokeStyle = DARK_PALETTE.grid;
        context.lineWidth = 1;
        context.beginPath();
        for (let x = GRID_STEP * 4; x < width; x += GRID_STEP * 4) {
            context.moveTo(x + 0.5, 0);
            context.lineTo(x + 0.5, height);
        }
        for (let y = GRID_STEP * 4; y < height; y += GRID_STEP * 4) {
            context.moveTo(0, y + 0.5);
            context.lineTo(width, y + 0.5);
        }
        context.stroke();
        context.restore();
    }

    /** A pointer event in design pixels, which is the only coordinate system the rules know about. */
    private point(event: PointerEvent | DragEvent | MouseEvent): { x: number; y: number } {
        const bounds = this.element.getBoundingClientRect();
        return {
            x: (event.clientX - bounds.left) / this.zoom,
            y: (event.clientY - bounds.top) / this.zoom,
        };
    }

    private pointerDown(event: PointerEvent): void {
        // Only the left button drags. A middle-click asks for the code behind the widget and a right-click
        // opens its menu, and neither should move anything while the button is held.
        if (event.button !== 0) {
            return;
        }
        const state = this.state;
        if (state === undefined) {
            return;
        }
        const { x, y } = this.point(event);
        const target = hitTest(state.document, x, y, this.selected, this.activeView);
        this.selected = target?.id;
        this.callbacks.onSelect(target?.id);

        if (target !== undefined) {
            const widget = state.document.widgets.find((candidate) => candidate.id === target.id);
            if (widget !== undefined) {
                this.element.setPointerCapture(event.pointerId);
                this.drag = {
                    kind:
                        target.vertex !== undefined
                            ? 'vertex'
                            : target.handle === undefined
                                ? 'move'
                                : 'resize',
                    id: target.id,
                    handle: target.handle,
                    vertex: target.vertex,
                    fromX: x,
                    fromY: y,
                    origin: { x: widget.x, y: widget.y, width: widget.width, height: widget.height },
                    originTriangle: target.vertex === undefined ? undefined : triangleBoxOf(widget),
                };
            }
        }
        this.draw();
    }

    private pointerMove(event: PointerEvent): void {
        const drag = this.drag;
        const state = this.state;
        if (drag === undefined || state === undefined) {
            return;
        }
        event.preventDefault();
        const { x, y } = this.point(event);
        const dx = Math.round(x - drag.fromX);
        const dy = Math.round(y - drag.fromY);
        const canvas = canvasOf(state.document);

        if (drag.kind === 'resize') {
            const rect = resizeFrom(drag.origin, drag.handle ?? 'se', dx, dy);
            this.guides = [];
            this.callbacks.onEdit(resizeWidget(state, drag.id, rect));
            return;
        }

        if (drag.kind === 'vertex' && drag.vertex !== undefined && drag.originTriangle !== undefined) {
            // The point goes exactly where the pointer is -- a whole design pixel, not the move grid -- and the
            // box is remeasured around all three points, so the other two do not stir and the dragged one can
            // leave the old box. No guides: they describe a rectangle aligning with its neighbours, which is
            // not what a free point is doing.
            const vertices = triangleVertices(drag.originTriangle);
            vertices[drag.vertex] = {
                x: clamp(Math.round(x), 0, canvas.width - 1),
                y: clamp(Math.round(y), 0, canvas.height - 1),
            };
            this.guides = [];
            this.callbacks.onEdit(setTriangleGeometry(state, drag.id, triangleFromVertices(vertices)));
            return;
        }

        const wanted = { ...drag.origin, x: drag.origin.x + dx, y: drag.origin.y + dy };
        const snapped = snapMove(wanted, snapTargets(state.document, drag.id, this.activeView), canvas);
        this.guides = snapped.guides;
        this.callbacks.onEdit(moveWidget(state, drag.id, snapped.x, snapped.y));
    }

    private pointerUp(event: PointerEvent): void {
        if (this.drag !== undefined) {
            this.element.releasePointerCapture(event.pointerId);
            this.drag = undefined;
            this.guides = [];
            this.draw();
            this.callbacks.onCommit();
        }
    }

    /**
     * A right-click: select what is under it and ask the panel for a menu.
     *
     * The browser's own menu is suppressed, even on empty canvas where there is nothing to offer -- a context
     * menu that sometimes shows the page's own is worse than one that does nothing.
     */
    private contextMenu(event: MouseEvent): void {
        const state = this.state;
        if (state === undefined) {
            return;
        }
        event.preventDefault();
        const { x, y } = this.point(event);
        const target = hitTest(state.document, x, y, this.selected, this.activeView);
        if (target === undefined) {
            return;
        }
        this.selected = target.id;
        this.callbacks.onSelect(target.id);
        this.draw();
        this.callbacks.onContextMenu(target.id, event.clientX, event.clientY);
    }

    /**
     * A middle-click: open the code behind the widget under the pointer, if it has any.
     *
     * Only a widget that raises an event has a handler, and a widget with none has nothing to show -- so the
     * click is ignored there rather than opening a file to show nothing. The selection follows the click for
     * the same reason a right-click's does: the panel's own view should agree with what was just acted on.
     */
    private auxClick(event: MouseEvent): void {
        if (event.button !== 1) {
            return;
        }
        const state = this.state;
        if (state === undefined) {
            return;
        }
        const { x, y } = this.point(event);
        const target = hitTest(state.document, x, y, this.selected, this.activeView);
        if (target === undefined) {
            return;
        }
        const widget = state.document.widgets.find((candidate) => candidate.id === target.id);
        if (widget === undefined || widget.events.length === 0) {
            return;
        }
        event.preventDefault();
        this.selected = target.id;
        this.callbacks.onSelect(target.id);
        this.draw();
        this.callbacks.onRevealHandler(target.id);
    }

    /** A widget dragged out of the Toolbox and dropped on the canvas. */
    private drop(event: DragEvent): void {
        const state = this.state;
        const tag = event.dataTransfer?.getData('text/rusty-designer-widget');
        if (state === undefined || tag === undefined || tag === '') {
            return;
        }
        event.preventDefault();
        const { x, y } = this.point(event);
        // The widget is centred on the pointer, because dropping by the corner makes it appear somewhere the
        // user did not aim; the half-size comes from the catalogue so it is right for every tag.
        const size = widgetSpec(tag)?.defaultSize ?? { width: 48, height: 24 };
        const placed = addWidget(state, tag, Math.round(x - size.width / 2), Math.round(y - size.height / 2));
        const added = placed.document.widgets[placed.document.widgets.length - 1];
        if (added !== undefined) {
            this.selected = added.id;
            this.callbacks.onSelect(added.id);
        }
        this.callbacks.onEdit(placed);
        this.callbacks.onCommit();
        this.draw();
    }
}
