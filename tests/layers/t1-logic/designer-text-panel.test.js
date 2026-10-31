'use strict';

/**
 * The text panel: a read-only widget whose entries fold to its width.
 *
 * Three separate promises, and each has its own way of going wrong quietly:
 *
 * - **the markup** carries the entries as `line` children, so the crate builds a panel with them;
 * - **the generated Rust** gives the project methods that write it, because a panel nobody can add a line
 *   to from code is a label with extra steps;
 * - **the canvas** stacks a folded entry by the rows it took, which is the one thing the webview cannot
 *   copy from a label preview.
 *
 * The crate's own half -- folding, stacking, the marker and the mutators -- is tested in
 * `crates/embedded-gui/src/widgets/mod.rs`, where it can be run against the real renderer.
 */

const { test, ok, equal, notOk, contains, compiled } = require('../../lib/harness');

const { emitKdl } = compiled('designer/kdl');
const { TEXT_LINES_MAX } = compiled('designer/catalog');
const { emitUiRs } = compiled('designer/generate');
const {
    createDocument,
    defaultChildren,
    defaultProps,
    validateDocument,
    widgetsInView,
} = compiled('designer/model');
const { duplicateWidget } = compiled('designer/state');

/** A one-view design holding one text panel. */
function documentWithPanel(entries = ['booting', 'ready'], overrides = {}) {
    const document = createDocument({
        boardId: 'sunton-035r',
        panelWidth: 320,
        panelHeight: 480,
        rotation: 3,
        screenId: 'Panel',
    });
    document.widgets = [
        {
            id: 'log',
            tag: 'text_lines',
            x: 8,
            y: 8,
            width: 200,
            height: 120,
            props: { ...defaultProps('text_lines'), ...overrides },
            events: [],
            children: { kind: 'lines', values: [...entries] },
        },
    ];
    return document;
}

test('a dropped text panel starts with entries, not an empty box', () => {
    const children = defaultChildren('text_lines');
    ok(children !== undefined, 'a text panel has a body');
    equal(children.kind, 'lines', 'the body is a line list');
    ok(children.values.length > 0, 'it starts with something to read');
    // The properties the crate reads are all there, so the markup a fresh panel emits is complete.
    const props = defaultProps('text_lines');
    equal(props.gap, 2, 'entries start two pixels apart');
    ok('font' in props, 'a font can be chosen');
});

test('the entries are written as line children, one per entry', () => {
    const kdl = emitKdl(documentWithPanel(['booting', 'he said "hi"']));
    contains(kdl, 'text_lines id="log"', 'the panel reaches the markup');
    contains(kdl, 'line "booting"', 'the first entry is a line child');
    // A quote inside an entry is escaped once, by the KDL writer, rather than through an attribute that
    // would need it escaped again.
    contains(kdl, 'line "he said \\"hi\\""', 'a quote in an entry survives');
    contains(kdl, 'gap=2', 'the gap rides along');
});

test('a panel with no entries emits no body at all', () => {
    const kdl = emitKdl(documentWithPanel([]));
    contains(kdl, 'text_lines id="log"', 'the panel is still there');
    notOk(kdl.includes('line "'), 'no line children for an empty panel');
    // An empty panel is legal: it is what a log that its code fills starts as.
    equal(validateDocument(documentWithPanel([])).length, 0, 'an empty panel is valid');
});

test('a blank entry is refused, because it reserves a row nobody asked for', () => {
    const document = documentWithPanel(['first', '', 'third']);
    const problems = validateDocument(document);
    ok(
        problems.some((problem) => problem.includes('entry 2 is blank')),
        `expected a complaint about the blank entry, got ${JSON.stringify(problems)}`,
    );
});

