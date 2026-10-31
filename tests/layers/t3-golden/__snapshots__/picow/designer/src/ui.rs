// Grumpy's Rusty Platform -- the design's Rust side.
//
// Generated. The markup it compiles (src/ui.kdl) is what the designer rewrites on every save,
// and the handlers it calls are declared in src/ui_handlers.rs, which is yours. There is nothing to
// edit here that the designer would not put back.
//
// rusty-designer-ui

// Through embedded_graphics, not embedded_graphics_core: the project declares the former, which re-exports
// the latter's types, and naming the core crate directly does not resolve (found by building a generated
// project).
use core::cell::{Ref, RefCell, RefMut};
use embedded_graphics::draw_target::DrawTarget;
use embedded_graphics::pixelcolor::Rgb565;
use embedded_gui::prelude::*;
use embassy_time::Instant;

/// The screen, compiled from the markup the designer writes.
mod design {
    use embedded_gui::prelude::*;
    embedded_gui::include_gui!("src/ui.kdl");
}

pub use design::RustyPanelWidgets;

/// Node budget: the markup's own widget count plus headroom, so the designer cannot outgrow a constant.
pub const NODES: usize = design::RustyPanelApp::NODE_COUNT + 8;
/// Whether the design draws a clock -- what decides whether the firmware keeps a time at all.
pub const HAS_CLOCK: bool = false;
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


/// Any widget, by the name the design gave it.
///
/// A handle borrows the design, not the GUI, so several can be alive at once and the app never holds a
/// WidgetId of its own: design.title().set_text("Ready"), design.panel().set_background(Some(Rgb565::new(2, 4, 2))).
#[allow(dead_code)]
pub struct WidgetHandle<'a> {
    design: &'a Designer,
    id: WidgetId,
}

#[allow(dead_code)]
impl WidgetHandle<'_> {
    pub fn id(&self) -> WidgetId {
        self.id
    }

    /// The text of a label, button, toggle or checkbox. Borrowed for the life of the program, so nothing is
    /// copied: a line put together at runtime needs a text panel, not a label.
    pub fn set_text(&self, text: &'static str) {
        let _ = self.design.gui.borrow_mut().set_text(self.id, text);
    }

    /// Whether it is drawn, and whether it can be pointed at.
    pub fn set_visible(&self, visible: bool) {
        let _ = self.design.gui.borrow_mut().set_visible(self.id, visible);
    }

    /// Whether it answers the pointer at all -- a disabled button still draws, and does nothing.
    pub fn set_enabled(&self, enabled: bool) {
        let _ = self.design.gui.borrow_mut().set_enabled(self.id, enabled);
    }

    /// Moves and resizes it in one go, in the design's own pixels.
    pub fn set_rect(&self, rect: Rect) {
        let _ = self.design.gui.borrow_mut().set_widget_rect(self.id, rect);
    }

    pub fn set_position(&self, x: i32, y: i32) {
        let mut gui = self.design.gui.borrow_mut();
        let _ = gui.set_widget_x(self.id, x);
        let _ = gui.set_widget_y(self.id, y);
    }

    pub fn set_size(&self, width: u32, height: u32) {
        let mut gui = self.design.gui.borrow_mut();
        let _ = gui.set_widget_width(self.id, width);
        let _ = gui.set_widget_height(self.id, height);
    }

    pub fn set_opacity(&self, opacity: u8) {
        let _ = self.design.gui.borrow_mut().set_widget_opacity(self.id, opacity);
    }

    pub fn set_corner_radius(&self, radius: u8) {
        let _ = self.design.gui.borrow_mut().set_widget_corner_radius(self.id, radius);
    }

    pub fn set_accent(&self, colour: Rgb565) {
        let _ = self.design.gui.borrow_mut().set_widget_accent(self.id, colour);
    }

    pub fn set_text_colour(&self, colour: Rgb565) {
        let _ = self.design.gui.borrow_mut().set_widget_text_color(self.id, colour);
    }

    /// None makes it transparent again.
    pub fn set_background(&self, colour: Option<Rgb565>) {
        let _ = self.design.gui.borrow_mut().set_widget_background(self.id, colour);
    }
}
/// The screen, and the pointer state the widgets need to see a press and a release as a pair.
///
/// A board with no touch controller cannot raise an event, so the pointer plumbing below is never called --
/// kept so that the same design compiles for both kinds of board rather than two shapes of this file.
#[allow(dead_code)]
pub struct Designer {
    /// The design's context, in a RefCell so a widget handle can hold the design rather than the GUI.
    ///
    /// That is what makes design.log().add_line(design.keypad().text) possible at all: two handles hold
    /// shared borrows of the design, and the mutation goes through this cell. What it cannot do is panic on
    /// a nested borrow -- the outer borrow checker refuses to hold a handle across anything taking the
    /// design mutably (render, pump), so the only borrows that can overlap are our own, and they do not.
    gui: RefCell<GuiContext<'static, NODES, EVENTS, DIRTY>>,
    /// The widget ids, named the way the design names them.
    pub widgets: RustyPanelWidgets,
    down: bool,
    painted: bool,
    /// The wall clock the hands follow once the board has been told the time: the local
    /// time it was told, and the instant it was told. `None` until then -- and on a board
    /// with no RTC that survives power-off, for ever.
    #[allow(dead_code)]
    wall_base: Option<(Instant, u32)>,
}

