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
/// The ADC input the status bar's battery gauge reads, when the design named one.
#[allow(dead_code)]
pub const BATTERY_PIN: Option<u8> = None;
/// What multiplies the pin's voltage to give the battery's: 2 for a divider that halves it.
#[allow(dead_code)]
pub const BATTERY_SCALE: f32 = 2.00;

/// The cell this gauge was calibrated on, as (voltage in millivolts, charge in percent), ascending.
///
/// A single Li-ion cell: 2.75 V is empty and 4.20 V is full, and between the measured points the gauge
/// interpolates rather than assuming a straight line from empty to full -- the middle of a Li-ion discharge
/// curve is nearly flat, so a straight line reads half full on a cell that is almost flat.
const BATTERY_CURVE: [(u16, u8); 24] = [
    (2750, 0), (2900, 2), (3000, 4), (3100, 7), (3200, 10), (3300, 14),
    (3350, 17), (3400, 20), (3450, 24), (3500, 28), (3550, 32), (3600, 37),
    (3650, 42), (3700, 47), (3750, 52), (3800, 58), (3850, 64), (3900, 70),
    (3950, 76), (4000, 82), (4050, 87), (4100, 92), (4150, 97), (4200, 100),
];

/// A raw ADC sample as a battery percentage.
///
/// The sample is the pin's voltage on the ADC's 0-4095 scale, and BATTERY_SCALE turns it into the battery's
/// voltage (2 for a divider that halves it). The percentage is read off BATTERY_CURVE, interpolated between
/// the two measured points either side of it and clamped at the ends, so a cell below 2.75 V reads 0% rather
/// than a negative number. A different chemistry needs this curve changed rather than the gauge.
#[allow(dead_code)]
pub fn battery_percent(raw: u16) -> u8 {
    let pin_mv = f32::from(raw) * 3300.0 / 4095.0;
    battery_percent_at((pin_mv * BATTERY_SCALE) as i32)
}

/// BATTERY_CURVE's answer for a cell voltage in millivolts: linear between the measured points, clamped to
/// the first and last of them.
fn battery_percent_at(battery_mv: i32) -> u8 {
    if battery_mv <= i32::from(BATTERY_CURVE[0].0) {
        return BATTERY_CURVE[0].1;
    }
    for pair in BATTERY_CURVE.windows(2) {
        let (lo_mv, lo_percent) = pair[0];
        let (hi_mv, hi_percent) = pair[1];
        if battery_mv > i32::from(hi_mv) {
            continue;
        }
        let span_mv = i32::from(hi_mv) - i32::from(lo_mv);
        let span_percent = i32::from(hi_percent) - i32::from(lo_percent);
        let above = battery_mv - i32::from(lo_mv);
        // Half a step rounds up, in whole percent: the gauge has no digits to spend on a fraction.
        return (i32::from(lo_percent) + (above * span_percent + span_mv / 2) / span_mv) as u8;
    }
    BATTERY_CURVE[BATTERY_CURVE.len() - 1].1
}
/// Queued events and damage rectangles: what a finger produces between two frames.
///
/// Sixteen, not eight: a moving hand is damaged as four narrow pieces (hand_damage_regions), and the
/// second and minute hands can move in the same frame -- plus the date block on a midnight.
pub const EVENTS: usize = 16;
pub const DIRTY: usize = 16;

/// The pixels a partial repaint is composed in before it is flushed, in one band or several.
///
/// The damaged regions are rendered here (cleared to SCREEN_BACKGROUND first) and then written
/// contiguously, so the panel never shows the cleared region before its contents. That is what stops a
/// moving clock hand from making the date text blink as it crosses.
pub const DAMAGE_SCRATCH: usize = 960;

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

    /// The level the battery gauge shows, 0-100, and whether it is charging.
    ///
    /// A status bar is the widget this is meant for; the crate refuses any other. Feed it from the ADC
    /// reading at BATTERY_PIN, or from any source the app already has.
    pub fn set_battery(&self, percent: u8, charging: bool) {
        let _ = self
            .design
            .gui
            .borrow_mut()
            .set_status_bar_battery(self.id, percent, charging);
    }

    /// The free-text label on a status bar's left edge, replaced at run time.
    ///
    /// A status bar is the widget this is meant for; the crate refuses any other. The design's own label is
    /// what the bar shows until this is called, and the clock beside it is untouched: design.status_bar().set_status_bar_label("WiFi")
    /// works whether or not the bar draws a time. A line built at run time costs nothing on the heap and needs
    /// no lifetime: the crate copies it into the bar's own field. It is ASCII, truncated to what the field holds.
    pub fn set_status_bar_label(&self, label: &str) {
        let _ = self
            .design
            .gui
            .borrow_mut()
            .set_status_bar_label(self.id, label);
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
    /// Where a partial repaint is composed before it is flushed (see DAMAGE_SCRATCH).
    damage_scratch: [Rgb565; DAMAGE_SCRATCH],
    /// The wall clock the hands and the date block follow once the board has been told the
    /// time: the local seconds of day it was told, the calendar day when the hand-over
    /// carried one, and the instant it was told. `None` until then.
    #[allow(dead_code)]
    wall_base: Option<(Instant, Option<i64>, u32)>,
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
            damage_scratch: [Rgb565::new(0, 0, 0); DAMAGE_SCRATCH],
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
            // A partial repaint is composed in the scratch buffer -- cleared to the colour the panel
            // started as -- and written once per band. Painting the damaged region on the glass in two
            // passes (clear, then draw) is what made a clock's date text blink as a hand crossed it
            // (bench, 2026-11-25); the old hand is still erased because the scratch starts from the
            // background, but the panel never shows the blank in between.
            gui.render_dirty_buffered_with(
                target,
                &mut self.damage_scratch,
                SCREEN_BACKGROUND,
            )
        } else {
            gui.render(target)
        };
        self.painted = true;
        gui.clear_dirty();
        result
    }

    /// Tells the design the local date and time. This is what the generated firmware calls when its
    /// RTC, a network answer or the host hands a full wall clock over.
    ///
    /// The anchor is kept rather than the time being counted, so a frame that took two seconds -- or
    /// a loop that was asleep -- cannot make the hands lose a second. Out-of-range fields are clamped
    /// rather than wrapped, the same rule the clock itself follows.
    pub fn set_wall_datetime(&mut self, year: u16, month: u8, day: u8, hour: u8, minute: u8, second: u8) {
        let now = Instant::now();
        let year = year.clamp(2000, 9999);
        let month = month.clamp(1, 12);
        let day = day.clamp(1, embedded_gui::widgets::clock::days_in_month(year, month));
        let days = embedded_gui::widgets::clock::days_from_civil(year as i64, month, day);
        let start = hour.min(23) as u32 * 3600 + minute.min(59) as u32 * 60 + second.min(59) as u32;
        self.wall_base = Some((now, Some(days), start % 86_400));

    }

    /// The time-only hand-over an older project's main.rs still calls. The clocks keep the date
    /// their design gave them, because a time alone cannot say which day it belongs to.
    #[allow(dead_code)]
    pub fn set_wall_clock(&mut self, hour: u8, minute: u8, second: u8) {
        let now = Instant::now();
        let start = hour.min(23) as u32 * 3600 + minute.min(59) as u32 * 60 + second.min(59) as u32;
        self.wall_base = Some((now, None, start % 86_400));

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
