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
    /** Where a hand ends, per hand, in pixels. */
    hourLength: number;
    minuteLength: number;
    secondLength: number;
    /** `{x, y}` pairs: the hour ticks, the minute ticks, and the numerals 1..12. */
    hourTicks: number[][];
    minuteTicks: number[][];
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
    const ticks = (inner: number, outer: number, count: number): number[][] => {
        const pairs: number[][] = [];
        for (let index = 0; index < count; index += 1) {
            const step = Math.round((index * CLOCK_STEPS) / count);
            pairs.push(at(step, inner), at(step, outer));
        }
        return pairs;
    };
    const numerals: number[][] = [];
    for (let hour = 1; hour <= 12; hour += 1) {
        numerals.push(at(Math.round((hour * CLOCK_STEPS) / 12), radius * 0.7));
    }
    return {
        cx,
        cy,
        hourLength: Math.round(radius * 0.45),
        minuteLength: Math.round(radius * 0.62),
        secondLength: Math.round(radius * 0.7),
        hourTicks: ticks(radius * 0.82, radius * 0.94, 12),
        minuteTicks: ticks(radius * 0.9, radius * 0.94, 60),
        numerals,
    };
}

/** `{x, y}, {x, y}, ...` for an `lv_point_precise_t[]` initialiser. */
function pointPairs(pairs: readonly number[][]): string {
    return pairs.map(([x, y]) => `{${x ?? 0}, ${y ?? 0}}`).join(', ');
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
        `static lv_point_precise_t clock_${id}_hourTicks[] = {${pointPairs(geometry.hourTicks)}};`,
        `static lv_point_precise_t clock_${id}_minuteTicks[] = {${pointPairs(geometry.minuteTicks)}};`,
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
    for (let index = 0; index < geometry.minuteTicks.length / 2; index += 1) {
        const major = index % 5 === 0;
        lines.push(
            `    lv_obj_t *tick_${id}_${index} = lv_line_create(parent);`,
            `    lv_line_set_points(tick_${id}_${index}, &clock_${id}_${
                major ? 'hourTicks' : 'minuteTicks'
            }[${major ? (index / 5) * 2 : (index - Math.floor(index / 5)) * 2}], 2);`,
            `    lv_obj_set_style_line_color(tick_${id}_${index}, ${major ? majorColour : minorColour}, 0);`,
            `    lv_obj_set_style_line_width(tick_${id}_${index}, ${major ? 3 : 1}, 0);`,
        );
    }
    const numeralSize = (() => {
        const named = designFontOf(widget.props);
        const scale = Math.max(1, Math.round(numberProp(widget, 'label_scale', 1)));
        const base = lvglFontFor(named, document.fonts.map((font) => font.id)).size;
        return named === undefined ? base : nearestFontSize(base * scale);
    })();
    const numeralFont = fontSymbol(numeralSize);
    // Centring a glyph of this size on its mark: half a line up, and a pixel left for the digit's own side bearing.
    const numeralY = -Math.round(numeralSize / 2) + 1;
    if (widget.props.show_labels === undefined || boolProp(widget, 'show_labels')) {
        geometry.numerals.forEach(([x, y], index) => {
            lines.push(
                `    lv_obj_t *numeral_${id}_${index + 1} = lv_label_create(parent);`,
                `    lv_label_set_text(numeral_${id}_${index + 1}, "${index + 1}");`,
                `    lv_obj_set_style_text_color(numeral_${id}_${index + 1}, ${labelColour}, 0);`,
                `    lv_obj_set_style_text_font(numeral_${id}_${index + 1}, ${numeralFont}, 0);`,
                `    lv_obj_align(numeral_${id}_${index + 1}, LV_ALIGN_CENTER, ${(x ?? 0) - geometry.cx - 1}, ${
                    (y ?? 0) - geometry.cy + numeralY
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

function widgetLines(widget: DesignerWidget, parent: string, document: DesignerDocument): string[] {
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
            // The face draws itself from the geometry in its own block; the container only holds it.
            lines.push(`    lv_obj_t *${variable} = lv_obj_create(${parent});`, ...geometry);
            lines.push(`    lv_obj_set_style_border_width(${variable}, 0, 0);`);
            lines.push(`    lv_obj_set_style_bg_opa(${variable}, LV_OPA_TRANSP, 0);`);
            lines.push(`    ui_set_scrollable(${variable}, false);`);
            lines.push(`    lv_obj_set_style_pad_all(${variable}, 0, 0);`);
            lines.push(`    clock_${cppId(widget.id)}_build(${variable});`);
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

export function emitUiCpp(document: DesignerDocument): string {
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
        const lines = widgetLines(widget, `view_${cppId(widget.view ?? firstView)}`, document);
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

${FLAG_WRAPPERS}${clocks.length === 0 ? '' : `\n${CLOCK_HELPERS.replace('[[clocks]]', clocks.map((clock) => clockBlock(clock, document)).join('\n'))}\n`}
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
${
    clocks.filter((clock) => boolProp(clock, 'movement')).length === 0
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
