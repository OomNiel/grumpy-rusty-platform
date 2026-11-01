'use strict';

/**
 * The design as LVGL C++: what the C++ canvas writes.
 *
 * The two things that can go wrong silently are the names and the split. A handler the design calls but the
 * handler file never defines is a link error the moment the user builds, and a widget whose widget id becomes
 * an illegal C identifier is the same. So these tests pin:
 *
 *   - the handler names are the Rust ones, character for character, so one design reads the same in either
 *     language;
 *   - every tag this emitter claims is emitted, and every tag it does not is *reported* rather than dropped;
 *   - the handler sync appends what is missing and removes only the stubs it wrote itself.
 */

const { test, ok, equal, contains, notContains, compiled } = require('../../lib/harness');
const {
    SUPPORTED_TAGS,
    cppId,
    cppHandlerName,
    cppRequiredHandlers,
    emitHandlerStubsCpp,
    emitHandlersCppHeader,
    documentFontSizes,
    emitUiCpp,
    emitUiCppHeader,
    lvEventName,
    syncHandlerStubsCpp,
    unsupportedTags,
} = compiled('designer/lvgl');
const { createDocument, defaultChildren, defaultProps } = compiled('designer/model');
const { KDL_WIDGETS, widgetSpec } = compiled('designer/catalog');
const {
    DEFAULT_FONT_SIZE,
    LVGL_FONT_SIZES,
    fontSymbol,
    lvConfFontLines,
    lvglFontFor,
    nearestFontSize,
} = compiled('designer/lvglFonts');

/** A design with a title, a button, a slider and two views. */
function design() {
    const document = createDocument({
        boardId: 'pico2w',
        panelWidth: 240,
        panelHeight: 320,
        rotation: 0,
        screenId: 'RustyPanel',
    });
    document.widgets = [
        { id: 'Title', tag: 'label', x: 10, y: 10, width: 220, height: 24, props: { text: 'Hello' }, events: [] },
        { id: 'go', tag: 'button', x: 20, y: 60, width: 200, height: 50, props: { text: 'Press' }, events: ['clicked'] },
        { id: 'volume', tag: 'slider', x: 20, y: 130, width: 200, height: 20, props: { min: 0, max: 100, value: 40 }, events: ['valueChanged'] },
        { id: 'next', tag: 'button', x: 20, y: 250, width: 200, height: 40, props: { text: 'Next' }, events: ['navigate'] },
    ];
    document.widgets[3].props.navigate_to = 'second';
    document.views = [
        { id: 'main', label: 'Main', start: true },
        { id: 'second', label: 'Second' },
    ];
    return document;
}

// ------------------------------------------------------------------------- names

test('a widget id becomes a legal C identifier, and the handler name matches the Rust one', () => {
    equal(cppId('go'), 'go', 'a plain id is left alone');
    equal(cppId('my-button'), 'my_button', 'a hyphen');
    equal(cppId('2nd try'), 'w_2nd_try', 'a leading digit is prefixed, a space becomes an underscore');
    ok(/^[A-Za-z_][A-Za-z0-9_]*$/.test(cppId('weird.id/with junk')), 'and the result is always an identifier');

    equal(cppHandlerName('go', 'clicked'), 'on_go_clicked', 'the Rust spelling');
    equal(cppHandlerName('my-button', 'valueChanged'), 'on_my_button_value_changed', 'including a renamed id');
});

test('the events map onto LVGL events, with a value event for the widgets that carry one', () => {
    equal(lvEventName('clicked'), 'LV_EVENT_CLICKED', 'a click');
    equal(lvEventName('valueChanged'), 'LV_EVENT_VALUE_CHANGED', 'a value');
    equal(lvEventName('longPressed'), 'LV_EVENT_LONG_PRESSED', 'a long press');
    equal(lvEventName('scroll'), 'LV_EVENT_SCROLL', 'a scroll');
    equal(cppRequiredHandlers(design()).join(' '), 'on_go_clicked on_volume_value_changed', 'and navigate is not a handler');
});

// ------------------------------------------------------------------------ the tree

