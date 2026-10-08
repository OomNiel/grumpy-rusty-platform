/**
 * The widget catalogue the designer's Toolbox and property panel are built from.
 *
 * Where this comes from: `embedded-gui` 0.2.7 draws the panels, and `embedded-gui-codegen` 0.2.7 parses the
 * KDL the designer emits. This table was read off the parser, not off documentation -- the tag list is the
 * match arms of `parse_widget` in `embedded-gui-codegen-0.2.7/src/parser.rs`, every property name is a
 * `get_*_prop(node, "...")` call inside those arms, and every `defaultValue` is that call's own `unwrap_or`.
 * Getting them from the source matters more here than usual: a default that disagrees with the parser is not
 * a cosmetic difference, it is markup that builds to different pixels than the canvas showed.
 *
 * The tags that read child nodes (`dropdown`, `roller`, `carousel`, `table`, `icon`) carry a `children`
 * grammar. Two of them are not optional in practice: an `icon` with no `part` child fails codegen outright
 * (`parser.rs` returns `MissingAttribute`), and an `image` or `mesh` with no `src` does too, which is why
 * those properties are marked `required`.
 *
 * The aliases matter even though the designer always emits the canonical tag: the crate's serializer writes
 * whichever spelling it parsed, so a hand-edited `.kdl` may use either, and anything reading markup back has
 * to accept both.
 *
 * No `vscode` import and no `fs` import, so the t1 layer can test the catalogue as plain data.
 */

import { NAMED_STYLES } from './appearance';
import type { FontSupport } from './fonts';

/**
 * The kinds a property can take, which is what decides the editor the property panel shows.
 *
 * `font` is its own kind rather than a `text` or an `asset` field because a widget does not name a font
 * *file*: it names either a font the screen declared or one the crate ships. The panel therefore offers the
 * declared names and the built-ins together, and the emitter picks the route each one needs -- see
 * `src/designer/fonts.ts` for why they are not the same attribute.
 */
export type KdlPropertyKind =
    | 'text'
    | 'int'
    | 'float'
    | 'bool'
    | 'color'
    | 'enum'
    | 'asset'
    | 'font'
    | 'style';

export interface KdlProperty {
    /** The KDL attribute name, exactly as the parser reads it. */
    name: string;
    kind: KdlPropertyKind;
    /** What the property panel calls it. */
    label: string;
    /** What a freshly dropped widget gets, so the markup is always complete enough to build. */
    defaultValue: string | number | boolean;
    min?: number;
    max?: number;
    options?: readonly string[];
    /** True when the parser errors without it, e.g. an image's `src`. */
    required?: boolean;
    /**
     * True when the parser reads the property but the generator throws it away.
     *
     * The shapes are why this exists. `embedded-gui-codegen` emits
     * `gui.add_panel(cells[i], Style::panel())` for a `rect` or a `circle` and mentions the shape's own
     * radius and stroke width only in a trailing comment, and a `line` becomes a `spacer`. So the canvas
     * must not paint a fill the board will not paint: a designer that shows a red rectangle over a
     * theme-coloured panel is lying about the one thing it exists to show.
     */
    ignoredByCodegen?: boolean;
}

/**
 * Which child grammar a widget's body uses, if any.
 *
 * `options` covers the `option "text"` children that dropdown, roller and carousel share; `table` is the
 * `headers "a" "b"` plus `row "1" "2"` pair; `parts` is the composite icon's `part src="..."`.
 */
export type ChildGrammar = 'options' | 'table' | 'parts';

/**
 * The events a widget can raise.
 *
 * These are the designer's names; `variant` in `EVENT_SPECS` is the `UiEvent` variant from
 * `embedded-gui-0.2.7/src/input.rs` that carries the same thing, so the dispatch loop the extension
 * generates cannot drift from the list the property panel offers.
 */
export type DesignerEvent =
    | 'clicked'
    | 'pressed'
    | 'released'
    | 'doubleClicked'
    | 'longPressed'
    | 'valueChanged'
    | 'scroll'
    | 'opened'
    | 'closed'
    | 'textInput';

export interface DesignerEventSpec {
    /** The `UiEvent` variant that carries it. */
    variant: string;
    /**
     * How the variant is matched, with the widget id bound to `id`.
     *
     * Two variants are not newtypes: `Scroll` carries a delta and `TextInput` a character, so the match
     * pattern has fields rather than a single binding. Generated code that assumed `Variant(id)` everywhere
     * would fail to compile on exactly those two, which is the sort of thing worth writing down once.
     */
    pattern: string;
    /** Anything the variant carries besides the widget id. */
    parameter?: { name: string; type: string };
    /** What the handler is called, appended to `on_<widget>_`. */
    suffix: string;
}

