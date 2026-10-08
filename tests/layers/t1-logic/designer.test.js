'use strict';

/**
 * The WYSIWYG designer's model, catalogue and markup emitter.
 *
 * The promise a WYSIWYG designer makes is that what is on the canvas is what appears on the glass. The markup
 * it emits has no absolute positioning, so that promise rests on one piece of arithmetic -- turning rectangles
 * into grid tracks and back -- and these tests are mostly about that: for every fixture, resolving the
 * emitted grid has to give the original rectangles back *exactly*, not approximately. The catalogue tests are
 * the other half: a property default that disagrees with the crate's parser produces markup that builds to
 * different pixels than the canvas showed, so the values that were read off `parser.rs` are pinned here.
 */

const { test, ok, notOk, equal, contains, notContains, throws, compiled } = require('../../lib/harness');
const { KDL_WIDGETS, EVENT_SPECS, DESIGNER_EVENTS, widgetSpec, widgetRaises, toolboxGroups, CATEGORY_LABELS, widgetAddressable, propertyHelp, widgetHelp } =
    compiled('designer/catalog');
const { layoutToGrid, resolveGrid, trackSpec, describeGrid, GRID_FILLER } = compiled('designer/grid');
const {
    DESIGNER_FILE_VERSION,
    DESIGNER_DOCUMENT_PATH,
    DESIGNER_KDL_PATH,
    createDocument,
    defaultProps,
    defaultChildren,
    designCanvasSize,
    placeWidget,
    rustFieldName,
    screenIdFrom,
    uniqueWidgetId,
    validateDocument,
} = compiled('designer/model');
const { emitKdl, layoutDocument } = compiled('designer/kdl');
const { fontConstName } = compiled('designer/model');

/** The CYD's panel, which is the board the designer is developed against. */
const PANEL = { boardId: 'sunton-3248s035r', panelWidth: 320, panelHeight: 480 };

function document(rotation = 0, widgets = []) {
    const doc = createDocument({
        boardId: PANEL.boardId,
        panelWidth: PANEL.panelWidth,
        panelHeight: PANEL.panelHeight,
        rotation,
        screenId: 'Panel',
    });
    doc.widgets = widgets;
    return doc;
}

/** A widget with the catalogue's own defaults, so a fixture only states what it is testing. */
function widget(id, tag, box, extra = {}) {
    return {
        id,
        tag,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        props: defaultProps(tag),
        events: [],
        children: defaultChildren(tag),
        ...box,
        ...extra,
    };
}

/**
 * Every `UiEvent` variant that names a widget, copied from `embedded-gui-0.2.7/src/input.rs`.
 *
 * Pinned as data rather than imported, because it is the crate's vocabulary and the point of the test is to
 * fail if the designer starts offering an event the crate cannot deliver.
 */
const UI_EVENT_VARIANTS = [
    'Pressed',
    'Released',
    'Clicked',
    'DoubleClicked',
    'LongPressed',
    'Opened',
    'Closed',
    'ValueChanged',
    'Gesture',
    'TextInput',
    'Focused',
    'Defocused',
    'Scroll',
    'LayoutChanged',
    'StyleChanged',
];

/**
 * The thirty KDL tags `parse_widget` matches, from the same list the catalogue was built from. A tag missing
 * here means the Toolbox is hiding a widget the crate supports; an extra one means it offers markup that will
 * not build.
 */
const PARSER_TAGS = [
    'label',
    'button',
    'toggle',
    'checkbox',
    'slider',
    'dropdown',
    'roller',
    'scale',
    'spinbox',
    'progress',
    'arc',
    'busy_wheel',
    'chart',
    'status_bar',
    'time_picker',
    'number_picker',
    'dialog',
    'content_indicator',
    'crumbs',
    'panel',
    'image',
    'carousel',
    'icon',
    'mesh',
    'spacer',
    'path',
    'rect',
    'line',
    'circle',
    'table',
];

// ---------------------------------------------------------------- the catalogue

test('the catalogue carries every tag the parser accepts, and no others', () => {
    const tags = KDL_WIDGETS.map((w) => w.tag);
    equal(tags.length, PARSER_TAGS.length, 'tag count');
    for (const tag of PARSER_TAGS) {
        ok(tags.includes(tag), `the Toolbox is missing ${tag}`);
    }
    for (const tag of tags) {
        ok(PARSER_TAGS.includes(tag), `${tag} is offered but the parser does not know it`);
    }
});

