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
const { test, ok, notOk, equal, contains, compiled } = require('../../lib/harness');
const { repoRoot } = require('../../lib/harness');
const dom = require('../../lib/dom');

const { starterDocument } = compiled('designer/generate');
const { KDL_WIDGETS, widgetSpec, toolboxOffers } = compiled('designer/catalog');
const { createDocument, defaultChildren, defaultProps } = compiled('designer/model');

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
        .emit('pointerdown', { clientX: titleWidget.x + 2, clientY: titleWidget.y + 2, pointerId: 1, button: 0 });
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

    // The Toolbox is generated from the catalogue, so it holds one entry per tag the palette offers.
    // A tag in the catalogue but not in the toolbox is either one the codegen cannot produce
    // (`unavailable`) or one that is simply no longer handed out (`toolboxOffers`, which is what hides
    // the Time picker).
    const toolboxItems = all().filter((element) => element.classList.contains('toolbox-item'));
    const offered = KDL_WIDGETS.filter((widget) => toolboxOffers(widget.tag));
    equal(
        toolboxItems.length,
        offered.length,
        `every offered widget tag appears, catalogue has ${KDL_WIDGETS.length}`,
    );
    notOk(
        toolboxItems.some((item) => item.textContent === 'Time picker'),
        'the Time picker is not in the Toolbox',
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
    canvasElement.emit('pointerdown', { clientX: centreX, clientY: centreY, pointerId: 1, button: 0 });
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
    canvasElement.emit('pointerdown', { clientX: moved.x + 5, clientY: moved.y + 5, pointerId: 1, button: 0 });
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
            preventDefault() { },
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
        .emit('contextmenu', { clientX: label.x + 3, clientY: label.y + 3, preventDefault() { } });
    const secondMenu = all().find((element) => element.classList.contains('context-menu'));
    ok(secondMenu !== undefined, 'the menu opens again');
    secondMenu.children.find((item) => item.textContent === 'Duplicate').emit('click');
    const afterDuplicate = messages.filter((message) => message.type === 'changed').pop();
    ok(afterDuplicate !== undefined, 'duplicating posts a change');
    equal(afterDuplicate.document.widgets.length, before + 1, 'the design gained exactly one widget');
    equal(afterDuplicate.document.widgets[before].id, `${label.id}_2`, 'a copy of the one that was clicked');
});

test('a circle tool renders as an arc and edits through its own fields', () => {
    const { root, messages, window } = dom.install();
    // The bundle is cached by Node and binds its listeners to the window it first sees, so clear it so this
    // case boots a fresh panel against this stub.
    delete require.cache[require.resolve(BUNDLE)];
    require(BUNDLE);

    const doc = createDocument({
        boardId: 'sunton-035r',
        panelWidth: 320,
        panelHeight: 480,
        rotation: 3,
        screenId: 'Panel',
    });
    doc.widgets = [
        { id: 'dial', tag: 'circle', x: 100, y: 100, width: 64, height: 64, props: defaultProps('circle'), events: [] },
    ];

    const canvas = { width: 480, height: 320 };
    window.emit('message', {
        data: {
            type: 'init',
            document: doc,
            canvas,
            paths: { document: 'designer/panel.ui.json', kdl: 'src/ui.kdl' },
            touchBoard: false,
            touchEnabled: false,
        },
    });

    const all = () => root.descendants();
    const canvasElement = all().find((element) => element.tagName === 'CANVAS');
    ok(
        canvasElement.context.calls.some((call) => call.method === 'arc'),
        'the circle is painted with an arc call, not a rectangle',
    );

    // Pressing the circle selects it and rebuilds the property panel around the circle's own fields: centre and
    // radius geometry, then the four appearance properties -- and not the rectangle's X/Y/Width/Height.
    canvasElement.emit('pointerdown', { clientX: 132, clientY: 132, pointerId: 1, button: 0 });
    const labels = all()
        .filter((element) => element.classList.contains('field-label'))
        .map((element) => String(element.textContent));
    for (const name of ['Centre X', 'Centre Y', 'Radius', 'Line colour', 'Line thickness', 'Fill', 'Fill colour']) {
        ok(labels.includes(name), `the property panel offers ${name}`);
    }
    for (const name of ['X', 'Y', 'Width', 'Height']) {
        notOk(labels.includes(name), `the property panel does not offer ${name} for a circle`);
    }
});

