/**
 * How a design asks for an appearance: a base style, the widget's own colours, and a font.
 *
 * The markup has one appearance attribute and it carries everything. `style` holds the crate's own named
 * looks -- and, because the crate gives a colour attribute of its own to only some tags, whatever else the
 * widget has no field for. A design can want a base style, a font, a background, a border, an accent and a
 * text colour at once, and all of them have to be composed into **one** `style` expression rather than written
 * as separate attributes, because a widget can only have one `style`.
 *
 * What each name means was read off `style_expr` in `embedded-gui-codegen` rather than guessed, because a name
 * the resolver does not know is passed through *verbatim* as Rust. That is a foot-gun in a design file a person
 * edits by hand: a typo would not be ignored, it would be compiled. So the names are a closed set here and
 * validation refuses anything else.
 *
 * The crate's own list is longer than this and mostly aliases: `default`, `label`, `bold`, `dim`, `accent`,
 * `success`, `danger` and `inverted` all resolve to `Style::label()`; `card` is `Style::panel()`; `body*` and
 * `menu` are a label carrying `Scaled6x10`; `hint*` is a label carrying `Medium4x7`; and a `#rrggbb` becomes a
 * `WidgetStyle::button()`, which is a button's shape and no other widget's. The font aliases are offered by the
 * Font field instead, where they are the same thing named more directly, and what is left are the four base
 * styles that actually differ from one another in a way a designer can see.
 *
 * **Which style a colour is set on matters.** A widget that names only an accent must keep the background,
 * border and padding it had, so the expression starts from the style *that tag* wears when the design says
 * nothing -- `Style::panel()` for a roller, `Style::default()` for a toggle -- and not from one global default.
 * `ownStyleOf` is that mapping, and it mirrors the codegen fork's per-tag fallback; if the two ever disagree,
 * setting one colour would silently change a widget's whole surface.
 */

import { isBuiltInFont } from './fonts';
import type { KdlProperty } from './catalog';

/**
 * A `#rrggbb` colour as the `Rgb565` the crate's runtime wants.
 *
 * The same 5/6/5 reduction the crate's own resolver performs on a hex colour, and the same one the canvas
 * preview uses, so the swatch on the canvas and the pixel on the glass come from one arithmetic.
 */
export function rgb565Expression(colour: string): string | undefined {
    const match = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(colour);
    if (match === null) {
        return undefined;
    }
    const r = parseInt(match[1] ?? '00', 16);
    const g = parseInt(match[2] ?? '00', 16);
    const b = parseInt(match[3] ?? '00', 16);
    return `Rgb565::new(${r >> 3}, ${g >> 2}, ${b >> 3})`;
}

/** One of the base styles, as the picker offers it. */
export interface NamedStyle {
    /** The value stored in the design, and the `Style` constructor it selects. */
    id: string;
    label: string;
}

/**
 * The base styles, in the crate's order of weight.
 *
 * They differ in more than colour: `panel` and `button` carry a gradient, a border and a shadow, `progress` a
 * horizontal one, and `label` none of them. That is why a plain widget can be given a panel's look and a panel
 * can be given a label's -- which is the appearance control the crate actually exposes.
 */
export const NAMED_STYLES: readonly NamedStyle[] = [
    { id: 'label', label: 'Plain — no background, border or shadow' },
    { id: 'panel', label: 'Panel — dark card, border, soft shadow' },
    { id: 'progress', label: 'Progress — thin, horizontal gradient' },
    { id: 'button', label: 'Button — button gradient and corner radius' },
];

const NAMED_STYLE_IDS = new Set(NAMED_STYLES.map((style) => style.id));

export function isNamedStyle(value: string): boolean {
    return NAMED_STYLE_IDS.has(value);
}

/**
 * The flat fields of the crate's `Style` that a design can set, as a property's `viaStyle` marker names them.
 *
 * These are `Style`'s own fields rather than a palette of roles, because that is what the emitted expression
 * has to assign: `style.rs` declares `background`, `foreground`, `text`, `accent`, `corner_radius` and
 * `border`, and `Block::render` paints the gradient *instead of* the background when it has one -- which is why
 * setting a background has to clear the gradient too.
 */
export type StyleField =
    | 'font'
    | 'text'
    | 'foreground'
    | 'accent'
    | 'background'
    | 'border'
    | 'borderWidth'
    | 'radius';

/** The values a widget's `viaStyle` properties ask for, in the crate's own terms. */
export interface StyleValues {
    /** A built-in font, by id. */
    font?: string;
    /** `#rrggbb` colours. */
    text?: string;
    foreground?: string;
    accent?: string;
    background?: string;
    border?: string;
    /** Pixels. */
    borderWidth?: number;
    radius?: number;
}

