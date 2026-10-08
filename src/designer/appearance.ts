/**
 * How a design asks for an appearance: a base style, and a font on top of it.
 *
 * The markup has two appearance attributes and they are not independent. `style` carries the crate's own named
 * looks -- and, when a widget has one, the font it selects -- and the crate's fonts have no attribute of their
 * own, so a built-in font *is* a style expression. A design can therefore want both at once, and the two have to
 * be composed into **one** `style` attribute rather than written twice.
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
 */

import { isBuiltInFont } from './fonts';

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
 * The style expression a widget needs, or `undefined` when it needs none.
 *
 * A widget with only a font gets the expression the crate's own resolver would write for it; one with only a
 * style gets the plain constructor, which is exactly what the resolver turns that name into; one with both gets
 * the font set onto the named base.
 *
 * A **button** is the exception, and it is the same one the font picker has to work around: the button's emitter
 * chains its colour and corner builders onto whatever the expression returns, so a button's appearance has to be
 * a `WidgetStyle` and not a `Style`. The named base rides in the normal state.
 */
export function appearanceExpression(options: {
    tag: string;
    /** The chosen base style, or empty for the widget's own. */
    style?: string;
    /** The chosen font, when it is one of the crate's own. */
    builtInFont?: string;
}): string | undefined {
    const style = options.style ?? '';
    const font = options.builtInFont ?? '';
    if (style === '' && font === '') {
        return undefined;
    }
    if (style !== '' && !isNamedStyle(style)) {
        // Validation reports this too; refusing here as well means no path can emit it.
        return undefined;
    }
    if (font !== '' && !isBuiltInFont(font)) {
        return undefined;
    }

    const own = options.tag === 'button' ? 'button' : 'label';
    const base = `Style::${style === '' ? own : style}()`;
    const normal = font === '' ? base : `{ let mut style = ${base}; style.font = FontId::${font}; style }`;

    if (options.tag === 'button') {
        return `WidgetStyle::button().with_normal(${normal})`;
    }
    return normal;
}