/**
 * The event vocabulary, taken from `UiEvent` rather than invented.
 *
 * Only the variants naming a single widget are here: `FocusChanged` carries two ids and no widget of its
 * own, `Activate`/`Back` are navigation rather than a widget event, and `PointerPressed`/`PointerReleased`
 * are the raw touch phases whose `Pressed`/`Released` counterparts are what a widget reports.
 */
export const EVENT_SPECS: Record<DesignerEvent, DesignerEventSpec> = {
    clicked: { variant: 'Clicked', pattern: 'Clicked(id)', suffix: 'clicked' },
    pressed: { variant: 'Pressed', pattern: 'Pressed(id)', suffix: 'pressed' },
    released: { variant: 'Released', pattern: 'Released(id)', suffix: 'released' },
    doubleClicked: { variant: 'DoubleClicked', pattern: 'DoubleClicked(id)', suffix: 'double_clicked' },
    longPressed: { variant: 'LongPressed', pattern: 'LongPressed(id)', suffix: 'long_pressed' },
    valueChanged: { variant: 'ValueChanged', pattern: 'ValueChanged(id)', suffix: 'value_changed' },
    scroll: {
        variant: 'Scroll',
        pattern: 'Scroll { id, delta }',
        suffix: 'scroll',
        parameter: { name: 'delta', type: 'i32' },
    },
    opened: { variant: 'Opened', pattern: 'Opened(id)', suffix: 'opened' },
    closed: { variant: 'Closed', pattern: 'Closed(id)', suffix: 'closed' },
    textInput: {
        variant: 'TextInput',
        pattern: 'TextInput { id, ch }',
        suffix: 'text_input',
        parameter: { name: 'ch', type: 'char' },
    },
};

/** The order events are offered in, so the property panel and the golden markup stay stable. */
export const DESIGNER_EVENTS: DesignerEvent[] = [
    'clicked',
    'pressed',
    'released',
    'doubleClicked',
    'longPressed',
    'valueChanged',
    'scroll',
    'textInput',
    'opened',
    'closed',
];

/** Toolbox grouping. Purely presentational, but it keeps thirty tags navigable. */
export type KdlCategory = 'text' | 'input' | 'value' | 'container' | 'media' | 'shape';

export const CATEGORY_LABELS: Record<KdlCategory, string> = {
    text: 'Text',
    input: 'Input',
    value: 'Values and gauges',
    container: 'Containers',
    media: 'Media and 3D',
    shape: 'Shapes',
};

export interface KdlWidgetSpec {
    /** The tag the designer emits. */
    tag: string;
    /** Spellings the parser accepts for the same widget. */
    aliases: readonly string[];
    label: string;
    category: KdlCategory;
    /** What a dropped widget measures before the user resizes it. */
    defaultSize: { width: number; height: number };
    /** The child grammar, when the parser reads one. */
    children?: ChildGrammar;
    /** True when the parser rejects the widget with no children, which only the composite icon does. */
    requiresChildren?: boolean;
    /**
     * True when the widget survives codegen with an id, so firmware can name it.
     *
     * Only the spacer is not addressable: `parse_widget` builds `WidgetDef::Spacer` with no id at all, so
     * the generated `Widgets` struct has no field for it and `absolute_rect` can never be asked about it.
     * It still occupies its cells and still draws nothing, which is what a spacer is for -- but anything
     * expecting to look it up by id, events included, has to know it cannot be found.
     */
    addressable?: boolean;
    /**
     * What the widget actually draws on the board, which is not always what its properties suggest.
     *
     * `widget` is the honest case: the parser's properties reach the emitted widget. `panel` means the
     * generator emits a theme-styled panel regardless of the shape's own colours. `nothing` means the tag
     * reserves its space and paints none of it. Measured from `emitter.rs`, not assumed.
     */
    draws?: 'widget' | 'panel' | 'nothing';
    /** A caveat the properties panel shows, for tags whose behaviour is not obvious from their properties. */
    note?: string;
    /**
     * How this widget can be given a font, when it can: the crate reads a declared `font="name"` for labels
     * and carousels, and a `style` expression for labels, buttons, tables and carousels. Omitted when the
     * widget is drawn wholly from the theme and neither route reaches it, which the properties panel then
     * simply does not offer.
     */
    fontSupport?: FontSupport;
    props: readonly KdlProperty[];
    events: readonly DesignerEvent[];
}

/**
 * The crate's named base styles, for the widgets whose emitter honours one.
 *
 * A closed set rather than a text box, because the resolver passes an unknown name through **verbatim as Rust**:
 * a typo would not be ignored, it would be compiled. See `./appearance` for what each name resolves to.
 */
