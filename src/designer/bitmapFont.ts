/**
 * A BDF font, in the shape the canvas can draw.
 *
 * The crate reads BDF too -- `parse_bdf` in `embedded-gui-codegen/src/assets.rs` -- and a design's
 * declared font reaches the board as `FontId::Bitmap`. This is that same conversion, in TypeScript and
 * deliberately byte for byte: the cell is sized to the glyphs actually being embedded (not to
 * `FONTBOUNDINGBOX`, which reserves room for accents no digit uses), each glyph is composited into that
 * cell by its own offset from the baseline, and a row is one number with the leftmost column in the
 * high bit. If the two disagreed, the canvas would show a layout the board does not.
 *
 * Nothing here imports `vscode` or `fs`: the editor hands in the file's text and gets pixels back, so
 * the rules can be tested against the crate's own fixtures.
 */

/** One declared font, as the canvas draws it. */
export interface DesignFontPixels {
    /** Columns in the cell. */
    width: number;
    /** Rows in the cell. */
    height: number;
    /** Pixels from one character's origin to the next. */
    advance: number;
    /** Pixels from one line's origin to the next: the cell's own height, as the crate does. */
    lineHeight: number;
    /** The first character the range covers. */
    firstChar: number;
    /** The last character the range covers. */
    lastChar: number;
    /**
     * `(lastChar - firstChar + 1) * height` row numbers, glyph after glyph.
     *
     * A row is `width` bits with the leftmost column in bit `width - 1`. It is a number rather than the
     * crate's bytes because a cell may be wider than eight columns, and the canvas tests bits by
     * dividing rather than shifting.
     */
    rows: number[];
}

export type BdfResult = { font: DesignFontPixels } | { error: string };

interface RawGlyph {
    encoding: number;
    /** Width, height, x offset, y offset from the baseline. */
    bbx: [number, number, number, number];
    dwidth: number;
    /** One number per row: `width` bits, leftmost column high. */
    rows: number[];
}

/** A `hex` row of a BITMAP into bits, as the glyph itself states its width. */
function hexRow(line: string): number[] | undefined {
    const padded = line.length % 2 === 0 ? line : `${line}0`;
    const bits: number[] = [];
    for (let i = 0; i < padded.length; i += 2) {
        const byte = Number.parseInt(padded.slice(i, i + 2), 16);
        if (Number.isNaN(byte)) {
            return undefined;
        }
        for (let bit = 7; bit >= 0; bit -= 1) {
            bits.push((byte >> bit) & 1);
        }
    }
    return bits;
}

function ints(parts: string[], count: number): number[] | undefined {
    const values: number[] = [];
    for (let i = 0; i < count; i += 1) {
        const value = Number.parseInt(parts[i] ?? '', 10);
        if (Number.isNaN(value)) {
            return undefined;
        }
        values.push(value);
    }
    return values;
}

/**
 * Parse a BDF file into a fixed-cell bitmap font.
 *
 * `chars`, when given, restricts what is embedded -- a shot counter needs the digits and nothing else,
 * and the rest is flash. A character not in the subset is not in the result, which is why the range may
 * be narrower than the file's: the crate indexes glyphs by code, so the cell must cover a contiguous
 * run.
 */
