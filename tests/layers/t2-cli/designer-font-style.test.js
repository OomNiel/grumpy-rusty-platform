'use strict';

/**
 * The canvas draws a declared font on the widgets that carry it in their *style*.
 *
 * The clock is the one that matters: the crate takes its numerals' face from `style.font`, so the markup says
 * `style.font = FontId::Bitmap(&__FONT_<ID>)` -- and the canvas went on painting the default face because
 * `designStyle` only ever put a *built-in* font into the style. A design could name an imported font, show it
 * in the Font list, and draw something else entirely.
 *
 * The proof is a comparison: the same clock, painted once with the font's pixels registered (the extension
 * sends them with the document) and once without. If the canvas ignores the font, both paints are identical.
 */

const path = require('path');
const { test, ok, equal, compiled, repoRoot } = require('../../lib/harness');
const dom = require('../../lib/dom');

const { starterDocument } = compiled('designer/generate');
const { defaultProps } = compiled('designer/model');

const BUNDLE = path.join(repoRoot(), 'out', 'webview', 'designer.js');

/** A 5x7 font of solid blocks: every numeral is a filled rectangle, so its ink cannot be mistaken for a digit. */
const BOX_FONT = {
    width: 5,
    height: 7,
    advance: 6,
    lineHeight: 9,
    firstChar: 48,
    lastChar: 57,
    rows: Array.from({ length: 10 * 7 }, () => 0b11111),
};

/**
 * The same cell with a single row of ink.
 *
 * A font *lighter* than the packed 3x5 digits is the control that makes this test mean something: if the canvas
 * ignored the declared face, both fonts would paint exactly what the default paints. Painting more ink for one
 * and less for the other can only come from the font's own glyphs.
 */
const SPARSE_FONT = {
    ...BOX_FONT,
    rows: Array.from({ length: 10 * 7 }, (_, index) => (index % 7 === 6 ? 0b11111 : 0)),
};

/** Paints one clock that uses the declared font, with the pixels given (or none), and returns the ink laid down. */
function paintClock(font) {
    const { root, messages, window } = dom.install();
    delete require.cache[require.resolve(BUNDLE)];
    require(BUNDLE);

    const document = starterDocument({
        boardId: 'sunton-3248s035r',
        panelWidth: 320,
        panelHeight: 480,
        rotation: 3,
    });
    document.fonts = [{ id: 'face', src: 'assets/face.bdf', chars: '' }];
    document.widgets = [
        {
            id: 'tower',
            tag: 'clock',
            x: 8,
            y: 8,
            width: 200,
            height: 200,
            props: { ...defaultProps('clock'), font: 'face' },
            events: [],
            children: [],
        },
    ];

    window.emit('message', {
        data: {
            type: 'init',
            document,
            canvas: { width: 480, height: 320 },
            paths: { document: 'designer/panel.ui.json', kdl: 'src/ui.kdl' },
            touchBoard: true,
            touchEnabled: false,
            fonts: font === undefined ? {} : { face: font },
        },
    });

    const canvas = root.descendants().find((element) => element.tagName === 'CANVAS');
    ok(canvas !== undefined, 'there is a canvas');
    const fills = canvas.context.calls.filter((call) => call.method === 'fillRect');
    const area = fills.reduce((total, call) => total + Number(call.args[2] ?? 0) * Number(call.args[3] ?? 0), 0);
    void messages;
    return { count: fills.length, area };
}

test('a clock draws the declared face the design selected, not the default one', () => {
    const fallback = paintClock(undefined);
    equal(fallback.area > 0, true, 'the clock paints even with no font the canvas knows');

    // Twelve hour labels. A solid block per glyph is far more ink than the packed 3x5 digits...
    const box = paintClock(BOX_FONT);
    ok(
        box.area > fallback.area,
        `a heavy face paints more than the default (${box.area} against ${fallback.area})`,
    );
    // ...and a font with one row of ink is far less. Both can only follow the font's own glyphs.
    const sparse = paintClock(SPARSE_FONT);
    ok(
        sparse.area < fallback.area,
        `a light face paints less than the default (${sparse.area} against ${fallback.area})`,
    );
});
