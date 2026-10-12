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

const fs = require('fs');
const path = require('path');
const { test, ok, notOk, equal, contains, notContains, throws, compiled, repoRoot } = require('../../lib/harness');
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
    circleCentre,
    circleRadius,
    circleRect,
    rustFieldName,
    screenIdFrom,
    sdImageSourceProblems,
    sdImagesNeedingCard,
    uniqueWidgetId,
    validateDocument,
    DEFAULT_TRIANGLE_POINTS,
    TRIANGLE_POINT_NAMES,
    trianglePoints,
} = compiled('designer/model');
const { emitKdl, layoutDocument } = compiled('designer/kdl');
const { fontConstName } = compiled('designer/model');
const {
    rgb565Expression,
    appearanceExpression,
    ownStyleOf,
    resolveStyleValues,
    styleValuesOf,
} = compiled('designer/appearance');

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
    'plotter',
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
    'triangle',
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
    equal(props('arc').progress, 0.5, 'an arc starts half swept');
    // Fourteen, not four: the frame is an opaque card painted over the sweep, so a smaller inset would hide
    // the arc completely at the default radius -- the design would look like it had no arc at all.
    equal(props('arc').frame_inset, 14, 'and its frame leaves room for the arc');
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
    equal(props('busy_wheel').phase, 0, 'a busy wheel starts at the top of its turn');
    equal(props('toggle').checked, false, 'toggle checked');
});

