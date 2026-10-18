'use strict';

/**
 * The BDF reader the canvas draws with.
 *
 * A declared font's glyphs are not in the design -- only the path to them -- so the extension parses the
 * file and sends the pixels. The crate parses the same files (`parse_bdf` in
 * `embedded-gui-codegen/src/assets.rs`) and turns them into `FontId::Bitmap`, so this conversion has to
 * agree with that one: two fixtures below are the crate's own, asserted to the same numbers, and the
 * third is the BDF the designer's simulator already uses.
 */

const fs = require('fs');
const path = require('path');
const { test, ok, equal, contains, repoRoot, compiled } = require('../../lib/harness');

const { parseBdfFont } = compiled('designer/bitmapFont');

/** The crate's `parses_bdf_into_fixed_cells` fixture, character for character. */
const TWO_GLYPHS = `STARTFONT 2.1
FONTBOUNDINGBOX 8 8 0 0
CHARS 2
STARTCHAR zero
ENCODING 48
DWIDTH 8 0
BBX 8 2 0 6
BITMAP
FF
81
ENDCHAR
STARTCHAR one
ENCODING 49
DWIDTH 8 0
BBX 8 1 0 7
BITMAP
18
ENDCHAR
ENDFONT
`;

test('a BDF becomes one fixed cell, as the crate makes it', () => {
    const parsed = parseBdfFont(TWO_GLYPHS);
    ok(!('error' in parsed), `it parses: ${parsed.error ?? ''}`);
    const font = parsed.font;
    // The cell is the union of the two glyphs, not the 8x8 FONTBOUNDINGBOX: display fonts reserve room
    // for accents that a digit never uses.
    equal(font.width, 8, 'eight columns');
    equal(font.height, 2, 'two rows, which is all the glyphs use');
    equal(font.advance, 8, 'the DWIDTH the file states');
    equal(font.lineHeight, 2, 'and a line is the cell, as the crate sets it');
    equal(font.firstChar, 48, 'the first character is `0`');
    equal(font.lastChar, 49, 'and the last is `1`');
    // Glyph after glyph, row after row: '0' fills both rows of the cell, and '1' sits a row higher on
    // the baseline, so it lands on the cell's top row.
    equal(font.rows, [0xff, 0x81, 0x18, 0x00]);
});

test('the characters asked for are the only ones embedded', () => {
    const bdf = `FONTBOUNDINGBOX 8 8 0 0
STARTCHAR a
ENCODING 65
DWIDTH 8 0
BBX 8 1 0 7
BITMAP
FF
ENDCHAR
STARTCHAR b
ENCODING 66
DWIDTH 8 0
BBX 8 1 0 7
BITMAP
0F
ENDCHAR
ENDFONT
`;
    const parsed = parseBdfFont(bdf, 'B');
    ok(!('error' in parsed), 'it parses');
    equal(parsed.font.firstChar, 66, 'the range starts at the one character asked for');
    equal(parsed.font.lastChar, 66, 'and ends there');
    equal(parsed.font.rows, [0x0f], 'with that glyph and no other');
});

test('a font the canvas cannot draw says why rather than drawing nothing', () => {
    contains(parseBdfFont('FONTBOUNDINGBOX 8 8 0 0\n').error, 'no glyphs', 'an empty file');
    contains(parseBdfFont('STARTFONT 2.1\nENDFONT\n').error, 'FONTBOUNDINGBOX', 'a file with no box');
    const noSuchChar = parseBdfFont(TWO_GLYPHS, 'Z');
    ok('error' in noSuchChar, 'a subset that matches no glyph is an error, not an empty font');
});

test('the BDF the designer simulator uses parses with the shape it states', () => {
    const source = fs.readFileSync(path.join(repoRoot(), 'tests', 'sim', 'assets', 'test.bdf'), 'utf8');
    const parsed = parseBdfFont(source);
    ok(!('error' in parsed), `the repository's own BDF parses: ${parsed.error ?? ''}`);
    const font = parsed.font;
    ok(font.width > 0 && font.height > 0, 'a cell with area');
    ok(font.advance >= 1, 'an advance the canvas can step by');
    equal(
        font.rows.length,
        (font.lastChar - font.firstChar + 1) * font.height,
        'one row per glyph row, end to end',
    );
    // Every declared row fits the cell: a bit above the width would be a bit the canvas never draws and a
    // sign that the two parsers had drifted apart.
    const ceiling = 2 ** font.width;
    ok(
        font.rows.every((row) => row >= 0 && row < ceiling),
        'every row is inside the cell width',
    );
});