/**
 * The style a tag wears when the design names none.
 *
 * One entry per tag whose emitted default is not `Style::default()`: the codegen fork writes exactly these
 * fallbacks in its arms (see `crates/embedded-gui/README.md` for why the runtime is vendored alongside), so a
 * colour the design sets is layered onto the surface the widget already had.
 */
const OWN_STYLE: Record<string, string> = {
    button: 'button',
    panel: 'panel',
    card: 'panel',
    dropdown: 'panel',
    roller: 'panel',
    spinbox: 'panel',
    scale: 'panel',
    table: 'panel',
    dialog: 'panel',
};

export function ownStyleOf(tag: string): string {
    return OWN_STYLE[tag] ?? 'label';
}

/**
 * The style fields a widget's properties ask for, from the catalogue's `viaStyle` markers.
 *
 * The catalogue is the authority on which properties travel inside the expression rather than as attributes --
 * a button's `bg` is a real attribute, a toggle's is not -- so the caller passes the tag's property list rather
 * than this module guessing from names. A value that is absent or empty contributes nothing, which is what keeps
 * an unset colour from overriding the base style with black.
 */
export function styleValuesOf(
    widget: { props: Record<string, string | number | boolean> },
    props: readonly KdlProperty[],
): StyleValues {
    const values: StyleValues = {};
    for (const property of props) {
        const field = property.viaStyle;
        const value = widget.props[property.name];
        if (value === undefined || value === '') {
            continue;
        }
        // A **built-in** font is a style expression and nothing else: the markup has no `font` attribute for
        // the crate's own faces, so `style.font` is the only way to reach one. A *declared* font (a BDF the
        // screen names) does have an attribute, and the generic emitter writes that one instead.
        if (field === undefined) {
            if (property.kind === 'font' && typeof value === 'string' && isBuiltInFont(value)) {
                values.font = value;
            }
            continue;
        }
        if (field === 'font') {
            if (typeof value === 'string' && isBuiltInFont(value)) {
                values.font = value;
            }
        } else if (field === 'borderWidth' || field === 'radius') {
            if (typeof value === 'number' && Number.isFinite(value)) {
                values[field] = value;
            }
        } else if (typeof value === 'string' && rgb565Expression(value) !== undefined) {
            values[field] = value;
        }
    }
    return values;
}

/** Whether anything at all was asked for, as opposed to an empty set of markers. */
function hasAnyValue(values: StyleValues): boolean {
    return Object.values(values).some((value) => value !== undefined && value !== '');
}

/**
 * The appearance a design asked for, after the rules that make a half-filled form do the obvious thing.
 *
 * This is data rather than text because **two** things have to agree about it: the Rust the board compiles and
 * the pixels the canvas paints. Doing the policy here means the canvas cannot accidentally apply a border the
 * board does not have.
 *
 * The rules, and why they are not simply "apply whatever is in the field":
 *
 * - **A colour that is set is applied; one that is not leaves the base style alone.** Every colour defaults to
 *   the empty string, and empty means "not set" rather than black, or every widget would be repainted black
 *   the moment any appearance field existed.
 * - **A border colour brings a border with it.** The plain base style has a border width of `0`, so a design
 *   that picks only a border colour would otherwise see nothing at all. Naming a colour therefore means "draw
 *   me a border", and the width defaults to one pixel.
 * - **A border width on its own thickens the border the base style already has**, which is how a panel's own
 *   border gets fatter without also changing its colour.
 * - **A corner radius of `0` means "keep the base's corners"**, by the same logic as the border width: the
 *   radius is a number whose default has to mean "unset", and a panel's corner is not something a design
 *   should lose by leaving a field alone. A square corner is asked for with the Plain base style instead,
 *   which is what that style is.
 */
export interface ResolvedStyle {
    /** `#rrggbb`, and it clears any gradient the base style carried. */
    background?: string;
    /** `#rrggbb`. */
    text?: string;
    accent?: string;
    foreground?: string;
    /** A border to draw, in the design's colour, at least one pixel wide. */
    border?: { colour: string; width: number };
    /** A border width with no colour of its own. */
    borderWidth?: number;
    /** Pixels, always above zero. */
    radius?: number;
    /** A built-in font, by id. */
    font?: string;
}