test('rectangle, line and triangle paint their own primitive and edit through their field sheets', () => {
    const { root, messages, window } = dom.install();
    // The bundle binds its listeners to the window it first sees, so clear it so this case boots a fresh panel.
    delete require.cache[require.resolve(BUNDLE)];
    require(BUNDLE);

    const doc = createDocument({
        boardId: 'sunton-035r',
        panelWidth: 320,
        panelHeight: 480,
        rotation: 3,
        screenId: 'Panel',
    });
    doc.widgets = [
        { id: 'box', tag: 'rect', x: 100, y: 100, width: 64, height: 64, props: defaultProps('rect'), events: [] },
        { id: 'slash', tag: 'line', x: 200, y: 100, width: 64, height: 8, props: defaultProps('line'), events: [] },
        { id: 'pyr', tag: 'triangle', x: 300, y: 100, width: 48, height: 48, props: defaultProps('triangle'), events: [] },
    ];

    const canvas = { width: 480, height: 320 };
    window.emit('message', {
        data: {
            type: 'init',
            document: doc,
            canvas,
            paths: { document: 'designer/panel.ui.json', kdl: 'src/ui.kdl' },
            touchBoard: false,
            touchEnabled: false,
        },
    });

    const all = () => root.descendants();
    const canvasElement = all().find((element) => element.tagName === 'CANVAS');
    const calls = () => canvasElement.context.calls;
    // Each shape paints a call no other widget makes: a `rect` (radius-0 path) for the rectangle, a
    // `closePath` for the triangle; guides and the background fill with `fillRect` and stroke with `stroke`,
    // so none of those can stand in for a shape.
    ok(calls().some((call) => call.method === 'rect'), 'the rectangle is painted with a rect call');
    ok(calls().some((call) => call.method === 'closePath'), 'the triangle is painted as a closed path');
    ok(calls().some((call) => call.method === 'lineTo'), 'the line is painted as a segment');
    ok(!calls().some((call) => call.method === 'arc'), 'no circle is present, so no arc is painted');

    // Pressing each shape selects it and rebuilds the panel around that shape's own fields. A rectangle, line
    // and triangle all keep the ordinary geometry sheet (X/Y/Width/Height) and swap in their own colours and
    // corners -- never the circle's Centre/Radius controls.
    const labels = () =>
        all()
            .filter((element) => element.classList.contains('field-label'))
            .map((element) => String(element.textContent));
    const select = (x, y, label) => {
        canvasElement.emit('pointerdown', { clientX: x, clientY: y, pointerId: 1, button: 0 });
        const seen = labels();
        ok(seen.includes(label), `the panel offers ${label} for the selected shape`);
        for (const name of ['Centre X', 'Centre Y', 'Radius']) {
            notOk(seen.includes(name), `the panel does not offer ${name} for a non-circle shape`);
        }
    };
    select(132, 132, 'Corner radius');
    for (const name of ['Stroke width', 'Fill', 'Stroke', 'X', 'Y', 'Width', 'Height']) {
        ok(labels().includes(name), `the rectangle sheet offers ${name}`);
    }
    select(232, 104, 'Colour');
    for (const name of ['Stroke width', 'Colour', 'X', 'Y', 'Width', 'Height']) {
        ok(labels().includes(name), `the line sheet offers ${name}`);
    }
    select(324, 124, 'Stroke');
    for (const name of ['Stroke width', 'Fill', 'Stroke', 'X', 'Y', 'Width', 'Height']) {
        ok(labels().includes(name), `the triangle sheet offers ${name}`);
    }
});

test('a triangle paints its own points, and a point can be dragged wherever the pointer goes', () => {
    const { root, messages, window } = dom.install();
    delete require.cache[require.resolve(BUNDLE)];
    require(BUNDLE);

    const doc = createDocument({
        boardId: 'sunton-035r',
        panelWidth: 320,
        panelHeight: 480,
        rotation: 3,
        screenId: 'Panel',
    });
    // A right triangle -- the far top corner, not the isosceles default -- so the pixels it paints prove the
    // six offsets travelled from the document to the canvas and not merely that "a triangle was drawn".
    doc.widgets = [
        {
            id: 'pyr',
            tag: 'triangle',
            x: 100,
            y: 100,
            width: 48,
            height: 48,
            props: { ...defaultProps('triangle'), p1x: 1000, p1y: 0, p2x: 0, p2y: 1000, p3x: 1000, p3y: 1000 },
            events: [],
        },
    ];

    const canvas = { width: 480, height: 320 };
    window.emit('message', {
        data: {
            type: 'init',
            document: doc,
            canvas,
            paths: { document: 'designer/panel.ui.json', kdl: 'src/ui.kdl' },
            touchBoard: false,
            touchEnabled: false,
        },
    });

    const all = () => root.descendants();
    const canvasElement = all().find((element) => element.tagName === 'CANVAS');
    const called = (method) => canvasElement.context.calls.filter((call) => call.method === method).map((call) => call.args.join(','));
    // 1000 per-mille across a 48-pixel box is its *last* column -- pixel 147, not 148, because a box 48 pixels
    // wide ends at the 47th offset -- and 1000 down is its last row. So the apex is the box's top-right pixel
    // and the base runs along the bottom, which is exactly what the crate paints on the glass.
    ok(called('moveTo').includes('147,100'), `the apex is at the box's top right, got ${called('moveTo').join(' ')}`);
    ok(called('lineTo').includes('100,147'), 'the second point is the bottom left');
    ok(called('lineTo').includes('147,147'), 'and the third the bottom right');

    // Selecting it shows the six offsets as one group of fields, beside the ordinary geometry and colours.
    canvasElement.emit('pointerdown', { clientX: 120, clientY: 120, pointerId: 1, button: 0 });
    canvasElement.emit('pointerup', { clientX: 120, clientY: 120, pointerId: 1 });
    const labels = all()
        .filter((element) => element.classList.contains('field-label'))
        .map((element) => String(element.textContent));
    for (const name of ['Point 1 X', 'Point 1 Y', 'Point 2 X', 'Point 2 Y', 'Point 3 X', 'Point 3 Y']) {
        ok(labels.includes(name), `the triangle sheet offers ${name}`);
    }
    ok(
        all().some(
            (element) => element.classList.contains('field-group') && String(element.textContent).startsWith('Points'),
        ),
        'under one heading, so they read as three points',
    );
    for (const name of ['Stroke width', 'Fill', 'Stroke', 'X', 'Y', 'Width', 'Height']) {
        ok(labels.includes(name), `and it still offers ${name}`);
    }

    // Now grab the apex -- which shares its pixel with the box's north handle -- and drag it up and to the
    // right, outside the box it started in. The box has to follow, or a point could never reach the glass's
    // edges.
    messages.length = 0;
    canvasElement.emit('pointerdown', { clientX: 147, clientY: 100, pointerId: 2, button: 0 });
    canvasElement.emit('pointermove', { clientX: 180, clientY: 60, pointerId: 2 });
    canvasElement.emit('pointerup', { clientX: 180, clientY: 60, pointerId: 2 });
    const changed = messages.filter((message) => message.type === 'changed');
    ok(changed.length > 0, 'dragging a point posts a change');
    const moved = changed[changed.length - 1].document.widgets.find((widget) => widget.id === 'pyr');
    equal(`${moved.x},${moved.y}`, '100,60', 'the box grew up to the dragged point');
    equal(`${moved.width},${moved.height}`, '81,88', 'and reaches the other two, which have not moved');
    // The point landed on the pixel the pointer was on, which is the whole promise of the handle.
    const apexX = moved.x + Math.floor((moved.props.p1x * moved.width) / 1000);
    const apexY = moved.y + Math.floor((moved.props.p1y * moved.height) / 1000);
    equal(`${apexX},${apexY}`, '180,60', 'and it is where the user let go of it');
    // The offsets are relative to the box, so the second point's numbers change as the box grows -- what has
    // to hold is that its *pixel* has not: the other two points stay where the user left them, which is what
    // makes one point draggable without disturbing the shape's other corner.
    const second = {
        x: moved.x + Math.floor((moved.props.p2x * moved.width) / 1000),
        y: moved.y + Math.floor((moved.props.p2y * moved.height) / 1000),
    };
    equal(`${second.x},${second.y}`, '100,147', 'the second point is still on the pixel it was on');
});

