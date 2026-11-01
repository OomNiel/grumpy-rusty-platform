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
    emitUiCpp,
    emitUiCppHeader,
    lvEventName,
    syncHandlerStubsCpp,
    unsupportedTags,
} = compiled('designer/lvgl');
const { createDocument } = compiled('designer/model');

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
    const document = design();
    document.widgets.push({
        id: 'chart1',
        tag: 'chart',
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        props: {},
        events: [],
    });
    equal(unsupportedTags(document).join(' '), 'chart', 'the tag is reported');
    notContains(emitUiCpp(document), 'chart1', 'and nothing is emitted for it');
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
