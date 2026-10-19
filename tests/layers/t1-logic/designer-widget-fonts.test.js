'use strict';

/**
 * The Font field, for every widget that offers one.
 *
 * A Font field is a promise about three things at once: that the *markup* carries the face, that the base
 * style the expression is written onto is the same base the codegen would have used, and that the canvas
 * shows what the board will draw. The first two are checked here; the canvas half is in the t2 layer,
 * which boots the real webview bundle (`designer-webview.test.js`).
 *
 * The base-style half is the subtle one, and it is why this file reads the emitter's source: a design with
 * nothing set gets the codegen's own fallback (`Style::panel()` for a status bar, say), but *setting*
 * anything routes through the designer's expression, which names a base itself. If that name disagrees with
 * the fallback, the widget changes shape the moment a font is chosen -- and only the glass shows it.
 */

const fs = require('fs');
const path = require('path');
const { test, ok, equal, notOk, contains, repoRoot, compiled } = require('../../lib/harness');

const { KDL_WIDGETS, widgetSpec } = compiled('designer/catalog');

const { appearanceExpression, ownStyleOf } = compiled('designer/appearance');
const { emitKdl } = compiled('designer/kdl');
const { createDocument, defaultChildren, defaultProps, validateDocument } = compiled('designer/model');

/** The tags whose catalogue entry offers a Font, which is the set the user is looking at. */
const FONT_TAGS = KDL_WIDGETS.filter((spec) => spec.props.some((property) => property.kind === 'font')).map(
    (spec) => spec.tag,
);

/**
 * `WidgetDef` variant → the tag the markup uses for it.
 *
 * Copied from `crates/embedded-gui-codegen/src/parser.rs`: the emitter is keyed by the AST variant, the
 * designer by the tag, and this is the only place the two names meet.
 */
const TAG_OF_VARIANT = {
    Label: 'label',
    Toggle: 'toggle',
    Checkbox: 'checkbox',
    Slider: 'slider',
    Dropdown: 'dropdown',
    Roller: 'roller',
    Scale: 'scale',
    Spinbox: 'spinbox',
    ProgressBar: 'progress',
    SweepingArc: 'arc',
    BusyWheel: 'busy_wheel',
    Chart: 'chart',
    Plotter: 'plotter',
    StatusBar: 'status_bar',
    TimePicker: 'time_picker',
    NumberPicker: 'number_picker',
    Dialog: 'dialog',
    ContentIndicator: 'content_indicator',
    CrumbsIndicator: 'crumbs',
    Panel: 'panel',
    Table: 'table',
    Carousel: 'carousel',
};