// A middle-click on a widget asks for the code behind it: the handler for the widget's first event, which lives
// in the project's own `src/ui_handlers.rs`. Only the extension can open a file, so the panel's whole part is
// the message -- which is what is asserted here (2026-10-12).
test('a middle-click asks for the widget\'s handler, and only when it has one', () => {
    const { root, messages, window } = dom.install();
    // The bundle is cached by Node and binds its listeners to the window it first sees, so clear it.
    delete require.cache[require.resolve(BUNDLE)];
    require(BUNDLE);

    const document = starterDocument({
        boardId: 'sunton-3248s035r',
        panelWidth: 320,
        panelHeight: 480,
        rotation: 3,
    });
    window.emit('message', {
        data: {
            type: 'init',
            document,
            canvas: { width: 480, height: 320 },
            paths: { document: 'designer/panel.ui.json', kdl: 'src/ui.kdl' },
            touchBoard: true,
            touchEnabled: true,
        },
    });

    const all = () => root.descendants();
    const canvasElement = all().find((element) => element.tagName === 'CANVAS');
    const button = document.widgets.find((widget) => widget.id === 'go');
    // The starter's label raises nothing, so it is the case with no code behind it.
    const label = document.widgets.find((widget) => widget.id === 'title');

    messages.length = 0;
    canvasElement.emit('pointerdown', { clientX: button.x + 5, clientY: button.y + 5, pointerId: 1, button: 1 });
    canvasElement.emit('pointermove', { clientX: button.x + 40, clientY: button.y + 5, pointerId: 1 });
    ok(!messages.some((message) => message.type === 'changed'), 'the middle button does not drag the widget');

    canvasElement.emit('auxclick', {
        clientX: button.x + 5,
        clientY: button.y + 5,
        button: 1,
        preventDefault() { },
    });
    const asked = messages.filter((message) => message.type === 'action' && message.action === 'revealHandler');
    equal(asked.length, 1, 'the middle-click asks for the handler');
    equal(asked[0].widgetId, 'go', 'naming the widget under the pointer');

    messages.length = 0;
    canvasElement.emit('auxclick', {
        clientX: label.x + 2,
        clientY: label.y + 2,
        button: 1,
        preventDefault() { },
    });
    equal(messages.length, 0, 'a widget that raises no event has no handler to ask for');
});

// ---------------------------------------------------------------------------
// The WYSIWYG preview: the crate's paint, not the generic rounded rectangle.
//
// These drive the same real bundle, but read the canvas context's recorded calls. The stub records *method*
// calls only (`tests/lib/dom.js`), and a colour is delivered by a `fillStyle = …` assignment, so `boot`
// wraps the context once to record those assignments as `{method:'fillStyle', args:[colour]}` too -- which
// is what lets the gradient and accent assertions below read the colour that was in effect. The panel draws
// synchronously inside the init message, so the wrapper is removed again immediately.
// ---------------------------------------------------------------------------