test('every alias resolves to its canonical widget', () => {
    const aliases = {
        banner: 'label',
        progress_bar: 'progress',
        sweeping_arc: 'arc',
        gauge: 'scale',
        spinner: 'busy_wheel',
        plotter: 'chart',
        bitmap: 'image',
        composite_icon: 'icon',
        card: 'panel',
        crumbs_indicator: 'crumbs',
        mesh3d: 'mesh',
        rectangle: 'rect',
        vector_path: 'path',
    };
    for (const [alias, canonical] of Object.entries(aliases)) {
        const spec = widgetSpec(alias);
        ok(spec !== undefined, `${alias} should resolve`);
        equal(spec.tag, canonical, `${alias} should resolve to ${canonical}`);
    }
});

test('every offered event is a UiEvent the crate really carries', () => {
    for (const event of DESIGNER_EVENTS) {
        const spec = EVENT_SPECS[event];
        ok(spec !== undefined, `${event} has no event spec`);
        ok(UI_EVENT_VARIANTS.includes(spec.variant), `${event} maps to ${spec.variant}, which UiEvent has no variant for`);
    }
});

test('every event a widget claims to raise has a spec and is offered somewhere', () => {
    for (const spec of KDL_WIDGETS) {
        for (const event of spec.events) {
            ok(EVENT_SPECS[event] !== undefined, `${spec.tag} raises ${event}, which has no spec`);
            ok(DESIGNER_EVENTS.includes(event), `${spec.tag} raises ${event}, which the property panel never offers`);
        }
    }
});

test('no widget offers an event it cannot receive', () => {
    // A label, a panel and the shapes are display-only, and the parser reads no input for them.
    for (const tag of ['label', 'panel', 'rect', 'line', 'circle', 'spacer', 'progress', 'status_bar']) {
        equal(widgetSpec(tag).events.length, 0, `${tag} should raise nothing`);
    }
    ok(widgetRaises('button', 'clicked'), 'a button clicks');
    notOk(widgetRaises('button', 'valueChanged'), 'a button has no value to change');
    ok(widgetRaises('toggle', 'valueChanged'), 'a toggle changes value');
    ok(widgetRaises('slider', 'valueChanged'), 'a slider changes value');
});

test('the defaults are the parser\'s own unwrap_or values, including the surprising ones', () => {
    const props = (tag) => Object.fromEntries(widgetSpec(tag).props.map((p) => [p.name, p.defaultValue]));

    // Read off `parse_widget` in embedded-gui-codegen 0.2.7. The ones here are the values that differ from
    // what an invented default would have been.
    equal(props('spinbox').max, 9999, 'spinbox max');
    equal(props('spinbox').digits, 4, 'spinbox digits');
    equal(props('number_picker').max, 100, 'number_picker max');
    equal(props('arc').end_angle, 270, 'arc end angle');
    equal(props('status_bar').time, '12:00', 'status_bar time is text, not a number');
    equal(props('scale').minor_ticks, 2, 'scale minor ticks');
    equal(props('scale').mode, 'radial', 'scale mode');
    equal(props('carousel').pulse, 255, 'carousel pulse is a number');
    equal(props('carousel').indicator, false, 'carousel indicator');
    equal(props('carousel').item_step, 16, 'carousel item step');
    equal(props('image').fit, 'stretch', 'image fit');
    equal(props('mesh').shading, 'solid', 'mesh shading');
    equal(props('dialog').title, 'Alert', 'dialog title');
    equal(props('slider').value, 0, 'slider value starts at its minimum');
    equal(props('busy_wheel').active, true, 'a busy wheel starts spinning');
    equal(props('toggle').checked, false, 'toggle checked');
});

test('the closed vocabularies match what the emitter branches on', () => {
    const options = (tag, name) => widgetSpec(tag).props.find((p) => p.name === name).options;
    // The palette maps "radial" to Radial and "linear_vertical" to LinearVertical, everything else to
    // LinearHorizontal; "center" to Center and everything else to Stretch; "top_left" to TopLeft, else Center.
    equal(options('scale', 'mode').join(','), 'radial,linear_vertical,linear_horizontal', 'gauge modes');
    equal(options('image', 'fit').join(','), 'stretch,center', 'image fits');
    equal(options('icon', 'align').join(','), 'center,top_left', 'icon aligns');
    equal(options('chart', 'mode').join(','), 'line,bar', 'chart modes');
});

test('the two widgets the parser refuses without an asset are marked required', () => {
    const required = (tag) => widgetSpec(tag).props.filter((p) => p.required === true).map((p) => p.name);
    equal(required('image').join(','), 'src', 'image src');
    equal(required('mesh').join(','), 'src', 'mesh src');
    equal(required('label').length, 0, 'a label has nothing required');
});