const STYLE_PROPERTY: KdlProperty = {
    name: 'style',
    kind: 'style',
    label: 'Style',
    defaultValue: '',
    options: NAMED_STYLES.map((style) => style.id),
};

/** The colour pairs a clickable widget carries, with the parser's own defaults where it has none. */
const CLICKABLE_COLOURS: KdlProperty[] = [
    { name: 'bg', kind: 'color', label: 'Background', defaultValue: '#3a6ea5' },
    { name: 'fg', kind: 'color', label: 'Foreground', defaultValue: '#f0f0f0' },
    { name: 'text_color', kind: 'color', label: 'Label colour', defaultValue: '#ffffff' },
    { name: 'pressed_bg', kind: 'color', label: 'Pressed background', defaultValue: '#2a5a8a' },
    { name: 'pressed_fg', kind: 'color', label: 'Pressed foreground', defaultValue: '#ffffff' },
    { name: 'disabled_bg', kind: 'color', label: 'Disabled background', defaultValue: '#303030' },
    { name: 'disabled_fg', kind: 'color', label: 'Disabled foreground', defaultValue: '#808080' },
    { name: 'focused_bg', kind: 'color', label: 'Focused background', defaultValue: '#4a7eb5' },
    { name: 'focused_fg', kind: 'color', label: 'Focused foreground', defaultValue: '#ffffff' },
    { name: 'border_color', kind: 'color', label: 'Border', defaultValue: '#101010' },
    { name: 'corner_radius', kind: 'int', label: 'Corner radius', defaultValue: 4, min: 0, max: 64 },
];

/** The option list a dropdown, roller or carousel starts with. */
export const DEFAULT_OPTIONS: readonly string[] = ['One', 'Two', 'Three'];

/** The table a dropped table starts as. */
export const DEFAULT_TABLE_HEADERS: readonly string[] = ['Name', 'Value'];
export const DEFAULT_TABLE_ROWS: readonly (readonly string[])[] = [
    ['A', '1'],
    ['B', '2'],
];

/**
 * The thirty tags the parser accepts, with the properties and defaults it reads for each.
 *
 * Ordered by category and then by how likely a hand reaches for it, because that is the order the Toolbox
 * lists them in.
 */