test('every widget becomes an LVGL object at the place the design put it', () => {
    const source = emitUiCpp(design());
    contains(source, 'lv_obj_t *w_title = lv_label_create(view_main);', 'a label in its view');
    contains(source, 'lv_label_set_text(w_title, "Hello");', 'with its text');
    equal(cppId('Title'), 'title', 'an id keeps the Rust snake-case rule, capitals included');
    contains(source, 'lv_obj_set_pos(w_go, 20, 60);', 'a button where the design put it');
    contains(source, 'lv_slider_set_range(w_volume, 0, 100);', 'a slider with its range');
    contains(source, 'lv_obj_add_event_cb(w_go, on_go_clicked_cb, LV_EVENT_CLICKED, nullptr);', 'and its event');
});

test('views are containers, and navigate hides one and shows the other', () => {
    const source = emitUiCpp(design());
    contains(source, 'lv_obj_t *view_main = nullptr;', 'the first view');
    contains(source, 'lv_obj_t *view_second = nullptr;', 'and the second');
    contains(source, 'ui_set_hidden(view_second, true);', 'the one not on show starts hidden');
    contains(source, 'ui_show_view("second");', 'navigate calls the switch');
    contains(source, 'strcmp(view_id, "second")', 'and the switch compares by id');
    // LVGL 9.6 deprecated the flag pair, and its per-flag setters do not exist on 9.2, so the generated file
    // asks by version and the call sites say what they mean. A clean bench build of a designer project is how
    // the warning was found (2026-10-31): three `-Wdeprecated-declarations` on a screen nobody had touched.
    contains(source, '#if LVGL_VERSION_MAJOR > 9 || (LVGL_VERSION_MAJOR == 9 && LVGL_VERSION_MINOR >= 6)', 'the choice is made once');
    contains(source, 'lv_obj_set_hidden(object, hidden);', 'the 9.6 spelling');
    contains(source, 'lv_obj_add_flag(object, LV_OBJ_FLAG_HIDDEN);', 'and the 9.2 one beside it');
    notContains(source, '    lv_obj_add_flag(view_', 'no call site reaches for the deprecated function directly');
});

test('a widget the C++ side cannot draw is named in the report, not silently dropped', () => {
    // `mesh` is the one that is still not drawable: it is 3D shaded triangles and LVGL has no rasteriser for them.
    // A chart used to be the example here, until the whole toolbox was implemented.
    const document = design();
    document.widgets.push({
        id: 'shape1',
        tag: 'mesh',
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        props: {},
        events: [],
    });
    equal(unsupportedTags(document).join(' '), 'mesh', 'the tag is reported');
    notContains(emitUiCpp(document), 'shape1', 'and nothing is emitted for it');
    ok(SUPPORTED_TAGS.button === 'lv_button', 'the map says what each tag becomes');
});

test('the header the canvas writes is the one the source is compiled against', () => {
    const header = emitUiCppHeader();
    contains(header, '#include <lvgl.h>', 'LVGL types are visible');
    contains(header, 'void ui_init();', 'the entry point');
    contains(header, 'void ui_show_view(const char *view_id);', 'and the view switch ui.cpp defines');
});

// --------------------------------------------------------------------- handlers

test('the handler stubs carry the signature the callback calls', () => {
    const stubs = emitHandlerStubsCpp(design()).join('\n');
    contains(stubs, 'extern "C" void on_go_clicked() {', 'a click takes nothing');
    contains(stubs, 'extern "C" void on_volume_value_changed() {', 'a value change takes nothing either');
    contains(emitHandlersCppHeader(design()), 'on_go_clicked()', 'and the header matches');
});

test('a new stub is appended, and an untouched one whose widget is gone is removed', () => {
    const document = design();
    const start = `#include "ui_handlers.h"\n\n${emitHandlerStubsCpp(document).join('\n')}`;
    equal(syncHandlerStubsCpp(start, document), start, 'nothing to do is nothing done');

    const grown = design();
    grown.widgets.push({
        id: 'sw',
        tag: 'toggle',
        x: 0,
        y: 200,
        width: 60,
        height: 30,
        props: {},
        events: ['valueChanged'],
    });
    const appended = syncHandlerStubsCpp(start, grown);
    contains(appended, 'on_sw_value_changed', 'the new one is added');
    contains(appended, 'on_go_clicked', 'and the old ones stay');

    const shrunk = design();
    shrunk.widgets = shrunk.widgets.filter((widget) => widget.id !== 'go');
    const pruned = syncHandlerStubsCpp(start, shrunk);
    notContains(pruned, 'on_go_clicked', 'a stub nobody wants any more goes');
    contains(pruned, 'on_volume_value_changed', 'the rest stay');
});

