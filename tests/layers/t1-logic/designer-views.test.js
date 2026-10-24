'use strict';

/**
 * Views: more than one screenful of widgets in one design.
 *
 * A view is a *layer* of the one screen rather than a second screen. Two things follow from that, and both are
 * what these tests are about: the markup does not change at all (every widget is emitted, so the crate's parser
 * and the goldens stay as they were), and the generated `ui.rs` is where a view exists -- it hides the widgets
 * of the views that are not on show, using the runtime's own hidden flag.
 *
 * The other half is the document: a design that names a view nothing has, or two views that become the same
 * Rust variant, is a build error waiting to happen, so the validator refuses both.
 */

const { test, ok, notOk, equal, contains, notContains, compiled } = require('../../lib/harness');
const { loadDocument, renderDesign } = compiled('designer/store');
const {
    createDocument,
    defaultChildren,
    defaultProps,
    designViews,
    startViewId,
    validateDocument,
    viewEnumName,
    widgetViewId,
    widgetsInView,
    DESIGNER_FILE_VERSION,
} = compiled('designer/model');
const { emitKdl } = compiled('designer/kdl');
const { emitUiRs } = compiled('designer/generate');
const { requiredHandlers } = compiled('designer/generate');
const {
    addView,
    assignView,
    initialState,
    freeViewId,
    removeView,
    renameView,
    setViewLabel,
    toggleEvent,
    undo,
    viewsOf,
    widgetAt,
} = compiled('designer/state');
const { hitTest } = compiled('designer/hit');

function document(widgets = []) {
    const doc = createDocument({
        boardId: 'sunton-3248s035r',
        panelWidth: 320,
        panelHeight: 480,
        rotation: 0,
        screenId: 'Panel',
    });
    doc.widgets = widgets;
    return doc;
}

function widget(id, tag, box, props = {}) {
    return {
        id,
        tag,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        props: { ...defaultProps(tag), ...props },
        events: [],
        children: defaultChildren(tag),
    };
}

/** A design with two views: `main` holding a label, `settings` holding a button. */
function twoViewDocument() {
    const doc = document([
        widget('title', 'label', { x: 0, y: 0, width: 120, height: 20 }),
        widget('open', 'button', { x: 0, y: 40, width: 120, height: 32 }),
    ]);
    doc.views = [
        { id: 'main', label: 'Main' },
        { id: 'settings', label: 'Settings' },
    ];
    doc.widgets[1].view = 'settings';
    return doc;
}

test('a design with no views is the single view it always was', () => {
    const doc = document([widget('title', 'label', { x: 0, y: 0, width: 40, height: 20 })]);
    equal(designViews(doc).map((view) => view.id), ['main'], 'the implicit first view is called main');
    equal(startViewId(doc), 'main', 'and it is the one the board starts on');
    equal(widgetViewId(doc, doc.widgets[0]), 'main', 'a widget that names no view belongs to it');
});

test('a widget naming a view the design does not have is refused', () => {
    const doc = document([widget('title', 'label', { x: 0, y: 0, width: 40, height: 20 })]);
    doc.widgets[0].view = 'settings';
    const problems = validateDocument(doc);
    ok(
        problems.some((problem) => problem.includes('belongs to view "settings"')),
        `expected a problem about the missing view, got ${JSON.stringify(problems)}`,
    );
});

test('two views that become the same Rust variant are refused', () => {
    // `view_1` and `View1` both become `View1`, and the generated enum would not compile. The validator says so
    // while the tab is still on screen, which is the whole point of owning the naming rule on both sides.
    const doc = document();
    doc.views = [
        { id: 'main', label: 'Main' },
        { id: 'view_1', label: 'One' },
        { id: 'view1', label: 'Also one' },
    ];
    const problems = validateDocument(doc);
    ok(
        problems.some((problem) => problem.includes('becomes View1 in the generated code')),
        `expected a variant clash, got ${JSON.stringify(problems)}`,
    );
    equal(viewEnumName('scr_settings'), 'ScrSettings', 'the variant is the id in CamelCase');
});

