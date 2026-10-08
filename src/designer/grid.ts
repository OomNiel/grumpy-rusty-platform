/**
 * Turning free canvas coordinates into the grid the markup actually supports.
 *
 * `embedded-gui`'s KDL has no absolute positioning: a widget is placed in a grid cell with `col`, `row`,
 * `col_span` and `row_span`, inside a container whose `cols`/`rows` are tracks. Dragging a widget anywhere on
 * a canvas is the whole point of a designer, so the placement has to be *translated* rather than dropped.
 *
 * The translation here is exact, not approximate. With `gap=0` and `padding=0` the tracks are contiguous
 * from the origin, so the widgets' own edges can be the track boundaries: collect every left and right edge
 * along an axis, sort them, and each neighbouring pair becomes a pixel-wide track. A widget's column index is
 * then the position of its left edge in that sorted list, and its span is the number of tracks its width
 * covers. The widget lands on exactly the rectangle it was drawn at -- which `resolveGrid` re-derives from
 * the tracks and spans alone, so the t1 layer can prove the round trip rather than trust it.
 *
 * The cost is track count: ten widgets at unrelated x positions produce up to twenty-one columns, because
 * every distinct edge becomes one. That is the price of pixel-exact placement, the designer's snap-to-grid
 * keeps it small in practice, and the alternative -- quantising a dragged widget onto a fixed lattice --
 * would move things the user placed deliberately.
 *
 * No `vscode` import, no `fs` import: this is arithmetic and is tested as arithmetic.
 */

/** A widget's rectangle on the canvas, in whole pixels, with the origin at the top-left. */
export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface Placement {
    col: number;
    row: number;
    colSpan: number;
    rowSpan: number;
}

export interface GridLayout {
    /** Column tracks in pixels, left to right. Always at least one. */
    cols: number[];
    /** Row tracks in pixels, top to bottom. Always at least one. */
    rows: number[];
    /** One placement per input rectangle, in the same order. */
    placements: Placement[];
}

function isWholePixel(value: number): boolean {
    return Number.isFinite(value) && Number.isInteger(value);
}

/**
 * The sorted, de-duplicated boundaries along one axis, always including the two canvas edges.
 *
 * Zero-length widgets cannot occur (they are rejected by `assertPlaceable` and by the document validator),
 * so every rectangle contributes two distinct edges and a track is never zero wide.
 */
function axisEdges(starts: readonly number[], sizes: readonly number[], extent: number): number[] {
    if (starts.length !== sizes.length) {
        throw new Error('internal: every horizontal position needs a width');
    }
    const edges = new Set<number>([0, extent]);
    for (const [index, start] of starts.entries()) {
        const size = sizes[index] ?? 0;
        edges.add(start);
        edges.add(start + size);
    }
    return [...edges].sort((a, b) => a - b);
}

function tracksFrom(edges: readonly number[]): number[] {
    const tracks: number[] = [];
    let previous = edges[0];
    if (previous === undefined) {
        return tracks;
    }
    for (const edge of edges.slice(1)) {
        tracks.push(edge - previous);
        previous = edge;
    }
    // Both canvas edges are always present, so this cannot legitimately be empty; a grid with no tracks
    // would be markup the parser rejects.
    if (tracks.length === 0) {
        throw new Error('internal: the canvas produced no tracks');
    }
    return tracks;
}

/**
 * The value at an index, or a loud failure.
 *
 * The track lists are built from the same edges the placements index into, so running off the end is a bug
 * in this module rather than anything a user can cause -- and `undefined` arithmetic would silently produce
 * a `NaN` track that only shows up as a blank panel.
 */
function at(values: readonly number[], index: number): number {
    const value = values[index];
    if (value === undefined) {
        throw new Error(`internal: track ${index} is outside the ${values.length}-entry list`);
    }
    return value;
}

/** The track a value sits on, i.e. its position in the sorted edge list. */
function edgeIndex(edges: number[], value: number): number {
    const index = edges.indexOf(value);
    if (index === -1) {
        throw new Error(`internal: edge ${value} missing from the track list`);
    }
    return index;
}

