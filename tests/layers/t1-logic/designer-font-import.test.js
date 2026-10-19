'use strict';

/**
 * The BDF writer behind "Import a Font".
 *
 * The importer's two halves split at the file: the webview draws a face and measures it, and the extension
 * writes the result out. What makes that safe is that the file is read back by code that already exists, so
 * these tests do not trust the text -- they parse it with the same reader the canvas uses and demand the
 * same pixels back. A BDF that reads back to the face that was drawn is a BDF the crate can draw too.
 */

const { test, ok, equal, contains, compiled } = require('../../lib/harness');

const { bdfFromRaster, fontIdFromFile, hexRow, isBitmapFontFile } = compiled('designer/fontImport');
const { measureCell, rasteriseCell, rowBits } = compiled('designer/fontRaster');
const { parseBdfFont } = compiled('designer/bitmapFont');

/**
 * A face with known geography, so the arithmetic can be checked against a table rather than against itself.
 *
 * Every glyph is a box: `A` is eight rows above the baseline and three wide, `g` descends three rows, `M` is
 * the widest ink, and a space has none. A real face is not this tidy, but every decision the rasteriser makes
 * -- the cell's size, where the pen origin sits, which pixels count as ink -- is decided by exactly these
 * numbers.
 */
const FACE = {
    advance: 7,
    box: (code) => {
        const ch = String.fromCharCode(code);
        if (ch === ' ') return { left: 0, right: 0, ascent: 0, descent: 0 };
        if (ch === 'A') return { left: 0, right: 3, ascent: 8, descent: 0 };
        if (ch === 'g') return { left: 0, right: 3, ascent: 5, descent: 3 };
        if (ch === 'M') return { left: -1, right: 6, ascent: 6, descent: 0 };
        return { left: 0, right: 4, ascent: 6, descent: 1 };
    },
    metrics(code) {
        const box = FACE.box(code);
        return {
            width: FACE.advance,
            actualBoundingBoxLeft: box.left,
            actualBoundingBoxRight: box.right,
            actualBoundingBoxAscent: box.ascent,
            actualBoundingBoxDescent: box.descent,
        };
    },
};

/** A canvas that draws the fake face's boxes: fillText is remembered, getImageData paints it. */
function fakeCanvasFactory() {
    let pending = undefined;
    return (width, height) => ({
        width,
        height,
        context: {
            font: '',
            textBaseline: '',
            fillStyle: '',
            clearRect() { pending = undefined; },
            fillText(text, x, y) { pending = { code: text.charCodeAt(0), x, y }; },
            measureText(text) { return FACE.metrics(text.charCodeAt(0)); },
            getImageData(_x, _y, w, h) {
                const data = new Uint8ClampedArray(w * h * 4);
                if (pending !== undefined) {
                    const box = FACE.box(pending.code);
                    for (let row = 0; row < (box.ascent + box.descent); row += 1) {
                        for (let col = box.left; col < box.right; col += 1) {
                            const px = pending.x + col;
                            const py = pending.y - box.ascent + row;
                            if (px < 0 || px >= w || py < 0 || py >= h) continue;
                            data[(py * w + px) * 4 + 3] = 255;
                        }
                    }
                }
                return { data };
            },
        },
    });
}

/** A font shaped like the webview's answer: a fixed cell, rows with the leftmost column high. */
function sample() {
    const width = 5;
    const height = 7;
    const blank = () => new Array(height).fill(0);
    const glyphs = [];
    for (let code = 32; code <= 126; code += 1) {
        glyphs.push(blank());
    }
    // An A with a hole, a solid B, a z on the bottom row, and a space that is empty -- enough to catch a
    // row shift, a reversed column, or a cropped cell.
    glyphs['A'.charCodeAt(0) - 32] = [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001];
    glyphs['B'.charCodeAt(0) - 32] = [0b11111, 0b11111, 0b11111, 0b11111, 0b11111, 0b11111, 0b11111];
    glyphs['z'.charCodeAt(0) - 32] = [0, 0, 0, 0, 0, 0, 0b11111];
    return { width, height, descent: 2, advance: 6, pixelSize: 12, glyphs };
}

