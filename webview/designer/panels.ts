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
    propertyHelp,
    toolboxGroups,
    widgetHelp,
    widgetRaises,
    widgetSpec,
} from '../../src/designer/catalog';
import type { DesignerActionId, DesignerAssetKind } from '../../src/designer/protocol';
import {
    type DesignerFont,
    type DesignerWidget,
    circleCentre,
    circleRadius,
    circleRect,
    designCanvasSize,
} from '../../src/designer/model';
import { NAMED_STYLES } from '../../src/designer/appearance';
import { BUILT_IN_FONTS, type FontSupport } from '../../src/designer/fonts';
import {
    type DesignerState,
    addFont,
    declareFontFromPath,
    duplicateWidget,
    moveWidget,
    removeWidget,
    renameWidget,
    removeFont,
    reorderWidget,
    resizeWidget,
    setChildren,
    setFontField,
    setIconParts,
    setProperty,
    setScreenField,
    toggleEvent,
} from '../../src/designer/state';

export interface PanelCallbacks {
    onEdit(state: DesignerState): void;
    onSelect(id: string | undefined): void;
    /**
     * Asks the extension to choose a file.
     *
     * The extension owns the dialog; the panel owns the edit, and applies the path when the answer arrives --
     * which is why it hands over the *apply* rather than the field's name.
     */
    onBrowseAsset(
        kind: DesignerAssetKind,
        apply: (path: string, font?: { source: string; size: number }) => void,
    ): void;
    /**
     * A font in a Font list was right-clicked.
     *
     * The menu itself is the panel's, but it has to be positioned against the page rather than the field, so the
     * coordinates travel out to whoever owns the root element -- the same arrangement the canvas and the layers
     * list use.
     */
    onFontMenu(fontId: string, x: number, y: number): void;
    /**
     * A widget's action button was pressed.
     *
     * Actions are the work only the extension can do -- it owns the filesystem, the terminal and the
     * serial port -- so the panel sends the id and forgets it. Nothing is awaited: the answer arrives
     * as a report, the same channel a save uses.
     */
    onAction(action: DesignerActionId): void;
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

/**
 * A labelled row, with an optional tooltip.
 *
 * The tooltip is a plain `title` attribute, which is what gives a native hover description in the webview --
 * no custom popup to keep in step with the theme, and it is announced by screen readers too.
 */
function field(label: string, control: HTMLElement, className = 'field', help?: string): HTMLElement {
    const row = element('label', className);
    if (help !== undefined) {
        row.title = help;
    }
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

/** The file dialog filter a widget's asset field wants. */
function assetKindFor(tag: string): DesignerAssetKind {
    return tag === 'mesh' ? 'mesh' : tag === 'icon' ? 'icon' : 'image';
}

/**
 * A path field with a button that opens a file dialog.
 *
 * The path is still typed-able -- a file that is already in the project is often quicker to name than to find --
 * but nobody should have to work out where an asset lives relative to the project root.
 */
/** How a declared font is named in the Font list: its id, and the size it was drawn at when that is known. */
function fontOptionLabel(font: { id: string; size?: number }): string {
    return font.size === undefined ? font.id : `${font.id} (${font.size} px)`;
}

/** The `...` that opens the file picker, named for the widget that reads it. */
function browseButton(onBrowse: () => void, title = DEFAULT_BROWSE_TITLE): HTMLElement {
    const pick = button('\u2026', 'secondary-button', onBrowse);
    pick.title = title;
    return pick;
}

const DEFAULT_BROWSE_TITLE = 'Choose a file. One from outside the project is copied into assets/.';

/** A font field takes a BDF as it is, and draws anything else into one -- so say so where it is offered. */
const FONT_BROWSE_TITLE =
    'Choose a font. A .bdf is used as it is; a .ttf or .otf is drawn into one at a size you pick.';

function assetField(
    value: string,
    onChange: (value: string) => void,
    onBrowse: (() => void) | undefined,
    title?: string,
): HTMLElement {
    const row = element('div', 'asset-field');
    row.append(textInput(value, onChange));
    if (onBrowse !== undefined) {
        row.append(browseButton(onBrowse, title));
    }
    return row;
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
            item.title = [
                widgetHelp(spec.tag) ?? spec.label,
                `starts at ${spec.defaultSize.width}x${spec.defaultSize.height} px`,
                spec.note,
            ]
                .filter((line) => line !== undefined)
                .join(' — ');
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
        if (spec.unavailable !== undefined) {
            // In the design but not in the toolbox: a tag the crate's own code generator cannot build. It is
            // still selectable and deletable, and this is the sentence that explains why it has to be.
            root.append(element('p', 'panel-note panel-note-blocked', spec.unavailable));
        }
        if (spec.note !== undefined) {
            root.append(element('p', 'panel-note', spec.note));
        }
        root.append(spec.draws === 'circle' ? circleGeometryForm(state, widget, callbacks) : geometryForm(state, widget, callbacks));
        if (spec.props.length > 0) {
            root.append(propertyForm(state, widget, spec, callbacks));
        }
        if (spec.actions !== undefined && spec.actions.length > 0) {
            root.append(actionForm(spec, callbacks));
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

/**
 * The buttons a widget offers beyond its properties.
 *
 * One per action the catalogue declares, with its help text as the tooltip -- which is where a caveat like
 * "needs the board connected" belongs, since the button has no room for it and the panel should not nag.
 */
function actionForm(spec: KdlWidgetSpec, callbacks: PanelCallbacks): HTMLElement {
    const node = section('Board');
    for (const action of spec.actions ?? []) {
        const item = button(action.label, 'secondary-button', () => callbacks.onAction(action.id));
        if (action.help !== undefined) {
            item.title = action.help;
        }
        node.append(item);
    }
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

/**
 * The Geometry form for a circle: centre and radius, rather than the rectangle's X/Y/W/H.
 *
 * A circle's rect is its bounding box, and its centre and radius are derived from that -- so the form edits the
 * rect through the same move/resize operations the canvas uses, keeping the document and the geometry panel in
 * step without a second pair of fields to fall out of sync.
 */
function circleGeometryForm(
    state: DesignerState,
    widget: DesignerWidget,
    callbacks: PanelCallbacks,
): HTMLElement {
    const canvas = designCanvasSize(
        state.document.panelWidth,
        state.document.panelHeight,
        state.document.rotation,
    );
    const { cx, cy } = circleCentre(widget);
    const radius = circleRadius(widget);
    const grid = element('div', 'field-grid');
    grid.append(
        field('Centre X', numberInput(cx, 0, canvas.width, (value) =>
            callbacks.onEdit(moveWidget(state, widget.id, value - radius, widget.y)))),
    );
    grid.append(
        field('Centre Y', numberInput(cy, 0, canvas.height, (value) =>
            callbacks.onEdit(moveWidget(state, widget.id, widget.x, value - radius)))),
    );
    grid.append(
        field(
            'Radius',
            numberInput(radius, 1, Math.floor(Math.min(canvas.width, canvas.height) / 2), (value) =>
                callbacks.onEdit(resizeWidget(state, widget.id, circleRect(cx, cy, value))),
            ),
        ),
    );
    const node = section('Geometry');
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
    // Properties that belong together -- a triangle's six vertex offsets -- get one small heading rather than
    // six identical-looking rows, so the numbers read as three points and not as six unrelated values.
    let group: string | undefined;
    for (const property of spec.props) {
        // A superseded property is read and written but not offered: editing one would be editing the past.
        if (property.legacy === true) {
            continue;
        }
        if (property.group !== undefined && property.group !== group) {
            group = property.group;
            node.append(element('h4', 'field-group', property.group));
        }
        const control = propertyControl(
            property,
            widget.props[property.name],
            (next) => callbacks.onEdit(setProperty(state, widget.id, property.name, next)),
            state.document.fonts ?? [],
            spec.fontSupport,
            property.kind === 'asset'
                ? () =>
                    callbacks.onBrowseAsset(assetKindFor(widget.tag), (path) =>
                        callbacks.onEdit(setProperty(state, widget.id, property.name, path)),
                    )
                : property.kind === 'font'
                    ? () =>
                        callbacks.onBrowseAsset('font', (path, font) =>
                            callbacks.onEdit(declareFontFromPath(state, widget.id, path, font)),
                        )
                    : undefined,
            callbacks.onFontMenu,
        );
        const help = [
            propertyHelp(widget.tag, property.name),
            // The parser reads it and the generator throws it away: say so rather than implying it works.
            property.ignoredByCodegen === true
                ? 'The markup accepts this, but the current code generator ignores it.'
                : undefined,
        ]
            .filter((line) => line !== undefined)
            .join(' ');
        const row = field(property.label, control, 'field', help === '' ? undefined : help);
        if (property.ignoredByCodegen === true) {
            row.classList.add('field-ignored');
        }
        node.append(row);
    }
    return node;
}

function propertyControl(
    property: KdlProperty,
    value: string | number | boolean | undefined,
    onChange: (value: string | number | boolean) => void,
    fonts: readonly DesignerFont[],
    support: FontSupport | undefined,
    onBrowse: (() => void) | undefined,
    onFontMenu: (fontId: string, x: number, y: number) => void,
): HTMLElement {
    switch (property.kind) {
        case 'asset':
            return assetField(String(value ?? ''), onChange, onBrowse);
        case 'font': {
            // Two routes, one control. A *declared* font is a BDF file in the project and the crate reads it
            // from `font="name"` on labels and carousels; a *built-in* one ships inside the crate and can only
            // be reached by a style expression. Which of the two a widget can take is the crate's shape, so the
            // list is built from what `fontSupport` allows rather than offered wholesale.
            const select = element('select', 'field-input');
            const none = element('option', undefined, '(default)');
            none.value = '';
            select.append(none);
            if (support !== 'attribute') {
                const group = element('optgroup');
                group.label = 'Built into the crate';
                for (const font of BUILT_IN_FONTS) {
                    const option = element('option', undefined, font.label);
                    option.value = font.id;
                    group.append(option);
                }
                select.append(group);
            }
            // A declared font is offered to every widget with this field, not just the ones that read a `font`
            // attribute: the ones that read only a style get `style.font = FontId::Bitmap(...)`, which is the
            // same `BitmapFont` the markup declares. Hiding the list made a system font look like it had not
            // been imported at all.
            if (fonts.length > 0) {
                const group = element('optgroup');
                group.label = 'In this project';
                for (const font of fonts) {
                    const option = element('option', undefined, fontOptionLabel(font));
                    option.value = font.id;
                    group.append(option);
                }
                select.append(group);
            }
            const current = typeof value === 'string' ? value : '';
            // A name the design no longer declares still has to be *shown*: a select whose value matches no
            // option draws itself blank, which reads as "nothing is set" when something is.
            if (current !== '' && !select.querySelector(`option[value="${current}"]`)) {
                const orphan = element('option', undefined, `${current} (not in this project)`);
                orphan.value = current;
                select.append(orphan);
            }
            select.value = current;
            select.addEventListener('change', () => onChange(select.value));
            // A font is removed from where it is chosen. The list is the only place a declared font appears, so
            // right-clicking it is the shortest path to "I do not want this one" -- and removing it clears the
            // reference from every widget that named it, in one undo step.
            select.addEventListener('contextmenu', (event) => {
                const declared = fonts.some((font) => font.id === current);
                if (current === '' || !declared) {
                    return;
                }
                event.preventDefault();
                onFontMenu(current, event.clientX, event.clientY);
            });

            const rowNode = element('div', 'asset-field');
            rowNode.append(select);
            if (onBrowse !== undefined) {
                // The `...` declares a font from a file and selects it, so the common case -- "use this font, I
                // have not added it yet" -- is one action rather than two lists to visit in the right order. A
                // system font is drawn into a BDF on the way, which is why the button says so.
                rowNode.append(browseButton(onBrowse, FONT_BROWSE_TITLE));
            }
            return rowNode;
        }
        case 'bool': {
            const input = element('input', 'field-input');
            input.type = 'checkbox';
            input.checked = value === true;
            input.addEventListener('change', () => onChange(input.checked));
            return input;
        }
        case 'style': {
            // The base styles a widget can wear. Named for what they look like rather than for the word the
            // markup wants, because "panel" on a label means "give this label a panel's background".
            const select = element('select', 'field-input');
            const own = element('option', undefined, "(the widget's own look)");
            own.value = '';
            select.append(own);
            for (const named of NAMED_STYLES) {
                const choice = element('option', undefined, named.label);
                choice.value = named.id;
                select.append(choice);
            }
            select.value = typeof value === 'string' ? value : '';
            select.addEventListener('change', () => onChange(select.value));
            return select;
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
            const setPart = (value: string) => {
                const parts = children.parts.map((candidate, at) =>
                    at === index ? { ...candidate, src: value } : candidate,
                );
                callbacks.onEdit(setIconParts(state, widget.id, parts));
            };
            node.append(
                field(
                    `Part ${index + 1}`,
                    assetField(part.src, setPart, () => callbacks.onBrowseAsset('icon', setPart)),
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
    node.append(fontList(state, callbacks));
    return node;
}

/**
 * The fonts the screen declares.
 *
 * A widget's `Font` is a reference to one of these, so this is where the file is actually chosen. A font is
 * embedded into the firmware at build time from a BDF -- the only format the crate's loader parses -- and
 * `chars` narrows it, which matters on a panel where flash is the budget: a design that shows digits need not
 * carry the whole alphabet.
 */
function fontList(state: DesignerState, callbacks: PanelCallbacks): HTMLElement {
    const node = section('Fonts');
    const fonts = state.document.fonts ?? [];
    node.append(
        element(
            'p',
            'panel-note',
            'A BDF file, embedded into the firmware at build time. Widgets then pick one by name.',
        ),
    );

    for (const font of fonts) {
        const entry = element('div', 'font-entry');
        entry.append(
            field(
                'Name',
                textInput(font.id, (value) => callbacks.onEdit(setFontField(state, font.id, 'id', value))),
                'field',
                'The name widgets refer to. Letters, digits and underscores only.',
            ),
        );
        // The file is a path relative to the project root, like every other asset.
        entry.append(
            field(
                'File',
                assetField(
                    font.src,
                    (value) => callbacks.onEdit(setFontField(state, font.id, 'src', value)),
                    () =>
                        callbacks.onBrowseAsset('font', (path) =>
                            callbacks.onEdit(setFontField(state, font.id, 'src', path)),
                        ),
                ),
                'field',
                'A BDF file, relative to the project root, e.g. assets/title.bdf. It is embedded at build time.',
            ),
        );
        entry.append(
            field(
                'Characters',
                textInput(font.chars, (value) => callbacks.onEdit(setFontField(state, font.id, 'chars', value))),
                'field',
                'Which characters to embed. Empty embeds every glyph in the file; a title can use far fewer.',
            ),
        );
        // An imported font is a drawing of a face, so say which one and at what size: the BDF's own name is
        // about the file, and the face it came from is what the design actually chose.
        if (font.source !== undefined) {
            entry.append(
                field(
                    'Drawn from',
                    element(
                        'span',
                        'field-static',
                        `${font.source}${font.size === undefined ? '' : ` at ${font.size} px`}`,
                    ),
                    'field',
                    'The face this font was drawn from, and the size. Change the size in a widget\'s Font row.',
                ),
            );
        }
        const remove = button('Remove', 'secondary-button', () =>
            callbacks.onEdit(removeFont(state, font.id)),
        );
        entry.append(remove);
        node.append(entry);
    }

    node.append(button('Add a font', 'secondary-button', () => callbacks.onEdit(addFont(state))));
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

// ---------------------------------------------------------------- the right-click menu

export interface ContextMenuItem {
    label: string;
    action: () => void;
    /** Drawn in the error colour, for the one that removes something. */
    danger?: boolean;
}

/** The open menu, so opening another can replace it and a click anywhere can dismiss it. */
let openMenu: HTMLElement | undefined;

/**
 * Opens the menu for a placed control at a point.
 *
 * Deleting, duplicating and reordering were only reachable from the layer list, which is a list of names --
 * right-clicking the thing itself is the shorter path, and the menu is the natural home for the rest.
 */
export function showContextMenu(
    host: HTMLElement,
    x: number,
    y: number,
    items: readonly ContextMenuItem[],
): void {
    hideContextMenu(host);
    const menu = element('div', 'context-menu');
    for (const item of items) {
        const entry = button(item.label, item.danger === true ? 'context-item danger' : 'context-item', () => {
            hideContextMenu(host);
            item.action();
        });
        menu.append(entry);
    }
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    host.append(menu);
    openMenu = menu;
}

/** Closes it, if one is open. Safe to call when none is. */
export function hideContextMenu(host: HTMLElement): void {
    if (openMenu !== undefined) {
        host.removeChild(openMenu);
        openMenu = undefined;
    }
}

/** The menu a declared font offers, opened from the Font list that names it. */
export function fontMenu(
    state: DesignerState,
    id: string,
    callbacks: PanelCallbacks,
): ContextMenuItem[] {
    // Removing a font clears the reference from every widget that named it (`removeFont`), because a widget
    // left pointing at a font that no longer exists is a validation error the user would have to hunt for.
    return [
        {
            label: `Delete the font "${id}"`,
            danger: true,
            action: () => callbacks.onEdit(removeFont(state, id)),
        },
    ];
}

/** The menu a placed control offers. */
export function widgetMenu(
    state: DesignerState,
    id: string,
    callbacks: PanelCallbacks,
): ContextMenuItem[] {
    return [
        { label: 'Duplicate', action: () => callbacks.onEdit(duplicateWidget(state, id)) },
        { label: 'Bring forward', action: () => callbacks.onEdit(reorderWidget(state, id, 'up')) },
        { label: 'Send backward', action: () => callbacks.onEdit(reorderWidget(state, id, 'down')) },
        {
            label: 'Delete',
            danger: true,
            action: () => {
                callbacks.onEdit(removeWidget(state, id));
                callbacks.onSelect(undefined);
            },
        },
    ];
}