test('a stored version 2 design still loads, and stays a one-view design', () => {
    // The shape is additive: `views` and `widget.view` were simply absent, and the code already treats an
    // absent view as the first one -- so nothing has to be rewritten on load.
    const stored = JSON.stringify({
        version: 2,
        boardId: 'sunton-3248s035r',
        panelWidth: 320,
        panelHeight: 480,
        rotation: 0,
        screenId: 'Panel',
        theme: 'dark',
        fonts: [],
        widgets: [widget('title', 'label', { x: 0, y: 0, width: 40, height: 20 })],
    });
    const loaded = loadDocument(stored);
    equal(loaded.error, undefined, 'a version 2 file is migrated, not refused');
    equal(loaded.document.version, DESIGNER_FILE_VERSION, 'and stamped with the current version');
    equal(loaded.document.views, undefined, 'without inventing a view list the user never asked for');
    equal(designViews(loaded.document).length, 1, 'and it reads as one view');
    notOk(loaded.document.widgets[0].view !== undefined, 'nor a view on the widget');
});

test('the markup does not change: every view is emitted, and visibility is the Rust side', () => {
    // The design decision that keeps this cheap. If the markup grew a per-view container, the codegen would have
    // to learn nesting; instead every widget is written as it always was, and `ui.rs` hides what is not on show.
    const single = document([widget('title', 'label', { x: 0, y: 0, width: 120, height: 20 })]);
    const two = twoViewDocument();
    const oneViewMarkup = emitKdl(single);
    notContains(oneViewMarkup, 'visible', 'a one-view design says nothing about visibility');
    notContains(emitKdl(two), 'visible', 'and neither does a two-view one');
    contains(emitKdl(two), 'label id="title"', 'the first view is emitted');
    contains(emitKdl(two), 'button id="open"', 'and so is the second');
});

test('the generated ui.rs is where a view lives', () => {
    const two = twoViewDocument();
    const ui = emitUiRs(two);
    contains(ui, 'pub enum View {', 'the app gets an enum to name');
    contains(ui, '    Main,', 'one variant per view');
    contains(ui, '    Settings,');
    contains(ui, '    view: View,', 'the design remembers which one is on show');
    contains(ui, 'pub fn show_view(&mut self, view: View) {', 'and can switch');
    contains(ui, 'pub fn active_view(&self) -> View {', 'and be asked');
    contains(
        ui,
        'let _ = self.gui_mut().set_visible(id, view == View::Settings);',
        'the runtime is told per widget, which is what a hidden node already understands',
    );
    contains(ui, 'set_visible(id, false)', 'and the other views are out of sight before the first frame');

    // The enum goes above the struct, not inside its documentation. Splice it in lower and the struct loses its
    // own doc line -- and, on a board with no touchscreen, the `#[allow(dead_code)]` that keeps `pointer` and
    // `pump` from warning in a design that raises no event. Found by compiling a two-view DevKitC project.
    const noTouch = emitUiRs(two, false);
    contains(noTouch, '/// The screen, and the pointer state', 'the struct keeps its own doc line');
    contains(noTouch, '#[allow(dead_code)]\npub struct Designer {', 'and the no-touch allowance stays on it');
    notContains(noTouch, 'as a pair.\n/// Which view', 'the enum is not spliced into the struct documentation');

    // A one-view design generates exactly what it generated before views existed: no enum, no field, no method.
    const single = emitUiRs(document([widget('title', 'label', { x: 0, y: 0, width: 120, height: 20 })]));
    notContains(single, 'enum View', 'nothing to switch');
    notContains(single, 'set_visible', 'and nothing to hide');
});

test('adding, renaming and deleting a view are edits, and each is one undo step', () => {
    const start = initialState(document([widget('title', 'label', { x: 0, y: 0, width: 40, height: 20 })]));
    equal(freeViewId(start.document), 'view2', 'the first free name');

    const added = addView(start);
    equal(viewsOf(added.document).map((view) => view.id), ['main', 'view2'], 'the view is appended');
    equal(freeViewId(added.document), 'view3', 'and the next name moves on');

    const renamed = renameView(added, 'view2', 'settings');
    equal(viewsOf(renamed.document).map((view) => view.id), ['main', 'settings']);
    const labelled = setViewLabel(renamed, 'settings', 'Setup');
    equal(viewsOf(labelled.document)[1].label, 'Setup', 'the caption is free text');

    // Renaming the view a widget is on moves the widget with it, or the design would point at a name nothing has.
    const moved = assignView(labelled, 'title', 'settings');
    equal(moved.document.widgets[0].view, 'settings');
    equal(validateDocument(renameView(moved, 'settings', 'options').document).length, 0, 'still valid after a rename');

    const removed = removeView(moved, 'settings');
    equal(viewsOf(removed.document).length, 1, 'the view goes');
    equal(removed.document.widgets.length, 0, 'and the widgets that were on it go with it');

    // Back up the history: one undo returns the deleted view and its widget.
    const back = undo(removed);
    equal(viewsOf(back.document).length, 2, 'the delete was one step');
    equal(back.document.widgets.length, 1);
});