test('the five widgets with a body declare the grammar the parser reads', () => {
    const grammars = { dropdown: 'options', roller: 'options', carousel: 'options', table: 'table', icon: 'parts' };
    for (const [tag, grammar] of Object.entries(grammars)) {
        equal(widgetSpec(tag).children, grammar, `${tag} grammar`);
    }
    equal(widgetSpec('icon').requiresChildren, true, 'an icon cannot be built without a part');
    equal(widgetSpec('panel').children, undefined, 'a panel has no body in the markup');
});

test('the only widget the parser cannot name is the spacer', () => {
    // `parse_widget` builds `WidgetDef::Spacer` with no id, so the generated `Widgets` struct has no field
    // for it and `absolute_rect` can never be asked where it went. Found by the simulator, which tried.
    const unaddressable = KDL_WIDGETS.filter((widget) => !widgetAddressable(widget.tag)).map((widget) => widget.tag);
    equal(unaddressable.join(','), 'spacer', 'exactly one widget has no id in codegen');
});

test('the shapes that do not paint themselves are marked, so a canvas cannot lie about them', () => {
    // Measured from `emitter.rs`: a rect and a circle become `gui.add_panel(cells[i], Style::panel())` with
    // their own radius and stroke width only in a trailing comment, and a line becomes `gui.add_spacer`. A
    // designer that painted the fill the user picked would be showing something the board will not draw.
    const draws = (tag) => widgetSpec(tag).draws ?? 'widget';
    equal(draws('rect'), 'panel', 'a rectangle is a theme panel');
    equal(draws('circle'), 'panel', 'so is a circle');
    equal(draws('line'), 'nothing', 'a line draws nothing');
    equal(draws('spacer'), 'nothing', 'neither does a spacer');
    equal(draws('button'), 'widget', 'a button is drawn for real');
    equal(draws('panel'), 'widget', 'and so is a panel');

    for (const tag of ['rect', 'circle', 'line']) {
        for (const property of widgetSpec(tag).props) {
            ok(
                property.ignoredByCodegen === true,
                `${tag}.${property.name} has no effect in codegen and should say so`,
            );
        }
        ok(typeof widgetSpec(tag).note === 'string', `${tag} should carry the caveat the UI shows`);
    }
});

test('the Toolbox groups every widget, and only into known categories', () => {
    const groups = toolboxGroups();
    const total = groups.reduce((sum, group) => sum + group.widgets.length, 0);
    equal(total, KDL_WIDGETS.length, 'every widget appears exactly once');
    for (const group of groups) {
        equal(group.label, CATEGORY_LABELS[group.category], `${group.category} label`);
        ok(group.widgets.length > 0, `${group.category} should not be an empty group`);
    }
});

// ---------------------------------------------------------------- the grid mapping

/**
 * Fixtures chosen so that a mistake has somewhere to show: shared edges, a widget flush against both edges,
 * a widget fully inside another's span, coincident positions on one axis only, and a single widget.
 */
const GRID_FIXTURES = [
    { name: 'nothing but a header bar', rects: [{ x: 0, y: 0, width: 320, height: 40 }] },
    {
        name: 'flush to both edges',
        rects: [
            { x: 0, y: 0, width: 320, height: 40 },
            { x: 0, y: 440, width: 320, height: 40 },
        ],
    },
    {
        name: 'a widget inside another\'s span',
        rects: [
            { x: 0, y: 0, width: 320, height: 200 },
            { x: 100, y: 50, width: 40, height: 30 },
        ],
    },
    {
        name: 'odd coordinates, which is where rounding would show',
        rects: [
            { x: 17, y: 33, width: 43, height: 29 },
            { x: 61, y: 7, width: 5, height: 5 },
        ],
    },
    {
        name: 'sharing every edge but one',
        rects: [
            { x: 0, y: 0, width: 100, height: 100 },
            { x: 100, y: 0, width: 100, height: 100 },
            { x: 200, y: 0, width: 100, height: 100 },
        ],
    },
    {
        name: 'one on each corner',
        rects: [
            { x: 0, y: 0, width: 20, height: 20 },
            { x: 300, y: 0, width: 20, height: 20 },
            { x: 0, y: 460, width: 20, height: 20 },
            { x: 300, y: 460, width: 20, height: 20 },
        ],
    },
    {
        name: 'a full-screen background with a row of buttons',
        rects: [
            { x: 0, y: 0, width: 320, height: 480 },
            { x: 8, y: 8, width: 96, height: 32 },
            { x: 112, y: 8, width: 96, height: 32 },
            { x: 216, y: 8, width: 96, height: 32 },
        ],
    },
];

