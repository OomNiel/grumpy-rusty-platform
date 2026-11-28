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
    UNAVAILABLE_CPP,
    unavailableCppWidgets,
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
    equal((source.match(/lv_line_create/g) ?? []).length, 3, 'the three hands are the only lines');
    equal((source.match(/lv_obj_t \*tick_clock_/g) ?? []).length, 60, 'and the ticks are rectangles, one per minute');
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
    contains(source, 'clock_clock.year = ', 'and a date to start from');
    contains(source, 'void ui_clock_clock_set_time(int hour, int minute, int second) {', 'the time setter exists');
    contains(source, 'void ui_clock_clock_set_date(int year, int month, int day) {', 'and the date setter');
    contains(source, 'void ui_clock_clock_set_datetime(int year, int month, int day,', 'and the two together');
    contains(source, 'ui_clock_set_datetime(&clock_clock, clock_clock.year,', 'the time setter keeps the date it had');
    contains(source, 'clock->hour = ((hour % 24) + 24) % 24;', 'and a value is folded into range');
    const header = emitUiCppHeader(clockDesign());
    contains(header, 'void ui_clock_clock_set_time(int hour, int minute, int second);', 'declared for the app');
    contains(header, 'void ui_clock_clock_set_date(int year, int month, int day);', 'the date too');
    contains(header, 'void ui_clock_clock_set_datetime(int year, int month, int day, int hour, int minute, int second);', 'and both');
    equal(emitUiCppHeader(design()).includes('set_time'), false, 'a design with no clock declares none');
});

test('the date block follows its offset, and the day box keeps its border clear of the number', () => {
    const weekdayY = (source) => {
        const found = /lv_obj_align\(clock_clock\.weekdayLabel, LV_ALIGN_CENTER, 0, (-?\d+)\)/.exec(source);
        ok(found !== null, 'the weekday label is aligned');
        return Number(found[1]);
    };
    const monthY = (source) => {
        const found = /lv_obj_align\(clock_clock\.monthLabel, LV_ALIGN_CENTER, 0, (-?\d+)\)/.exec(source);
        ok(found !== null, 'the month label is aligned');
        return Number(found[1]);
    };
    const plain = emitUiCpp(clockDesign({ date_font: 'Mono6x10', weekday_size: 2 }));
    const shifted = emitUiCpp(clockDesign({ date_font: 'Mono6x10', weekday_size: 2, date_offset: 6 }));
    equal(weekdayY(shifted), weekdayY(plain) - 6, 'a positive offset lifts the whole block');
    // Asked 2026-11-23: *"Swop the date element order: Month/Year on top and Day of the week in the
    // middle."* LVGL's centre alignment measures downward, so the month must be the more negative one.
    ok(monthY(plain) < weekdayY(plain), 'the month and year sit above the weekday');

    // The number must not paint over the frame: the box is the label's line height plus the border
    // and a few pixels of air on each side.
    const box = /lv_obj_set_size\(clock_clock\.dayBox, (\d+), (\d+)\)/.exec(plain);
    ok(box !== null, 'the box is sized');
    ok(Number(box[1]) >= 24 && Number(box[2]) >= 24, `the box leaves room for the border and air: ${box[0]}`);
});

test('a fractional date size lands on the nearest face LVGL can switch on', () => {
    // Asked 2026-11-23 for sizing the date text by fractions. Montserrat comes in whole sizes, so a
    // weight of 1.5 has to move the chosen face between the whole steps rather than being rounded
    // back to 1 or up to 2.
    const weekdayFace = (source) => {
        const found = /lv_obj_set_style_text_font\(clock_clock\.weekdayLabel, &lv_font_montserrat_(\d+), 0\)/.exec(source);
        ok(found !== null, 'the weekday label has a face');
        return Number(found[1]);
    };
    const one = weekdayFace(emitUiCpp(clockDesign({ date_font: 'Mono6x10', weekday_size: 1 })));
    const half = weekdayFace(emitUiCpp(clockDesign({ date_font: 'Mono6x10', weekday_size: 1.5 })));
    const two = weekdayFace(emitUiCpp(clockDesign({ date_font: 'Mono6x10', weekday_size: 2 })));
    ok(one < half && half < two, `a fraction is neither whole step: ${one}, ${half}, ${two}`);
});

