/**
 * The pictures the canvas can draw, keyed by the path the design names them by.
 *
 * The panel receives each file from the extension as a data URL and decodes it with the browser's own decoder —
 * there is no image parser anywhere in this codebase, which is the point: a `no_std` firmware loader and a
 * browser both read BMP/PNG/JPEG/GIF/WebP, and only one of those two is worth writing.
 *
 * A module-level map rather than state threaded through the canvas: `drawWidget` is a pure painter that takes a
 * widget and a palette, and every caller of it wants the same answer to "do we have pixels for this path?".
 */

const bitmaps = new Map<string, CanvasImageSource>();

/** The decoded picture for an asset path, or `undefined` when it has not arrived (or could not be decoded). */
export function bitmapFor(src: string): CanvasImageSource | undefined {
    return bitmaps.get(src);
}

/** Records a decoded picture. The canvas is redrawn by whoever decoded it. */
export function setBitmap(src: string, bitmap: CanvasImageSource): void {
    bitmaps.set(src, bitmap);
}

/** Drops everything, for a panel that is being handed a new project. */
export function clearBitmaps(): void {
    bitmaps.clear();
}