/** Boots the built bundle against a fresh stub and returns the canvas and every recorded context call. */
function boot(doc) {
    const env = dom.install();
    const proto = dom.Element.prototype;
    const originalGetContext = proto.getContext;
    proto.getContext = function getContext(kind) {
        const context = originalGetContext.call(this, kind);
        if (kind !== '2d' || context === null) {
            return context;
        }
        return new Proxy(context, {
            set(target, property, value) {
                target.calls.push({ method: String(property), args: [value] });
                target[property] = value;
                return true;
            },
        });
    };
    try {
        delete require.cache[require.resolve(BUNDLE)];
        require(BUNDLE);
        env.window.emit('message', {
            data: {
                type: 'init',
                document: doc,
                canvas: { width: 480, height: 320 },
                paths: { document: 'designer/panel.ui.json', kdl: 'src/ui.kdl' },
                touchBoard: false,
                touchEnabled: false,
            },
        });
    } finally {
        proto.getContext = originalGetContext;
    }
    const canvas = env.root.descendants().find((element) => element.tagName === 'CANVAS');
    ok(canvas !== undefined, 'the panel made a canvas');
    return { ...env, canvas, calls: canvas.context.calls };
}

/** One widget at a fixed origin, sized as the catalogue sizes it. */
function widgetOf(tag, overrides = {}, children = undefined) {
    const size = widgetSpec(tag)?.defaultSize ?? { width: 96, height: 24 };
    return {
        id: 'probe',
        tag,
        x: 40,
        y: 60,
        width: size.width,
        height: size.height,
        props: { ...defaultProps(tag), ...overrides },
        events: [],
        children,
    };
}

/** A one-widget document, so every recorded call belongs to that widget. */
function documentWith(widget) {
    const doc = createDocument({
        boardId: 'sunton-035r',
        panelWidth: 320,
        panelHeight: 480,
        rotation: 3,
        screenId: 'Panel',
    });
    doc.widgets = [widget];
    return doc;
}

/** Every `fillRect` the calls contain. */
function fillRects(calls) {
    return calls.filter((call) => call.method === 'fillRect');
}

/** The colour of the `fillStyle` in effect at the given call index. */
function fillColourAt(calls, index) {
    for (let i = index; i >= 0; i -= 1) {
        if (calls[i].method === 'fillStyle') {
            return calls[i].args[0];
        }
    }
    return undefined;
}

/** The white a widget's text is drawn in (`Rgb565::WHITE`); nothing else paints white fills. */
const TEXT_WHITE = 'rgb(255,255,255)';

/** The `fillRect` calls whose fillStyle is `colour`, so a dithering shadow cannot stand in for text. */
function fillsWithColour(calls, colour) {
    return calls.filter((call, index) => call.method === 'fillRect' && fillColourAt(calls, index) === colour);
}

test('a slider grip sits at the left track end at min, the right end at max, and moves with value', () => {
    // The grip fills the block's inner height (28 here: the widget is 160x28 with no border or padding) and is
    // eight pixels wide unless the design names a width (`render_slider`, `widgets/mod.rs`). The one-pixel
    // track is `style.text`; the grip is `style.accent`.
    const gripX = (value, width = 8) => {
        const { calls } = boot(documentWith(widgetOf('slider', { min: 0, max: 100, value, knob_width: width })));
        const grip = fillRects(calls).filter((call) => call.args[2] === width && call.args[3] === 28);
        equal(grip.length, 1, `exactly one grip at value ${value}`);
        return grip[0].args[0];
    };
    equal(gripX(0), 40, 'at min the grip is flush with the inner left edge');
    equal(gripX(100), 40 + 160 - 8, 'at max the grip reaches the inner right edge');
    equal(gripX(50), 40 + Math.trunc((160 - 8) / 2), 'and at the midpoint it is halfway along');
    ok(gripX(50) > gripX(0) && gripX(50) < gripX(100), 'it moves with the value rather than sitting still');
    // A wider grip keeps the same travel rule, so it still sits flush at both ends.
    equal(gripX(100, 20), 40 + 160 - 20, 'a twenty-pixel grip stops at the same right edge');
    equal(gripX(0, 20), 40, 'and starts at the same left edge');
});

test('a progress bar fills in proportion to value, and not at all at zero', () => {
    // `render_progress` fills `inner` with `style.foreground` (WHITE in Normal) to `w * clamp(value)`
    // (preview-spec.md §4.7). The default progress style paints no block, so this is the only bar.
    const fillWidths = (value) => {
        const { calls } = boot(documentWith(widgetOf('progress', { value })));
        return fillRects(calls)
            .filter((call) => call.args[3] === 20 && call.args[2] > 0)
            .map((call) => call.args[2]);
    };
    equal(fillWidths(0), [], 'nothing is filled at zero');
    equal(fillWidths(0.25), [40], 'a quarter of 160 is 40');
    equal(fillWidths(0.5), [80], 'half is 80');
    equal(fillWidths(1), [160], 'and the whole width at one');
});

