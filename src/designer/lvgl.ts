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
function widgetLines(widget: DesignerWidget, parent: string): string[] {
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
            break;
        case 'text_lines': {
            lines.push(`    lv_obj_t *${variable} = lv_obj_create(${parent});`, ...geometry);
            lines.push(`    lv_obj_set_flex_flow(${variable}, LV_FLEX_FLOW_COLUMN);`);
            lines.push(`    lv_obj_set_style_pad_row(${variable}, ${Math.round(numberProp(widget, 'gap', 2))}, 0);`);
            lines.push(`    lv_obj_set_style_border_width(${variable}, 0, 0);`);
            lines.push(`    lv_obj_set_style_bg_opa(${variable}, LV_OPA_TRANSP, 0);`);
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
            break;
        }
        case 'roller': {
            lines.push(`    lv_obj_t *${variable} = lv_roller_create(${parent});`, ...geometry);
            const options = widget.children?.kind === 'options' ? widget.children.values : [];
            lines.push(
                `    lv_roller_set_options(${variable}, ${cString(options.join('\n'))}, LV_ROLLER_MODE_NORMAL);`,
            );
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
        case 'keypad':
            lines.push(`    lv_obj_t *${variable} = lv_textarea_create(${parent});`, ...geometry);
            lines.push(`    lv_obj_t *${variable}_keys = lv_keyboard_create(${parent});`);
            lines.push(`    lv_keyboard_set_textarea(${variable}_keys, ${variable});`);
            break;
        case 'panel':
            lines.push(`    lv_obj_t *${variable} = lv_obj_create(${parent});`, ...geometry);
            lines.push(`    lv_obj_set_style_border_width(${variable}, 0, 0);`);
            lines.push(`    lv_obj_set_style_radius(${variable}, 0, 0);`);
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
            ];
            if (view.id !== startView) {
                lines.push(`    ui_set_hidden(${name}, true);`);
            }
            return lines.join('\n');
        })
        .join('\n');

    const widgetBlocks: string[] = [];
    for (const widget of document.widgets) {
        const lines = widgetLines(widget, `view_${cppId(widget.view ?? firstView)}`);
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

${FLAG_WRAPPERS}
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

void ui_init() {
    lv_obj_t *screen = lv_screen_active();
    ui_set_scrollable(screen, false);

${viewObjects}

${widgetBlocks.join('\n\n')}

    Serial.printf("ui: ${document.widgets.length} widget(s), ${views.length} view(s)\\n");
}

void ui_tick() {
    // Nothing in this design recomputes itself. A clock's hands, or a value read from the board, is emitted
    // here when the design asks for one.
}
`;
}

/** The header `ui.cpp` is compiled against. Written by the wizard and rewritten by the Designer -- one text. */
export function emitUiCppHeader(): string {
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
`;
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
