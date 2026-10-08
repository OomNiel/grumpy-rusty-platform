/**
 * The fonts `embedded-gui` itself provides, and how a design can ask for one.
 *
 * The crate ships three bitmap fonts and a scalable vector one -- `FontId::Tiny3x5`, `Medium4x7` (the default),
 * `Scaled6x10` and `Vector(scale)` -- but the markup has **no attribute for them**. A widget's `font="name"`
 * refers to a font the *screen declares*, which means a BDF file in the project; the code generator drops a name
 * it cannot resolve in silence, so a built-in name typed there would do nothing at all.
 *
 * What reaches them is `style`. The crate's own style resolver (`style_expr` in `embedded-gui-codegen`) accepts a
 * Rust expression and passes it through, and its own named styles read like a font menu: `body`, `menu` and
 * `body-accent` select `Scaled6x10`, while `hint` and `hint-accent` select `Medium4x7`. So a built-in font is
 * asked for by writing the expression the crate would have written itself:
 *
 *     { let mut style = Style::label(); style.font = FontId::Tiny3x5; style }
 *
 * Which is what this module produces, per widget, since the base style differs.
 *
 * Only some widgets honour either route, and that is the crate's shape rather than a choice here: a `font` is
 * read for labels and carousels, and a `style` for labels, buttons, panels, tables and carousels. Everything
 * else is drawn entirely from the theme.
 */

/** One of the crate's own fonts, as the picker offers it. */
export interface BuiltInFont {
    /** The value stored in the design, and the `FontId` variant it names. */
    id: string;
    label: string;
}

/**
 * The built-in fonts, in the crate's own order of size.
 *
 * `Tiny3x5` is the one a widget gets when nothing asks for another: both `Style::new()` and `Style::label()`
 * start there, so choosing it is the same as choosing nothing -- which is worth saying, because it is the
 * smallest of the three and reads as "no font" on screen.
 *
 * `Vector` takes a scale, so it appears once per scale worth offering rather than as a free number: the id
 * carries the scale (`Vector(2)`), which is what the reference in the generated code needs.
 */
export const BUILT_IN_FONTS: readonly BuiltInFont[] = [
    { id: 'Tiny3x5', label: 'Tiny 3x5 (the default)' },
    { id: 'Medium4x7', label: 'Medium 4x7' },
    { id: 'Scaled6x10', label: 'Scaled 6x10' },
    { id: 'Vector(2)', label: 'Vector, scale 2' },
    { id: 'Vector(3)', label: 'Vector, scale 3' },
];

/** The ids, for validation and for the emitter's lookup. */
const BUILT_IN_IDS = new Set(BUILT_IN_FONTS.map((font) => font.id));

export function isBuiltInFont(value: string): boolean {
    return BUILT_IN_IDS.has(value);
}

/**
 * The `style` expression that selects a built-in font for a widget.
 *
 * The shape is not the same for every tag, because the crate's emitter does not treat the expression the same
 * way. For most of them it is a `Style`, and the emitter passes it straight to `add_*`. A **button** is the
 * exception: the emitter builds its colour and corner settings by *chaining builder calls onto the expression*
 * (`.with_bg(...)`, `.with_corner_radius(...)`), so the expression has to be a `WidgetStyle` and not a `Style`
 * -- and since the designer always writes those colour properties, a `Style` here does not compile at all.
 * `WidgetStyle::button().with_normal(...)` satisfies both: the font rides in the normal state, and the chained
 * calls still have a `WidgetStyle` to land on.
 */
export function builtInFontExpression(font: string, tag: string): string {
    if (tag === 'button') {
        return `{ let mut style = Style::button(); style.font = FontId::${font}; WidgetStyle::button().with_normal(style) }`;
    }
    return `{ let mut style = Style::label(); style.font = FontId::${font}; style }`;
}

/**
 * Whether a widget can be given a font the *declared* way (`font="name"`), which the crate reads for labels and
 * carousels only, or the built-in way (`style=...`), or both.
 */
export type FontSupport = 'attribute' | 'style' | 'both';

/** True when the tag can name a declared font, whose pixels came from a BDF file in the project. */
export function supportsFontAttribute(support: FontSupport | undefined): boolean {
    return support === 'attribute' || support === 'both';
}

/** True when the tag can carry a style expression, which is the only route a built-in font can take. */
export function supportsFontStyle(support: FontSupport | undefined): boolean {
    return support === 'style' || support === 'both';
}