test('a toggle track uses the accent when checked and the dark track when not', () => {
    // `render_toggle` draws a fixed track at the right whose colour is the state (preview-spec.md §4.4):
    // accent new(0,42,31) when on, new(7,10,10) when off.
    const trackColour = (checked) => {
        const { calls } = boot(documentWith(widgetOf('toggle', { checked })));
        const index = calls.findIndex((call) => call.method === 'fillRect' && call.args[2] === 16 && call.args[3] === 26);
        ok(index !== -1, `the toggle draws its 16x26 track (checked: ${checked})`);
        return fillColourAt(calls, index);
    };
    equal(trackColour(true), 'rgb(0,170,255)', 'checked is the accent from Style::new()');
    equal(trackColour(false), 'rgb(57,40,82)', 'unchecked is the crate\'s own dark track');
    notOk(trackColour(false) === trackColour(true), 'the knob follows checked rather than staying one colour');
});

test('a button draws the crate gradient and its own text', () => {
    const { calls } = boot(documentWith(widgetOf('button', { text: 'Ok' })));
    const colours = calls.filter((call) => call.method === 'fillStyle').map((call) => call.args[0]);
    // Style::button()'s vertical gradient new(6,12,16) -> new(2,4,8) (preview-spec.md §2.2, §4.3), expanded
    // to 24-bit the way the packed pixel is.
    ok(colours.includes('rgb(49,48,132)'), 'the gradient\'s first stop is painted');
    ok(colours.includes('rgb(16,16,66)'), 'and its last stop');
    // Medium4x7 is a bitmap font: one canvas pixel per set bit (preview-spec.md §1.4). The white colour
    // separates text from the button's black dithered shadow, which also draws 1x1 pixels.
    const glyphs = fillsWithColour(calls, TEXT_WHITE).filter((call) => call.args[2] === 1 && call.args[3] === 1);
    ok(glyphs.length > 0, 'the button text is drawn as white glyph pixels');
    ok(
        glyphs.every((call) => call.args[0] >= 40 && call.args[0] < 40 + 96 && call.args[1] >= 60 && call.args[1] < 60 + 32),
        'and its pixels are inside the button',
    );
});

test('a label draws no block background, only its text', () => {
    const { calls } = boot(documentWith(widgetOf('label', { text: 'Hi' })));
    const fills = fillRects(calls);
    notOk(
        fills.some((call) => call.args[0] === 40 && call.args[1] === 60 && call.args[2] === 96 && call.args[3] === 24),
        'Style::label() has no background, so the whole rect is not filled',
    );
    const glyphs = fillsWithColour(calls, TEXT_WHITE).filter(
        (call) =>
            call.args[2] === 1 &&
            call.args[3] === 1 &&
            call.args[0] >= 40 &&
            call.args[0] < 40 + 96 &&
            call.args[1] >= 60 &&
            call.args[1] < 60 + 24,
    );
    ok(glyphs.length > 0, 'the label text is drawn');
    ok(glyphs.length < 40, 'as glyph pixels, not a painted block');
});

test('a table draws the header row as the first row, then the body rows', () => {
    // The corrected emitter passes the design's header row first and then the body rows, and the renderer has
    // no separate header concept (preview-spec.md §4.10 + the follow-up correction). The default table has
    // two headers and two body rows; every cell is stroked and its text drawn.
    const { calls } = boot(documentWith(widgetOf('table', {}, defaultChildren('table'))));
    const textRowsAt = (top) =>
        fillsWithColour(calls, TEXT_WHITE).filter(
            (call) =>
                call.args[2] === 1 &&
                call.args[3] === 1 &&
                call.args[1] >= top &&
                call.args[1] < top + 5,
        );
    // `Style::panel()` insets the rect by padding 2 + border 1, so the first row's text starts at y = 63;
    // three rows share the 114-pixel inner height at 38 pixels each.
    ok(textRowsAt(63).length > 0, 'the header row is drawn first');
    ok(textRowsAt(63 + 38).length > 0, 'then the first body row');
    ok(textRowsAt(63 + 76).length > 0, 'then the second');
});

test('a Vector font draws the crate\'s own polylines, not bitmap pixels', () => {
    // Vector(n) uses `vectorGlyph`'s points, scaled by n and stroked as one-pixel segments (preview-spec.md
    // §1.4). A bitmap font would emit fillRects inside the glyph box instead; the vector path must not.
    const { calls } = boot(documentWith(widgetOf('label', { text: 'A', font: 'Vector(2)' })));
    // The canvas grid also strokes `lineTo`s, but it runs the full width/height, so only a segment with both
    // endpoints inside the label's own box can be the glyph.
    const glyphLines = calls.filter(
        (call) =>
            call.method === 'lineTo' &&
            call.args[0] >= 40 &&
            call.args[0] < 40 + 96 &&
            call.args[1] >= 60 &&
            call.args[1] < 60 + 24,
    );
    ok(glyphLines.length > 0, 'the vector glyph is stroked as a polyline inside its box');
    const glyphBox = fillRects(calls).filter(
        (call) => call.args[0] >= 40 && call.args[0] < 40 + 96 && call.args[1] >= 60 && call.args[1] < 60 + 24,
    );
    equal(glyphBox.length, 0, 'and no bitmap pixel of it is filled');
});

