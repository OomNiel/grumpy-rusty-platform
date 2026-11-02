/**
 * The design document as LVGL C++ -- the C++ twin of `generate.ts`'s `emitUiRs`.
 *
 * One design becomes one LVGL object tree: a container per view (the ones not on show are hidden), and each
 * widget becomes the LVGL object its tag names. Two things must match `emitUiRs` exactly: the **handler names**
 * (`on_<id>_<suffix>`, from `EVENT_SPECS`, so a design reads the same in either language) and the **file
 * split** -- `ui.cpp` is generated and rewritten, `ui_handlers.cpp` is appended to and is the person's.
 *
 * Coverage is honest rather than complete. Every widget with a direct LVGL 9 object is emitted; the ones that
 * are this extension's own drawing code on the Rust side (chart, plotter, mesh, status bar, ...) are **named in
 * a report** instead of being drawn as nothing. `unsupportedTags()` is that list.
 *
 * Pure: no `vscode`, so the t1 layer pins the emitted code and the handler sync.
 */

import { EVENT_SPECS, type DesignerEvent } from './catalog';
import type { DesignerDocument, DesignerWidget, DesignerView } from './model';
import { designFontOf, fontSymbol, lvglFontFor, nearestFontSize } from './lvglFonts';
import { pixelLines, type CppImageSlots } from './lvglImages';
import { flattenPath } from './lvglShapes';
import { designViews, rustFieldName } from './model';

/** Tags this emitter draws, and what each one becomes. Anything else is reported, not drawn. */
export const SUPPORTED_TAGS: Readonly<Record<string, string>> = {
    panel: 'lv_obj',
    label: 'lv_label',
    text_lines: 'a flex column of lv_label',
    button: 'lv_button',
    toggle: 'lv_switch',
    checkbox: 'lv_checkbox',
    slider: 'lv_slider',
    dropdown: 'lv_dropdown',
    roller: 'lv_roller',
    progress: 'lv_bar',
    arc: 'lv_arc',
    spacer: 'lv_obj',
    rect: 'lv_obj',
    circle: 'lv_obj',
    line: 'lv_line',
    triangle: 'lv_line',
    clock: 'lv_obj + lv_line hands',
    chart: 'lv_chart',
    plotter: 'lv_chart (the ring buffer unrolled)',
    scale: 'lv_scale + a line needle',
    spinbox: 'lv_spinbox',
    number_picker: 'lv_spinbox + a unit label',
    time_picker: 'lv_obj + lv_roller',
    busy_wheel: 'lv_spinner',
    status_bar: 'lv_obj + lv_label + lv_line',
    content_indicator: 'lv_obj dots',
    crumbs: 'lv_obj bars',
    dialog: 'lv_obj + lv_label + lv_button',
    table: 'lv_table',
    carousel: 'lv_obj + lv_label',
    path: 'lv_line, flattened at generation time',
    image: 'lv_image, its file decoded to pixels at generation time',
    icon: 'lv_image, its parts composited at generation time',
    keypad: 'lv_keyboard + lv_textarea',
};

/** Every tag in the design this emitter cannot draw, without duplicates. */
export function unsupportedTags(document: DesignerDocument): string[] {
    const tags: string[] = [];
    for (const widget of document.widgets) {
        if (SUPPORTED_TAGS[widget.tag] === undefined && !tags.includes(widget.tag)) {
            tags.push(widget.tag);
        }
    }
    return tags;
}

/** The C identifier for a widget id: a design may name a widget anything, C may not. */
export function cppId(id: string): string {
    const snake = rustFieldName(id).replace(/[^A-Za-z0-9_]/g, '_');
    return /^[A-Za-z_]/.test(snake) ? snake : `w_${snake}`;
}

/** `on_go_clicked` -- exactly the name the Rust side gives the same event. */
export function cppHandlerName(id: string, event: DesignerEvent): string {
    return `on_${cppId(id)}_${EVENT_SPECS[event].suffix}`;
}

/** Every handler a design needs, in document order, without duplicates. */
export function cppRequiredHandlers(document: DesignerDocument): string[] {
    const names: string[] = [];
    for (const widget of document.widgets) {
        for (const event of widget.events) {
            if (EVENT_SPECS[event].action !== undefined) {
                continue; // navigate becomes a ui_show_view() call, not a handler
            }
            const name = cppHandlerName(widget.id, event);
            if (!names.includes(name)) {
                names.push(name);
            }
        }
    }
    return names;
}

function textOf(widget: DesignerWidget, key: string, fallback = ''): string {
    const value = widget.props[key];
    return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback;
}

function numberProp(widget: DesignerWidget, key: string, fallback: number): number {
    const value = widget.props[key];
    if (typeof value === 'number') {
        return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }
    return fallback;
}

function boolProp(widget: DesignerWidget, key: string): boolean {
    return widget.props[key] === true;
}