test('a clock with no numerals draws no labels', () => {
    const source = emitUiCpp(clockDesign({ show_labels: false }));
    equal(/numeral_clock_1 = lv_label_create/.test(source), false, 'no numeral objects at all');
    equal((source.match(/lv_obj_t \*tick_clock_/g) ?? []).length, 60, 'and the ticks are still there');
});

function barDesign(overrides = {}) {
    const document = createDocument({ boardId: 'pico2w', panelWidth: 240, panelHeight: 320, rotation: 0, screenId: 'RustyPanel' });
    document.widgets = [
        {
            id: 'bar',
            tag: 'status_bar',
            x: 0,
            y: 0,
            width: 240,
            height: 24,
            props: {
                label: 'BATT',
                time: '10:10',
                show_clock: true,
                clock_align: 'right',
                show_battery: true,
                battery_align: 'right',
                font_scale: 1.5,
                label_color: '#ff0000',
                clock_color: '#00ff00',
                battery_color: '#0000ff',
                ...overrides,
            },
            events: [],
        },
    ];
    return document;
}

/** The x a feature's label was aligned to, read back out of the emitted call. */
function barAlignX(source, name) {
    const match = new RegExp(`lv_obj_align\\(${name}, LV_ALIGN_LEFT_MID, (-?\\d+), 0\\);`).exec(source);
    return match === null ? undefined : Number(match[1]);
}

test('a status bar draws its label, clock and battery as three separate features', () => {
    const source = emitUiCpp(barDesign());
    contains(source, 'lv_obj_t *w_bar_label = lv_label_create(w_bar);', 'the label');
    contains(source, 'lv_label_set_text(w_bar_label, "BATT");', 'with its text');
    contains(source, 'lv_obj_set_style_text_color(w_bar_label, lv_color_hex(0xff0000), 0);', 'in its own colour');
    contains(source, 'lv_obj_t *w_bar_time = lv_label_create(w_bar);', 'the clock');
    contains(source, 'lv_obj_set_style_text_color(w_bar_time, lv_color_hex(0x00ff00), 0);', 'in its own colour');
    contains(source, 'lv_label_set_text(w_bar_time, "10:10");', 'and its time');
    contains(source, 'lv_obj_t *w_bar_battery = lv_obj_create(w_bar);', 'the gauge');
    contains(source, 'lv_obj_set_style_border_color(w_bar_battery, lv_color_hex(0x0000ff), 0);', 'in its own colour');
    contains(source, 'lv_obj_t *w_bar_fill = lv_obj_create(w_bar_battery);', 'with a fill');
});

test('hiding a feature leaves it out, and both hidden leaves the strip empty', () => {
    const noClock = emitUiCpp(barDesign({ show_clock: false }));
    notContains(noClock, 'w_bar_time', 'no clock object at all');
    const noBattery = emitUiCpp(barDesign({ show_battery: false }));
    notContains(noBattery, 'w_bar_battery', 'no gauge object at all');
    const bare = emitUiCpp(barDesign({ show_clock: false, show_battery: false, label: '' }));
    notContains(bare, 'w_bar_label', 'and no label when it is empty');
});

test('right-aligned features stack to the right of centred ones', () => {
    const right = emitUiCpp(barDesign({ clock_align: 'right', battery_align: 'right' }));
    const centred = emitUiCpp(barDesign({ clock_align: 'center', battery_align: 'center' }));
    const rightX = barAlignX(right, 'w_bar_time');
    const centreX = barAlignX(centred, 'w_bar_time');
    ok(rightX !== undefined && centreX !== undefined, 'both emit a clock position');
    ok(rightX > centreX, `a right-aligned clock sits further right (${rightX} > ${centreX})`);
    ok(rightX > 120, `and in the right half of a 240-pixel bar (${rightX})`);
});