// ---------------------------------------------------------------------------
// The verdict at load.
//
// A design that does not validate has no markup written, so the board goes on compiling an older design than
// the canvas shows. The user has to be told that as the panel opens, not after their first edit: a value this
// version disagrees with reaches here -- an unknown *key* is dropped on the way in instead, which is the other
// half of the same problem.
// ---------------------------------------------------------------------------

test('a design that does not validate says so as it opens', () => {
    const env = dom.install();
    delete require.cache[require.resolve(BUNDLE)];
    require(BUNDLE);

    env.window.emit('message', {
        data: {
            type: 'init',
            document: starterDocument({
                boardId: 'sunton-3248s035r',
                panelWidth: 320,
                panelHeight: 480,
                rotation: 3,
            }),
            canvas: { width: 480, height: 320 },
            paths: { document: 'designer/panel.ui.json', kdl: 'src/ui.kdl' },
            touchBoard: false,
            touchEnabled: false,
            loadNotes: ['"gaugeRun": "style" is not a property of a checkbox any more'],
            loadProblems: ['"probe": Box width is above the maximum of 64'],
        },
    });

    const find = (tag) => env.root.descendants().find((element) => element.tagName === tag);
    const footer = find('FOOTER');
    contains(footer.textContent, '1 problem', 'the footer says the design is not valid');
    contains(footer.textContent, 'Box width', 'and names the first problem');

    const listed = (className) =>
        env.root.descendants().find((element) => element.classList.contains(className));
    const problems = listed('problem-list');
    ok(problems !== undefined, 'the whole list is shown under the properties');
    equal(problems.children.length, 1, 'one item per problem');

    // What the load tidied up has its own list, and it is *not* the footer: that is one clipped line, and the
    // load that dropped a property is exactly the one whose board was compiling an older design.
    const notes = listed('load-notes');
    ok(notes !== undefined, 'and what the load dropped is listed too');
    contains(notes.children[0].textContent, '"style"', 'naming the property it removed');

    // And the problems go when they are fixed. The list is rebuilt on every verdict, so a problem the design no
    // longer has cannot stay on screen for the rest of the session. The load's own note is not a verdict on an
    // edit, so a save must leave it alone.
    env.window.emit('message', { data: { type: 'report', problems: [], kdl: 'screen id="RustyPanel" {}' } });
    equal(listed('problem-list'), undefined, 'fixed, so nothing is listed any more');
    contains(find('FOOTER').textContent, 'Saved', 'and the footer says the markup was written');
    ok(listed('load-notes') !== undefined, 'while the note about the load stays put');
});


// ---------------------------------------------------------------------------
// Every widget that offers a Font responds to it on the canvas.
//
// The canvas is the designer's promise: what it draws is what the board draws. A Font field that changes
// nothing here is worse than a missing field, because the design looks finished. Three widgets drew their
// text in a hard-coded `Tiny3x5` (the status bar, the time picker and the number picker), three more read
// a bare `Style::panel()` instead of the widget's own style (the dropdown, the table and the dialog), and
// the spinbox measured with the crate's fixed four-pixel cell while the runtime forks had moved to the
// font's own advance. So the assertion is per widget: two fonts, two different drawings.
// ---------------------------------------------------------------------------

/** The tags whose catalogue entry offers a Font -- the set the user is looking at. */
const FONT_TAGS = KDL_WIDGETS.filter((spec) => spec.props.some((property) => property.kind === 'font')).map(
    (spec) => spec.tag,
);

/** What the canvas drew, as one comparable string: every recorded context call and its arguments. */
function paintOf(tag, font) {
    const { calls } = boot(documentWith(widgetOf(tag, { font, message: 'Body text' }, defaultChildren(tag))));
    return calls.map((call) => `${call.method}(${call.args.join(',')})`).join(';');
}

test('the font-capable widget list is the catalogue\'s own, not a copy', () => {
    ok(FONT_TAGS.length >= 14, `expected every font-capable tag, found ${FONT_TAGS.length}`);
    for (const tag of ['label', 'button', 'dropdown', 'time_picker', 'number_picker', 'status_bar', 'table']) {
        ok(FONT_TAGS.includes(tag), `${tag} offers a Font and belongs in this check`);
    }
});

test('every widget with a Font field paints differently when the font changes', () => {
    for (const tag of FONT_TAGS) {
        // Same design twice, one field changed. A widget that draws no text at all cannot satisfy this,
        // which is the point: every one of these tags has text on the glass.
        notOk(
            paintOf(tag, 'Tiny3x5') === paintOf(tag, 'Medium4x7'),
            `${tag} drew exactly the same pixels for two different fonts, so its Font field does nothing`,
        );
    }
});

test('and the same font paints the same pixels twice', () => {
    // The guard on the test above: if the canvas were non-deterministic, "the pixels differ" would prove
    // nothing. One widget is enough to show that the comparison means what it says.
    equal(paintOf('time_picker', 'Medium4x7'), paintOf('time_picker', 'Medium4x7'));
});

