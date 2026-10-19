/**
 * Drawing a font file with the one renderer this extension has.
 *
 * Nothing clever happens here: a `FontFace` from the file's bytes, a canvas to draw on, and
 * `src/designer/fontRaster.ts` for the part that has to be right -- which character's ink lands where. The
 * split is deliberate, because the arithmetic can be held to a measurement table in a test and this cannot.
 */

import { rasteriseCell, type CellCanvas, type CellCanvasFactory } from '../../src/designer/fontRaster';
import type { RasterisedFont } from '../../src/designer/fontImport';

export type RasterResult = { font: RasterisedFont } | { error: string };

/** A DOM canvas as the rasteriser's interface -- the same object, seen through a narrower type. */
const canvases: CellCanvasFactory = (width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) {
        return undefined;
    }
    return { width: canvas.width, height: canvas.height, context } as unknown as CellCanvas;
};

/**
 * Rasterises a face at the size asked for.
 *
 * The face is loaded and discarded: it is only needed while the glyphs are drawn, and leaving it registered
 * would let a second import of the same file quietly reuse the first one's pixels.
 */
export async function rasteriseFont(
    bytes: Uint8Array,
    name: string,
    pixelSize: number,
): Promise<RasterResult> {
    let face: FontFace;
    try {
        face = new FontFace(name, bytes.buffer as ArrayBuffer);
        await face.load();
    } catch (error) {
        return { error: `the browser could not read this font (${String(error)}).` };
    }
    document.fonts.add(face);
    try {
        return rasteriseCell(canvases, name, pixelSize);
    } finally {
        document.fonts.delete(face);
    }
}
