'use strict';

/**
 * The Font list: what it offers, and removing a font from it.
 *
 * Two things can only be tested through the real bundle. The first is that a *declared* font is listed for every
 * widget that offers a Font field -- including the clock, whose numerals come from `style.font` and which used to
 * show the crate's own faces only, making an imported system font look like it had never arrived. The second is
 * the right-click menu: a font is removed from where it is chosen, and removing it takes the reference out of
 * every widget that named it, in one undo step.
 */

const path = require('path');
const { test, ok, equal, compiled, repoRoot } = require('../../lib/harness');
const dom = require('../../lib/dom');

const { starterDocument } = compiled('designer/generate');
const { defaultProps } = compiled('designer/model');

const BUNDLE = path.join(repoRoot(), 'out', 'webview', 'designer.js');

/** A design with one clock drawn with an imported font, and a second declared font nobody uses. */
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

const all = (root) => root.descendants();

/** Selects the clock and returns its Font list. */
function clockFontList(root) {
    all(root)
        .find((element) => element.tagName === 'CANVAS')
        .emit('pointerdown', { clientX: 202, clientY: 42, pointerId: 1, button: 0 });
    const select = all(root).find(
        (element) =>
            element.tagName === 'SELECT' &&
            element.descendants().some((option) => option.value === 'DejaVu_24'),
    );
    ok(select !== undefined, 'the clock\'s Font list offers the project font');
    return select;
}

test('a declared font is listed for a clock, named with the size it was drawn at', () => {
    // The clock reads only a style, so before this its list showed the crate's own faces and nothing else: an
    // imported font was in the design, invisible here, and the field read "(default)".
    const { root } = boot();
    const select = clockFontList(root);
    equal(select.value, 'DejaVu_24', 'the font the clock uses is the one shown');
    const option = select.descendants().find((candidate) => candidate.value === 'DejaVu_24');
    equal(option.textContent, 'DejaVu_24 (24 px)', 'and the size it was drawn at is named beside it');
    ok(
        select.descendants().some((candidate) => candidate.value === 'hero'),
        'a BDF with no face behind it is offered too',
    );
});

test('right-clicking the Font list offers to delete the font it names', () => {
    const { root, messages } = boot();
    const select = clockFontList(root);

    select.emit('contextmenu', { clientX: 40, clientY: 60 });
    const menu = all(root).find((element) => element.classList.contains('context-menu'));
    ok(menu !== undefined, 'a menu opens');
    const remove = menu.children.find((item) => item.textContent === 'Delete the font "DejaVu_24"');
    ok(remove !== undefined, 'with the font it was opened on named in it');
    ok(remove.classList.contains('danger'), 'and marked as destructive');

    messages.length = 0;
    remove.emit('click');
    const changed = messages.filter((message) => message.type === 'changed').pop();
    ok(changed !== undefined, 'the design is saved');
    equal(
        changed.document.fonts.some((font) => font.id === 'DejaVu_24'),
        false,
        'the declaration is gone',
    );
    equal(
        changed.document.widgets.find((widget) => widget.id === 'face').props.font,
        '',
        'and the widget that used it no longer names a font that is not there',
    );
    ok(
        changed.document.fonts.some((font) => font.id === 'hero'),
        'while a font nothing used is left alone',
    );
});

test('the menu only appears for a font this project declares', () => {
    // Nothing to delete for "(default)" or for a face built into the crate, so the browser's own menu is left
    // alone rather than replaced by a menu with nothing useful in it.
    const { root } = boot();
    const select = clockFontList(root);

    for (const value of ['', 'Vector(2)']) {
        select.value = value;
        select.emit('change');
        const list = all(root).find(
            (element) =>
                element.tagName === 'SELECT' &&
                element.descendants().some((option) => option.value === 'hero'),
        );
        list.emit('contextmenu', { clientX: 40, clientY: 60 });
        ok(
            !all(root).some((element) => element.classList.contains('context-menu')),
            `no menu for "${value === '' ? '(default)' : value}"`,
        );
    }
});
