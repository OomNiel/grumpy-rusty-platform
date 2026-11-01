/**
 * The pictures a design names, as LVGL can draw them.
 *
 * On the Rust side an asset path is a path: `embedded-gui`'s macros resolve the file at compile time and the
 * crate decodes it at run time. LVGL has no such decode step -- an `lv_image_dsc_t` is a colour format, a size
 * and a block of pixels -- so the work moves to the *generator*: the file is read here, decoded here, and the
 * pixels are emitted into `ui.cpp` as a `const` array. That is also why the canvas can send the same files to
 * the webview for the browser to decode: one set of bytes, two decoders, and no image library in the extension.
 *
 * Only what a panel designer actually uses is decoded. BMP covers the pixel-art and icon files the Asset picker
 * hands out, and PNG covers everything exported from a drawing tool; a JPEG or a GIF is *named in a problem*
 * rather than silently drawn as an empty box, because "convert it to PNG" is an answer and a blank rectangle is
 * not. The decoders are small on purpose -- no RLE, no interlacing, no CMYK -- and each refusal says which
 * feature it could not read.
 */

import { inflateSync } from 'node:zlib';

import type { DesignerDocument, DesignerWidget } from './model';

/** A decoded picture: RGBA, four bytes per pixel, top row first, no padding. */
export interface RasterImage {
    width: number;
    height: number;
    rgba: Uint8Array;
}

export type DecodeResult = { ok: true; image: RasterImage } | { ok: false; reason: string };

/**
 * A picture ready to be written into `ui.cpp`: which colour format the pixels are in, how wide a row is, and
 * the bytes themselves.
 *
 * Converted once, here, rather than at each of the two places the emitter needs the numbers -- an image is
 * parsed into bytes exactly once whether the design holds one of them or twenty.
 */
export interface CppImage {
    format: 'LV_COLOR_FORMAT_RGB565' | 'LV_COLOR_FORMAT_RGB565A8';
    width: number;
    height: number;
    stride: number;
    bytes: Uint8Array;
}

/** What a widget's picture turned out to be. */
export interface CppImageSlot {
    /** The pixels, when the file could be decoded. */
    image?: CppImage;
    /** Why there are none: the reason, said in a way that names what the person has to change. */
    note?: string;
}

/** The slots for a design, keyed by widget id. */
export type CppImageSlots = ReadonlyMap<string, CppImageSlot>;

/**
 * Every picture a design needs, decoded, plus the reasons the ones that are not there are not there.
 *
 * Keyed by widget id rather than by file path because an icon composites several files into one picture, and
 * because the emitter names its C symbols after the widget. A missing file is not an error here: the emitter
 * draws the widget's box and the problem list says why, which is what the save gate shows.
 */
export function buildCppImages(
    document: DesignerDocument,
    read: (relative: string) => Uint8Array | undefined,
): { slots: CppImageSlots; problems: string[] } {
    const slots = new Map<string, CppImageSlot>();
    const problems: string[] = [];
    const fail = (widget: DesignerWidget, reason: string): void => {
        slots.set(widget.id, { note: reason });
        problems.push(`"${widget.id}": ${reason}`);
    };

    for (const widget of document.widgets) {
        if (widget.tag === 'image') {
            const source = widget.props.src;
            if (typeof source !== 'string' || source === '') {
                fail(widget, 'no asset is chosen');
                continue;
            }
            if (source.startsWith('sd:')) {
                fail(widget, `"${source}" lives on the SD card, which the C++ backend cannot read yet`);
                continue;
            }
            const decoded = decodeAssetFile(source, read);
            if (decoded.ok) {
                slots.set(widget.id, { image: prepared(decoded.image) });
            } else {
                fail(widget, decoded.reason);
            }
            continue;
        }
        if (widget.tag === 'icon') {
            const parts = widget.children?.kind === 'parts' ? widget.children.parts : [];
            const composed = composeIcon(widget, parts, read);
            if (composed.ok) {
                slots.set(widget.id, { image: prepared(composed.image) });
            } else {
                fail(widget, composed.reason);
            }
        }
    }
    return { slots, problems };
}