test('the generated design gives the project methods that write the panel', () => {
    const rust = emitUiRs(documentWithPanel());
    // Borrowed entries: a static table, no RAM.
    contains(rust, 'pub fn log_set_lines(&mut self, lines: &[&\'static str])', 'replace every entry');
    // Borrowed append, answering whether it fitted.
    contains(rust, 'pub fn log_push_line(&mut self, line: &\'static str) -> bool', 'append a static entry');
    // Runtime-built text is copied in, so no heap is involved.
    contains(rust, 'pub fn log_push_line_owned(&mut self, line: &str) -> bool', 'append a built entry');
    // By index, which is what makes "drop the oldest" a call rather than a rebuild.
    contains(rust, 'pub fn log_remove_line(&mut self, index: usize)', 'delete one entry by index');
    contains(rust, 'pub fn log_line_count(&self) -> usize', 'read how many entries there are');
    // Font and colour, settable before writing.
    contains(rust, 'pub fn log_set_text_style(&mut self, font: FontId, colour: Rgb565)', 'set face and ink');
});

test('a design with no panel gains none of those methods', () => {
    const document = createDocument({
        boardId: 'sunton-035r',
        panelWidth: 320,
        panelHeight: 480,
        rotation: 3,
        screenId: 'Panel',
    });
    const rust = emitUiRs(document);
    notOk(rust.includes('_push_line'), 'no panel, no append method');
    notOk(rust.includes('_remove_line'), 'no panel, no delete method');
});

test('copying a panel copies its entries', () => {
    const state = { document: documentWithPanel(['one', 'two']), selection: ['log'], past: [], future: [] };
    const next = duplicateWidget(state, 'log');
    const copy = next.document.widgets.find((widget) => widget.id !== 'log');
    ok(copy !== undefined, 'a copy was added beside it');
    const children = copy.children;
    ok(children !== undefined && children.kind === 'lines', 'the copy has an entries body');
    equal(children.values.join('|'), 'one|two');
    // A copy, not a shared array: editing one must not edit the other.
    children.values.push('three');
    equal(state.document.widgets[0].children.values.length, 2, 'the original is untouched');
});

test('the panel is a text widget in the toolbox, with no events of its own', () => {
    const spec = compiled('designer/catalog').widgetSpec('text_lines');
    ok(spec !== undefined, 'the catalogue knows it');
    equal(spec.category, 'text', 'it sits with the text widgets');
    equal(spec.events.length, 0, 'a read-only panel raises nothing to handle');
    equal(spec.children, 'lines', 'its body grammar is the line list');
    ok(widgetsInView !== undefined);
});

test('the entry limit the validator enforces is the one the crate really has', () => {
    const fs = require('fs');
    const path = require('path');
    const { repoRoot } = require('../../lib/harness');
    const source = fs.readFileSync(
        path.join(repoRoot(), 'crates', 'embedded-gui', 'src', 'widgets', 'mod.rs'),
        'utf8',
    );
    const match = /pub const TEXT_LINES_CAPACITY: usize = (\d+);/.exec(source);
    ok(match !== null, 'the crate still declares a capacity');
    equal(Number(match[1]), TEXT_LINES_MAX, 'the designer and the crate agree on how many entries fit');
});

test('a panel listing more entries than the crate holds is refused, not silently trimmed', () => {
    const tooMany = Array.from({ length: TEXT_LINES_MAX + 1 }, (_, index) => `entry ${index + 1}`);
    const problems = validateDocument(documentWithPanel(tooMany));
    ok(
        problems.some((problem) => problem.includes(`holds ${TEXT_LINES_MAX} entries`)),
        `expected a complaint about the count, got ${JSON.stringify(problems)}`,
    );
    // Exactly the limit is fine.
    const exact = Array.from({ length: TEXT_LINES_MAX }, (_, index) => `entry ${index + 1}`);
    equal(validateDocument(documentWithPanel(exact)).length, 0, 'the limit itself is allowed');
});

// ---------------------------------------------------------------- the handle API

/** A design with a text panel, a keypad and a label, so every handle kind is generated. */
function documentWithAll() {
    const document = documentWithPanel(['first']);
    document.widgets = [
        {
            id: 'log',
            tag: 'text_lines',
            x: 8,
            y: 8,
            width: 200,
            height: 100,
            props: { ...defaultProps('text_lines'), gap: 2 },
            events: [],
            children: { kind: 'lines', values: ['first'] },
        },
        {
            id: 'pad',
            tag: 'keypad',
            x: 8,
            y: 120,
            width: 200,
            height: 100,
            props: { ...defaultProps('keypad') },
            events: ['submitted'],
            children: undefined,
        },
        {
            id: 'title',
            tag: 'label',
            x: 8,
            y: 224,
            width: 200,
            height: 16,
            props: { ...defaultProps('label') },
            events: [],
            children: undefined,
        },
    ];
    return document;
}

