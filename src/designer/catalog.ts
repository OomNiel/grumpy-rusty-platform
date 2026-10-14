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

import { NAMED_STYLES, type StyleField } from './appearance';
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
    /**
     * The `Style` field this property is written into, when the value does not travel as its own attribute but
     * is folded into the widget's `style` expression.
     *
     * A widget whose markup has no colour attribute of its own -- a label's text colour, a toggle's accent --
     * can still be given one, because the crate paints from the resolved `Style`: `style.text`, `style.accent`,
     * `style.background`, `style.border` and `style.corner_radius` are all `pub`. They have to be written into
     * the same expression that carries the base style and the font, since a widget can only have one `style`.
     *
     * The value is the field rather than a flag because the field is what the emitter has to name, and because
     * the canvas has to resolve the same overrides to stay WYSIWYG (see `src/designer/appearance.ts`).
     */
    viaStyle?: StyleField;
    /** The KDL attribute name, exactly as the parser reads it. */
    name: string;
    kind: KdlPropertyKind;
    /** What the property panel calls it. */
    label: string;
    /**
     * Properties that belong together, under one small heading in the Properties panel.
     *
     * The triangle's six vertex offsets are the reason this exists: they are one idea -- where the shape's
     * three points sit -- and six loose fields in a row would read as six unrelated numbers. The canvas
     * handles are the usual way to set them; the numbers are there to be exact, and to be editable without a
     * pointer.
     */
    group?: string;
    /** What a freshly dropped widget gets, so the markup is always complete enough to build. */
    defaultValue: string | number | boolean;
    min?: number;
    max?: number;
    options?: readonly string[];
    /** True when the parser errors without it, e.g. an image's `src`. */
    required?: boolean;
    /**
     * True when the value may be absent from a document, because the crate applies the same default.
     *
     * A triangle's six vertex offsets are the case: a design written before they existed -- or one hand-edited
     * to name only some of them -- is not an incomplete design, it is one using the crate's own default
     * triangle. The panel still writes them when the user drags a point, and `defaultProps` fills them in for
     * a widget dropped from the Toolbox, so a design the designer made always names all six.
     */
    optional?: boolean;
    /**
     * True when the property is still read but no longer offered.
     *
     * The checkbox's single `box_size` is the case: the box has a width and a height of its own now, and a
     * design written before that names `box_size`. Dropping it from the catalogue would turn every such design
     * into one with a property the validator does not know, so it stays -- accepted, emitted when it is
     * present, and left out of the panel and out of a newly dropped widget's defaults.
     */
    legacy?: boolean;
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
     * reserves its space and paints none of it. `circle`/`rectangle`/`line`/`triangle`/`path` mean the
     * designer paints the shape on the canvas for editing *and* the board renders the same primitive from the
     * cell rect (the designer prop names are mapped onto the codegen's attributes, and a path becomes a
     * `rusty-gui-widgets::VectorPath`). Measured from `emitter.rs`, not assumed.
     */
    draws?: 'widget' | 'panel' | 'nothing' | 'circle' | 'rectangle' | 'line' | 'triangle' | 'path';
    /**
     * True when this is a designer-native widget: the canvas paints it, but it is not emitted as KDL for the
     * crate, because there is no crate builder for it yet. The generated project still builds; the widget
     * simply does not reach the board until a widgets crate provides one.
     *
     * A `circle`, `rectangle`, `line` and `triangle` are no longer native: the `rusty-gui-widgets` crate
     * renders them from the cell rect, so the designer both paints them for editing and emits markup the
     * board draws. The flag now covers widgets that genuinely have no crate rendering at all.
     */
    native?: boolean;
    /** A caveat the properties panel shows, for tags whose behaviour is not obvious from their properties. */
    note?: string;
    /**
     * How this widget can be given a font, when it can: the crate reads a declared `font="name"` for labels
     * and carousels, and a `style` expression for labels, buttons, tables and carousels. Omitted when the
     * widget is drawn wholly from the theme and neither route reaches it, which the properties panel then
     * simply does not offer.
     */
    fontSupport?: FontSupport;
    /**
     * Why this tag cannot be used at all, when it cannot.
     *
     * Not a caveat about its looks -- that is `note` -- but a defect that makes the widget's generated code fail
     * to build. The catalogue still documents these tags, because they are part of the crate, but the Toolbox
     * does not offer them and validation refuses a design that contains one: a designer whose canvas promises
     * something the toolchain cannot produce is worse than one with fewer controls.
     *
     * The text is the reason, and it is shown to the user. See `NOTES.md` §100 for the evidence.
     */
    unavailable?: string;
    props: readonly KdlProperty[];
    events: readonly DesignerEvent[];
}

