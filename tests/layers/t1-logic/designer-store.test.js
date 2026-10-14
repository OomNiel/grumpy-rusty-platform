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
const { loadDocument, renderDesign, missingAssets, planAssetImport, ASSET_DIRECTORY } = compiled('designer/store');
const { createDocument, defaultProps, defaultChildren, validateDocument, DESIGNER_FILE_VERSION } =
    compiled('designer/model');

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

// ------------------------------------------------- what a load has to tidy up

/** The checkbox that started this: one carrying the `style` property from before the appearance fields. */
function staleCheckbox() {
    return widget('gaugeRun', 'checkbox', { x: 68, y: 212, width: 78, height: 77 }, {
        label: 'Swing it!',
        checked: true,
        style: 'panel',
        box_width: 20,
    });
}

test('a property this version has no place for is dropped on load, and reported', () => {
    // Reported rather than tidied in silence: what was dropped was part of what the design said.
    const loaded = loadDocument(JSON.stringify(document([staleCheckbox()])));
    equal(loaded.error, undefined, 'the design still loads');
    equal(loaded.notes.length, 1, JSON.stringify(loaded.notes));
    contains(loaded.notes[0], '"gaugeRun"', 'the note names the widget');
    contains(loaded.notes[0], '"style"', 'and the property');
    contains(loaded.notes[0], 'checkbox', 'and says what the widget is');

    const kept = loaded.document.widgets[0];
    equal(kept.props.style, undefined, 'the property is gone');
    equal(kept.props.label, 'Swing it!', JSON.stringify(kept.props));
    equal(kept.props.box_width, 20, 'while the ones it does have are untouched');
    equal(kept.x, 68, 'and the widget itself is untouched');
    equal(kept.height, 77, 'in full');
});

test('dropping that property is what lets the markup be written at all', () => {
    // The failure this exists for: one unknown key fails the whole design, and a design that does not validate
    // never has its markup written -- so `src/ui.kdl` keeps the last save that worked while the canvas keeps
    // accepting edits, and the board shows an older design than the one on screen.
    const stale = document([staleCheckbox()]);
    equal(renderDesign(stale).kdl, undefined, 'as stored, no markup is written at all');
    contains(renderDesign(stale).problems.join('\n'), 'not a property of a checkbox', 'and this is why');

    const loaded = loadDocument(JSON.stringify(stale));
    equal(loaded.notes.length, 1, 'the load drops it');
    const rendered = renderDesign(loaded.document);
    equal(rendered.problems.length, 0, JSON.stringify(rendered.problems));
    ok(rendered.kdl !== undefined, 'so the markup is written again');
    contains(rendered.kdl, 'label="Swing it!"', 'with the label the canvas has, not the one the board had');
    notContains(rendered.documentJson, '"style": "panel"', 'and the file the user keeps is cleaned too');
});

test('a design with nothing to drop is handed back untouched and unreported', () => {
    // Every ordinary load. A note here would be noise, and its absence is how the caller knows not to write the
    // project's files again.
    const original = document([widget('go', 'button', { x: 8, y: 8, width: 96, height: 32 })]);
    const loaded = loadDocument(JSON.stringify(original));
    equal(loaded.notes, undefined, 'nothing to report');
    equal(JSON.stringify(loaded.document), JSON.stringify(original), 'and nothing changed');
});

test('only unknown keys go: a value this version disagrees with is left to be reported', () => {
    // A box wider than the maximum is a mistake to show, not junk to clear away -- dropping it would rewrite
    // the design into something the user never drew.
    const doc = document([widget('go', 'checkbox', { x: 8, y: 8, width: 96, height: 24 }, { box_width: 999 })]);
    const loaded = loadDocument(JSON.stringify(doc));
    equal(loaded.notes, undefined, 'nothing is dropped');
    equal(loaded.document.widgets[0].props.box_width, 999, 'the value stays');
    contains(validateDocument(loaded.document).join('\n'), 'Box width', 'for the panel to complain about');
});

test('a widget whose tag is gone keeps its properties, and is reported instead', () => {
    // A whole widget is someone's work rather than leftover configuration, so the pruner has no opinion about
    // a tag it does not know and the validator is left to explain it.
    const doc = document([widget('gone', 'not_a_widget', { x: 0, y: 0, width: 10, height: 10 }, { style: 'panel' })]);
    const loaded = loadDocument(JSON.stringify(doc));
    equal(loaded.notes, undefined, 'the pruner says nothing');
    equal(loaded.document.widgets[0].props.style, 'panel', 'so the widget keeps everything it had');
    contains(validateDocument(loaded.document).join('\n'), 'not one of the widgets', 'and the validator says why');
});