/** A decoded picture in the form the emitter writes out. */
function prepared(image: RasterImage): CppImage {
    const pixels = toLvglPixels(image);
    return { format: pixels.format, width: image.width, height: image.height, stride: pixels.stride, bytes: pixels.bytes };
}

/** Reads one asset and decodes it, turning every failure into a sentence that names the file. */
function decodeAssetFile(src: string, read: (relative: string) => Uint8Array | undefined): DecodeResult {
    const bytes = read(src);
    if (bytes === undefined || bytes.byteLength === 0) {
        return { ok: false, reason: `"${src}" is not in the project` };
    }
    const decoded = decodeAsset(bytes, src);
    if (!decoded.ok) {
        return { ok: false, reason: `"${src}": ${decoded.reason}` };
    }
    return decoded;
}

/**
 * An icon's parts, composited into one picture the way the crate draws them.
 *
 * The crate builds a multi-part glyph out of 1-bit masks: a pixel counts as ink when it is at least as bright as
 * `threshold`, `invert` swaps which side of that line is ink, `tint` paints the ink, everything else is paper
 * and stays transparent, and `scale` is a nearest-neighbour upscale that keeps pixel art crisp. Doing it here
 * rather than with LVGL's own recolour keeps the look identical to the Rust option and costs no run-time work.
 */
function composeIcon(
    widget: DesignerWidget,
    parts: readonly { src: string; x: number; y: number; visible: boolean; tint: string }[],
    read: (relative: string) => Uint8Array | undefined,
): DecodeResult {
    const visible = parts.filter((part) => part.visible !== false);
    if (visible.length === 0) {
        return { ok: false, reason: 'a composite icon needs at least one visible part' };
    }
    const scale = Math.max(1, Math.round(numberOf(widget.props.scale, 1)));
    const threshold = Math.min(255, Math.max(0, Math.round(numberOf(widget.props.threshold, 128))));
    const invert = widget.props.invert === true;
    const tint = typeof widget.props.tint === 'string' ? widget.props.tint : '';

    const decoded: { part: (typeof visible)[number]; image: RasterImage }[] = [];
    for (const part of visible) {
        if (typeof part.src !== 'string' || part.src === '') {
            return { ok: false, reason: 'a part has no asset' };
        }
        if (part.src.startsWith('sd:')) {
            return { ok: false, reason: `"${part.src}" lives on the SD card, which the C++ backend cannot read yet` };
        }
        const result = decodeAssetFile(part.src, read);
        if (!result.ok) {
            return result;
        }
        decoded.push({ part, image: result.image });
    }

    // The natural size is the bounding box of the parts as they would sit at their offsets; `align` then places
    // that box inside the widget on the board, exactly as the crate's `IconAlign` does.
    let width = 0;
    let height = 0;
    for (const { part, image } of decoded) {
        width = Math.max(width, Math.round(numberOf(part.x, 0)) + image.width * scale);
        height = Math.max(height, Math.round(numberOf(part.y, 0)) + image.height * scale);
    }
    if (width <= 0 || height <= 0) {
        return { ok: false, reason: 'the parts have no pixels' };
    }

    const rgba = new Uint8Array(width * height * 4);
    for (const { part, image } of decoded) {
        const colour = colourOf(part.tint) ?? colourOf(tint);
        const left = Math.round(numberOf(part.x, 0));
        const top = Math.round(numberOf(part.y, 0));
        for (let y = 0; y < image.height; y += 1) {
            for (let x = 0; x < image.width; x += 1) {
                const index = (y * image.width + x) * 4;
                const r = image.rgba[index] ?? 0;
                const g = image.rgba[index + 1] ?? 0;
                const b = image.rgba[index + 2] ?? 0;
                const alpha = image.rgba[index + 3] ?? 255;
                // A source pixel that is already transparent is not ink, whatever its colour says: otherwise a
                // rounded glyph's corners would come out as square black ink.
                const brightness = Math.max(r, g, b);
                const ink = alpha === 0 ? false : brightness >= threshold !== invert;
                if (!ink) {
                    continue;
                }
                for (let sy = 0; sy < scale; sy += 1) {
                    for (let sx = 0; sx < scale; sx += 1) {
                        const px = left + x * scale + sx;
                        const py = top + y * scale + sy;
                        if (px >= width || py >= height) {
                            continue;
                        }
                        const out = (py * width + px) * 4;
                        rgba[out] = colour?.r ?? r;
                        rgba[out + 1] = colour?.g ?? g;
                        rgba[out + 2] = colour?.b ?? b;
                        rgba[out + 3] = 255;
                    }
                }
            }
        }
    }
    return { ok: true, image: { width, height, rgba } };
}

