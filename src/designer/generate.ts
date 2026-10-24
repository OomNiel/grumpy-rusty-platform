/**
 * What a Designer project is born with: the starter design, the Rust that drives it, and the code-behind.
 *
 * Three artifacts with three different lifetimes, which is the whole reason this module exists:
 *
 * - **`src/ui.kdl`** is regenerated whenever the designer saves. It is the compiled form of the design.
 * - **`src/ui.rs`** is generated too, and contains no user code: the `include_gui!` call, the node budgets,
 *   the pointer plumbing and the match that turns a `UiEvent` into a call. It has to be regenerated, because
 *   the match and the budgets both depend on what the design contains.
 * - **`src/ui_handlers.rs`** is the user's. The designer only ever *appends* a stub for an event that has
 *   none, and never rewrites a function that exists -- so renaming a handler body, moving it into a module
 *   and calling it, or deleting the log line all survive the next save.
 *
 * `main.rs` is not touched at all after the wizard writes it: it calls `ui::Designer`, and every change
 * arrives through the two files above.
 */

import { EVENT_SPECS, type DesignerEvent, navigateTriggerFor, widgetSpec } from './catalog';
import {
    type DesignerDocument,
    type DesignerView,
    type DesignerWidget,
    createDocument,
    designCanvasSize,
    designViews,
    defaultChildren,
    defaultProps,
    startViewId,
    viewEnumName,
    widgetsInView,
    widgetViewId,
} from './model';
import { emitKdl } from './kdl';
import { rustFieldName } from './model';
import type { LcdRotation } from '../display/rotation';

/**
 * The screen id every designer project pins.
 *
 * The generated `ui.rs` has to name the app type the code generator produces, and that name comes from the
 * screen id -- so an editable id would be a way to break the build from a text field. The designer still
 * shows the field; changing it is reported as a problem rather than silently regenerating a file nobody
 * expects to change.
 */
export const PINNED_SCREEN_ID = 'RustyPanel';

/** Markers so the extension can tell its own generated files from a user's. */
export const UI_MARKER = 'rusty-designer-ui';
export const HANDLERS_MARKER = 'rusty-designer-handlers';

/** The files a designer project carries, relative to the project root. */
export const DESIGNER_FILES = {
    markup: 'src/ui.kdl',
    rust: 'src/ui.rs',
    handlers: 'src/ui_handlers.rs',
    document: 'designer/panel.ui.json',
    /** The screen manifest, which is also what anchors asset paths to the project root. */
    manifest: 'project.kdl',
} as const;

/**
 * The project manifest.
 *
 * It exists for two reasons and both matter. `embedded-gui`'s macros resolve an asset path -- an image, a font
 * -- relative to the directory of the *screen* file, unless they find a `project.kdl` above it, in which case
 * that directory is the asset root. So without this file, `src="assets/logo.bmp"` in `src/ui.kdl` would be
 * read as `src/assets/logo.bmp`: a path nobody would guess, and one the designer's own asset check would
 * disagree with (found by building the harness with a font in it). And declaring the screen here means
 * `include_project!` would accept this project as it stands, should a design ever grow into several screens.
 */
export function emitProjectKdl(document: DesignerDocument): string {
    return `// Grumpy's Rusty Platform -- the project's screen manifest.
//
// Asset paths in ${DESIGNER_FILES.markup} are relative to the project root because this file is here:
// embedded-gui looks for a project.kdl above a screen and treats its directory as the asset root. Deleting it
// does not break the build, but it silently moves the root to src/ and every asset path with it.

project {
    screen id="${document.screenId}" file="${DESIGNER_FILES.markup}"
}
`;
}

/**
 * The design a new Designer project starts with.
 *
 * Deliberately tiny and deliberately complete: a title and one button that raises `clicked`, so the first
 * flash shows something that proves the whole chain -- markup, code generator, budgets, paint -- and the
 * handler file has an example in it.
 */
