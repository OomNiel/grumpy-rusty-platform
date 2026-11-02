/**
 * A composite icon on the canvas: its parts, thresholded, tinted and scaled the way the board draws them.
 *
 * An icon is the one widget whose picture is not one file: it is a list of parts, each with its own asset, its
 * own offset and optionally its own tint, composited into a glyph. The canvas drew it as a widget face -- a grey
 * box with its name on it -- which is the one thing an icon is never. The board (and the C++ generator) turn
 * each part into ink above a brightness threshold and paint that ink in the tint, so this does the same, in the
 * browser, with the pixels the panel already decoded for the canvas.
 *
 * THE CACHE IS THE POINT. Painting an icon means `getImageData`/`putImageData` over every pixel of every part,
 * and the canvas redraws on every mouse move of a drag. So the *processed* part -- after threshold, tint and
 * scale -- is cached against the settings that produced it, and a redraw is one `drawImage` per part.
 */

import type { DesignerIconPart, DesignerWidget } from '../../src/designer/model';
import { bitmapFor } from './bitmaps';

/** A processed part, ready to blit. */
const processed = new Map<string, HTMLCanvasElement>();

/** Drops the cache, for a panel that is being handed a new project. */
export function clearIconCache(): void {
    processed.clear();
}

/** The decoded size of a bitmap, whichever kind of source the browser handed back. */
function bitmapSize(bitmap: CanvasImageSource): { width: number; height: number } {
    const size = bitmap as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number };
    return {
        width: size.width ?? size.naturalWidth ?? 0,
        height: size.height ?? size.naturalHeight ?? 0,
    };
}

/** `#rrggbb` (with or without the `#`) as three channels; `undefined` when the design left it blank. */
function colourOf(value: unknown): { r: number; g: number; b: number } | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
    if (match === null) {
        return undefined;
    }
    const packed = parseInt(match[1] ?? '0', 16);
    return { r: (packed >> 16) & 0xff, g: (packed >> 8) & 0xff, b: packed & 0xff };
}

/** A number from a design, which a hand-edited file may have written as anything. */
function numberOf(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * One part as ink: the pixels above the threshold painted in the tint, everything else transparent.
 *
 * The rule is the crate's and the generator's: brightness is the brightest channel, a pixel at or above the
 * threshold is ink, `invert` swaps which side of the line counts, a pixel that is already transparent is never
 * ink (otherwise a rounded glyph's corners come out as square ink), and `scale` is nearest-neighbour so pixel art
 * stays crisp. No tint leaves the file's own colour on the ink.
 */
function inkPart(
    bitmap: CanvasImageSource,
    tint: { r: number; g: number; b: number } | undefined,
    threshold: number,
    invert: boolean,
    scale: number,
): HTMLCanvasElement | undefined {
    const size = bitmapSize(bitmap);
    if (size.width <= 0 || size.height <= 0) {
        return undefined;
    }
    const source = document.createElement('canvas');
    source.width = size.width;
    source.height = size.height;
    const sourceContext = source.getContext('2d', { willReadFrequently: true });
    if (sourceContext === null) {
        return undefined;
    }
    sourceContext.drawImage(bitmap, 0, 0);
    const data = sourceContext.getImageData(0, 0, size.width, size.height);
    const pixels = data.data;
    for (let index = 0; index < pixels.length; index += 4) {
        const r = pixels[index] ?? 0;
        const g = pixels[index + 1] ?? 0;
        const b = pixels[index + 2] ?? 0;
        const alpha = pixels[index + 3] ?? 255;
        const brightness = Math.max(r, g, b);
        const ink = alpha === 0 ? false : brightness >= threshold !== invert;
        if (!ink) {
            pixels[index + 3] = 0;
            continue;
        }
        pixels[index] = tint?.r ?? r;
        pixels[index + 1] = tint?.g ?? g;
        pixels[index + 2] = tint?.b ?? b;
        pixels[index + 3] = 255;
    }
    sourceContext.putImageData(data, 0, 0);
    if (scale === 1) {
        return source;
    }
    const scaled = document.createElement('canvas');
    scaled.width = size.width * scale;
    scaled.height = size.height * scale;
    const scaledContext = scaled.getContext('2d');
    if (scaledContext === null) {
        return source;
    }
    scaledContext.imageSmoothingEnabled = false;
    scaledContext.drawImage(source, 0, 0, scaled.width, scaled.height);
    return scaled;
}

/** The parts of an icon, whatever the design's children happen to hold. */
function partsOf(widget: DesignerWidget): DesignerIconPart[] {
    return widget.children?.kind === 'parts' ? widget.children.parts : [];
}

/**
 * Paints an icon's parts inside its cell. Answers whether it drew anything, so the caller knows whether to fall
 * back to a face; a widget whose assets have not arrived is a placeholder, not a blank.
 *
 * The composition is the size its parts add up to, and `align` places that box in the cell -- `top_left` at the
 * cell's own corner, anything else centred -- exactly as the crate's `IconAlign` does on the board.
 */
export function paintIcon(context: CanvasRenderingContext2D, widget: DesignerWidget): boolean {
    const parts = partsOf(widget).filter((part) => part.visible !== false);
    if (parts.length === 0) {
        return false;
    }
    const scale = Math.max(1, Math.round(numberOf(widget.props.scale, 1)));
    const threshold = Math.min(255, Math.max(0, Math.round(numberOf(widget.props.threshold, 128))));
    const invert = widget.props.invert === true;
    const widgetTint = colourOf(widget.props.tint);
    const prepared: { part: DesignerIconPart; canvas: HTMLCanvasElement }[] = [];
    let width = 0;
    let height = 0;
    for (const part of parts) {
        if (typeof part.src !== 'string' || part.src === '') {
            continue;
        }
        const bitmap = bitmapFor(part.src);
        if (bitmap === undefined) {
            continue;
        }
        const tint = colourOf(part.tint) ?? widgetTint;
        const key = [
            part.src,
            tint === undefined ? '-' : `${tint.r},${tint.g},${tint.b}`,
            threshold,
            invert ? 'i' : 'n',
            scale,
        ].join('|');
        let canvas = processed.get(key);
        if (canvas === undefined) {
            const made = inkPart(bitmap, tint, threshold, invert, scale);
            if (made === undefined) {
                continue;
            }
            processed.set(key, made);
            canvas = made;
        }
        prepared.push({ part, canvas });
        width = Math.max(width, Math.round(numberOf(part.x, 0)) + canvas.width);
        height = Math.max(height, Math.round(numberOf(part.y, 0)) + canvas.height);
    }
    if (prepared.length === 0) {
        return false;
    }
    const aligned = widget.props.align === 'top_left';
    const originX = aligned ? widget.x : widget.x + Math.floor((widget.width - width) / 2);
    const originY = aligned ? widget.y : widget.y + Math.floor((widget.height - height) / 2);
    for (const { part, canvas } of prepared) {
        context.drawImage(
            canvas,
            originX + Math.round(numberOf(part.x, 0)),
            originY + Math.round(numberOf(part.y, 0)),
        );
    }
    return true;
}
