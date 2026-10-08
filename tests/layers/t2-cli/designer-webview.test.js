'use strict';

/**
 * The designer's frontend, run for real: a built bundle, a stub DOM, and the messages it posts back.
 *
 * This is the one part of the feature that no other layer touches. Everything else -- the model, the grid
 * mapping, the markup, the generated Rust -- runs in tests or on the board, but the panel is a browser
 * bundle, and "it compiles and it typechecks" is a weak claim about code that builds a Toolbox out of a
 * catalogue, turns a pointer into a drag, rebuilds a property panel and posts a document.
 *
 * So the bundle in `out/` is loaded the way the webview loads it and driven through a session: the init
 * message, a pointer press and drag on the canvas, and a keystroke. The assertions are on what it *told the
 * extension*, because that is the contract that decides what gets written to the project.
 */

const path = require('path');
const { test, ok, equal, contains, compiled } = require('../../lib/harness');
const { repoRoot } = require('../../lib/harness');
const dom = require('../../lib/dom');

const { starterDocument } = compiled('designer/generate');
const { KDL_WIDGETS } = compiled('designer/catalog');

const BUNDLE = path.join(repoRoot(), 'out', 'webview', 'designer.js');

test('the designer panel boots, builds itself from the catalogue, and posts its edits', () => {
    const { root, messages, window } = dom.install();

    // The webview loads the bundle; it has to run on its own, look up its shell and ask for a document.
    require(BUNDLE);
    equal(messages.length, 1, 'booting posts exactly one message');
    equal(messages[0].type, 'ready', 'and it is the one that asks for the document');

    // The extension's answer, for a landscape CYD design with one button on it.
    const document = starterDocument({
        boardId: 'sunton-3248s035r',
        panelWidth: 320,
        panelHeight: 480,
        rotation: 3,
    });
    // Give the design a font, declared on the screen and used by the title, so the panel's font UI has
    // something to show.
    document.fonts = [{ id: 'title', src: 'assets/title.bdf', chars: 'AB' }];
    document.widgets.find((widget) => widget.id === 'title').props.font = 'title';

    const canvas = { width: 480, height: 320 };
    window.emit('message', {
        data: {
            type: 'init',
            document,
            canvas,
            paths: { document: 'designer/panel.ui.json', kdl: 'src/ui.kdl' },
            touchBoard: true,
            // Off to begin with, so the toolbar shows it and dropping a control has something to turn on.
            touchEnabled: false,
        },
    });

    const all = () => root.descendants();

    // The screen form is where fonts are declared, and it shows the one the design has.
    ok(
        all().some((element) => element.value === 'title'),
        'the declared font is in the screen form',
    );
    ok(
        all().some((element) => element.value === 'assets/title.bdf'),
        'with its file',
    );

    // The picker: a path field has a browse button, which asks the extension -- it is the only side that can
    // open a dialog or know the project folder -- and the answer comes back as an edit the panel makes itself,
    // so the change lands in the document and its undo history like any other.
    const browse = all().find((element) => element.tagName === 'BUTTON' && element.textContent === '\u2026');
    ok(browse !== undefined, 'the font file field offers a browse button');
    messages.length = 0;
    browse.emit('click');
    const request = messages.find((message) => message.type === 'pickAsset');
    ok(request !== undefined, 'clicking it asks the extension to choose a file');
    equal(request.kind, 'font', 'for the kind of asset that field wants');

    window.emit('message', {
        data: { type: 'assetPicked', requestId: request.requestId, path: 'assets/other.bdf' },
    });
    const afterPick = messages.filter((message) => message.type === 'changed').pop();
    ok(afterPick !== undefined, 'the answer is applied through the panel');
    equal(afterPick.document.fonts[0].src, 'assets/other.bdf', 'and the field names the chosen file');

    // A cancellation changes nothing, and a refusal says so.
    messages.length = 0;
    browse.emit('click');
    const second = messages.find((message) => message.type === 'pickAsset');
    window.emit('message', { data: { type: 'assetPicked', requestId: second.requestId } });
    equal(
        messages.filter((message) => message.type === 'changed').length,
        0,
        'a cancelled dialog leaves the design alone',
    );

    // A widget that uses a font gets a dropdown, not a text box: a widget names a declaration, and a name the
    // markup cannot resolve is dropped without a word. The list is grouped, because there are two routes to a
    // font and only one of them is a file in the project.
    const titleWidget = document.widgets.find((widget) => widget.id === 'title');
    all()
        .find((element) => element.tagName === 'CANVAS')
        .emit('pointerdown', { clientX: titleWidget.x + 2, clientY: titleWidget.y + 2, pointerId: 1 });
    const fontSelect = all().find(
        (element) =>
            element.tagName === 'SELECT' &&
            element.descendants().some((option) => option.textContent === 'title'),
    );
    ok(fontSelect !== undefined, 'the Font property offers the declared fonts');
    equal(fontSelect.value, 'title', 'showing the one this widget uses');
    ok(
        fontSelect.descendants().some((option) => option.textContent === '(default)'),
        'and a way back to the default font',
    );
    ok(
        fontSelect.descendants().some((option) => option.value === 'Vector(2)'),
        'the crate\'s own fonts are offered too, since a style expression can select them',
    );
    // The `...` on a font property declares a font from a file and selects it, rather than making the user
    // add a declaration in the Fonts list first and come back.
    const fontRow = all().find(
        (element) =>
            element.classList.contains('asset-field') &&
            element.descendants().some((child) => child === fontSelect),
    );
    const fontBrowse = fontRow?.descendants().find((child) => child.textContent === '\u2026');
    ok(fontBrowse !== undefined, 'and the font property has its own file browser');
    messages.length = 0;
    fontBrowse.emit('click');
    const fontPick = messages.find((message) => message.type === 'pickAsset');
    equal(fontPick.kind, 'font', 'which asks for a font file');
    window.emit('message', {
        data: { type: 'assetPicked', requestId: fontPick.requestId, path: 'assets/hero.bdf' },
    });
    const afterFontPick = messages.filter((message) => message.type === 'changed').pop();
    ok(
        afterFontPick.document.fonts.some((font) => font.id === 'hero' && font.src === 'assets/hero.bdf'),
        'and the chosen file becomes a declaration named after it',
    );
    equal(
        afterFontPick.document.widgets.find((widget) => widget.id === 'title').props.font,
        'hero',
        'selected on the widget that asked for it',
    );

    // Hover help: a property row carries its description as a tooltip.
    const explained = all().filter((element) => typeof element.title === 'string' && element.title.length > 0);
    ok(explained.length > 0, 'fields carry a hover description');
    ok(
        explained.some((element) => element.title.includes('The words it shows')),
        'including the description of the text property',
    );

    // The Toolbox is generated from the catalogue, so it holds one entry per tag that can actually be built.
    // The tags the crate's codegen cannot produce are in the catalogue but not in the toolbox.
    const toolboxItems = all().filter((element) => element.classList.contains('toolbox-item'));
    const usable = KDL_WIDGETS.filter((widget) => widget.unavailable === undefined);
    equal(
        toolboxItems.length,
        usable.length,
        `every buildable widget tag is offered, catalogue has ${KDL_WIDGETS.length}`,
    );
    ok(
        toolboxItems.some((item) => item.textContent === 'Button'),
        'and they are the catalogue\'s labels',
    );

    // The canvas is the board's own panel at the designed rotation, and it was drawn.
    const canvasElement = all().find((element) => element.tagName === 'CANVAS');
    ok(canvasElement !== undefined, 'there is a canvas element');
    equal(canvasElement.width, canvas.width, 'sized to the design, not to the window');
    equal(canvasElement.height, canvas.height, 'on both axes');
    ok(canvasElement.context !== undefined, 'a 2D context was taken');
    ok(canvasElement.context.calls.length > 0, 'and something was drawn on it');

    // A press on the button selects it, and the property panel follows.
    const button = document.widgets.find((widget) => widget.id === 'go');
    const centreX = button.x + Math.floor(button.width / 2);
    const centreY = button.y + Math.floor(button.height / 2);
    canvasElement.emit('pointerdown', { clientX: centreX, clientY: centreY, pointerId: 1 });
    ok(
        all().some((element) => element.value === 'go'),
        'the property panel shows the pressed widget',
    );
    ok(
        all().some((element) => element.value === 'Press me'),
        'with its text in a field',
    );

    // A drag moves it, and the panel tells the extension the whole document -- not a diff, because the
    // extension's job is to validate and write, and a diff would let the two disagree.
    messages.length = 0;
    canvasElement.emit('pointermove', { clientX: centreX + 30, clientY: centreY + 10, pointerId: 1 });
    canvasElement.emit('pointerup', { clientX: centreX + 30, clientY: centreY + 10, pointerId: 1 });
    const changed = messages.filter((message) => message.type === 'changed');
    ok(changed.length > 0, 'a drag posts a change');
    const moved = changed[changed.length - 1].document.widgets.find((widget) => widget.id === 'go');
    equal(moved.x, button.x + 30, 'the widget moved by the drag');
    equal(moved.y, button.y + 10, 'on both axes');

    // The keyboard: Delete removes the selection, and that is a change too.
    messages.length = 0;
    window.emit('keydown', { key: 'Delete', target: null, ctrlKey: false, metaKey: false });
    const afterDelete = messages.filter((message) => message.type === 'changed');
    ok(afterDelete.length > 0, 'Delete posts a change');
    equal(
        afterDelete[afterDelete.length - 1].document.widgets.some((widget) => widget.id === 'go'),
        false,
        'and the widget is gone from the document it posts',
    );

    // Undo has to bring it back, because that is the whole point of the undo stack being in the panel.
    messages.length = 0;
    window.emit('keydown', { key: 'z', target: null, ctrlKey: true, metaKey: false, shiftKey: false });
    const afterUndo = messages.filter((message) => message.type === 'changed');
    ok(afterUndo.length > 0, 'undo posts a change');
    equal(
        afterUndo[afterUndo.length - 1].document.widgets.some((widget) => widget.id === 'go'),
        true,
        'and the widget is back',
    );

    // The toolbar carries the touch setting beside the rotation, since both are compile-time settings asked
    // about in the wizard and changeable later.
    const touchSelect = all().find(
        (element) =>
            element.tagName === 'SELECT' &&
            element.children.some((option) => option.textContent === 'Touch: off'),
    );
    ok(touchSelect !== undefined, 'the toolbar offers the touch setting');
    equal(touchSelect.value, 'false', 'showing what the project is built with');

    messages.length = 0;
    touchSelect.value = 'true';
    touchSelect.emit('change');
    const turnedOn = messages.find((message) => message.type === 'setTouch');
    ok(turnedOn !== undefined, 'changing it tells the extension');
    equal(turnedOn.enabled, true, 'with the new value');

    // And turning it back off, so the auto-enable below has something to do.
    messages.length = 0;
    touchSelect.value = 'false';
    touchSelect.emit('change');
    equal(messages.find((message) => message.type === 'setTouch').enabled, false, 'and off again');

    // Clicking a Toolbox entry (the way in for anyone who cannot drag) drops a widget on the canvas.
    messages.length = 0;
    const labelEntry = all().find(
        (element) => element.classList.contains('toolbox-item') && element.textContent === 'Label',
    );
    ok(labelEntry !== undefined, 'the Toolbox offers a Label');
    labelEntry.emit('click');
    const afterAdd = messages
        .filter((message) => message.type === 'changed')
        .pop();
    ok(afterAdd !== undefined, 'adding posts a change');
    equal(afterAdd.document.widgets.length, 3, 'the design gained a widget');
    const added = afterAdd.document.widgets[afterAdd.document.widgets.length - 1];
    equal(added.tag, 'label', 'of the kind that was clicked');
    ok(added.width > 0 && added.height > 0, 'with the default size the catalogue gives it');

    // Dropping a control that raises events turns touch on by itself: a button that can never be pressed is
    // worse than a setting changed for you. A label, which raises nothing, must not.
    const buttonEntry = all().find(
        (element) => element.classList.contains('toolbox-item') && element.textContent === 'Button',
    );
    ok(buttonEntry !== undefined, 'the Toolbox offers a Button');
    messages.length = 0;
    buttonEntry.emit('click');
    const autoEnabled = messages.find((message) => message.type === 'setTouch');
    ok(autoEnabled !== undefined, 'dropping a button turns touch on');
    equal(autoEnabled.enabled, true, 'because a button is a control that needs it');

    messages.length = 0;
    const secondLabel = all().find(
        (element) => element.classList.contains('toolbox-item') && element.textContent === 'Label',
    );
    secondLabel.emit('click');
    equal(
        messages.filter((message) => message.type === 'setTouch').length,
        0,
        'and a label, which raises nothing, does not',
    );

    // And editing a property -- the point of the panel on the right -- posts the new value. Adding a widget
    // selected it, so the button has to be selected again first, which is also what a user would do.
    canvasElement.emit('pointerdown', { clientX: moved.x + 5, clientY: moved.y + 5, pointerId: 1 });
    const textField = all().find((element) => element.value === 'Press me');
    ok(textField !== undefined, 'the button text is in a field');
    messages.length = 0;
    textField.value = 'Hello';
    textField.emit('change');
    const afterEdit = messages
        .filter((message) => message.type === 'changed')
        .pop();
    ok(afterEdit !== undefined, 'editing a field posts a change');
    equal(
        afterEdit.document.widgets.find((widget) => widget.id === 'go').props.text,
        'Hello',
        'with the value that was typed',
    );
    // Right-clicking a placed control offers the per-widget actions, so the layer list is not the only way to
    // reach them.
    const menuButton = afterUndo[afterUndo.length - 1].document.widgets.find((widget) => widget.id === 'go');
    all()
        .find((element) => element.tagName === 'CANVAS')
        .emit('contextmenu', {
            clientX: menuButton.x + 5,
            clientY: menuButton.y + 5,
            preventDefault() {},
        });
    const menu = all().find((element) => element.classList.contains('context-menu'));
    ok(menu !== undefined, 'a right-click opens a menu');
    const entries = menu.children.map((item) => item.textContent);
    equal(entries.join(', '), 'Duplicate, Bring forward, Send backward, Delete', 'with the four actions');
    ok(
        menu.children[menu.children.length - 1].classList.contains('danger'),
        'and Delete is marked as the destructive one',
    );

    // Delete, from the menu.
    messages.length = 0;
    menu.children.find((item) => item.textContent === 'Delete').emit('click');
    const afterMenuDelete = messages.filter((message) => message.type === 'changed').pop();
    ok(afterMenuDelete !== undefined, 'the menu posts a change');
    equal(
        afterMenuDelete.document.widgets.some((widget) => widget.id === 'go'),
        false,
        'and the widget is gone',
    );
    equal(
        all().some((element) => element.classList.contains('context-menu')),
        false,
        'the menu closes behind it',
    );

    // Duplicate, from the menu: the copy lands beside the original and gets its own name. Counted relative to
    // what is there now, so this reads the same wherever the block sits in the session.
    messages.length = 0;
    const before = afterMenuDelete.document.widgets.length;
    const label = afterMenuDelete.document.widgets.find((widget) => widget.tag === 'label');
    all()
        .find((element) => element.tagName === 'CANVAS')
        .emit('contextmenu', { clientX: label.x + 3, clientY: label.y + 3, preventDefault() {} });
    const secondMenu = all().find((element) => element.classList.contains('context-menu'));
    ok(secondMenu !== undefined, 'the menu opens again');
    secondMenu.children.find((item) => item.textContent === 'Duplicate').emit('click');
    const afterDuplicate = messages.filter((message) => message.type === 'changed').pop();
    ok(afterDuplicate !== undefined, 'duplicating posts a change');
    equal(afterDuplicate.document.widgets.length, before + 1, 'the design gained exactly one widget');
    equal(afterDuplicate.document.widgets[before].id, `${label.id}_2`, 'a copy of the one that was clicked');
});