/**
 * Fails loudly on anything the markup cannot express.
 *
 * The caller validates the document first (see `model.ts`), so reaching this is a bug in the caller rather
 * than user error -- and a widget placed outside the panel would otherwise be silently clipped on glass,
 * which is exactly the kind of thing a designer must not do silently.
 */
function assertPlaceable(rect: Rect, width: number, height: number, what: string): void {
    for (const [name, value] of Object.entries(rect)) {
        if (!isWholePixel(value)) {
            throw new Error(`${what}: ${name} must be a whole number of pixels, got ${value}`);
        }
    }
    if (rect.width <= 0 || rect.height <= 0) {
        throw new Error(`${what}: a widget must be at least 1x1, got ${rect.width}x${rect.height}`);
    }
    if (rect.x < 0 || rect.y < 0) {
        throw new Error(`${what}: the origin cannot be negative, got (${rect.x}, ${rect.y})`);
    }
    if (rect.x + rect.width > width || rect.y + rect.height > height) {
        throw new Error(
            `${what}: ${rect.width}x${rect.height} at (${rect.x}, ${rect.y}) runs past the ` +
                `${width}x${height} panel`,
        );
    }
}

/**
 * Maps rectangles to a grid that reproduces them exactly.
 *
 * @param rects one rectangle per widget, in the order the widgets should be emitted
 * @param width the panel's width in the orientation being designed for
 * @param height the panel's height in the orientation being designed for
 */
export function layoutToGrid(rects: readonly Rect[], width: number, height: number): GridLayout {
    if (!isWholePixel(width) || !isWholePixel(height) || width <= 0 || height <= 0) {
        throw new Error(`the panel extent must be whole positive pixels, got ${width}x${height}`);
    }
    rects.forEach((rect, index) => assertPlaceable(rect, width, height, `widget ${index}`));

    const colEdges = axisEdges(
        rects.map((rect) => rect.x),
        rects.map((rect) => rect.width),
        width,
    );
    const rowEdges = axisEdges(
        rects.map((rect) => rect.y),
        rects.map((rect) => rect.height),
        height,
    );

    const placements = rects.map((rect) => {
        const col = edgeIndex(colEdges, rect.x);
        const row = edgeIndex(rowEdges, rect.y);
        return {
            col,
            row,
            colSpan: edgeIndex(colEdges, rect.x + rect.width) - col,
            rowSpan: edgeIndex(rowEdges, rect.y + rect.height) - row,
        };
    });

    return {
        cols: tracksFrom(colEdges),
        rows: tracksFrom(rowEdges),
        placements,
    };
}

/**
 * Rebuilds the rectangles from the tracks and placements alone.
 *
 * This is the other half of the round trip, and it is the reason the mapping can be trusted without a
 * photograph of the panel: whatever `layoutToGrid` computes, resolving it here has to give the rectangles
 * back unchanged. The t1 layer asserts exactly that for every fixture it has.
 */
export function resolveGrid(layout: GridLayout): Rect[] {
    const colOffsets = cumulative(layout.cols);
    const rowOffsets = cumulative(layout.rows);
    return layout.placements.map((placement) => {
        const left = at(colOffsets, placement.col);
        const top = at(rowOffsets, placement.row);
        return {
            x: left,
            y: top,
            width: at(colOffsets, placement.col + placement.colSpan) - left,
            height: at(rowOffsets, placement.row + placement.rowSpan) - top,
        };
    });
}

function cumulative(tracks: readonly number[]): number[] {
    const offsets: number[] = [];
    let total = 0;
    for (const track of tracks) {
        offsets.push(total);
        total += track;
    }
    offsets.push(total);
    return offsets;
}

/**
 * The `cols=`/`rows=` attribute value.
 *
 * Every track is emitted in pixels, never `fr`: a fractional track would let the engine redistribute space
 * and the canvas would stop matching the glass, which is the one promise a WYSIWYG designer makes.
 */
export function trackSpec(tracks: readonly number[]): string {
    return tracks.map((track) => `${track}px`).join(' ');
}

/** A one-line summary of a layout, for logs and for test failure messages. */
export function describeGrid(layout: GridLayout): string {
    const { cols, rows } = layout;
    return `${cols.length}x${rows.length} tracks (${cols.reduce((sum, n) => sum + n, 0)}x${rows.reduce((sum, n) => sum + n, 0)} px)`;
}