test('every fixture survives the round trip through tracks and spans', () => {
    for (const fixture of GRID_FIXTURES) {
        const canvas = designCanvasSize(PANEL.panelWidth, PANEL.panelHeight, 0);
        const layout = layoutToGrid(fixture.rects, canvas.width, canvas.height);
        const resolved = resolveGrid(layout);
        equal(resolved.length, fixture.rects.length, `${fixture.name}: widget count`);
        for (let i = 0; i < fixture.rects.length; i += 1) {
            const want = fixture.rects[i];
            const got = resolved[i];
            equal(
                `${got.x},${got.y},${got.width},${got.height}`,
                `${want.x},${want.y},${want.width},${want.height}`,
                `${fixture.name}: widget ${i} came back as ${describeGrid(layout)}`,
            );
        }
    }
});

test('the tracks always cover the canvas exactly, so nothing is left outside the grid', () => {
    for (const fixture of GRID_FIXTURES) {
        const canvas = designCanvasSize(PANEL.panelWidth, PANEL.panelHeight, 0);
        const layout = layoutToGrid(fixture.rects, canvas.width, canvas.height);
        equal(layout.cols.reduce((a, b) => a + b, 0), canvas.width, `${fixture.name}: columns`);
        equal(layout.rows.reduce((a, b) => a + b, 0), canvas.height, `${fixture.name}: rows`);
    }
});

test('every track that carries geometry is a pixel track', () => {
    // The one exception is the zero-width filler, which exists because a grid with no fractional track at all
    // dies on the board -- see GRID_FILLER. It must be the *last* token, and there must be exactly one.
    const layout = layoutToGrid([{ x: 17, y: 33, width: 43, height: 29 }], 320, 480);
    const tokens = trackSpec(layout.cols).split(' ');
    equal(tokens.length, layout.cols.length + 1, 'one token per track, plus the filler');
    for (const token of tokens.slice(0, -1)) {
        ok(token.endsWith('px'), `a geometry track must be in pixels, got ${token}`);
    }
    equal(tokens[tokens.length - 1], GRID_FILLER, 'and the filler comes last');
    notContains(trackSpec(layout.cols), 'auto', 'no automatic track is ever emitted');

    // Asking for the geometry alone still gives pixels only, which is what the round trip is asserted against.
    const bare = trackSpec(layout.cols, false);
    equal(bare.split(' ').length, layout.cols.length, 'one token per track when the filler is left off');
    equal(bare, '17px 43px 260px', 'and they are the edges the design produced');
});

test('a single widget yields exactly the edges it has, and nothing more', () => {
    const layout = layoutToGrid([{ x: 17, y: 33, width: 43, height: 29 }], 320, 480);
    // x edges {0, 17, 60, 320} -> three columns; y edges {0, 33, 62, 480} -> three rows.
    equal(layout.cols.join(','), '17,43,260', 'columns');
    equal(layout.rows.join(','), '33,29,418', 'rows');
    equal(JSON.stringify(layout.placements[0]), JSON.stringify({ col: 1, row: 1, colSpan: 1, rowSpan: 1 }));
});

test('an empty canvas still produces a well-formed, single-track grid', () => {
    const layout = layoutToGrid([], 320, 480);
    equal(layout.cols.join(','), '320', 'columns');
    equal(layout.rows.join(','), '480', 'rows');
    equal(layout.placements.length, 0, 'no placements');
});

test('impossible geometry is refused rather than clipped', () => {
    const canvas = designCanvasSize(PANEL.panelWidth, PANEL.panelHeight, 0);
    throws(() => layoutToGrid([{ x: 0, y: 0, width: 0, height: 10 }], canvas.width, canvas.height), 'zero width');
    throws(() => layoutToGrid([{ x: 0, y: 0, width: 10, height: -1 }], canvas.width, canvas.height), 'negative height');
    throws(() => layoutToGrid([{ x: -1, y: 0, width: 10, height: 10 }], canvas.width, canvas.height), 'negative origin');
    throws(() => layoutToGrid([{ x: 315, y: 0, width: 10, height: 10 }], canvas.width, canvas.height), 'past the right edge');
    throws(() => layoutToGrid([{ x: 0, y: 475, width: 10, height: 10 }], canvas.width, canvas.height), 'past the bottom edge');
    throws(() => layoutToGrid([{ x: 0.5, y: 0, width: 10, height: 10 }], canvas.width, canvas.height), 'half a pixel');
});

// ---------------------------------------------------------------- the document

