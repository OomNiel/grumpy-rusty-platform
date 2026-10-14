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
use embedded_graphics::draw_target::DrawTarget;
use embedded_graphics::pixelcolor::Rgb565;
use embedded_gui::prelude::*;

/// The screen, compiled from the markup the designer writes.
mod design {
    use embedded_gui::prelude::*;
    embedded_gui::include_gui!("src/ui.kdl");
}

pub use design::RustyPanelWidgets;

/// Node budget: the markup's own widget count plus headroom, so the designer cannot outgrow a constant.
pub const NODES: usize = design::RustyPanelApp::NODE_COUNT + 8;
/// Queued events and damage rectangles: what a finger produces between two frames.
pub const EVENTS: usize = 16;
pub const DIRTY: usize = 8;

/// The screen, and the pointer state the widgets need to see a press and a release as a pair.
///
/// A board with no touch controller cannot raise an event, so the pointer plumbing below is never called --
/// kept so that the same design compiles for both kinds of board rather than two shapes of this file.
#[allow(dead_code)]
pub struct Designer {
    gui: GuiContext<'static, NODES, EVENTS, DIRTY>,
    /// The widget ids, named the way the design names them.
    pub widgets: RustyPanelWidgets,
    down: bool,
    painted: bool,
}

#[allow(dead_code)]
impl Designer {
    /// Builds the screen once, at the size the panel is actually drawn at.
    pub fn new(width: u32, height: u32) -> Self {
        let mut gui = GuiContext::new(Rect::new(0, 0, width, height));
        let app = design::RustyPanelApp::build(&mut gui).expect("the design fits its node budget");
        Self {
            gui,
            widgets: app.widgets,
            down: false,
            painted: false,
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
                UiEvent::Clicked(id) if id == self.widgets.go => crate::ui_handlers::on_go_clicked(),
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
