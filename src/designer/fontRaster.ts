/**
 * Turning a drawn face into the cell a BDF can carry.
 *
 * The drawing itself belongs to the webview -- it is the only side with a text renderer -- but the *arithmetic*
 * that decides where every glyph lands is here, behind a canvas-shaped interface, so it can be held to a
 * measurement table without a browser. That matters because this is the part that silently goes wrong: a cell
 * measured from the wrong baseline draws a face that looks almost right, and "almost" is not something you can
 * see on a 320x480 panel without a reference beside it.
 *
 * The result is the shape `fontImport.ts` writes out and the canvas already draws: a fixed cell, glyphs in
 * printable-ASCII order, a row per line with the leftmost column high.
 */

import type { RasterisedFont } from './fontImport';

/** A coverage value at or above this is ink; below it is the anti-aliasing fringe. */
const INK = 128;

/** What `measureText` has to answer, so a test can answer it instead. */
export interface TextMetricsLike {
    width: number;
    actualBoundingBoxLeft: number;
    actualBoundingBoxRight: number;
    actualBoundingBoxAscent: number;
    actualBoundingBoxDescent: number;
}

/** The drawing surface the rasteriser needs: one canvas, and the handful of calls it makes. */
export interface CellCanvas {
    width: number;
    height: number;
    context: {
        font: string;
        textBaseline: string;
        fillStyle: string;
        clearRect(x: number, y: number, width: number, height: number): void;
        fillText(text: string, x: number, y: number): void;
        measureText(text: string): TextMetricsLike;
        /** RGBA bytes, row by row. */
        getImageData(x: number, y: number, width: number, height: number): { data: ArrayLike<number> };
    };
}

/** Makes a canvas of the given size, or says why it cannot. */
export type CellCanvasFactory = (width: number, height: number) => CellCanvas | undefined;

export type CellResult = { font: RasterisedFont } | { error: string };

/** The cell a face needs: the union of every glyph's ink, on one shared pen origin and baseline. */
export interface CellGeometry {
    /** How far left of the pen origin the ink reaches (zero or negative). */
    left: number;
    /** How far right of it. */
    right: number;
    /** Rows above the baseline. */
    ascent: number;
    /** Rows below it. */
    descent: number;
    /** Pixels from one character's origin to the next. */
    advance: number;
    /** Cell size in pixels. */
    width: number;
    height: number;
}

/**
 * Measures all ninety-five characters and works out the cell they need.
 *
 * The pen origin is shared, so a proportional face keeps its relative placement: `left` is the widest reach
 * to the left of the origin and every glyph is drawn at `-left`, which puts them all where the face intends.
 */
export function measureCell(measure: (text: string) => TextMetricsLike): CellGeometry {
    let left = 0;
    let right = 0;
    let ascent = 0;
    let descent = 0;
    let advance = 0;
    for (let code = 32; code <= 126; code += 1) {
        const text = String.fromCharCode(code);
        const metrics = measure(text);
        advance = Math.max(advance, Math.round(metrics.width));
        if (code === 32) {
            // A space has no ink, and asking a font where its blank is gets a zero box that would only
            // widen the cell for nothing.
            continue;
        }
        left = Math.min(left, Math.floor(metrics.actualBoundingBoxLeft));
        right = Math.max(right, Math.ceil(metrics.actualBoundingBoxRight));
        ascent = Math.max(ascent, Math.ceil(metrics.actualBoundingBoxAscent));
        descent = Math.max(descent, Math.ceil(metrics.actualBoundingBoxDescent));
    }
    const width = Math.max(1, right - left);
    const height = Math.max(1, ascent + descent);
    return { left, right, ascent, descent, advance: Math.max(1, advance, width), width, height };
}

/** One row of RGBA pixels as a number with the leftmost column in bit `width - 1`. */
export function rowBits(
    pixels: ArrayLike<number>,
    width: number,
    y: number,
    threshold = INK,
): number {
    let bits = 0;
    for (let x = 0; x < width; x += 1) {
        const alpha = pixels[(y * width + x) * 4 + 3] ?? 0;
        bits = bits * 2 + (alpha >= threshold ? 1 : 0);
    }
    return bits;
}

/**
 * Draws every printable character into one cell and reads the pixels back.
 *
 * The cell is drawn per glyph rather than as one long string because that is the only way to know which
 * pixels belong to which character -- kerning between neighbours would otherwise move ink across the
 * boundary, and a BDF cell has no room for that.
 */
export function rasteriseCell(
    makeCanvas: CellCanvasFactory,
    faceName: string,
    pixelSize: number,
): CellResult {
    const size = Math.max(4, Math.min(128, Math.round(pixelSize)));

    const measure = makeCanvas(1, 1);
    if (measure === undefined) {
        return { error: 'the canvas could not be created.' };
    }
    measure.context.font = `${size}px "${faceName}"`;
    const geometry = measureCell((text) => measure.context.measureText(text));

    const cell = makeCanvas(geometry.width, geometry.height);
    if (cell === undefined) {
        return { error: 'the canvas could not be created.' };
    }
    const { left, ascent, width, height } = geometry;
    const glyphs: number[][] = [];
    for (let code = 32; code <= 126; code += 1) {
        const context = cell.context;
        context.clearRect(0, 0, width, height);
        if (code !== 32) {
            context.font = `${size}px "${faceName}"`;
            context.textBaseline = 'alphabetic';
            context.fillStyle = '#ffffff';
            context.fillText(String.fromCharCode(code), -left, ascent);
        }
        const { data } = context.getImageData(0, 0, width, height);
        const rows: number[] = [];
        for (let y = 0; y < height; y += 1) {
            rows.push(rowBits(data, width, y));
        }
        glyphs.push(rows);
    }

    return {
        font: { width, height, descent: geometry.descent, advance: geometry.advance, pixelSize: size, glyphs },
    };
}