test('the designed canvas turns with the panel, as mipidsi turns its drawing area', () => {
    equal(
        `${designCanvasSize(320, 480, 0).width}x${designCanvasSize(320, 480, 0).height}`,
        '320x480',
        'no rotation',
    );
    equal(
        `${designCanvasSize(320, 480, 2).width}x${designCanvasSize(320, 480, 2).height}`,
        '320x480',
        '180 degrees does not swap the axes',
    );
    for (const rotation of [1, 3]) {
        const canvas = designCanvasSize(320, 480, rotation);
        equal(`${canvas.width}x${canvas.height}`, '480x320', `${rotation}: 90 and 270 swap the axes`);
    }
});

test('the generated field name follows the crate\'s own to_snake_case, warts included', () => {
    // `parser.rs:941`. The capital loses its case without a separator being remembered, and only spaces and
    // dashes become underscores -- so "MyBtn" and "my_btn" really do become the same field.
    const cases = {
        go: 'go',
        MyBtn: 'my_btn',
        my_btn: 'my_btn',
        'my btn': 'my_btn',
        'btn-1': 'btn_1',
        Title2: 'title2',
        A: 'a',
        '': '',
    };
    for (const [input, expected] of Object.entries(cases)) {
        equal(rustFieldName(input), expected, `rustFieldName(${JSON.stringify(input)})`);
    }
});

test('two ids that would collide in the generated struct are refused', () => {
    const problems = validateDocument(
        document(0, [widget('MyBtn', 'button', { x: 0, y: 0 }), widget('my_btn', 'button', { x: 0, y: 50 })]),
    );
    equal(problems.length, 1, `expected one problem, got ${JSON.stringify(problems)}`);
    contains(problems[0], 'my_btn', 'the collision names the field');
});

test('a fresh widget gets an id that is not taken', () => {
    const doc = document(0, [widget('button', 'button'), widget('button_2', 'button')]);
    equal(uniqueWidgetId(doc, 'button'), 'button_3', 'the next free suffix');
    equal(uniqueWidgetId(doc, 'label'), 'label', 'an unused tag is its own id');
});

test('a dropped widget is slid back inside the canvas, not shrunk', () => {
    const canvas = designCanvasSize(PANEL.panelWidth, PANEL.panelHeight, 0);
    const spec = widgetSpec('button').defaultSize;
    const bottomRight = placeWidget('button', 318, 478, canvas);
    equal(`${bottomRight.width}x${bottomRight.height}`, `${spec.width}x${spec.height}`, 'the size is the catalogue default');
    equal(bottomRight.x, canvas.width - spec.width, 'x is pushed back inside');
    equal(bottomRight.y, canvas.height - spec.height, 'y is pushed back inside');
    const negative = placeWidget('button', -20, -20, canvas);
    equal(`${negative.x},${negative.y}`, '0,0', 'a negative drop lands at the origin');
});

test('a valid document has nothing to report', () => {
    const doc = document(0, [
        widget('title', 'label', { x: 8, y: 8, width: 200, height: 24 }),
        widget('go', 'button', { x: 8, y: 40, width: 96, height: 32, events: ['clicked'] }),
        widget('level', 'slider', { x: 8, y: 80, width: 200, height: 28, events: ['valueChanged'] }),
    ]);
    equal(validateDocument(doc).length, 0, JSON.stringify(validateDocument(doc)));
});

test('geometry that runs off the canvas is reported against the widget', () => {
    const problems = validateDocument(document(0, [widget('wide', 'rect', { x: 300, y: 0, width: 96, height: 48 })]));
    equal(problems.length, 1, JSON.stringify(problems));
    contains(problems[0], '"wide"', 'the widget is named');
    contains(problems[0], '320x480', 'the canvas is named');
});

test('a widget that has no asset is reported, because the parser would refuse it', () => {
    const problems = validateDocument(document(0, [widget('photo', 'image', { x: 0, y: 0, width: 96, height: 96 })]));
    equal(problems.length, 1, JSON.stringify(problems));
    contains(problems[0], 'required', 'the message says the asset is required');
});

test('an icon with no parts is reported, because codegen errors on one', () => {
    const icon = widget('battery', 'icon', { x: 0, y: 0, width: 48, height: 48 });
    const problems = validateDocument(document(0, [icon]));
    equal(problems.length, 1, JSON.stringify(problems));
    contains(problems[0], 'at least one part', 'the message says what is missing');

    icon.children = { kind: 'parts', parts: [{ src: 'assets/bolt.bmp', x: 0, y: 0, visible: true, tint: '' }] };
    equal(validateDocument(document(0, [icon])).length, 0, 'and a part with an asset makes it valid');
});

