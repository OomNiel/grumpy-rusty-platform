'use strict';

/**
 * The canvas's glyph table, which is generated from the crate.
 *
 * The designer's promise is that the canvas shows the glass, and text is part of that: a browser font of a
 * similar size would make every measurement taken off the canvas -- does the label fit, does the button text
 * overflow -- a measurement of the wrong font. So the table is generated from `embedded_gui::font::glyph_rows`
 * by `tests/tools/glyph-table.js`, committed, and checked here.
 *
 * These tests read the generated file as text rather than importing it: the webview is bundled by esbuild with
 * `noEmit`, so there is no compiled module to require. What they defend against is a hand-edit of a generated
 * file and a stale regeneration -- the values themselves are the crate's, and `node tests/tools/glyph-table.js
 * --check` compares the whole file against the crate when a Rust toolchain is available.
 */

const fs = require('fs');
const path = require('path');
const { test, ok, notOk, equal, contains, repoRoot } = require('../../lib/harness');

const SOURCE = fs.readFileSync(path.join(repoRoot(), 'webview', 'designer', 'glyphs.ts'), 'utf8');

test('the canvas draws with the crate\'s own glyphs, and says where they came from', () => {
    contains(SOURCE, 'GENERATED, DO NOT EDIT', 'the file announces itself as generated');
    contains(SOURCE, 'tests/tools/glyph-table.js', 'and names the tool that writes it');
    contains(SOURCE, 'glyph_rows', 'and the crate API it was read from');
    contains(SOURCE, '1 << (2 - col)', 'and how a row byte is laid out');

    // What the crate prints for each font (`FontId::advance`/`line_height`), so a regeneration that changes a
    // font's metrics is a visible diff rather than a silent one.
    const metrics = [
        ['Tiny3x5', 4, 6],
        ['Medium4x7', 5, 8],
        ['Scaled6x10', 7, 11],
        ['Vector(2)', 16, 24],
        ['Vector(3)', 24, 36],
    ];
    contains(SOURCE, 'const DEFAULT_FONT: GlyphMetrics = { advance: 4, lineHeight: 6, table: 0 };',
        'the crate\'s default (Tiny3x5) is stated once, and is the fallback');
    for (const [name, advance, lineHeight] of metrics.slice(1)) {
        contains(
            SOURCE,
            `"${name}": { advance: ${advance}, lineHeight: ${lineHeight}, table: `,
            `${name} keeps the crate's metrics`,
        );
    }
});

test('the fonts share one table when they spell every glyph the same way', () => {
    // The generator keeps a table per *distinct* font, so it never ships five copies of the same
    // ninety-five glyphs. Since 0.8.0 there is only one: the 4x7 overrides (`? ! * @`) now spell
    // those four exactly as the base face does, which is why `Medium4x7` no longer needs a table of
    // its own. The rule is still the interesting part -- a font whose glyphs differ must get its own
    // table rather than being folded into the first -- and `glyph-table.js` dedupes by content.
    const tables = (SOURCE.match(/^const TABLE_\d+: readonly number\[\] = \[$/gm) ?? []).length;
    equal(tables, 1, 'one table, shared by all five fonts');
    contains(SOURCE, '0, 5, 2, 5, 0', "the face's `*`");
    notOk(SOURCE.includes('table: 1'), 'and nothing points at a second table');

    // The fonts that share it (including both scales of the vector face) must not have been given
    // copies.
    contains(SOURCE, '"Tiny3x5": DEFAULT_FONT,', 'the default font points at the table');
    for (const name of ['Scaled6x10', 'Vector(2)', 'Vector(3)']) {
        contains(SOURCE, `"${name}": { advance: `, `${name} is listed`);
    }
    // Five mentions: the `DEFAULT_FONT` constant and the four fonts that point at the same table.
    equal((SOURCE.match(/table: 0 \}/g) ?? []).length, 5, 'all five point at it');
});

test('a character the crate has no glyph for falls back the way the crate does', () => {
    contains(SOURCE, "?'", 'the fallback character is `?`');
    contains(SOURCE, 'GLYPH_FIRST_CHAR', 'the table states where it starts');
    contains(SOURCE, 'GLYPH_LAST_CHAR', 'and where it ends');
    // The range is what the generator read (printable ASCII), and `glyphRows` clamps to it.
    contains(SOURCE, 'export const GLYPH_FIRST_CHAR = 32;', 'printable ASCII starts at 32');
    contains(SOURCE, 'export const GLYPH_LAST_CHAR = 126;', 'and ends at 126');
});

test('the vector face is the crate\'s polylines, not the bitmap scaled', () => {
    // `Vector(n)` is not a bitmap: the engine strokes a polyline through these points, multiplying each
    // coordinate by the variant's scale, and lifting the pen at the crate's `(255, 255)` sentinel. Without this
    // data a replica could only approximate the vector face, which is the kind of nearly that makes a WYSIWYG
    // canvas untrustworthy -- so it is generated from `get_vector_glyph` rather than guessed.
    contains(SOURCE, 'export const VECTOR_PEN_UP = 255;', 'the pen-up marker is named');
    contains(SOURCE, 'export function vectorGlyph(', 'and there is a lookup for a character');
    contains(SOURCE, 'const VECTOR_GLYPHS: readonly (readonly number[])[]', 'over a table of point lists');
    // A space is an empty stroke and a digit is not; both are in the crate's own data.
    contains(SOURCE, '    [],', 'a glyph with no strokes is an empty entry');
    contains(SOURCE, '2, 0, 6, 0, 6, 10, 2, 10, 2, 0, 255, 255, 2, 10, 6, 0', "the crate's `0`: a box, a pen-up, then a slash");
    contains(SOURCE, 'GLYPH_FIRST_CHAR', 'and the table is indexed like the bitmap one');
});
