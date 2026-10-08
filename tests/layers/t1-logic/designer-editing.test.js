'use strict';

/**
 * The designer's editing rules: undo, coalescing, clamping, hit testing and snapping.
 *
 * These are the decisions the canvas makes on every mouse move, and every one of them has a way of going
 * wrong that a screenshot would not show -- a drag that takes forty undos to reverse, a resize that lets a
 * widget fall off the panel, a click that selects the widget behind the one you can see. So they live in a
 * pure module and are tested here rather than only by dragging.
 */

const { test, ok, notOk, equal, throws, compiled } = require('../../lib/harness');
const {
    initialState,
    newDocument,
    canUndo,
    canRedo,
    undo,
    redo,
    addWidget,
    moveWidget,
    resizeWidget,
    removeWidget,
    renameWidget,
    setProperty,
    toggleEvent,
    reorderWidget,
    addFont,
    declareFontFromPath,
    duplicateWidget,
    removeFont,
    setChildren,
    setFontField,
    setScreenField,
    setRotation,
    canvasOf,
    widgetById,
    widgetAt,
} = compiled('designer/state');
const {
    hitTest,
    resizeFrom,
    snapTargets,
    bestSnap,
    gridSnap,
    snapMove,
    HANDLE_SIZE,
    MIN_SIZE,
    SNAP_TOLERANCE,
    GRID_STEP,
} = compiled('designer/hit');
const { validateDocument } = compiled('designer/model');

/** A CYD document. Rotation 3 is the landscape canvas, 480x320. */
function state(rotation = 0) {
    return newDocument({
        boardId: 'sunton-3248s035r',
        panelWidth: 320,
        panelHeight: 480,
        rotation,
        screenId: 'Panel',
    });
}

/** A state with one widget already on it, for the tests that need something to move. */
function withButton(x = 10, y = 10) {
    return addWidget(state(), 'button', x, y);
}

// ---------------------------------------------------------------- adding and removing

test('a dropped widget is placed inside the canvas with the catalogue\'s defaults', () => {
    const next = addWidget(state(), 'button', 318, 478);
    equal(next.document.widgets.length, 1, 'one widget');
    const widget = next.document.widgets[0];
    equal(widget.id, 'button', 'the id starts as the tag');
    equal(widget.tag, 'button', 'the tag');
    ok(widget.x + widget.width <= 320, `the widget must be inside the canvas, got x=${widget.x}`);
    ok(widget.y + widget.height <= 480, `the widget must be inside the canvas, got y=${widget.y}`);
    equal(widget.props.text, 'Button', 'the catalogue default');
    equal(widget.events.length, 0, 'and no handlers to begin with');
    notOk(widget.children, 'a button has no body');
});

test('a widget that has a body gets one', () => {
    const next = addWidget(state(), 'dropdown', 0, 0);
    equal(next.document.widgets[0].children.kind, 'options', 'the option list');
    equal(next.document.widgets[0].children.values.length, 3, 'three options to start');
});

test('the second widget of a tag gets a different id', () => {
    const two = addWidget(addWidget(state(), 'button', 0, 0), 'button', 0, 100);
    equal(two.document.widgets.map((w) => w.id).join(','), 'button,button_2');
});

test('adding, removing and renaming are each one undo step, and redo brings them back', () => {
    let next = withButton();
    equal(canUndo(next), true, 'the add can be undone');
    next = addWidget(next, 'label', 0, 100);
    equal(next.document.widgets.length, 2, 'two widgets');

    next = undo(next);
    equal(next.document.widgets.length, 1, 'undo removed the label');
    equal(canRedo(next), true, 'and can be redone');
    next = redo(next);
    equal(next.document.widgets.length, 2, 'redo put it back');

    next = removeWidget(next, 'button');
    equal(next.document.widgets.map((w) => w.id).join(','), 'label', 'the button is gone');
    next = undo(next);
    equal(next.document.widgets.map((w) => w.id).join(','), 'button,label', 'and comes back');
});

test('a rename is its own undo step', () => {
    let next = renameWidget(withButton(), 'button', 'go');
    equal(next.document.widgets[0].id, 'go', 'renamed');
    next = undo(next);
    equal(next.document.widgets[0].id, 'button', 'the old name is back');
});

