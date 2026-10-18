'use strict';

/**
 * A declared font reaches the canvas, and is drawn as itself.
 *
 * The panel cannot read a file, so a BDF's glyphs arrive from the extension with the document (they are
 * not in the design -- only the path to them). This drives the real bundle: a design whose label names a
 * declared font, the pixels for that font in the init message, and an assertion on what the canvas
 * actually painted.
 *
 * The point of the test is the difference between "approximated with the default" and "drawn": before
 * this, a declared font was painted as the 3x5 fallback, which is five rows tall. The declared font here
 * is seven, so a painted label that spans seven rows can only have come from its own pixels.
 */

const path = require('path');
const { test, ok, equal, compiled, repoRoot } = require('../../lib/harness');
const dom = require('../../lib/dom');

const { starterDocument } = compiled('designer/generate');

const BUNDLE = path.join(repoRoot(), 'out', 'webview', 'designer.js');

/** A 5x7 font with one glyph: a filled box, so every row is unmistakable. */
const BOX_FONT = {
    width: 5,
    height: 7,
    advance: 6,
    lineHeight: 9,
    firstChar: 65,
    lastChar: 65,
    rows: [0b11111, 0b11111, 0b11111, 0b11111, 0b11111, 0b11111, 0b11111],
};

test('the canvas paints a declared font with its own glyphs', () => {
    const { root, messages, window } = dom.install();
    // Each file gets its own DOM, so the bundle has to be evaluated again for it: a cached module was
    // already run against the previous test's window.
    delete require.cache[require.resolve(BUNDLE)];
    require(BUNDLE);

    const document = starterDocument({
        boardId: 'sunton-3248s035r',
        panelWidth: 320,
        panelHeight: 480,
        rotation: 3,
    });
    // The title label uses a font the design declares, and says so in the way a design does.
    const title = document.widgets.find((widget) => widget.id === 'title');
    title.props.text = 'A';
    title.props.font = 'boxfont';
    document.fonts = [{ id: 'boxfont', src: 'assets/box.bdf', chars: 'A' }];

    window.emit('message', {
        data: {
            type: 'init',
            document,
            canvas: { width: 480, height: 320 },
            paths: { document: 'designer/panel.ui.json', kdl: 'src/ui.kdl' },
            touchBoard: true,
            touchEnabled: false,
            fonts: { boxfont: BOX_FONT },
        },
    });

    const all = () => root.descendants();
    const canvas = all().find((element) => element.tagName === 'CANVAS');
    ok(canvas !== undefined, 'there is a canvas');
    const fills = canvas.context.calls.filter((call) => call.method === 'fillRect');
    ok(fills.length > 0, 'the design was painted');

    // Every painted pixel of the glyph sits inside the label's box, and the ink is as tall as the font
    // says: seven rows, which the 3x5 fallback cannot produce.
    const inside = fills.filter(
        (call) =>
            call.args[0] >= title.x &&
            call.args[1] >= title.y &&
            call.args[0] + call.args[2] <= title.x + title.width &&
            call.args[1] + call.args[3] <= title.y + title.height,
    );
    ok(inside.length > 0, 'the label drew something inside its own box');
    const tops = inside.map((call) => call.args[1]);
    const bottoms = inside.map((call) => call.args[1] + (call.args[3] ?? 0));
    const height = Math.max(...bottoms) - Math.min(...tops);
    ok(
        height >= 7,
        `the ink spans ${height} rows, so it is the declared face and not the 3x5 fallback`,
    );
    equal(messages.filter((message) => message.type === 'changed').length, 0, 'and nothing was edited');
});