export function resolveStyleValues(values: StyleValues): ResolvedStyle {
    const resolved: ResolvedStyle = {};
    const colour = (value: string | undefined): string | undefined =>
        value === undefined || value === '' || rgb565Expression(value) === undefined ? undefined : value;
    const count = (value: number | undefined): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined;

    const font = values.font;
    if (font !== undefined && isBuiltInFont(font)) {
        resolved.font = font;
    }
    const background = colour(values.background);
    if (background !== undefined) {
        resolved.background = background;
    }
    const border = colour(values.border);
    const width = count(values.borderWidth);
    if (border !== undefined) {
        resolved.border = { colour: border, width: width !== undefined && width > 0 ? width : 1 };
    } else if (width !== undefined && width > 0) {
        resolved.borderWidth = width;
    }
    const radius = count(values.radius);
    if (radius !== undefined && radius > 0) {
        resolved.radius = radius;
    }
    const text = colour(values.text);
    if (text !== undefined) {
        resolved.text = text;
    }
    const accent = colour(values.accent);
    if (accent !== undefined) {
        resolved.accent = accent;
    }
    const foreground = colour(values.foreground);
    if (foreground !== undefined) {
        resolved.foreground = foreground;
    }
    return resolved;
}

/** Whether a resolved appearance asks for anything at all. */
export function hasAppearance(style: ResolvedStyle): boolean {
    return Object.keys(style).length > 0;
}

/**
 * The assignments a resolved appearance becomes, in a fixed order so a design always emits the same text --
 * which is what makes the markup diffable and the tests readable.
 */
function assignments(style: ResolvedStyle): string[] {
    const fills: string[] = [];
    const literal = (colour: string): string => rgb565Expression(colour) ?? 'Rgb565::new(0, 0, 0)';

    if (style.font !== undefined) {
        fills.push(`style.font = FontId::${style.font};`);
    }
    if (style.background !== undefined) {
        fills.push(`style.background = Some(${literal(style.background)});`);
        // `Block::render` paints the gradient *instead of* the background (`block.rs:177-186`), so a flat
        // colour the design asked for has to clear whatever the base style carried or it would never show.
        fills.push('style.gradient = None;');
    }
    if (style.border !== undefined) {
        fills.push(`style.border.color = ${literal(style.border.colour)};`);
        fills.push(`style.border.width = ${style.border.width};`);
    } else if (style.borderWidth !== undefined) {
        fills.push(`style.border.width = ${style.borderWidth};`);
    }
    if (style.radius !== undefined) {
        fills.push(`style.corner_radius = ${style.radius};`);
    }
    if (style.text !== undefined) {
        fills.push(`style.text = ${literal(style.text)};`);
    }
    if (style.accent !== undefined) {
        fills.push(`style.accent = ${literal(style.accent)};`);
    }
    if (style.foreground !== undefined) {
        fills.push(`style.foreground = ${literal(style.foreground)};`);
    }
    return fills;
}

/**
 * The style expression a widget needs, or `undefined` when it needs none.
 *
 * A widget with only a font gets the expression the crate's own resolver would write for it; one with only a
 * style gets the plain constructor, which is exactly what the resolver turns that name into; one with both gets
 * the design's fields set onto the chosen base.
 *
 * A **button** is the exception, and it is the same one the font picker has to work around: the button's emitter
 * chains its colour and corner builders onto whatever the expression returns, so a button's appearance has to be
 * a `WidgetStyle` and not a `Style`. The named base rides in the normal state.
 *
 * A malformed colour yields `undefined` -- no expression at all rather than a partly applied one. Validation
 * refuses such a design first (see `propertyProblem`), so reaching here with one is a caller's bug, and a
 * half-written expression would be worse than none: the board would differ from the canvas *and* still build.
 */
export function appearanceExpression(options: {
    tag: string;
    /** The chosen base style, or empty for the widget's own. */
    style?: string;
    /** The fields the design's `viaStyle` properties asked for. */
    values?: StyleValues;
}): string | undefined {
    const style = options.style ?? '';
    const values = options.values ?? {};
    if (style !== '' && !isNamedStyle(style)) {
        // Validation reports this too; refusing here as well means no path can emit it.
        return undefined;
    }
    if (style === '' && !hasAnyValue(values)) {
        return undefined;
    }

    const own = options.tag === 'button' ? 'button' : ownStyleOf(options.tag);
    const base = `Style::${style === '' ? own : style}()`;
    const resolved = resolveStyleValues(values);
    const fills = assignments(resolved);
    if (hasAnyValue(values) && fills.length === 0) {
        // Every value was unusable, e.g. a colour that is not `#rrggbb`; validation reports it first.
        return undefined;
    }
    const normal = fills.length === 0 ? base : `{ let mut style = ${base}; ${fills.join(' ')} style }`;

    if (options.tag === 'button') {
        return `WidgetStyle::button().with_normal(${normal})`;
    }
    return normal;
}