test('undo and redo do nothing at the ends of the history', () => {
    const fresh = state();
    equal(undo(fresh), fresh, 'nothing to undo');
    equal(redo(fresh), fresh, 'nothing to redo');
    const one = withButton();
    const undone = undo(one);
    equal(undo(undone).document.widgets.length, 0, 'the second undo is a no-op, not a crash');
});

test('an edit that changes nothing is not recorded', () => {
    const one = withButton(10, 10);
    const again = moveWidget(one, 'button', 10, 10);
    equal(again, one, 'the state is returned untouched');
});

test('a new edit after an undo discards the redo branch', () => {
    let next = addWidget(withButton(), 'label', 0, 100);
    next = undo(next);
    equal(canRedo(next), true, 'the redo branch exists');
    next = setScreenField(next, 'theme', 'light');
    equal(canRedo(next), false, 'editing discards it, as every editor does');
});

// ---------------------------------------------------------------- moving, resizing, coalescing

test('a drag of one widget is a single undo step, however many edits it produced', () => {
    let next = withButton(10, 10);
    for (let x = 11; x <= 30; x += 1) {
        next = moveWidget(next, 'button', x, 10);
    }
    equal(next.document.widgets[0].x, 30, 'it moved');
    // One step for the add, one for the whole drag, however many moves it took.
    equal(next.past.length, 2, 'the drag collapsed into a single step');
    next = undo(next);
    equal(next.document.widgets[0].x, 10, 'one undo returns it to where the drag began');
});

test('two different widgets do not coalesce into one undo step', () => {
    let next = addWidget(withButton(), 'label', 0, 100);
    next = moveWidget(next, 'button', 20, 20);
    next = moveWidget(next, 'label', 30, 130);
    next = undo(next);
    equal(next.document.widgets.find((w) => w.id === 'label').x, 0, 'only the label moved back');
    equal(next.document.widgets.find((w) => w.id === 'button').x, 20, 'the button kept its move');
});

test('typing in a property field is one undo step per property', () => {
    let next = withButton();
    for (const text of ['G', 'GO', 'GO!']) {
        next = setProperty(next, 'button', 'text', text);
    }
    next = setProperty(next, 'button', 'corner_radius', 8);
    next = undo(next);
    equal(widgetById(next.document, 'button').props.corner_radius, 4, 'the radius went back');
    equal(widgetById(next.document, 'button').props.text, 'GO!', 'the text stayed');
});

test('a move cannot push a widget off the canvas', () => {
    const moved = moveWidget(withButton(), 'button', 9999, 9999);
    const widget = moved.document.widgets[0];
    equal(widget.x, 320 - widget.width, 'x is flush to the right edge');
    equal(widget.y, 480 - widget.height, 'y is flush to the bottom');
    const back = moveWidget(moved, 'button', -50, -50);
    equal(back.document.widgets[0].x, 0, 'and a negative move stops at the origin');
});

test('a resize cannot shrink a widget below a pixel or push it outside', () => {
    const resized = resizeWidget(withButton(10, 10), 'button', { x: 10, y: 10, width: 0, height: -5 });
    const widget = resized.document.widgets[0];
    equal(widget.width, 1, 'the width cannot be zero');
    equal(widget.height, 1, 'nor the height');
    const wide = resizeWidget(withButton(10, 10), 'button', { x: 10, y: 10, width: 9999, height: 9999 });
    equal(wide.document.widgets[0].width, 320 - 10, 'the width stops at the canvas edge');
    equal(wide.document.widgets[0].height, 480 - 10, 'and so does the height');
});

test('handlers are added and removed one at a time', () => {
    let next = toggleEvent(withButton(), 'button', 'clicked');
    equal(next.document.widgets[0].events.join(','), 'clicked', 'added');
    next = toggleEvent(next, 'button', 'longPressed');
    equal(next.document.widgets[0].events.join(','), 'clicked,longPressed', 'and another');
    next = toggleEvent(next, 'button', 'clicked');
    equal(next.document.widgets[0].events.join(','), 'longPressed', 'and removed');
});

test('the array order is the drawing order', () => {
    let next = addWidget(addWidget(state(), 'label', 0, 0), 'button', 0, 0);
    equal(next.document.widgets.map((w) => w.id).join(','), 'label,button', 'the button draws last, so on top');
    next = reorderWidget(next, 'button', 'down');
    equal(next.document.widgets.map((w) => w.id).join(','), 'button,label', 'and can be sent behind');
    equal(reorderWidget(next, 'button', 'down'), next, 'there is nothing below it');
    equal(reorderWidget(next, 'label', 'up'), next, 'nor above the one on top');
    next = reorderWidget(next, 'button', 'up');
    equal(next.document.widgets.map((w) => w.id).join(','), 'label,button', 'and back');
});

