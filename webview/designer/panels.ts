/**
 * The panels around the canvas: the Toolbox on the left, the property editor on the right.
 *
 * Both are built from the catalogue rather than hand-written, which is the whole reason the catalogue is data:
 * a new tag in `src/designer/catalog.ts` appears in the Toolbox, gets editors for its own properties, and
 * offers exactly the events it can raise, without anything in this file changing.
 *
 * Two rules are followed throughout:
 *
 * - **Nothing user-supplied is ever parsed as markup.** Ids, labels and asset paths come out of a document
 *   the user controls, so they are set with `textContent` and input values, never with `innerHTML`.
 * - **A property that does not reach the board says so.** The rectangle and circle tags carry properties the
 *   code generator discards, and a button's fill is painted over by the theme: those get a visible warning
 *   rather than a control that appears to work.
 */

import {
    CATEGORY_LABELS,
    type KdlProperty,
    type KdlWidgetSpec,
    DESIGNER_EVENTS,
    EVENT_SPECS,
    toolboxGroups,
    widgetRaises,
    widgetSpec,
} from '../../src/designer/catalog';
import { type DesignerWidget, designCanvasSize } from '../../src/designer/model';
import {
    type DesignerState,
    moveWidget,
    removeWidget,
    renameWidget,
    reorderWidget,
    resizeWidget,
    setChildren,
    setIconParts,
    setProperty,
    setScreenField,
    toggleEvent,
} from '../../src/designer/state';

export interface PanelCallbacks {
    onEdit(state: DesignerState): void;
    onSelect(id: string | undefined): void;
}

/** A short element factory, because the DOM API is otherwise nine lines per control. */
function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className !== undefined) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

/** A labelled row. */
function field(label: string, control: HTMLElement, className = 'field'): HTMLElement {
    const row = element('label', className);
    row.append(element('span', 'field-label', label));
    row.append(control);
    return row;
}

function section(title: string): HTMLElement {
    const node = element('section', 'panel-section');
    node.append(element('h3', 'group-title', title));
    return node;
}

function numberInput(
    value: number,
    min: number | undefined,
    max: number | undefined,
    onChange: (value: number) => void,
): HTMLInputElement {
    const input = element('input', 'field-input');
    input.type = 'number';
    input.value = String(value);
    if (min !== undefined) {
        input.min = String(min);
    }
    if (max !== undefined) {
        input.max = String(max);
    }
    input.addEventListener('change', () => {
        const parsed = Number(input.value);
        if (Number.isFinite(parsed)) {
            onChange(parsed);
        }
    });
    return input;
}