export const KDL_WIDGETS: readonly KdlWidgetSpec[] = [
    {
        tag: 'label',
        aliases: ['banner'],
        label: 'Label',
        category: 'text',
        defaultSize: { width: 96, height: 24 },
        props: [
            { name: 'text', kind: 'text', label: 'Text', defaultValue: 'Label' },
            { name: 'font', kind: 'font', label: 'Font', defaultValue: '' },
            STYLE_PROPERTY,
        ],
        fontSupport: 'both',
        events: [],
    },
    {
        tag: 'button',
        aliases: [],
        label: 'Button',
        category: 'input',
        defaultSize: { width: 96, height: 32 },
        note:
            'The background colours reach the widget but are painted over: the crate\'s default button ' +
            'style carries a vertical gradient that no markup attribute can clear, so the visible fill ' +
            'comes from the theme. Measured in the simulator, not assumed.',
        props: [
            { name: 'text', kind: 'text', label: 'Text', defaultValue: 'Button' },
            { name: 'font', kind: 'font', label: 'Font', defaultValue: '' },
            STYLE_PROPERTY,
            ...CLICKABLE_COLOURS,
        ],
        fontSupport: 'style',
        events: ['clicked', 'pressed', 'released', 'doubleClicked', 'longPressed'],
    },
    {
        tag: 'toggle',
        aliases: [],
        label: 'Toggle',
        category: 'input',
        defaultSize: { width: 64, height: 28 },
        props: [
            { name: 'label', kind: 'text', label: 'Label', defaultValue: 'Toggle' },
            { name: 'checked', kind: 'bool', label: 'Checked', defaultValue: false },
        ],
        events: ['valueChanged', 'clicked'],
    },
    {
        tag: 'checkbox',
        aliases: [],
        label: 'Checkbox',
        category: 'input',
        defaultSize: { width: 96, height: 24 },
        props: [
            { name: 'label', kind: 'text', label: 'Label', defaultValue: 'Checkbox' },
            { name: 'checked', kind: 'bool', label: 'Checked', defaultValue: false },
        ],
        events: ['valueChanged', 'clicked'],
    },
    {
        tag: 'slider',
        aliases: [],
        label: 'Slider',
        category: 'input',
        defaultSize: { width: 160, height: 28 },
        props: [
            { name: 'min', kind: 'int', label: 'Minimum', defaultValue: 0 },
            { name: 'max', kind: 'int', label: 'Maximum', defaultValue: 100 },
            { name: 'value', kind: 'int', label: 'Value', defaultValue: 0 },
        ],
        events: ['valueChanged', 'pressed', 'released'],
    },
    {
        tag: 'dropdown',
        aliases: [],
        label: 'Dropdown',
        category: 'input',
        defaultSize: { width: 120, height: 28 },
        children: 'options',
        props: [{ name: 'selected', kind: 'int', label: 'Selected index', defaultValue: 0, min: 0 }],
        events: ['valueChanged'],
    },
    {
        tag: 'roller',
        aliases: [],
        label: 'Roller',
        category: 'input',
        defaultSize: { width: 80, height: 80 },
        children: 'options',
        props: [{ name: 'selected', kind: 'int', label: 'Selected index', defaultValue: 0, min: 0 }],
        events: ['valueChanged', 'scroll'],
    },
    {
        tag: 'spinbox',
        aliases: [],
        label: 'Spinbox',
        category: 'input',
        defaultSize: { width: 96, height: 28 },
        props: [
            { name: 'min', kind: 'int', label: 'Minimum', defaultValue: 0 },
            { name: 'max', kind: 'int', label: 'Maximum', defaultValue: 9999 },
            { name: 'value', kind: 'int', label: 'Value', defaultValue: 0 },
            { name: 'digits', kind: 'int', label: 'Digits', defaultValue: 4, min: 1, max: 10 },
            { name: 'decimals', kind: 'int', label: 'Decimals', defaultValue: 0, min: 0, max: 6 },
        ],
        events: ['valueChanged'],
    },
    {
        tag: 'number_picker',
        aliases: [],
        label: 'Number picker',
        category: 'input',
        defaultSize: { width: 96, height: 28 },
        props: [
            { name: 'min', kind: 'int', label: 'Minimum', defaultValue: 0 },
            { name: 'max', kind: 'int', label: 'Maximum', defaultValue: 100 },
            { name: 'value', kind: 'int', label: 'Value', defaultValue: 0 },
            { name: 'unit', kind: 'text', label: 'Unit', defaultValue: '' },
        ],
        events: ['valueChanged'],
    },
    {
        tag: 'time_picker',
        aliases: [],
        label: 'Time picker',
        category: 'input',
        defaultSize: { width: 120, height: 32 },
        props: [
            { name: 'hour', kind: 'int', label: 'Hour', defaultValue: 12, min: 0, max: 23 },
            { name: 'minute', kind: 'int', label: 'Minute', defaultValue: 0, min: 0, max: 59 },
            { name: 'is_12h', kind: 'bool', label: '12-hour clock', defaultValue: true },
            { name: 'is_pm', kind: 'bool', label: 'PM', defaultValue: false },
        ],
        events: ['valueChanged'],
    },
    {
        tag: 'progress',
        aliases: ['progress_bar'],
        label: 'Progress bar',
        category: 'value',
        defaultSize: { width: 160, height: 20 },
        props: [{ name: 'value', kind: 'float', label: 'Value', defaultValue: 0 }],
        events: [],
    },
    {
        tag: 'scale',
        aliases: ['gauge'],
        label: 'Gauge',
        category: 'value',
        defaultSize: { width: 96, height: 96 },
        props: [
            {
                name: 'mode',
                kind: 'enum',
                label: 'Mode',
                defaultValue: 'radial',
                options: ['radial', 'linear_vertical', 'linear_horizontal'],
            },
            { name: 'min', kind: 'float', label: 'Minimum', defaultValue: 0 },
            { name: 'max', kind: 'float', label: 'Maximum', defaultValue: 100 },
            { name: 'value', kind: 'float', label: 'Value', defaultValue: 0 },
            { name: 'major_ticks', kind: 'int', label: 'Major ticks', defaultValue: 5, min: 1, max: 255 },
            { name: 'minor_ticks', kind: 'int', label: 'Minor ticks', defaultValue: 2, min: 1, max: 255 },
        ],
        events: ['valueChanged'],
    },
    {
        tag: 'arc',
        aliases: ['sweeping_arc'],
        label: 'Sweeping arc',
        category: 'value',
        defaultSize: { width: 96, height: 96 },
        props: [
            { name: 'start_angle', kind: 'int', label: 'Start angle', defaultValue: 0, min: -32768, max: 32767 },
            { name: 'end_angle', kind: 'int', label: 'End angle', defaultValue: 270, min: -32768, max: 32767 },
        ],
        events: [],
    },
    {
        tag: 'busy_wheel',
        aliases: ['spinner'],
        label: 'Busy wheel',
        category: 'value',
        defaultSize: { width: 48, height: 48 },
        props: [{ name: 'active', kind: 'bool', label: 'Spinning', defaultValue: true }],
        events: [],
    },
    {
        tag: 'chart',
        aliases: ['plotter'],
        label: 'Chart',
        category: 'value',
        defaultSize: { width: 160, height: 96 },
        props: [
            { name: 'mode', kind: 'enum', label: 'Mode', defaultValue: 'line', options: ['line', 'bar'] },
        ],
        events: [],
    },
    {
        tag: 'status_bar',
        aliases: [],
        label: 'Status bar',
        category: 'value',
        defaultSize: { width: 240, height: 24 },
        props: [{ name: 'time', kind: 'text', label: 'Time', defaultValue: '12:00' }],
        events: [],
    },
    {
        tag: 'content_indicator',
        aliases: [],
        label: 'Content indicator',
        category: 'value',
        defaultSize: { width: 72, height: 16 },
        props: [
            { name: 'count', kind: 'int', label: 'Count', defaultValue: 3, min: 1, max: 255 },
            { name: 'active', kind: 'int', label: 'Active index', defaultValue: 0, min: 0, max: 255 },
        ],
        events: [],
    },
    {
        tag: 'crumbs',
        aliases: ['crumbs_indicator'],
        label: 'Crumbs indicator',
        category: 'value',
        defaultSize: { width: 72, height: 16 },
        props: [
            { name: 'count', kind: 'int', label: 'Count', defaultValue: 3, min: 1, max: 255 },
            { name: 'active', kind: 'int', label: 'Active index', defaultValue: 0, min: 0, max: 255 },
        ],
        events: [],
    },
    {
        tag: 'panel',
        aliases: ['card'],
        label: 'Panel',
        category: 'container',
        defaultSize: { width: 160, height: 96 },
        // A panel's whole appearance comes from its style, and its emitter reads one -- so this is the only
        // appearance property it has, and the reason the base styles are worth offering at all.
        props: [STYLE_PROPERTY],
        events: [],
    },
    {
        tag: 'dialog',
        aliases: [],
        label: 'Dialog',
        category: 'container',
        defaultSize: { width: 240, height: 120 },
        props: [
            { name: 'title', kind: 'text', label: 'Title', defaultValue: 'Alert' },
            { name: 'message', kind: 'text', label: 'Message', defaultValue: '' },
            {
                name: 'type',
                kind: 'enum',
                label: 'Type',
                defaultValue: 'info',
                // The parser keeps any string; the palette maps the warning spellings to yellow.
                options: ['info', 'warning', 'error'],
            },
        ],
        events: ['opened', 'closed'],
    },
    {
        tag: 'table',
        aliases: [],
        label: 'Table',
        category: 'container',
        defaultSize: { width: 240, height: 120 },
        children: 'table',
        // No Font property: the table's emitter arm hard-codes `Style::panel()` and drops any `style` the
        // markup carries, so there is no route to a font for it at all. Offering one would be a field that
        // does nothing, which is the trap this catalogue exists to avoid.
        note: 'A table is drawn with the panel style and its own cells; the markup has no handle for its appearance.',
        props: [],
        events: ['scroll'],
    },
    {
        tag: 'carousel',
        aliases: [],
        label: 'Carousel',
        category: 'container',
        defaultSize: { width: 200, height: 80 },
        children: 'options',
        props: [
            { name: 'selected', kind: 'int', label: 'Selected index', defaultValue: 0, min: 0 },
            { name: 'item_step', kind: 'int', label: 'Item step', defaultValue: 16, min: 1, max: 255 },
            { name: 'visible', kind: 'int', label: 'Visible items', defaultValue: 7, min: 1, max: 31 },
            { name: 'shift', kind: 'int', label: 'Shift', defaultValue: 0, min: -4096, max: 4096 },
            { name: 'mask_top', kind: 'int', label: 'Top mask', defaultValue: 0, min: 0, max: 4096 },
            { name: 'mask_bottom', kind: 'int', label: 'Bottom mask', defaultValue: 0, min: 0, max: 4096 },
            { name: 'fade', kind: 'bool', label: 'Fade edges', defaultValue: true },
            { name: 'indicator', kind: 'bool', label: 'Show indicator', defaultValue: false },
            { name: 'pulse', kind: 'int', label: 'Pulse', defaultValue: 255, min: 0, max: 255 },
            { name: 'font', kind: 'font', label: 'Font', defaultValue: '' },
            STYLE_PROPERTY,
        ],
        fontSupport: 'both',
        events: ['valueChanged', 'scroll'],
    },
    {
        tag: 'image',
        aliases: ['bitmap'],
        label: 'Image',
        category: 'media',
        defaultSize: { width: 96, height: 96 },
        props: [
            { name: 'src', kind: 'asset', label: 'Asset', defaultValue: '', required: true },
            {
                name: 'fit',
                kind: 'enum',
                label: 'Fit',
                // The palette knows exactly two: "center" or anything else, which is Stretch.
                defaultValue: 'stretch',
                options: ['stretch', 'center'],
            },
            { name: 'mode', kind: 'text', label: 'Mode', defaultValue: 'color' },
            { name: 'tint', kind: 'color', label: 'Tint', defaultValue: '' },
        ],
        events: [],
    },
    {
        tag: 'icon',
        aliases: ['composite_icon'],
        label: 'Composite icon',
        category: 'media',
        defaultSize: { width: 48, height: 48 },
        children: 'parts',
        requiresChildren: true,
        props: [
            { name: 'scale', kind: 'int', label: 'Scale', defaultValue: 1, min: 1, max: 16 },
            {
                name: 'align',
                kind: 'enum',
                label: 'Align',
                // Only two exist in the palette: "top_left" or anything else, which is Center.
                defaultValue: 'center',
                options: ['center', 'top_left'],
            },
            { name: 'tint', kind: 'color', label: 'Tint', defaultValue: '' },
            { name: 'threshold', kind: 'int', label: 'Threshold', defaultValue: 128, min: 0, max: 255 },
            { name: 'invert', kind: 'bool', label: 'Invert', defaultValue: false },
        ],
        events: [],
    },
    {
        tag: 'mesh',
        aliases: ['mesh3d'],
        label: '3D mesh',
        category: 'media',
        defaultSize: { width: 160, height: 120 },
        note: 'Reserves its rect and builds a mesh panel, but the app has to draw it with render_mesh_panel.',
        props: [
            { name: 'src', kind: 'asset', label: 'Asset', defaultValue: '', required: true },
            {
                name: 'shading',
                kind: 'enum',
                label: 'Shading',
                defaultValue: 'solid',
                options: ['solid', 'points', 'lines', 'lit'],
            },
            { name: 'color', kind: 'color', label: 'Colour', defaultValue: '#c0c0c0' },
            { name: 'scale', kind: 'float', label: 'Scale', defaultValue: 1 },
            { name: 'roll', kind: 'float', label: 'Roll', defaultValue: 0 },
            { name: 'pitch', kind: 'float', label: 'Pitch', defaultValue: 0 },
            { name: 'yaw', kind: 'float', label: 'Yaw', defaultValue: 0 },
            { name: 'camera_distance', kind: 'float', label: 'Camera distance', defaultValue: 4 },
            { name: 'fov', kind: 'float', label: 'Field of view', defaultValue: 60 },
        ],
        events: [],
    },
    {
        tag: 'spacer',
        aliases: [],
        label: 'Spacer',
        category: 'shape',
        defaultSize: { width: 32, height: 32 },
        // The one tag whose id the parser drops on the floor; see `addressable`.
        addressable: false,
        draws: 'nothing',
        note: 'Reserves its space and draws nothing, and has no id in the generated code.',
        props: [],
        events: [],
    },
    {
        tag: 'rect',
        aliases: ['rectangle'],
        label: 'Rectangle',
        category: 'shape',
        defaultSize: { width: 96, height: 48 },
        draws: 'panel',
        note: 'Drawn as a theme-styled panel: the generator ignores this shape\'s own fill, stroke and corners.',
        props: [
            { name: 'radius', kind: 'int', label: 'Corner radius', defaultValue: 0, min: 0, max: 64, ignoredByCodegen: true },
            { name: 'stroke_width', kind: 'int', label: 'Stroke width', defaultValue: 0, min: 0, max: 32, ignoredByCodegen: true },
            { name: 'fill', kind: 'color', label: 'Fill', defaultValue: '#3a6ea5', ignoredByCodegen: true },
            { name: 'stroke', kind: 'color', label: 'Stroke', defaultValue: '#ffffff', ignoredByCodegen: true },
        ],
        events: [],
    },
    {
        tag: 'line',
        aliases: [],
        label: 'Line',
        category: 'shape',
        defaultSize: { width: 96, height: 8 },
        draws: 'nothing',
        note: 'The generator emits a spacer: a line reserves its space and draws none of it.',
        props: [
            { name: 'stroke_width', kind: 'int', label: 'Stroke width', defaultValue: 1, min: 1, max: 32, ignoredByCodegen: true },
            { name: 'color', kind: 'color', label: 'Colour', defaultValue: '#ffffff', ignoredByCodegen: true },
        ],
        events: [],
    },
    {
        tag: 'circle',
        aliases: [],
        label: 'Circle',
        category: 'shape',
        defaultSize: { width: 64, height: 64 },
        draws: 'panel',
        note: 'Drawn as a theme-styled panel: the generator ignores this shape\'s own fill, stroke and radius.',
        props: [
            { name: 'radius', kind: 'int', label: 'Radius', defaultValue: 32, min: 1, max: 240, ignoredByCodegen: true },
            { name: 'stroke_width', kind: 'int', label: 'Stroke width', defaultValue: 0, min: 0, max: 32, ignoredByCodegen: true },
            { name: 'fill', kind: 'color', label: 'Fill', defaultValue: '#3a6ea5', ignoredByCodegen: true },
            { name: 'stroke', kind: 'color', label: 'Stroke', defaultValue: '#ffffff', ignoredByCodegen: true },
        ],
        events: [],
    },
    {
        tag: 'path',
        aliases: ['vector_path'],
        label: 'Vector path',
        category: 'shape',
        defaultSize: { width: 96, height: 96 },
        props: [
            { name: 'stroke_width', kind: 'int', label: 'Stroke width', defaultValue: 1, min: 1, max: 32 },
            // The SVG path data the parser turns into verbs; free text, since it is a mini-language.
            { name: 'd', kind: 'text', label: 'Path data', defaultValue: 'M 0 0 L 32 32 Z' },
        ],
        events: [],
    },
];