test('a click picks the widget drawn on top', () => {
    // Both at the same place: the engine draws the last one over the first, so that is the one a click means.
    const two = addWidget(addWidget(state(), 'label', 0, 0), 'button', 0, 0);
    equal(widgetAt(two.document, 10, 10).id, 'button', 'the topmost widget');
    equal(widgetAt(two.document, 400, 400), undefined, 'and nothing outside them');
    const reordered = reorderWidget(two, 'button', 'down');
    equal(widgetAt(reordered.document, 10, 10).id, 'label', 'after reordering, the label is on top');
});

test('the option list, the table and the icon parts can be replaced', () => {
    let next = addWidget(state(), 'dropdown', 0, 0);
    next = setChildren(next, 'dropdown', { kind: 'options', values: ['A'] });
    equal(next.document.widgets[0].children.values.join(','), 'A', 'the list');
    next = setChildren(next, 'dropdown', { kind: 'table', headers: ['x'], rows: [] });
    equal(next.document.widgets[0].children.kind, 'table', 'the body kind is whatever it is set to');
});

test('the screen fields and the rotation are editable', () => {
    let next = setScreenField(setScreenField(state(), 'screenId', 'Hmi'), 'theme', 'light');
    equal(next.document.screenId, 'Hmi', 'the id');
    equal(next.document.theme, 'light', 'the theme');
    next = setRotation(next, 3);
    equal(next.document.rotation, 3, 'the rotation');
    equal(canvasOf(next.document).width, 480, 'and the canvas turned with it');
});

// ---------------------------------------------------------------- hit testing

test('the selected widget\'s handles are live, and reach outside it', () => {
    const doc = addWidget(state(), 'button', 0, 0).document;
    const widget = doc.widgets[0];
    // The north-west handle sits on the corner, which is also the canvas origin.
    const corner = hitTest(doc, 0, 0, 'button');
    equal(corner.handle, 'nw', 'the corner handle');
    const reach = Math.floor(HANDLE_SIZE / 2);
    const outside = hitTest(doc, -reach, -reach, 'button');
    equal(outside?.handle, 'nw', 'and it is grabbable from outside the canvas');
    const middle = hitTest(doc, Math.floor(widget.width / 2), Math.floor(widget.height / 2), 'button');
    equal(middle.handle, undefined, 'the body is not a handle');
    equal(middle.id, 'button', 'but it is the widget');
});

test('handles belong to the selection only', () => {
    const doc = addWidget(addWidget(state(), 'label', 0, 0), 'button', 0, 0).document;
    // Nothing is selected, so the corner belongs to whatever is under it rather than to a handle.
    equal(hitTest(doc, 0, 0).handle, undefined, 'no handles without a selection');
    equal(hitTest(doc, 0, 0, 'label').handle, 'nw', 'the label\'s handle once it is selected');
});

test('a handle drag moves only the edges the handle owns', () => {
    const rect = { x: 10, y: 20, width: 100, height: 50 };
    equal(JSON.stringify(resizeFrom(rect, 'e', 5, 999)), JSON.stringify({ x: 10, y: 20, width: 105, height: 50 }));
    equal(JSON.stringify(resizeFrom(rect, 's', 999, 5)), JSON.stringify({ x: 10, y: 20, width: 100, height: 55 }));
    equal(JSON.stringify(resizeFrom(rect, 'nw', 4, 4)), JSON.stringify({ x: 14, y: 24, width: 96, height: 46 }));
    equal(JSON.stringify(resizeFrom(rect, 'se', 4, 4)), JSON.stringify({ x: 10, y: 20, width: 104, height: 54 }));
});

test('a handle drag cannot invert the widget it is resizing', () => {
    const rect = { x: 10, y: 10, width: 40, height: 40 };
    // The east edge is dragged 60px left, which is past the west edge at x=10.
    const shrunk = resizeFrom(rect, 'e', -60, 0);
    equal(shrunk.width, MIN_SIZE, 'the width stops at one pixel rather than going negative');
    equal(shrunk.x, 10, 'and the edge it is anchored to stayed put');
    const collapsed = resizeFrom(rect, 'e', -40, -40);
    equal(collapsed.width, MIN_SIZE, 'the dragged axis stops at the minimum');
    equal(collapsed.height, 40, 'and the untouched axis is untouched');
});