test('the closed vocabularies match what the emitter branches on', () => {
    const options = (tag, name) => widgetSpec(tag).props.find((p) => p.name === name).options;
    // The palette maps "radial" to Radial and "linear_vertical" to LinearVertical, everything else to
    // LinearHorizontal; "center" to Center and everything else to Stretch; "top_left" to TopLeft, else Center.
    equal(options('scale', 'mode').join(','), 'radial,linear_vertical,linear_horizontal', 'gauge modes');
    equal(options('image', 'fit').join(','), 'stretch,center', 'image fits');
    equal(options('icon', 'align').join(','), 'center,top_left', 'icon aligns');
    equal(options('scale', 'mode').join(','), 'radial,linear_vertical,linear_horizontal', 'and the gauge again');
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

test('the shapes the board now paints reach the markup, and the ones it cannot are still marked', () => {
    // The board's own picture comes from `emitter.rs`. Shapes the crate renders paint themselves: a rect is a
    // filled rectangle, a line is a segment, a circle an arc, a triangle an inscribed triangle -- each from
    // the cell rect the layout engine laid out. The spacer still draws nothing, and a button/panel surface
    // is still the crate's own look. A designer that painted a fill the board would not draw would be lying
    // about the one thing it exists to show.
    const draws = (tag) => widgetSpec(tag).draws ?? 'widget';
    equal(draws('rect'), 'rectangle', 'a rectangle is painted as a rectangle on the board');
    equal(draws('line'), 'line', 'a line is painted as a segment on the board');
    equal(draws('circle'), 'circle', 'a circle is painted as an arc on the board');
    equal(draws('triangle'), 'triangle', 'a triangle is painted as a triangle on the board');
    equal(draws('spacer'), 'nothing', 'a spacer still reserves its space and draws nothing');
    equal(draws('button'), 'widget', 'a button is drawn for real');
    equal(draws('panel'), 'widget', 'and so is a panel');

    // Every board-painted shape carries its own colours to the markup now, so its properties are not ignored.
    const expectedDraws = { rect: 'rectangle', line: 'line', circle: 'circle', triangle: 'triangle' };
    for (const tag of ['rect', 'line', 'circle', 'triangle']) {
        const spec = widgetSpec(tag);
        equal(spec.draws, expectedDraws[tag], `${tag}'s canvas drawing matches its board drawing`);
        ok(spec.native !== true, `${tag} is no longer a designer-native widget`);
        for (const property of spec.props) {
            ok(
                property.ignoredByCodegen !== true,
                `${tag}.${property.name} reaches the board, so it is not ignored`,
            );
        }
        ok(typeof spec.note === 'string', `${tag} carries its note`);
    }
});

test('the Toolbox offers every widget that can be built, and only into known categories', () => {
    const groups = toolboxGroups();
    const offered = groups.flatMap((group) => group.widgets.map((widget) => widget.tag));
    const usable = KDL_WIDGETS.filter((widget) => widget.unavailable === undefined).map((widget) => widget.tag);
    equal(offered.length, usable.length, 'every buildable widget appears exactly once');
    equal(new Set(offered).size, offered.length, 'and none of them twice');
    for (const group of groups) {
        equal(group.label, CATEGORY_LABELS[group.category], `${group.category} label`);
        ok(group.widgets.length > 0, `${group.category} should not be an empty group`);
    }

    // Nothing is refused any more. The ten tags that used to be documented-but-withheld -- a slider whose
    // value arrived in the wrong order, an arc whose builder takes ten arguments, an arc's missing `add_busy_wheel`
    // and the five widgets the runtime did not dispatch at all -- now generate code the runtime accepts, so the
    // Toolbox hands out the whole catalogue. `unavailable` stays as the channel for the next defect: a tag that
    // cannot be built must say why rather than produce a project that does not compile.
    const refused = KDL_WIDGETS.filter((widget) => widget.unavailable !== undefined);
    equal(refused.length, 0, 'no tag is refused today');
    equal(offered.length, KDL_WIDGETS.length, 'so every widget in the catalogue is offered');
    ok(usable.length > 0, 'and the toolbox is not empty');
});

test('a design naming a tag the markup does not have is refused by name', () => {
    // The refusal path that matters now that nothing is withheld: an older or hand-edited design file can name
    // something the catalogue has never heard of, and loading it must say which control and why rather than
    // failing later inside a macro.
    const doc = document(0, [widget('level', 'leveller', { x: 8, y: 8, width: 200, height: 28 })]);
    const problems = validateDocument(doc);
    equal(problems.length, 1, JSON.stringify(problems));
    contains(problems[0], '"level"', 'the widget is named');
    contains(problems[0], 'leveller', 'and so is the tag it asked for');
    contains(problems[0], 'not one of the widgets', 'with the reason the markup cannot build it');
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
        widget('level', 'progress', { x: 8, y: 80, width: 200, height: 28 }),
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
        widget('knob', 'panel', { x: 10, y: 10, width: 20, height: 20 }),
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

test('a circle is emitted to the board with its designer props mapped onto codegen attributes', () => {
    // A circle used to be skipped on the board (it had no crate builder); now `rusty-gui-widgets` renders an
    // arc, so the circle reaches the markup. Its catalogue props are NOT passed through by name -- the
    // codegen parser only reads `stroke_width`/`fill`/`stroke` -- so the emitter maps them and omits `radius`,
    // which the board derives from the cell rect.
    const doc = document(0, [
        widget('band', 'rect', { x: 0, y: 0, width: 320, height: 40 }),
        widget('ring', 'circle', { x: 10, y: 10, width: 64, height: 64 }),
        // An explicit outline colour and thickness that differ from the defaults, to prove the mapping happens.
        widget('rim', 'circle', {
            x: 80,
            y: 10,
            width: 40,
            height: 40,
            props: { line_color: '#00ff00', line_thickness: 3, fill: true, fill_color: '#ff0000' },
        }),
    ]);
    validateDocument(doc);
    const kdl = emitKdl(doc);
    contains(kdl, 'rect id=', 'the rectangle is still written');
    contains(kdl, 'circle id="ring"', 'the circle is now emitted as markup');
    contains(kdl, 'stroke_width=1', 'line_thickness is mapped to stroke_width');
    contains(kdl, 'stroke="#ffffff"', 'line_color is mapped to the codegen stroke attribute');
    contains(kdl, 'circle id="rim"', 'an explicitly-styled circle is emitted');
    contains(
        kdl,
        'stroke_width=3 fill="#ff0000" stroke="#00ff00"',
        'the designer colours are mapped onto stroke/fill as colour strings the crate RGB565-ifies',
    );
    notContains(kdl, 'line_color=', 'the catalogue property name is not emitted');
    notContains(kdl, 'line_thickness=', 'the catalogue property name is not emitted');
    // `radius` is a rectangle attribute (corner radius) carried on the `band` rect above, never on a circle:
    // the board derives the circle's size from the cell rect, so the circle line must not carry one.
    for (const line of kdl.split('\n').filter((l) => l.includes('circle id='))) {
        notContains(line, 'radius', 'a circle does not emit radius');
    }
});

test('rectangle, line and triangle are emitted with the codegen attributes their crate widget reads', () => {
    // These shapes carry catalogue property names that already match the codegen tags (radius/stroke_width/
    // fill/stroke for a rect, stroke_width/color for a line, stroke_width/fill/stroke for a triangle), so the
    // generic emitter writes them straight through and the forked arms turn each into `add_custom_widget`.
    const doc = document(0, [
        widget('box', 'rect', { x: 0, y: 0, width: 40, height: 20 }, {
            props: { radius: 4, stroke_width: 2, fill: '#ff0000', stroke: '#00ff00' },
        }),
        widget('slash', 'line', { x: 0, y: 30, width: 40, height: 8 }, {
            props: { stroke_width: 3, color: '#0000ff' },
        }),
        widget('pyr', 'triangle', { x: 0, y: 40, width: 40, height: 40 }, {
            props: { stroke_width: 1, fill: '#000000', stroke: '#ffffff' },
        }),
    ]);
    validateDocument(doc);
    const kdl = emitKdl(doc);
    contains(
        kdl,
        'rect id="box" radius=4 stroke_width=2 fill="#ff0000" stroke="#00ff00"',
        'a rectangle emits the attributes its crate widget reads',
    );
    contains(kdl, 'line id="slash" stroke_width=3 color="#0000ff"', 'a line emits its attributes as-is');
    contains(
        kdl,
        'triangle id="pyr" stroke_width=1 fill="#000000" stroke="#ffffff"',
        'a triangle emits the attributes its crate widget reads',
    );
});

test('a circle\'s centre, radius and bounding box round-trip through its rect', () => {
    // These three are the Geometry panel's numbers, in whole pixels, and they have to be each other's inverse:
    // the Radius field edits the box, and a radius that came back one smaller every time would walk the circle
    // across the canvas as the user typed.
    const square = { ...widget('dial', 'circle'), x: 10, y: 20, width: 64, height: 64 };
    equal(circleCentre(square), { cx: 42, cy: 52 }, 'centre is half the box from its corner');
    equal(circleRadius(square), 32, 'radius is half the shorter side');
    equal(circleRect(42, 52, 32), { x: 10, y: 20, width: 64, height: 64 }, 'radius -> box is the inverse');

    // The panel creates boxes of `2r`, so the radius it shows is exactly the radius the renderer draws, and
    // the round trip is exact for every radius the field can produce.
    for (const r of [1, 5, 19, 32]) {
        const box = circleRect(100, 100, r);
        equal(circleRadius({ ...widget('dial', 'circle'), ...box }), r, `radius ${r} survives a round trip`);
        equal(circleRect(100, 100, r), box, 'and the box is stable too');
    }

    // A non-square box still inscribes the circle from its smaller side.
    const oval = { ...widget('dial', 'circle'), x: 0, y: 0, width: 60, height: 40 };
    equal(circleRadius(oval), 20, 'radius is the smaller half');

    // Nothing here is responsible for keeping the disc inside the box: the renderer does that, by measuring in
    // half-pixels (an even-sized box has no whole-pixel centre, and the earlier whole-pixel measurement put the
    // disc's top and bottom rows outside the cell, where the board's clip flattened them).
});

test('a circle is a board shape with its own appearance properties', () => {
    const spec = widgetSpec('circle');
    equal(spec.draws, 'circle', 'the canvas paints an arc for editing');
    ok(spec.native !== true, 'and it is emitted to the board now, not native');
    equal(spec.category, 'shape', 'offered in the Shapes group');
    equal(spec.events, [], 'shapes raise no events');
    equal(spec.props.map((p) => p.name).join(','), 'line_color,line_thickness,fill,fill_color', 'four appearance properties');
    const props = Object.fromEntries(spec.props.map((p) => [p.name, p.defaultValue]));
    equal(props.line_color, '#ffffff', 'default line colour');
    equal(props.line_thickness, 1, 'default line thickness');
    equal(props.fill, true, 'filled by default');
    equal(props.fill_color, '#3a6ea5', 'default fill colour');
    const shapes = toolboxGroups().find((g) => g.category === 'shape');
    ok(shapes?.widgets.some((w) => w.tag === 'circle'), 'circle is offered in Shapes');
});

test('a dropped circle starts square with the catalogue defaults', () => {
    // The box a drop produces is square, its centre lands where the pointer did, and its props are the
    // catalogue's -- nothing the geometry form derives is stored until the user changes it.
    const canvas = designCanvasSize(320, 480, 0);
    const placed = placeWidget('circle', 50, 50, canvas);
    equal(placed.width, placed.height, 'the bounding box is square');
    equal(placed.width, 64, 'at the catalogue default size');
    equal(circleCentre(placed), { cx: 82, cy: 82 }, 'centre tracks the drop point');
    equal(
        defaultProps('circle'),
        { line_color: '#ffffff', line_thickness: 1, fill: true, fill_color: '#3a6ea5' },
        'appearance defaults',
    );
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

test('a widget with children gets a block, because KDL nests by braces and not by indentation', () => {
    // The bug this pins: the children were emitted on deeper lines with no braces, which KDL reads as *siblings*
    // of their widget. Every dropdown, roller, carousel, table and icon therefore produced markup that codegen
    // rejected outright -- "Unknown widget or container node: 'option'" -- and nothing caught it because the
    // host fixtures used none of those five tags.
    const doc = document(0, [
        widget('pick', 'dropdown', { x: 0, y: 0, width: 120, height: 28 }, {
            props: { ...defaultProps('dropdown') },
            children: { kind: 'options', values: ['One', 'Two'] },
        }),
    ]);
    const kdl = emitKdl(doc);
    const lines = kdl.split('\n').map((line) => line.trim());
    const opening = lines.findIndex((line) => line.startsWith('dropdown '));
    ok(opening >= 0, 'the widget is there');
    ok(lines[opening].endsWith('{'), 'and opens a block, rather than letting the children float');
    equal(lines[opening + 1], 'option "One"', 'the first child is inside it');
    equal(lines[opening + 2], 'option "Two"', 'and so is the second');
    equal(lines[opening + 3], '}', 'and the block is closed again');
    // An icon is the same shape, and its parts are the ones codegen refuses to meet as widgets.
    const withIcon = document(0, [
        widget('mark', 'icon', { x: 0, y: 0, width: 32, height: 32 }, {
            props: { ...defaultProps('icon') },
            children: {
                kind: 'parts',
                parts: [{ src: 'assets/a.png', x: 0, y: 0, visible: true, tint: '' }],
            },
        }),
    ]);
    const iconLines = emitKdl(withIcon).split('\n').map((line) => line.trim());
    const iconAt = iconLines.findIndex((line) => line.startsWith('icon '));
    ok(iconLines[iconAt].endsWith('{'), 'an icon opens a block too');
    ok(iconLines[iconAt + 1].startsWith('part '), 'with its part inside');
    equal(iconLines[iconAt + 2], '}', 'and closed');
});

test('the shapes speak the attribute names the codegen fork parses', () => {
    // The designer's property names and the fork's are not the same vocabulary -- `line_thickness` is
    // `stroke_width`, a circle's `fill` is a *bool* where a rectangle's is a colour. The mapping lives in
    // `widgetLine`, and if it drifts the shape silently stops painting on the board, so it is pinned here.
    const kdl = (tag, props) => {
        const doc = document(0, [
            widget('shape', tag, { x: 0, y: 0, width: 40, height: 40 }, { props: { ...defaultProps(tag), ...props } }),
        ]);
        return emitKdl(doc).split('\n').find((line) => line.trim().startsWith(tag));
    };

    const circle = kdl('circle', { line_thickness: 2, line_color: '#ffffff', fill: true, fill_color: '#3a6ea5' });
    contains(circle, 'stroke_width=2', 'the circle pen width');
    contains(circle, 'stroke="#ffffff"', 'and its colour');
    contains(circle, 'fill="#3a6ea5"', 'the fill colour, from the separate designer colour');
    notContains(circle, 'line_thickness=', 'the designer-only name never reaches the markup');
    notContains(circle, 'line_color=', 'nor this one');
    notContains(circle, 'radius=', 'and the radius is derived from the cell rect, never written');
    // An unfilled circle hands the fork no fill colour at all, which is the same as "leave the backdrop".
    notContains(kdl('circle', { fill: false, fill_color: '#3a6ea5' }), 'fill=', 'no fill attribute when unfilled');

    const rect = kdl('rect', { radius: 4, stroke_width: 2, fill: '#ff0000', stroke: '#00ff00' });
    contains(rect, 'radius=4', 'a rectangle keeps its corner radius');
    contains(rect, 'stroke_width=2', 'and its pen width');
    contains(rect, 'fill="#ff0000"', 'and its fill colour');

    const line = kdl('line', { stroke_width: 2, color: '#0000ff' });
    contains(line, 'stroke_width=2', 'a line its pen width');
    contains(line, 'color="#0000ff"', 'and its colour');

    const triangle = kdl('triangle', { stroke_width: 2, fill: '#ffff00', stroke: '#ff00ff' });
    contains(triangle, 'stroke_width=2', 'a triangle its pen width');
    contains(triangle, 'fill="#ffff00"', 'its fill');
    contains(triangle, 'stroke="#ff00ff"', 'and its stroke');
});

test('a triangle emits its three points, and an older design without them keeps the crate\'s default', () => {
    // The six offsets are ordinary attributes, so they travel the same route as every other property -- and
    // the crate's parser reads each with the default triangle's value, which is what makes a design written
    // before the points existed still build to the shape it always had.
    const dragged = widget('pyr', 'triangle', { x: 0, y: 40, width: 40, height: 40 }, {
        props: {
            ...defaultProps('triangle'),
            p1x: 1000,
            p1y: 0,
            p2x: 0,
            p2y: 1000,
            p3x: 1000,
            p3y: 1000,
        },
    });
    const doc = document(0, [dragged]);
    equal(validateDocument(doc).length, 0, 'a triangle with dragged points is a valid design');
    contains(
        emitKdl(doc),
        'triangle id="pyr" stroke_width=1 fill="#3a6ea5" stroke="#ffffff" p1x=1000 p1y=0 p2x=0 p2y=1000 p3x=1000 p3y=1000',
        'the six points are emitted in the order the parser reads them',
    );

    // The older design: none of the six, and therefore the isosceles triangle -- on the canvas as well as on
    // the board, since the canvas reads the same fallback.
    const old = widget('old', 'triangle', { x: 0, y: 0, width: 32, height: 32 });
    for (const name of TRIANGLE_POINT_NAMES) {
        delete old.props[name];
    }
    const oldDoc = document(0, [old]);
    equal(validateDocument(oldDoc).length, 0, 'a design without the points is still valid');
    notContains(emitKdl(oldDoc), 'p1x=', 'and emits no point at all, so the crate defaults it');
    equal(trianglePoints(old).join(','), DEFAULT_TRIANGLE_POINTS.join(','), 'while the canvas shows the default');
});

test('the six point attributes are the ones the whole chain spells the same way', () => {
    // Designer property -> KDL attribute -> fork parser -> fork AST -> crate struct. A rename anywhere along
    // it would leave a triangle that builds and then never moves, so the names are read out of the sources
    // rather than pinned as literals here.
    const read = (file) => fs.readFileSync(path.join(repoRoot(), file), 'utf8');
    const parser = read('crates/embedded-gui-codegen/src/parser.rs');
    const ast = read('crates/embedded-gui-codegen/src/ast.rs');
    const emitter = read('crates/embedded-gui-codegen/src/emitter.rs');
    const widgets = read('crates/rusty-gui-widgets/src/lib.rs');

    for (const name of TRIANGLE_POINT_NAMES) {
        contains(parser, `point("${name}",`, `the fork's parser reads ${name}`);
    }
    contains(ast, 'points: [i16; 6]', 'the fork carries the six on the shape node');
    contains(emitter, 'points,', 'and writes them into the custom widget');
    contains(widgets, 'pub points: [i16; 6],', "the crate's Triangle holds them");
    contains(
        widgets,
        'DEFAULT_TRIANGLE_POINTS: [i16; 6] = [500, 0, 0, 1000, 1000, 1000]',
        'and its default is the isosceles triangle',
    );
    equal(
        defaultProps('triangle').p1x +
        ',' +
        defaultProps('triangle').p1y +
        ',' +
        defaultProps('triangle').p2x +
        ',' +
        defaultProps('triangle').p2y +
        ',' +
        defaultProps('triangle').p3x +
        ',' +
        defaultProps('triangle').p3y,
        DEFAULT_TRIANGLE_POINTS.join(','),
        'which is the same one the catalogue drops and the parser falls back to',
    );
});

test('every shape is offered, and each declares how it is drawn', () => {
    // The canvas paints from `draws`; a shape without one would fall back to the panel look and quietly lie.
    const shapes = ['rect', 'line', 'circle', 'triangle'];
    const offered = toolboxGroups().flatMap((group) => group.widgets.map((item) => item.tag));
    for (const tag of shapes) {
        ok(offered.includes(tag), `${tag} must be in the Toolbox`);
        const spec = widgetSpec(tag);
        ok(['rectangle', 'line', 'circle', 'triangle'].includes(spec.draws), `${tag} declares its own drawing`);
        ok(spec.native !== true, `${tag} reaches the board, so it is not native-only`);
        ok(spec.props.every((property) => property.ignoredByCodegen !== true), `${tag}'s properties reach the board`);
    }
});

// ---------------------------------------------------------------- built-in fonts

test('a built-in font travels as a style expression, since the markup has no attribute for it', () => {
    // `font="name"` names a font the screen *declares*. The crate's own fonts are not declarable, so
    // `font="Scaled6x10"` would be dropped in silence; a style expression is the route that reaches them, and
    // the crate's own style resolver passes one through.
    const doc = document(0, [
        widget('note', 'label', { x: 0, y: 0, width: 120, height: 24 }, {
            props: { ...defaultProps('label'), text: 'AB', font: 'Scaled6x10' },
        }),
    ]);
    const kdl = emitKdl(doc);
    contains(
        kdl,
        'style="{ let mut style = Style::label(); style.font = FontId::Scaled6x10; style }"',
        'the font it asked for, in the expression the crate reads',
    );
    notContains(kdl, 'font="Scaled6x10"', 'and not the attribute, which would name nothing');
    equal(validateDocument(doc).length, 0, 'a built-in font is valid without a declaration');
});

test('a button gets a WidgetStyle, because the emitter chains its colours onto the expression', () => {
    // The crate's button arm appends `.with_bg(...)`, `.with_corner_radius(...)` and so on to whatever the
    // style expression evaluates to. A plain `Style` therefore fails to compile for a button, and the designer
    // always writes those colour properties, so this is not a corner case -- it is every button.
    const doc = document(0, [
        widget('go', 'button', { x: 0, y: 0, width: 100, height: 32 }, {
            props: { ...defaultProps('button'), text: 'Go', font: 'Vector(2)' },
        }),
    ]);
    const kdl = emitKdl(doc);
    contains(kdl, 'style.font = FontId::Vector(2)', 'the font is set');
    contains(kdl, 'WidgetStyle::button().with_normal(', 'and handed over as a WidgetStyle');
    equal(validateDocument(doc).length, 0, 'which is a valid button');
});

test('a font is only offered where the crate reads one', () => {
    // Two routes reach a widget: the `font` attribute, which the parser reads for labels and carousels only,
    // and a `style` expression, which every widget whose renderer draws its text in `style.font` can take.
    // A field that does nothing is worse than no field, so a widget with no text -- or with text no face can
    // change -- must not offer one (2026-10-12).
    for (const tag of [
        'label',
        'carousel',
        'button',
        'toggle',
        'checkbox',
        'dropdown',
        'roller',
        'spinbox',
        'number_picker',
        'time_picker',
        'scale',
        'status_bar',
        'dialog',
        'table',
    ]) {
        ok(
            widgetSpec(tag).props.some((property) => property.name === 'font'),
            `${tag} can be given a font and must offer one`,
        );
        ok(
            ['style', 'both'].includes(widgetSpec(tag).fontSupport),
            `${tag} needs a style handle for a built-in font to reach it`,
        );
    }
    for (const tag of ['panel', 'rect', 'circle', 'line', 'triangle', 'path', 'spacer', 'image', 'icon', 'slider', 'progress', 'plotter', 'arc', 'busy_wheel', 'crumbs', 'content_indicator']) {
        notOk(
            widgetSpec(tag).props.some((property) => property.name === 'font'),
            `${tag} draws no text a font could change and must not offer one`,
        );
        ok(widgetSpec(tag).fontSupport === undefined, `${tag} claims no font support`);
    }
    // The attribute route is the narrower one, so a declared font on a button is refused rather than emitted
    // into a dropped attribute.
    const button = document(0, [
        widget('go', 'button', { x: 0, y: 0, width: 100, height: 32 }, {
            props: { ...defaultProps('button'), font: 'title' },
        }),
    ]);
    button.fonts = [{ id: 'title', src: 'assets/title.bdf', chars: 'AB' }];
    contains(
        validateDocument(button).join('\n'),
        'reads a declared font for labels and carousels only',
        'a declared font on a button is reported',
    );
});

test('a chosen base style is the constructor the crate\'s own resolver would write', () => {
    // The names are the crate's, and so is what each resolves to. Emitting the constructor directly means the
    // markup says exactly what the resolver would have turned the name into, with one less thing in between.
    const doc = document(0, [
        widget('card', 'panel', { x: 0, y: 0, width: 160, height: 96 }, {
            props: { ...defaultProps('panel'), style: 'progress' },
        }),
        widget('note', 'label', { x: 0, y: 100, width: 120, height: 24 }, {
            props: { ...defaultProps('label'), text: 'AB', style: 'panel' },
        }),
    ]);
    const kdl = emitKdl(doc);
    contains(kdl, 'style="Style::progress()"', 'a panel can wear the progress look');
    contains(kdl, 'style="Style::panel()"', 'and a label a panel\'s');
    equal(validateDocument(doc).length, 0, 'both are valid designs');
});

test('a style and a font are one attribute, not two', () => {
    // A built-in font *is* a style expression, so the two cannot both be written. Composing them is what lets a
    // label wear a panel's background and a larger face at the same time.
    const doc = document(0, [
        widget('note', 'label', { x: 0, y: 0, width: 120, height: 24 }, {
            props: { ...defaultProps('label'), text: 'AB', style: 'panel', font: 'Scaled6x10' },
        }),
    ]);
    const kdl = emitKdl(doc);
    equal(
        kdl.split('style=').length - 1,
        1,
        'exactly one style attribute, or the markup would not parse',
    );
    contains(
        kdl,
        'style="{ let mut style = Style::panel(); style.font = FontId::Scaled6x10; style }"',
        'the base look with the font set on it',
    );
    // A widget with neither says neither.
    const plain = document(0, [
        widget('note', 'label', { x: 0, y: 0, width: 120, height: 24 }, {
            props: { ...defaultProps('label'), text: 'AB' },
        }),
    ]);
    notContains(emitKdl(plain), 'style=', 'and a plain label carries no style at all');
});

test('a style name the crate does not know is refused, because it would be compiled', () => {
    // `style_expr` passes an unrecognised name through *verbatim* as Rust. A typo would not be ignored, it would
    // be compiled -- so a closed set is the only safe thing to offer, and validation enforces the same set.
    const doc = document(0, [
        widget('note', 'label', { x: 0, y: 0, width: 120, height: 24 }, {
            props: { ...defaultProps('label'), text: 'AB', style: 'panell' },
        }),
    ]);
    const problems = validateDocument(doc).join('\n');
    contains(problems, 'is not a base style the crate knows', 'the typo is reported');
    contains(problems, 'label, panel', 'and the message lists the names that would have worked');

    // A widget whose emitter ignores a style must not offer one, so the property itself is the error.
    const rect = document(0, [
        widget('band', 'rect', { x: 0, y: 0, width: 40, height: 10 }, {
            props: { ...defaultProps('rect'), style: 'panel' },
        }),
    ]);
    contains(validateDocument(rect).join('\n'), 'is not a property of a rect', 'no handle, no property');
});

test('a label can be given a text colour, which the markup has no attribute for', () => {
    // The crate paints text as `TextStyle::new(style.text).with_font(style.font)`, and the parser reads no colour
    // property for a label at all -- so the colour has to ride in the style expression, with the font and the
    // base style. That is the only route there is; the alternative is not being able to set it.
    const doc = document(0, [
        widget('note', 'label', { x: 0, y: 0, width: 120, height: 24 }, {
            props: { ...defaultProps('label'), text: 'AB', text_color: '#ff0000' },
        }),
    ]);
    const kdl = emitKdl(doc);
    contains(
        kdl,
        'style="{ let mut style = Style::label(); style.text = Rgb565::new(31, 0, 0); style }"',
        'the colour, in the 5/6/5 the crate itself reduces a hex colour to',
    );
    notContains(kdl, 'text_color=', 'and not as an attribute, which the parser would ignore for a label');
    equal(validateDocument(doc).length, 0, 'which is a valid design');

    // All three ride in one expression, because a widget has one style and no more.
    const all = document(0, [
        widget('note', 'label', { x: 0, y: 0, width: 120, height: 24 }, {
            props: { ...defaultProps('label'), text: 'AB', style: 'panel', font: 'Scaled6x10', text_color: '#00ff00' },
        }),
    ]);
    const combined = emitKdl(all);
    equal(combined.split('style=').length - 1, 1, 'one style attribute');
    contains(
        combined,
        '{ let mut style = Style::panel(); style.font = FontId::Scaled6x10; style.text = Rgb565::new(0, 63, 0); style }',
        'the base look, the font and the colour together',
    );

    // A button's text colour is a real attribute and must not be swallowed by the appearance handling.
    const button = document(0, [
        widget('go', 'button', { x: 0, y: 0, width: 100, height: 32 }, {
            props: { ...defaultProps('button'), text: 'Go', text_color: '#ffffff' },
        }),
    ]);
    const buttonKdl = emitKdl(button);
    contains(buttonKdl, 'text_color="#ffffff"', 'a button keeps its own text colour attribute');
    notContains(buttonKdl, 'style=', 'and needs no style expression for it');
});

test('the canvas colour and the emitted colour are the same arithmetic', () => {
    // The swatch on the canvas and the pixel on the glass have to agree; both reduce a `#rrggbb` the same way
    // the crate's resolver does.
    equal(rgb565Expression('#ffffff'), 'Rgb565::new(31, 63, 31)', 'white is full on all three');
    equal(rgb565Expression('#000000'), 'Rgb565::new(0, 0, 0)', 'black is none');
    equal(rgb565Expression('#ff0000'), 'Rgb565::new(31, 0, 0)', 'red keeps five bits');
    equal(rgb565Expression('#0000ff'), 'Rgb565::new(0, 0, 31)', 'blue keeps five bits');
    equal(rgb565Expression('#00ff00'), 'Rgb565::new(0, 63, 0)', 'green keeps six');
    equal(rgb565Expression('#3a6ea5'), 'Rgb565::new(7, 27, 20)', 'and a mixed colour matches the crate\'s own reduction');
    equal(rgb565Expression('red'), undefined, 'a name the design never stores is refused');
});

// ---------------------------------------------------------------- hover help

test('a triangle\'s six points are one group of optional properties', () => {
    // Grouped, so the panel presents them as three points rather than six loose numbers; and optional, since
    // the crate defaults each of them and a design written before they existed must stay valid.
    const spec = widgetSpec('triangle');
    const points = spec.props.filter((property) => property.name !== 'stroke_width' && property.name !== 'fill' && property.name !== 'stroke');
    equal(points.map((property) => property.name).join(','), TRIANGLE_POINT_NAMES.join(','), 'the six, in order');
    for (const property of points) {
        equal(property.optional, true, `${property.name} may be absent`);
        equal(typeof property.group, 'string', `${property.name} belongs to a group`);
        equal(property.min, 0, `${property.name} is a per-mille offset`);
        equal(property.max, 1000, `${property.name} stops at the box's far edge`);
    }
    equal(new Set(points.map((property) => property.group)).size, 1, 'and they all share the one heading');
    // Nothing else in the catalogue is optional apart from one superseded field: a shape's points are the case
    // this exists for, and the checkbox's old `box_size` joined them because the crate defaults it and every
    // widget dropped now leaves it out. Named rather than counted, so adding an optional property has to be a
    // deliberate act instead of something that slips in.
    const optional = KDL_WIDGETS.flatMap((entry) => entry.props)
        .filter((property) => property.optional === true)
        .map((property) => property.name)
        .sort();
    equal(
        optional.join(','),
        ['box_size', ...TRIANGLE_POINT_NAMES].sort().join(','),
        'the triangle\'s points and the checkbox\'s superseded box size are the only optional properties',
    );
});

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

test('the properties that mean something different per widget say so', () => {
    // A shared name would otherwise describe the wrong thing: `mode` selects between quite different
    // drawings, and `scale` is a glyph's growth on an icon but the model's size on a mesh.
    ok(propertyHelp('scale', 'mode') !== propertyHelp('image', 'mode'), 'mode differs');
    ok(propertyHelp('icon', 'scale') !== propertyHelp('mesh', 'scale'), 'scale differs');
    equal(propertyHelp('label', 'text'), propertyHelp('button', 'text'), 'and a shared one is shared');
});

test('the font property explains where a font comes from', () => {
    // The field was a trap once: it takes a name, and the name has to be declared on the screen.
    contains(propertyHelp('label', 'font'), 'Fonts', 'it points at the section that declares them');
});

// ---------------------------------------------------------------- the appearance the six controls gained

test('every control that had no colours offers them, and the crate reads the rest as attributes', () => {
    // The complaint was that a Toggle, Checkbox, Roller, Progress bar and Gauge had no colour settings at all,
    // and that a Spinbox had none either. Which of the new properties travel inside the `style` expression and
    // which are attributes the runtime reads is the crate's shape, not a preference, so it is pinned here.
    const viaStyle = {
        toggle: ['accent', 'bg', 'border_color', 'border_width', 'corner_radius', 'text_color'],
        checkbox: ['accent', 'bg', 'border_color', 'border_width', 'corner_radius', 'text_color'],
        roller: ['accent', 'bg', 'border_color', 'border_width', 'corner_radius', 'text_color'],
        progress: ['fg', 'bg', 'border_color', 'border_width', 'corner_radius'],
        spinbox: ['bg', 'border_color', 'border_width', 'corner_radius', 'text_color'],
        scale: ['bg', 'border_color', 'border_width', 'corner_radius', 'text_color'],
    };
    // The colours the runtime fork reads for itself, because upstream hard-coded them inside a renderer.
    const attributes = {
        toggle: ['off_color'],
        checkbox: ['box_size', 'box_color'],
        roller: [],
        progress: [],
        spinbox: ['accent_color', 'chevron_color'],
        scale: [
            'start_angle',
            'end_angle',
            'show_labels',
            'show_needle',
            'tick_color',
            'needle_color',
            'major_ticks',
            'minor_ticks',
        ],
    };
    for (const [tag, names] of Object.entries(viaStyle)) {
        const spec = widgetSpec(tag);
        for (const name of names) {
            const property = spec.props.find((entry) => entry.name === name);
            ok(property !== undefined, `${tag} offers ${name}`);
            ok(property.viaStyle !== undefined, `${tag}'s ${name} travels in the style expression`);
            ok(property.kind === 'color' || property.kind === 'int', `${tag}'s ${name} is a colour or a size`);
            if (property.kind === 'color') {
                equal(property.defaultValue, '', `${tag}'s ${name} starts unset, not black`);
            }
        }
        for (const name of attributes[tag]) {
            const property = spec.props.find((entry) => entry.name === name);
            ok(property !== undefined, `${tag} offers ${name}`);
            equal(property.viaStyle, undefined, `${tag}'s ${name} is an attribute, not a style expression`);
        }
    }
    // And the gauge's tick counts, which the emitter used to drop on the floor.
    contains(emitKdl(document(0, [widget('g', 'scale', { x: 0, y: 0, width: 90, height: 90 })])), 'major_ticks=5', 'the gauge emits its tick counts');
});

test('a colour is set on the style the widget already wore, not on one generic default', () => {
    // The whole point of a single colour: an accent on a Roller must not also turn its panel surface into a
    // bare label. Each tag's own base is the codegen fork's fallback, and the canvas paints the same one.
    equal(ownStyleOf('toggle'), 'label', 'a toggle is plain');
    equal(ownStyleOf('checkbox'), 'label', 'so is a checkbox');
    equal(ownStyleOf('progress'), 'label', 'and a progress bar, which draws its own track');
    equal(ownStyleOf('roller'), 'panel', 'a roller is a panel');
    equal(ownStyleOf('spinbox'), 'panel', 'and so is a spinbox');
    equal(ownStyleOf('scale'), 'panel', 'and the gauge');
    equal(ownStyleOf('button'), 'button', 'a button has its own');
    equal(ownStyleOf('label'), 'label', 'and anything unknown falls back to plain');

    equal(
        appearanceExpression({ tag: 'roller', values: { accent: '#ff8800' } }),
        '{ let mut style = Style::panel(); style.accent = Rgb565::new(31, 34, 0); style }',
        'one accent is one assignment on the roller\'s own surface',
    );
    equal(
        appearanceExpression({ tag: 'toggle', style: 'panel', values: { accent: '#00ff00' } }),
        '{ let mut style = Style::panel(); style.accent = Rgb565::new(0, 63, 0); style }',
        'and a chosen base style replaces it',
    );
});

test('the appearance rules: a colour is what asks for a border, and zero keeps the base\'s', () => {
    // These three rules exist so that a half-filled form does the obvious thing. They are asserted as data
    // because the canvas resolves the same values: if it disagreed, the board and the canvas would drift.
    equal(
        JSON.stringify(resolveStyleValues({ border: '#ffff00' })),
        JSON.stringify({ border: { colour: '#ffff00', width: 1 } }),
        'a border colour alone means a one-pixel border, or a plain toggle would show nothing',
    );
    equal(
        JSON.stringify(resolveStyleValues({ border: '#ffff00', borderWidth: 3 })),
        JSON.stringify({ border: { colour: '#ffff00', width: 3 } }),
        'and a width thickens it',
    );
    equal(
        JSON.stringify(resolveStyleValues({ borderWidth: 4 })),
        JSON.stringify({ borderWidth: 4 }),
        'a width alone thickens the border the base style already had',
    );
    equal(
        JSON.stringify(resolveStyleValues({ borderWidth: 0, radius: 0 })),
        '{}',
        'a zero width and a zero radius mean "leave the base style alone"',
    );
    equal(
        JSON.stringify(resolveStyleValues({ background: '#8000ff' })),
        JSON.stringify({ background: '#8000ff' }),
        'a background is a background',
    );
    equal(JSON.stringify(resolveStyleValues({ text: 'not-a-colour' })), '{}', 'and a non-colour is nothing at all');
});

test('the emitted expression clears the gradient, because a gradient paints over a background', () => {
    // `Block::render` draws the gradient *instead of* the background, so a design that picked a flat colour on
    // a panel-based widget would otherwise see the panel's gradient and nothing else.
    const style = appearanceExpression({ tag: 'progress', values: { background: '#003300', foreground: '#ff00ff' } });
    contains(style, 'style.background = Some(Rgb565::new(0, 12, 0));', 'the background is set');
    contains(style, 'style.gradient = None;', 'and the gradient is cleared');
    contains(style, 'style.foreground = Rgb565::new(31, 0, 31);', 'with the fill colour');
    equal(style.indexOf('background'), style.indexOf('gradient') - 'style.background = Some(Rgb565::new(0, 12, 0)); '.length, 'in that order');
});

test('a control with no appearance at all emits no style, so the crate\'s own default stands', () => {
    // The other half of the promise: a design that says nothing must emit the same markup it did before these
    // properties existed. Nothing here may invent a colour.
    for (const tag of ['toggle', 'checkbox', 'roller', 'progress', 'spinbox', 'scale']) {
        equal(
            appearanceExpression({ tag, values: styleValuesOf({ props: defaultProps(tag) }, widgetSpec(tag).props) }),
            undefined,
            `${tag} needs no expression when nothing is set`,
        );
    }
    const plain = emitKdl(document(0, [widget('p', 'progress', { x: 0, y: 0, width: 100, height: 20 })]));
    contains(plain, 'progress id="p" value=0', 'a progress bar still emits its own value');
    notContains(plain, 'style=', 'and no style expression at all');
});

// ---------------------------------------------------------------- images from the SD card

test('an image can name a file on the card, and the name is checked against what the card can read', () => {
    // Reading the card is what makes this different from an asset: the file is not on the build machine, so the
    // markup carries a path the firmware opens at runtime. The card is read with short 8.3 names from its root,
    // because a generated project has no allocator for long names and opens no subdirectories.
    const image = (source) => widget('pic', 'image', { x: 0, y: 0, width: 64, height: 64 }, { props: { src: source } });
    equal(sdImageSourceProblems(image('assets/logo.bmp')).length, 0, 'an embedded asset is not a card path');
    equal(sdImageSourceProblems(image('sd:PIC1.BMP')).length, 0, 'a short name is fine');
    equal(sdImageSourceProblems(image('sd:/PIC1.BMP')).length, 0, 'and a leading slash is just a habit');
    equal(sdImageSourceProblems(image('sd:PIC1')).length, 0, 'a name with no extension is fine too');
    equal(sdImageSourceProblems(image('SD:PIC1.BMP')).length, 0, 'and the prefix is not case-sensitive');
    equal(sdImageSourceProblems(image('Sd:/PIC1.BMP')).length, 0, 'in any spelling a file manager writes');

    contains(sdImageSourceProblems(image('sd:'))[0], 'empty', 'an empty path says so');
    contains(sdImageSourceProblems(image('sd:/sub/PIC1.BMP'))[0], 'root', 'a subdirectory is refused');
    contains(sdImageSourceProblems(image('sd:PHOTO_1234.BMP'))[0], 'short file name', 'a long name is refused');
    contains(sdImageSourceProblems(image('sd:PHOTO.BMPX'))[0], 'short file name', 'and so is a long extension');
});

test('a design with a card image in it is reported when the board has no card', () => {
    // Whether the card exists belongs to the board, so the design says which widgets need one and the panel
    // adds the sentence. A board without a socket has no src/sd.rs either, so a project that cannot read the
    // card is a build failure waiting to happen -- the panel is where it should be found.
    const card = widget('pic', 'image', { x: 0, y: 0, width: 64, height: 64 }, { props: { src: 'sd:PIC1.BMP' } });
    const upper = widget('upper', 'image', { x: 0, y: 0, width: 64, height: 64 }, { props: { src: 'SD:PIC2.BMP' } });
    const asset = widget('logo', 'image', { x: 0, y: 64, width: 64, height: 64 }, { props: { src: 'assets/logo.bmp' } });
    equal(sdImagesNeedingCard([card, asset]).join(','), 'pic', 'only the card image is listed');
    equal(sdImagesNeedingCard([upper, asset]).join(','), 'upper', 'and a card written as SD: is one too');
    equal(sdImagesNeedingCard([asset]).length, 0, 'and an embedded one needs no socket');
    equal(sdImagesNeedingCard([]).length, 0, 'an empty design needs nothing');
});

test('the markup keeps the card prefix rather than turning it into an asset path', () => {
    // Two halves have to agree here: the designer writes the path as the design spelled it, and the codegen
    // fork is what notices the prefix and emits a runtime reader instead of an embedded array.
    const card = widget('pic', 'image', { x: 0, y: 0, width: 64, height: 64 }, {
        props: { ...defaultProps('image'), src: 'sd:PIC1.BMP', fit: 'center' },
    });
    const kdl = emitKdl(document(0, [card]));
    contains(kdl, 'image id="pic" src="sd:PIC1.BMP" fit="center"', 'the card path travels whole');
    notContains(kdl, 'assets/', 'and is not rewritten as a project asset');
});