test('a version 1 design is migrated and pruned in the same pass', () => {
    const old = { ...document([staleCheckbox()]), version: 1 };
    delete old.fonts;
    const loaded = loadDocument(JSON.stringify(old));
    equal(loaded.error, undefined, 'it loads');
    equal(loaded.document.version, DESIGNER_FILE_VERSION, 'migrated');
    equal(loaded.document.fonts.length, 0, 'with its font list');
    equal(loaded.notes.length, 1, 'and tidied as well');
    equal(loaded.document.widgets[0].props.style, undefined, 'the stale property is gone');
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

test('an image read from the card is not looked for in the project', () => {
    // The file is on the SD card the firmware mounts, so asking the project's own asset check about it would
    // report every card image as missing -- which is exactly backwards.
    const onCard = document([
        widget('photo', 'image', { x: 0, y: 0, width: 96, height: 96 }, { src: 'sd:PIC1.BMP' }),
        widget('icon', 'icon', { x: 0, y: 96, width: 48, height: 48 }, { src: 'sd:LOGO.BMP' }),
        widget('shouted', 'image', { x: 0, y: 144, width: 96, height: 96 }, { src: 'SD:PHOTO.BMP' }),
    ]);
    equal(missingAssets(onCard, () => false).length, 0, 'a card path is not a project asset');
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

// ---------------------------------------------------------------- bringing a file in

test('a file already in the project is referenced where it is', () => {
    const plan = planAssetImport({
        chosen: '/home/me/proj/assets/logo.bmp',
        projectRoot: '/home/me/proj',
        taken: () => false,
    });
    equal(plan.relativePath, 'assets/logo.bmp', 'the path the design stores');
    equal(plan.copyFrom, undefined, 'and nothing is copied');
});

test('a file from outside is copied in rather than referenced', () => {
    // A path that climbs out of the project works until the folder moves, and then fails at build time with a
    // path nobody recognises. So it comes in.
    const plan = planAssetImport({
        chosen: '/home/me/Pictures/logo.bmp',
        projectRoot: '/home/me/proj',
        taken: () => false,
    });
    equal(plan.relativePath, `${ASSET_DIRECTORY}/logo.bmp`, 'it lands in assets/');
    equal(plan.copyFrom, '/home/me/Pictures/logo.bmp', 'and is copied from where it was');
});

test('a name already taken gains a number rather than replacing anything', () => {
    const taken = new Set(['assets/logo.bmp', 'assets/logo-2.bmp']);
    const plan = planAssetImport({
        chosen: '/home/me/Pictures/logo.bmp',
        projectRoot: '/home/me/proj',
        taken: (relative) => taken.has(relative),
    });
    equal(plan.relativePath, 'assets/logo-3.bmp', 'the next free name');
});

test('a name with no extension, and Windows separators, are both handled', () => {
    const bare = planAssetImport({
        chosen: '/home/me/Pictures/README',
        projectRoot: '/home/me/proj',
        taken: () => false,
    });
    equal(bare.relativePath, 'assets/README', 'no extension, no invented one');

    const windows = planAssetImport({
        chosen: 'C:\\Users\\me\\pics\\logo.bmp',
        projectRoot: 'C:\\Users\\me\\proj',
        taken: () => false,
        separator: '/',
    });
    equal(windows.relativePath, 'assets/logo.bmp', 'a Windows path still yields a markup path');

    const inside = planAssetImport({
        chosen: 'C:\\Users\\me\\proj\\assets\\logo.bmp',
        projectRoot: 'C:\\Users\\me\\proj',
        taken: () => false,
        separator: '/',
    });
    equal(inside.relativePath, 'assets/logo.bmp', 'and one inside the project is left alone');
});

test('the project folder itself is not mistaken for a file inside it', () => {
    // A prefix match on the string would say this is inside; it is not.
    const plan = planAssetImport({
        chosen: '/home/me/project-two/logo.bmp',
        projectRoot: '/home/me/project',
        taken: () => false,
    });
    equal(plan.relativePath, 'assets/logo.bmp', 'a sibling folder is outside, so the file is copied');
    equal(plan.copyFrom, '/home/me/project-two/logo.bmp', 'from where it was');
});
