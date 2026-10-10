'use strict';

/**
 * The property pane fits the pane it is given.
 *
 * A setting that is drawn past the right edge is a setting the user has to scroll sideways to reach, and the
 * cause is always a flex or grid item that refuses to shrink: an input's default width, a `<select>` as wide as
 * its widest option, an input and its `...` button on one unbreakable line. Those are the rules checked here.
 *
 * Checked as *rules* rather than as a rendered layout because nothing in this repository lays CSS out -- no
 * browser runs in the suite, and the stub DOM has no widths -- so the one thing that can be asserted is the
 * declaration that keeps a row shrinkable. The failure it guards against is quiet: a new field with a fixed
 * width looks right on a wide window and runs off the side of a narrow one.
 */

const { test, equal, contains, compiled } = require('../../lib/harness');
const { designerStyles } = compiled('designer/styles');

const css = designerStyles();

/** The declarations of one selector, by property, so a test asserts what a rule says and not how it is spelt.
 *
 * Every rule that names the selector contributes, later ones winning, which is what the cascade does: a
 * `.field-input` appears in the typography rule and again in the sizing one, and only the second has a width.
 */
function styleOf(selector) {
    // The sheet is flat -- no nested at-rules -- so splitting on braces is enough, and comments are stripped
    // first so a property named in prose is never mistaken for one that applies.
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const declarations = {};
    for (const rule of flat.split('}')) {
        const brace = rule.indexOf('{');
        if (brace < 0) {
            continue;
        }
        const selectors = rule
            .slice(0, brace)
            .split(',')
            .map((part) => part.trim());
        if (!selectors.includes(selector)) {
            continue;
        }
        for (const declaration of rule.slice(brace + 1).split(';')) {
            const colon = declaration.indexOf(':');
            if (colon > 0) {
                declarations[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
            }
        }
    }
    return declarations;
}

test('the middle pane shrinks instead of pushing the property pane off the side', () => {
    // `1fr` carries an `auto` minimum, so a canvas wider than the window would widen the whole grid and take the
    // property pane with it. With a zero minimum the design scrolls inside the stage and the pane keeps its
    // width, which is what makes the rest of these rules matter.
    contains(styleOf('.body')['grid-template-columns'], 'minmax(0, 1fr)');
});

test('nothing in a pane can be wider than the pane', () => {
    equal(styleOf('.properties *')['max-width'], '100%', 'the property pane caps its contents');
    equal(styleOf('.toolbox *')['max-width'], '100%', 'and so does the toolbox');
});

test('a property row shares its width between the label and the control', () => {
    const label = styleOf('.field-label');
    equal(label['flex'], '0 1 auto', 'the label gives up width first');
    equal(label['min-width'], '0', 'and may shrink to nothing');
    equal(label['overflow'], 'hidden', 'with');
    equal(label['text-overflow'], 'ellipsis', 'an ellipsis where it did');
    equal(styleOf('.field > :not(.field-label)')['min-width'], '0', 'the control may shrink too');
});

test('a path field is a row of its own rather than one unbreakable line', () => {
    // The bug this exists for: `.asset-field` had no rule, so its input kept its default width and its `...`
    // button sat beside it with no whitespace between them -- a line no pane could narrow, so the Source and
    // File fields of an Image, an Icon or a font ran off the side.
    const row = styleOf('.asset-field');
    equal(row['display'], 'flex', 'the input and the browse button share a flex row');
    equal(row['min-width'], '0', 'which may shrink');
    equal(styleOf('.asset-field > .field-input')['min-width'], '0', 'and the input inside it may shrink too');
    equal(styleOf('.asset-field > button')['flex'], '0 0 auto', 'while the button keeps its own size');
});

test('the geometry grid columns may shrink to nothing', () => {
    // A grid track's default minimum is `auto`, which here is the number input's own width: two of those plus
    // their labels is wider than the pane, and the second column (Y, Height, Radius) is what goes off screen.
    equal(
        styleOf('.field-grid')['grid-template-columns'],
        'minmax(0, 1fr) minmax(0, 1fr)',
        'both columns have a zero minimum',
    );
    equal(styleOf('.field-grid .field')['min-width'], '0', 'and the rows inside them may shrink');
});

test('a field control is never stretched to nothing and never as wide as its text', () => {
    const input = styleOf('.field-input');
    equal(input['width'], '100%', 'an input fills the width its row gives it');
    equal(input['min-width'], '0', 'which it may shrink into');
    equal(styleOf('.field > input[type="checkbox"]')['flex'], '0 0 auto', 'a checkbox keeps its own size');
    equal(
        styleOf('.color-field input[type="color"]')['min-width'],
        '28px',
        'and a colour swatch stays big enough to see',
    );
});