/** `#rrggbb` as three channels, or `undefined` when the design left the colour blank. */
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

/** A numeric property, which a hand-edited design may have written as anything. */
function numberOf(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * A file's bytes as pixels, picked by its extension.
 *
 * The extension is used rather than a magic-number sniff because the design already spells the path, and the
 * message a person reads should say the file they chose rather than a format they never picked.
 */
export function decodeAsset(bytes: Uint8Array, src: string): DecodeResult {
    const dot = src.lastIndexOf('.');
    const extension = dot === -1 ? '' : src.slice(dot + 1).toLowerCase();
    switch (extension) {
        case 'bmp':
            return decodeBmp(bytes);
        case 'png':
            return decodePng(bytes);
        case 'jpg':
        case 'jpeg':
            return { ok: false, reason: 'JPEG cannot be decoded at build time; save it as PNG or BMP' };
        case 'gif':
            return { ok: false, reason: 'GIF cannot be decoded at build time; save it as PNG or BMP' };
        case 'webp':
            return { ok: false, reason: 'WebP cannot be decoded at build time; save it as PNG or BMP' };
        default:
            return { ok: false, reason: 'not a picture this generator reads; use PNG or BMP' };
    }
}

/** Little-endian `u16` at `offset`, or 0 past the end. */
function u16(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

/** Little-endian `u32` at `offset`, or 0 past the end. */
function u32(bytes: Uint8Array, offset: number): number {
    return (
        ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16)) +
        (bytes[offset + 3] ?? 0) * 0x1000000
    );
}

/** Signed 32-bit, little-endian. */
function i32(bytes: Uint8Array, offset: number): number {
    const value = u32(bytes, offset);
    return value >= 0x80000000 ? value - 0x100000000 : value;
}