test('a stub somebody has filled in is never removed, even when the widget goes', () => {
    const document = design();
    const filled = `#include "ui_handlers.h"\n\nextern "C" void on_go_clicked() {\n    Serial.println("real work");\n}\n`;
    const after = syncHandlerStubsCpp(filled, { ...document, widgets: [] });
    contains(after, 'Serial.println("real work");', 'the person\'s own code survives');
});

test('the file is a C++ file: the callbacks are ours, and the handlers are extern "C"', () => {
    const source = emitUiCpp(design());
    contains(source, 'void on_go_clicked_cb(lv_event_t *event) {', 'the callback is a plain C++ function');
    contains(source, 'on_go_clicked();', 'and it calls the handler the project defines');
    notContains(source, 'extern "C" void on_go_clicked', 'which is declared in the header, not here');
});

// --------------------------------------------------------------------- the clock

/** The design from the bench (2026-11-01): one clock and nothing else. */
function clockDesign(overrides = {}) {
    const document = createDocument({ boardId: 'pico2w', panelWidth: 240, panelHeight: 320, rotation: 3, screenId: 'RustyPanel' });
    document.widgets = [
        {
            id: 'clock',
            tag: 'clock',
            x: 0,
            y: 0,
            width: 320,
            height: 240,
            props: {
                hour: 10,
                minute: 10,
                second: 0,
                hour_color: '#ffffff',
                minute_color: '#ffffff',
                second_color: '#ff0000',
                hour_tick_color: '#808080',
                minute_tick_color: '#525252',
                label_color: '#ffffff',
                show_labels: true,
                movement: true,
                // What the bench design asks for: Mono6x10 (Montserrat 14) doubled by label_scale.
                font: 'Mono6x10',
                label_scale: 2,
                ...overrides,
            },
            events: [],
        },
    ];
    return document;
}

test('the clock is drawn, not dropped: 12 hour ticks, 60 minute ticks and three hands', () => {
    // It was missing from SUPPORTED_TAGS, so a design that was only a clock emitted an empty view and the board
    // showed a blank screen (bench, 2026-11-01).
    const source = emitUiCpp(clockDesign());
    equal(unsupportedTags(clockDesign()).join(' '), '', 'nothing is unsupported about a clock');
    equal((source.match(/lv_line_create/g) ?? []).length, 63, '60 minute ticks, 12 hour ticks, 3 hands');
    contains(source, 'struct ui_clock {', 'the face has state of its own');
    contains(source, 'static const float ui_clock_sin[60]', 'and a table instead of a trigonometry library');
    contains(source, 'lv_label_set_text(numeral_clock_12, "12");', 'the numerals');
    contains(source, 'lv_color_hex(0xff0000)', 'the second hand keeps its colour');
});

test('a clock with movement runs, and one without does not', () => {
    contains(emitUiCpp(clockDesign()), 'ui_clock_tick(&clock_clock);', 'a ticking clock advances in ui_tick');
    const still = emitUiCpp(clockDesign({ movement: false }));
    notContains(still, 'ui_clock_tick(&clock_clock);', 'a still clock is not touched every loop');
    contains(still, 'nothing to recompute here', 'and says so');
});

test('the face starts at the time the design shows, and an app can hand over the real one', () => {
    const source = emitUiCpp(clockDesign());
    contains(source, 'clock_clock.hour = 10;', 'the designed hour');
    contains(source, 'clock_clock.minute = 10;', 'and minute');
    contains(source, 'void ui_clock_clock_set_time(int hour, int minute, int second) {', 'the setter exists');
    contains(source, 'clock_clock.hour = ((hour % 24) + 24) % 24;', 'and folds a value into range');
    contains(emitUiCppHeader(clockDesign()), 'void ui_clock_clock_set_time(int hour, int minute, int second);', 'declared for the app');
    equal(emitUiCppHeader(design()).includes('set_time'), false, 'a design with no clock declares none');
});

test('a clock with no numerals draws no labels', () => {
    const source = emitUiCpp(clockDesign({ show_labels: false }));
    equal(/numeral_clock_1 = lv_label_create/.test(source), false, 'no numeral objects at all');
    equal((source.match(/lv_line_create/g) ?? []).length, 63, 'and the ticks and hands are still there');
});