export function starterDocument(options: {
    boardId: string;
    panelWidth: number;
    panelHeight: number;
    rotation: LcdRotation;
}): DesignerDocument {
    const document = createDocument({
        boardId: options.boardId,
        panelWidth: options.panelWidth,
        panelHeight: options.panelHeight,
        rotation: options.rotation,
        screenId: PINNED_SCREEN_ID,
    });
    const canvas = designCanvasSize(options.panelWidth, options.panelHeight, options.rotation);
    const margin = 8;
    const inset = Math.min(16, Math.floor(canvas.width / 8));
    // A button that a finger can hit, and that still fits the smallest panel in the catalogue: the T-QT is
    // 128 px across, so nothing here may assume a landscape 480.
    const buttonWidth = Math.min(140, canvas.width - inset * 2);
    const buttonHeight = Math.min(44, Math.max(24, Math.floor(canvas.height / 6)));

    document.widgets = [
        {
            id: 'title',
            tag: 'label',
            x: inset,
            y: margin,
            width: canvas.width - inset * 2,
            height: 26,
            props: { ...defaultProps('label'), text: 'Rusty Platform' },
            events: [],
        },
        {
            id: 'go',
            tag: 'button',
            x: Math.floor((canvas.width - buttonWidth) / 2),
            y: Math.floor((canvas.height - buttonHeight) / 2),
            width: buttonWidth,
            height: buttonHeight,
            props: { ...defaultProps('button'), text: 'Press me' },
            events: ['clicked'],
        },
    ];
    return document;
}

/** The markup for a design, which is what `include_gui!` compiles. */
export function emitStarterKdl(document: DesignerDocument): string {
    return emitKdl(document);
}

/** The Rust function name for one event of one widget, e.g. `on_go_clicked`. */
export function handlerName(id: string, event: DesignerEvent): string {
    return `on_${rustFieldName(id)}_${EVENT_SPECS[event].suffix}`;
}

/** The parameter the handler takes, if the event carries anything beyond its widget. */
function handlerParameters(event: DesignerEvent): string {
    const spec = EVENT_SPECS[event];
    const parameter = spec.parameter;
    if (parameter !== undefined) {
        return `${parameter.name}: ${parameter.type}`;
    }
    // An argument fetched from the GUI rather than bound from the event (a keypad's submitted
    // line) still has to be named in the signature the generated arm calls.
    return spec.argumentType === undefined ? '' : `text: ${spec.argumentType}`;
}

/** Every handler a design needs, in document order, without duplicates. */
export function requiredHandlers(document: DesignerDocument): string[] {
    const names: string[] = [];
    for (const widget of document.widgets) {
        for (const event of widget.events) {
            // An event the generated code answers itself (`navigate`) has no handler to write, and a stub for
            // it would be a function nothing calls.
            if (EVENT_SPECS[event].action !== undefined) {
                continue;
            }
            const name = handlerName(widget.id, event);
            if (!names.includes(name)) {
                names.push(name);
            }
        }
    }
    return names;
}

/**
 * The movement the code-behind attaches to a clock: one second on every attached face.
 *
 * The crate's clock holds a *time*, not a running clock, so the engine is here rather than in the
 * widget: it reads embassy's clock when the app paints, advances the widget by however many seconds
 * have passed, and the damage the widget reports is its own cell -- one hand moving is not a reason
 * to repaint a 480x320 panel.
 *
 * There is no `Timer` to await: `render` is called from the app's synchronous paint path, and the
 * project's main loop already asks `is_dirty()` every pass. Answering "yes" once a second is what
 * makes an untouched panel keep up with the time.
 */