test('a rasterised face becomes all ninety-five characters, in encoding order', () => {
    const text = bdfFromRaster(sample(), 'DejaVuSansMono');
    ok(text.startsWith('STARTFONT 2.1\n'), 'it is a BDF 2.1 file');
    ok(text.trimEnd().endsWith('ENDFONT'), 'and it ends');
    equal((text.match(/^STARTCHAR /gm) ?? []).length, 95, 'ninety-five glyphs');
    equal((text.match(/^ENCODING /gm) ?? []).length, 95, 'each with an encoding');
    contains(text, 'CHARS 95\n', 'the count the parser checks');
    equal(
        (text.match(/^ENCODING (\d+)$/gm) ?? []).map((line) => line.slice(9)).join(','),
        Array.from({ length: 95 }, (_, index) => 32 + index).join(','),
        'space through tilde, no gaps',
    );
});

test('the cell and the baseline are stated, so the file is self-describing', () => {
    const text = bdfFromRaster(sample(), 'DejaVuSansMono');
    contains(text, 'SIZE 12 75 75\n', 'the size it was drawn at');
    contains(text, 'FONTBOUNDINGBOX 5 7 0 -2\n', 'the cell, and how far below the baseline it reaches');
    contains(text, 'FONT_ASCENT 5\n', 'five rows above the baseline');
    contains(text, 'FONT_DESCENT 2\n', 'two below');
    // Every glyph carries the whole cell rather than a crop a reader would have to reassemble.
    equal((text.match(/^BBX 5 7 0 -2$/gm) ?? []).length, 95, 'one bounding box per glyph');
});

test('the written file reads back through the project\'s own parser as the same pixels', () => {
    const font = sample();
    const parsed = parseBdfFont(bdfFromRaster(font, 'DejaVuSansMono'));
    ok(!('error' in parsed), `it parses: ${parsed.error ?? ''}`);
    const read = parsed.font;
    equal(read.width, font.width, 'the cell keeps its width');
    equal(read.height, font.height, 'and its height');
    equal(read.advance, font.advance, 'the advance the writer stated');
    equal(read.firstChar, 32, 'starting at space');
    equal(read.lastChar, 126, 'ending at the tilde');
    for (let code = 32; code <= 126; code += 1) {
        const offset = (code - 32) * font.height;
        equal(
            read.rows.slice(offset, offset + font.height),
            font.glyphs[code - 32],
            `character ${code} came back changed`,
        );
    }
});

test('a cell wider than eight columns keeps its far bits', () => {
    // Nine columns straddle two bytes, which is where a row shift or a padding bug would hide.
    const font = sample();
    font.width = 9;
    font.glyphs['W'.charCodeAt(0) - 32] = [0, 0, 0, 0, 0, 0, 0b100000001];
    const parsed = parseBdfFont(bdfFromRaster(font, 'wide'));
    ok(!('error' in parsed), `it parses: ${parsed.error ?? ''}`);
    const offset = ('W'.charCodeAt(0) - 32) * font.height;
    equal(parsed.font.rows[offset + 6], 0b100000001, 'both outer columns survive the trip');
    equal(hexRow(0b100000001, 9), '8080', 'and the row states them as two bytes, high bit first');
});

test('a row is padded to whole bytes with the leftmost column high', () => {
    equal(hexRow(0b11111, 5), 'F8', 'five ones sit in the top bits');
    equal(hexRow(0b10000, 5), '80', 'only the leftmost column');
    equal(hexRow(0b00001, 5), '08', 'only the rightmost');
    equal(hexRow(0, 5), '00', 'and nothing at all');
    equal(hexRow(0b11111111, 8), 'FF', 'a full byte is itself');
});

test('a font missing characters is refused rather than written short', () => {
    const font = sample();
    font.glyphs = font.glyphs.slice(0, 60);
    let message = '';
    try {
        bdfFromRaster(font, 'short');
    } catch (error) {
        message = String(error.message ?? error);
    }
    contains(message, '95 printable', 'it says what is missing');
});

test('the file name becomes the Rust identifier the generator needs', () => {
    equal(fontIdFromFile('/usr/share/fonts/DejaVuSansMono.ttf'), 'DejaVuSansMono', 'the stem');
    equal(fontIdFromFile('my font.otf'), 'my_font', 'spaces are not identifiers');
    equal(fontIdFromFile('7-segment.bdf'), 'font_7_segment', 'nor is a leading digit');
    equal(fontIdFromFile('DejaVu.ttf', ['DejaVu']), 'DejaVu_2', 'a second import gets its own name');
    equal(fontIdFromFile('DejaVu.ttf', ['DejaVu', 'DejaVu_2']), 'DejaVu_3', 'and a third');
});