test('nothing is padded: a design\'s coordinates are absolute', () => {
    // LVGL's default theme pads a container, so a view the design sizes to the whole panel had its contents
    // pushed in and its last few pixels left showing the background -- a bar on the right and bottom, and a face
    // that looked off-centre (bench, 2026-11-01). Every container the emitter makes now says pad_all 0, and the
    // views and the screen are not scrollable either.
    const source = emitUiCpp(clockDesign());
    contains(source, 'lv_obj_set_style_pad_all(screen, 0, 0);', 'the screen');
    contains(source, 'lv_obj_set_style_pad_all(view_main, 0, 0);', 'a view');
    contains(source, 'ui_set_scrollable(view_main, false);', 'and a view does not scroll');
    contains(source, 'lv_obj_set_style_pad_all(w_clock, 0, 0);', 'a container widget');

    const rich = emitUiCpp(design());
    contains(rich, 'lv_obj_set_style_pad_all(view_main, 0, 0);', 'still true when widgets live in the view');
    equal(/lv_obj_set_size\(view_main, 240, 320\);/.test(rich), true, 'and the view is the canvas size, exactly');
});

// ------------------------------------------------------------------ fonts (C++)

test('a design font becomes the nearest LVGL face, and an imported one is approximated', () => {
    // LVGL has no bitmaps of its own to match `Mono8x16`; it has Montserrat at fixed sizes, compiled in one at a
    // time. The mapping is against the canvas's line height, so a label keeps its place in its rectangle.
    equal(lvglFontFor('Mono8x16').size, 20, 'the 16px-tall bitmap face is Montserrat 20');
    equal(lvglFontFor('Mono8x16').source, 'builtin', 'and it is a font the design knows');
    equal(lvglFontFor('Tiny3x5').size, 10, 'the smallest face is not left at the default');
    equal(lvglFontFor(undefined).source, 'default', 'no font named is LVGL\'s default');
    equal(lvglFontFor(undefined).size, DEFAULT_FONT_SIZE, 'which is the one always compiled in');
    equal(lvglFontFor('my-bdf-face', ['my-bdf-face']).source, 'declared', 'a BDF-declared font cannot be read by LVGL');
    equal(lvglFontFor('my-bdf-face', ['my-bdf-face']).size, 24, 'so a generous stand-in is used, and said so');
    equal(lvglFontFor('nonsense').source, 'default', 'an unknown name falls back rather than failing a build');
    // Nothing may ask for a size LVGL was not built with, and a huge request is capped.
    for (const id of ['Vector(3)', 'Mono8x16']) {
        ok(LVGL_FONT_SIZES.includes(lvglFontFor(id).size), `${id} lands on a real size`);
    }
    equal(nearestFontSize(200), 36, 'and a giant font is capped, not turned into a link error');
});

test('lv_conf.h switches on exactly the sizes the design names', () => {
    const lines = lvConfFontLines([20, 36]);
    contains(lines, '#define LV_FONT_MONTSERRAT_20 1', 'the label font');
    contains(lines, '#define LV_FONT_MONTSERRAT_36 1', 'the big one');
    contains(lines, `#define LV_FONT_DEFAULT ${fontSymbol(DEFAULT_FONT_SIZE)}`, 'and the default is always there');
    contains(lines, '#define LV_FONT_MONTSERRAT_14 1', 'even when no widget asks for it');
    equal(lines.includes('LV_FONT_MONTSERRAT_16'), false, 'nothing is switched on unused');
});

test('a widget the design gives a font gets it, and one without stays at the default', () => {
    const document = design();
    document.widgets[0].props.font = 'Mono8x16';
    const source = emitUiCpp(document);
    contains(source, 'lv_obj_set_style_text_font(w_title, &lv_font_montserrat_20, 0);', 'the label');
    // The button's text is drawn by its own label, so that is what carries the font.
    document.widgets[1].props.font = 'Mono6x10';
    contains(emitUiCpp(document), 'lv_obj_set_style_text_font(w_go_label, &lv_font_montserrat_14, 0);', 'a button label');
    const plain = emitUiCpp(design());
    equal(/text_font/.test(plain), false, 'a design that names no font emits none');
});

test('documentFontSizes is what lv_conf.h has to compile in', () => {
    const document = design();
    document.widgets[0].props.font = 'Mono8x16';
    equal(documentFontSizes(document).join(' '), '20', 'one label');
    // The clock multiplies: Mono6x10 is 14 and label_scale 2 asks for 28.
    equal(documentFontSizes(clockDesign()).join(' '), '28', 'the clock numerals');
    equal(documentFontSizes(clockDesign({ movement: false })).join(' '), '28', 'moving or not');
    const numerals = emitUiCpp(clockDesign());
    contains(numerals, 'lv_obj_set_style_text_font(numeral_clock_1, &lv_font_montserrat_28, 0);', 'and that is what ui.cpp names');
});