/**
 * The defect that makes a tag's generated code fail to build, quoted from the compiler.
 *
 * `embedded-gui-codegen` 0.2.7 and `embedded-gui` 0.2.7 do not agree with one another for ten of the tags it
 * parses: the emitter calls builder methods the runtime does not have, passes the wrong number or type of
 * arguments, or names types it never brings into scope. Each of those is a `cargo build` failure inside the
 * `include_gui!` macro, with no markup that can avoid it -- the call is written by the crate, not by us.
 *
 * Written once here because the ten vary only in which method and which error, and because the day the crate is
 * fixed all ten are deleted together.
 */
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

/**
 * The colour of a widget's text, for a widget the markup gives no colour attribute.
 *
 * Only offered where a style expression reaches the widget: the crate reads no colour property for a label, so
 * this is the one route to it, and it is the same route the font and base style take.
 */
const TEXT_COLOUR_PROPERTY: KdlProperty = {
    name: 'text_color',
    kind: 'color',
    label: 'Text colour',
    defaultValue: '',
    viaStyle: 'text',
};

/**
 * The surface a widget is painted on: its background, its border and its corners.
 *
 * These are `style.background`, `style.border` and `style.corner_radius`, which the crate's `Block` paints for
 * every widget it draws a block for -- so they reach the board for a tag whose markup has no colour attribute
 * of its own. A border *colour* is what asks for a border: the plain base style has a width of zero, so a
 * design that picked only a width would see nothing (see `resolveStyleValues`).
 */
const APPEARANCE_BLOCK: KdlProperty[] = [
    { name: 'bg', kind: 'color', label: 'Background', defaultValue: '', viaStyle: 'background' },
    { name: 'border_color', kind: 'color', label: 'Border colour', defaultValue: '', viaStyle: 'border' },
    {
        name: 'border_width',
        kind: 'int',
        label: 'Border width',
        defaultValue: 0,
        min: 0,
        max: 16,
        viaStyle: 'borderWidth',
    },
    {
        name: 'corner_radius',
        kind: 'int',
        label: 'Corner radius',
        defaultValue: 0,
        min: 0,
        max: 64,
        viaStyle: 'radius',
    },
];

/** The colour the widget's own contents are drawn in: a progress bar's fill, a slider's knob. */
const APPEARANCE_FILL: KdlProperty = {
    name: 'fg',
    kind: 'color',
    label: 'Fill',
    defaultValue: '',
    viaStyle: 'foreground',
};

