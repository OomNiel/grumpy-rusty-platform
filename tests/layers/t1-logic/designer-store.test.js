'use strict';

/**
 * What the designer writes, and what it refuses to write.
 *
 * The rules here are about not losing work and not breaking a build, which is why they are worth testing
 * rather than reasoning about: the document is always written because it is the user's work, and the markup is
 * only written when the design validates, because the crate's macro reads it at compile time and a
 * half-finished canvas would turn every build into a codegen error instead of preserving the last thing that
 * worked.
 */

const { test, ok, notOk, equal, contains, notContains, compiled } = require('../../lib/harness');
const { loadDocument, renderDesign, missingAssets } = compiled('designer/store');
const { createDocument, defaultProps, defaultChildren, DESIGNER_FILE_VERSION } = compiled('designer/model');

function document(widgets = []) {
    const doc = createDocument({
        boardId: 'sunton-3248s035r',
        panelWidth: 320,
        panelHeight: 480,
        rotation: 0,
        screenId: 'Panel',
    });
    doc.widgets = widgets;
    return doc;
}

function widget(id, tag, box, props = {}) {
    return {
        id,
        tag,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        props: { ...defaultProps(tag), ...props },
        events: [],
        children: defaultChildren(tag),
        ...box,
    };
}

// ---------------------------------------------------------------- reading

test('an absent design is not an error: a new designer project starts empty', () => {
    const loaded = loadDocument('');
    equal(loaded.document, undefined, 'no document');
    equal(loaded.error, undefined, 'and nothing to complain about');
});

test('a design file that is not JSON is reported rather than ignored', () => {
    const loaded = loadDocument('{ this is not json');
    equal(loaded.document, undefined, 'no document');
    contains(loaded.error, 'not valid JSON', 'the reason');
});

test('a design from a future version is refused with the versions named', () => {
    const loaded = loadDocument(JSON.stringify({ ...document(), version: DESIGNER_FILE_VERSION + 1 }));
    equal(loaded.document, undefined, 'refused');
    contains(loaded.error, 'version', 'the reason mentions the version');
});

test('a design with the wrong shape is refused', () => {
    equal(loadDocument('[]').error !== undefined, true, 'an array is not a document');
    equal(loadDocument('null').error !== undefined, true, 'nor is null');
    equal(loadDocument('{"version":1}').error !== undefined, true, 'a document needs a board and widgets');
});

test('a valid design round-trips through the file format', () => {
    const original = document([widget('go', 'button', { x: 8, y: 8, width: 96, height: 32 })]);
    const loaded = loadDocument(JSON.stringify(original));
    equal(loaded.error, undefined, 'no error');
    equal(JSON.stringify(loaded.document), JSON.stringify(original), 'the document survives');
});

// ---------------------------------------------------------------- writing

test('a valid design is written as indented JSON plus markup', () => {
    const rendered = renderDesign(document([widget('go', 'button', { x: 8, y: 8, width: 96, height: 32 })]));
    equal(rendered.problems.length, 0, JSON.stringify(rendered.problems));
    contains(rendered.documentJson, '\n    ', 'the JSON is indented, so a diff is readable');
    ok(rendered.documentJson.endsWith('\n'), 'and newline-terminated');
    contains(rendered.kdl, 'button id="go"', 'the markup was generated');
});

test('an invalid design is still written, but its markup is not', () => {
    // The widget runs off the panel, which the grid mapping refuses outright.
    const rendered = renderDesign(document([widget('wide', 'rect', { x: 300, y: 0, width: 96, height: 48 })]));
    equal(rendered.kdl, undefined, 'no markup is written, so the last good build still builds');
    ok(rendered.problems.length > 0, 'but the problem is reported');
    contains(rendered.documentJson, '"wide"', 'and the work is not thrown away');
});

test('the document survives a problem that has nothing to do with geometry', () => {
    const rendered = renderDesign(document([widget('pick', 'dropdown', { x: 0, y: 0, width: 120, height: 28 })]));
    const bad = { ...rendered, problems: [] };
    ok(bad.documentJson.length > 0, 'the document is written first, whatever else happens');
});

// ---------------------------------------------------------------- assets

test('an asset that is not in the project is reported against its widget', () => {
    const withImage = document([widget('photo', 'image', { x: 0, y: 0, width: 96, height: 96 }, { src: 'assets/logo.bmp' })]);
    equal(missingAssets(withImage, () => true).length, 0, 'nothing to report when the file is there');
    const problems = missingAssets(withImage, () => false);
    equal(problems.length, 1, JSON.stringify(problems));
    contains(problems[0], '"photo"', 'the widget');
    contains(problems[0], 'assets/logo.bmp', 'the path');
});

test('a widget with no asset named yet is not reported as missing', () => {
    // The document validator already reports the empty required property; saying it twice helps nobody.
    const withImage = document([widget('photo', 'image', { x: 0, y: 0, width: 96, height: 96 })]);
    equal(missingAssets(withImage, () => false).length, 0, 'an empty src is the validator\'s business');
});

test('every part of a composite icon is checked', () => {
    const icon = widget('battery', 'icon', { x: 0, y: 0, width: 48, height: 48 });
    icon.children = {
        kind: 'parts',
        parts: [
            { src: 'assets/shell.bmp', x: 0, y: 0, visible: true, tint: '' },
            { src: 'assets/bolt.bmp', x: 0, y: 0, visible: true, tint: '' },
        ],
    };
    const exists = (path) => path === 'assets/shell.bmp';
    const problems = missingAssets(document([icon]), exists);
    equal(problems.length, 1, JSON.stringify(problems));
    contains(problems[0], 'bolt.bmp', 'the missing part');
    notContains(problems.join('\n'), 'shell.bmp', 'the present one is not mentioned');
});

// ---------------------------------------------------------------- fonts

test('a version 1 design is migrated rather than refused', () => {
    // Version 2 added the fonts list. The change is additive, so refusing the old file would throw away a
    // design for a field that did not exist when it was written.
    const old = { ...document([widget('go', 'button', { x: 8, y: 8, width: 96, height: 32 })]), version: 1 };
    delete old.fonts;
    const loaded = loadDocument(JSON.stringify(old));
    equal(loaded.error, undefined, 'it loads');
    equal(loaded.document.version, DESIGNER_FILE_VERSION, 'brought up to date');
    equal(loaded.document.fonts.length, 0, 'with an empty font list');
    equal(loaded.document.widgets.length, 1, 'and nothing else changed');
});

test('a document with no font list at all still loads', () => {
    const bare = { ...document(), version: DESIGNER_FILE_VERSION };
    delete bare.fonts;
    const loaded = loadDocument(JSON.stringify(bare));
    equal(loaded.error, undefined, 'an absent list is an empty one, not a broken file');
    equal(loaded.document.fonts.length, 0, 'normalised');
});

test('a font file that is not in the project is reported against the font', () => {
    const doc = document();
    doc.fonts = [{ id: 'title', src: 'assets/title.bdf', chars: 'AB' }];
    equal(missingAssets(doc, () => true).length, 0, 'nothing to report when the file is there');
    const problems = missingAssets(doc, () => false);
    equal(problems.length, 1, JSON.stringify(problems));
    contains(problems[0], '"title"', 'the font is named');
    contains(problems[0], 'assets/title.bdf', 'and so is the file');
});