test('the numerals sit on their marks, with no half-a-font nudge', () => {
    // `lv_obj_align(LV_ALIGN_CENTER)` centres the label's line box, and Montserrat's metrics put a digit's ink in
    // the middle of it (ascent 13 of a 16px line at 14, 25 of 30 at 28). A `-fontSize/2` correction on top of
    // that lifted every numeral by half a digit -- obvious at 28 pt, faintly wrong at 14 (bench, 2026-11-01).
    const source = emitUiCpp(clockDesign());
    const align = (numeral) => {
        const found = new RegExp('lv_obj_align\\(numeral_clock_' + numeral + ', LV_ALIGN_CENTER, (-?\\d+), (-?\\d+)\\)').exec(source);
        ok(found !== null, `numeral ${numeral} is aligned`);
        return [Number(found[1]), Number(found[2])];
    };
    const [topX, topY] = align(12);
    const [bottomX, bottomY] = align(6);
    const [rightX, rightY] = align(3);
    equal(topX, 0, 'twelve is centred horizontally');
    equal(bottomX, 0, 'and so is six');
    equal(topY, -bottomY, 'they are the same distance above and below the centre');
    equal(rightY, 0, 'three is centred vertically');
    ok(rightX > 0, 'and sits to the right');
    // The half-font error would have made both vertical offsets larger by half the numeral size.
    equal(bottomY - topY, 2 * Math.round(0.7 * (Math.min(320, 240) / 2 - 4)), 'and the ring radius is what decides the gap');
});

// ----------------------------------------------------------- the whole toolbox

/**
 * The tags the C++ emitter still cannot draw, and why.
 *
 * Keeping this list *explicit* is the point: a widget added to the toolbox tomorrow fails the test below until it is
 * either implemented or written down here, which is the difference between a known gap and a silent one.
 */
const UNDRAWABLE_CPP = [
    'image', // needs the asset decoded to pixels at generation time; the Rust crate does that in Rust
    'icon', // the same asset pipeline, tinted through a threshold
    'mesh', // 3D shaded triangles: LVGL has no rasteriser for them
];

test('every toolbox widget is drawn, or is on the list of ones that are not', () => {
    const missing = KDL_WIDGETS.map((widget) => widget.tag).filter(
        (tag) => SUPPORTED_TAGS[tag] === undefined && !UNDRAWABLE_CPP.includes(tag),
    );
    equal(missing.length, 0, `not drawn and not listed: ${missing.join(', ')}`);
    // And the list may not lie: a tag on it must really be unsupported.
    for (const tag of UNDRAWABLE_CPP) {
        equal(SUPPORTED_TAGS[tag], undefined, `${tag} is claimed undrawable`);
    }
});

test('a design using every drawable widget emits code for all of them', () => {
    // The kitchen sink: the only check that catches a wrong LVGL call, because it is the only one that compiles.
    // Here it proves each tag reaches the emitter rather than falling through to the `default: return []` arm.
    const document = createDocument({ boardId: 'pico2w', panelWidth: 240, panelHeight: 320, rotation: 0, screenId: 'RustyPanel' });
    const drawable = KDL_WIDGETS.map((widget) => widget.tag).filter((tag) => SUPPORTED_TAGS[tag] !== undefined);
    document.widgets = drawable.map((tag, index) => {
        const spec = widgetSpec(tag);
        const widget = {
            id: `w${index}_${tag}`,
            tag,
            x: 2,
            y: 2 + index,
            width: spec?.defaultSize.width ?? 40,
            height: spec?.defaultSize.height ?? 20,
            props: { ...defaultProps(tag) },
            events: [],
        };
        const children = defaultChildren(tag);
        return children === undefined ? widget : { ...widget, children };
    });
    const source = emitUiCpp(document);
    const problems = [];
    for (const tag of drawable) {
        // Every widget creates at least one object, and the object is named after the widget.
        const id = `w${drawable.indexOf(tag)}_${tag}`;
        if (!source.includes(`w_${id}`)) {
            problems.push(`${tag} emitted nothing`);
        }
    }
    equal(problems.length, 0, problems.slice(0, 4).join('; '));
    equal(unsupportedTags(document).length, 0, 'and none of them is reported as undrawable');
});
