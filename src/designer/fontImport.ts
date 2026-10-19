/**
 * Turning a font into a BDF file the project can embed.
 *
 * Two halves, and neither touches `vscode`:
 *
 * - **The rasteriser is the webview's**, because a browser already has one: a `FontFace` built from the
 *   file's bytes, drawn with `fillText` at the size the user asked for. That is the only renderer this
 *   extension has, and it is a far better one than a hand-rolled outline walker would be.
 * - **The file writer is here**, because a webview cannot write one. It emits a plain BDF, which the crate
 *   already parses (`parse_bdf`) and which the designer's canvas already draws -- so an imported font needs
 *   no new code on either side of the glass.
 *
 * The shape in between is deliberately the one `bitmapFont.ts` reads: a fixed cell, glyphs in printable-ASCII
 * order, a row per line with the leftmost column high. `bdfFromRaster` → `parseBdfFont` round-trips to the
 * same pixels, which is what the test holds it to.
 */

/** What the webview measured and drew, before it becomes a file. */
export interface RasterisedFont {
    /** Cell width in pixels -- the widest glyph's ink, placed on a shared origin. */
    width: number;
    /** Cell height in pixels: the tallest ascent plus the deepest descent. */
    height: number;
    /** Rows from the baseline down to the bottom of the cell. */
    descent: number;
    /** Pixels from one character's origin to the next. */
    advance: number;
    /** The size the face was drawn at, for the BDF's `SIZE` and `FONT` fields. */
    pixelSize: number;
    /**
     * One entry per printable ASCII character, space first.
     *
     * Each entry is `height` row numbers with the leftmost column in bit `width - 1` -- the shape the canvas
     * and the crate both already understand.
     */
    glyphs: number[][];
}

/**
 * The name a design will give an imported font: the file's stem, made safe.
 *
 * It has to be a Rust identifier, because the code generator turns it into a constant.
 */
export function fontIdFromFile(file: string, taken: readonly string[] = []): string {
    const stem = file.split(/[\\/]/).pop() ?? file;
    const cleaned = stem.replace(/\.(bdf|ttf|otf)$/i, '').replace(/[^A-Za-z0-9_]/g, '_');
    const base = /^[A-Za-z_]/.test(cleaned) && cleaned !== '' ? cleaned : `font_${cleaned}`;
    let id = base;
    for (let n = 2; taken.includes(id); n += 1) {
        id = `${base}_${n}`;
    }
    return id;
}

/**
 * Whether a file is a bitmap font the crate can read as it is.
 *
 * Anything else -- a TTF, an OTF, a collection -- has to be drawn into a BDF first, so this is the test that
 * decides between "copy it in" and "rasterise it".
 */
export function isBitmapFontFile(file: string): boolean {
    return /\.bdf$/i.test(file);
}

/** A row's bits as hex, padded to whole bytes the way BDF states a row. */
export function hexRow(bits: number, width: number): string {
    const bytes = Math.ceil(width / 8);
    let out = '';
    for (let byte = 0; byte < bytes; byte += 1) {
        let value = 0;
        for (let bit = 0; bit < 8; bit += 1) {
            const col = byte * 8 + bit;
            const set = col < width ? Math.floor(bits / 2 ** (width - 1 - col)) % 2 === 1 : false;
            value = value * 2 + (set ? 1 : 0);
        }
        out += value.toString(16).toUpperCase().padStart(2, '0');
    }
    return out;
}

/**
 * The BDF text for a rasterised face.
 *
 * Every glyph gets the whole cell as its bounding box, so the file states exactly what was rasterised
 * rather than a per-glyph crop that a parser would have to reassemble. SWIDTH is in thousandths of the pixel
 * size, which is what every BDF reader expects even though the crate ignores it.
 */
export function bdfFromRaster(font: RasterisedFont, name: string): string {
    const { width, height, descent, advance, pixelSize } = font;
    if (width <= 0 || height <= 0) {
        throw new Error('a font with no cell cannot be written');
    }
    if (font.glyphs.length !== 95) {
        throw new Error(`a BDF needs all 95 printable characters, got ${font.glyphs.length}`);
    }
    const swidth = Math.round((advance * 1000) / Math.max(1, pixelSize));
    const lines: string[] = [
        'STARTFONT 2.1',
        `FONT -rusty-${name}-medium-r-normal--${pixelSize}-${pixelSize * 10}-75-75-c-${advance * 10}-iso10646-1`,
        'COMMENT Rasterised by Rusty Platform from a system font.',
        `SIZE ${pixelSize} 75 75`,
        `FONTBOUNDINGBOX ${width} ${height} 0 ${-descent}`,
        'STARTPROPERTIES 2',
        `FONT_ASCENT ${height - descent}`,
        `FONT_DESCENT ${descent}`,
        'ENDPROPERTIES',
        'CHARS 95',
    ];
    for (let index = 0; index < 95; index += 1) {
        const code = 32 + index;
        const rows = font.glyphs[index] ?? [];
        lines.push('STARTCHAR char' + code);
        lines.push(`ENCODING ${code}`);
        lines.push(`SWIDTH ${swidth} 0`);
        lines.push(`DWIDTH ${advance} 0`);
        lines.push(`BBX ${width} ${height} 0 ${-descent}`);
        lines.push('BITMAP');
        for (let row = 0; row < height; row += 1) {
            lines.push(hexRow(rows[row] ?? 0, width));
        }
        lines.push('ENDCHAR');
    }
    lines.push('ENDFONT');
    return lines.join('\n') + '\n';
}