// ---------------------------------------------------------------- snapping

test('the snap targets are the canvas and the neighbours, never the dragged widget itself', () => {
    const doc = addWidget(addWidget(state(), 'label', 100, 200), 'button', 10, 10).document;
    const { xs, ys } = snapTargets(doc, 'button');
    ok(xs.includes(0) && xs.includes(320) && xs.includes(160), `canvas x targets, got ${xs.join(',')}`);
    ok(ys.includes(0) && ys.includes(480) && ys.includes(240), 'canvas y targets');
    ok(xs.includes(100), 'the neighbour\'s left edge');
    notOk(xs.includes(10), 'the dragged widget\'s own edges are not targets');
});

test('the nearest target within tolerance wins, and nothing beyond it', () => {
    equal(bestSnap(103, [0, 100, 320]), 100, 'the neighbour');
    equal(bestSnap(103, [0, 105, 320]), 105, 'the closer of two');
    equal(bestSnap(103, [0, 320]), undefined, 'nothing within tolerance');
    equal(bestSnap(110, [100], SNAP_TOLERANCE), undefined, 'exactly at the limit is outside it');
    equal(bestSnap(106, [100]), 100, 'at the limit is inside it');
});

test('a drag with nothing near falls back to the grid', () => {
    equal(gridSnap(103), 104, 'the nearest grid line');
    equal(gridSnap(102), 104, 'and the other side of the tie');
    const moved = snapMove({ x: 103, y: 103, width: 40, height: 20 }, { xs: [], ys: [] }, { width: 320, height: 480 });
    equal(`${moved.x},${moved.y}`, `${GRID_STEP * 26},${GRID_STEP * 26}`, 'both axes snapped to the grid');
    equal(moved.guides.length, 0, 'and no guide lines, because nothing was aligned to');
});

test('a drag snaps by whichever edge is closest, and says which', () => {
    const rect = { x: 102, y: 40, width: 40, height: 20 };
    const moved = snapMove(rect, { xs: [100], ys: [] }, { width: 320, height: 480 });
    equal(moved.x, 100, 'the left edge took the snap');
    equal(moved.guides.find((g) => g.axis === 'x').position, 100, 'and the guide is drawn there');

    // The right edge is nearer than the left, so the widget is placed by its right edge instead.
    const byRight = snapMove({ x: 58, y: 40, width: 40, height: 20 }, { xs: [100], ys: [] }, { width: 320, height: 480 });
    equal(byRight.x, 60, 'the right edge took the snap, so the left moved to match');
    equal(byRight.guides.find((g) => g.axis === 'x').position, 100, 'the guide is still the target');
});

test('a snapped drag is still kept inside the canvas', () => {
    const moved = snapMove({ x: -10, y: -10, width: 40, height: 20 }, { xs: [0], ys: [0] }, { width: 320, height: 480 });
    equal(`${moved.x},${moved.y}`, '0,0', 'it cannot be dragged out through the top-left');
    const far = snapMove({ x: 310, y: 470, width: 40, height: 20 }, { xs: [320], ys: [480] }, { width: 320, height: 480 });
    equal(`${far.x},${far.y}`, `${320 - 40},${480 - 20}`, 'nor out through the bottom-right');
});

// ---------------------------------------------------------------- fonts

test('declaring a font from a file names it after the file and selects it, in one step', () => {
    // What the `...` beside a widget's Font does. Doing it as `add` then `rename` then `select` would leave two
    // undo steps that are each half a change, so it is one.
    const state1 = addWidget(state(), 'label', 10, 10);
    const declared = declareFontFromPath(state1, 'label', 'assets/hero.bdf');
    equal(declared.document.fonts.length, 1, 'the file becomes a declaration');
    equal(declared.document.fonts[0].id, 'hero', 'named after the file, without the extension');
    equal(declared.document.fonts[0].src, 'assets/hero.bdf', 'pointing at it');
    equal(
        declared.document.widgets.find((widget) => widget.id === 'label').props.font,
        'hero',
        'and the widget that asked for it now names it',
    );
    equal(validateDocument(declared.document).length, 0, 'which is a valid design');

    // A name the generated Rust constant cannot be built from is sanitised, and a second file with the same
    // stem is a duplicate the user meant to make rather than a refusal.
    const awkward = declareFontFromPath(state1, 'label', 'assets/my-font 2.bdf');
    equal(awkward.document.fonts[0].id, 'my_font_2', 'punctuation becomes an underscore');
    equal(
        declareFontFromPath(awkward, 'label', 'assets/hero.bdf').document.fonts.map((font) => font.id).join(','),
        'my_font_2,hero',
        'a new stem appends',
    );
    const twice = declareFontFromPath(declared, 'label', 'assets/hero.bdf');
    equal(twice.document.fonts.map((font) => font.id).join(','), 'hero,hero_2', 'the same stem does not collide');
    equal(twice.document.fonts[1].src, 'assets/hero.bdf', 'and still points at the file that was chosen');

    // One step: the declaration and the reference go away together.
    const undone = undo(declared);
    equal(undone.document.fonts.length, 0, 'undo removes the declaration');
    equal(
        undone.document.widgets.find((widget) => widget.id === 'label').props.font,
        '',
        'and the reference with it',
    );
    equal(undo(twice).document.fonts.length, 1, 'undoing the second declaration leaves the first alone');
});

