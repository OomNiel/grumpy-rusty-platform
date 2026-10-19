/**
 * The fonts `embedded-gui` itself provides, and how a design can ask for one.
 *
 * The crate ships six drawn bitmap faces and a scalable vector one -- `FontId::Tiny3x5`, `Medium4x7` (the
 * default), `Scaled6x10`, `Medium5x7`, `Mono6x10`, `Mono8x16` and `Vector(scale)` -- but the markup has **no
 * attribute for them**. A widget's `font="name"` refers to a font the *screen declares*, which means a BDF file in the project;
 * the code generator drops a name it cannot resolve in silence, so a built-in name typed there would do nothing
 * at all.
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
 * `Mono6x10` and `Mono8x16` are the two faces rasterised from DejaVu Sans Mono (`crates/embedded-gui/assets/`),
 * added because a 3x5 bitmap is as legible as hand-drawn pixels get: everything larger than a few characters
 * wants one of these. The sizes are the cell, not the ink -- 6x10 keeps 68 characters on a 480-pixel panel,
 * 8x16 keeps 53 -- and both carry a real lower case and the whole of printable ASCII.
 *
 * `Vector` takes a scale, so it appears once per scale worth offering rather than as a free number: the id
 * carries the scale (`Vector(2)`), which is what the reference in the generated code needs.
 */
export const BUILT_IN_FONTS: readonly BuiltInFont[] = [
    { id: 'Tiny3x5', label: 'Tiny 3x5 (the default)' },
    { id: 'Medium4x7', label: 'Medium 4x7' },
    { id: 'Scaled6x10', label: 'Scaled 6x10' },
    { id: 'Medium5x7', label: 'Medium 5x7 (drawn)' },
    { id: 'Mono6x10', label: 'Mono 6x10 (DejaVu)' },
    { id: 'Mono8x16', label: 'Mono 8x16 (DejaVu)' },
    { id: 'Vector(2)', label: 'Vector, scale 2' },
    { id: 'Vector(3)', label: 'Vector, scale 3' },
];

/** The ids, for validation and for the emitter's lookup. */
const BUILT_IN_IDS = new Set(BUILT_IN_FONTS.map((font) => font.id));

export function isBuiltInFont(value: string): boolean {
    return BUILT_IN_IDS.has(value);
}

/**
 * Whether a widget can be given a font the *declared* way (`font="name"`), which the crate reads for labels and
 * carousels only, or the built-in way (`style=...`), or both.
 *
 * The style expression that a built-in font needs is composed in `./appearance`, which also has to account for a
 * chosen base style and for the button's `WidgetStyle`.
 */
export type FontSupport = 'attribute' | 'style' | 'both';

/**
 * Rust-cases a font id into the identifier of its generated static.
 *
 * Mirrors `font_const_name` in `embedded-gui-codegen`, which is what a font name becomes in the generated
 * Rust. Two names that differ only in punctuation -- `big-font` and `big font` -- both become
 * `__FONT_BIG_FONT`, and the validator refuses that collision rather than letting the codegen produce two
 * statics with one name. It lives here, in a leaf module, so the style emitter can name a declared font's
 * `BitmapFont` static without importing the document model.
 */
export function fontConstName(id: string): string {
    let out = '__FONT_';
    for (const ch of id) {
        out += /[A-Za-z0-9]/.test(ch) ? ch.toUpperCase() : '_';
    }
    return out;
}

// The second name in a collision would silently use the first's data, which is why validation refuses two
// declarations whose constants match rather than letting the compiler report a duplicate static.

/** True when the tag can name a declared font, whose pixels came from a BDF file in the project. */
export function supportsFontAttribute(support: FontSupport | undefined): boolean {
    return support === 'attribute' || support === 'both';
}

/** True when the tag can carry a style expression, which is the only route a built-in font can take. */
export function supportsFontStyle(support: FontSupport | undefined): boolean {
    return support === 'style' || support === 'both';
}