function movementMethodsFor(document: DesignerDocument, clocks: readonly DesignerWidget[]): string {
    // A clock on another view is not on the glass, and moving it still damages its own rectangle -- which the
    // renderer then clears to the background and does not paint over, because the widget is hidden. That showed
    // up as black blocks appearing on the visible view once a second (bench, 2026-10-24), so the movement only
    // runs for a clock whose view is the one on show. A one-view design emits no guard at all, which is why the
    // goldens of a single-view project do not move.
    const guard = (widget: DesignerWidget, body: string, indent: string): string => {
        const views = designViews(document);
        if (views.length <= 1) {
            return body;
        }
        const variant = viewEnumName(widgetViewId(document, widget));
        return `${indent}if self.view == View::${variant} {\n${indent}    ${body.trim()}\n${indent}}`;
    };
    const advances = clocks
        .map((widget) =>
            guard(widget, `let _ = self.gui.advance_clock(self.widgets.${rustFieldName(widget.id)});`, '            '),
        )
        .join('\n');
    // The same clocks, told the time a wall clock says rather than stepped by a count of ticks.
    const shows = clocks
        .map((widget) =>
            guard(
                widget,
                `let _ = self.gui.set_clock_time(self.widgets.${rustFieldName(widget.id)}, hour, minute, second);`,
                '            ',
            ),
        )
        .join('\n');
    return `
    /// The time the design is showing: the wall clock advanced to now, or \`None\` before one has
    /// been handed over.
    pub fn wall_clock(&self) -> Option<(u8, u8, u8)> {
        let (anchor, start) = self.wall_base?;
        let seconds = (start + anchor.elapsed().as_secs() as u32) % 86_400;
        Some((
            (seconds / 3600) as u8,
            ((seconds / 60) % 60) as u8,
            (seconds % 60) as u8,
        ))
    }

    /// Whether a wall clock has been handed over -- what a board with no RTC (or one that has not
    /// been told yet) answers \`false\` to. The app's to use; the movement asks wall_clock.
    #[allow(dead_code)]
    pub fn has_wall_clock(&self) -> bool {
        self.wall_base.is_some()
    }

    /// Whether a whole second has passed since the clocks were last advanced.
    ///
    /// A design nobody is touching only paints when something says it changed, so this is what keeps
    /// the panel awake: once a second, and not once a frame.
    fn clock_due(&self) -> bool {
        match self.last_tick {
            None => true,
            Some(last) => Instant::now().duration_since(last).as_secs() > 0,
        }
    }

    /// The movement: the wall clock when the board has one, the one-second timer otherwise.
    ///
    /// With a wall clock the hands are *set* to what it says, so nothing accumulates and nothing
    /// drifts; without one, a frame that took two seconds advances the hands by two, so a slow
    /// panel does not make the design's own time lose seconds either.
    fn tick_clocks(&mut self) {
        let shown = self.wall_clock();
        if let Some((hour, minute, second)) = shown {
            self.last_tick = Some(Instant::now());
${shows}
            return;
        }
        let now = Instant::now();
        let last = match self.last_tick {
            None => {
                self.last_tick = Some(now);
                return;
            }
            Some(last) => last,
        };
        let elapsed = now.duration_since(last).as_secs();
        if elapsed == 0 {
            return;
        }
        self.last_tick = Some(last + Duration::from_secs(elapsed));
        for _ in 0..elapsed {
${advances}
        }
    }
`;
}

/**
 * The wall clock, emitted for every design whether or not one of its widgets shows the time.
 *
 * `main.rs` calls it whenever the console hands a time over, so it has to exist even in a design
 * with no clock: the hand-over is the firmware's, not any widget's.
 */
function wallMethodsFor(movement: boolean): string {
    const resume = movement ? '        self.last_tick = Some(now);\n' : '';
    return `
    /// Tells the design what time it is, as local time.
    ///
    /// The toolchain sends this over the console once the board is running: an ESP32's internal RTC
    /// has no battery, so a board that has been powered off has no idea of the time until it is
    /// told. The anchor is kept rather than the time being counted, so a frame that took two
    /// seconds -- or a loop that was asleep -- cannot make the hands lose a second.
    ///
    /// Out-of-range fields are clamped rather than wrapped, the same rule the clock itself follows.
    pub fn set_wall_clock(&mut self, hour: u8, minute: u8, second: u8) {
        let now = Instant::now();
        let start = hour.min(23) as u32 * 3600 + minute.min(59) as u32 * 60 + second.min(59) as u32;
        self.wall_base = Some((now, start % 86_400));
${resume}
    }
`;
}

/**
 * The `match` arms one widget contributes to `pump`.
 *
 * Almost always one arm per event, calling the handler of that name. `navigate` is the exception: it borrows the
 * event the widget reports -- `Clicked` for a button, `ValueChanged` for a dropdown, `Submitted` for a keypad --
 * answers it with `show_view` instead of a handler call, and folds that event's own handler into the same arm, so
 * a widget can both switch view and run its own code. Two arms matching one variant would mean the second never
 * ran, which is why the borrowed one is left out of the loop below.
 */
function armsFor(widget: DesignerWidget, multiView: boolean): string[] {
    const field = rustFieldName(widget.id);
    const navigate = widget.events.find((event) => EVENT_SPECS[event].action !== undefined);
    // The event the switch is fired by: the crate has no navigation variant, so a navigate is the widget's own
    // event, answered by the generated code. Only when the widget navigates at all -- otherwise this would name
    // the event of an ordinary arm and then skip it.
    const trigger = navigate === undefined ? undefined : navigateTriggerFor(widget.tag);
    const arms: string[] = [];
    for (const event of widget.events) {
        const spec = EVENT_SPECS[event];
        if (spec.action !== undefined) {
            continue;
        }
        // The event the switch borrows is the arm below, not a second one on the same pattern.
        if (trigger !== undefined && event === trigger) {
            continue;
        }
        arms.push(
            `                UiEvent::${spec.pattern} if id == self.widgets.${field} => crate::ui_handlers::${handlerCall(widget, event)},`,
        );
    }
    const spec = navigate === undefined ? undefined : EVENT_SPECS[navigate];
    const target = widget.props[spec?.action?.targetProperty ?? ''];
    // No enum to name, or no destination chosen: the validator says so in the panel, and a project is not
    // left with code that could not compile.
    if (spec !== undefined && trigger !== undefined && multiView && typeof target === 'string' && target !== '') {
        // A widget can ask for both: the switch, and a handler of its own on the same event.
        const thenClick = widget.events.includes(trigger)
            ? `\n                    crate::ui_handlers::${handlerCall(widget, trigger)};`
            : '';
        arms.unshift(
            `                UiEvent::${EVENT_SPECS[trigger].pattern} if id == self.widgets.${field} => {\n` +
            `                    self.show_view(View::${viewEnumName(target)});${thenClick}\n` +
            '                }',
        );
    }
    return arms;
}