test('a font can be added, renamed and removed, and its name follows the widgets', () => {
    // A label, because `font` is a property of the tags that draw text.
    let next = addFont(addWidget(state(), 'label', 10, 10));
    equal(next.document.fonts.length, 1, 'added');
    equal(next.document.fonts[0].id, 'font', 'with a plain name');
    equal(next.document.fonts[0].src, '', 'and no file chosen yet');

    // A second font gets a different name rather than colliding with the first.
    next = addFont(next);
    equal(next.document.fonts.map((font) => font.id).join(','), 'font,font_2', 'the second is named apart');

    next = setFontField(next, 'font', 'src', 'assets/title.bdf');
    next = setFontField(next, 'font', 'chars', '0123456789');
    equal(next.document.fonts[0].src, 'assets/title.bdf', 'the file');
    equal(next.document.fonts[0].chars, '0123456789', 'and the character set');

    // A widget pointed at it, then the font is renamed: the reference has to follow, or the design breaks.
    next = setProperty(next, 'label', 'font', 'font');
    next = setFontField(next, 'font', 'id', 'title');
    equal(next.document.fonts[0].id, 'title', 'renamed');
    equal(
        next.document.widgets.find((widget) => widget.id === 'label').props.font,
        'title',
        'and the widget that named it was renamed with it',
    );

    // Undo covers the rename as one step, name and references together.
    next = undo(next);
    equal(next.document.fonts[0].id, 'font', 'the font name came back');
    equal(
        next.document.widgets.find((widget) => widget.id === 'label').props.font,
        'font',
        'and so did the reference',
    );

    next = removeFont(next, 'font');
    equal(next.document.fonts.map((font) => font.id).join(','), 'font_2', 'the font is gone');
    equal(
        next.document.widgets.find((widget) => widget.id === 'label').props.font,
        '',
        'and nothing is left pointing at it',
    );
});

test('adding a font is one undo step', () => {
    const withOne = addFont(state());
    equal(undo(withOne).document.fonts.length, 0, 'undone');
});

test('a duplicate is a separate widget, placed beside the original', () => {
    const original = withButton(10, 10);
    const copy = duplicateWidget(original, 'button');
    equal(copy.document.widgets.length, 2, 'there are two now');
    const made = copy.document.widgets[1];
    equal(made.id, 'button_2', 'with a free name');
    equal(made.tag, 'button', 'the same kind');
    equal(`${made.x},${made.y}`, '18,18', 'placed a little down and right, so it can be seen');
    equal(made.width, original.document.widgets[0].width, 'the same size');

    // Editing the copy must not touch the original: the two share nothing.
    const renamed = setProperty(copy, 'button_2', 'text', 'Copy');
    equal(widgetById(renamed.document, 'button').props.text, 'Button', 'the original is untouched');
    equal(widgetById(renamed.document, 'button_2').props.text, 'Copy', 'and the copy took the change');

    // One undo step, like adding.
    equal(undo(copy).document.widgets.length, 1, 'undo removes the copy');
});

test('duplicating near an edge keeps the copy inside the canvas', () => {
    const far = moveWidget(withButton(), 'button', 319, 479);
    const copy = duplicateWidget(far, 'button');
    const made = copy.document.widgets[1];
    ok(made.x + made.width <= 320 && made.y + made.height <= 480, `the copy is inside, got ${made.x},${made.y}`);
});