test('the last view cannot be deleted, and a view cannot be renamed onto another', () => {
    const start = initialState(document());
    equal(removeView(start, 'main'), start, 'deleting the only view is not an edit');
    const two = addView(start, 'settings');
    equal(renameView(two, 'settings', 'main'), two, 'two views cannot share a name');
    equal(renameView(two, 'settings', 'not an id'), two, 'and a name rustc could not use is refused');
});

test('the canvas and the pointer see one view at a time', () => {
    const doc = twoViewDocument();
    // The button is at (10, 50) and belongs to `settings`; the canvas editing `main` must not find it.
    equal(widgetAt(doc, 10, 50)?.id, 'open', 'without a view, the widget is found as before');
    equal(widgetAt(doc, 10, 50, 'main'), undefined, 'and is not found while another view is on show');
    equal(widgetAt(doc, 10, 50, 'settings')?.id, 'open', 'it is found on its own view');
    equal(hitTest(doc, 10, 50, undefined, 'main'), undefined, 'the hit test agrees, which is what a click uses');
    equal(hitTest(doc, 10, 50, undefined, 'settings')?.id, 'open', 'and the other way round');
    equal(widgetsInView(doc, 'settings').map((entry) => entry.id), ['open'], 'the view lists its own widgets');
});

test('the designer writes what it read, and a two-view design validates', () => {
    const rendered = renderDesign(twoViewDocument());
    equal(rendered.problems.length, 0, `expected a valid design, got ${JSON.stringify(rendered.problems)}`);
    ok(rendered.kdl !== undefined, 'and markup to write');
    const stored = JSON.parse(rendered.documentJson);
    equal(stored.views.length, 2, 'the view list is saved with the design');
    equal(stored.widgets[1].view, 'settings', 'and so is the view a widget belongs to');
});

test('a navigate click switches view with no handler at all', () => {
    // The point of the event: a design can move between its views without a line of Rust. It rides on `Clicked`
    // because the crate has no navigation variant, so the generated arm is the switch -- and no `on_..._navigate`
    // stub is written, because there is nothing for one to do.
    const doc = twoViewDocument();
    doc.widgets[1].events = ['navigate'];
    doc.widgets[1].props.navigate_to = 'main';
    equal(validateDocument(doc).length, 0, 'a navigate with a destination is a valid design');

    const ui = emitUiRs(doc);
    contains(ui, 'self.show_view(View::Main);', 'the click switches view');
    contains(ui, 'UiEvent::Clicked(id) if id == self.widgets.open => {', 'on the widget that was clicked');
    notContains(ui, 'ui_handlers::on_open_navigate', 'and calls no handler for it');
    equal(requiredHandlers(doc).length, 0, 'so no stub is needed');
    notContains(emitKdl(doc), 'navigate_to', 'the destination never reaches the markup');

    // Ticking it picks a view that is not the widget's own, and unticking it drops the destination.
    const state = initialState(doc);
    const off = toggleEvent(state, 'open', 'navigate');
    equal(off.document.widgets[1].props.navigate_to, undefined, 'unticking clears the destination');
    const back = toggleEvent(off, 'open', 'navigate');
    equal(back.document.widgets[1].props.navigate_to, 'main', 'ticking picks the other view');
});

test('a navigate that has nowhere to go is refused', () => {
    const doc = twoViewDocument();
    doc.widgets[1].events = ['navigate'];
    doc.widgets[1].props.navigate_to = '';
    ok(
        validateDocument(doc).some((problem) => problem.includes('navigate has no view chosen')),
        'a navigate click with no destination is a problem, not a silent no-op',
    );

    doc.widgets[1].props.navigate_to = 'nowhere';
    ok(
        validateDocument(doc).some((problem) => problem.includes('navigate goes to view "nowhere"')),
        'and a destination the design does not have is named exactly',
    );

    // One view is the same problem: there is nothing to switch to, and no `View` enum to name.
    const single = document([widget('open', 'button', { x: 0, y: 0, width: 40, height: 20 })]);
    single.widgets[0].events = ['navigate'];
    single.widgets[0].props.navigate_to = 'main';
    ok(
        validateDocument(single).some((problem) => problem.includes('navigate needs a second view')),
        'a one-view design has nowhere to navigate to',
    );
});