/** A C string literal, with everything that would end it early escaped. */
function cString(text: string): string {
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function colourLiteral(value: unknown): string | undefined {
    return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
        ? `lv_color_hex(0x${value.slice(1)})`
        : undefined;
}

/** The LVGL event one design event listens to. */
export function lvEventName(event: DesignerEvent): string {
    switch (event) {
        case 'clicked':
            return 'LV_EVENT_CLICKED';
        case 'pressed':
            return 'LV_EVENT_PRESSED';
        case 'released':
            return 'LV_EVENT_RELEASED';
        case 'doubleClicked':
            return 'LV_EVENT_DOUBLE_CLICKED';
        case 'longPressed':
            return 'LV_EVENT_LONG_PRESSED';
        case 'scroll':
            return 'LV_EVENT_SCROLL';
        case 'textInput':
            return 'LV_EVENT_KEY';
        case 'opened':
            return 'LV_EVENT_READY';
        case 'closed':
            return 'LV_EVENT_CANCEL';
        default:
            return 'LV_EVENT_VALUE_CHANGED';
    }
}

/** The C++ type a handler takes beyond its widget, or nothing. */
export function handlerArgument(event: DesignerEvent): string {
    const spec = EVENT_SPECS[event];
    if (spec.parameter !== undefined) {
        const type = spec.parameter.type === 'i32' ? 'int32_t' : spec.parameter.type;
        return `${type} ${spec.parameter.name}`;
    }
    if (spec.argumentType === '&str') {
        return 'const char *text';
    }
    return '';
}

/** How a callback gets the handler's argument out of the widget LVGL handed it. */
function argumentRead(widget: DesignerWidget, event: DesignerEvent): string {
    const spec = EVENT_SPECS[event];
    if (spec.parameter !== undefined) {
        if (widget.tag === 'slider') {
            return 'const int32_t value = static_cast<int32_t>(lv_slider_get_value(target));';
        }
        if (widget.tag === 'arc') {
            return 'const int32_t value = static_cast<int32_t>(lv_arc_get_value(target));';
        }
        if (widget.tag === 'progress') {
            return 'const int32_t value = static_cast<int32_t>(lv_bar_get_value(target));';
        }
        return 'const int32_t value = static_cast<int32_t>(lv_dropdown_get_selected(target));';
    }
    if (spec.argumentType === '&str') {
        return 'const char *text = lv_textarea_get_text(target);';
    }
    return '';
}

function argumentName(event: DesignerEvent): string {
    const spec = EVENT_SPECS[event];
    if (spec.parameter !== undefined) {
        return spec.parameter.name;
    }
    return spec.argumentType === '&str' ? 'text' : '';
}

/** One widget, as the statements that build it. Empty for a tag this emitter cannot draw. */
// ------------------------------------------------------------------------ clock

/**
 * The analogue clock face, as LVGL objects.
 *
 * The Rust face is drawn with the crate's own drawing code; here it is made of ordinary objects so the same design
 * looks the same and costs no drawing code -- 60 minute ticks, 12 hour ticks, the numerals, and three `lv_line`
 * hands. Ticks and numerals never move, so their geometry is worked out *here*, in TypeScript, and emitted as
 * literals: no `math.h` and no trigonometric code in the firmware. Only the hands need arithmetic at runtime, and
 * a 60-entry table of unit vectors is all of it.
 *
 * The widget holds a *time*, not a running clock -- the catalogue says so, and the Rust side obeys it. `movement`
 * is what turns it into one: a design that asks for movement advances a second at a time from `millis()`, which is
 * what a board with no RTC can honestly do, and the generated `ui_clock_<id>_set_time()` is how an app that *does*
 * know the time (NTP, an RTC) hands it over.
 */
const CLOCK_STEPS = 60;
const CLOCK_COS = Array.from({ length: CLOCK_STEPS }, (_, index) =>
    Math.cos((index * 2 * Math.PI) / CLOCK_STEPS).toFixed(6),
);
const CLOCK_SIN = Array.from({ length: CLOCK_STEPS }, (_, index) =>
    Math.sin((index * 2 * Math.PI) / CLOCK_STEPS).toFixed(6),
);

/** One clock's fixed geometry, worked out from the rectangle the design gives it. */
interface ClockGeometry {
    /** Centre, in the clock's own coordinates. */
    cx: number;
    cy: number;
    /** The face's radius: where the ticks and the numerals are placed from. */
    radius: number;
    /** Where a hand ends, per hand, in pixels. */
    hourLength: number;
    minuteLength: number;
    secondLength: number;
    /** `{x, y}` centres of the numerals 1..12 on the face. */
    numerals: number[][];
}

function clockGeometry(widget: DesignerWidget): ClockGeometry {
    const width = Math.round(widget.width);
    const height = Math.round(widget.height);
    const cx = Math.round(width / 2);
    const cy = Math.round(height / 2);
    const radius = Math.max(12, Math.round(Math.min(width, height) / 2) - 4);
    const at = (index: number, distance: number): number[] => [
        cx + Math.round(distance * Math.cos((index * 2 * Math.PI) / CLOCK_STEPS - Math.PI / 2)),
        cy + Math.round(distance * Math.sin((index * 2 * Math.PI) / CLOCK_STEPS - Math.PI / 2)),
    ];
    const numerals: number[][] = [];
    for (let hour = 1; hour <= 12; hour += 1) {
        numerals.push(at(Math.round((hour * CLOCK_STEPS) / 12), radius * 0.7));
    }
    return {
        cx,
        cy,
        radius,
        hourLength: Math.round(radius * 0.45),
        minuteLength: Math.round(radius * 0.62),
        secondLength: Math.round(radius * 0.7),
        numerals,
    };
}

/** The runtime half: one struct per clock, and the three calls that drive it. Emitted once per design. */
const CLOCK_HELPERS = `// ---- the clock face ----------------------------------------------------------
//
// Ticks and numerals are static geometry, so they are literals below. The hands are the only moving parts.

/** One face's state: its three lines, the points they are drawn from, and the time they show. */
struct ui_clock {
    lv_obj_t *hourHand;
    lv_obj_t *minuteHand;
    lv_obj_t *secondHand;
    lv_point_precise_t hourPoints[2];
    lv_point_precise_t minutePoints[2];
    lv_point_precise_t secondPoints[2];
    int cx;
    int cy;
    int hourLength;
    int minuteLength;
    int secondLength;
    int hour;
    int minute;
    int second;
    uint32_t lastMs;
};

/** Hand angles: 60 unit vectors, one per six degrees, so no trigonometry is linked in. */
static const float ui_clock_cos[60] = {${CLOCK_COS.join(', ')}};
static const float ui_clock_sin[60] = {${CLOCK_SIN.join(', ')}};

static int ui_clock_step(float unit, int length) {
    const float scaled = unit * static_cast<float>(length);
    return static_cast<int>(scaled < 0 ? scaled - 0.5f : scaled + 0.5f);
}

/** One hand: from the centre outwards, at the angle its value names. */
static void ui_clock_place(lv_obj_t *hand, lv_point_precise_t *points, int cx, int cy, int length, int step) {
    points[0].x = cx;
    points[0].y = cy;
    points[1].x = cx + ui_clock_step(ui_clock_cos[step], length);
    points[1].y = cy + ui_clock_step(ui_clock_sin[step], length);
    lv_line_set_points(hand, points, 2);
}

static void ui_clock_hands(ui_clock *clock) {
    // The hour hand creeps between the hours, which is the only thing that tells 3:45 from 3:00 at a glance.
    const int hourStep = ((clock->hour % 12) * 5 + clock->minute / 12) % 60;
    ui_clock_place(clock->hourHand, clock->hourPoints, clock->cx, clock->cy, clock->hourLength, hourStep);
    ui_clock_place(clock->minuteHand, clock->minutePoints, clock->cx, clock->cy, clock->minuteLength, clock->minute % 60);
    ui_clock_place(clock->secondHand, clock->secondPoints, clock->cx, clock->cy, clock->secondLength, clock->second % 60);
}

/**
 * A second at a time, from millis(): what a board with no RTC can honestly do.
 *
 * The design's hour/minute/second are the starting point, so a face that shows 10:10 begins there and runs.
 */
static void ui_clock_tick(ui_clock *clock) {
    const uint32_t now = millis();
    while (static_cast<uint32_t>(now - clock->lastMs) >= 1000u) {
        clock->lastMs += 1000u;
        clock->second += 1;
        if (clock->second >= 60) {
            clock->second = 0;
            clock->minute += 1;
            if (clock->minute >= 60) {
                clock->minute = 0;
                clock->hour = (clock->hour + 1) % 24;
            }
        }
        ui_clock_hands(clock);
    }
}

[[clocks]]
`;

/** The C++ for one clock: its geometry, its hands and the two entry points an app needs. */
function clockBlock(widget: DesignerWidget, document: DesignerDocument): string {
    const id = cppId(widget.id);
    const geometry = clockGeometry(widget);
    const hour = Math.round(numberProp(widget, 'hour', 10)) % 24;
    const minute = Math.round(numberProp(widget, 'minute', 10)) % 60;
    const second = Math.round(numberProp(widget, 'second', 0)) % 60;
    const movement = boolProp(widget, 'movement');
    const hourColour = colourLiteral(widget.props.hour_color) ?? 'lv_color_hex(0xFFFFFF)';
    const minuteColour = colourLiteral(widget.props.minute_color) ?? 'lv_color_hex(0xFFFFFF)';
    const secondColour = colourLiteral(widget.props.second_color) ?? 'lv_color_hex(0xFF0000)';
    const majorColour = colourLiteral(widget.props.hour_tick_color) ?? 'lv_color_hex(0x808080)';
    const minorColour = colourLiteral(widget.props.minute_tick_color) ?? 'lv_color_hex(0x525252)';
    const labelColour = colourLiteral(widget.props.label_color) ?? 'lv_color_hex(0xFFFFFF)';
    void movement;
    const lines = [
        `static ui_clock clock_${id};`,
        '',
        `static void clock_${id}_build(lv_obj_t *parent) {`,
        `    clock_${id}.cx = ${geometry.cx};`,
        `    clock_${id}.cy = ${geometry.cy};`,
        `    clock_${id}.hourLength = ${geometry.hourLength};`,
        `    clock_${id}.minuteLength = ${geometry.minuteLength};`,
        `    clock_${id}.secondLength = ${geometry.secondLength};`,
        `    clock_${id}.hour = ${hour};`,
        `    clock_${id}.minute = ${minute};`,
        `    clock_${id}.second = ${second};`,
        `    clock_${id}.lastMs = millis();`,
    ];
    // A tick is a small filled rectangle, rotated about the face's centre -- not an `lv_line`.
    //
    // Lines were the obvious choice and the wrong one: an `lv_line` object has no size of its own, and LVGL needs
    // an area to invalidate. The ticks that lay almost along an axis survived; the diagonal ones kept whatever was
    // behind them, which is exactly "the minute ticks render in the unpainted colour except next to 12, 3, 6 and 9"
    // (bench, 2026-11-01). A rectangle has a real area, and its colour is a background -- the primitive the dots,
    // the dialog and the face itself already use.
    for (let index = 0; index < 60; index += 1) {
        const major = index % 5 === 0;
        const thickness = major ? 3 : 2;
        const inner = Math.round(geometry.radius * (major ? 0.82 : 0.9));
        const outer = Math.round(geometry.radius * 0.94);
        const length = Math.max(2, outer - inner);
        lines.push(
            `    lv_obj_t *tick_${id}_${index} = lv_obj_create(parent);`,
            `    lv_obj_set_size(tick_${id}_${index}, ${thickness}, ${length});`,
            `    lv_obj_set_pos(tick_${id}_${index}, ${geometry.cx - Math.floor(thickness / 2)}, ${geometry.cy - outer});`,
            `    lv_obj_set_style_radius(tick_${id}_${index}, 0, 0);`,
            `    lv_obj_set_style_border_width(tick_${id}_${index}, 0, 0);`,
            `    lv_obj_set_style_pad_all(tick_${id}_${index}, 0, 0);`,
            `    lv_obj_set_style_bg_opa(tick_${id}_${index}, LV_OPA_COVER, 0);`,
            `    lv_obj_set_style_bg_color(tick_${id}_${index}, ${major ? majorColour : minorColour}, 0);`,
            // Turned about the *face's centre*, which for a tick sitting at twelve o'clock is `outer` pixels below
            // its own top -- outside the little rectangle, and that is fine: LVGL takes the pivot in object
            // coordinates and does not require it to be inside them. Pivoting on the tick's own top end instead
            // left all sixty of them stacked at the twelve (bench, 2026-11-01).
            `    lv_obj_set_style_transform_pivot_x(tick_${id}_${index}, ${Math.floor(thickness / 2)}, 0);`,
            `    lv_obj_set_style_transform_pivot_y(tick_${id}_${index}, ${outer}, 0);`,
            `    lv_obj_set_style_transform_rotation(tick_${id}_${index}, ${index * 60}, 0);`,
        );
    }
    const numeralSize = (() => {
        const named = designFontOf(widget.props);
        const scale = Math.max(1, Math.round(numberProp(widget, 'label_scale', 1)));
        const base = lvglFontFor(named, document.fonts.map((font) => font.id)).size;
        return named === undefined ? base : nearestFontSize(base * scale);
    })();
    const numeralFont = fontSymbol(numeralSize);
    // No vertical nudge, and that is measured rather than assumed: `lv_obj_align(LV_ALIGN_CENTER)` centres the
    // label's *line box*, and Montserrat's own metrics put a digit's ink in the middle of it -- ascent 13 of a
    // 16px line at size 14, 25 of 30 at 28, so (ascent - capHeight/2) lands on lineHeight/2 either way. A
    // half-font-height correction on top of that pushed every numeral up by half a digit (bench, 2026-11-01).
    const numeralY = 0;
    if (widget.props.show_labels === undefined || boolProp(widget, 'show_labels')) {
        geometry.numerals.forEach(([x, y], index) => {
            lines.push(
                `    lv_obj_t *numeral_${id}_${index + 1} = lv_label_create(parent);`,
                `    lv_label_set_text(numeral_${id}_${index + 1}, "${index + 1}");`,
                `    lv_obj_set_style_text_color(numeral_${id}_${index + 1}, ${labelColour}, 0);`,
                `    lv_obj_set_style_text_font(numeral_${id}_${index + 1}, ${numeralFont}, 0);`,
                `    lv_obj_align(numeral_${id}_${index + 1}, LV_ALIGN_CENTER, ${(x ?? 0) - geometry.cx}, ${(y ?? 0) - geometry.cy + numeralY
                });`,
            );
        });
    }
    lines.push(
        `    clock_${id}.hourHand = lv_line_create(parent);`,
        `    lv_obj_set_style_line_color(clock_${id}.hourHand, ${hourColour}, 0);`,
        `    lv_obj_set_style_line_width(clock_${id}.hourHand, 5, 0);`,
        `    clock_${id}.minuteHand = lv_line_create(parent);`,
        `    lv_obj_set_style_line_color(clock_${id}.minuteHand, ${minuteColour}, 0);`,
        `    lv_obj_set_style_line_width(clock_${id}.minuteHand, 3, 0);`,
        `    clock_${id}.secondHand = lv_line_create(parent);`,
        `    lv_obj_set_style_line_color(clock_${id}.secondHand, ${secondColour}, 0);`,
        `    lv_obj_set_style_line_width(clock_${id}.secondHand, 2, 0);`,
        `    ui_clock_hands(&clock_${id});`,
        `}`,
    );
    return lines.join('\n');
}


/** The accent colour a design gives a widget, or the crate's own cyan when it names none. */
function accentOf(widget: DesignerWidget): string {
    return colourLiteral(widget.props.accent) ?? 'lv_color_hex(0x00FFFF)';
}

/** The accent when the design set one, otherwise its text colour: the selected item of a strip. */
function accentOrText(widget: DesignerWidget): string {
    return colourLiteral(widget.props.accent) ?? colourLiteral(widget.props.text_color) ?? 'lv_color_hex(0xFFFFFF)';
}

/**
 * The numbers behind a chart or a plotter, from the design's `values` list.
 *
 * A plotter is a ring buffer with the newest sample at `head`; the design's head is a fixed number, so the list is
 * rotated here and LVGL is given a plain series. Anything that is not a number is dropped rather than sent as zero,
 * which is what the canvas does too.
 */
function seriesOf(widget: DesignerWidget, rotate: boolean): number[] {
    const raw = textOf(widget, 'values');
    const values = raw
        .split(',')
        .map((entry) => Number(entry.trim()))
        .filter((value) => Number.isFinite(value));
    if (!rotate || values.length === 0) {
        return values;
    }
    const head = Math.max(0, Math.round(numberProp(widget, 'head', 0))) % values.length;
    return values.map((_, index) => values[(head + index) % values.length] ?? 0);
}

/** The items a carousel lists, which the design keeps as its `options` children. */
function optionsOf(widget: DesignerWidget): string[] {
    return widget.children?.kind === 'options' ? [...widget.children.values] : [];
}

/** A table's cells: the header row first when the design has one, then every row. */
function tableRowsOf(widget: DesignerWidget): { cells: string[][]; maxColumns: number } {
    if (widget.children?.kind !== 'table') {
        return { cells: [], maxColumns: 1 };
    }
    const cells: string[][] = [];
    if (widget.children.headers.length > 0) {
        cells.push([...widget.children.headers]);
    }
    for (const row of widget.children.rows) {
        cells.push([...row]);
    }
    return { cells, maxColumns: Math.max(1, ...cells.map((row) => row.length)) };
}

function widgetLines(
    widget: DesignerWidget,
    parent: string,
    document: DesignerDocument,
    images: CppImageSlots,
): string[] {
    const variable = `w_${cppId(widget.id)}`;
    const lines: string[] = [];
    const geometry = [
        `    lv_obj_set_pos(${variable}, ${Math.round(widget.x)}, ${Math.round(widget.y)});`,
        `    lv_obj_set_size(${variable}, ${Math.round(widget.width)}, ${Math.round(widget.height)});`,
    ];

    switch (widget.tag) {
        case 'label':
            lines.push(`    lv_obj_t *${variable} = lv_label_create(${parent});`, ...geometry);
            lines.push(`    lv_label_set_long_mode(${variable}, LV_LABEL_LONG_WRAP);`);
            lines.push(`    lv_label_set_text(${variable}, ${cString(textOf(widget, 'text'))});`);
            {
                const font = fontLine(widget, variable, document);
                if (font !== undefined) {
                    lines.push(font);
                }
            }
            break;
        case 'text_lines': {
            lines.push(`    lv_obj_t *${variable} = lv_obj_create(${parent});`, ...geometry);
            lines.push(`    lv_obj_set_flex_flow(${variable}, LV_FLEX_FLOW_COLUMN);`);
            lines.push(`    lv_obj_set_style_pad_row(${variable}, ${Math.round(numberProp(widget, 'gap', 2))}, 0);`);
            lines.push(`    lv_obj_set_style_border_width(${variable}, 0, 0);`);
            lines.push(`    lv_obj_set_style_bg_opa(${variable}, LV_OPA_TRANSP, 0);`);
            lines.push(`    lv_obj_set_style_pad_all(${variable}, 0, 0);`);
            {
                const font = fontLine(widget, variable, document);
                if (font !== undefined) {
                    lines.push(font);
                }
            }
            const values = widget.children?.kind === 'lines' ? widget.children.values : [];
            for (const value of values) {
                lines.push(`    lv_label_set_text(lv_label_create(${variable}), ${cString(value)});`);
            }
            break;
        }
        case 'button':
            lines.push(`    lv_obj_t *${variable} = lv_button_create(${parent});`, ...geometry);
            lines.push(`    lv_obj_t *${variable}_label = lv_label_create(${variable});`);
            lines.push(`    lv_label_set_text(${variable}_label, ${cString(textOf(widget, 'text', 'Button'))});`);
            lines.push(`    lv_obj_center(${variable}_label);`);
            {
                const font = fontLine(widget, `${variable}_label`, document);
                if (font !== undefined) {
                    lines.push(font);
                }
            }
            break;
        case 'toggle': {
            lines.push(`    lv_obj_t *${variable} = lv_switch_create(${parent});`, ...geometry);
            if (boolProp(widget, 'checked')) {
                lines.push(`    lv_obj_add_state(${variable}, LV_STATE_CHECKED);`);
            }
            const off = colourLiteral(widget.props.off_color);
            if (off !== undefined) {
                lines.push(`    lv_obj_set_style_bg_color(${variable}, ${off}, LV_PART_INDICATOR);`);
            }
            break;
        }
        case 'checkbox':
            lines.push(`    lv_obj_t *${variable} = lv_checkbox_create(${parent});`, ...geometry);
            lines.push(`    lv_checkbox_set_text(${variable}, ${cString(textOf(widget, 'label', 'Checkbox'))});`);
            {
                const font = fontLine(widget, variable, document);
                if (font !== undefined) {
                    lines.push(font);
                }
            }
            if (boolProp(widget, 'checked')) {
                lines.push(`    lv_obj_add_state(${variable}, LV_STATE_CHECKED);`);
            }
            break;
        case 'slider':
            lines.push(`    lv_obj_t *${variable} = lv_slider_create(${parent});`, ...geometry);
            lines.push(
                `    lv_slider_set_range(${variable}, ${Math.round(numberProp(widget, 'min', 0))}, ` +
                `${Math.round(numberProp(widget, 'max', 100))});`,
            );
            lines.push(
                `    lv_slider_set_value(${variable}, ${Math.round(numberProp(widget, 'value', 0))}, LV_ANIM_OFF);`,
            );
            break;
        case 'dropdown': {
            lines.push(`    lv_obj_t *${variable} = lv_dropdown_create(${parent});`, ...geometry);
            const options = widget.children?.kind === 'options' ? widget.children.values : [];
            lines.push(`    lv_dropdown_set_options(${variable}, ${cString(options.join('\n'))});`);
            lines.push(`    lv_dropdown_set_selected(${variable}, ${Math.round(numberProp(widget, 'selected', 0))});`);
            {
                const font = fontLine(widget, variable, document);
                if (font !== undefined) {
                    lines.push(font);
                }
            }
            break;
        }
        case 'roller': {
            lines.push(`    lv_obj_t *${variable} = lv_roller_create(${parent});`, ...geometry);
            const options = widget.children?.kind === 'options' ? widget.children.values : [];
            lines.push(
                `    lv_roller_set_options(${variable}, ${cString(options.join('\n'))}, LV_ROLLER_MODE_NORMAL);`,
            );
            {
                const font = fontLine(widget, variable, document);
                if (font !== undefined) {
                    lines.push(font);
                }
            }
            break;
        }
        case 'progress':
            lines.push(`    lv_obj_t *${variable} = lv_bar_create(${parent});`, ...geometry);
            lines.push(`    lv_bar_set_range(${variable}, 0, ${Math.round(numberProp(widget, 'max', 100))});`);
            lines.push(
                `    lv_bar_set_value(${variable}, ${Math.round(numberProp(widget, 'value', 0))}, LV_ANIM_OFF);`,
            );
            break;
        case 'arc':
            lines.push(`    lv_obj_t *${variable} = lv_arc_create(${parent});`, ...geometry);
            lines.push(`    lv_arc_set_value(${variable}, ${Math.round(numberProp(widget, 'value', 0))});`);
            break;
        case 'spacer':
        case 'rect':
        case 'circle': {
            lines.push(`    lv_obj_t *${variable} = lv_obj_create(${parent});`, ...geometry);
            lines.push(`    lv_obj_set_style_border_width(${variable}, 0, 0);`);
            lines.push(`    lv_obj_set_style_pad_all(${variable}, 0, 0);`);
            if (widget.tag === 'circle') {
                lines.push(`    lv_obj_set_style_radius(${variable}, LV_RADIUS_CIRCLE, 0);`);
            }
            if (widget.tag === 'spacer') {
                lines.push(`    lv_obj_set_style_bg_opa(${variable}, LV_OPA_TRANSP, 0);`);
            } else {
                const fill = colourLiteral(widget.props.fill);
                if (fill !== undefined) {
                    lines.push(`    lv_obj_set_style_bg_color(${variable}, ${fill}, 0);`);
                }
            }
            break;
        }
        case 'line':
        case 'triangle': {
            // LVGL draws a polyline from a point array; a triangle is the same with its first point repeated,
            // which is what closes it.
            const x = Math.round(widget.x);
            const y = Math.round(widget.y);
            const w = Math.round(widget.width);
            const h = Math.round(widget.height);
            const points =
                widget.tag === 'triangle'
                    ? `{${x}, ${y + h}}, {${x}, ${y}}, {${x + w}, ${y}}, {${x}, ${y + h}}`
                    : `{${x}, ${y}}, {${x + w}, ${y + h}}`;
            lines.push(`    static const lv_point_precise_t ${variable}_points[] = {${points}};`);
            lines.push(`    lv_obj_t *${variable} = lv_line_create(${parent});`);
            lines.push(
                `    lv_line_set_points(${variable}, ${variable}_points, ` +
                `sizeof(${variable}_points) / sizeof(${variable}_points[0]));`,
            );
            break;
        }
        case 'clock': {
            // The face draws itself from the geometry in its own block; the container holds it and wears the
            // design's own appearance -- a clock may have a coloured face, a frame and rounded corners like any
            // other block, and emitting it transparent ignored every one of those (bench, 2026-11-01).
            lines.push(`    lv_obj_t *${variable} = lv_obj_create(${parent});`, ...geometry);
            const fill = colourLiteral(widget.props.bg);
            if (fill === undefined) {
                lines.push(`    lv_obj_set_style_bg_opa(${variable}, LV_OPA_TRANSP, 0);`);
            } else {
                lines.push(`    lv_obj_set_style_bg_color(${variable}, ${fill}, 0);`);
                lines.push(`    lv_obj_set_style_bg_opa(${variable}, LV_OPA_COVER, 0);`);
            }
            const borderWidth = Math.max(0, Math.round(numberProp(widget, 'border_width', 0)));
            const borderColour = colourLiteral(widget.props.border_color);
            if (borderWidth > 0 && borderColour !== undefined) {
                lines.push(`    lv_obj_set_style_border_color(${variable}, ${borderColour}, 0);`);
                lines.push(`    lv_obj_set_style_border_width(${variable}, ${borderWidth}, 0);`);
            } else {
                lines.push(`    lv_obj_set_style_border_width(${variable}, 0, 0);`);
            }
            const radius = Math.max(0, Math.round(numberProp(widget, 'corner_radius', 0)));
            if (radius > 0) {
                lines.push(`    lv_obj_set_style_radius(${variable}, ${radius}, 0);`);
            }
            lines.push(`    ui_set_scrollable(${variable}, false);`);
            lines.push(`    lv_obj_set_style_pad_all(${variable}, 0, 0);`);
            lines.push(`    clock_${cppId(widget.id)}_build(${variable});`);
            break;
        }
        case 'chart':
        case 'plotter': {
            // The crate draws both as a connected polyline over `values`; LVGL has that shape as a chart series, so
            // the design's numbers go in as points and LVGL draws the line. The plotter's ring buffer is unrolled
            // here: `head` is a design-time number, so the rotation costs nothing at runtime.
            lines.push(`    lv_obj_t *${variable} = lv_chart_create(${parent});`, ...geometry);
            const series = seriesOf(widget, widget.tag === 'plotter');
            const min = Math.round(numberProp(widget, 'min', 0));
            const max = Math.round(numberProp(widget, 'max', 10));
            lines.push(`    lv_chart_set_type(${variable}, LV_CHART_TYPE_LINE);`);
            lines.push(`    lv_chart_set_range(${variable}, LV_CHART_AXIS_PRIMARY_Y, ${min}, ${max});`);
            lines.push(`    lv_chart_set_point_count(${variable}, ${Math.max(1, series.length)});`);
            lines.push(`    lv_chart_set_div_line_count(${variable}, 0, 0);`);
            lines.push(`    lv_obj_set_style_size(${variable}, 0, 0, LV_PART_INDICATOR);`);
            lines.push(
                `    lv_chart_series_t *${variable}_series = lv_chart_add_series(${variable}, ${accentOf(widget)}, LV_CHART_AXIS_PRIMARY_Y);`,
            );
            lines.push(
                `    static const int32_t ${variable}_values[] = {${series.map((value) => Math.round(value)).join(', ')}};`,
            );
            lines.push(
                `    lv_chart_set_series_values(${variable}, ${variable}_series, ${variable}_values, ${Math.max(1, series.length)});`,
            );
            break;
        }
        case 'scale': {
            // A radial scale is `LV_SCALE_MODE_ROUND_INNER`; LVGL draws the ticks and labels and, given a line, the
            // needle, so this is the one value widget with no drawing code of its own.
            lines.push(`    lv_obj_t *${variable} = lv_scale_create(${parent});`, ...geometry);
            const min = Math.round(numberProp(widget, 'min', 0));
            const max = Math.round(numberProp(widget, 'max', 100));
            const major = Math.max(1, Math.round(numberProp(widget, 'major_ticks', 5)));
            const minor = Math.max(1, Math.round(numberProp(widget, 'minor_ticks', 2)));
            lines.push(`    lv_scale_set_mode(${variable}, LV_SCALE_MODE_ROUND_INNER);`);
            lines.push(`    lv_scale_set_range(${variable}, ${min}, ${max});`);
            lines.push(`    lv_scale_set_total_tick_count(${variable}, ${major * minor});`);
            lines.push(`    lv_scale_set_major_tick_every(${variable}, ${minor});`);
            lines.push(`    lv_scale_set_label_show(${variable}, ${boolProp(widget, 'show_labels') ? 'true' : 'false'});`);
            lines.push(`    lv_scale_set_angle_range(${variable}, 270);`);
            lines.push(`    lv_scale_set_rotation(${variable}, 135);`);
            if (boolProp(widget, 'show_needle')) {
                lines.push(`    lv_obj_t *${variable}_needle = lv_line_create(${variable});`);
                lines.push(`    lv_obj_set_style_line_width(${variable}_needle, 3, 0);`);
                lines.push(
                    `    lv_obj_set_style_line_color(${variable}_needle, ${colourLiteral(widget.props.needle_color) ?? 'lv_color_hex(0xFF0000)'}, 0);`,
                );
                lines.push(
                    `    lv_scale_set_line_needle_value(${variable}, ${variable}_needle, ${Math.round(-0.1 * Math.min(widget.width, widget.height))}, ${Math.round(numberProp(widget, 'value', 0))});`,
                );
            }
            break;
        }
        case 'spinbox': {
            lines.push(`    lv_obj_t *${variable} = lv_spinbox_create(${parent});`, ...geometry);
            lines.push(
                `    lv_spinbox_set_range(${variable}, ${Math.round(numberProp(widget, 'min', 0))}, ${Math.round(numberProp(widget, 'max', 9999))});`,
            );
            lines.push(
                `    lv_spinbox_set_digit_format(${variable}, ${Math.max(1, Math.round(numberProp(widget, 'digits', 4)))}, ${Math.max(1, Math.round(numberProp(widget, 'digits', 4))) - Math.max(0, Math.round(numberProp(widget, 'decimals', 0)))});`,
            );
            lines.push(`    lv_spinbox_set_value(${variable}, ${Math.round(numberProp(widget, 'value', 0))});`);
            break;
        }
        case 'number_picker': {
            // The crate draws a value with the unit beside it; LVGL's spinbox is the value, a label is the unit.
            lines.push(`    lv_obj_t *${variable} = lv_spinbox_create(${parent});`, ...geometry);
            const digits = Math.max(1, String(Math.round(numberProp(widget, 'max', 100))).length);
            lines.push(
                `    lv_spinbox_set_range(${variable}, ${Math.round(numberProp(widget, 'min', 0))}, ${Math.round(numberProp(widget, 'max', 100))});`,
            );
            lines.push(`    lv_spinbox_set_digit_format(${variable}, ${digits}, ${digits});`);
            lines.push(`    lv_spinbox_set_value(${variable}, ${Math.round(numberProp(widget, 'value', 0))});`);
            const unit = textOf(widget, 'unit');
            if (unit !== '') {
                lines.push(`    lv_obj_t *${variable}_unit = lv_label_create(${variable});`);
                lines.push(`    lv_label_set_text(${variable}_unit, ${cString(unit)});`);
            }
            break;
        }
        case 'time_picker': {
            // Two rollers, and an AM/PM roller only when the design asks for a 12-hour face: LVGL's roller is the
            // same control the crate's picker builds from its digits.
            lines.push(`    lv_obj_t *${variable} = lv_obj_create(${parent});`, ...geometry);
            lines.push(`    lv_obj_set_style_border_width(${variable}, 0, 0);`);
            lines.push(`    lv_obj_set_style_pad_all(${variable}, 0, 0);`);
            lines.push(`    lv_obj_set_flex_flow(${variable}, LV_FLEX_FLOW_ROW);`);
            lines.push(
                `    lv_obj_set_flex_align(${variable}, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);`,
            );
            const twelve = boolProp(widget, 'is_12h');
            const first = twelve ? 1 : 0;
            const last = twelve ? 12 : 23;
            const pad = (value: number): string => String(value).padStart(2, '0');
            const hours: string[] = [];
            for (let hour = first; hour <= last; hour += 1) {
                hours.push(pad(hour));
            }
            const minutes: string[] = [];
            for (let minute = 0; minute < 60; minute += 1) {
                minutes.push(pad(minute));
            }
            lines.push(`    lv_obj_t *${variable}_hour = lv_roller_create(${variable});`);
            lines.push(`    lv_roller_set_options(${variable}_hour, ${cString(hours.join('\n'))}, LV_ROLLER_MODE_NORMAL);`);
            lines.push(
                `    lv_roller_set_selected(${variable}_hour, ${Math.max(0, Math.round(numberProp(widget, 'hour', 12)) - first)}, LV_ANIM_OFF);`,
            );
            lines.push(`    lv_obj_t *${variable}_minute = lv_roller_create(${variable});`);
            lines.push(`    lv_roller_set_options(${variable}_minute, ${cString(minutes.join('\n'))}, LV_ROLLER_MODE_NORMAL);`);
            lines.push(
                `    lv_roller_set_selected(${variable}_minute, ${Math.max(0, Math.round(numberProp(widget, 'minute', 0)))}, LV_ANIM_OFF);`,
            );
            if (twelve) {
                lines.push(`    lv_obj_t *${variable}_meridiem = lv_roller_create(${variable});`);
                lines.push(`    lv_roller_set_options(${variable}_meridiem, "AM\\nPM", LV_ROLLER_MODE_NORMAL);`);
                lines.push(
                    `    lv_roller_set_selected(${variable}_meridiem, ${boolProp(widget, 'is_pm') ? 1 : 0}, LV_ANIM_OFF);`,
                );
            }
            break;
        }
        case 'busy_wheel':
            lines.push(`    lv_obj_t *${variable} = lv_spinner_create(${parent});`, ...geometry);
            lines.push(`    lv_spinner_set_anim_params(${variable}, 1000, 60);`);
            lines.push(
                `    lv_obj_set_style_arc_color(${variable}, ${accentOf(widget)}, LV_PART_INDICATOR);`,
            );
            break;
        case 'status_bar': {
            // The crate's bar is the time on the right and a rule along the bottom; both are ordinary objects here.
            lines.push(`    lv_obj_t *${variable} = lv_obj_create(${parent});`, ...geometry);
            lines.push(`    lv_obj_set_style_border_width(${variable}, 0, 0);`);
            lines.push(`    lv_obj_set_style_pad_all(${variable}, 0, 0);`);
            lines.push(`    ui_set_scrollable(${variable}, false);`);
            lines.push(`    lv_obj_t *${variable}_time = lv_label_create(${variable});`);
            lines.push(`    lv_label_set_text(${variable}_time, ${cString(textOf(widget, 'time', '12:00'))});`);
            lines.push(`    lv_obj_align(${variable}_time, LV_ALIGN_RIGHT_MID, -4, 0);`);
            {
                const font = fontLine(widget, `${variable}_time`, document);
                if (font !== undefined) {
                    lines.push(font);
                }
            }
            lines.push(`    static lv_point_precise_t ${variable}_rule[] = {{0, 0}, {${Math.round(widget.width)}, 0}};`);
            lines.push(`    lv_obj_t *${variable}_line = lv_line_create(${variable});`);
            lines.push(`    lv_line_set_points(${variable}_line, ${variable}_rule, 2);`);
            lines.push(`    lv_obj_align(${variable}_line, LV_ALIGN_BOTTOM_LEFT, 0, 0);`);
            break;
        }
        case 'content_indicator':
        case 'crumbs': {
            // Both are a row of marks with one of them current. A dot is a circle, a crumb is a rounded bar: the
            // sizes come from the crate's own renderer, so the row is the same shape on the glass as on the canvas.
            const indicator = widget.tag === 'content_indicator';
            const count = Math.max(1, Math.round(numberProp(widget, 'count', 3)));
            const active = Math.min(Math.max(0, Math.round(numberProp(widget, 'active', 0))), count - 1);
            const width = Math.round(widget.width);
            const height = Math.round(widget.height);
            const dot = indicator ? Math.max(2, Math.round(Math.min(width, height) / 3)) : 4;
            const step = indicator ? dot + 2 : 6;
            const size = indicator ? dot : 4;
            const startX = Math.round((width - ((count - 1) * step + size)) / 2);
            const centreY = Math.round((height - (indicator ? dot : 4)) / 2);
            lines.push(`    lv_obj_t *${variable} = lv_obj_create(${parent});`, ...geometry);
            lines.push(`    lv_obj_set_style_border_width(${variable}, 0, 0);`);
            lines.push(`    lv_obj_set_style_pad_all(${variable}, 0, 0);`);
            lines.push(`    ui_set_scrollable(${variable}, false);`);
            lines.push(
                `    lv_obj_set_style_bg_opa(${variable}, ${colourLiteral(widget.props.bg) === undefined ? 'LV_OPA_TRANSP' : colourLiteral(widget.props.bg)}, 0);`,
            );
            for (let index = 0; index < count; index += 1) {
                const target = `    lv_obj_t *${variable}_dot${index} = lv_obj_create(${variable});`;
                lines.push(target);
                lines.push(
                    `    lv_obj_set_size(${variable}_dot${index}, ${indicator ? dot : 4}, ${indicator ? dot : 4});`,
                );
                lines.push(`    lv_obj_set_pos(${variable}_dot${index}, ${startX + index * step}, ${centreY});`);
                lines.push(`    lv_obj_set_style_border_width(${variable}_dot${index}, 0, 0);`);
                lines.push(
                    `    lv_obj_set_style_radius(${variable}_dot${index}, ${indicator ? 'LV_RADIUS_CIRCLE' : '1'}, 0);`,
                );
                lines.push(
                    `    lv_obj_set_style_bg_color(${variable}_dot${index}, ${index === active ? accentOf(widget) : 'lv_color_hex(0x0A140A)'}, 0);`,
                );
            }
            break;
        }
        case 'dialog': {
            // A container with a title line, the message, and one button: what the crate composes, in the same order.
            lines.push(`    lv_obj_t *${variable} = lv_obj_create(${parent});`, ...geometry);
            lines.push(`    lv_obj_set_style_pad_all(${variable}, 4, 0);`);
            lines.push(`    ui_set_scrollable(${variable}, false);`);
            const title = textOf(widget, 'title', 'Alert');
            lines.push(`    lv_obj_t *${variable}_title = lv_label_create(${variable});`);
            lines.push(`    lv_label_set_text(${variable}_title, ${cString(title)});`);
            lines.push(`    lv_obj_align(${variable}_title, LV_ALIGN_TOP_MID, 0, 0);`);
            lines.push(`    lv_obj_t *${variable}_message = lv_label_create(${variable});`);
            lines.push(`    lv_label_set_text(${variable}_message, ${cString(textOf(widget, 'message'))});`);
            lines.push(`    lv_label_set_long_mode(${variable}_message, LV_LABEL_LONG_WRAP);`);
            lines.push(`    lv_obj_set_width(${variable}_message, lv_pct(100));`);
            lines.push(`    lv_obj_align(${variable}_message, LV_ALIGN_TOP_MID, 0, 20);`);
            lines.push(`    lv_obj_t *${variable}_ok = lv_button_create(${variable});`);
            lines.push(`    lv_obj_align(${variable}_ok, LV_ALIGN_BOTTOM_RIGHT, 0, 0);`);
            lines.push(`    lv_obj_t *${variable}_ok_label = lv_label_create(${variable}_ok);`);
            lines.push(`    lv_label_set_text(${variable}_ok_label, "OK");`);
            lines.push(`    lv_obj_center(${variable}_ok_label);`);
            {
                const font = fontLine(widget, `${variable}_title`, document);
                if (font !== undefined) {
                    lines.push(font);
                }
            }
            break;
        }
        case 'table': {
            // The design holds the cells, so the table is fully described at generation time: LVGL's table takes a
            // row and column count and a string per cell.
            const rows = tableRowsOf(widget);
            lines.push(`    lv_obj_t *${variable} = lv_table_create(${parent});`, ...geometry);
            lines.push(`    lv_table_set_column_count(${variable}, ${Math.max(1, rows.maxColumns)});`);
            lines.push(`    lv_table_set_row_count(${variable}, ${Math.max(1, rows.cells.length)});`);
            rows.cells.forEach((row, rowIndex) => {
                row.forEach((cell, columnIndex) => {
                    lines.push(
                        `    lv_table_set_cell_value(${variable}, ${rowIndex}, ${columnIndex}, ${cString(cell)});`,
                    );
                });
            });
            {
                const font = fontLine(widget, variable, document);
                if (font !== undefined) {
                    lines.push(font);
                }
            }
            break;
        }
        case 'carousel': {
            // A vertical strip of items with the selected one in the accent colour, laid out from the design's
            // `item_step` and `visible` counts -- the crate's wheel, flattened the way the canvas draws it.
            lines.push(`    lv_obj_t *${variable} = lv_obj_create(${parent});`, ...geometry);
            lines.push(`    lv_obj_set_style_border_width(${variable}, 0, 0);`);
            lines.push(`    lv_obj_set_style_pad_all(${variable}, 0, 0);`);
            lines.push(`    ui_set_scrollable(${variable}, false);`);
            const items = optionsOf(widget);
            const selected = Math.min(Math.max(0, Math.round(numberProp(widget, 'selected', 0))), Math.max(0, items.length - 1));
            const step = Math.max(1, Math.round(numberProp(widget, 'item_step', 16)));
            const centreX = Math.round(widget.width / 2);
            const centreY = Math.round(widget.height / 2);
            const half = Math.max(1, Math.round(numberProp(widget, 'visible', 7) / 2));
            items.forEach((item, index) => {
                const distance = index - selected;
                if (Math.abs(distance) > half) {
                    return;
                }
                lines.push(`    lv_obj_t *${variable}_item${index} = lv_label_create(${variable});`);
                lines.push(`    lv_label_set_text(${variable}_item${index}, ${cString(item)});`);
                lines.push(
                    `    lv_obj_align(${variable}_item${index}, LV_ALIGN_CENTER, ${-Math.round(centreX / 2)}, ${distance * step - Math.round(centreY / 2)});`,
                );
                lines.push(
                    `    lv_obj_set_style_text_color(${variable}_item${index}, ${distance === 0 ? accentOrText(widget) : 'lv_color_hex(0x606060)'}, 0);`,
                );
            });
            break;
        }
        case 'path': {
            // A path is a polyline once flattened, and flattening happens here so no curve maths is linked in.
            const points = flattenPath(textOf(widget, 'd'));
            if (points.length < 2) {
                return [];
            }
            lines.push(`    static lv_point_precise_t ${variable}_points[] = {${points
                .map((point) => `{${point.x}, ${point.y}}`)
                .join(', ')}};`);
            lines.push(`    lv_obj_t *${variable} = lv_line_create(${parent});`);
            lines.push(
                `    lv_line_set_points(${variable}, ${variable}_points, ${points.length});`,
            );
            lines.push(
                `    lv_obj_set_style_line_color(${variable}, ${colourLiteral(widget.props.colour) ?? 'lv_color_hex(0xFFFFFF)'}, 0);`,
            );
            lines.push(
                `    lv_obj_set_style_line_width(${variable}, ${Math.max(1, Math.round(numberProp(widget, 'stroke_width', 1)))}, 0);`,
            );
            break;
        }
        case 'image':
        case 'icon': {
            // The pixels were decoded when the file was read and are in the table above, keyed by this widget.
            // A file that could not be read leaves an empty box the size of the widget rather than nothing at
            // all: a design keeps its layout while the asset is sorted out, and the problem list names the file.
            const slot = images.get(widget.id);
            if (slot?.image === undefined) {
                lines.push(
                    `    // ${slot?.note ?? 'no picture was decoded for this widget'}`,
                    `    lv_obj_t *${variable} = lv_obj_create(${parent});`,
                    ...geometry,
                    `    lv_obj_set_style_border_width(${variable}, 0, 0);`,
                    `    lv_obj_set_style_radius(${variable}, 0, 0);`,
                    `    lv_obj_set_style_bg_opa(${variable}, LV_OPA_TRANSP, 0);`,
                );
                break;
            }
            const image = slot.image;
            lines.push(`    lv_obj_t *${variable} = lv_image_create(${parent});`, ...geometry);
            lines.push(
                `    ui_image_attach(&img_${cppId(widget.id)}, img_${cppId(widget.id)}_data, ` +
                `${image.bytes.byteLength}, ${image.format}, ${image.width}, ${image.height}, ${image.stride});`,
            );
            lines.push(`    lv_image_set_src(${variable}, &img_${cppId(widget.id)});`);
            // `stretch` fills the widget's box and `center` draws the picture at its own size in the middle of
            // it: the two fits the catalogue offers and the two the crate draws. An icon's picture is already
            // the size the parts compose to, so its alignment is the one the crate calls `IconAlign`.
            const placement =
                widget.tag === 'icon'
                    ? widget.props.align === 'top_left'
                        ? 'LV_IMAGE_ALIGN_TOP_LEFT'
                        : 'LV_IMAGE_ALIGN_CENTER'
                    : widget.props.fit === 'center'
                        ? 'LV_IMAGE_ALIGN_CENTER'
                        : 'LV_IMAGE_ALIGN_STRETCH';
            lines.push(`    lv_image_set_inner_align(${variable}, ${placement});`);
            break;
        }
        case 'keypad':
            lines.push(`    lv_obj_t *${variable} = lv_textarea_create(${parent});`, ...geometry);
            {
                const font = fontLine(widget, variable, document);
                if (font !== undefined) {
                    lines.push(font);
                }
            }
            lines.push(`    lv_obj_t *${variable}_keys = lv_keyboard_create(${parent});`);
            lines.push(`    lv_keyboard_set_textarea(${variable}_keys, ${variable});`);
            break;
        case 'panel':
            lines.push(`    lv_obj_t *${variable} = lv_obj_create(${parent});`, ...geometry);
            lines.push(`    lv_obj_set_style_border_width(${variable}, 0, 0);`);
            lines.push(`    lv_obj_set_style_radius(${variable}, 0, 0);`);
            lines.push(`    lv_obj_set_style_pad_all(${variable}, 0, 0);`);
            break;
        default:
            return [];
    }

    // Events last, so the callback has the object it acts on. A navigate event switches views by itself, so it
    // gets a callback that calls ui_show_view and no handler -- exactly as on the Rust side.
    for (const event of widget.events) {
        const spec = EVENT_SPECS[event];
        if (spec.action !== undefined) {
            const target = textOf(widget, spec.action.targetProperty);
            if (target === '') {
                continue;
            }
            lines.push(
                `    lv_obj_add_event_cb(${variable}, navigate_to_${cppId(target)}_cb, ${lvEventName(event)}, nullptr);`,
            );
            continue;
        }
        lines.push(
            `    lv_obj_add_event_cb(${variable}, ${cppHandlerName(widget.id, event)}_cb, ${lvEventName(event)}, nullptr);`,
        );
    }
    return lines;
}

/**
 * The toolbox widgets a C++ project cannot draw, and the sentence a person gets when they hover one.
 *
 * LVGL has no 3D rasteriser, so a mesh is a rect of nothing on a C++ panel. Listing the tag in the toolbox with
 * this reason is the difference between a limitation and a bug -- and computing it here, next to
 * `SUPPORTED_TAGS`, keeps the emitter and the toolbox from disagreeing.
 */
export const UNAVAILABLE_CPP: Readonly<Record<string, string>> = {
    mesh:
        'Not available in a C++ project: LVGL has no 3D rasteriser, so a mesh would be an empty box. ' +
        'The Rust option draws it.',
};

/** The list above as the panel wants it, which is a shape it can paint without knowing what LVGL can do. */
export function unavailableCppWidgets(): { tag: string; reason: string }[] {
    return Object.entries(UNAVAILABLE_CPP).map(([tag, reason]) => ({ tag, reason }));
}

/**
 * The pixel tables, and the one helper that turns each of them into an `lv_image_dsc_t`.
 *
 * LVGL's descriptor is a header of bit fields plus a size and a pointer, and bit-field initialisers are C++20 --
 * a sketch is C++17 -- so the fields are assigned in a small function instead of written as an aggregate. That
 * is also the only reason this helper exists: it keeps the eight assignments out of every widget's block.
 *
 * Empty when the design holds no pictures, so a design without one still emits exactly what it used to.
 */
function imageTables(document: DesignerDocument, images: CppImageSlots): string {
    const drawn = document.widgets.filter((widget) => images.get(widget.id)?.image !== undefined);
    if (drawn.length === 0) {
        return '';
    }
    const blocks: string[] = [
        '// ---- pictures ---------------------------------------------------------------',
        '//',
        '// Each file below was decoded when the design was saved and is copied into the flash as the pixels LVGL',
        '// draws: RGB565, or RGB565A8 when the picture has transparency. Nothing is read at run time.',
        '',
        'static void ui_image_attach(lv_image_dsc_t *image, const uint8_t *data, uint32_t size,',
        '                            lv_color_format_t format, int32_t width, int32_t height, int32_t stride) {',
        '    image->header.magic = LV_IMAGE_HEADER_MAGIC;',
        '    image->header.cf = format;',
        '    image->header.flags = 0;',
        '    image->header.w = (uint16_t)width;',
        '    image->header.h = (uint16_t)height;',
        '    image->header.stride = (uint16_t)stride;',
        '    image->data_size = size;',
        '    image->data = data;',
        '}',
    ];
    for (const widget of drawn) {
        const image = images.get(widget.id)?.image;
        if (image === undefined) {
            continue;
        }
        const symbol = `img_${cppId(widget.id)}`;
        blocks.push(
            '',
            `// ${widget.id}: ${image.width}x${image.height}, ${image.format.replace('LV_COLOR_FORMAT_', '')}, ${image.bytes.byteLength} bytes.`,
            `static const uint8_t ${symbol}_data[] =`,
            ...pixelLines(image.bytes, '    ').map((line, index, all) =>
                index === all.length - 1 ? `${line};` : line,
            ),
            `static lv_image_dsc_t ${symbol};`,
        );
    }
    return `${blocks.join('\n')}\n\n`;
}

/**
 * The `text_font` line for a widget, when the design names a font.
 *
 * LVGL resolves a font by compiling it in, so the size comes from `lvglFonts.ts` — the nearest Montserrat to the
 * font the canvas draws. Nothing is emitted when the design names none, which leaves LVGL's default in place.
 */
function fontLine(widget: DesignerWidget, target: string, document: DesignerDocument): string | undefined {
    const named = designFontOf(widget.props);
    if (named === undefined) {
        return undefined;
    }
    const choice = lvglFontFor(named, document.fonts.map((font) => font.id));
    return `    lv_obj_set_style_text_font(${target}, ${fontSymbol(choice.size)}, 0);`;
}

/** The widget tags whose text the design can give a font. */
const TEXT_TAGS: ReadonlySet<string> = new Set([
    'label',
    'button',
    'checkbox',
    'text_lines',
    'dropdown',
    'roller',
    'keypad',
]);

/**
 * Every Montserrat size this design needs compiled in.
 *
 * LVGL resolves a font at build time, so `lv_conf.h` has to switch on exactly the sizes `ui.cpp` names -- one
 * missing symbol is a link error, and one extra is 20 KB of flash nobody asked for. The clock's numerals are the
 * one place a size is multiplied (`label_scale`), which is why this is asked of the emitter rather than read off
 * the props.
 */
export function documentFontSizes(document: DesignerDocument): number[] {
    const declared = document.fonts.map((font) => font.id);
    const sizes: number[] = [];
    for (const widget of document.widgets) {
        const named = designFontOf(widget.props);
        if (widget.tag === 'clock') {
            if (named === undefined) {
                continue;
            }
            const scale = Math.max(1, Math.round(numberProp(widget, 'label_scale', 1)));
            sizes.push(lvglFontFor(named, declared).size * scale);
            continue;
        }
        if (named === undefined || !TEXT_TAGS.has(widget.tag)) {
            continue;
        }
        sizes.push(lvglFontFor(named, declared).size);
    }
    return sizes;
}

/** The canvas size: the panel turned with the design, exactly as the canvas shows it. */
function canvasSize(document: DesignerDocument): { width: number; height: number } {
    const swaps = document.rotation === 1 || document.rotation === 3;
    return swaps
        ? { width: document.panelHeight, height: document.panelWidth }
        : { width: document.panelWidth, height: document.panelHeight };
}

/** The callbacks, one per event, each calling the handler in src/ui_handlers.cpp. */
function callbacksFor(document: DesignerDocument): string {
    const blocks: string[] = [];
    for (const widget of document.widgets) {
        for (const event of widget.events) {
            const spec = EVENT_SPECS[event];
            if (spec.action !== undefined) {
                const target = textOf(widget, spec.action.targetProperty);
                if (target === '') {
                    continue;
                }
                blocks.push(
                    `void navigate_to_${cppId(target)}_cb(lv_event_t *event) {\n` +
                    `    (void)event;\n` +
                    `    ui_show_view(${cString(target)});\n` +
                    `}\n`,
                );
                continue;
            }
            const name = cppHandlerName(widget.id, event);
            const read = argumentRead(widget, event);
            blocks.push(
                `void ${name}_cb(lv_event_t *event) {\n` +
                `    lv_obj_t *target = static_cast<lv_obj_t *>(lv_event_get_target(event));\n` +
                `    (void)target;\n` +
                (read === '' ? '' : `    ${read}\n`) +
                `    ${name}(${argumentName(event)});\n` +
                `}\n`,
            );
        }
    }
    return blocks.length === 0 ? '// No widget in this design raises an event yet.' : blocks.join('\n');
}

/** The whole of `src/ui.cpp`. */
/**
 * The two flag setters a generated screen needs, written once per file.
 *
 * LVGL 9.6 deprecated `lv_obj_add_flag()`/`lv_obj_remove_flag()` in favour of one setter per flag -- and those
 * setters do not exist before it, so a project on 9.2 has to keep the old spelling. The bench build put three
 * `-Wdeprecated-declarations` warnings on the Problems pane for a screen nobody had touched (2026-10-31), which
 * is how this arrived: the choice is made once, here, and every call site says what it means.
 */
const FLAG_WRAPPERS = `// LVGL 9.6 deprecated lv_obj_add_flag()/lv_obj_remove_flag() in favour of one setter per flag; those setters
// do not exist on 9.2. These two wrappers are the whole difference, so one generated file builds on both.
#if LVGL_VERSION_MAJOR > 9 || (LVGL_VERSION_MAJOR == 9 && LVGL_VERSION_MINOR >= 6)
void ui_set_hidden(lv_obj_t *object, bool hidden) {
    lv_obj_set_hidden(object, hidden);
}
void ui_set_scrollable(lv_obj_t *object, bool scrollable) {
    lv_obj_set_scrollable(object, scrollable);
}
#else
void ui_set_hidden(lv_obj_t *object, bool hidden) {
    if (hidden) {
        lv_obj_add_flag(object, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_remove_flag(object, LV_OBJ_FLAG_HIDDEN);
    }
}
void ui_set_scrollable(lv_obj_t *object, bool scrollable) {
    if (scrollable) {
        lv_obj_add_flag(object, LV_OBJ_FLAG_SCROLLABLE);
    } else {
        lv_obj_remove_flag(object, LV_OBJ_FLAG_SCROLLABLE);
    }
}
#endif
`;

export function emitUiCpp(document: DesignerDocument, images: CppImageSlots = new Map()): string {
    const views = designViews(document);
    const clocks = document.widgets.filter((widget) => widget.tag === 'clock');
    const size = canvasSize(document);
    const firstView = views[0]?.id ?? 'main';
    const startView = views.find((view) => view.start === true)?.id ?? firstView;
    const viewObjects = views
        .map((view: DesignerView) => {
            const name = `view_${cppId(view.id)}`;
            const lines = [
                `    ${name} = lv_obj_create(screen);`,
                `    lv_obj_set_pos(${name}, 0, 0);`,
                `    lv_obj_set_size(${name}, ${size.width}, ${size.height});`,
                `    lv_obj_set_style_border_width(${name}, 0, 0);`,
                `    lv_obj_set_style_radius(${name}, 0, 0);`,
                `    lv_obj_set_style_bg_opa(${name}, LV_OPA_TRANSP, 0);`,
                // The default theme pads a container, and a design's coordinates are absolute: padding moved
                // every widget in, and the container's last few pixels showed the background as a bar on the
                // right and bottom (bench, 2026-11-01).
                `    lv_obj_set_style_pad_all(${name}, 0, 0);`,
                `    ui_set_scrollable(${name}, false);`,
            ];
            if (view.id !== startView) {
                lines.push(`    ui_set_hidden(${name}, true);`);
            }
            return lines.join('\n');
        })
        .join('\n');

    const widgetBlocks: string[] = [];
    for (const widget of document.widgets) {
        const lines = widgetLines(widget, `view_${cppId(widget.view ?? firstView)}`, document, images);
        if (lines.length > 0) {
            widgetBlocks.push(lines.join('\n'));
        }
    }

    return `// Generated by Grumpy's Rusty Platform from the design. The Designer rewrites this file on every save.
// Put your own code in src/ui_handlers.cpp, which it only ever appends to. Each event below calls the
// handler named after its widget, so a widget called "go" with a click gives on_go_clicked.

#include "ui.h"

#include "lv_conf.h"
#include "ui_handlers.h"

#include <string.h>

namespace {

${FLAG_WRAPPERS}${clocks.length === 0 ? '' : `\n${CLOCK_HELPERS.replace('[[clocks]]', clocks.map((clock) => clockBlock(clock, document)).join('\n'))}\n`}${imageTables(document, images)}
${views.map((view: DesignerView) => `lv_obj_t *view_${cppId(view.id)} = nullptr;`).join('\n')}

${callbacksFor(document)}

} // namespace

void ui_show_view(const char *view_id) {
${views
            .map(
                (view: DesignerView) =>
                    `    if (strcmp(view_id, ${cString(view.id)}) == 0) {\n` +
                    `        ui_set_hidden(view_${cppId(view.id)}, false);\n` +
                    `    } else {\n` +
                    `        ui_set_hidden(view_${cppId(view.id)}, true);\n` +
                    `    }`,
            )
            .join('\n')}
}

${clocks
            .map(
                (clock) =>
                    `void ui_clock_${cppId(clock.id)}_set_time(int hour, int minute, int second) {\n` +
                    `    clock_${cppId(clock.id)}.hour = ((hour % 24) + 24) % 24;\n` +
                    `    clock_${cppId(clock.id)}.minute = ((minute % 60) + 60) % 60;\n` +
                    `    clock_${cppId(clock.id)}.second = ((second % 60) + 60) % 60;\n` +
                    `    ui_clock_hands(&clock_${cppId(clock.id)});\n` +
                    `}\n`,
            )
            .join('\n')}${clocks.length === 0 ? '' : '\n'}void ui_init() {
    lv_obj_t *screen = lv_screen_active();
    ui_set_scrollable(screen, false);
    lv_obj_set_style_pad_all(screen, 0, 0);

${viewObjects}

${widgetBlocks.join('\n\n')}

    Serial.printf("ui: ${document.widgets.length} widget(s), ${views.length} view(s)\\n");
}

void ui_tick() {
${clocks.filter((clock) => boolProp(clock, 'movement')).length === 0
            ? '    // No clock in this design runs by itself; nothing to recompute here.'
            : clocks
                .filter((clock) => boolProp(clock, 'movement'))
                .map((clock) => `    ui_clock_tick(&clock_${cppId(clock.id)});`)
                .join('\n')
        }\n}
`;
}

/** The header `ui.cpp` is compiled against. Written by the wizard and rewritten by the Designer -- one text. */
export function emitUiCppHeader(document?: DesignerDocument): string {
    return `// Generated by Grumpy's Rusty Platform from the design. The Designer rewrites this file.
//
// Your own code belongs in src/ui_handlers.cpp, which the Designer only ever appends to.

#pragma once

#include <Arduino.h>
#include <lvgl.h>

/** Builds the screen the design describes. Called once from setup(), after LVGL is up. */
void ui_init();

/** Runs one turn of the screen's own work: a clock's hands, a value that follows the board. */
void ui_tick();

/** Shows one view of the design, hiding the others. A navigate event calls this. */
void ui_show_view(const char *view_id);
${document === undefined
            ? ''
            : document.widgets
                .filter((widget) => widget.tag === 'clock')
                .map(
                    (clock) =>
                        `\n/** Sets the time one clock face shows. A running clock advances from millis() by itself; */\n` +
                        `/** this is how an app that knows the real time (NTP, an RTC) hands it over. */\n` +
                        `void ui_clock_${cppId(clock.id)}_set_time(int hour, int minute, int second);`,
                )
                .join('')}`;
}

// ---------------------------------------------------------------------- handlers

function findHandlerOwner(
    document: DesignerDocument,
    name: string,
): { id: string; event: DesignerEvent } | undefined {
    for (const widget of document.widgets) {
        for (const event of widget.events) {
            if (EVENT_SPECS[event].action === undefined && cppHandlerName(widget.id, event) === name) {
                return { id: widget.id, event };
            }
        }
    }
    return undefined;
}

/** The prototypes `ui.cpp` needs, for src/ui_handlers.h. */
export function emitHandlersCppHeader(document: DesignerDocument): string {
    const prototypes = cppRequiredHandlers(document).map((name) => {
        const owner = findHandlerOwner(document, name);
        return `extern "C" void ${name}(${owner === undefined ? '' : handlerArgument(owner.event)});`;
    });
    return `// Generated by Grumpy's Rusty Platform from the design. The Designer keeps this list in step.
//
// Your code belongs in src/ui_handlers.cpp: one function per event, appended there and never rewritten.

#pragma once

#include <Arduino.h>

${prototypes.length === 0 ? '// This design raises no event that needs a handler.' : prototypes.join('\n')}
`;
}

/** A stub for each handler the design needs, as it goes into src/ui_handlers.cpp. */
export function emitHandlerStubsCpp(document: DesignerDocument): string[] {
    return cppRequiredHandlers(document).map((name) => {
        const owner = findHandlerOwner(document, name);
        const argument = owner === undefined ? '' : handlerArgument(owner.event);
        return (
            `extern "C" void ${name}(${argument}) {\n` +
            `    // TODO: what ${owner?.id ?? 'this widget'} should do on ${owner?.event ?? 'this event'}.\n` +
            `    Serial.println("${name}");\n` +
            `}\n`
        );
    });
}

/**
 * Adds a stub for a handler the design has gained and removes one it has lost -- but only while its body is
 * still exactly the stub this wrote, so deleting a widget never deletes somebody's code.
 *
 * The stubs have no nested braces, which is what makes a plain block match safe here.
 */
export function syncHandlerStubsCpp(existing: string, document: DesignerDocument): string {
    const wanted = emitHandlerStubsCpp(document);
    const names = wanted.map((stub) => /void (on_[A-Za-z0-9_]+)\(/.exec(stub)?.[1] ?? '');
    let text = existing;

    for (let index = 0; index < wanted.length; index += 1) {
        const name = names[index] ?? '';
        if (name !== '' && !text.includes(`void ${name}(`)) {
            text = `${text.trimEnd()}\n\n${wanted[index] ?? ''}`;
        }
    }

    const block = /extern "C" void (on_[A-Za-z0-9_]+)\([^)]*\) \{[^}]*\}\n?/g;
    return text.replace(block, (match: string, name: string) => {
        if (names.includes(name)) {
            return match;
        }
        const untouched = match.includes(`Serial.println("${name}");`) && match.includes('// TODO:');
        return untouched ? '' : match;
    });
}
