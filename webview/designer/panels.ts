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
    navigateTriggerFor,
    propertyHelp,
    toolboxGroups,
    widgetHelp,
    widgetRaises,
    widgetSpec,
} from '../../src/designer/catalog';
import type { DesignerActionId, DesignerAssetKind, DesignerHardware } from '../../src/designer/protocol';
import {
    PANEL_MODULES,
    busLabel,
    headerPin,
    panelModule,
    panelModuleOrDefault,
    planWiring,
    type PanelWiring,
} from '../../src/boards/panels';
import {
    type DesignerFont,
    type DesignerWidget,
    circleCentre,
    circleRadius,
    circleRect,
    designCanvasSize,
    widgetViewId,
} from '../../src/designer/model';
import { NAMED_STYLES } from '../../src/designer/appearance';
import { BUILT_IN_FONTS, type FontSupport } from '../../src/designer/fonts';
import {
    type DesignerState,
    addFont,
    assignView,
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
    setNavigateTarget,
    setProperty,
    setScreenField,
    toggleEvent,
    viewsOf,
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

    /**
     * The Hardware panel's wiring changed.
     *
     * Sent on every committed field, because the extension is the only validator: its rules are the same ones
     * embassy-rp's typed pins enforce, and a second copy of them here would drift. The answer comes back as a
     * report carrying the verdict.
     *
     * `note` is set when the panel planned the pins itself -- a bus change, a new module, the assign button --
     * and says which of them moved. A plain edit sends none, because the field that was typed *is* the change.
     * `replanned` tells the two apart: a planned wiring is not in the fields yet, so the panel has to redraw
     * itself, while an edit already is and redrawing would take the caret out of the box being typed in.
     */
    onWiring(wiring: PanelWiring, note?: string, replanned?: boolean): void;
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
 *
 * `unavailable` is the widgets this project's language cannot draw, with the reason. They are listed but not
 * offered: a person looking for one deserves the sentence rather than a gap in the toolbox.
 */
export function renderToolbox(
    root: HTMLElement,
    onTag: (tag: string) => void,
    unavailable: readonly { tag: string; reason: string }[] = [],
): void {
    const blocked = new Map(unavailable.map((entry) => [entry.tag, entry.reason]));
    root.replaceChildren();
    root.append(element('h2', 'panel-title', 'Toolbox'));

    for (const group of toolboxGroups()) {
        const node = element('div', 'toolbox-group');
        node.append(element('h3', 'group-title', CATEGORY_LABELS[group.category]));
        for (const spec of group.widgets) {
            const item = button(spec.label, 'toolbox-item', () => onTag(spec.tag));
            const reason = blocked.get(spec.tag);
            if (reason !== undefined) {
                item.disabled = true;
                item.classList.add('is-unavailable');
                item.title = reason;
                node.append(item);
                continue;
            }
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
    hardware?: DesignerHardware,
): void {
    root.replaceChildren();

    if (selectedId === undefined) {
        root.append(element('h2', 'panel-title', 'Screen'));
        root.append(screenForm(state, callbacks));
        // A Pico's panel is wired rather than soldered, so its pins are part of the screen. An ESP board has
        // no `hardware` and shows nothing here.
        if (hardware !== undefined) {
            root.append(hardwareForm(hardware, callbacks));
        }
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
    // Which view the widget is on. Offered only once there is a second one: a design with one view keeps
    // exactly the panel it had before views existed.
    const views = viewsOf(state.document);
    if (views.length > 1) {
        const select = element('select', 'field-input');
        for (const view of views) {
            const option = element('option');
            option.value = view.id;
            option.textContent = view.label === '' ? view.id : view.label;
            select.append(option);
        }
        select.value = widgetViewId(state.document, widget);
        select.addEventListener('change', () => callbacks.onEdit(assignView(state, widget.id, select.value)));
        node.append(field('View', select));
    }
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
        // An event's own property belongs beside the event, not in the list of things that reach the board:
        // the navigate destination has a row of its own in the Events section.
        if (actionTargets().includes(property.name)) {
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

/** The property names that events carry, which the Events section edits rather than the property list. */
function actionTargets(): string[] {
    return Object.values(EVENT_SPECS)
        .map((spec) => spec.action?.targetProperty)
        .filter((name): name is string => name !== undefined);
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
        const spec = EVENT_SPECS[event];
        if (spec.action !== undefined) {
            // Not a handler: a destination. The generated code answers the click itself, so the row asks which
            // view to show -- and says so when the design has only one, because then there is nowhere to go.
            const views = viewsOf(state.document);
            if (views.length < 2) {
                node.append(element('p', 'panel-note', 'A navigate event needs a second view to switch to.'));
                continue;
            }
            const select = element('select', 'field-input');
            const current = String(widget.props[spec.action.targetProperty] ?? '');
            for (const view of views) {
                const option = element('option', undefined, view.label === view.id ? view.id : `${view.label} (${view.id})`);
                option.value = view.id;
                option.selected = view.id === current;
                select.append(option);
            }
            select.addEventListener('change', () =>
                callbacks.onEdit(setNavigateTarget(state, widget.id, select.value)),
            );
            const box = element('input', 'field-input');
            box.type = 'checkbox';
            box.checked = widget.events.includes(event);
            box.addEventListener('change', () => callbacks.onEdit(toggleEvent(state, widget.id, event)));
            // Two rows rather than one nested label: a `<label>` inside a `<label>` is not valid markup, and
            // the picker has to be reachable on its own anyway. The title says which event fires it, because
            // that is the widget's own event -- a click on a button, a change on a dropdown.
            const fires = navigateTriggerFor(widget.tag);
            node.append(
                field(
                    'Navigate',
                    box,
                    'field',
                    fires === undefined
                        ? 'Switch view without a handler'
                        : `Switches view when the widget reports ${EVENT_SPECS[fires].suffix.replace(/_/g, ' ')}, and needs no handler`,
                ),
            );
            node.append(field('Goes to view', select));
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

    if (children?.kind === 'lines') {
        node.append(
            element(
                'p',
                'panel-note',
                'One entry per line. Each folds to the panel width when it is drawn, so a long entry needs no '
                + 'manual break; code addresses them by index, oldest first.',
            ),
        );
        const area = element('textarea', 'field-input');
        area.rows = 6;
        area.value = children.values.join('\n');
        area.addEventListener('change', () =>
            callbacks.onEdit(
                setChildren(state, widget.id, {
                    kind: 'lines',
                    // Blank entries are dropped rather than kept: a blank line is a real gap in the middle of
                    // a panel (the widget honours it), but a trailing one is almost always the newline the
                    // textarea leaves behind, and keeping it would make the panel look one line longer than
                    // the user typed.
                    values: area.value.split('\n').filter((line, index, all) => line !== '' || index < all.length - 1),
                }),
            ),
        );
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

/**
 * The Hardware panel: which module is wired to the board, and to which GPIOs.
 *
 * A Pico has no soldered panel, so these numbers *are* the display as far as the firmware is concerned: they
 * are compiled into `src/panel.rs` and every one of them is checked against the chip's own pin functions. The
 * panel offers them as plain number boxes rather than a list of legal pins per signal, because the wiring is
 * what somebody did with a soldering iron and a wrong number has to be *said* rather than made untypeable --
 * the extension's verdict appears under the fields as soon as a number is committed.
 */
function hardwareForm(hardware: DesignerHardware, callbacks: PanelCallbacks): HTMLElement {
    const node = section('Hardware');
    const wiring = hardware.wiring;
    const module = panelModule(wiring.panel);

    /**
     * Plans the pins for a change, here in the panel.
     *
     * The same `planWiring` the extension uses, imported rather than reimplemented: a selector that guessed
     * differently from the validator would be worse than no selector at all. `fresh` throws the current pins
     * away and plans from the block, which is what the assign button offers after a few overrides have left
     * the wiring somewhere odd.
     */
    const replan = (change: { panel?: string; bus?: 0 | 1; alt?: boolean; fresh?: boolean }): void => {
        const chosen = panelModuleOrDefault(change.panel ?? wiring.panel);
        const { wiring: planned, notes } = planWiring({
            panel: chosen.id,
            bus: change.bus ?? wiring.bus,
            alt: change.alt ?? wiring.alt,
            // The socket is in use when it has pins: the toolbar switch is a cargo feature and this is the
            // wiring, and planning the card back in because the *module* has a socket would argue with it.
            sd: chosen.sd && wiring.sdCs !== null,
            reserved: hardware.reserved,
            timeSource: wiring.timeSource,
            backlightActiveLow: wiring.backlightActiveLow,
            keep: change.fresh === true ? undefined : wiring,
        });
        callbacks.onWiring(planned, notes.length > 0 ? `${notes.join('. ')}.` : undefined, true);
    };

    node.append(
        element(
            'p',
            'panel-note',
            `Wired to ${hardware.board}. These GPIOs are compiled into src/panel.rs; the Designer rewrites it ` +
            'whenever one of them changes.',
        ),
    );

    // The module decides the glass: its size, its colour order, whether it has a touch controller and whether
    // it has a card socket. Picking another one re-lays the canvas the next time the Designer is opened.
    const moduleSelect = element('select', 'field-input');
    for (const candidate of PANEL_MODULES) {
        const option = element('option');
        option.value = candidate.id;
        option.textContent = candidate.label;
        if (candidate.id === wiring.panel) {
            option.selected = true;
        }
        moduleSelect.append(option);
    }
    moduleSelect.addEventListener('change', () => {
        // Re-planned, not just renamed: the module decides whether there is a touch pair to assign and whether
        // a socket's four pins are needed at all.
        replan({ panel: moduleSelect.value });
    });
    node.append(field('Module', moduleSelect, 'field', 'A different module is a different size and may have touch or a card socket.'));

    // The bus is the choice the pins hang off, so it comes before them. Choosing one moves the block of four,
    // takes the control lines and the touch pair to the nearest free pins, and gives the card the other bus.
    // Three entries, because SPI0 has two groups of pins and the choice between them is a wiring decision
    // rather than something to infer from a number. The value is `<bus>` or `<bus>-alt`.
    const busOptions: Array<{ value: string; bus: 0 | 1; alt: boolean }> = [
        { value: '0', bus: 0, alt: false },
        { value: '0-alt', bus: 0, alt: true },
        { value: '1', bus: 1, alt: false },
    ];
    const busSelect = element('select', 'field-input');
    for (const candidate of busOptions) {
        const option = element('option');
        option.value = candidate.value;
        option.textContent = busLabel(candidate.bus, candidate.alt);
        if (candidate.bus === wiring.bus && candidate.alt === (wiring.alt === true)) {
            option.selected = true;
        }
        busSelect.append(option);
    }
    busSelect.addEventListener('change', () => {
        const picked = busOptions.find((candidate) => candidate.value === busSelect.value);
        if (picked !== undefined) {
            replan({ bus: picked.bus, alt: picked.alt });
        }
    });
    node.append(
        field(
            'Bus',
            busSelect,
            'field',
            'Which SPI bus the panel is on. The four SPI pins are assigned for you, DC, RESET and BL take the ' +
            'nearest free pins, and the card gets the other bus. Any pin can still be overridden below.',
        ),
    );

    const assignButton = element('button', 'secondary-button', 'Assign the pins');
    assignButton.addEventListener('click', () => replan({ fresh: true }));
    node.append(
        field(
            'Automatic',
            assignButton,
            'field',
            'Plan the pins again from the bus: discards the overrides below and puts every pin back where the ' +
            'planner would choose it.',
        ),
    );

    /**
     * One pin, and the module pin it comes out on.
     *
     * The GPIO is what the firmware names and the header pin is what a soldering iron finds, so the two sit
     * together: a narrow box (a GPIO is one or two digits, and the spinner arrows that used to fill it are
     * gone -- they halved the box and nobody nudges a GPIO one click at a time) with the module's own pin
     * number beside it. `—` is a real answer: GPIO 23, 24, 25 and 29 are the radio's and the LED's, and are
     * not on the header at all.
     */
    const pinRow = (label: string, key: keyof PanelWiring, help: string): HTMLElement => {
        const current = wiring[key];
        const input = element('input', 'field-input pin-input');
        input.type = 'number';
        input.min = '0';
        input.max = '29';
        input.value = current === null ? '' : String(current);
        input.addEventListener('change', () => {
            const text = input.value.trim();
            const value = text === '' ? null : Number(text);
            // One number at a time, as typed. Moving the panel to another group of pins is what the bus list is
            // for, so a clock pin that belongs to the other group is a pin the validator judges, not a re-plan.
            callbacks.onWiring({ ...wiring, [key]: Number.isFinite(value as number) ? value : null });
        });
        const pin = headerPin(typeof current === 'number' ? current : null);
        const badge = element(
            'span',
            'pin-header',
            current === null ? '' : pin === null ? '—' : `PIN ${pin}`,
        );
        if (current !== null && pin === null) {
            badge.title = 'Not brought out on the module: the wireless chip and the on-board LED own this GPIO.';
        }
        const pair = element('span', 'pin-field');
        pair.append(input);
        pair.append(badge);
        return field(`${label} GPIO`, pair, 'field', help);
    };

    // One row per signal. `null` is a real answer -- "not wired" -- so an empty box means exactly that.
    const rows: Array<{ key: keyof PanelWiring; label: string; help?: string }> = [
        {
            key: 'sclk',
            label: 'SCK',
            help:
                'Panel SPI clock: 18 or 2 on SPI0, 10 or 14 on SPI1. The bus list above plans it together with ' +
                'the rest of its group.',
        },
        { key: 'mosi', label: 'MOSI', help: 'Panel SPI data out.' },
        { key: 'miso', label: 'MISO', help: 'Panel SPI data in. Needed by touch, and by a card on this bus.' },
        { key: 'cs', label: 'CS', help: 'Panel chip select.' },
        { key: 'dc', label: 'DC', help: 'Panel data/command.' },
        { key: 'rst', label: 'RESET', help: 'Panel reset. Leave empty when the module ties it to the board reset.' },
        { key: 'backlight', label: 'BL', help: 'Backlight pin. Leave empty when the module leaves BL unconnected.' },
        { key: 'touchCs', label: 'Touch CS', help: 'XPT2046 chip select.' },
        { key: 'touchIrq', label: 'Touch IRQ', help: 'XPT2046 interrupt, pulled up.' },
        { key: 'sdSclk', label: 'Card SCK', help: 'The socket\'s own clock, when it has its own pins.' },
        { key: 'sdMosi', label: 'Card MOSI', help: 'The socket\'s data out.' },
        { key: 'sdMiso', label: 'Card MISO', help: 'The socket\'s data in.' },
        { key: 'sdCs', label: 'Card CS', help: 'Empty means no card is used.' },
    ];
    for (const row of rows) {
        node.append(pinRow(row.label, row.key, row.help ?? ''));
    }

    const activeLow = element('input');
    activeLow.type = 'checkbox';
    activeLow.checked = wiring.backlightActiveLow;
    activeLow.addEventListener('change', () => {
        callbacks.onWiring({ ...wiring, backlightActiveLow: activeLow.checked });
    });
    node.append(field('BL active low', activeLow, 'field', 'Tick when the backlight transistor switches on with a LOW level.'));

    // The time source is a project setting rather than a pin, but it is the other thing the firmware is
    // compiled for. A battery-backed module is not implemented yet, so it is not offered.
    if (hardware.wireless) {
        const timeSelect = element('select', 'field-input');
        for (const [value, label] of [
            ['wifi', 'Wi-Fi (SNTP at boot)'],
            ['flash', 'The time it was flashed'],
        ] as const) {
            const option = element('option');
            option.value = value;
            option.textContent = label;
            if (value === wiring.timeSource) {
                option.selected = true;
            }
            timeSelect.append(option);
        }
        timeSelect.addEventListener('change', () => {
            const value = timeSelect.value === 'flash' ? 'flash' : 'wifi';
            callbacks.onWiring({ ...wiring, timeSource: value });
        });
        node.append(field('Clock', timeSelect, 'field', 'Where a clock design gets its time.'));
    } else {
        node.append(field('Clock', element('span', 'field-static', 'set when the board is flashed'), 'field'));
    }

    if (module !== undefined) {
        node.append(
            field('Glass', element('span', 'field-static', `${module.width}x${module.height}, ${module.colorOrder.toUpperCase()}`), 'field'),
        );
    }

    const errors = hardware.problems.filter((problem) => problem.severity === 'error');
    const warnings = hardware.problems.filter((problem) => problem.severity === 'warning');
    for (const problem of [...errors, ...warnings]) {
        node.append(
            element(
                'p',
                problem.severity === 'error' ? 'panel-note panel-note-blocked' : 'panel-note',
                problem.message,
            ),
        );
    }
    if (errors.length > 0) {
        node.append(
            element(
                'p',
                'panel-note',
                'While a pin above is wrong, src/panel.rs keeps the last wiring that worked -- fix the number and ' +
                'the firmware follows.',
            ),
        );
    }
    return node;
}