/** The call an event makes, with whatever the variant carries. */
function handlerCall(widget: DesignerWidget, event: DesignerEvent): string {
    const name = handlerName(widget.id, event);
    const spec = EVENT_SPECS[event];
    // `Scroll { id, delta }` binds `delta`, `TextInput { id, ch }` binds `ch`.
    if (spec.parameter !== undefined) {
        return `${name}(${spec.parameter.name})`;
    }
    // A keypad's Enter carries only the id, so the line is read back from the widget: submitting
    // clears the live line, which leaves the copy the widget keeps for exactly this call.
    if (spec.argument !== undefined) {
        return `${name}(${spec.argument})`;
    }
    return `${name}()`;
}

/**
 * Whether the design draws a clock.
 *
 * The main loop asks this before doing anything with time at all: a project whose design has no clock
 * has no face to set, so it should not spend a console receiver and an RTC on one. The answer travels
 * into the generated `ui.rs` as `HAS_CLOCK`, which is a `const` and therefore folded away at build time.
 */
export function designHasClock(document: DesignerDocument): boolean {
    return document.widgets.some((widget) => widget.tag === 'clock');
}

/**
 * The `View` enum a multi-view design gets.
 *
 * Variants come from the view ids (`viewEnumName`), because the app calls this from its own code and the file
 * it reads the name in should not teach a second naming scheme. No backticks in this text: it lives inside a
 * JavaScript template literal.
 */
function viewEnumOf(views: readonly DesignerView[], start: string): string {
    const variants = views.map((view) => `    ${viewEnumName(view.id)},`).join('\n');
    return `/// Which view the design is showing.
///
/// A view is a layer of this one screen, not a second screen: every widget is in the markup, and the ones
/// that are not on show are hidden. So a switch is a handful of flag writes -- no rebuild, no re-layout, and
/// no second node budget. The design starts on "${start}", and show_view changes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View {
${variants}
}

`;
}

/**
 * `show_view` and `active_view` for a multi-view design.
 *
 * Each view's widgets are named in a loop of their own, so the runtime is told, per widget, whether it is on
 * show -- there is no table to keep in step with the design, and an empty view simply has no loop.
 */
function viewMethodsOf(document: DesignerDocument, views: readonly DesignerView[]): string {
    const loops = views
        .filter((view) => widgetsInView(document, view.id).length > 0)
        .map((view) => {
            const ids = widgetsInView(document, view.id)
                .map((widget) => `self.widgets.${rustFieldName(widget.id)}`)
                .join(', ');
            return `        for id in [${ids}] {
            let _ = self.gui_mut().set_visible(id, view == View::${viewEnumName(view.id)});
        }`;
        })
        .join('\n');
    return `
    /// Shows one view and hides every other.
    ///
    /// A view is a layer of the one screen: every widget is in the markup, and switching tells each of them
    /// whether it is on show. The runtime skips a hidden widget when it draws and when it looks for the widget
    /// under a finger, so nothing is rebuilt and the node budget does not double.
    #[allow(dead_code)]
    pub fn show_view(&mut self, view: View) {
${loops}
        self.view = view;
    }

    /// The view on show.
    #[allow(dead_code)]
    pub fn active_view(&self) -> View {
        self.view
    }
`;
}

/**
 * The generated Rust side: the markup's `include_gui!`, the budgets, and the plumbing `main.rs` drives.
 *
 * Two details are load-bearing. The node budget is the markup's own `NODE_COUNT` plus headroom, so adding
 * widgets in the designer can never overflow a hand-written number. And the first frame is a full render
 * while later frames are `render_dirty`: over a 24 MHz SPI link a full 480x320 repaint is a quarter of a
 * second, and honouring the damage rectangles is what makes dragging a finger affordable.
 */
