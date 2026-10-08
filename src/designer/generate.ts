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

import { EVENT_SPECS, type DesignerEvent, widgetSpec } from './catalog';
import {
    type DesignerDocument,
    type DesignerWidget,
    createDocument,
    designCanvasSize,
    defaultChildren,
    defaultProps,
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
    const parameter = EVENT_SPECS[event].parameter;
    return parameter === undefined ? '' : `${parameter.name}: ${parameter.type}`;
}

/** Every handler a design needs, in document order, without duplicates. */
export function requiredHandlers(document: DesignerDocument): string[] {
    const names: string[] = [];
    for (const widget of document.widgets) {
        for (const event of widget.events) {
            const name = handlerName(widget.id, event);
            if (!names.includes(name)) {
                names.push(name);
            }
        }
    }
    return names;
}

/** The call an event makes, with whatever the variant carries. */
function handlerCall(widget: DesignerWidget, event: DesignerEvent): string {
    const name = handlerName(widget.id, event);
    const parameter = EVENT_SPECS[event].parameter;
    if (parameter === undefined) {
        return `${name}()`;
    }
    // `Scroll { id, delta }` binds `delta`, `TextInput { id, ch }` binds `ch`.
    return `${name}(${parameter.name})`;
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
    const arms = document.widgets.flatMap((widget) =>
        widget.events.map((event) => {
            const spec = EVENT_SPECS[event];
            const field = rustFieldName(widget.id);
            return `                UiEvent::${spec.pattern} if id == self.widgets.${field} => crate::ui_handlers::${handlerCall(widget, event)},`;
        }),
    );
    const armText = arms.length === 0 ? '                // No widget in this design raises an event yet.' : arms.join('\n');

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

/// The screen, compiled from the markup the designer writes.
mod design {
    use embedded_gui::prelude::*;
    embedded_gui::include_gui!("${DESIGNER_FILES.markup}");
}

pub use design::${PINNED_SCREEN_ID}Widgets;

/// Node budget: the markup's own widget count plus headroom, so the designer cannot outgrow a constant.
pub const NODES: usize = design::${PINNED_SCREEN_ID}App::NODE_COUNT + 8;
/// Queued events and damage rectangles: what a finger produces between two frames.
pub const EVENTS: usize = 16;
pub const DIRTY: usize = 8;

/// The screen, and the pointer state the widgets need to see a press and a release as a pair.
${touch ? '' : `///
/// A board with no touch controller cannot raise an event, so the pointer plumbing below is never called --
/// kept so that the same design compiles for both kinds of board rather than two shapes of this file.
#[allow(dead_code)]
`}pub struct Designer {
    gui: GuiContext<'static, NODES, EVENTS, DIRTY>,
    /// The widget ids, named the way the design names them.
    pub widgets: ${PINNED_SCREEN_ID}Widgets,
    down: bool,
    painted: bool,
}

${touch ? '' : '#[allow(dead_code)]\n'}impl Designer {
    /// Builds the screen once, at the size the panel is actually drawn at.
    pub fn new(width: u32, height: u32) -> Self {
        let mut gui = GuiContext::new(Rect::new(0, 0, width, height));
        let app = design::${PINNED_SCREEN_ID}App::build(&mut gui).expect("the design fits its node budget");
        Self {
            gui,
            widgets: app.widgets,
            down: false,
            painted: false,
        }
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

    /// True when something changed and the panel needs repainting.
    pub fn is_dirty(&self) -> bool {
        !self.gui.dirty_regions().is_empty()
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
        let result = if self.painted {
            self.gui.render_dirty(target)
        } else {
            self.gui.render(target)
        };
        self.painted = true;
        self.gui.clear_dirty();
        result
    }
}
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
        return `${touch ? '' : '#[allow(dead_code)]\n'}/// Raised by the design. Called from \`ui::Designer::pump\`.
pub fn ${name}(${parameters}) {
    log::info!("design: ${name} fired");
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
