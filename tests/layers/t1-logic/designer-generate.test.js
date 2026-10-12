'use strict';

/**
 * What a Designer project is born with.
 *
 * The starter design and the Rust that drives it are the only things standing between "the wizard made a
 * project" and "the board draws the design", so they are worth pinning: the design must validate, the markup
 * must be the one the simulator proved, and the handler file must be extendable without ever being rewritten
 * -- that last one is the promise that makes it the user's file.
 */

const { test, ok, notOk, equal, contains, notContains, compiled } = require('../../lib/harness');
const {
    PINNED_SCREEN_ID,
    UI_MARKER,
    HANDLERS_MARKER,
    DESIGNER_FILES,
    starterDocument,
    emitStarterKdl,
    emitUiRs,
    emitHandlersRs,
    appendHandlerStubs,
    pruneHandlerStubs,
    syncHandlerStubs,
    requiredHandlers,
    handlerName,
    missingFromGeneratedCode,
} = compiled('designer/generate');
const { validateDocument, designCanvasSize } = compiled('designer/model');

const CYD = { boardId: 'sunton-3248s035r', panelWidth: 320, panelHeight: 480 };
const TQT = { boardId: 'lilygo-tqt', panelWidth: 128, panelHeight: 128 };

// ---------------------------------------------------------------- the starter design

test('a new designer project starts with a valid design, on both panel boards', () => {
    for (const board of [CYD, TQT]) {
        for (const rotation of [0, 1, 2, 3]) {
            const document = starterDocument({ ...board, rotation });
            const problems = validateDocument(document);
            equal(problems.length, 0, `${board.boardId} at rotation ${rotation}: ${problems[0] ?? ''}`);
        }
    }
});

test('the starter design is tiny, complete and inside the canvas', () => {
    const document = starterDocument({ ...CYD, rotation: 3 });
    equal(document.screenId, PINNED_SCREEN_ID, 'the screen id is the pinned one');
    equal(document.widgets.map((w) => w.tag).join(','), 'label,button', 'a title and something to press');

    const button = document.widgets.find((w) => w.id === 'go');
    equal(button.events.join(','), 'clicked', 'the button is wired to an event, so the handler file has an example');
    const canvas = designCanvasSize(CYD.panelWidth, CYD.panelHeight, 3);
    equal(canvas.width, 480, 'the landscape canvas');
    for (const widget of document.widgets) {
        ok(widget.x >= 0 && widget.y >= 0, `${widget.id} starts inside`);
        ok(widget.x + widget.width <= canvas.width, `${widget.id} fits across`);
        ok(widget.y + widget.height <= canvas.height, `${widget.id} fits down`);
    }
});

test('the starter button fits the smallest panel in the catalogue', () => {
    // The T-QT is 128 px across: a starter design that assumed a landscape 480 would not fit it.
    const document = starterDocument({ ...TQT, rotation: 0 });
    const button = document.widgets.find((w) => w.id === 'go');
    ok(button.width <= 128 && button.height <= 128, `the button is ${button.width}x${button.height}`);
    ok(button.width >= 64, 'and it is still big enough to hit with a finger');
});

test('the starter markup is the design, laid out in pixel tracks', () => {
    const kdl = emitStarterKdl(starterDocument({ ...CYD, rotation: 3 }));
    contains(kdl, `screen id="${PINNED_SCREEN_ID}" width=480 height=320`, 'the rotated screen');
    contains(kdl, 'gap=0 padding=0', 'the zero-gap grid the mapping depends on');
    contains(kdl, 'label id="title"', 'the title');
    contains(kdl, 'button id="go"', 'the button');
    // A design project's markup must carry the zero-width filler, or the board dies before it paints: a grid
    // with no fractional track divides by zero in the crate's track resolution (found on hardware).
    contains(kdl, ` ${'1fr'}"`, 'the zero-width filler track each axis carries');
});

// ---------------------------------------------------------------- the generated Rust