export function parseBdfFont(source: string, chars?: string): BdfResult {
    let fontBox: number[] | undefined;
    const glyphs = new Map<number, RawGlyph>();
    let current: RawGlyph | undefined;
    let inBitmap = false;

    for (const raw of source.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === '') {
            continue;
        }
        const parts = line.split(/\s+/);
        const keyword = parts[0] ?? '';

        if (inBitmap) {
            if (keyword === 'ENDCHAR') {
                inBitmap = false;
                if (current !== undefined) {
                    glyphs.set(current.encoding, current);
                    current = undefined;
                }
                continue;
            }
            const bits = hexRow(line);
            if (bits === undefined) {
                return { error: `bad BITMAP row ${line}` };
            }
            current?.rows.push(sumBits(bits, current.bbx[0]));
            continue;
        }

        switch (keyword) {
            case 'FONTBOUNDINGBOX': {
                const values = ints(parts.slice(1), 4);
                if (values === undefined) {
                    return { error: 'malformed FONTBOUNDINGBOX' };
                }
                fontBox = values;
                break;
            }
            case 'STARTCHAR':
                current = { encoding: 0, bbx: [0, 0, 0, 0], dwidth: 0, rows: [] };
                break;
            case 'ENCODING': {
                const code = Number.parseInt(parts[1] ?? '', 10);
                if (current !== undefined && !Number.isNaN(code)) {
                    current.encoding = code;
                }
                break;
            }
            case 'DWIDTH': {
                const width = Number.parseInt(parts[1] ?? '', 10);
                if (current !== undefined && !Number.isNaN(width)) {
                    current.dwidth = width;
                }
                break;
            }
            case 'BBX': {
                const values = ints(parts.slice(1), 4);
                if (values === undefined) {
                    return { error: 'malformed BBX' };
                }
                if (current !== undefined) {
                    current.bbx = [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 0];
                }
                break;
            }
            case 'BITMAP':
                inBitmap = true;
                break;
            default:
                break;
        }
    }

    if (fontBox === undefined) {
        return { error: 'missing FONTBOUNDINGBOX' };
    }
    if ((fontBox[0] ?? 0) <= 0 || (fontBox[1] ?? 0) <= 0) {
        return { error: 'font bounding box has no area' };
    }

    const wanted = chars === undefined ? undefined : new Set([...chars].map((ch) => ch.codePointAt(0) ?? 0));
    const selected = [...glyphs.keys()]
        .filter((code) => code <= 255 && (wanted === undefined || wanted.has(code)))
        .sort((a, b) => a - b);
    if (selected.length === 0) {
        return { error: 'the font has no glyphs in the characters asked for' };
    }

    // The cell is the union of the glyphs being embedded, not FONTBOUNDINGBOX: display fonts reserve
    // room for accents and descenders that a digit never uses.
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.POSITIVE_INFINITY;
    let top = Number.NEGATIVE_INFINITY;
    for (const code of selected) {
        const glyph = glyphs.get(code);
        if (glyph === undefined) {
            continue;
        }
        const [gw, gh, gx, gy] = glyph.bbx;
        left = Math.min(left, gx);
        right = Math.max(right, gx + gw);
        bottom = Math.min(bottom, gy);
        top = Math.max(top, gy + gh);
    }
    const cellWidth = right - left;
    const cellHeight = top - bottom;
    if (cellWidth <= 0 || cellHeight <= 0) {
        return { error: 'the font has no height or width to draw' };
    }

    const firstChar = selected[0] ?? 32;
    const lastChar = selected[selected.length - 1] ?? firstChar;
    const rows: number[] = new Array(cellHeight * (lastChar - firstChar + 1)).fill(0);
    let advance = 0;

    for (const code of selected) {
        const glyph = glyphs.get(code);
        if (glyph === undefined) {
            continue;
        }
        advance = Math.max(advance, glyph.dwidth > 0 ? glyph.dwidth : glyph.bbx[0]);
        const [gw, gh, gx, gy] = glyph.bbx;
        // BDF y offsets are measured up from the baseline; these rows run down from the cell's top.
        const dx = gx - left;
        const dy = top - (gy + gh);
        const base = (code - firstChar) * cellHeight;
        glyph.rows.forEach((bits, rowIndex) => {
            const ty = dy + rowIndex;
            if (ty < 0 || ty >= cellHeight) {
                return;
            }
            for (let col = 0; col < gw; col += 1) {
                const set = Math.floor(bits / 2 ** (gw - 1 - col)) % 2 === 1;
                if (!set) {
                    continue;
                }
                const tx = dx + col;
                if (tx < 0 || tx >= cellWidth) {
                    continue;
                }
                rows[base + ty] = (rows[base + ty] ?? 0) + 2 ** (cellWidth - 1 - tx);
            }
        });
    }

    return {
        font: {
            width: cellWidth,
            height: cellHeight,
            advance: Math.min(255, Math.max(1, advance)),
            lineHeight: cellHeight,
            firstChar,
            lastChar,
            rows,
        },
    };
}

/** A row's set bits as a number, keeping the first `width` columns. */
function sumBits(bits: number[], width: number): number {
    let value = 0;
    for (let col = 0; col < width; col += 1) {
        value = value * 2 + (bits[col] ?? 0);
    }
    return value;
}