test('a table row that does not match its headers is reported', () => {
    const table = widget('grid', 'table', { x: 0, y: 0, width: 240, height: 120 });
    table.children = { kind: 'table', headers: ['A', 'B'], rows: [['1', '2', '3']] };
    const problems = validateDocument(document(0, [table]));
    equal(problems.length, 1, JSON.stringify(problems));
    contains(problems[0], '2 headers', 'the message counts the headers');
});

test('a selected index past the end of the option list is reported', () => {
    const dropdown = widget('pick', 'dropdown', { x: 0, y: 0, width: 120, height: 28 });
    dropdown.children = { kind: 'options', values: ['one', 'two'] };
    dropdown.props.selected = 5;
    const problems = validateDocument(document(0, [dropdown]));
    equal(problems.length, 1, JSON.stringify(problems));
    contains(problems[0], 'past the end', 'the message explains the index');
});

test('an unknown property, tag or event is reported rather than silently emitted', () => {
    const doc = document(0, [widget('go', 'button', { x: 0, y: 0, events: ['valueChanged'] })]);
    doc.widgets[0].props = { ...doc.widgets[0].props, nonsense: 1 };
    const problems = validateDocument(doc);
    equal(problems.length, 2, JSON.stringify(problems));
    contains(problems.join('\n'), 'does not raise valueChanged', 'the event');
    contains(problems.join('\n'), 'not a property', 'the property');
});

test('a colour must be #rrggbb or absent, since that is what the crate parses', () => {
    const doc = document(0, [widget('go', 'button', { x: 0, y: 0 })]);
    doc.widgets[0].props.bg = 'blue';
    contains(validateDocument(doc)[0], '#rrggbb', 'a colour name is refused');
    doc.widgets[0].props.bg = '#abc';
    contains(validateDocument(doc)[0], '#rrggbb', 'the short form is refused too');
    doc.widgets[0].props.bg = '#A1B2C3';
    equal(validateDocument(doc).length, 0, 'six hex digits in either case is accepted');
});

test('a document from a future version is refused rather than misread', () => {
    const doc = document();
    doc.version = DESIGNER_FILE_VERSION + 1;
    contains(validateDocument(doc)[0], 'version', 'the version is named');
});

test('the screen id is normalised from the project name', () => {
    equal(screenIdFrom('My Panel'), 'My_Panel', 'spaces become underscores');
    equal(screenIdFrom('3d-thing'), 's3d_thing', 'a leading digit is prefixed');
    equal(screenIdFrom(''), 'Panel', 'an empty name still yields an id');
});

test('the document and its artifacts live at fixed paths inside the project', () => {
    equal(DESIGNER_DOCUMENT_PATH, 'designer/panel.ui.json', 'the document');
    equal(DESIGNER_KDL_PATH, 'src/ui.kdl', 'the markup the macro compiles');
});

// ---------------------------------------------------------------- the markup

test('the emitted markup is a screen around a zero-gap grid', () => {
    const doc = document(0, [widget('title', 'label', { x: 8, y: 8, width: 200, height: 24 })]);
    const kdl = emitKdl(doc);
    contains(kdl, 'screen id="Panel" width=320 height=480 theme="dark" {', 'the screen line');
    contains(
        kdl,
        `grid cols="8px 200px 112px ${GRID_FILLER}" rows="8px 24px 448px ${GRID_FILLER}" gap=0 padding=0 {`,
        'the grid line, with the zero-width filler each axis carries',
    );
    contains(kdl, 'label id="title" text="Label" col=1 row=1 col_span=1 row_span=1', 'the widget line');
    contains(kdl, '\n}\n', 'the closing brace');
});

test('a rotated design is emitted at the rotated size, which is what the panel draws', () => {
    const doc = document(3, [widget('title', 'label', { x: 8, y: 8, width: 200, height: 24 })]);
    contains(emitKdl(doc), 'screen id="Panel" width=480 height=320', 'the landscape canvas');
});

test('optional properties are left out, so the parser\'s own default applies', () => {
    const doc = document(0, [
        widget('title', 'label', { x: 0, y: 0 }),
        widget('photo', 'image', { x: 0, y: 40, width: 96, height: 96 }),
    ]);
    doc.widgets[1].props.src = 'assets/logo.bmp';
    const kdl = emitKdl(doc);
    notContains(kdl, 'font=""', 'an empty font is not written');
    notContains(kdl, 'tint=""', 'an empty tint is not written');
    contains(kdl, 'src="assets/logo.bmp"', 'the chosen asset is written');
    contains(kdl, 'fit="stretch"', 'a default that is a real value is written, so the canvas is reproducible');
});

