/**
 * Pointing at the canvas: what a click selects, what a drag does, and where it snaps.
 *
 * Split out from the frontend's drawing code because these are the decisions with consequences -- which of
 * two overlapping widgets a click meant, whether a corner drag resized or moved, and whether a widget landed
 * on a neighbour's edge or one pixel off it. None of that needs a DOM, so all of it is testable here.
 *
 * Two conventions carry most of the weight:
 *
 * - **Handles win over bodies.** The eight resize handles sit on and around the selected widget, so a click
 *   there must resize rather than select whatever is underneath. They are only live for the selected widget,
 *   which is what makes a handle usable when widgets are stacked.
 * - **Topmost means last.** The document's array order is the drawing order (`state.ts` reorders it), so the
 *   search for `widgetAt` runs backwards and a click lands on what the user can actually see.
 */

import { type DesignerDocument, type DesignerWidget, designCanvasSize } from './model';
import type { Rect } from './grid';

/** The eight resize handles, named by the corner or edge they sit on. */
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** How big a handle is on screen, in canvas pixels. */
export const HANDLE_SIZE = 8;

/** How close an edge has to come before it snaps, in canvas pixels. */
export const SNAP_TOLERANCE = 6;

/** The grid a drag falls back to when nothing else is near. */
export const GRID_STEP = 4;

/** Nothing may be resized below this, which is also the smallest thing the validator accepts. */
export const MIN_SIZE = 1;

export interface Target {
    id: string;
    /** Present when the click was on one of the selected widget's resize handles. */
    handle?: Handle;
}

/** A line the frontend draws to show why something snapped where it did. */
export interface Guide {
    axis: 'x' | 'y';
    position: number;
}

/** Whether a widget's rectangle is selected, which is what makes its handles live. */
function handleCentres(widget: DesignerWidget): { handle: Handle; x: number; y: number }[] {
    const left = widget.x;
    const right = widget.x + widget.width;
    const top = widget.y;
    const bottom = widget.y + widget.height;
    const midX = widget.x + Math.floor(widget.width / 2);
    const midY = widget.y + Math.floor(widget.height / 2);
    return [
        { handle: 'nw', x: left, y: top },
        { handle: 'n', x: midX, y: top },
        { handle: 'ne', x: right, y: top },
        { handle: 'e', x: right, y: midY },
        { handle: 'se', x: right, y: bottom },
        { handle: 's', x: midX, y: bottom },
        { handle: 'sw', x: left, y: bottom },
        { handle: 'w', x: left, y: midY },
    ];
}

/**
 * What is under a point.
 *
 * The selected widget's handles are tested first, with the tolerance reaching outside the widget so that a
 * corner handle on a widget flush with the canvas edge is still grabbable.
 */
export function hitTest(
    document: DesignerDocument,
    x: number,
    y: number,
    selectedId?: string,
): Target | undefined {
    if (selectedId !== undefined) {
        const selected = document.widgets.find((widget) => widget.id === selectedId);
        if (selected !== undefined) {
            const reach = Math.floor(HANDLE_SIZE / 2);
            for (const centre of handleCentres(selected)) {
                if (
                    x >= centre.x - reach &&
                    x <= centre.x + reach &&
                    y >= centre.y - reach &&
                    y <= centre.y + reach
                ) {
                    return { id: selected.id, handle: centre.handle };
                }
            }
        }
    }

    for (let index = document.widgets.length - 1; index >= 0; index -= 1) {
        const widget = document.widgets[index];
        if (
            widget !== undefined &&
            x >= widget.x &&
            x < widget.x + widget.width &&
            y >= widget.y &&
            y < widget.y + widget.height
        ) {
            return { id: widget.id };
        }
    }
    return undefined;
}

/**
 * The rectangle a drag from a handle produces.
 *
 * Only the edges the handle owns move, so dragging the east edge never shifts the west one. A moving edge
 * also cannot pass the edge it is anchored to: dragging the east edge far to the left stops at one pixel
 * rather than inverting the rectangle. Inverting would leave the widget's `x` on the other side of its own
 * body, which is invisible in the document and startling on screen -- and the grid mapping refuses a
 * negative size, so an inverted rectangle would fail to emit rather than merely look wrong.
 */
