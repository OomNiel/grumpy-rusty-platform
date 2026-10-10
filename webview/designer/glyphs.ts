/**
 * The crate's own glyphs, and its per-font metrics -- GENERATED, DO NOT EDIT.
 *
 * Produced by `node tests/tools/glyph-table.js`, which runs `tests/sim/src/bin/glyphs.rs`: a host binary that
 * reads `embedded_gui::font::glyph_rows` for every printable ASCII character. The canvas draws text from this
 * table so that what it shows is the font the board will use, not one that looks a bit like it.
 *
 * A glyph is five row bytes. In row `r`, bit `1 << (2 - col)` is set when the pixel at column `col`
 * (0 = leftmost of three) is ink -- the walk is `PackedFont::draw_glyph` in the crate's `font.rs`. The fonts
 * differ in `advance` and `lineHeight` (which is what spaces characters and lines), and in almost nothing
 * else: the tables are shared, except that `Medium4x7` spells `*` and `@` differently.
 */

/** The first character code the table covers. */
export const GLYPH_FIRST_CHAR = 32;

/** The last character code the table covers. */
export const GLYPH_LAST_CHAR = 126;

/** How many rows a glyph has. */
export const GLYPH_ROWS = 5;

/** How many columns a glyph has. */
export const GLYPH_COLUMNS = 3;

/** One line of a glyph: three bits, leftmost column in bit 2. */
export interface GlyphMetrics {
    /** Pixels from one character's origin to the next. */
    advance: number;
    /** Pixels from one line's origin to the next. */
    lineHeight: number;
    /** Which of `TABLES` holds this font's glyphs. */
    table: number;
}

/** The crate's default font, and what anything unrecognised falls back to. */
const DEFAULT_FONT: GlyphMetrics = { advance: 4, lineHeight: 6, table: 0 };

/** The fonts the designer offers, by the name the design stores. */
export const GLYPH_FONTS: Record<string, GlyphMetrics> = {
    "Tiny3x5": DEFAULT_FONT,
    "Medium4x7": { advance: 5, lineHeight: 8, table: 1 },
    "Scaled6x10": { advance: 7, lineHeight: 11, table: 0 },
    "Vector(2)": { advance: 16, lineHeight: 24, table: 0 },
    "Vector(3)": { advance: 24, lineHeight: 36, table: 0 },
};

/** Five row bytes per character, from `GLYPH_FIRST_CHAR`, one entry per distinct font table. */
const TABLE_0: readonly number[] = [
    0, 0, 0, 0, 0,
    2, 2, 2, 0, 2,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    5, 1, 2, 4, 5,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    0, 0, 7, 0, 0,
    0, 0, 0, 0, 2,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    2, 6, 2, 2, 7,
    6, 1, 2, 4, 7,
    6, 1, 2, 1, 6,
    5, 5, 7, 1, 1,
    7, 4, 6, 1, 6,
    3, 4, 6, 5, 2,
    7, 1, 2, 2, 2,
    2, 5, 2, 5, 2,
    2, 5, 3, 1, 6,
    0, 2, 0, 2, 0,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    7, 1, 2, 0, 2,
    7, 5, 7, 4, 3,
    2, 5, 7, 5, 5,
    6, 5, 6, 5, 6,
    3, 4, 4, 4, 3,
    6, 5, 5, 5, 6,
    7, 4, 6, 4, 7,
    7, 4, 6, 4, 4,
    3, 4, 5, 5, 3,
    5, 5, 7, 5, 5,
    7, 2, 2, 2, 7,
    1, 1, 1, 5, 2,
    5, 5, 6, 5, 5,
    4, 4, 4, 4, 7,
    5, 7, 7, 5, 5,
    5, 7, 7, 7, 5,
    2, 5, 5, 5, 2,
    6, 5, 6, 4, 4,
    2, 5, 5, 7, 3,
    6, 5, 6, 5, 5,
    3, 4, 2, 1, 6,
    7, 2, 2, 2, 2,
    5, 5, 5, 5, 7,
    5, 5, 5, 5, 2,
    5, 5, 7, 7, 5,
    5, 5, 2, 5, 5,
    5, 5, 2, 2, 2,
    7, 1, 2, 4, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    0, 0, 0, 0, 7,
    7, 5, 5, 5, 7,
    2, 5, 7, 5, 5,
    6, 5, 6, 5, 6,
    3, 4, 4, 4, 3,
    6, 5, 5, 5, 6,
    7, 4, 6, 4, 7,
    7, 4, 6, 4, 4,
    3, 4, 5, 5, 3,
    5, 5, 7, 5, 5,
    7, 2, 2, 2, 7,
    1, 1, 1, 5, 2,
    5, 5, 6, 5, 5,
    4, 4, 4, 4, 7,
    5, 7, 7, 5, 5,
    5, 7, 7, 7, 5,
    2, 5, 5, 5, 2,
    6, 5, 6, 4, 4,
    2, 5, 5, 7, 3,
    6, 5, 6, 5, 5,
    3, 4, 2, 1, 6,
    7, 2, 2, 2, 2,
    5, 5, 5, 5, 7,
    5, 5, 5, 5, 2,
    5, 5, 7, 7, 5,
    5, 5, 2, 5, 5,
    5, 5, 2, 2, 2,
    7, 1, 2, 4, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
];