#[allow(dead_code)]
impl Designer {
    /// Builds the screen once, at the size the panel is actually drawn at.
    pub fn new(width: u32, height: u32) -> Self {
        let mut gui = GuiContext::new(Rect::new(0, 0, width, height));
        let app = design::RustyPanelApp::build(&mut gui).expect("the design fits its node budget");
        Self {
            gui: RefCell::new(gui),
            widgets: app.widgets,
            down: false,
            painted: false,
            wall_base: None,
        }
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
    pub fn gui(&self) -> Ref<'_, GuiContext<'static, NODES, EVENTS, DIRTY>> {
        self.gui.borrow()
    }

    /// The same, mutably: the setters all take &mut self.
    ///
    /// A borrow, not a reference: the design keeps its context behind a RefCell so the widget handles below
    /// can hold the design and still write to it. The guard behaves like the reference it replaces -- it
    /// derefs to the context and is dropped at the end of the statement.
    #[allow(dead_code)]
    pub fn gui_mut(&mut self) -> RefMut<'_, GuiContext<'static, NODES, EVENTS, DIRTY>> {
        self.gui.borrow_mut()
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
        let _ = self.gui.borrow_mut().handle_input(event);
    }

    /// Hands whatever the widgets raised to the code-behind.
    pub fn pump(&mut self) {
        loop {
            // Out of the loop condition and into a block of its own: a temporary borrow of the cell lives
            // until the end of the statement it is written in, so asking for the next event inside while-let
            // would keep the design borrowed for the whole body -- and the arms below borrow it again.
            let next = { self.gui.borrow_mut().pop_event() };
            let Some(event) = next else { break };
            match event {
                UiEvent::Clicked(id) if id == self.widgets.go => crate::ui_handlers::on_go_clicked(),
                _ => {}
            }
        }
    }

    /// True when something changed and the panel needs repainting.
    pub fn is_dirty(&self) -> bool {
        !self.gui.borrow().dirty_regions().is_empty()
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
        let mut gui = self.gui.borrow_mut();
        let result = if self.painted {
            // A partial repaint paints the damaged regions and nothing else, and the design paints
            // no screen background of its own -- so the regions are cleared to the colour the panel
            // started as first. Without this a moving clock drew each new hand and left the old one
            // on the glass (reported 2026-10-17).
            gui.paint_damage(target, SCREEN_BACKGROUND)
                .and_then(|()| gui.render_dirty(target))
        } else {
            gui.render(target)
        };
        self.painted = true;
        gui.clear_dirty();
        result
    }

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

    }

    /// The label named title.
    #[allow(dead_code)]
    pub fn title(&self) -> WidgetHandle<'_> {
        WidgetHandle {
            design: self,
            id: self.widgets.title,
        }
    }

    /// The button named go.
    #[allow(dead_code)]
    pub fn go(&self) -> WidgetHandle<'_> {
        WidgetHandle {
            design: self,
            id: self.widgets.go,
        }
    }
}