test('naming a font changes nothing for the widgets whose base already uses it', () => {
    // `fonts.ts` says picking `Tiny3x5` is the same as picking nothing: both `Style::new()` and
    // `Style::label()` start there. The one exception is the button, whose own base is
    // `Style::button()` -- `Medium4x7` -- and that is asserted too, because it is the widget whose default
    // font is *not* the crate's smallest and so the one where "no font chosen" must not mean "Tiny3x5".
    for (const tag of FONT_TAGS) {
        if (tag === 'button') {
            notOk(paintOf(tag, 'Tiny3x5') === paintOf(tag, ''), 'a button\'s own base is Medium4x7');
            continue;
        }
        equal(paintOf(tag, 'Tiny3x5'), paintOf(tag, ''), `${tag} draws the same with its default font named`);
    }
});

test('the toolbar offers SD and SMTP as switches, and posts what was flipped', () => {
    // Two project settings are cargo features -- the card's FAT filesystem and the SMTP keep-alive client --
    // so they are on/off switches, not a menu of values. The bundle is driven for real: the switch's
    // `<input>` is the control, and the message it posts is the contract with the extension.
    const env = dom.install();
    delete require.cache[require.resolve(BUNDLE)];
    require(BUNDLE);
    env.window.emit('message', {
        data: {
            type: 'init',
            document: starterDocument({ boardId: 'sunton-3248s035r', panelWidth: 320, panelHeight: 480, rotation: 3 }),
            canvas: { width: 480, height: 320 },
            paths: { document: 'designer/panel.ui.json', kdl: 'src/ui.kdl' },
            touchBoard: true,
            touchEnabled: false,
            sdBoard: true,
            sdEnabled: true,
            smtpAvailable: true,
            smtpEnabled: false,
        },
    });

    const labelFor = (name) => env.root
        .descendants()
        .find((element) => element.className.split(' ').includes('tool-toggle')
            && element.descendants().some((child) => child.textContent === name && child.className.includes('tool-toggle-label')));
    const inputOf = (label) => label.descendants().find((element) => element.tagName === 'INPUT');

    const sd = labelFor('SD');
    const smtp = labelFor('SMTP');
    ok(sd !== undefined, 'the SD setting is a switch');
    ok(smtp !== undefined, 'and so is SMTP');
    ok(sd.descendants().some((element) => element.className.includes('tool-toggle-track')),
        'the switch is drawn as a track and thumb, not a checkbox glyph');
    equal(inputOf(sd).checked, true, 'SD starts from the manifest: on');
    equal(inputOf(smtp).checked, false, 'SMTP starts from the manifest: off');
    equal(inputOf(smtp).disabled, false, 'and is usable because src/smtp.rs exists');

    env.messages.length = 0;
    const smtpInput = inputOf(smtp);
    smtpInput.checked = true;
    smtpInput.emit('change');
    equal(env.messages.at(-1).type, 'setSmtp', 'flipping SMTP asks the extension to write the feature');
    equal(env.messages.at(-1).enabled, true);

    const sdInput = inputOf(labelFor('SD'));
    sdInput.checked = false;
    sdInput.emit('change');
    equal(env.messages.at(-1).type, 'setSd');
    equal(env.messages.at(-1).enabled, false);

    // Without src/smtp.rs there is nothing for the feature to compile in, so the switch is refused by the
    // extension and comes back disabled -- the report is what the toolbar follows.
    env.window.emit('message', { data: { type: 'report', problems: [], smtpAvailable: false, smtpEnabled: false } });
    equal(inputOf(labelFor('SMTP')).disabled, true, 'no module means no switch to flip');
});

test('the toolbar offers a brightness slider only for a panel with a backlight pin', () => {
    // Brightness is a range, not a switch, and it is a project setting like touch and SD. Two rules are
    // asserted: the control exists only when the panel has a BL pin, and it posts a message only when the
    // thumb is *released* -- a drag must not rewrite the config file on every pixel.
    const boot = (extra) => {
        const env = dom.install();
        delete require.cache[require.resolve(BUNDLE)];
        require(BUNDLE);
        env.window.emit('message', {
            data: {
                type: 'init',
                document: starterDocument({ boardId: 'esp32-devkitc', panelWidth: 240, panelHeight: 240, rotation: 3 }),
                canvas: { width: 240, height: 240 },
                paths: { document: 'designer/panel.ui.json', kdl: 'src/ui.kdl' },
                touchBoard: false,
                touchEnabled: false,
                ...extra,
            },
        });
        const label = env.root
            .descendants()
            .find((element) => element.className.split(' ').includes('tool-slider'));
        return { env, label };
    };

    const { env, label } = boot({ backlight: true, backlightPwm: true, brightness: 60 });
    ok(label !== undefined, 'the setting is offered');
    ok(
        label.descendants().some((element) => element.textContent === 'Brightness'),
        'and it is named',
    );
    const input = label.descendants().find((element) => element.tagName === 'INPUT');
    equal(input.type, 'range');
    equal(input.min, '0');
    equal(input.max, '100');
    equal(input.value, '60', 'the slider starts from the project config');
    equal(input.disabled, false);
    ok(
        label.descendants().some((element) => element.textContent === '60%'),
        'the value is spelled out beside the thumb',
    );

    // Dragging updates the reading and writes nothing; releasing asks the extension to write the line.
    env.messages.length = 0;
    input.value = '25';
    input.emit('input');
    equal(env.messages.length, 0, 'a drag writes nothing to the project');
    ok(
        label.descendants().some((element) => element.textContent === '25%'),
        'but the reading follows the thumb',
    );
    input.emit('change');
    equal(env.messages.at(-1).type, 'setBrightness');
    equal(env.messages.at(-1).percent, 25);

    // A report with the manifest's own value moves the slider, the same way the switches follow theirs.
    env.window.emit('message', { data: { type: 'report', problems: [], brightness: 80 } });
    const moved = env.root
        .descendants()
        .find((element) => element.className.split(' ').includes('tool-slider'))
        .descendants()
        .find((element) => element.tagName === 'INPUT');
    equal(moved.value, '80', 'the slider follows the file, not the click');

    // A project whose firmware still holds the pin on gets the control disabled, with the reason on it.
    const older = boot({ backlight: true, backlightPwm: false, brightness: 100 });
    const olderInput = older.label.descendants().find((element) => element.tagName === 'INPUT');
    equal(olderInput.disabled, true, 'the setting cannot reach a firmware that does not read it');
    contains(older.label.title, 'src/main.rs', 'and the tooltip says why');

    // No BL pin wired: no control at all, rather than one that writes a line nothing can act on.
    const bare = boot({ backlight: false, brightness: 100 });
    equal(bare.label, undefined, 'a panel with no backlight pin has no brightness to set');
});