export function emitUiRs(document: DesignerDocument, touch = true): string {
    // ---- views ---------------------------------------------------------------------------------
    // A design with one view emits none of this: a project made before views existed generates exactly the
    // file it generated before, which is also why the goldens do not move.
    const views = designViews(document);
    const multiView = views.length > 1;
    const arms = document.widgets.flatMap((widget) => armsFor(widget, multiView));
    const armText = arms.length === 0 ? '                // No widget in this design raises an event yet.' : arms.join('\n');
    // The `widgets` field is the app's handle to its own widgets, and a design that raises no event has
    // nothing in this file reading it — so the compiler calls it dead and a generated project builds with a
    // warning it did not ask for. Allowed only when there are no arms, so a design that does raise events
    // still hears about the handle if it really is unused (found by building a real project whose design had
    // no events at all, 2026-10-12).
    // The clocks whose movement is attached, in design order: a checkbox in the clock's properties
    // panel decides, and the design says so with a property the markup never carries (`designerOnly`
    // in the catalogue), because it is about the generated code rather than about the drawn face.
    const movingClocks = document.widgets.filter(
        (widget) => widget.tag === 'clock' && widget.props.movement === true,
    );
    const movement = movingClocks.length > 0;
    // `Instant` is always needed: the wall clock's anchor is one, whether or not the design shows a
    // clock. `Duration` is the stepping fallback's business alone.
    const movementImport = movement
        ? 'use embassy_time::{Duration, Instant};\n'
        : 'use embassy_time::Instant;\n';
    // The wall clock is a field of every design: `main.rs` hands the time over as soon as the board
    // is running, and a design with no clock in it still stores it (the app may add one later).
    const wallField =
        '    /// The wall clock the hands follow once the board has been told the time: the local\n' +
        '    /// time it was told, and the instant it was told. `None` until then -- and on a board\n' +
        '    /// with no RTC that survives power-off, for ever.\n' +
        '    #[allow(dead_code)]\n' +
        '    wall_base: Option<(Instant, u32)>,\n';
    const wallInit = '            wall_base: None,\n';
    const movementField = movement
        ? '    /// When the clocks were last advanced. `None` until the first frame sets it.\n' +
        '    last_tick: Option<Instant>,\n'
        : '';
    const movementInit = movement ? '            last_tick: None,\n' : '';
    // The extra sentence on `is_dirty` is there only in a design that has a movement: a project with
    // no clock generates exactly the file it generated before this existed.
    const isDirtyDoc = movement
        ? '    ///\n' +
        '    /// A clock whose movement is attached is due once a second has passed, which is what\n' +
        '    /// makes the hands move on a panel nobody is touching.\n'
        : '';
    const movementTick = movement ? '        self.tick_clocks();\n' : '';
    const isDirty = movement
        ? '        !self.gui.dirty_regions().is_empty() || self.clock_due()'
        : '        !self.gui.dirty_regions().is_empty()';
    const movementMethods = movement ? movementMethodsFor(document, movingClocks) : '';
    const wallMethods = wallMethodsFor(movement);

    const widgetsField =
        arms.length > 0
            ? '    pub widgets: '
            : '    // Nothing in this file reads it, because the design below raises no event — and the app\'s own\n' +
            '    // code may still drive the widgets by the names the design gave them.\n' +
            '    #[allow(dead_code)]\n' +
            '    pub widgets: ';

    // ---- views ---------------------------------------------------------------------------------
    const viewEnum = multiView ? viewEnumOf(views, startViewId(document)) : '';
    const viewField = multiView
        ? '    /// The view on show. `show_view` is what changes it.\n    view: View,\n'
        : '';
    const viewInit = multiView ? `            view: View::${viewEnumName(startViewId(document))},\n` : '';
    // Hidden before the first frame, not after it: `new` builds the design, so this is the one moment a widget
    // of another view could paint itself. The ids are copied out of the widget struct as an array, which keeps
    // the borrow of `app.widgets` over before `gui` is borrowed mutably.
    const viewStartHide = views
        .filter((view) => view.id !== startViewId(document))
        .map((view) => {
            const ids = widgetsInView(document, view.id);
            if (ids.length === 0) {
                return '';
            }
            const list = ids.map((widget) => `app.widgets.${rustFieldName(widget.id)}`).join(', ');
            return `        for id in [${list}] {\n            let _ = gui.set_visible(id, false);\n        }\n`;
        })
        .join('');
    const viewMethods = multiView ? viewMethodsOf(document, views) : '';

    return `// Grumpy's Rusty Platform -- the design's Rust side.
//
// Generated. The markup it compiles (${DESIGNER_FILES.markup}) is what the designer rewrites on every save,
// and the handlers it calls are declared in ${DESIGNER_FILES.handlers}, which is yours. There is nothing to
// edit here that the designer would not put back.
//
// ${UI_MARKER}

// Through embedded_graphics, not embedded_graphics_core: the project declares the former, which re-exports
// the latter's types, and naming the core crate directly does not resolve (found by building a generated
// project).
use embedded_graphics::draw_target::DrawTarget;
use embedded_graphics::pixelcolor::Rgb565;
use embedded_gui::prelude::*;
${movementImport}
/// The screen, compiled from the markup the designer writes.
mod design {
    use embedded_gui::prelude::*;
    embedded_gui::include_gui!("${DESIGNER_FILES.markup}");
}

pub use design::${PINNED_SCREEN_ID}Widgets;

/// Node budget: the markup's own widget count plus headroom, so the designer cannot outgrow a constant.
pub const NODES: usize = design::${PINNED_SCREEN_ID}App::NODE_COUNT + 8;
/// Whether the design draws a clock -- what decides whether the firmware keeps a time at all.
pub const HAS_CLOCK: bool = ${designHasClock(document)};
/// Queued events and damage rectangles: what a finger produces between two frames.
pub const EVENTS: usize = 16;
pub const DIRTY: usize = 8;

/// What the panel is cleared to before the design is first painted.
///
/// The sketch does that clear (it owns the display), and a partial repaint has to agree with it:
/// the damaged regions are cleared to this same colour first, so a widget with no face of its own
/// -- a clock's hands are drawn straight onto the panel -- cannot leave its previous drawing behind
/// where nothing else repaints those pixels. Changing this means changing the clear in main.rs
/// to match. Spelled out as a raw value rather than Rgb565::BLACK: that constant comes from the
/// RgbColor trait, which this file does not pull in.
pub const SCREEN_BACKGROUND: Rgb565 = Rgb565::new(0, 0, 0);

${viewEnum}/// The screen, and the pointer state the widgets need to see a press and a release as a pair.
${touch ? '' : `///
/// A board with no touch controller cannot raise an event, so the pointer plumbing below is never called --
/// kept so that the same design compiles for both kinds of board rather than two shapes of this file.
#[allow(dead_code)]
`}pub struct Designer {
    gui: GuiContext<'static, NODES, EVENTS, DIRTY>,
    /// The widget ids, named the way the design names them.
${widgetsField}${PINNED_SCREEN_ID}Widgets,
    down: bool,
    painted: bool,
${wallField}${movementField}${viewField}}

${touch ? '' : '#[allow(dead_code)]\n'}impl Designer {
    /// Builds the screen once, at the size the panel is actually drawn at.
    pub fn new(width: u32, height: u32) -> Self {
        let mut gui = GuiContext::new(Rect::new(0, 0, width, height));
        let app = design::${PINNED_SCREEN_ID}App::build(&mut gui).expect("the design fits its node budget");
${viewStartHide}        Self {
            gui,
            widgets: app.widgets,
            down: false,
            painted: false,
${wallInit}${movementInit}${viewInit}        }
    }

    /// The design's own context, for an app that drives a widget itself.
    ///
    /// Every named set_* method the crate has is reached through this, and so is the generic
    /// set_widget_property(id, key, value) -- addressed by the ids in widgets, for example
    /// gui_mut().set_widget_property(widgets.my_scale, PropertyKey::Value, PropertyValue::Float(8.4)).
    /// Without it a screen could be touched and painted but never told anything, which is what an app that
    /// animates a needle or a gauge needs.
    //
    // allow(dead_code) for the same reason as the widgets field: whether an app drives a widget itself is
    // the app's business, and the warning would otherwise appear in every project that does not. (No
    // backticks in this file's Rust template: they would end the JavaScript string it lives in.)
    #[allow(dead_code)]
    pub fn gui(&self) -> &GuiContext<'static, NODES, EVENTS, DIRTY> {
        &self.gui
    }

    /// The same, mutably: the setters all take &mut self.
    #[allow(dead_code)]
    pub fn gui_mut(&mut self) -> &mut GuiContext<'static, NODES, EVENTS, DIRTY> {
        &mut self.gui
    }

    /// A touch sample.
    ///
    /// Only the press and the release are sent as such: a widget acts on those, and a stream of presses would
    /// restart a press on every frame. While the finger stays down the moves are what let a slider follow it.
    pub fn pointer(&mut self, x: i32, y: i32, down: bool) {
        let event = if down != self.down {
            self.down = down;
            InputEvent::Pointer {
                x,
                y,
                state: if down { PointerState::Pressed } else { PointerState::Released },
                button: PointerButton::Primary,
            }
        } else if down {
            InputEvent::Pointer {
                x,
                y,
                state: PointerState::Moved,
                button: PointerButton::Primary,
            }
        } else {
            return;
        };
        let _ = self.gui.handle_input(event);
    }

    /// Hands whatever the widgets raised to the code-behind.
    pub fn pump(&mut self) {
        while let Some(event) = self.gui.pop_event() {
            match event {
${armText}
                _ => {}
            }
        }
    }
${viewMethods}
    /// True when something changed and the panel needs repainting.
${isDirtyDoc}    pub fn is_dirty(&self) -> bool {
${isDirty}
    }

    /// Paints the whole screen whatever the damage says.
    ///
    /// For the first frame and for anything that clears the panel underneath the design -- a completed
    /// calibration, or coming back from the calibration screen -- where honouring the damage rectangles would
    /// leave stale pixels behind.
    pub fn repaint<D>(&mut self, target: &mut D) -> Result<(), D::Error>
    where
        D: DrawTarget<Color = Rgb565>,
    {
        self.painted = false;
        self.render(target)
    }

    /// Paints what changed. The first frame is whole -- there is no damage to honour yet -- and every frame
    /// after it is only the regions that changed.
    pub fn render<D>(&mut self, target: &mut D) -> Result<(), D::Error>
    where
        D: DrawTarget<Color = Rgb565>,
    {
${movementTick}        let result = if self.painted {
            // A partial repaint paints the damaged regions and nothing else, and the design paints
            // no screen background of its own -- so the regions are cleared to the colour the panel
            // started as first. Without this a moving clock drew each new hand and left the old one
            // on the glass (reported 2026-10-17).
            self.gui
                .paint_damage(target, SCREEN_BACKGROUND)
                .and_then(|()| self.gui.render_dirty(target))
        } else {
            self.gui.render(target)
        };
        self.painted = true;
        self.gui.clear_dirty();
        result
    }
${wallMethods}${movementMethods}}
`;
}