export function resizeFrom(rect: Rect, handle: Handle, dx: number, dy: number): Rect {
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    let x = rect.x;
    let y = rect.y;
    let width = rect.width;
    let height = rect.height;

    if (handle === 'nw' || handle === 'w' || handle === 'sw') {
        x = Math.min(rect.x + dx, right - MIN_SIZE);
        width = right - x;
    }
    if (handle === 'ne' || handle === 'e' || handle === 'se') {
        width = Math.max(MIN_SIZE, rect.width + dx);
    }
    if (handle === 'nw' || handle === 'n' || handle === 'ne') {
        y = Math.min(rect.y + dy, bottom - MIN_SIZE);
        height = bottom - y;
    }
    if (handle === 'sw' || handle === 's' || handle === 'se') {
        height = Math.max(MIN_SIZE, rect.height + dy);
    }

    return { x, y, width, height };
}

/** The edges and centres a dragged widget can snap to: its neighbours' and the canvas's own. */
export function snapTargets(
    document: DesignerDocument,
    excludeId: string,
): { xs: number[]; ys: number[] } {
    const canvas = designCanvasSize(document.panelWidth, document.panelHeight, document.rotation);
    const xs = [0, canvas.width, Math.floor(canvas.width / 2)];
    const ys = [0, canvas.height, Math.floor(canvas.height / 2)];

    for (const widget of document.widgets) {
        if (widget.id === excludeId) {
            continue;
        }
        xs.push(widget.x, widget.x + widget.width, widget.x + Math.floor(widget.width / 2));
        ys.push(widget.y, widget.y + widget.height, widget.y + Math.floor(widget.height / 2));
    }
    return { xs, ys };
}

/** The nearest target within tolerance, or `undefined`. Ties go to the closest, then the first. */
export function bestSnap(value: number, targets: readonly number[], tolerance = SNAP_TOLERANCE): number | undefined {
    let best: number | undefined;
    let bestDistance = tolerance + 1;
    for (const target of targets) {
        const distance = Math.abs(target - value);
        if (distance <= tolerance && distance < bestDistance) {
            best = target;
            bestDistance = distance;
        }
    }
    return best;
}

export function gridSnap(value: number, step = GRID_STEP): number {
    return Math.round(value / step) * step;
}

/**
 * Where a dragged widget's top-left lands, and which lines to draw.
 *
 * Both edges of each axis are offered to the snap, so a widget can be aligned by its right edge as easily as
 * by its left; the correction is taken from whichever edge is closest to a target, and the widget keeps its
 * size either way. Nothing snapping means the grid, which is what keeps hand-placed widgets tidy.
 */
export function snapMove(
    rect: Rect,
    targets: { xs: readonly number[]; ys: readonly number[] },
    canvas: { width: number; height: number },
): { x: number; y: number; guides: Guide[] } {
    const guides: Guide[] = [];

    const right = rect.x + rect.width;
    const snappedLeft = bestSnap(rect.x, targets.xs);
    const snappedRight = bestSnap(right, targets.xs);
    let x: number;
    if (snappedLeft !== undefined && (snappedRight === undefined || Math.abs(snappedLeft - rect.x) <= Math.abs(snappedRight - right))) {
        x = snappedLeft;
        guides.push({ axis: 'x', position: snappedLeft });
    } else if (snappedRight !== undefined) {
        x = snappedRight - rect.width;
        guides.push({ axis: 'x', position: snappedRight });
    } else {
        x = gridSnap(rect.x);
    }

    const bottom = rect.y + rect.height;
    const snappedTop = bestSnap(rect.y, targets.ys);
    const snappedBottom = bestSnap(bottom, targets.ys);
    let y: number;
    if (snappedTop !== undefined && (snappedBottom === undefined || Math.abs(snappedTop - rect.y) <= Math.abs(snappedBottom - bottom))) {
        y = snappedTop;
        guides.push({ axis: 'y', position: snappedTop });
    } else if (snappedBottom !== undefined) {
        y = snappedBottom - rect.height;
        guides.push({ axis: 'y', position: snappedBottom });
    } else {
        y = gridSnap(rect.y);
    }

    return {
        x: Math.max(0, Math.min(x, canvas.width - rect.width)),
        y: Math.max(0, Math.min(y, canvas.height - rect.height)),
        guides,
    };
}