test('booleans are bare and strings are quoted and escaped', () => {
    const doc = document(0, [widget('sync', 'checkbox', { x: 0, y: 0, width: 96, height: 24 })]);
    doc.widgets[0].props.checked = true;
    doc.widgets[0].props.label = 'Say "hello"';
    const kdl = emitKdl(doc);
    contains(kdl, 'checked=true', 'a bare boolean');
    contains(kdl, 'label="Say \\"hello\\""', 'the quote is escaped');
});

test('floats are written without forcing a fractional part', () => {
    const doc = document(0, [widget('level', 'progress', { x: 0, y: 0, width: 160, height: 20 })]);
    doc.widgets[0].props.value = 0;
    contains(emitKdl(doc), 'value=0 ', 'a whole-number float');
    doc.widgets[0].props.value = 12.5;
    contains(emitKdl(doc), 'value=12.5 ', 'a real fraction');
});

test('every widget gets an explicit span, so the markup explains its own layout', () => {
    const doc = document(0, [
        widget('band', 'rect', { x: 0, y: 0, width: 320, height: 40 }),
        widget('knob', 'circle', { x: 10, y: 10, width: 20, height: 20 }),
    ]);
    // Widget lines are the ones indented inside the grid; the screen line carries an id too.
    const lines = emitKdl(doc)
        .split('\n')
        .filter((line) => /^ {8}\S+ id="/.test(line));
    equal(lines.length, 2, 'two widgets');
    for (const line of lines) {
        contains(line, 'col_span=', `${line} should carry a span`);
        contains(line, 'row_span=', `${line} should carry a row span`);
    }
});

test('the option list becomes option children', () => {
    const doc = document(0, [widget('pick', 'dropdown', { x: 0, y: 0, width: 120, height: 28 })]);
    doc.widgets[0].children = { kind: 'options', values: ['Alpha', 'Beta'] };
    const kdl = emitKdl(doc);
    contains(kdl, 'option "Alpha"', 'the first option');
    contains(kdl, 'option "Beta"', 'the second option');
});

test('a table becomes a headers line and one row line per row', () => {
    const doc = document(0, [widget('grid', 'table', { x: 0, y: 0, width: 240, height: 120 })]);
    doc.widgets[0].children = { kind: 'table', headers: ['Name', 'Value'], rows: [['A', '1'], ['B', '2']] };
    const kdl = emitKdl(doc);
    contains(kdl, 'headers "Name" "Value"', 'the header line');
    contains(kdl, 'row "A" "1"', 'the first row');
    contains(kdl, 'row "B" "2"', 'the second row');
});

test('icon parts are emitted with their own offsets', () => {
    const doc = document(0, [widget('battery', 'icon', { x: 0, y: 0, width: 48, height: 48 })]);
    doc.widgets[0].children = {
        kind: 'parts',
        parts: [
            { src: 'assets/shell.bmp', x: 0, y: 0, visible: true, tint: '' },
            { src: 'assets/bolt.bmp', x: 3, y: 1, visible: false, tint: '#ff0000' },
        ],
    };
    const kdl = emitKdl(doc);
    contains(kdl, 'part src="assets/shell.bmp" x=0 y=0', 'a visible part omits its visibility');
    contains(kdl, 'part src="assets/bolt.bmp" x=3 y=1 visible=false tint="#ff0000"', 'a hidden, tinted part');
});

test('an invalid document is refused instead of being emitted as broken markup', () => {
    const doc = document(0, [widget('wide', 'rect', { x: 300, y: 0, width: 96, height: 48 })]);
    throws(() => emitKdl(doc), 'emitting a widget outside the panel');
});

test('the emitter lays out exactly what the canvas laid out', () => {
    const doc = document(0, [
        widget('a', 'button', { x: 11, y: 13, width: 37, height: 21 }),
        widget('b', 'label', { x: 60, y: 80, width: 71, height: 19 }),
    ]);
    const layout = layoutDocument(doc);
    const resolved = resolveGrid(layout);
    equal(JSON.stringify(resolved), JSON.stringify(doc.widgets.map((w) => ({ x: w.x, y: w.y, width: w.width, height: w.height }))));
});

// ---------------------------------------------------------------- fonts

test('a widget may only name a font the design declares', () => {
    const titled = () =>
        widget('title', 'label', { x: 0, y: 0, width: 100, height: 24 }, {
            props: { ...defaultProps('label'), text: 'AB', font: 'title' },
        });

    // Nothing declared yet: refused, because the markup's parser drops an unresolvable font in silence and a
    // typo would look like "the font did nothing".
    const undeclared = document(0, [titled()]);
    const problems = validateDocument(undeclared);
    equal(problems.length, 1, JSON.stringify(problems));
    contains(problems[0], 'no font named "title"', 'the message says what is missing');

    const declared = document(0, [titled()]);
    declared.fonts = [{ id: 'title', src: 'assets/title.bdf', chars: 'AB' }];
    equal(validateDocument(declared).length, 0, 'and declaring it makes the design valid');
});

test('a font name is checked for the Rust constant it becomes, not just for uniqueness', () => {
    const withFonts = (fonts) => {
        const doc = document(0, []);
        doc.fonts = fonts;
        return validateDocument(doc);
    };

    // The crate's rule: everything that is not alphanumeric becomes an underscore, and everything is
    // upper-cased. Punctuation would collide (`big-font` and `big font` both become `__FONT_BIG_FONT`), but names
    // like those are refused earlier by the identifier rule -- so the collision that can actually reach the
    // constant is a difference of case.
    equal(fontConstName('big-font'), '__FONT_BIG_FONT', 'the crate\'s sanitisation, mirrored');
    equal(fontConstName('big font'), '__FONT_BIG_FONT', 'two spellings, one constant');

    const collision = withFonts([
        { id: 'Title', src: 'assets/a.bdf', chars: '' },
        { id: 'title', src: 'assets/b.bdf', chars: '' },
    ]);
    equal(collision.length, 1, JSON.stringify(collision));
    contains(collision[0], '__FONT_TITLE', 'the message names the constant');

    const duplicate = withFonts([
        { id: 'title', src: 'assets/a.bdf', chars: '' },
        { id: 'title', src: 'assets/b.bdf', chars: '' },
    ]);
    contains(duplicate.join('\n'), 'two fonts have this name', 'a plain duplicate');

    const badName = withFonts([{ id: 'my title', src: 'assets/a.bdf', chars: '' }]);
    contains(badName.join('\n'), 'must start with a letter', 'and a name that is not an identifier');

    const noFile = withFonts([{ id: 'title', src: '', chars: '' }]);
    contains(noFile.join('\n'), 'no font file', 'a font with no file');

    const wrongFormat = withFonts([{ id: 'title', src: 'assets/title.ttf', chars: '' }]);
    contains(wrongFormat.join('\n'), '.bdf', 'and a file the loader cannot read');
});

test('the markup declares the fonts before the grid that refers to them', () => {
    const doc = document(0, [
        widget('title', 'label', { x: 0, y: 0, width: 100, height: 24 }, {
            props: { ...defaultProps('label'), text: 'AB', font: 'title' },
        }),
    ]);
    doc.fonts = [{ id: 'title', src: 'assets/title.bdf', chars: 'AB' }];
    const kdl = emitKdl(doc);
    contains(kdl, 'font id="title" src="assets/title.bdf" chars="AB"', 'the declaration');
    ok(
        kdl.indexOf('font id=') < kdl.indexOf('grid cols='),
        'and it comes before the grid, so a reader has met it before the reference',
    );

    // An empty character set is left out, which is what tells the loader to embed every glyph.
    doc.fonts[0].chars = '';
    notContains(emitKdl(doc), 'chars=', 'no empty chars attribute');
});

// ---------------------------------------------------------------- hover help

test('every property and every widget has a hover description', () => {
    // The panel shows these as the field's tooltip, so a property without one is a control the user has to
    // guess at. Asserted over the whole catalogue rather than per widget, so a new tag cannot arrive without
    // its help.
    for (const spec of KDL_WIDGETS) {
        const about = widgetHelp(spec.tag);
        ok(typeof about === 'string' && about.length > 0, `${spec.tag} has no description for the Toolbox`);
        for (const property of spec.props) {
            const help = propertyHelp(spec.tag, property.name);
            ok(
                typeof help === 'string' && help.length > 0,
                `${spec.tag}.${property.name} has no hover description`,
            );
        }
    }
});

test('the two properties that mean something different per widget say so', () => {
    // A shared name would otherwise describe the wrong thing: `radius` is a corner on a rectangle and the
    // whole shape on a circle, and `mode` selects between quite different drawings.
    ok(propertyHelp('rect', 'radius') !== propertyHelp('circle', 'radius'), 'radius differs');
    ok(propertyHelp('scale', 'mode') !== propertyHelp('chart', 'mode'), 'mode differs');
    ok(propertyHelp('icon', 'scale') !== propertyHelp('mesh', 'scale'), 'scale differs');
    equal(propertyHelp('label', 'text'), propertyHelp('button', 'text'), 'and a shared one is shared');
});

test('the font property explains where a font comes from', () => {
    // The field was a trap once: it takes a name, and the name has to be declared on the screen.
    contains(propertyHelp('label', 'font'), 'Fonts', 'it points at the section that declares them');
});