/** Big-endian `u32`, which is the byte order a PNG chunk uses. */
function u32be(bytes: Uint8Array, offset: number): number {
    return (
        (bytes[offset] ?? 0) * 0x1000000 +
        (((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0))
    );
}

/**
 * A Windows bitmap, which is what the Asset picker's hand-made icons are.
 *
 * Palette depths (1, 4 and 8 bits) are supported because pixel art is usually saved that way, and 24/32-bit
 * because a screenshot is. Bottom-up rows are the normal case and top-down (`height < 0`) is allowed; RLE is
 * refused by name rather than decoded half-way.
 */
export function decodeBmp(bytes: Uint8Array): DecodeResult {
    if (bytes.byteLength < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
        return { ok: false, reason: 'not a BMP file' };
    }
    const dataOffset = u32(bytes, 10);
    const headerSize = u32(bytes, 14);
    const width = i32(bytes, 18);
    const rawHeight = i32(bytes, 22);
    const bitsPerPixel = u16(bytes, 28);
    const compression = u32(bytes, 30);
    if (width <= 0 || rawHeight === 0) {
        return { ok: false, reason: 'the BMP has no pixels' };
    }
    if (compression !== 0 && compression !== 3) {
        return {
            ok: false,
            reason: `compressed BMP (mode ${compression}) cannot be decoded; save it as a plain 24-bit BMP`,
        };
    }
    const height = Math.abs(rawHeight);
    const topDown = rawHeight < 0;
    if (width * height > 4096 * 4096) {
        return { ok: false, reason: 'the BMP is larger than any panel this project targets' };
    }

    // The palette, when there is one. `biClrUsed` of zero means "as many as the depth allows".
    const palette: { r: number; g: number; b: number; a: number }[] = [];
    if (bitsPerPixel <= 8) {
        const declared = u32(bytes, 46);
        const count = declared === 0 ? 1 << bitsPerPixel : declared;
        const start = 14 + headerSize;
        for (let index = 0; index < count; index += 1) {
            const at = start + index * 4;
            palette.push({
                b: bytes[at] ?? 0,
                g: bytes[at + 1] ?? 0,
                r: bytes[at + 2] ?? 0,
                a: 255,
            });
        }
    }
    // Bit masks live after a 40-byte header on a BITFIELDS bitmap; a 16-bit BI_RGB one is 5-5-5.
    let maskR = 0x7c00;
    let maskG = 0x03e0;
    let maskB = 0x001f;
    let maskA = 0;
    if (compression === 3) {
        const start = 14 + headerSize;
        if (bitsPerPixel === 16) {
            maskR = u32(bytes, start);
            maskG = u32(bytes, start + 4);
            maskB = u32(bytes, start + 8);
        } else if (bitsPerPixel === 32) {
            maskR = u32(bytes, start);
            maskG = u32(bytes, start + 4);
            maskB = u32(bytes, start + 8);
            maskA = u32(bytes, start + 12);
        }
    } else if (bitsPerPixel === 32) {
        // BI_RGB 32-bit is BGRA with the fourth byte unused by most writers.
        maskR = 0x00ff0000;
        maskG = 0x0000ff00;
        maskB = 0x000000ff;
        maskA = 0xff000000;
    }

    const rgba = new Uint8Array(width * height * 4);
    const stride = Math.floor((bitsPerPixel * width + 31) / 32) * 4;
    let sawAlpha = false;
    for (let row = 0; row < height; row += 1) {
        const source = dataOffset + (topDown ? row : height - 1 - row) * stride;
        if (source + stride > bytes.byteLength) {
            return { ok: false, reason: 'the BMP is truncated' };
        }
        for (let x = 0; x < width; x += 1) {
            const out = (row * width + x) * 4;
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 255;
            if (bitsPerPixel === 1 || bitsPerPixel === 4 || bitsPerPixel === 8) {
                const bit = x * bitsPerPixel;
                const byte = bytes[source + (bit >> 3)] ?? 0;
                const shift = 8 - bitsPerPixel - (bit & 7);
                const index = (byte >> shift) & ((1 << bitsPerPixel) - 1);
                const entry = palette[index];
                if (entry === undefined) {
                    return { ok: false, reason: 'the BMP palette is shorter than its pixels' };
                }
                r = entry.r;
                g = entry.g;
                b = entry.b;
            } else if (bitsPerPixel === 16) {
                const value = u16(bytes, source + x * 2);
                r = channelOf(value, maskR);
                g = channelOf(value, maskG);
                b = channelOf(value, maskB);
            } else if (bitsPerPixel === 24) {
                const at = source + x * 3;
                b = bytes[at] ?? 0;
                g = bytes[at + 1] ?? 0;
                r = bytes[at + 2] ?? 0;
            } else if (bitsPerPixel === 32) {
                const value = u32(bytes, source + x * 4);
                r = channelOf(value, maskR);
                g = channelOf(value, maskG);
                b = channelOf(value, maskB);
                a = maskA === 0 ? 255 : channelOf(value, maskA);
                sawAlpha ||= a !== 255;
            } else {
                return { ok: false, reason: `a ${bitsPerPixel}-bit BMP cannot be decoded` };
            }
            rgba[out] = r;
            rgba[out + 1] = g;
            rgba[out + 2] = b;
            rgba[out + 3] = a;
        }
    }
    if (maskA !== 0 && !sawAlpha) {
        // Every alpha byte was zero: the writer meant "unused", not "invisible".
        for (let index = 3; index < rgba.length; index += 4) {
            rgba[index] = 255;
        }
    }
    return { ok: true, image: { width, height, rgba } };
}

/** One channel of a masked 16/32-bit pixel, scaled to 0..255 from whatever width the mask has. */
function channelOf(value: number, mask: number): number {
    if (mask === 0) {
        return 0;
    }
    let shift = 0;
    while (((mask >> shift) & 1) === 0) {
        shift += 1;
    }
    const bits = ((mask >>> shift) + 1).toString(2).length - 1;
    const raw = (value & mask) >>> shift;
    const max = (1 << bits) - 1;
    return max === 0 ? 0 : Math.round((raw * 255) / max);
}

/**
 * A PNG, which is what everything exported from a drawing tool is.
 *
 * The unfiltering and the colour-type switch are the whole format; the compression is the one thing handed to
 * Node's own `zlib`, since a deflate implementation written here would be a second thing to get wrong. Palette,
 * greyscale and truecolour (with and without alpha) are read at every bit depth, and 16-bit samples keep their
 * high byte. Interlacing is refused by name: Adam7 needs a second pass over the whole decoder for a feature no
 * designer export uses.
 */
export function decodePng(bytes: Uint8Array): DecodeResult {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.byteLength < 8 || signature.some((value, index) => bytes[index] !== value)) {
        return { ok: false, reason: 'not a PNG file' };
    }
    let width = 0;
    let height = 0;
    let depth = 8;
    let colourType = 6;
    let palette: { r: number; g: number; b: number; a: number }[] = [];
    let transparentGrey: number | undefined;
    let transparentRgb: { r: number; g: number; b: number } | undefined;
    const data: number[] = [];
    let offset = 8;
    let sawHeader = false;
    while (offset + 8 <= bytes.byteLength) {
        const length = u32be(bytes, offset);
        const type = String.fromCharCode(
            bytes[offset + 4] ?? 0,
            bytes[offset + 5] ?? 0,
            bytes[offset + 6] ?? 0,
            bytes[offset + 7] ?? 0,
        );
        const start = offset + 8;
        if (start + length > bytes.byteLength) {
            return { ok: false, reason: 'the PNG is truncated' };
        }
        if (type === 'IHDR') {
            width = u32be(bytes, start);
            height = u32be(bytes, start + 4);
            depth = bytes[start + 8] ?? 8;
            colourType = bytes[start + 9] ?? 6;
            const interlace = bytes[start + 12] ?? 0;
            if (interlace !== 0) {
                return { ok: false, reason: 'an interlaced PNG cannot be decoded; re-save it without interlacing' };
            }
            sawHeader = true;
        } else if (type === 'PLTE') {
            palette = [];
            for (let index = 0; index + 2 < length; index += 3) {
                palette.push({
                    r: bytes[start + index] ?? 0,
                    g: bytes[start + index + 1] ?? 0,
                    b: bytes[start + index + 2] ?? 0,
                    a: 255,
                });
            }
        } else if (type === 'tRNS') {
            if (colourType === 3) {
                for (let index = 0; index < length; index += 1) {
                    const entry = palette[index];
                    if (entry !== undefined) {
                        entry.a = bytes[start + index] ?? 255;
                    }
                }
            } else if (colourType === 0) {
                transparentGrey = (bytes[start] ?? 0) * (depth === 16 ? 256 : 1) + (depth === 16 ? (bytes[start + 1] ?? 0) : 0);
            } else if (colourType === 2) {
                const step = depth === 16 ? 2 : 1;
                transparentRgb = {
                    r: (bytes[start] ?? 0) * step,
                    g: (bytes[start + step] ?? 0) * step,
                    b: (bytes[start + step * 2] ?? 0) * step,
                };
            }
        } else if (type === 'IDAT') {
            for (let index = 0; index < length; index += 1) {
                data.push(bytes[start + index] ?? 0);
            }
        } else if (type === 'IEND') {
            break;
        }
        offset = start + length + 4;
    }
    if (!sawHeader || width <= 0 || height <= 0) {
        return { ok: false, reason: 'the PNG has no header' };
    }
    let raw: Uint8Array;
    try {
        raw = new Uint8Array(inflateSync(Uint8Array.from(data)));
    } catch {
        return { ok: false, reason: 'the PNG data could not be decompressed' };
    }

    const channels = colourType === 0 ? 1 : colourType === 2 ? 3 : colourType === 3 ? 1 : colourType === 4 ? 2 : 4;
    const bitsPerPixel = channels * depth;
    const step = Math.max(1, bitsPerPixel >> 3);
    const rowBytes = Math.ceil((bitsPerPixel * width) / 8);
    if (raw.byteLength < (rowBytes + 1) * height) {
        return { ok: false, reason: 'the PNG data is shorter than its header says' };
    }

    // Undo the per-row filter, in place, in the buffer the deflate produced.
    const pixels = new Uint8Array(rowBytes * height);
    for (let row = 0; row < height; row += 1) {
        const filter = raw[row * (rowBytes + 1)] ?? 0;
        const from = row * (rowBytes + 1) + 1;
        const to = row * rowBytes;
        for (let index = 0; index < rowBytes; index += 1) {
            const value = raw[from + index] ?? 0;
            const left = index >= step ? (pixels[to + index - step] ?? 0) : 0;
            const up = row > 0 ? (pixels[to - rowBytes + index] ?? 0) : 0;
            const upLeft = row > 0 && index >= step ? (pixels[to - rowBytes + index - step] ?? 0) : 0;
            let restored: number;
            switch (filter) {
                case 0:
                    restored = value;
                    break;
                case 1:
                    restored = value + left;
                    break;
                case 2:
                    restored = value + up;
                    break;
                case 3:
                    restored = value + ((left + up) >> 1);
                    break;
                case 4:
                    restored = value + paeth(left, up, upLeft);
                    break;
                default:
                    return { ok: false, reason: `the PNG uses filter ${filter}, which is not in the format` };
            }
            pixels[to + index] = restored & 0xff;
        }
    }

    /** One sample of a row, at its own bit depth, scaled to 0..255. */
    const sample = (row: number, index: number): number => {
        const base = row * rowBytes;
        if (depth === 8) {
            return pixels[base + index] ?? 0;
        }
        if (depth === 16) {
            // The high byte is the 8-bit value: a panel with 16 bits per channel would round it the same way.
            return pixels[base + index * 2] ?? 0;
        }
        const bit = index * depth;
        const byte = pixels[base + (bit >> 3)] ?? 0;
        const shift = 8 - depth - (bit & 7);
        return Math.round(((byte >> shift) & ((1 << depth) - 1)) * (255 / ((1 << depth) - 1)));
    };

    const rgba = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row += 1) {
        for (let x = 0; x < width; x += 1) {
            const out = (row * width + x) * 4;
            if (colourType === 3) {
                const index = depth === 8 ? (pixels[row * rowBytes + x] ?? 0) : sample(row, x);
                const entry = palette[depth === 8 ? index : Math.round((index * (palette.length - 1)) / 255)];
                rgba[out] = entry?.r ?? 0;
                rgba[out + 1] = entry?.g ?? 0;
                rgba[out + 2] = entry?.b ?? 0;
                rgba[out + 3] = entry?.a ?? 255;
                continue;
            }
            if (colourType === 0 || colourType === 4) {
                const grey = sample(row, x * channels);
                const alpha = colourType === 4 ? sample(row, x * channels + 1) : 255;
                const transparent = transparentGrey !== undefined && grey === (transparentGrey >> 8 || transparentGrey);
                rgba[out] = grey;
                rgba[out + 1] = grey;
                rgba[out + 2] = grey;
                rgba[out + 3] = transparent ? 0 : alpha;
                continue;
            }
            const r = sample(row, x * channels);
            const g = sample(row, x * channels + 1);
            const b = sample(row, x * channels + 2);
            const alpha = channels === 4 ? sample(row, x * channels + 3) : 255;
            const transparent =
                transparentRgb !== undefined && r === transparentRgb.r && g === transparentRgb.g && b === transparentRgb.b;
            rgba[out] = r;
            rgba[out + 1] = g;
            rgba[out + 2] = b;
            rgba[out + 3] = transparent ? 0 : alpha;
        }
    }
    return { ok: true, image: { width, height, rgba } };
}