test('the generated Rust is the barrel: markup, budgets, plumbing and the dispatch', () => {
    const document = starterDocument({ ...CYD, rotation: 3 });
    const rust = emitUiRs(document);

    contains(rust, `embedded_gui::include_gui!("${DESIGNER_FILES.markup}")`, 'it compiles the markup');
    contains(rust, UI_MARKER, 'and is marked as generated');
    contains(rust, `design::${PINNED_SCREEN_ID}App::NODE_COUNT + 8`, 'the node budget follows the markup');
    contains(rust, 'pub fn new(width: u32, height: u32)', 'the constructor takes the drawn size');
    contains(rust, 'pub fn pointer(&mut self, x: i32, y: i32, down: bool)', 'the pointer entry point');
    contains(rust, 'InputEvent::Pointer', 'which sends the crate\'s own input event');
    contains(rust, 'PointerState::Moved', 'and moves, so a slider can follow a finger');
    contains(rust, 'pub fn pump(&mut self)', 'the dispatch');
    contains(rust, 'pub fn is_dirty(&self) -> bool', 'the dirty check');
    contains(rust, 'pub fn repaint<D>', 'and a forced full paint for after a calibration');
    contains(rust, 'self.gui.render_dirty(target)', 'later frames honour the damage rectangles');
});

test('every event the design asks for becomes a match arm calling its handler by name', () => {
    const document = starterDocument({ ...CYD, rotation: 3 });
    const rust = emitUiRs(document);
    contains(
        rust,
        'UiEvent::Clicked(id) if id == self.widgets.go => crate::ui_handlers::on_go_clicked(),',
        'the arm',
    );
});

test('the two events that carry a payload bind it rather than assuming a newtype', () => {
    // `Scroll` carries a delta and `TextInput` a character; generated code that assumed `Variant(id)`
    // everywhere would fail to compile on exactly these two.
    const document = starterDocument({ ...CYD, rotation: 3 });
    document.widgets.push({
        id: 'list',
        tag: 'table',
        x: 0,
        y: 0,
        width: 100,
        height: 60,
        props: {},
        events: ['scroll'],
        children: { kind: 'table', headers: ['A'], rows: [['1']] },
    });
    const rust = emitUiRs(document);
    contains(rust, 'UiEvent::Scroll { id, delta } if id == self.widgets.list => crate::ui_handlers::on_list_scroll(delta),', 'the scroll arm passes the delta on');
    // The signature is declared in the handlers file; the barrel only calls it.
    contains(emitHandlersRs(document), 'pub fn on_list_scroll(delta: i32)', 'and its handler takes the delta');
    contains(appendHandlerStubs('', document), 'pub fn on_list_scroll(delta: i32)', 'appending it declares the same');
});

test('a design with no events still generates a match that compiles', () => {
    const document = starterDocument({ ...CYD, rotation: 3 });
    document.widgets = document.widgets.map((widget) => ({ ...widget, events: [] }));
    const rust = emitUiRs(document);
    contains(rust, 'No widget in this design raises an event yet.', 'the placeholder arm');
    contains(rust, '_ => {}', 'and the catch-all');
    equal(requiredHandlers(document).length, 0, 'nothing to declare');

    // And it builds without a warning. With no arms, nothing in the file reads `widgets`, so the compiler calls
    // the handle dead — which is a warning in every generated project whose design raises no event (found by
    // building one, 2026-10-12). The attribute is conditional, so a design that *does* raise an event still
    // hears about the handle if it is genuinely unused.
    contains(rust, '#[allow(dead_code)]\n    pub widgets:', 'the handle is allowed to be unread');
    notContains(
        emitUiRs(starterDocument({ ...CYD, rotation: 3 })),
        '#[allow(dead_code)]\n    pub widgets:',
        'a design with an event reads it, so no allow is needed',
    );
});

// ---------------------------------------------------------------- the handler file

test('the handler file starts with a stub for every event the design raises', () => {
    const rust = emitHandlersRs(starterDocument({ ...CYD, rotation: 3 }));
    contains(rust, HANDLERS_MARKER, 'it is marked as ours to append to');
    contains(rust, 'pub fn on_go_clicked()', 'the stub');
    contains(rust, 'design: on_go_clicked fired', 'with something to show in the log');
});

test('appending is idempotent, and never touches a handler that is already written', () => {
    const document = starterDocument({ ...CYD, rotation: 3 });
    const first = emitHandlersRs(document);
    equal(appendHandlerStubs(first, document), first, 'a second save adds nothing');

    // What the user does to a handler: body replaced, kept private, and moved to the top of the file.
    const edited = first.replace(
        'pub fn on_go_clicked() {\n    log::info!("design: on_go_clicked fired");\n}',
        'fn on_go_clicked() {\n    // do something worth doing\n}',
    );
    equal(appendHandlerStubs(edited, document), edited, 'a private, rewritten handler is left alone');
});