/** The colour the crate calls the accent: a toggle that is on, a checkbox that is ticked, a chosen row. */
const APPEARANCE_ACCENT: KdlProperty = {
    name: 'accent',
    kind: 'color',
    label: 'Accent',
    defaultValue: '',
    viaStyle: 'accent',
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
/**
 * The heading the triangle's six vertex offsets share in the Properties panel.
 *
 * The unit is in the heading rather than in each of six labels, so the numbers read as a set of coordinates
 * ("Point 1 X" out of 1000) instead of as six magic values that happen to stop at a thousand.
 */
const TRIANGLE_POINTS_LABEL = 'Points (of 1000 across its box)';

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
            TEXT_COLOUR_PROPERTY,
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
        note:
            'A switch, drawn from its own colours. Its border is the widget\'s frame; the track itself has no ' +
            'outline in the crate.',
        props: [
            { name: 'label', kind: 'text', label: 'Label', defaultValue: 'Toggle' },
            { name: 'font', kind: 'font', label: 'Font', defaultValue: '' },
            { name: 'checked', kind: 'bool', label: 'Checked', defaultValue: false },
            APPEARANCE_ACCENT,
            // The track's colour while the switch is off. The crate hard-coded a near-black literal here, which
            // is why an off toggle is hard to see on a dark panel; the runtime fork reads this instead.
            // `#392852` is the crate's own off-track literal (`Rgb565::new(7, 10, 10)`) written as the
            // `#rrggbb` this field takes: the 5/6/5 reduction of it is exactly (7, 10, 10) again, so a design
            // that never touches this field renders the colour the crate always used.
            { name: 'off_color', kind: 'color', label: 'Off track', defaultValue: '#392852' },
            // The switch itself, as opposed to the frame `border_color` draws. A width of one by default, so
            // naming a colour is enough to see it; the runtime draws nothing while the colour is unset.
            { name: 'track_border', kind: 'color', label: 'Track outline', defaultValue: '' },
            {
                name: 'track_border_width',
                kind: 'int',
                label: 'Track outline width',
                defaultValue: 1,
                min: 0,
                max: 8,
            },
            ...APPEARANCE_BLOCK,
            TEXT_COLOUR_PROPERTY,
        ],
        fontSupport: 'style',
        events: ['valueChanged', 'clicked'],
    },
    {
        tag: 'checkbox',
        aliases: [],
        label: 'Checkbox',
        category: 'input',
        defaultSize: { width: 96, height: 24 },
        fontSupport: 'style',
        note:
            'A tick box and a label, and the label can go on any of the box\'s four sides. The box is eight '
            + 'pixels unless a size is named here -- the crate capped it at the row height, which is why it '
            + 'looked lost in anything taller. The tick scales with the box.',
        props: [
            { name: 'label', kind: 'text', label: 'Label', defaultValue: 'Checkbox' },
            { name: 'checked', kind: 'bool', label: 'Checked', defaultValue: false },
            // Both zero means the crate's own rule rather than a size, exactly as the single `box_size` did.
            { name: 'box_width', kind: 'int', label: 'Box width', defaultValue: 0, min: 0, max: 64 },
            { name: 'box_height', kind: 'int', label: 'Box height', defaultValue: 0, min: 0, max: 64 },
            {
                name: 'label_position',
                kind: 'enum',
                label: 'Label side',
                defaultValue: 'right',
                options: ['left', 'right', 'top', 'bottom'],
            },
            // Only the crate's own fonts reach a checkbox: it is not a label or a carousel, so the `font`
            // attribute is not read for it. That is what `fontSupport: 'style'` says, and the validator uses it
            // to refuse a declared font rather than let the emitter drop it in silence.
            { name: 'font', kind: 'font', label: 'Label font', defaultValue: '' },
            { name: 'box_color', kind: 'color', label: 'Box colour', defaultValue: '' },
            // Superseded by the two sizes above: a design written before the box had a width and a height of
            // its own names this, and it still sets both. Kept, not offered.
            {
                name: 'box_size',
                kind: 'int',
                label: 'Box size (superseded)',
                defaultValue: 0,
                min: 0,
                max: 64,
                legacy: true,
                // The crate defaults it, so a design that does not name it -- every design dropped after this
                // change -- is complete rather than missing a property.
                optional: true,
            },
            APPEARANCE_ACCENT,
            ...APPEARANCE_BLOCK,
            TEXT_COLOUR_PROPERTY,
        ],
        events: ['valueChanged', 'clicked'],
    },
    {
        tag: 'slider',
        aliases: [],
        label: 'Slider',
        category: 'input',
        note: 'A track with a knob. The track is the widget\'s text colour and the knob its accent.',
        defaultSize: { width: 160, height: 28 },
        props: [
            // Floats, because the crate's slider is a float widget and its value is what it reports back:
            // whole numbers only was a limit of the markup, not of the widget.
            { name: 'min', kind: 'float', label: 'Minimum', defaultValue: 0 },
            { name: 'max', kind: 'float', label: 'Maximum', defaultValue: 100 },
            { name: 'value', kind: 'float', label: 'Value', defaultValue: 0 },
            TEXT_COLOUR_PROPERTY,
            APPEARANCE_ACCENT,
            ...APPEARANCE_BLOCK,
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
        props: [
            { name: 'selected', kind: 'int', label: 'Selected index', defaultValue: 0, min: 0 },
            { name: 'font', kind: 'font', label: 'Font', defaultValue: '' },
        ],
        // The dropdown's style used to be dropped by the emitter, which hard-coded `Style::panel()` and
        // discarded the one the markup carried -- so there was no route to a font at all. It is carried now.
        fontSupport: 'style',
        events: ['valueChanged'],
    },
    {
        tag: 'roller',
        aliases: [],
        label: 'Roller',
        category: 'input',
        defaultSize: { width: 80, height: 80 },
        children: 'options',
        props: [
            { name: 'selected', kind: 'int', label: 'Selected index', defaultValue: 0, min: 0 },
            { name: 'font', kind: 'font', label: 'Font', defaultValue: '' },
            APPEARANCE_ACCENT,
            ...APPEARANCE_BLOCK,
            TEXT_COLOUR_PROPERTY,
        ],
        fontSupport: 'style',
        // `valueChanged` only: a `scroll` entry here was dead code — only a ScrollView ancestor raises
        // `UiEvent::Scroll`, and it carries the *view's* id, so a generated arm for a roller could
        // never fire. The drag added in 0.0.90 raises the same `valueChanged` the arrow keys do.
        events: ['valueChanged'],
    },
    {
        tag: 'plotter',
        aliases: [],
        label: 'Plotter',
        category: 'value',
        note:
            'A scrolling trace: the newest value goes in at `head` and the older ones wrap around behind it. ' +
            'The crate gives it a head index of its own, which is why it is not the same widget as a chart.',
        defaultSize: { width: 160, height: 96 },
        props: [
            { name: 'values', kind: 'text', label: 'Values', defaultValue: '1,2,3,4,5,6' },
            { name: 'head', kind: 'int', label: 'Head index', defaultValue: 0, min: 0, max: 255 },
            { name: 'min', kind: 'float', label: 'Minimum', defaultValue: 0 },
            { name: 'max', kind: 'float', label: 'Maximum', defaultValue: 10 },
            APPEARANCE_ACCENT,
            ...APPEARANCE_BLOCK,
        ],
        events: [],
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
            { name: 'font', kind: 'font', label: 'Font', defaultValue: '' },
            // The two colours inside the crate's own spinbox are literals in its renderer, so they are fields
            // here rather than style expressions; the runtime fork reads them.
            { name: 'accent_color', kind: 'color', label: 'Focused digit', defaultValue: '#00ffff' },
            { name: 'chevron_color', kind: 'color', label: 'Chevron outline', defaultValue: '#808080' },
            ...APPEARANCE_BLOCK,
            TEXT_COLOUR_PROPERTY,
        ],
        fontSupport: 'style',
        events: ['valueChanged'],
    },
    {
        tag: 'number_picker',
        aliases: [],
        label: 'Number picker',
        category: 'input',
        note:
            'A number with a unit beside it. The crate\'s picker paints its own rounded card and reads no ' +
            'colours at all, so this one offers none: a colour field here would change nothing on the glass.',
        defaultSize: { width: 96, height: 28 },
        props: [
            { name: 'min', kind: 'int', label: 'Minimum', defaultValue: 0 },
            { name: 'max', kind: 'int', label: 'Maximum', defaultValue: 100 },
            { name: 'value', kind: 'int', label: 'Value', defaultValue: 0 },
            { name: 'unit', kind: 'text', label: 'Unit', defaultValue: '' },
            { name: 'font', kind: 'font', label: 'Font', defaultValue: '' },
        ],
        fontSupport: 'style',
        events: ['valueChanged'],
    },
    {
        tag: 'time_picker',
        aliases: [],
        label: 'Time picker',
        category: 'input',
        note: 'A clock face showing an hour and a minute, on either a 12- or 24-hour dial.',
        defaultSize: { width: 120, height: 32 },
        props: [
            { name: 'hour', kind: 'int', label: 'Hour', defaultValue: 12, min: 0, max: 23 },
            { name: 'minute', kind: 'int', label: 'Minute', defaultValue: 0, min: 0, max: 59 },
            { name: 'is_12h', kind: 'bool', label: '12-hour clock', defaultValue: true },
            { name: 'is_pm', kind: 'bool', label: 'PM', defaultValue: false },
            { name: 'font', kind: 'font', label: 'Font', defaultValue: '' },
            // The crate's clock paints the field being edited in its accent, which is the one colour of its
            // own that its renderer reads from the style.
            APPEARANCE_ACCENT,
            TEXT_COLOUR_PROPERTY,
            ...APPEARANCE_BLOCK,
        ],
        fontSupport: 'style',
        events: ['valueChanged'],
    },
    {
        tag: 'progress',
        aliases: ['progress_bar'],
        label: 'Progress bar',
        category: 'value',
        defaultSize: { width: 160, height: 20 },
        note: 'A bar that fills from the left. The track is its background and the fill its own colour.',
        props: [
            { name: 'value', kind: 'float', label: 'Value', defaultValue: 0 },
            APPEARANCE_FILL,
            ...APPEARANCE_BLOCK,
        ],
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
            {
                name: 'start_angle',
                kind: 'int',
                label: 'Start angle',
                defaultValue: 135,
                min: -360,
                max: 360,
            },
            { name: 'end_angle', kind: 'int', label: 'End angle', defaultValue: 45, min: -360, max: 360 },
            { name: 'show_labels', kind: 'bool', label: 'Tick labels', defaultValue: true },
            { name: 'show_needle', kind: 'bool', label: 'Needle', defaultValue: true },
            // The gauge's own colours are fields on the widget the crate already carried but never let a
            // builder set: `add_scale` hard-coded grey ticks and a red needle.
            { name: 'tick_color', kind: 'color', label: 'Tick colour', defaultValue: '#808080' },
            { name: 'needle_color', kind: 'color', label: 'Needle colour', defaultValue: '#ff0000' },
            { name: 'font', kind: 'font', label: 'Font', defaultValue: '' },
            ...APPEARANCE_BLOCK,
            TEXT_COLOUR_PROPERTY,
        ],
        fontSupport: 'style',
        events: ['valueChanged'],
    },
    {
        tag: 'arc',
        aliases: ['sweeping_arc'],
        label: 'Sweeping arc',
        category: 'value',
        note:
            'A pie sweep around an opaque card: the card is what the value would be drawn on, and the arc shows ' +
            'in the ring the card leaves. It is not anchored to angles -- the sweep starts at twelve o\'clock ' +
            'and covers `Progress` of the circle -- so `Arc radius` and `Frame inset` are what decide how much ' +
            'of it is visible.',
        defaultSize: { width: 96, height: 96 },
        props: [
            // The widget takes these eight values and has no builder that defaults any of them, so every one is
            // a property with a sensible default rather than something the markup can leave out.
            { name: 'progress', kind: 'float', label: 'Progress', defaultValue: 0.5, min: 0, max: 1 },
            { name: 'clockwise', kind: 'bool', label: 'Clockwise', defaultValue: true },
            {
                name: 'arc_radius',
                kind: 'int',
                label: 'Arc radius',
                defaultValue: 0,
                min: 0,
                max: 480,
            },
            // The frame is an opaque rounded card in the *middle* of the widget and it is painted after the
            // sweep, so the ring the design sees is whatever the card does not cover. At an inset of four the
            // card hides the sweep almost entirely; fourteen leaves a visible ring at the default radius.
            { name: 'frame_inset', kind: 'int', label: 'Frame inset', defaultValue: 14, min: 0, max: 64 },
            { name: 'corner_radius', kind: 'int', label: 'Corner radius', defaultValue: 4, min: 0, max: 64 },
            { name: 'bg_color', kind: 'color', label: 'Background', defaultValue: '#101010' },
            { name: 'arc_color', kind: 'color', label: 'Arc colour', defaultValue: '#00a0ff' },
            { name: 'frame_color', kind: 'color', label: 'Frame colour', defaultValue: '#404040' },
            ...APPEARANCE_BLOCK,
        ],
        events: [],
    },
    {
        tag: 'busy_wheel',
        aliases: ['spinner'],
        label: 'Busy wheel',
        category: 'value',
        note: 'A turning wheel. Turn it by feeding its phase from the animation clock: 0 to 1 is one turn.',
        defaultSize: { width: 48, height: 48 },
        props: [
            // The crate's spinner is a `phase`, not an on/off switch: it draws where you tell it to, and the
            // application is what moves it. A boolean could not express a quarter turn.
            { name: 'phase', kind: 'float', label: 'Phase', defaultValue: 0, min: 0, max: 1 },
            APPEARANCE_ACCENT,
            ...APPEARANCE_BLOCK,
        ],
        events: [],
    },
    {
        tag: 'chart',
        aliases: [],
        label: 'Chart',
        category: 'value',
        note:
            'A filled graph of a series. The design carries the values it starts with, and the application can ' +
            'replace them as they change.',
        defaultSize: { width: 160, height: 96 },
        props: [
            { name: 'values', kind: 'text', label: 'Values', defaultValue: '2,5,3,8,6' },
            { name: 'min', kind: 'float', label: 'Minimum', defaultValue: 0 },
            { name: 'max', kind: 'float', label: 'Maximum', defaultValue: 10 },
            // The crate draws the series with the resolved style's accent, so this is the series colour.
            APPEARANCE_ACCENT,
            ...APPEARANCE_BLOCK,
        ],
        events: [],
    },
    {
        tag: 'status_bar',
        aliases: [],
        label: 'Status bar',
        category: 'value',
        note: 'A strip with the time on it, drawn from its own style.',
        defaultSize: { width: 240, height: 24 },
        props: [
            { name: 'time', kind: 'text', label: 'Time', defaultValue: '12:00' },
            { name: 'font', kind: 'font', label: 'Font', defaultValue: '' },
            TEXT_COLOUR_PROPERTY,
            ...APPEARANCE_BLOCK,
        ],
        fontSupport: 'style',
        events: [],
    },
    {
        tag: 'content_indicator',
        aliases: [],
        label: 'Content indicator',
        category: 'value',
        note:
            'A chevron rather than dots: the crate draws one arrow, up or down, and which way it points comes ' +
            'from whether the active item is the last of the count. `Crumbs` is the widget that draws dots.',
        defaultSize: { width: 72, height: 16 },
        props: [
            { name: 'count', kind: 'int', label: 'Count', defaultValue: 3, min: 1, max: 255 },
            { name: 'active', kind: 'int', label: 'Active index', defaultValue: 0, min: 0, max: 255 },
            APPEARANCE_ACCENT,
            ...APPEARANCE_BLOCK,
        ],
        events: [],
    },
    {
        tag: 'crumbs',
        aliases: ['crumbs_indicator'],
        label: 'Crumbs indicator',
        category: 'value',
        note:
            'A row of dots, one per item, with the active one larger and in the accent. The inactive dots use a ' +
            'colour of the crate\'s own, so they are not part of the design.',
        defaultSize: { width: 72, height: 16 },
        props: [
            { name: 'count', kind: 'int', label: 'Count', defaultValue: 3, min: 1, max: 255 },
            { name: 'active', kind: 'int', label: 'Active index', defaultValue: 0, min: 0, max: 255 },
            APPEARANCE_ACCENT,
            ...APPEARANCE_BLOCK,
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
            { name: 'font', kind: 'font', label: 'Font', defaultValue: '' },
        ],
        // The dialog's style used to be dropped by the emitter; it is carried now, so its title and body can
        // be drawn in a font the design chose.
        fontSupport: 'style',
        events: ['opened', 'closed'],
    },
    {
        tag: 'table',
        aliases: [],
        label: 'Table',
        category: 'container',
        defaultSize: { width: 240, height: 120 },
        children: 'table',
        note:
            'A table is drawn with the panel style and its own cells; its headers and cells are drawn in the ' +
            'font chosen here.',
        props: [{ name: 'font', kind: 'font', label: 'Font', defaultValue: '' }],
        // The table's emitter arm used to hard-code `Style::panel()` and drop any `style` the markup carried,
        // which is why this catalogue had no font field for it. The style is carried through now.
        fontSupport: 'style',
        // No events at all: a table is not focusable and cannot be touched, so a `scroll` entry (which
        // only a ScrollView ancestor can raise) was an offer nothing could keep.
        events: [],
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
            TEXT_COLOUR_PROPERTY,
        ],
        fontSupport: 'both',
        // `valueChanged` only, and that one is real: the carousel gained the drag (and the arrow-key arm
        // that goes with it) in 0.0.90, while its `scroll` entry was the same dead offer the roller had.
        events: ['valueChanged'],
    },
    {
        tag: 'image',
        aliases: ['bitmap'],
        label: 'Image',
        category: 'media',
        note:
            'A bitmap. A file in the project is embedded in the flash at build time; a `sd:` name such as ' +
            '`sd:PIC1.BMP` is read from the card the firmware mounts, a row at a time as it draws, so a ' +
            'full-screen image costs a row of RAM rather than a copy of the file.',
        defaultSize: { width: 96, height: 96 },
        props: [
            {
                name: 'src',
                kind: 'asset',
                label: 'Asset',
                defaultValue: '',
                required: true,
            },
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
        // Board-side now: `rusty-gui-widgets` renders a filled/stroked rectangle from the cell rect, so the
        // shape's own colours and corners reach the board the same way they do on the canvas.
        draws: 'rectangle',
        note: 'Drawn as a rectangle from its own fill, stroke and corner radius -- the same on the canvas and on the board.',
        props: [
            { name: 'radius', kind: 'int', label: 'Corner radius', defaultValue: 0, min: 0, max: 64 },
            { name: 'stroke_width', kind: 'int', label: 'Stroke width', defaultValue: 0, min: 0, max: 32 },
            { name: 'fill', kind: 'color', label: 'Fill', defaultValue: '#3a6ea5' },
            { name: 'stroke', kind: 'color', label: 'Stroke', defaultValue: '#ffffff' },
        ],
        events: [],
    },
    {
        tag: 'line',
        aliases: [],
        label: 'Line',
        category: 'shape',
        defaultSize: { width: 96, height: 8 },
        // Board-side now: the codegen fork emits `add_custom_widget(rusty_gui_widgets::Line)`, which the
        // board orients along the cell's longer axis -- so the line is painted, not a spacer.
        draws: 'line',
        note: 'Drawn as a line along the longer axis of its cell, in its own colour and thickness.',
        props: [
            { name: 'stroke_width', kind: 'int', label: 'Stroke width', defaultValue: 1, min: 1, max: 32 },
            { name: 'color', kind: 'color', label: 'Colour', defaultValue: '#ffffff' },
        ],
        events: [],
    },
    {
        tag: 'circle',
        aliases: [],
        label: 'Circle',
        category: 'shape',
        defaultSize: { width: 64, height: 64 },
        // Designer-native: embedded-gui-codegen 0.2.7 has no circle builder -- it emits add_panel, which is a
        // rectangle -- so a markup circle would be a square on the board. The canvas paints the arc itself
        // from the bounding rect, and `native` keeps it out of the emitted KDL until a widgets crate renders
        // it on the board. The shape's own colours reach the canvas, not the (panel-painting) generator.
        draws: 'circle',
        // Board-side now: `rusty-gui-widgets` renders a real arc from the cell rect, so the circle is written
        // into the markup like every other shape. The canvas still paints its own arc for editing, but it no
        // longer has to hide behind `native` to keep a design building.
        note:
            'Drawn by the designer as a circle; the board renders a real arc from the same rect, once a ' +
            'widgets crate provides one. Its outline and fill colours reach the board through stroke/fill.',
        props: [
            { name: 'line_color', kind: 'color', label: 'Line colour', defaultValue: '#ffffff' },
            { name: 'line_thickness', kind: 'int', label: 'Line thickness', defaultValue: 1, min: 0, max: 32 },
            { name: 'fill', kind: 'bool', label: 'Fill', defaultValue: true },
            { name: 'fill_color', kind: 'color', label: 'Fill colour', defaultValue: '#3a6ea5' },
        ],
        events: [],
    },
    {
        tag: 'triangle',
        aliases: [],
        label: 'Triangle',
        category: 'shape',
        defaultSize: { width: 64, height: 56 },
        // Board-side: `rusty-gui-widgets` renders a triangle from its cell rect and the six vertex offsets
        // below; the canvas paints the same vertices. A freshly dropped one is isosceles -- apex on the top
        // edge centre, base along the bottom edge -- and the three points can then be dragged anywhere.
        draws: 'triangle',
        note:
            'Drawn as a triangle. Drag any of the three points on the canvas to move it; the box follows a ' +
            'point, so a vertex can go anywhere on the glass.',
        props: [
            { name: 'stroke_width', kind: 'int', label: 'Stroke width', defaultValue: 1, min: 0, max: 32 },
            { name: 'fill', kind: 'color', label: 'Fill', defaultValue: '#3a6ea5' },
            { name: 'stroke', kind: 'color', label: 'Stroke', defaultValue: '#ffffff' },
            // Per-mille of the box, which is how the crate's `Triangle` reads them (`parser.rs` clamps to
            // 0..=1000 and falls back to this same default). Six properties rather than one packed string so
            // each is a plain attribute the parser already accepts -- no new child grammar -- and so a
            // document written before they existed keeps the isosceles shape on both sides.
            { name: 'p1x', kind: 'int', label: 'Point 1 X', defaultValue: 500, min: 0, max: 1000, optional: true, group: TRIANGLE_POINTS_LABEL },
            { name: 'p1y', kind: 'int', label: 'Point 1 Y', defaultValue: 0, min: 0, max: 1000, optional: true, group: TRIANGLE_POINTS_LABEL },
            { name: 'p2x', kind: 'int', label: 'Point 2 X', defaultValue: 0, min: 0, max: 1000, optional: true, group: TRIANGLE_POINTS_LABEL },
            { name: 'p2y', kind: 'int', label: 'Point 2 Y', defaultValue: 1000, min: 0, max: 1000, optional: true, group: TRIANGLE_POINTS_LABEL },
            { name: 'p3x', kind: 'int', label: 'Point 3 X', defaultValue: 1000, min: 0, max: 1000, optional: true, group: TRIANGLE_POINTS_LABEL },
            { name: 'p3y', kind: 'int', label: 'Point 3 Y', defaultValue: 1000, min: 0, max: 1000, optional: true, group: TRIANGLE_POINTS_LABEL },
        ],
        events: [],
    },
    {
        tag: 'path',
        aliases: ['vector_path'],
        label: 'Vector path',
        category: 'shape',
        // Board-side now: `rusty-gui-widgets` flattens the commands and strokes them through the canvas, so a
        // path is drawn rather than making the generated file fail to compile.
        draws: 'path',
        note:
            'An outline from SVG-style path commands, in pixels from the widget\'s top-left corner. It is ' +
            'stroked, not filled, and curves are drawn as a fixed number of straight segments.',
        defaultSize: { width: 96, height: 96 },
        props: [
            // The SVG path data the parser turns into verbs; free text, since it is a mini-language.
            { name: 'd', kind: 'text', label: 'Path data', defaultValue: 'M 0 0 L 32 32 Z' },
            { name: 'stroke_width', kind: 'int', label: 'Stroke width', defaultValue: 1, min: 1, max: 32 },
            { name: 'colour', kind: 'color', label: 'Colour', defaultValue: '#ffffff' },
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
        // Only what can be built. An unavailable tag is still in the catalogue -- its properties are documented
        // and a design that already contains one is reported by name -- but it is not something to hand out.
        widgets: KDL_WIDGETS.filter((widget) => widget.category === category && widget.unavailable === undefined),
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
    accent: 'Colour of the part that shows the control is on, chosen or focused',
    accent_color: 'Colour of the underline under the digit being changed',
    active: 'Whether the spinner is turning',
    arc_color: 'Colour of the sweeping part of the arc',
    arc_radius: 'Radius of the arc in pixels. Zero fits it to the widget',
    bg_color: 'Colour of the disc behind the arc',
    frame_color: 'Colour of the arc\'s frame',
    border_width: 'How thick the border is, in pixels. A border colour asks for a border; this thickens it',
    box_color: 'Colour of the checkbox\'s own box outline',
    box_width: 'How wide the box is, in pixels. Zero keeps the crate\'s own eight-pixel rule',
    box_height: 'How tall the box is, in pixels. Zero keeps the crate\'s own eight-pixel rule',
    box_size: 'Superseded by the box width and height, and still read so an older design keeps its size',
    label_position: 'Which side of the box the label is drawn on',
    chevron_color: 'Colour of the outline around the minus and plus buttons',
    clockwise: 'Which way the arc sweeps',
    colour: 'Colour to stroke the path in',
    needle_color: 'Colour of the gauge\'s needle',
    off_color: 'Colour of a switch\'s track while it is off',
    phase: 'How far round the wheel has turned, 0 to 1',
    progress: 'How full the arc is, 0 to 1',
    track_border: 'Colour of the outline around the switch itself, not the frame',
    track_border_width: 'How thick that outline is; zero leaves the switch bare',
    show_labels: 'Whether the numbers beside the gauge\'s major ticks are drawn',
    show_needle: 'Whether the gauge\'s needle is drawn at all',
    tick_color: 'Colour of the gauge\'s ticks',
    head: 'Which value is the newest one; the older ones wrap around behind it',
    values: 'The numbers to draw, separated by commas',
    align: 'Where the parts sit inside the widget',
    bg: 'Background colour, drawn instead of the base style\'s fill',
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
    frame_inset: 'Pixels between the arc\'s frame and the arc itself',
    fg: 'Colour of the part that fills or moves: a progress bar\'s fill, a slider\'s knob',
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
    p1x: 'How far point 1 sits across the box, 0 to 1000. Drag the point on the canvas to place it by eye',
    p1y: 'How far point 1 sits down the box, 0 to 1000. Drag the point on the canvas to place it by eye',
    p2x: 'How far point 2 sits across the box, 0 to 1000. Drag the point on the canvas to place it by eye',
    p2y: 'How far point 2 sits down the box, 0 to 1000. Drag the point on the canvas to place it by eye',
    p3x: 'How far point 3 sits across the box, 0 to 1000. Drag the point on the canvas to place it by eye',
    p3y: 'How far point 3 sits down the box, 0 to 1000. Drag the point on the canvas to place it by eye',
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
    'label.text_color': 'Colour of the words: painted from the widget\'s style, since the markup has no colour attribute for a label',
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
    'checkbox.box_size': 'Zero keeps the crate\'s own rule: the row height, up to eight pixels',
    'arc.arc_radius': 'Zero fits the arc to the widget\'s shorter side',
    'busy_wheel.phase': 'One full turn is 0 to 1; feed it from your animation clock',
    'plotter.head': 'Which value is the newest one; the older ones wrap around behind it',
    'scale.start_angle': 'Degrees clockwise from the right, so 135 starts at the lower left and 270 at the top',
    'scale.mode': 'A dial, or a bar that runs down or across',
    'image.src':
        'A file in the project, which is embedded in the flash at build time, or `sd:NAME.BMP` to read it from ' +
        'the SD card as it is drawn (the card is read with short 8.3 names, from its root)',
    'image.mode': 'How the pixels are interpreted, e.g. colour or monochrome',
    'rect.radius': 'Corner radius in pixels',
    'icon.scale': 'How much to enlarge the glyph',
    'circle.line_color': 'Colour of the circle\'s outline',
    'circle.line_thickness': 'Width of the outline, in pixels',
    'circle.fill': 'Whether the circle is filled',
    'circle.fill_color': 'Colour inside the circle',
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
    chart: 'A filled graph of a series of values',
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
    rect: 'A rectangle of its own fill and stroke, painted by the crate from the cell rect',
    line: 'A line segment along the cell, in its own colour and thickness',
    circle: 'A circle the crate paints from the cell rect',
    triangle: 'A triangle whose three points you can drag anywhere in its box',
    path: 'A vector outline built from SVG path data',
    plotter: 'A scrolling trace of a series of values',
};

/** The help for one property of one widget, or `undefined` if it has none. */
export function propertyHelp(tag: string, property: string): string | undefined {
    return TAG_PROPERTY_HELP[`${tag}.${property}`] ?? PROPERTY_HELP[property];
}

/** The one-line description of a widget, for the Toolbox tooltip. */
export function widgetHelp(tag: string): string | undefined {
    return WIDGET_HELP[tag];
}
