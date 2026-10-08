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

import { type DesignerState, canvasOf, moveWidget, resizeWidget, addWidget } from '../../src/designer/state';
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
import type { Rect } from '../../src/designer/grid';
import { widgetSpec } from '../../src/designer/catalog';
import { DARK_PALETTE, drawSelection, drawWidget } from './theme';

export interface CanvasCallbacks {
    /** An edit happened. The panel forwards the whole document to the extension from here. */
    onEdit(state: DesignerState): void;
    /** The selection changed, including to nothing. */
    onSelect(id: string | undefined): void;
    /**
     * A drag or a drop finished.
     *
     * Live edits arrive through `onEdit` while the pointer is down, and the panel deliberately does not
     * rebuild its fields during a drag. This is the moment to catch up.
     */
    onCommit(): void;
}

interface Drag {
    kind: 'move' | 'resize';
    id: string;
    handle?: Handle;
    /** Where the pointer went down, in design pixels. */
    fromX: number;
    fromY: number;
    /** The rectangle as it was, so a drag is always computed from the original rather than accumulating. */
    origin: Rect;
}

export class CanvasView {
    private state?: DesignerState;
    private selected?: string;
    private drag?: Drag;
    private guides: Guide[] = [];
    private zoom = 1;

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
    }

    setState(state: DesignerState): void {
        this.state = state;
        if (this.selected !== undefined && !state.document.widgets.some((w) => w.id === this.selected)) {
            this.selected = undefined;
            this.callbacks.onSelect(undefined);
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
            drawWidget(context, widget, DARK_PALETTE);
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
    private point(event: PointerEvent | DragEvent): { x: number; y: number } {
        const bounds = this.element.getBoundingClientRect();
        return {
            x: (event.clientX - bounds.left) / this.zoom,
            y: (event.clientY - bounds.top) / this.zoom,
        };
    }

    private pointerDown(event: PointerEvent): void {
        const state = this.state;
        if (state === undefined) {
            return;
        }
        const { x, y } = this.point(event);
        const target = hitTest(state.document, x, y, this.selected);
        this.selected = target?.id;
        this.callbacks.onSelect(target?.id);

        if (target !== undefined) {
            const widget = state.document.widgets.find((candidate) => candidate.id === target.id);
            if (widget !== undefined) {
                this.element.setPointerCapture(event.pointerId);
                this.drag = {
                    kind: target.handle === undefined ? 'move' : 'resize',
                    id: target.id,
                    handle: target.handle,
                    fromX: x,
                    fromY: y,
                    origin: { x: widget.x, y: widget.y, width: widget.width, height: widget.height },
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

        const wanted = { ...drag.origin, x: drag.origin.x + dx, y: drag.origin.y + dy };
        const snapped = snapMove(wanted, snapTargets(state.document, drag.id), canvas);
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
