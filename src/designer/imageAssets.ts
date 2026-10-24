/**
 * The image files a design refers to, carried to the designer's canvas.
 *
 * The canvas runs in a webview, which cannot read the project's files, and the panel used to draw an image widget
 * as an empty box -- the same box every other widget gets, in a colour that reads as "nothing here" (reported
 * 2026-10-24, an image on a view of its own made that view look blank). So the extension reads the file and sends
 * the bytes; the *browser* decodes them.
 *
 * Decoding in the browser is the whole trick: BMP, PNG, JPEG, GIF and WebP all arrive as a data URL and the
 * webview's own decoder draws them, so there is no image parser here to get wrong, and no third-party dependency
 * in a `no_std`-shaped codebase.
 *
 * Two kinds are deliberately left out. An `sd:` image lives on a card the canvas cannot read -- the widget says
 * so, and the board reads the file. A file larger than the cap is skipped rather than shipped through a message,
 * for the same reason a 4 MB photo would make every save slow: the canvas is a preview, and the note says why.
 */

import type { DesignerDocument } from './model';

/** How much of one file is worth a round trip to the panel. Beyond this the widget says it is too large. */
export const MAX_CANVAS_IMAGE_BYTES = 1536 * 1024;

export interface DesignerImageAsset {
    /** The path exactly as the design names it, e.g. `assets/logo.bmp`: the canvas keys its bitmaps by this. */
    src: string;
    /** What the bytes are, so the browser's decoder is picked correctly. */
    mime: string;
    /** The file, base64. */
    data: string;
}

const MIME_BY_EXTENSION: Record<string, string> = {
    bmp: 'image/bmp',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    tif: 'image/tiff',
    tiff: 'image/tiff',
};

/** The MIME type for an asset path, from its extension; `application/octet-stream` for one we do not know. */
export function mimeFor(src: string): string {
    const dot = src.lastIndexOf('.');
    const extension = dot === -1 ? '' : src.slice(dot + 1).toLowerCase();
    return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/**
 * Every asset path the canvas could draw, in document order and without duplicates.
 *
 * An icon is several images in one widget, so its parts count too; a mesh is geometry rather than pixels and is
 * left out; anything from the SD card is left out (the canvas cannot read a card).
 */
export function imageSourcesOf(document: DesignerDocument): string[] {
    const sources: string[] = [];
    const add = (value: unknown): void => {
        if (typeof value !== 'string' || value === '' || value.startsWith('sd:')) {
            return;
        }
        if (!sources.includes(value)) {
            sources.push(value);
        }
    };
    for (const widget of document.widgets) {
        if (widget.tag === 'image') {
            add(widget.props.src);
        }
        if (widget.children?.kind === 'parts') {
            for (const part of widget.children.parts) {
                add(part.src);
            }
        }
    }
    return sources;
}

/**
 * The bytes for each of those paths, base64 for the panel.
 *
 * `read` is handed the path as the design spells it and answers `undefined` for a file that is not there; a
 * missing asset is already reported in the panel, so it is simply not sent. A file too large to be worth shipping
 * is skipped the same way.
 */
export function collectImageAssets(
    document: DesignerDocument,
    read: (relative: string) => Uint8Array | undefined,
): DesignerImageAsset[] {
    const assets: DesignerImageAsset[] = [];
    for (const src of imageSourcesOf(document)) {
        const bytes = read(src);
        if (bytes === undefined || bytes.byteLength === 0 || bytes.byteLength > MAX_CANVAS_IMAGE_BYTES) {
            continue;
        }
        assets.push({ src, mime: mimeFor(src), data: Buffer.from(bytes).toString('base64') });
    }
    return assets;
}