test('the cell is the union of every glyph, measured from one baseline', () => {
    // The widest reach to the left is M's -1 and to the right its 6: seven columns, with the pen origin one
    // column in from the left edge. The tallest ascent is A's 8; the deepest descent is g's 3.
    const cell = measureCell((text) => FACE.metrics(text.charCodeAt(0)));
    equal(cell.left, -1, 'one column of M hangs left of the origin');
    equal(cell.right, 6, 'and six reach right of it');
    equal(cell.width, 7, 'so the cell is seven columns');
    equal(cell.ascent, 8, 'eight rows above the baseline');
    equal(cell.descent, 3, 'three below');
    equal(cell.height, 11, 'eleven rows in all');
    equal(cell.advance, 7, 'the advance the face states');
});

test('a space cannot widen the cell', () => {
    // A font reports a zero box for a blank, and if that were mixed in as ink it would drag the origin left.
    const cell = measureCell((text) => (text === ' '
        ? {
            width: 7, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 0,
            actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0
        }
        : FACE.metrics(text.charCodeAt(0))));
    equal(cell.width, 7, 'the blank is skipped');
});

test('every glyph is drawn on the shared origin, and a blank stays blank', () => {
    const result = rasteriseCell(fakeCanvasFactory(), 'fake', 12);
    ok(!('error' in result), `it rasterises: ${result.error ?? ''}`);
    const font = result.font;
    equal(font.width, 7, 'the cell');
    equal(font.height, 11, 'and its height');
    equal(font.descent, 3, 'with three rows below the baseline');
    equal(font.glyphs.length, 95, 'ninety-five characters');
    equal(font.glyphs[0], new Array(11).fill(0), 'a space has no ink at all');
    // A's ink is three columns from the origin, eight rows up: columns 1..3 (the origin is at 1) and rows 0..7.
    const a = font.glyphs['A'.charCodeAt(0) - 32];
    equal(a.slice(0, 8), new Array(8).fill(0b0111000), 'A is a solid three-column stem, high on the cell');
    equal(a.slice(8), [0, 0, 0], 'and nothing below the baseline');
    // g sits five rows up and three down, so its lowest ink is the cell's last row.
    const g = font.glyphs['g'.charCodeAt(0) - 32];
    equal(g.slice(3, 6), new Array(3).fill(0b0111000), 'g starts three rows down');
    ok(g[10] > 0, 'and reaches the bottom row');
    // M is the glyph that hangs left of the origin: its ink starts at column 0.
    const m = font.glyphs['M'.charCodeAt(0) - 32];
    equal(m[2], 0b1111111, 'M fills all seven columns');
});

test('the same pixels come out of the file that went in', () => {
    // The whole point of the two halves: draw a face, write it, read it back, and the board draws what the
    // canvas drew.
    const result = rasteriseCell(fakeCanvasFactory(), 'fake', 12);
    ok(!('error' in result), `it rasterises: ${result.error ?? ''}`);
    const parsed = parseBdfFont(bdfFromRaster(result.font, 'fake'));
    ok(!('error' in parsed), `it parses: ${parsed.error ?? ''}`);
    equal(parsed.font.width, result.font.width, 'the cell width survives');
    equal(parsed.font.height, result.font.height, 'and the height');
    for (let code = 32; code <= 126; code += 1) {
        const offset = (code - 32) * result.font.height;
        equal(parsed.font.rows.slice(offset, offset + result.font.height), result.font.glyphs[code - 32],
            `character ${code} came back changed`);
    }
});

test('a pixel counts as ink at half coverage and not below it', () => {
    // Anti-aliasing is the difference between a readable face and mush at these sizes; the threshold is
    // stated rather than left to whatever the browser produced.
    const pixels = new Uint8ClampedArray([0, 0, 0, 127, 0, 0, 0, 128, 0, 0, 0, 255]);
    equal(rowBits(pixels, 3, 0), 0b011, 'a fringe at 127 is not ink, 128 and above is');
    equal(rowBits(pixels, 3, 0, 1), 0b111, 'and the threshold is a parameter');
});

test('only a BDF goes in as it is, and everything else is drawn first', () => {
    // The rule that decides whether a picked file is copied or rasterised. Both font dialogs share it.
    ok(isBitmapFontFile('assets/hero.BDF'), 'a BDF, whatever its case');
    ok(!isBitmapFontFile('/usr/share/fonts/DejaVuSansMono.ttf'), 'a TrueType face is not');
    ok(!isBitmapFontFile('face.otf'), 'nor an OpenType one');
    ok(!isBitmapFontFile('collection.ttc'), 'nor a collection');
});