/** Lookup by the tag the designer emits or by any alias the parser accepts. */
const WIDGET_BY_TAG = new Map<string, KdlWidgetSpec>();
for (const widget of KDL_WIDGETS) {
    WIDGET_BY_TAG.set(widget.tag, widget);
    for (const alias of widget.aliases) {
        WIDGET_BY_TAG.set(alias, widget);
    }
}

export function widgetSpec(tag: string): KdlWidgetSpec | undefined {
    return WIDGET_BY_TAG.get(tag);
}

/** The widgets, grouped for the Toolbox, in catalogue order and without the empty groups. */
export function toolboxGroups(): { category: KdlCategory; label: string; widgets: KdlWidgetSpec[] }[] {
    const categories: KdlCategory[] = ['text', 'input', 'value', 'container', 'media', 'shape'];
    const groups = categories.map((category) => ({
        category,
        label: CATEGORY_LABELS[category],
        widgets: KDL_WIDGETS.filter((widget) => widget.category === category),
    }));
    return groups.filter((group) => group.widgets.length > 0);
}

/** True when the widget raises the event, which is what decides whether the property panel offers it. */
export function widgetRaises(tag: string, event: DesignerEvent): boolean {
    const spec = widgetSpec(tag);
    return spec !== undefined && spec.events.includes(event);
}