/**
 * The code-behind, written only if it is not there.
 *
 * A handler the user has already written is never touched. `pump` may therefore call a function whose body
 * the user has emptied or renamed *and* re-declared -- if they rename it, it is theirs to fix, and the
 * compile error names it exactly.
 */
export function emitHandlersRs(document: DesignerDocument, touch = true): string {
    const names = requiredHandlers(document);
    const stubs = names.map((name) => {
        const event = document.widgets
            .flatMap((widget) => widget.events.map((candidate) => ({ widget, candidate })))
            .find((entry) => handlerName(entry.widget.id, entry.candidate) === name);
        const parameters = event === undefined ? '' : handlerParameters(event.candidate);
        // On a board with no touch controller nothing in the generated code can call these; the user still can,
        // from a timer or a sensor, so they are declared and the allowance says why they look unused.
        // A stub has to *use* its argument or a freshly generated project builds with an
        // `unused_variables` warning, which reads as broken: a submitted line is the one an
        // argument is ever handed over for.
        const usesArgument =
            EVENT_SPECS[event?.candidate ?? 'clicked'].argumentType !== undefined;
        const message = `\"design: ${name} fired${usesArgument ? ': {}' : ''}\"`;
        const forwarded = usesArgument ? ', text' : '';
        return `${touch ? '' : '#[allow(dead_code)]\n'}/// Raised by the design. Called from \`ui::Designer::pump\`.
pub fn ${name}(${parameters}) {
    log::info!(${message}${forwarded});
}`;
    });

    return `// The code behind your design's events -- yours to keep.
//
// The designer appends a stub here for each event it is asked for, and never rewrites what is already
// written. Rename the bodies, move them into modules, call them from anywhere: the only thing that has to
// stay is the name and the signature, because \`src/ui.rs\` calls them by name.
//
// ${HANDLERS_MARKER}

${stubs.join('\n\n')}
`;
}