test('the font scale is a compiled Montserrat size, not a whole-font toggle', () => {
    const source = emitUiCpp(barDesign());
    contains(source, fontSymbol(nearestFontSize(DEFAULT_FONT_SIZE * 1.5)), 'the scaled face');
    ok(documentFontSizes(barDesign()).includes(nearestFontSize(DEFAULT_FONT_SIZE * 1.5)), 'and the build switches it on');
    notContains(emitUiCpp(barDesign({ font_scale: 1 })), fontSymbol(nearestFontSize(DEFAULT_FONT_SIZE * 1.5)), 'a scale of one asks for the base face');
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
    // The clock multiplies: Mono6x10 is 14 and label_scale 2 asks for 28. The date block shares the
    // clock's face, and its three lines are the design's own sizes -- 14 each -- with no fit.
    equal(documentFontSizes(clockDesign()).join(' '), '28 14 14 14', 'the clock numerals and its date');
    equal(documentFontSizes(clockDesign({ movement: false })).join(' '), '28 14 14 14', 'moving or not');
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
const UNDRAWABLE_CPP = Object.keys(UNAVAILABLE_CPP);

test('a C++ project is told which widgets its language cannot draw, in words', () => {
    // The list lives beside the emitter's coverage, so the toolbox and the generated code cannot disagree. One
    // entry today: LVGL has no 3D rasteriser, so a mesh would be an empty box.
    equal(UNDRAWABLE_CPP.join(','), 'mesh', 'the mesh is the one gap');
    const listed = unavailableCppWidgets();
    equal(listed.length, 1, 'and it is sent to the panel as a table');
    equal(listed[0].tag, 'mesh', 'under the tag the toolbox knows');
    contains(listed[0].reason, 'LVGL has no 3D rasteriser', 'with the reason, not just a refusal');
    contains(listed[0].reason, 'Rust option draws it', 'and where the person can get it');
});

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

test('all sixty ticks are drawn, each at its own minute and in its own colour', () => {
    // Ticks are rotated rectangles, not `lv_line`s: a line has no area of its own, and LVGL needs one to invalidate
    // -- the diagonal ticks kept the background while the ones near an axis drew, which is what "the minute ticks
    // render unpainted except next to 12, 3, 6 and 9" looked like (bench, 2026-11-01).
    const source = emitUiCpp(clockDesign({ hour_tick_color: '#f70202', minute_tick_color: '#04fb14' }));
    const ticks = [...source.matchAll(/bg_color\(tick_clock_(\d+), lv_color_hex\(0x([0-9a-f]+)\)/g)];
    equal(ticks.length, 60, 'sixty ticks, one per minute mark');
    equal(ticks.filter((tick) => tick[2] === 'f70202').length, 12, 'twelve in the hour colour, every five minutes');
    equal(ticks.filter((tick) => tick[2] === '04fb14').length, 48, 'and forty-eight in the minute colour');
    // Each tick has a real area ...
    contains(source, 'lv_obj_set_size(tick_clock_0, 3, 14);', 'the twelve is a 3-pixel mark');
    contains(source, 'lv_obj_set_style_transform_rotation(tick_clock_59, 3540, 0);', 'and the fifty-ninth is turned 354 degrees');
    // ... and turns about the face's centre, not its own end: a pivot on the tick's top end left all sixty
    // stacked at the twelve, because every one of them was swinging around the same point up there.
    // 320x240 face -> centre (160,120), radius 116, outer 109.
    contains(source, 'lv_obj_set_pos(tick_clock_5, 159, 11);', 'a tick starts at twelve o\'clock, outer radius above the centre');
    contains(source, 'lv_obj_set_style_transform_pivot_y(tick_clock_5, 109, 0);', 'and its pivot lands on the centre itself');
    equal(/lv_line_create\(parent\);\n    lv_line_set_points\(tick_/.test(source), false, 'no tick is a line');
});

test('a clock wears the design\'s background, frame and corners', () => {
    // Emitting the container transparent ignored every one of them: the design's `bg` never reached the glass
    // (bench, 2026-11-01).
    const document = clockDesign({ bg: '#102030', border_color: '#00ffff', border_width: 2, corner_radius: 8 });
    const source = emitUiCpp(document);
    contains(source, 'lv_obj_set_style_bg_color(w_clock, lv_color_hex(0x102030), 0);', 'the face colour');
    contains(source, 'lv_obj_set_style_bg_opa(w_clock, LV_OPA_COVER, 0);', 'opaque enough to see');
    contains(source, 'lv_obj_set_style_border_color(w_clock, lv_color_hex(0x00ffff), 0);', 'the frame');
    contains(source, 'lv_obj_set_style_border_width(w_clock, 2, 0);', 'and its width');
    contains(source, 'lv_obj_set_style_radius(w_clock, 8, 0);', 'and the corners');
    // With no background in the design the container stays transparent, as a clock on a coloured view should.
    const plain = emitUiCpp(clockDesign({ bg: '' }));
    contains(plain, 'lv_obj_set_style_bg_opa(w_clock, LV_OPA_TRANSP, 0);', 'no colour means no fill');
});

test('every board and both languages scale the clock date text', () => {
    // Asked 2026-11-25: *"Run through all board and language options … to check the date text scaling for
    // the Clock widget."* The Rust markup must name the attributes the crate parser reads, and the C++
    // labels must name scaled faces that `lv_conf.h` actually switches on -- on every board, and for every
    // panel revision a board offers.
    const { BOARDS } = compiled('boards/catalog');
    const { defaultWiring } = compiled('boards/panels');
    const { emitKdl } = compiled('designer/kdl');
    const { generateProjectFiles } = compiled('generate/files');
    const { generateArduinoProjectFiles, lvConfHeader } = compiled('generate/arduino');

    // Medium5x7 maps to Montserrat 12, so 1.5 → 18, 2 → 24, 2.4 → 28: every step is inside the emitter's
    // 36-point flash cap and can be told apart. A bigger base font is capped (see `MAX_FONT_SIZE`).
    const dateFont = 'Medium5x7';
    const weights = { weekday_size: 1.5, month_size: 2, day_size: 2.4 };
    const panelAnswers = (board) => {
        const panel = board.options?.find((option) => option.id === 'panel');
        return panel === undefined ? [{}] : panel.choices.map((choice) => ({ [panel.id]: choice.id }));
    };
    const fontOf = (source, label) => {
        const found = new RegExp(
            `lv_obj_set_style_text_font\\(clock_clock\\.${label}, &lv_font_montserrat_(\\d+), 0\\)`,
        ).exec(source);
        return found === null ? undefined : Number(found[1]);
    };

    for (const board of BOARDS) {
        const wiring = board.family === 'RP2040' || board.family === 'RP2350'
            ? defaultWiring(board, 'ili9341')
            : undefined;
        for (const choices of panelAnswers(board)) {
            const where = `${board.id}${Object.values(choices).length > 0 ? `:${Object.values(choices)[0]}` : ''}`;
            const document = createDocument({
                boardId: board.id,
                panelWidth: 320,
                panelHeight: 480,
                rotation: 0,
                screenId: 'RustyPanel',
            });
            document.widgets.push({
                id: 'clock', tag: 'clock', x: 0, y: 0, width: 260, height: 260,
                props: { ...defaultProps('clock'), date_font: dateFont, ...weights },
                events: [],
            });

            // Rust: the markup the crate's parser reads.
            const kdl = emitKdl(document);
            for (const text of ['weekday_scale=1.5', 'month_scale=2', 'day_scale=2.4']) {
                contains(kdl, text, `${where}: the Rust markup carries ${text}`);
            }
            ok(Number.isInteger(generateProjectFiles({
                board, projectName: `probe-${board.id}`, template: 'designer', wiring, choices,
            }).length), `${where}: a Rust designer project generates`);

            // C++: three distinct faces, each switched on in lv_conf.h.
            const source = emitUiCpp(document);
            const sizes = ['weekdayLabel', 'monthLabel', 'dayLabel'].map((label) => fontOf(source, label));
            ok(
                sizes.every((size) => size !== undefined),
                `${where}: all three date labels name a face (${sizes.join(', ')})`,
            );
            ok(
                sizes[0] < sizes[1] && sizes[1] < sizes[2],
                `${where}: the faces scale with the design (${sizes.join(' < ')})`,
            );
            const conf = lvConfHeader(documentFontSizes(document));
            for (const size of sizes) {
                contains(conf, `#define LV_FONT_MONTSERRAT_${size} 1`, `${where}: Montserrat ${size} is enabled`);
            }
            ok(Number.isInteger(generateArduinoProjectFiles({
                board, projectName: `probe-${board.id}`, template: 'designer', wiring, choices,
            }).length), `${where}: a C++ designer project generates`);
        }
    }
});