/** True when the property cannot be left empty, because the parser errors on a widget without it. */
export function propertyRequired(tag: string, property: string): boolean {
    return widgetSpec(tag)?.props.some((candidate) => candidate.name === property && candidate.required === true) === true;
}

/**
 * True when the generated `Widgets` struct will carry a field for this tag.
 *
 * Everything is addressable except the spacer, whose id the parser discards. A caller that wants to look a
 * widget up by id -- the event dispatch and the simulator's measurement both do -- has to skip the rest.
 */
export function widgetAddressable(tag: string): boolean {
    return widgetSpec(tag)?.addressable !== false;
}

/**
 * One line of help per property, shown as a tooltip on the field.
 *
 * Keyed by property name because most of them mean the same thing wherever they appear; the ones that do not
 * are in `TAG_PROPERTY_HELP` below. A test asserts that every property of every tag resolves one of these, so
 * a new property cannot arrive without help.
 */
const PROPERTY_HELP: Record<string, string> = {
    active: 'Whether the spinner is turning',
    align: 'Where the parts sit inside the widget',
    bg: 'Background colour',
    border_color: 'Colour of the border',
    camera_distance: 'How far the camera sits from the model',
    checked: 'Whether it starts switched on',
    color: 'Colour to draw it in',
    corner_radius: 'How round the corners are, in pixels',
    count: 'How many items there are to mark',
    d: 'SVG path data, e.g. "M 0 0 L 32 32 Z"',
    decimals: 'Digits after the decimal point',
    digits: 'How many digits to show, including the sign',
    disabled_bg: 'Background while it cannot be used',
    disabled_fg: 'Foreground while it cannot be used',
    end_angle: 'Where the arc stops, in degrees clockwise from the top',
    fade: 'Whether the items fade out towards the edges',
    fg: 'Foreground colour',
    fill: 'Fill colour',
    fit: 'How the image is fitted into its box',
    focused_bg: 'Background while it has focus',
    focused_fg: 'Foreground while it has focus',
    font:
        'A font for the text: one the crate ships, or one this screen declares under Fonts. The two travel ' +
        'by different markup, and only some widgets read either',
    fov: 'Field of view, in degrees',
    hour: 'Hour of the day',
    indicator: 'Whether the position indicator is shown',
    invert: 'Draw the glyph inverted',
    is_12h: 'Use a 12-hour clock',
    is_pm: 'Whether it is the afternoon',
    item_step: 'Pixels between one item and the next',
    label: 'Text shown beside the control',
    major_ticks: 'How many long tick marks to draw',
    mask_bottom: 'How many pixels to fade at the bottom edge',
    mask_top: 'How many pixels to fade at the top edge',
    max: 'Largest value it accepts',
    message: 'The body text',
    min: 'Smallest value it accepts',
    minor_ticks: 'How many short ticks to draw between the long ones',
    minute: 'Minute of the hour',
    mode: 'How it is drawn',
    pitch: 'Tilt up or down, in degrees',
    pressed_bg: 'Background while it is pressed',
    pressed_fg: 'Foreground while it is pressed',
    pulse: 'Brightness of the highlight, from 0 to 255',
    roll: 'Rotation about the viewing axis, in degrees',
    selected: 'Index of the chosen item, counting from zero',
    shading: 'How the surfaces are shaded',
    shift: 'Scroll offset, in pixels',
    src: 'File to load, relative to the project root',
    start_angle: 'Where the arc starts, in degrees clockwise from the top',
    stroke: 'Outline colour',
    style:
        'A base look from the crate: plain, panel, progress or button. It carries the background, border, ' +
        'shadow and corner radius, so it is what gives a widget an appearance its own properties do not',
    stroke_width: 'Width of the outline, in pixels',
    text: 'The words it shows',
    text_color: 'Colour of the text drawn on it',
    threshold: 'Brightness at which a pixel counts as ink, from 0 to 255',
    time: 'The time it shows, as text',
    tint: 'Colour to draw it in',
    title: 'Heading text',
    type: 'Which kind of message it is',
    unit: 'Suffix shown after the number',
    value: 'The value it shows',
    visible: 'Whether this part is drawn',
    yaw: 'Rotation about the vertical axis, in degrees',
};