/** Every `WidgetDef` arm's own fallback base style, read out of the emitter rather than copied. */
function emitterFallbacks() {
    const source = fs.readFileSync(
        path.join(repoRoot(), 'crates/embedded-gui-codegen/src/emitter.rs'),
        'utf8',
    );
    const fallbacks = new Map();
    for (const block of source.split(/(?=WidgetDef::[A-Za-z]+ \{)/)) {
        const variant = /^WidgetDef::([A-Za-z]+) \{/.exec(block);
        if (variant === null) {
            continue;
        }
        const style = /style_expr\(style\.as_deref\(\), "Style::([a-z]+)\(\)"\)/.exec(block);
        if (style !== null) {
            fallbacks.set(variant[1], style[1]);
        }
    }
    return fallbacks;
}

const FALLBACKS = emitterFallbacks();

test('the emitter\'s own base styles are readable, so the check below is not vacuous', () => {
    ok(FALLBACKS.size >= 20, `expected the emitter to declare a fallback per arm, found ${FALLBACKS.size}`);
    equal(FALLBACKS.get('TimePicker'), 'panel', 'the arms this bug was about are in the table');
    equal(FALLBACKS.get('StatusBar'), 'panel');
    equal(FALLBACKS.get('NumberPicker'), 'panel');
    equal(FALLBACKS.get('Carousel'), 'label');
});

/**
 * The base style a designer expression names, or `undefined` when it names none.
 *
 * Only the base is read: the fields set onto it are the design's own, and they are checked by the tests
 * above this one.
 */
function baseStyleOf(tag) {
    const expression = appearanceExpression({ tag, values: { font: 'Medium4x7' } });
    if (expression === undefined) {
        return undefined;
    }
    const match = /Style::([a-z]+)\(\)/.exec(expression);
    return match === null ? undefined : match[1];
}

/**
 * `Style::label()` is `Style::default()` spelled out -- both are `Style::new()`'s fields, field for field
 * (`style.rs:240-256` and `:432-436`). They are the same style with two names, so a tag whose expression
 * says `label` where the emitter says `default` has not changed shape.
 */
function canonicalStyle(name) {
    return name === 'label' || name === 'new' ? 'default' : name;
}

test('every widget\'s expression uses the base style the emitter would have used', () => {
    // This is the whole class of bug, not just the fonts: a tag missing from `OWN_STYLE` silently falls
    // back to `Style::label()`, and the moment a design set any appearance property the widget stopped
    // being a panel. `status_bar`, `time_picker` and `number_picker` were all in that state.
    const mismatches = [];
    for (const [variant, tag] of Object.entries(TAG_OF_VARIANT)) {
        const fallback = FALLBACKS.get(variant);
        if (fallback === undefined || tag === 'button') {
            // A button's expression is a `WidgetStyle`, which this one-line read cannot see; its own test
            // covers it below.
            continue;
        }
        const base = baseStyleOf(tag);
        if (canonicalStyle(base) !== canonicalStyle(fallback)) {
            mismatches.push(`${tag}: expression says ${base}, emitter falls back to ${fallback}`);
        }
    }
    equal(mismatches, [], 'a widget must not change its base style just because a font was chosen');
});

test('a button\'s expression is still a WidgetStyle with the crate\'s own button base', () => {
    const expression = appearanceExpression({ tag: 'button', values: { font: 'Scaled6x10' } });
    contains(expression, 'WidgetStyle::button().with_normal(');
    contains(expression, 'Style::button()');
    contains(expression, 'style.font = FontId::Scaled6x10;');
});

test('ownStyleOf agrees with the emitter for every widget it knows', () => {
    // The same claim from the other end: the table `appearance.ts` consults is the emitter's fallback.
    for (const [variant, tag] of Object.entries(TAG_OF_VARIANT)) {
        const fallback = FALLBACKS.get(variant);
        if (fallback === undefined || tag === 'button') {
            continue;
        }
        equal(canonicalStyle(ownStyleOf(tag)), canonicalStyle(fallback), `${tag} wears ${fallback}`);
    }
});

/** A one-widget design, with the properties the catalogue defaults to. */
function documentWithOne(tag, overrides = {}) {
    const spec = widgetSpec(tag);
    ok(spec, `unknown widget ${tag}`);
    const size = spec.defaultSize;
    const document = createDocument({
        boardId: 'sunton-035r',
        panelWidth: 320,
        panelHeight: 480,
        rotation: 3,
        screenId: 'Panel',
    });
    document.widgets = [
        {
            id: 'probe',
            tag,
            x: 8,
            y: 8,
            width: size.width,
            height: size.height,
            props: { ...defaultProps(tag), ...overrides },
            events: [],
            children: defaultChildren(tag),
        },
    ];
    return document;
}

test('every widget that offers a Font writes it into the markup', () => {
    ok(FONT_TAGS.length >= 14, `expected the font-capable widgets, found ${FONT_TAGS.length}`);
    for (const tag of FONT_TAGS) {
        const kdl = emitKdl(documentWithOne(tag, { font: 'Scaled6x10' }));
        // A built-in font is not an attribute: the markup has no `font="..."` for the crate's own faces, so
        // the expression is the only route. The assertion is on the assignment, which is what reaches
        // `Style::font` on the board.
        contains(kdl, 'style.font = FontId::Scaled6x10;', `${tag} must carry the font it was given`);
        notOk(
            /font="Scaled6x10"/.test(kdl),
            `${tag} must not write a built-in font as an attribute -- that names a declared font instead`,
        );
    }
});

test('the three pickers keep their panel when a font is chosen', () => {
    // The regression this file was written for: choosing a font emitted `Style::label()`, so the widget
    // lost its background, border, shadow and rounding on the glass while the canvas drew the panel.
    for (const tag of ['status_bar', 'time_picker', 'number_picker']) {
        const withFont = emitKdl(documentWithOne(tag, { font: 'Medium4x7' }));
        const withoutFont = emitKdl(documentWithOne(tag));
        notOk(/style=/.test(withoutFont), `${tag} with nothing set emits no style, so the emitter defaults it`);
        contains(withFont, 'let mut style = Style::panel();', `${tag} must stay a panel`);
        contains(withFont, 'style.font = FontId::Medium4x7;');
    }
});

test('a declared font reaches every widget that offers one, by whichever route that widget reads', () => {
    // Two routes carry a font, and which one depends on the tag: a label and a carousel read `font="name"`,
    // while every other widget is reached through a style. A declared font is a `BitmapFont` static, so the
    // style route names it exactly as the codegen would: `FontId::Bitmap(&__FONT_<ID>)`.
    for (const tag of FONT_TAGS) {
        const spec = widgetSpec(tag);
        const document = documentWithOne(tag, { font: 'my_bdf' });
        document.fonts = [{ id: 'my_bdf', src: 'fonts/my_bdf.bdf', chars: '' }];
        equal(validateDocument(document).length, 0, `${tag} accepts a declared font`);
        const kdl = emitKdl(document);
        if (spec.fontSupport === 'both' || spec.fontSupport === 'attribute') {
            contains(kdl, 'font="my_bdf"', `${tag} reads a declared font, so it is written as the attribute`);
        } else {
            contains(
                kdl,
                'style.font = FontId::Bitmap(&__FONT_MY_BDF)',
                `${tag} takes it through the style, naming the bitmap static`,
            );
            notOk(kdl.includes('font="my_bdf"'), `${tag} must not also write an attribute it does not read`);
        }
    }
});
