'use strict';

/**
 * The Font row's size box, driven through the real bundle.
 *
 * Two things can only be tested here. The first is that a *declared* font is listed for every widget that
 * offers a Font field -- including the clock, whose numerals come from `style.font` and which therefore used
 * to show an empty list, making an imported system font look like it had never arrived. The second is the
 * size box: enabled only when there is something to redraw, and asking the extension rather than editing the
 * document, because a BDF is a bitmap and a new size is a new drawing of the face.
 */

const path = require('path');
const { test, ok, equal, compiled, repoRoot } = require('../../lib/harness');
const dom = require('../../lib/dom');

const { starterDocument } = compiled('designer/generate');
const { defaultProps } = compiled('designer/model');

const BUNDLE = path.join(repoRoot(), 'out', 'webview', 'designer.js');

/** A design with one clock, drawn with an imported font at 24 px, and one label on a hand-made BDF. */
function boot() {
    const { root, messages, window } = dom.install();
    delete require.cache[require.resolve(BUNDLE)];
    require(BUNDLE);

    const document = starterDocument({
        boardId: 'sunton-3248s035r',
        panelWidth: 320,
        panelHeight: 480,
        rotation: 3,
    });
    document.fonts = [
        // What an import leaves behind: the BDF the crate reads, the face it was drawn from, and the size.
        {
            id: 'DejaVu_24',
            src: 'assets/DejaVu_24-24.bdf',
            chars: '',
            source: 'assets/DejaVuSansMono.ttf',
            size: 24,
        },
        // A font that arrived as a BDF with no face beside it: nothing to redraw it from.
        { id: 'hero', src: 'assets/hero.bdf', chars: '' },
    ];
    document.widgets = [
        ...document.widgets,
        {
            id: 'face',
            tag: 'clock',
            x: 200,
            y: 40,
            width: 100,
            height: 100,
            props: { ...defaultProps('clock'), font: 'DejaVu_24' },
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
        },
    });
    return { root, messages, window };
}

/** Selects the clock, and finds the row holding its Font list. */
function clockFontRow(root) {
    const all = () => root.descendants();
    all()
        .find((element) => element.tagName === 'CANVAS')
        .emit('pointerdown', { clientX: 202, clientY: 42, pointerId: 1, button: 0 });
    const select = all().find(
        (element) =>
            element.tagName === 'SELECT' &&
            element.descendants().some((option) => option.value === 'DejaVu_24'),
    );
    ok(select !== undefined, 'the clock\'s Font list offers the project font');
    const row = all().find(
        (element) =>
            element.classList.contains('asset-field') &&
            element.descendants().some((child) => child === select),
    );
    ok(row !== undefined, 'and it sits in a row with the rest of the control');
    return { select, row };
}

const sizeBoxOf = (row) => row.children.find((child) => child.classList.contains('font-size'));

test('a declared font is listed for a clock, named with the size it was drawn at', () => {
    // The clock reads only a style, so before this its list showed the crate's own faces and nothing else: an
    // imported font was in the design, invisible here, and the field read "(default)".
    const { root } = boot();
    const { select } = clockFontRow(root);
    equal(select.value, 'DejaVu_24', 'the font the clock uses is the one shown');
    const option = select.descendants().find((candidate) => candidate.value === 'DejaVu_24');
    equal(option.textContent, 'DejaVu_24 (24 px)', 'and the size it was drawn at is named beside it');
    ok(
        select.descendants().some((candidate) => candidate.value === 'hero'),
        'a BDF with no face behind it is offered too',
    );
});

test('the size box is enabled for a font that can be redrawn, and asks the extension', () => {
    const { root, messages } = boot();
    const { row } = clockFontRow(root);
    const box = sizeBoxOf(row);
    ok(box !== undefined, 'the Font row has a size box');
    equal(box.type, 'number', 'a number');
    equal(box.value, '24', 'showing the size the font is drawn at');
    equal(box.disabled, false, 'and enabled, because there is a face to draw again');

    messages.length = 0;
    box.value = '30';
    box.emit('change');
    const ask = messages.find((message) => message.type === 'resizeFont');
    ok(ask !== undefined, 'changing it asks the extension to redraw the face');
    equal(ask.fontId, 'DejaVu_24', 'for this font, not for a widget');
    equal(ask.pixelSize, 30, 'at the size that was typed');
});

test('the answer moves the declaration onto the new file and keeps the face', () => {
    const { root, messages, window } = boot();
    clockFontRow(root);

    messages.length = 0;
    window.emit('message', {
        data: { type: 'fontResized', fontId: 'DejaVu_24', src: 'assets/DejaVu_30-30.bdf', size: 30 },
    });
    const changed = messages.filter((message) => message.type === 'changed').pop();
    ok(changed !== undefined, 'the declaration is saved');
    const font = changed.document.fonts.find((candidate) => candidate.id === 'DejaVu_24');
    equal(font.src, 'assets/DejaVu_30-30.bdf', 'the font now names the redrawn file');
    equal(font.size, 30, 'and says what size it is');
    equal(font.source, 'assets/DejaVuSansMono.ttf', 'while still knowing the face it came from');
    equal(
        changed.document.widgets.find((widget) => widget.id === 'face').props.font,
        'DejaVu_24',
        'and the widget still names the same font, since only its drawing changed',
    );
});

test('the size box is disabled where there is nothing to redraw', () => {
    // A hand-made BDF is a bitmap with no face in the project: a size would mean scaling the pixels, and that is
    // how a font turns to mush. The box says why rather than pretending.
    const { root } = boot();
    const { row, select } = clockFontRow(root);
    select.value = 'hero';
    select.emit('change');

    const all = () => root.descendants();
    const afterRow = all().find(
        (element) =>
            element.classList.contains('asset-field') &&
            element.descendants().some((child) => child.tagName === 'SELECT' && child.value === 'hero'),
    );
    const box = sizeBoxOf(afterRow);
    equal(box.disabled, true, 'a font with no face behind it cannot be resized');
    ok((box.title ?? '').includes('bitmap'), 'and the tooltip says why');

    // A built-in face is not even a declaration: its size is the crate's.
    const builtIn = afterRow.children.find((child) => child.tagName === 'SELECT');
    builtIn.value = 'Vector(2)';
    builtIn.emit('change');
    const lastRow = all().find(
        (element) =>
            element.classList.contains('asset-field') &&
            element.descendants().some((child) => child.tagName === 'SELECT' && child.value === 'Vector(2)'),
    );
    equal(sizeBoxOf(lastRow).disabled, true, 'the crate\'s own fonts have no size to change');
});