test('a design reaches its widgets by the names it gave them', () => {
    const rust = emitUiRs(documentWithAll());
    // The three accessors, each returning the handle for its kind.
    contains(rust, "pub fn log(&self) -> TextLinesHandle<'_>", 'the text panel is reached by its name');
    contains(rust, "pub fn pad(&self) -> KeypadHandle<'_>", 'so is the keypad');
    contains(rust, "pub fn title(&self) -> WidgetHandle<'_>", 'and so is everything else');
    // The call the app writes, minus the design prefix: a TextLinesHandle and a KeypadHandle are both
    // shared borrows of the design, which is what makes the one-liner legal.
    contains(rust, 'pub fn add_line(&self, line: WidgetText) -> bool', 'add_line takes a copied line');
    contains(rust, 'pub text: WidgetText,', 'a keypad handle carries the line it last submitted');
});

test('the text panel handle has every mutator the crate has for it', () => {
    const rust = emitUiRs(documentWithAll());
    for (const signature of [
        'pub fn set_lines(&self, lines: &[&\'static str])',
        'pub fn add_line_static(&self, line: &\'static str) -> bool',
        'pub fn add_line(&self, line: WidgetText) -> bool',
        'pub fn set_line_static(&self, index: usize, line: &\'static str)',
        'pub fn set_line(&self, index: usize, line: WidgetText)',
        'pub fn insert_line(&self, index: usize, line: WidgetText) -> bool',
        'pub fn remove_line(&self, index: usize)',
        'pub fn clear(&self)',
        'pub fn line(&self, index: usize) -> Option<WidgetText>',
        'pub fn len(&self) -> usize',
        'pub fn is_empty(&self) -> bool',
        'pub fn set_text_style(&self, font: FontId, colour: Rgb565)',
    ]) {
        contains(rust, signature, `the handle offers ${signature}`);
    }
});

test('a handle borrows the design, so two of them can be alive at once', () => {
    const rust = emitUiRs(documentWithAll());
    // The property that makes design.log().add_line(design.pad().text) compile: two shared borrows, and the
    // write going through the cell the design owns rather than through a mutable borrow of the design.
    ok(
        rust.includes('gui: RefCell<GuiContext<') && rust.includes('self.gui.borrow_mut()'),
        'the GUI lives behind a RefCell and the handles borrow it mutably per call',
    );
    ok(
        !/pub fn add_line\(&self[^)]*\)[\s\S]{0,200}&mut self\.design/.test(rust),
        'and no handle takes a mutable borrow of the design',
    );
});

test('a widget named after a Designer method gets its own accessor name', () => {
    const document = documentWithAll();
    document.widgets[2].id = 'render';
    const rust = emitUiRs(document);
    ok(rust.includes("pub fn render_widget(&self) -> WidgetHandle<'_>"), 'the clash is renamed');
    ok(rust.includes('id: self.widgets.render,'), 'and still points at the widget');
});

test('a design with neither a text panel nor a keypad gains none of the copied-text machinery', () => {
    const document = createDocument({
        boardId: 'sunton-035r',
        panelWidth: 320,
        panelHeight: 480,
        rotation: 3,
        screenId: 'Panel',
    });
    document.widgets = [
        {
            id: 'title',
            tag: 'label',
            x: 8,
            y: 8,
            width: 120,
            height: 20,
            props: { ...defaultProps('label') },
            events: [],
            children: undefined,
        },
    ];
    const rust = emitUiRs(document);
    notOk(rust.includes('WidgetText'), 'no copied-text type without a widget that needs one');
    notOk(rust.includes('TextLinesHandle'), 'no text panel handle');
    ok(rust.includes("pub fn title(&self) -> WidgetHandle<'_>"), 'but the generic handle is there');
});