/** The properties whose meaning depends on the widget they belong to. */
const TAG_PROPERTY_HELP: Record<string, string> = {
    'scale.mode': 'A dial, or a bar that runs down or across',
    'chart.mode': 'A line through the points, or bars',
    'image.mode': 'How the pixels are interpreted, e.g. colour or monochrome',
    'rect.radius': 'Corner radius in pixels',
    'circle.radius': 'Radius in pixels',
    'icon.scale': 'How much to enlarge the glyph',
    'mesh.scale': 'Size of the model',
    'icon.align': 'Where the glyph sits inside the box',
    'mesh.color': 'Base colour of the model',
    'line.color': 'Colour of the line',
};

/** One line of help per widget, shown as a tooltip in the Toolbox. */
const WIDGET_HELP: Record<string, string> = {
    label: 'Plain text',
    button: 'A pressable button, with a click event',
    toggle: 'A switch that stays on or off',
    checkbox: 'A tick box with a label',
    slider: 'A value dragged between a minimum and a maximum',
    dropdown: 'A closed list that opens to choose one option',
    roller: 'A wheel of options',
    spinbox: 'A number with up and down steps',
    number_picker: 'A number with a unit after it',
    time_picker: 'An hour and a minute',
    progress: 'A bar that fills to show a value',
    scale: 'A gauge, as a dial or a bar',
    arc: 'A sweeping arc',
    busy_wheel: 'A spinner for work in progress',
    chart: 'A line or bar plot',
    status_bar: 'A strip with a clock',
    content_indicator: 'Dots showing where you are in a set',
    crumbs: 'A trail of position markers',
    panel: 'A surface to put things on',
    dialog: 'A message box with a heading',
    table: 'Rows and columns of text',
    carousel: 'A scrolling row of options',
    image: 'A bitmap from a file in the project',
    icon: 'A glyph drawn from one or more parts',
    mesh: 'A 3D model, which your own code draws',
    spacer: 'Reserves space and draws nothing at all',
    rect: 'A theme-styled panel: its own colours are ignored by the generator',
    line: 'Reserves space and draws nothing at all',
    circle: 'A theme-styled panel: its own colours are ignored by the generator',
    path: 'A vector outline built from SVG path data',
};

/** The help for one property of one widget, or `undefined` if it has none. */
export function propertyHelp(tag: string, property: string): string | undefined {
    return TAG_PROPERTY_HELP[`${tag}.${property}`] ?? PROPERTY_HELP[property];
}

/** The one-line description of a widget, for the Toolbox tooltip. */
export function widgetHelp(tag: string): string | undefined {
    return WIDGET_HELP[tag];
}