const TABLE_1: readonly number[] = [
    0, 0, 0, 0, 0,
    2, 2, 2, 0, 2,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    5, 1, 2, 4, 5,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    0, 5, 2, 5, 0,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    0, 0, 7, 0, 0,
    0, 0, 0, 0, 2,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    2, 6, 2, 2, 7,
    6, 1, 2, 4, 7,
    6, 1, 2, 1, 6,
    5, 5, 7, 1, 1,
    7, 4, 6, 1, 6,
    3, 4, 6, 5, 2,
    7, 1, 2, 2, 2,
    2, 5, 2, 5, 2,
    2, 5, 3, 1, 6,
    0, 2, 0, 2, 0,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    7, 1, 2, 0, 2,
    7, 5, 5, 5, 7,
    2, 5, 7, 5, 5,
    6, 5, 6, 5, 6,
    3, 4, 4, 4, 3,
    6, 5, 5, 5, 6,
    7, 4, 6, 4, 7,
    7, 4, 6, 4, 4,
    3, 4, 5, 5, 3,
    5, 5, 7, 5, 5,
    7, 2, 2, 2, 7,
    1, 1, 1, 5, 2,
    5, 5, 6, 5, 5,
    4, 4, 4, 4, 7,
    5, 7, 7, 5, 5,
    5, 7, 7, 7, 5,
    2, 5, 5, 5, 2,
    6, 5, 6, 4, 4,
    2, 5, 5, 7, 3,
    6, 5, 6, 5, 5,
    3, 4, 2, 1, 6,
    7, 2, 2, 2, 2,
    5, 5, 5, 5, 7,
    5, 5, 5, 5, 2,
    5, 5, 7, 7, 5,
    5, 5, 2, 5, 5,
    5, 5, 2, 2, 2,
    7, 1, 2, 4, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    0, 0, 0, 0, 7,
    7, 5, 5, 5, 7,
    2, 5, 7, 5, 5,
    6, 5, 6, 5, 6,
    3, 4, 4, 4, 3,
    6, 5, 5, 5, 6,
    7, 4, 6, 4, 7,
    7, 4, 6, 4, 4,
    3, 4, 5, 5, 3,
    5, 5, 7, 5, 5,
    7, 2, 2, 2, 7,
    1, 1, 1, 5, 2,
    5, 5, 6, 5, 5,
    4, 4, 4, 4, 7,
    5, 7, 7, 5, 5,
    5, 7, 7, 7, 5,
    2, 5, 5, 5, 2,
    6, 5, 6, 4, 4,
    2, 5, 5, 7, 3,
    6, 5, 6, 5, 5,
    3, 4, 2, 1, 6,
    7, 2, 2, 2, 2,
    5, 5, 5, 5, 7,
    5, 5, 5, 5, 2,
    5, 5, 7, 7, 5,
    5, 5, 2, 5, 5,
    5, 5, 2, 2, 2,
    7, 1, 2, 4, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
    7, 5, 5, 5, 7,
];

/** Every distinct table, in the order the fonts above point at them. */
const TABLES: readonly (readonly number[])[] = [TABLE_0, TABLE_1];

/**
 * The five row bytes of one character in the crate's glyph table for a font.
 *
 * A character outside the table answers with the crate's own fallback, `?` -- which is what `glyph_rows`
 * does, and the canvas has to agree with the board about what an unsupported character looks like.
 */
export function glyphRows(font: string, ch: string): readonly number[] {
    const metrics = glyphMetrics(font);
    const table = TABLES[metrics.table] ?? TABLE_0;
    const code = ch.codePointAt(0) ?? 0;
    const wanted = code >= GLYPH_FIRST_CHAR && code <= GLYPH_LAST_CHAR ? code : '?'.codePointAt(0) ?? 0;
    const start = (wanted - GLYPH_FIRST_CHAR) * GLYPH_ROWS;
    return table.slice(start, start + GLYPH_ROWS);
}

/** The metrics of a font the design names, falling back to the crate's own default (`Tiny3x5`). */
export function glyphMetrics(font: string): GlyphMetrics {
    return GLYPH_FONTS[font] ?? DEFAULT_FONT;
}
