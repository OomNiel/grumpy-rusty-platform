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
    setTriangleGeometry,
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
    VERTEX_HANDLE_SIZE,
    vertexHandles,
    MIN_SIZE,
    SNAP_TOLERANCE,
    GRID_STEP,
} = compiled('designer/hit');
const {
    DEFAULT_TRIANGLE_POINTS,
    TRIANGLE_POINT_NAMES,
    triangleBoxOf,
    triangleFromVertices,
    trianglePoints,
    triangleVertex,
    triangleVertices,
    validateDocument,
} = compiled('designer/model');

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

// ---------------------------------------------------------------- a triangle's three points

/** A design with one dropped triangle on it, which is 64x56 at 100,50 with the catalogue's own points. */
function withTriangle(x = 100, y = 50) {
    const made = addWidget(state(), 'triangle', x, y);
    return made;
}

test('a dropped triangle carries its three points, and the default is the old isosceles shape', () => {
    const widget = withTriangle().document.widgets[0];
    // Six attributes, so the markup never has to rely on the parser's fallback for a widget the designer made.
    for (const name of TRIANGLE_POINT_NAMES) {
        ok(typeof widget.props[name] === 'number', `a dropped triangle has ${name}`);
    }
    const box = triangleBoxOf(widget);
    const [apex, left, right] = triangleVertices(box);
    // The apex is the top centre and the base is the box's *last* row: `p = 1000` measures the cell's final
    // pixel, which is the same rule the crate renders with, so no point can leave the cell.
    equal(`${apex.x},${apex.y}`, `${box.x + Math.floor(box.width / 2)},${box.y}`, 'the apex is the top centre');
    equal(left.y, box.y + box.height - 1, 'the base sits on the last row');
    equal(right.y, left.y, 'both base corners on it');
    equal(right.x, box.x + box.width - 1, 'and the base spans the last column too');
    // An isosceles triangle, which is what every design made before the points existed has.
    equal(box.x + box.width - 1 - right.x, 0, 'the right corner is the box corner');
    equal(left.x, box.x, 'the left one too');
    // Centred to within a pixel: an even-width box has two middle columns, and the apex lands on the right
    // one of them (the crate's `floor` of 500 per-mille). It is the same column the board paints on.
    equal(Math.abs(apex.x - left.x - (right.x - apex.x)) <= 1, true, 'so the apex is the middle column');
});

test('dragging a point moves the box around it and leaves the other two on their pixels', () => {
    const one = withTriangle();
    const widget = one.document.widgets[0];
    const vertices = triangleVertices(triangleBoxOf(widget));

    // Drag the apex up and to the right, off the original box: the user asked to be able to put a point
    // anywhere on the glass, so the box has to follow rather than hold the point inside itself.
    const wanted = { x: 200, y: 10 };
    const moved = setTriangleGeometry(
        one,
        widget.id,
        triangleFromVertices([wanted, vertices[1], vertices[2]]),
    );
    const after = moved.document.widgets[0];
    equal(`${after.x},${after.y}`, '100,10', 'the box grew upwards to hold the dragged point');
    // 100..200 across (the dragged point is right of both base corners) and 10..105 down: the bounding box of
    // the three points, which is wider than the original 64 because the point left the box to the right.
    equal(`${after.width},${after.height}`, '101,96', 'and is the bounding box of all three points');

    const now = triangleVertices(triangleBoxOf(after));
    equal(`${now[0].x},${now[0].y}`, '200,10', 'the dragged point is exactly where it was let go');
    equal(`${now[1].x},${now[1].y}`, `${vertices[1].x},${vertices[1].y}`, 'the second point has not stirred');
    equal(`${now[2].x},${now[2].y}`, `${vertices[2].x},${vertices[2].y}`, 'nor the third');

    // One undo step for a whole drag: forty mouse-moves are not forty presses of Ctrl+Z.
    const again = setTriangleGeometry(
        moved,
        widget.id,
        triangleFromVertices([{ x: 210, y: 5 }, vertices[1], vertices[2]]),
    );
    const restored = undo(again);
    equal(restored.document.widgets[0].height, 56, 'one undo takes back the whole drag, not just one move');
    equal(
        restored.document.widgets[0].props.p1x,
        widget.props.p1x,
        'and restores the points it started with',
    );
    equal(undo(restored).document.widgets.length, 0, 'the step before it is the add, as it was before');
});