test('a newly ticked event is appended, and only the missing one', () => {
    const document = starterDocument({ ...CYD, rotation: 3 });
    const before = emitHandlersRs(document);
    document.widgets = document.widgets.map((widget) =>
        widget.id === 'go' ? { ...widget, events: ['clicked', 'longPressed'] } : widget,
    );

    const after = appendHandlerStubs(before, document);
    contains(after, 'pub fn on_go_clicked()', 'the existing handler is still there');
    contains(after, 'pub fn on_go_long_pressed()', 'and the new one was appended');
    equal(after.split('pub fn on_go_clicked').length - 1, 1, 'exactly once');
    equal(appendHandlerStubs(after, document), after, 'and appending again changes nothing');
});

// A deleted widget takes its generated stub with it (asked 2026-10-12) -- but only the stub. A handler someone
// has written in is theirs, and a widget going away must not erase it.
test('deleting a widget removes its generated stub, and nothing else', () => {
    const document = starterDocument({ ...CYD, rotation: 3 });
    const withStubs = emitHandlersRs(document);
    const withoutGo = { ...document, widgets: document.widgets.filter((widget) => widget.id !== 'go') };
    equal(requiredHandlers(withoutGo).length, 0, 'nothing needs a handler once the widget is gone');

    const pruned = pruneHandlerStubs(withStubs, withoutGo);
    notContains(pruned, 'pub fn on_go_clicked', 'the stub is gone');
    notContains(pruned, 'design: on_go_clicked fired', 'and so is its body');
    contains(pruned, HANDLERS_MARKER, 'while the file itself is still marked as ours');
    equal(pruneHandlerStubs(pruned, withoutGo), pruned, 'and pruning again changes nothing');

    // The same deletion, on a handler that now does something: it stays.
    const written = withStubs.replace(
        'pub fn on_go_clicked() {\n    log::info!("design: on_go_clicked fired");\n}',
        'pub fn on_go_clicked() {\n    self.level += 1;\n}',
    );
    equal(pruneHandlerStubs(written, withoutGo), written, 'a handler that does something is never removed');

    // And a handler the design still needs is not touched at all.
    equal(pruneHandlerStubs(withStubs, document), withStubs, 'nothing to prune while the widget is there');
});

test('one save both appends what is new and prunes what is gone', () => {
    const document = starterDocument({ ...CYD, rotation: 3 });
    const before = emitHandlersRs(document);
    const title = document.widgets.find((widget) => widget.id === 'title');
    // The same save: the button is deleted, and the label gains an event.
    const next = {
        ...document,
        widgets: [
            ...document.widgets.filter((widget) => widget.id !== 'go'),
            { ...title, events: ['clicked'] },
        ],
    };

    const after = syncHandlerStubs(before, next);
    contains(after, 'pub fn on_title_clicked()', 'the new event got its stub');
    notContains(after, 'pub fn on_go_clicked', 'and the deleted widget\'s stub went with it');
    equal(syncHandlerStubs(after, next), after, 'a second save changes nothing');
});

test('a handler name follows the widget id into snake case', () => {
    // The generated struct field is `to_snake_case(id)`, and the handler has to be reachable from the arm
    // that matches it, so the two must agree on the name.
    equal(handlerName('go', 'clicked'), 'on_go_clicked');
    equal(handlerName('SaveBtn', 'doubleClicked'), 'on_save_btn_double_clicked');
    equal(handlerName('level_2', 'valueChanged'), 'on_level_2_value_changed');
});

// ---------------------------------------------------------------- what codegen cannot carry

test('a screen id that the generated Rust does not name is reported, not silently generated', () => {
    const document = starterDocument({ ...CYD, rotation: 3 });
    equal(missingFromGeneratedCode(document).length, 0, 'the pinned id is fine');
    document.screenId = 'MyPanel';
    const problems = missingFromGeneratedCode(document);
    equal(problems.length, 1, JSON.stringify(problems));
    contains(problems[0], PINNED_SCREEN_ID, 'the message names the id it has to be');
});

test('a widget the generated code cannot name is reported if it is asked to raise events', () => {
    const document = starterDocument({ ...CYD, rotation: 3 });
    document.widgets.push({
        id: 'gap',
        tag: 'spacer',
        x: 0,
        y: 0,
        width: 8,
        height: 8,
        props: {},
        events: [],
    });
    equal(missingFromGeneratedCode(document).length, 0, 'a spacer with no events is fine');
});