/**
 * Adds a stub for every handler the design needs and the file does not declare.
 *
 * Appending rather than regenerating is what makes the file the user's: a handler they have already filled in
 * is found by name and left completely alone, and only the missing ones appear -- at the end, where they are
 * easy to find and out of the way of the code above them.
 */
export function appendHandlerStubs(existing: string, document: DesignerDocument, touch = true): string {
    const missing: string[] = [];
    for (const name of requiredHandlers(document)) {
        // `pub fn name(` and `fn name(` both count: a user may have made a handler private on purpose.
        if (!new RegExp(`\\bfn\\s+${name}\\s*[(<]`).test(existing)) {
            missing.push(name);
        }
    }
    if (missing.length === 0) {
        return existing;
    }

    const stubs = missing.map((name) => {
        const entry = document.widgets
            .flatMap((widget) => widget.events.map((event) => ({ widget, event })))
            .find((candidate) => handlerName(candidate.widget.id, candidate.event) === name);
        const parameters = entry === undefined ? '' : handlerParameters(entry.event);
        return `${touch ? '' : '#[allow(dead_code)]\n'}/// Appended by the designer when the design asked for this event.
pub fn ${name}(${parameters}) {
    log::info!("design: ${name} fired");
}`;
    });
    const trimmed = existing.endsWith('\n') ? existing : `${existing}\n`;
    return `${trimmed}\n${stubs.join('\n\n')}\n`;
}