/** The Paeth predictor, which is the fourth PNG filter and the only non-obvious one. */
function paeth(left: number, up: number, upLeft: number): number {
    const estimate = left + up - upLeft;
    const distanceLeft = Math.abs(estimate - left);
    const distanceUp = Math.abs(estimate - up);
    const distanceUpLeft = Math.abs(estimate - upLeft);
    if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) {
        return left;
    }
    return distanceUp <= distanceUpLeft ? up : upLeft;
}

/** Whether every pixel is fully opaque, which decides between RGB565 and RGB565A8. */
export function isOpaque(image: RasterImage): boolean {
    for (let index = 3; index < image.rgba.length; index += 4) {
        if (image.rgba[index] !== 255) {
            return false;
        }
    }
    return true;
}

/**
 * The pixels as LVGL stores them: RGB565 when the picture is opaque, RGB565A8 when it has transparency.
 *
 * RGB565A8 is the colour plane followed by one 8-bit alpha plane, which is why the stride stays two bytes per
 * pixel and the size is three. Transparency costs a third more flash than a plain copy and is the only way a
 * rounded icon does not come out with a black border on the panel.
 */
export function toLvglPixels(image: RasterImage): {
    format: 'LV_COLOR_FORMAT_RGB565' | 'LV_COLOR_FORMAT_RGB565A8';
    stride: number;
    bytes: Uint8Array;
} {
    const opaque = isOpaque(image);
    const count = image.width * image.height;
    const bytes = new Uint8Array(count * (opaque ? 2 : 3));
    for (let index = 0; index < count; index += 1) {
        const r = image.rgba[index * 4] ?? 0;
        const g = image.rgba[index * 4 + 1] ?? 0;
        const b = image.rgba[index * 4 + 2] ?? 0;
        const value = ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
        bytes[index * 2] = value & 0xff;
        bytes[index * 2 + 1] = (value >> 8) & 0xff;
    }
    if (!opaque) {
        const alphaBase = count * 2;
        for (let index = 0; index < count; index += 1) {
            bytes[alphaBase + index] = image.rgba[index * 4 + 3] ?? 255;
        }
    }
    return {
        format: opaque ? 'LV_COLOR_FORMAT_RGB565' : 'LV_COLOR_FORMAT_RGB565A8',
        stride: image.width * 2,
        bytes,
    };
}

/**
 * The pixels as a C string literal, sixteen bytes a line.
 *
 * Every byte is its own `\xNN` escape, which is what keeps a following hex digit from being swallowed into the
 * previous escape -- `"\x12a"` is one byte, `"\x12\x61"` is two. LVGL's own image converter writes files like
 * this, so a person who has seen one recognises it.
 */
export function pixelLines(bytes: Uint8Array, indent = ''): string[] {
    const lines: string[] = [];
    const perLine = 16;
    for (let offset = 0; offset < bytes.length; offset += perLine) {
        let text = '';
        for (let index = offset; index < Math.min(offset + perLine, bytes.length); index += 1) {
            text += `\\x${(bytes[index] ?? 0).toString(16).padStart(2, '0')}`;
        }
        lines.push(`${indent}"${text}"`);
    }
    return lines;
}