test('the per-mille offsets round-trip through the crate\'s own arithmetic, pixel for pixel', () => {
    // The crate measures forward with a truncating division (`p * size / 1000`), so this is the check that the
    // designer's numbers put a point back on the pixel the user let go of -- for every pixel of every box
    // shape a grid can produce, not only for the ones that happen to divide evenly.
    for (const [width, height] of [[64, 56], [1, 1], [7, 3], [200, 150], [13, 29], [320, 480], [479, 3]]) {
        for (let px = 0; px < width; px += Math.max(1, Math.floor(width / 17))) {
            const vertices = [{ x: px, y: 0 }, { x: 0, y: height - 1 }, { x: width - 1, y: height - 1 }];
            const box = triangleFromVertices(vertices);
            equal(box.x, 0, 'the box starts at the leftmost point');
            equal(box.y, 0, 'and at the topmost');
            equal(box.width, width, `the box spans the points, got ${box.width} for ${width}`);
            equal(box.height, height, `and vertically, got ${box.height} for ${height}`);
            const back = triangleVertex(box, 0);
            equal(`${back.x},${back.y}`, `${px},0`, `pixel ${px} of a ${width}-wide box comes back`);
        }
    }
});

test('a point dragged off the canvas is brought back in, so it can still be grabbed', () => {
    const one = withTriangle();
    const widget = one.document.widgets[0];
    const vertices = triangleVertices(triangleBoxOf(widget));
    const canvas = canvasOf(one.document);
    // The canvas clamps the pointer, but the rule belongs here too: a point outside the panel is one the
    // engine clips and the pointer can never reach again.
    const outside = setTriangleGeometry(
        one,
        widget.id,
        triangleFromVertices([{ x: -40, y: -30 }, vertices[1], vertices[2]]),
    );
    const after = outside.document.widgets[0];
    const now = triangleVertices(triangleBoxOf(after));
    equal(now[0].x, 0, 'the leftmost point is on the left edge');
    equal(now[0].y, 0, 'and on the top edge');
    ok(after.x >= 0 && after.y >= 0, 'so the box starts inside the canvas');
    ok(
        after.x + after.width <= canvas.width && after.y + after.height <= canvas.height,
        `and stays inside it, got ${after.x},${after.y} ${after.width}x${after.height}`,
    );
});

test('a triangle\'s point handle wins over the box handle it sits on, and only while selected', () => {
    const one = withTriangle();
    const widget = one.document.widgets[0];
    const [apex] = triangleVertices(triangleBoxOf(widget));
    // The apex and the box's north handle are the same pixel -- that is the point of the priority: a click
    // there has to mean "move this point", which is the thing a triangle has and a box does not.
    equal(apex.x, widget.x + Math.floor(widget.width / 2), 'the apex is where the north handle is');
    equal(apex.y, widget.y, 'on the same row');

    const onApex = hitTest(one.document, apex.x, apex.y, widget.id);
    equal(onApex.id, widget.id, 'the click is on the triangle');
    equal(onApex.vertex, 0, 'and it grabbed the first point');
    equal(onApex.handle, undefined, 'not the box handle underneath it');

    // The other seven edges are still resizable: only the point wins.
    const west = hitTest(one.document, widget.x, widget.y + Math.floor(widget.height / 2), widget.id);
    equal(west.handle, 'w', 'the west edge is still a box handle');
    equal(west.vertex, undefined, 'and not a point');

    // Unselected, there are no point handles at all: a click on the body is a plain selection.
    const unselected = hitTest(one.document, apex.x, apex.y, undefined);
    equal(unselected.id, widget.id, 'the click still selects the triangle');
    equal(unselected.vertex, undefined, 'but grabs no point');

    // And no other tag has them, however big its box is.
    const button = addWidget(state(), 'button', 10, 10);
    equal(vertexHandles(button.document.widgets[0]).length, 0, 'a button has no points to drag');
    equal(vertexHandles(widget).length, 3, 'a triangle has three');
    equal(VERTEX_HANDLE_SIZE > HANDLE_SIZE, true, 'and they are the easier target to hit');
});

test('a design written before the points existed keeps the default triangle', () => {
    // This is the compatibility promise: six new properties must not make an older design invalid, because the
    // crate's parser defaults each of them to the same isosceles triangle.
    const one = withTriangle();
    const widget = one.document.widgets[0];
    for (const name of TRIANGLE_POINT_NAMES) {
        delete widget.props[name];
    }
    equal(validateDocument(one.document).length, 0, 'an older design is still valid');
    equal(
        trianglePoints(widget).join(','),
        DEFAULT_TRIANGLE_POINTS.join(','),
        'and reads back as the default triangle',
    );
    // Half a set is the same deal, offset by offset, exactly as the parser reads it.
    widget.props.p1x = 0;
    equal(trianglePoints(widget)[0], 0, 'the one it names is used');
    equal(trianglePoints(widget)[1], 0, 'and the rest keep the crate\'s value');
});