test('a two-view design gets view tabs, and a navigate event gets a destination picker', () => {
    // The two halves of the views feature the user actually touches. Both are built from the document, so what
    // is asserted is what the panel put on screen and what it posted back when it was used.
    const { root, messages, window } = dom.install();
    // A fresh DOM needs a fresh module: the bundle captures the shell's root when it loads, so a cached copy
    // would keep painting into the previous test's document.
    delete require.cache[require.resolve(BUNDLE)];
    require(BUNDLE);

    const design = starterDocument({
        boardId: 'sunton-3248s035r',
        panelWidth: 320,
        panelHeight: 480,
        rotation: 3,
    });
    design.views = [
        { id: 'main', label: 'Main' },
        { id: 'settings', label: 'Settings' },
    ];
    const button = design.widgets.find((widget) => widget.tag === 'button');
    button.view = 'settings';
    button.events = ['navigate'];
    button.props.navigate_to = 'main';

    window.emit('message', {
        data: {
            type: 'init',
            document: design,
            canvas: { width: 480, height: 320 },
            paths: { document: 'designer/panel.ui.json', kdl: 'src/ui.kdl' },
            touchBoard: true,
            touchEnabled: true,
        },
    });

    const all = () => root.descendants();
    // The `+` is a `.view-tab` too -- the same shape, so the strip looks like one row of tabs -- so the strip is
    // the tabs that are not the add button.
    const tabs = all().filter(
        (element) => element.classList.contains('view-tab') && !element.classList.contains('view-tab-add'),
    );
    equal(
        tabs.map((tab) => tab.textContent),
        ['Main', 'Settings'],
        'one tab per view, in the design’s own order',
    );
    const active = all().filter((element) => element.classList.contains('view-tab-active'));
    equal(active.length, 1, 'exactly one tab is the one being edited');
    equal(active[0].textContent, 'Main', 'and the design starts on its first view');
    ok(
        all().some((element) => element.classList.contains('view-tab-add')),
        'with a way to add another',
    );

    // The button is on the other view, so the tab has to be switched before it can be selected.
    tabs[1].emit('click');
    const moved = all().find((element) => element.classList.contains('view-tab-active'));
    equal(moved.textContent, 'Settings', 'clicking a tab edits that view');

    const canvas = all().find((element) => element.tagName === 'CANVAS');
    canvas.emit('pointerdown', { clientX: button.x + 4, clientY: button.y + 4, pointerId: 1, button: 0 });
    canvas.emit('pointerup', { clientX: button.x + 4, clientY: button.y + 4, pointerId: 1, button: 0 });

    // The row is found by its label, because the stub DOM does not reflect a chosen `<option>` into the
    // `<select>`'s value the way a browser does.
    const row = all().find(
        (element) =>
            element.classList.contains('field') &&
            element.descendants().some((child) => child.textContent === 'Goes to view'),
    );
    ok(row !== undefined, 'the navigate event shows the view it goes to');
    const picker = row.descendants().find((element) => element.tagName === 'SELECT');
    ok(picker !== undefined, 'as a picker rather than a handler name');
    equal(
        picker
            .descendants()
            .filter((element) => element.tagName === 'OPTION')
            .map((option) => option.value),
        ['main', 'settings'],
        'offering every view of the design',
    );

    messages.length = 0;
    picker.value = 'settings';
    picker.emit('change');
    const posted = messages.filter((message) => message.type === 'changed').pop();
    ok(posted !== undefined, 'picking a destination posts a change');
    const edited = posted.document.widgets.find((widget) => widget.tag === 'button');
    equal(edited.props.navigate_to, 'settings', 'with the view that was picked');
});