/**
 * The one line a stub body holds, which is what makes a block the designer's to remove.
 *
 * Written as a test rather than an equality on the whole block because the block also carries the doc comment
 * and, on a board with no touch controller, an `#[allow(dead_code)]`.
 */
function isUntouchedStub(body: string, name: string): boolean {
    const lines = body
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
    return lines.length === 1 && lines[0] === `log::info!("design: ${name} fired");`;
}

/**
 * Removes the stub of every handler the design no longer needs -- a widget that was deleted, an event that was
 * unticked.
 *
 * Only what the designer itself wrote is removed: a block whose body is still exactly the `log::info!` line
 * above. A handler that has been filled in, renamed, or moved into a module is the user's code, and deleting a
 * widget must not delete someone's work -- so those stay, and the compiler says what to do about them.
 */
export function pruneHandlerStubs(existing: string, document: DesignerDocument): string {
    const wanted = new Set(requiredHandlers(document));
    // One block per handler: an optional `#[allow(dead_code)]`, the doc comment, the signature, and a body with
    // no braces of its own. A function whose body does have braces is one the user wrote, and it is returned
    // untouched -- the match stops early, which is why the body is non-greedy rather than counted.
    const block = /(?:#\[allow\(dead_code\)\]\n)?(?:\/\/\/[^\n]*\n)*pub fn (\w+)\s*\([^)]*\)\s*\{\n([\s\S]*?)\n\}\n?/g;
    return existing.replace(block, (matched, name: string, body: string) =>
        wanted.has(name) || !isUntouchedStub(body, name) ? matched : '',
    );
}

/**
 * The code-behind for a design: the stubs it needs, minus the ones it no longer does.
 *
 * One call so a caller cannot add without pruning -- which is what left a deleted widget's handler behind for
 * ever, and what made "the designer appends a stub for an event that has none" true of this module and false
 * of the extension, since nothing called it between the wizard and the next save.
 */
export function syncHandlerStubs(existing: string, document: DesignerDocument, touch = true): string {
    return pruneHandlerStubs(appendHandlerStubs(existing, document, touch), document);
}

/**
 * Every widget the design places must be one the generated code can name.
 *
 * The spacer is the exception, and it raises no events, so nothing is dispatched to it. This exists because
 * the alternative -- a design that validates in the panel and fails in rustc -- is the kind of feedback loop
 * the designer is meant to remove.
 */
export function missingFromGeneratedCode(document: DesignerDocument): string[] {
    const problems: string[] = [];
    if (document.screenId !== PINNED_SCREEN_ID) {
        problems.push(
            `the screen id must stay "${PINNED_SCREEN_ID}" in a generated project: src/ui.rs names the ` +
            `generated types after it`,
        );
    }
    for (const widget of document.widgets) {
        const spec = widgetSpec(widget.tag);
        if (spec !== undefined && spec.addressable === false && widget.events.length > 0) {
            problems.push(`"${widget.id}": a ${spec.label.toLowerCase()} has no id in the generated code, so it cannot raise events`);
        }
        if (spec?.children !== undefined && widget.children === undefined) {
            problems.push(`"${widget.id}": a ${spec.label.toLowerCase()} needs a body`);
        }
    }
    return problems;
}

/** The starter design's children, so a hand-built document is never missing one. */
export function withStarterChildren(document: DesignerDocument): DesignerDocument {
    return {
        ...document,
        widgets: document.widgets.map((widget) => ({
            ...widget,
            children: widget.children ?? defaultChildren(widget.tag),
        })),
    };
}