function textInput(value: string, onChange: (value: string) => void): HTMLInputElement {
    const input = element('input', 'field-input');
    input.type = 'text';
    input.value = value;
    input.addEventListener('change', () => onChange(input.value));
    return input;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
    const node = element('button', className, label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
}

/**
 * Fills the Toolbox.
 *
 * Each entry can be dragged onto the canvas, and can also be clicked, which drops it in the middle. The click
 * path exists because dragging is not available to everyone: a keyboard or an assistive device can only reach
 * the button, and a designer that requires a drag shuts those users out.
 */
export function renderToolbox(root: HTMLElement, onTag: (tag: string) => void): void {
    root.replaceChildren();
    root.append(element('h2', 'panel-title', 'Toolbox'));

    for (const group of toolboxGroups()) {
        const node = element('div', 'toolbox-group');
        node.append(element('h3', 'group-title', CATEGORY_LABELS[group.category]));
        for (const spec of group.widgets) {
            const item = button(spec.label, 'toolbox-item', () => onTag(spec.tag));
            item.draggable = true;
            item.title = spec.note ?? `${spec.label} (${spec.defaultSize.width}x${spec.defaultSize.height})`;
            if (spec.note !== undefined) {
                item.classList.add('has-caveat');
            }
            item.addEventListener('dragstart', (event) => {
                event.dataTransfer?.setData('text/rusty-designer-widget', spec.tag);
                if (event.dataTransfer !== null) {
                    event.dataTransfer.effectAllowed = 'copy';
                }
            });
            node.append(item);
        }
        root.append(node);
    }
}

/**
 * Fills the property panel for the current selection.
 *
 * Everything below the identity row is driven by the catalogue: the editors by each property's `kind`, the
 * handler list by the events the tag actually raises.
 */
export function renderProperties(
    root: HTMLElement,
    state: DesignerState,
    selectedId: string | undefined,
    callbacks: PanelCallbacks,
): void {
    root.replaceChildren();

    if (selectedId === undefined) {
        root.append(element('h2', 'panel-title', 'Screen'));
        root.append(screenForm(state, callbacks));
        root.append(layerList(state, undefined, callbacks));
        return;
    }

    const widget = state.document.widgets.find((candidate) => candidate.id === selectedId);
    if (widget === undefined) {
        root.append(element('p', 'panel-empty', 'That widget is gone.'));
        return;
    }
    const spec = widgetSpec(widget.tag);
    root.append(element('h2', 'panel-title', spec?.label ?? widget.tag));
    root.append(identityForm(state, widget, callbacks));

    if (spec !== undefined) {
        if (spec.note !== undefined) {
            root.append(element('p', 'panel-note', spec.note));
        }
        root.append(geometryForm(state, widget, callbacks));
        if (spec.props.length > 0) {
            root.append(propertyForm(state, widget, spec, callbacks));
        }
        root.append(eventForm(state, widget, callbacks, spec));
        if (spec.children !== undefined) {
            root.append(childrenForm(state, widget, callbacks));
        }
    }
    root.append(layerList(state, selectedId, callbacks));
}

function identityForm(state: DesignerState, widget: DesignerWidget, callbacks: PanelCallbacks): HTMLElement {
    const node = section('Widget');
    node.append(
        field('Name', textInput(widget.id, (value) => callbacks.onEdit(renameWidget(state, widget.id, value)))),
    );
    node.append(field('Tag', element('span', 'field-static', widget.tag)));
    return node;
}

function geometryForm(state: DesignerState, widget: DesignerWidget, callbacks: PanelCallbacks): HTMLElement {
    const node = section('Geometry');
    const grid = element('div', 'field-grid');
    // Position and size go through the same operations the canvas uses, so clamping and undo coalescing behave
    // identically whether the number was dragged or typed.
    grid.append(
        field('X', numberInput(widget.x, 0, undefined, (value) => callbacks.onEdit(moveWidget(state, widget.id, value, widget.y)))),
    );
    grid.append(
        field('Y', numberInput(widget.y, 0, undefined, (value) => callbacks.onEdit(moveWidget(state, widget.id, widget.x, value)))),
    );
    grid.append(
        field('Width', numberInput(widget.width, 1, undefined, (value) =>
            callbacks.onEdit(resizeWidget(state, widget.id, { x: widget.x, y: widget.y, width: value, height: widget.height })))),
    );
    grid.append(
        field('Height', numberInput(widget.height, 1, undefined, (value) =>
            callbacks.onEdit(resizeWidget(state, widget.id, { x: widget.x, y: widget.y, width: widget.width, height: value })))),
    );
    node.append(grid);
    return node;
}

/** One editor per property, chosen by the property's kind. */
function propertyForm(
    state: DesignerState,
    widget: DesignerWidget,
    spec: KdlWidgetSpec,
    callbacks: PanelCallbacks,
): HTMLElement {
    const node = section('Properties');
    for (const property of spec.props) {
        const control = propertyControl(property, widget.props[property.name], (next) =>
            callbacks.onEdit(setProperty(state, widget.id, property.name, next)),
        );
        const row = field(property.label, control);
        if (property.ignoredByCodegen === true) {
            // The parser reads it and the generator throws it away: say so rather than implying it works.
            row.classList.add('field-ignored');
            row.title = 'The markup accepts this, but the current code generator ignores it.';
        }
        node.append(row);
    }
    return node;
}

function propertyControl(
    property: KdlProperty,
    value: string | number | boolean | undefined,
    onChange: (value: string | number | boolean) => void,
): HTMLElement {
    switch (property.kind) {
        case 'bool': {
            const input = element('input', 'field-input');
            input.type = 'checkbox';
            input.checked = value === true;
            input.addEventListener('change', () => onChange(input.checked));
            return input;
        }
        case 'enum': {
            const select = element('select', 'field-input');
            for (const option of property.options ?? []) {
                const choice = element('option', undefined, option);
                choice.value = option;
                select.append(choice);
            }
            select.value = String(value ?? property.defaultValue);
            select.addEventListener('change', () => onChange(select.value));
            return select;
        }
        case 'color': {
            const row = element('div', 'color-field');
            const input = element('input', 'field-input');
            input.type = 'color';
            // The markup wants #rrggbb, which is exactly what the browser's colour input produces.
            input.value = typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000';
            input.addEventListener('change', () => onChange(input.value));
            const clear = button('none', 'secondary-button', () => onChange(''));
            clear.title = 'Leave the property out of the markup, so the crate\'s own default applies';
            row.append(input, clear);
            return row;
        }
        case 'int':
        case 'float': {
            const input = numberInput(Number(value ?? property.defaultValue), property.min, property.max, onChange);
            input.step = property.kind === 'float' ? '0.1' : '1';
            return input;
        }
        default:
            return textInput(String(value ?? ''), onChange);
    }
}

function eventForm(
    state: DesignerState,
    widget: DesignerWidget,
    callbacks: PanelCallbacks,
    spec: KdlWidgetSpec,
): HTMLElement {
    const node = section('Events');
    if (spec.events.length === 0) {
        node.append(element('p', 'panel-note', 'This widget raises no events: firmware cannot be told it changed.'));
        return node;
    }
    node.append(element('p', 'panel-note', 'Tick an event to have a handler inserted into src/ui_handlers.rs.'));
    for (const event of DESIGNER_EVENTS) {
        if (!widgetRaises(widget.tag, event)) {
            continue;
        }
        const input = element('input', 'field-input');
        input.type = 'checkbox';
        input.checked = widget.events.includes(event);
        input.addEventListener('change', () => callbacks.onEdit(toggleEvent(state, widget.id, event)));
        const row = field(handlerName(widget.id, event), input);
        node.append(row);
    }
    return node;
}

/** The handler name, which is what the user will be looking for in the generated Rust. */
function handlerName(id: string, event: keyof typeof EVENT_SPECS): string {
    return `on_${id}_${EVENT_SPECS[event].suffix}`;
}

/** The option list, table body or icon parts of a widget that has one. */
function childrenForm(state: DesignerState, widget: DesignerWidget, callbacks: PanelCallbacks): HTMLElement {
    const node = section('Body');
    const children = widget.children;

    if (children?.kind === 'options') {
        node.append(element('p', 'panel-note', 'One option per line.'));
        const area = element('textarea', 'field-input');
        area.rows = 4;
        area.value = children.values.join('\n');
        area.addEventListener('change', () =>
            callbacks.onEdit(
                setChildren(state, widget.id, {
                    kind: 'options',
                    values: area.value.split('\n').filter((line) => line.trim() !== ''),
                }),
            ),
        );
        node.append(area);
        return node;
    }

    if (children?.kind === 'table') {
        node.append(element('p', 'panel-note', 'The first line is the header row; one row per line after it.'));
        const area = element('textarea', 'field-input');
        area.rows = 5;
        area.value = [children.headers.join(' | '), ...children.rows.map((row) => row.join(' | '))].join('\n');
        area.addEventListener('change', () => {
            const lines = area.value.split('\n').filter((line) => line.trim() !== '');
            const headers = (lines[0] ?? '').split('|').map((cell) => cell.trim());
            const rows = lines.slice(1).map((line) => line.split('|').map((cell) => cell.trim()));
            callbacks.onEdit(setChildren(state, widget.id, { kind: 'table', headers, rows }));
        });
        node.append(area);
        return node;
    }

    if (children?.kind === 'parts') {
        node.append(
            element(
                'p',
                'panel-note',
                'A composite icon needs at least one part, and each part needs an asset in the project.',
            ),
        );
        children.parts.forEach((part, index) => {
            node.append(
                field(
                    `Part ${index + 1}`,
                    textInput(part.src, (value) => {
                        const parts = children.parts.map((candidate, at) =>
                            at === index ? { ...candidate, src: value } : candidate,
                        );
                        callbacks.onEdit(setIconParts(state, widget.id, parts));
                    }),
                ),
            );
        });
        node.append(
            button('Add a part', 'secondary-button', () =>
                callbacks.onEdit(
                    setIconParts(state, widget.id, [
                        ...children.parts,
                        { src: '', x: 0, y: 0, visible: true, tint: '' },
                    ]),
                ),
            ),
        );
        return node;
    }

    return node;
}

/** The screen itself, shown when nothing is selected. */
function screenForm(state: DesignerState, callbacks: PanelCallbacks): HTMLElement {
    const node = section('Screen');
    const document = state.document;
    const canvas = designCanvasSize(document.panelWidth, document.panelHeight, document.rotation);
    node.append(
        field('Screen id', textInput(document.screenId, (value) => callbacks.onEdit(setScreenField(state, 'screenId', value)))),
    );
    node.append(field('Theme', textInput(document.theme, (value) => callbacks.onEdit(setScreenField(state, 'theme', value)))));
    node.append(field('Board', element('span', 'field-static', document.boardId)));
    node.append(
        field(
            'Canvas',
            element('span', 'field-static', `${canvas.width}x${canvas.height} at rotation ${document.rotation}`),
        ),
    );
    return node;
}

/** The drawing order, topmost first, with buttons to reorder and delete. */
function layerList(state: DesignerState, selectedId: string | undefined, callbacks: PanelCallbacks): HTMLElement {
    const node = section('Layers');
    node.append(element('p', 'panel-note', 'The list is the drawing order: the top entry draws last.'));

    const list = element('ul', 'layer-list');
    for (const widget of [...state.document.widgets].reverse()) {
        const item = element('li', 'layer-item');
        if (widget.id === selectedId) {
            item.classList.add('is-selected');
        }
        item.append(button(`${widget.id} (${widget.tag})`, 'layer-name', () => callbacks.onSelect(widget.id)));
        const up = button('^', 'icon-button', () => callbacks.onEdit(reorderWidget(state, widget.id, 'up')));
        up.title = 'Bring forward';
        const down = button('v', 'icon-button', () => callbacks.onEdit(reorderWidget(state, widget.id, 'down')));
        down.title = 'Send backward';
        const remove = button('x', 'icon-button danger', () => {
            callbacks.onEdit(removeWidget(state, widget.id));
            callbacks.onSelect(undefined);
        });
        remove.title = 'Delete';
        item.append(up, down, remove);
        list.append(item);
    }
    node.append(list);
    return node;
}
