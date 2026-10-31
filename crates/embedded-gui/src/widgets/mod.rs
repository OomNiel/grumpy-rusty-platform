#![allow(unused_imports)]

use core::fmt::Write;

use embedded_graphics_core::pixelcolor::{Rgb565, RgbColor};
use heapless::String;

#[cfg(not(feature = "std"))]
use crate::math::F32Ext as _;
use crate::{
    block::Block,
    geometry::{EdgeInsets, Rect},
    image::{ImageFit, ImageRef, ReelPlayer},
    mono::{IconAlign, IconPart, MonoBitmap},
    render::{Compositor, RenderCtx, StrokeStyle, TextAlign, TextStyle, TextWrap, VerticalAlign},
    state::ListState,
    style::{Border, Style, VisualState, WidgetStyle},
    widget::{
        FocusGroupId, PropertyError, PropertyKey, PropertyValue, StyleClassId, WidgetFlags,
        WidgetId,
    },
};

pub mod action_menu;
pub mod bandmeter;
pub mod basic;
pub mod cinematic;
pub mod clock;
pub mod compass;
pub mod controls;
pub mod data;
pub mod dialog;
pub mod gauges;
pub mod inverter;
pub mod keypad;
pub mod matrix;
pub mod notification;
pub mod picker;
pub mod repeater;
pub mod rich_text_node;
pub mod scale;
pub mod segmented;
pub mod sparkline;
pub mod spinbox;
pub mod status_bar;
pub mod table;
pub mod timeline;
pub mod wearable;

pub use segmented::{
    encode_14seg, encode_7seg, SegmentStyle, SevenSegmentDisplay, SEG_14_A1, SEG_14_A2, SEG_14_B,
    SEG_14_C, SEG_14_D1, SEG_14_D2, SEG_14_E, SEG_14_F, SEG_14_G1, SEG_14_G2, SEG_14_H, SEG_14_J,
    SEG_14_K, SEG_14_L, SEG_14_M, SEG_14_N, SEG_7_A, SEG_7_B, SEG_7_C, SEG_7_D, SEG_7_DP, SEG_7_E,
    SEG_7_F, SEG_7_G,
};

pub use action_menu::{ActionMenuError, ActionMenuItem, ActionMenuWidget};
pub use bandmeter::{BandMeterWidget, MeterOrientation};
pub use basic::{ButtonWidget, LabelWidget, PanelWidget, SpacerWidget};
pub use cinematic::GlanceTileWidget;
pub use clock::ClockWidget;
pub use compass::{CompassMode, CompassWidget};
pub use controls::{
    CheckboxLabelPosition, CheckboxWidget, RollerSelection, SliderWidget, ToggleWidget,
};
pub use data::ListWidget;
pub use dialog::{
    ActionableDialogWidget, ConfirmationDialogWidget, DialogAction, DialogError, DialogType,
};
pub use gauges::{ArcGaugeWidget, GaugeThreshold, ProgressBarWidget};
pub use inverter::InverterWidget;
pub use keypad::{KeypadKey, KeypadMode, KeypadWidget, KEYPAD_CAPACITY};
pub use matrix::MatrixWidget;
pub use notification::{
    NotificationAction, NotificationError, NotificationPriority, NotificationSheetWidget,
};
pub use picker::{NumberPickerWidget, PickerError, TimeFormat, TimePickerField, TimePickerWidget};
pub use repeater::RepeaterWidget;
pub use rich_text_node::{RichTextError, RichTextNodeWidget, TextSpan};
pub use scale::{ScaleMode, ScaleWidget};
pub use sparkline::SparklineWidget;
pub use spinbox::SpinboxWidget;
pub use status_bar::{BatteryState, StatusBarError, StatusBarMode, StatusBarWidget};
pub use table::TableWidget;
pub use timeline::{PeekBannerWidget, TimelineNodeState, TimelineNodeWidget};
pub use wearable::{
    ActionBarSlot, ActionBarWidget, ContentIndicatorDirection, ContentIndicatorWidget,
    CrumbsIndicatorWidget, SelectionWidget,
};

pub const TEXTAREA_CAPACITY: usize = 128;

/// How many lines a [`WidgetKind::TextLines`] panel can hold.
///
/// Small on purpose. The widest `WidgetKind` variant sets the size of *every* widget node in the
/// budget, so a panel nobody dropped still costs this much per slot. A project that needs more
/// raises it here: the type is built from the constant, so the change is compile-time.
pub const TEXT_LINES_CAPACITY: usize = 8;

/// How many bytes one *copied* line may occupy (`set_line_owned`).
///
/// Only copied lines are bounded: a borrowed line is an `&str` the design already owns, so a static
/// table of long lines costs nothing but the two words of its pointer.
pub const TEXT_LINE_BYTES: usize = 32;

/// One entry of a [`WidgetKind::TextLines`] panel.
///
/// Either a borrowed string -- the design's own `&'static str`, no copy, no RAM -- or a copy in a
/// fixed inline buffer, which is what lets a line built at runtime reach the panel without a heap.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TextLine<'a> {
    Borrowed(&'a str),
    Owned {
        bytes: [u8; TEXT_LINE_BYTES],
        len: u8,
    },
}

impl<'a> TextLine<'a> {
    /// The text of the line, whichever way it is stored.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Borrowed(text) => text,
            Self::Owned { bytes, len } => {
                let used = (*len as usize).min(TEXT_LINE_BYTES);
                core::str::from_utf8(&bytes[..used]).unwrap_or("")
            }
        }
    }

    /// Copies `text` in, truncating at `TEXT_LINE_BYTES` on a character boundary.
    ///
    /// An empty source is accepted: clearing one line is a real thing to do, and refusing it would
    /// make the caller special-case a string that is simply empty.
    fn set_owned(&mut self, text: &str) {
        let mut len = text.len().min(TEXT_LINE_BYTES);
        // Never split a character: a half a UTF-8 sequence is not a shorter line, it is a corrupt
        // one, and `from_utf8` would answer an empty string for it.
        while len > 0 && !text.is_char_boundary(len) {
            len -= 1;
        }
        let mut bytes = [0u8; TEXT_LINE_BYTES];
        bytes[..len].copy_from_slice(&text.as_bytes()[..len]);
        *self = Self::Owned {
            bytes,
            len: len as u8,
        };
    }
}

/// A read-only panel of text lines, each folded to the widget's own width.
///
/// The point of the widget is that neither the folding nor the stacking is the caller's business: a
/// long entry wraps to as many rows as it needs, and everything below it moves down by exactly that
/// much. So the text positions itself against the *font* -- advance width decides where a line folds
/// and line height decides where the next one starts -- and the rect only decides where it stops.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextLines<'a> {
    lines: [TextLine<'a>; TEXT_LINES_CAPACITY],
    len: u8,
    /// Blank pixels between one logical line and the next, on top of the font's own line spacing.
    pub gap: u8,
}

impl Default for TextLines<'_> {
    fn default() -> Self {
        Self {
            lines: [TextLine::Borrowed(""); TEXT_LINES_CAPACITY],
            len: 0,
            gap: 0,
        }
    }
}

impl<'a> TextLines<'a> {
    pub const fn new() -> Self {
        Self {
            lines: [TextLine::Borrowed(""); TEXT_LINES_CAPACITY],
            len: 0,
            gap: 0,
        }
    }

    /// A panel holding `lines`, in order, dropping any that do not fit the storage.
    pub fn from_slice(lines: &[&'a str]) -> Self {
        let mut panel = Self::new();
        for line in lines.iter().take(TEXT_LINES_CAPACITY) {
            panel.lines[panel.len as usize] = TextLine::Borrowed(line);
            panel.len += 1;
        }
        panel
    }

    pub const fn gap(mut self, gap: u8) -> Self {
        self.gap = gap;
        self
    }

    /// How many lines the panel holds. Not how many are *visible*: that depends on the rect, the
    /// font and how far each line folds.
    pub const fn len(&self) -> usize {
        self.len as usize
    }

    pub const fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn get(&self, index: usize) -> Option<&str> {
        if index < self.len as usize {
            Some(self.lines[index].as_str())
        } else {
            None
        }
    }

    /// Replaces one line with a borrowed string.
    pub fn set(&mut self, index: usize, text: &'a str) -> bool {
        match self.lines.get_mut(index) {
            Some(slot) if index < self.len as usize => {
                *slot = TextLine::Borrowed(text);
                true
            }
            _ => false,
        }
    }

    /// Replaces one line with a copy of `text`, truncated to `TEXT_LINE_BYTES`.
    pub fn set_owned(&mut self, index: usize, text: &str) -> bool {
        match self.lines.get_mut(index) {
            Some(slot) if index < self.len as usize => {
                slot.set_owned(text);
                true
            }
            _ => false,
        }
    }

    /// Appends a borrowed line. `false` when the storage is full.
    pub fn push(&mut self, text: &'a str) -> bool {
        if self.len as usize >= TEXT_LINES_CAPACITY {
            return false;
        }
        self.lines[self.len as usize] = TextLine::Borrowed(text);
        self.len += 1;
        true
    }

    /// Appends a copy of `text`. `false` when the storage is full.
    pub fn push_owned(&mut self, text: &str) -> bool {
        if self.len as usize >= TEXT_LINES_CAPACITY {
            return false;
        }
        let mut slot = TextLine::Borrowed("");
        slot.set_owned(text);
        self.lines[self.len as usize] = slot;
        self.len += 1;
        true
    }

    /// Inserts a borrowed line at `index`, moving the rest down. `false` when the storage is full.
    pub fn insert(&mut self, index: usize, text: &'a str) -> bool {
        if index >= self.len as usize {
            return self.push(text);
        }
        if self.len as usize >= TEXT_LINES_CAPACITY {
            return false;
        }
        let from = index;
        let to = self.len as usize;
        for slot in (from..to).rev() {
            self.lines[slot + 1] = self.lines[slot];
        }
        self.lines[index] = TextLine::Borrowed(text);
        self.len += 1;
        true
    }

    /// Inserts a copy of `text` at `index`, moving the rest down. `false` when the storage is full.
    pub fn insert_owned(&mut self, index: usize, text: &str) -> bool {
        if index >= self.len as usize {
            return self.push_owned(text);
        }
        if self.len as usize >= TEXT_LINES_CAPACITY {
            return false;
        }
        let from = index;
        let to = self.len as usize;
        for slot in (from..to).rev() {
            self.lines[slot + 1] = self.lines[slot];
        }
        let mut line = TextLine::Borrowed("");
        line.set_owned(text);
        self.lines[index] = line;
        self.len += 1;
        true
    }

    /// Removes one line, moving the rest up -- `remove(0)` is how a log drops its oldest entry.
    pub fn remove(&mut self, index: usize) -> bool {
        if index >= self.len as usize {
            return false;
        }
        let last = self.len as usize - 1;
        for slot in index..last {
            self.lines[slot] = self.lines[slot + 1];
        }
        self.lines[last] = TextLine::Borrowed("");
        self.len -= 1;
        true
    }

    pub fn clear(&mut self) {
        self.lines = [TextLine::Borrowed(""); TEXT_LINES_CAPACITY];
        self.len = 0;
    }

    pub fn iter(&self) -> impl Iterator<Item = &str> + '_ {
        (0..self.len as usize).map(move |index| self.lines[index].as_str())
    }

    /// How many pixels the lines take at `max_chars` per visual row, gaps included.
    ///
    /// `line_h` and `spacing` come from the resolved style, so the answer is in the font's own
    /// units rather than in pixels guessed by the caller.
    pub fn height_at(&self, max_chars: usize, line_h: u32, spacing: u32) -> u32 {
        let mut total = 0u32;
        for index in 0..self.len as usize {
            let rows =
                crate::render::count_lines(self.lines[index].as_str(), max_chars, TextWrap::Word)
                    .max(1) as u32;
            total += rows * line_h + rows.saturating_sub(1) * spacing;
            if index + 1 < self.len as usize {
                total += self.gap as u32;
            }
        }
        total
    }

    /// The first line index whose folded block does not fit in `available` pixels, or `None` when
    /// they all do. What the renderer uses to decide where to stop -- and what a caller can use to
    /// know how many entries the rect can show.
    pub fn first_hidden(
        &self,
        max_chars: usize,
        line_h: u32,
        spacing: u32,
        available: u32,
    ) -> Option<usize> {
        let mut used = 0u32;
        for index in 0..self.len as usize {
            let rows =
                crate::render::count_lines(self.lines[index].as_str(), max_chars, TextWrap::Word)
                    .max(1) as u32;
            let entry = rows * line_h + rows.saturating_sub(1) * spacing;
            let gap = if index + 1 < self.len as usize {
                self.gap as u32
            } else {
                0
            };
            if used + entry > available {
                return Some(index);
            }
            used += entry + gap;
        }
        None
    }
}

/// Geometry and motion of a [`WidgetKind::Carousel`].
///
/// Every measurement is in pixels so a layout ports exactly between the host
/// preview and firmware; nothing here is derived from the widget rect.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CarouselSpec {
    /// Vertical pitch between item rows.
    pub item_step: u16,
    /// Total rows drawn, including the selected one. Even values round up to
    /// keep the selection centered.
    pub visible_slots: u8,
    /// In-flight scroll offset, driven by the caller's animation clock.
    pub shift: i16,
    /// Height of the background bands painted immediately above and below the
    /// widget after its rows are drawn. Rows near the edge overhang the rect;
    /// masking the neighbouring chrome makes them scroll *behind* a header and
    /// footer instead of colliding with them. Draw that chrome after the
    /// carousel so it survives the mask.
    pub mask_top: u16,
    pub mask_bottom: u16,
    /// Darkens the rows nearest the top and bottom edges.
    pub fade_edges: bool,
    /// Draws accent bars flanking the selected row.
    pub indicator: bool,
    /// Scales the indicator's accent color, letting the caller pulse it.
    pub indicator_pulse: u8,
    pub indicator_bar_w: u16,
    pub indicator_bar_h: u16,
    pub indicator_gap: u16,
}

impl Default for CarouselSpec {
    fn default() -> Self {
        Self {
            item_step: 16,
            visible_slots: 7,
            shift: 0,
            mask_top: 0,
            mask_bottom: 0,
            fade_edges: true,
            indicator: false,
            indicator_pulse: 255,
            indicator_bar_w: 5,
            indicator_bar_h: 3,
            indicator_gap: 6,
        }
    }
}

impl CarouselSpec {
    pub fn new(item_step: u16, visible_slots: u8) -> Self {
        Self {
            item_step,
            visible_slots,
            ..Self::default()
        }
    }
}

/// Scale and placement of a [`WidgetKind::CompositeIcon`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompositeIconSpec {
    /// Nearest-neighbor upscale, which keeps pixel art crisp.
    pub scale: u8,
    pub align: IconAlign,
    /// Fill for non-ink pixels. `None` leaves the backdrop visible.
    pub paper: Option<Rgb565>,
}

impl Default for CompositeIconSpec {
    fn default() -> Self {
        Self {
            scale: 1,
            align: IconAlign::Center,
            paper: None,
        }
    }
}

/// Scales an RGB565 color by `num5/31` on the 5-bit channels and `num6/63` on
/// green, which keeps the carousel falloff exact at any base color.
#[inline]
fn scale_rgb565(color: Rgb565, num5: u16, num6: u16) -> Rgb565 {
    Rgb565::new(
        ((u16::from(color.r()) * num5) / 31) as u8,
        ((u16::from(color.g()) * num6) / 63) as u8,
        ((u16::from(color.b()) * num5) / 31) as u8,
    )
}

/// Per-slot brightness falloff, indexed by distance from the selected row.
const CAROUSEL_FALLOFF: [(u16, u16); 4] = [(31, 63), (12, 24), (6, 12), (3, 6)];

#[inline]
fn carousel_slot_color(text: Rgb565, distance: u32) -> Rgb565 {
    let (n5, n6) = CAROUSEL_FALLOFF[(distance as usize).min(CAROUSEL_FALLOFF.len() - 1)];
    scale_rgb565(text, n5, n6)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SurfaceState {
    Ready,
    Loading,
    Empty,
    Error,
    Offline,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotificationLevel {
    Info,
    Success,
    Warning,
    Error,
}

/// A single selectable row in a [`WidgetKind::RichMenu`].
///
/// Mirrors PebbleOS-style menu cells: an optional icon, a primary title, and an
/// optional smaller subtitle. All data lives in static/Flash storage so the
/// widget remains zero-allocation on embedded targets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MenuCell<'a> {
    /// Primary row label.
    pub title: &'a str,
    /// Optional secondary label rendered beneath the title.
    pub subtitle: Option<&'a str>,
    /// Optional 1-bit icon rendered in the leading column.
    pub icon: Option<MonoBitmap<'a>>,
    /// When `false`, the row is drawn dimmed and skipped by selection.
    pub enabled: bool,
}

impl<'a> MenuCell<'a> {
    /// Creates a simple enabled menu cell with only a title.
    pub const fn new(title: &'a str) -> Self {
        Self {
            title,
            subtitle: None,
            icon: None,
            enabled: true,
        }
    }

    /// Adds an optional subtitle line.
    pub const fn with_subtitle(mut self, subtitle: &'a str) -> Self {
        self.subtitle = Some(subtitle);
        self
    }

    /// Adds an optional monochrome icon.
    pub const fn with_icon(mut self, icon: MonoBitmap<'a>) -> Self {
        self.icon = Some(icon);
        self
    }

    /// Marks the cell as disabled or enabled.
    pub const fn with_enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum WidgetKind<'a> {
    Panel,
    Custom(crate::widget::CustomWidgetRef<'a>),
    Label(&'a str),
    Button(&'a str),
    ProgressBar {
        value: f32,
    },
    #[cfg(feature = "rich-widgets")]
    Toggle {
        label: &'a str,
        on: bool,
        /// The track's colour when the switch is off. Upstream hard-coded a near-black literal here, which no
        /// markup could reach; `add_toggle` still passes the same colour, so nothing changes unless asked for.
        off_color: Rgb565,
        /// Outline drawn around the switch track. `None` draws none, exactly as upstream did.
        track_border: Option<Rgb565>,
        /// The outline's width in pixels. Only drawn when `track_border` is `Some` and this is greater than
        /// zero; `0` keeps upstream's outline-free track.
        track_border_width: u8,
    },
    #[cfg(feature = "rich-widgets")]
    Checkbox {
        label: &'a str,
        checked: bool,
        /// How wide the box is, in pixels. `0` keeps upstream's rule (`inner.h.min(8)`), which caps the box at
        /// eight pixels however tall the widget is -- the reason a designer checkbox looked tiny.
        box_width: u8,
        /// How tall the box is, in pixels. `0` keeps upstream's rule, exactly as `box_width` does. The two are
        /// separate so a design can ask for a wide box rather than only a square one, and the tick inside
        /// scales with them.
        box_height: u8,
        /// Which side of the box the label is drawn on.
        label_position: CheckboxLabelPosition,
        /// The box's outline. `None` keeps upstream's `style.text`, which the label shares.
        box_color: Option<Rgb565>,
    },
    #[cfg(feature = "rich-widgets")]
    Slider {
        value: f32,
        min: f32,
        max: f32,
        /// The grip's width in pixels. Its *height* is always the block's inner height, so the grip fills the
        /// space between the top and bottom borders instead of being the fixed 3x5 block upstream drew.
        /// `0` reads as this fork's default of eight pixels, which is what a design that names no width gets.
        knob_w: u32,
    },
    /// A clock face: hour and minute ticks, hour numerals and three hands.
    ///
    /// The widget is a value, not a running clock: the application sets `hour`/`minute`/`second` when it
    /// ticks, exactly as it would set a slider's value.
    #[cfg(feature = "rich-widgets")]
    Clock(clock::ClockWidget),
    /// A touch keypad: a one-line entry box and the key grid beneath it.
    ///
    /// The whole keypad is one widget, so its modes, Shift and the line being typed live in one
    /// place -- an Enter is a single event rather than twenty buttons to wire together.
    #[cfg(feature = "rich-widgets")]
    Keypad(keypad::KeypadWidget),
    #[cfg(feature = "rich-widgets")]
    ValueLabel {
        label: &'a str,
        value: i32,
    },
    #[cfg(feature = "rich-widgets")]
    IconButton {
        icon: char,
        label: &'a str,
    },
    #[cfg(feature = "rich-widgets")]
    List {
        items: &'a [&'a str],
        selected: usize,
        offset: usize,
        visible_rows: usize,
    },
    #[cfg(feature = "rich-widgets")]
    ScrollView {
        offset_y: i32,
        content_h: u32,
    },
    #[cfg(feature = "rich-widgets")]
    Tabs {
        labels: &'a [&'a str],
        selected: usize,
    },
    #[cfg(feature = "rich-widgets")]
    Dialog {
        title: &'a str,
        body: &'a str,
    },
    #[cfg(feature = "rich-widgets")]
    Toast {
        text: &'a str,
        ttl_ms: u32,
    },
    #[cfg(feature = "rich-widgets")]
    Meter {
        value: f32,
        min: f32,
        max: f32,
    },
    #[cfg(feature = "rich-widgets")]
    ArcGauge {
        value: f32,
        min: f32,
        max: f32,
        start_deg: i32,
        end_deg: i32,
        thickness: u8,
        antialias: bool,
        major_ticks: u8,
        minor_ticks: u8,
        show_value: bool,
    },
    #[cfg(feature = "rich-widgets")]
    Gauge {
        value: f32,
        min: f32,
        max: f32,
        major_ticks: u8,
        minor_ticks: u8,
        show_value: bool,
    },
    #[cfg(feature = "rich-widgets")]
    GaugeNeedle {
        value: f32,
        min: f32,
        max: f32,
        start_deg: i32,
        end_deg: i32,
    },
    /// Countdown/progress sweep: a filled pie-sector that grows clockwise
    /// with `progress` (0.0..=1.0) over a solid background, with a
    /// rounded-rect "window" punched in the middle for a caller-drawn value
    /// (e.g. a large countdown numeral in a font the crate doesn't own).
    /// Numeric-only, so it needs no lifetime and is drivable by
    /// [`crate::WidgetAnimator`] through `set_progress`.
    SweepingArc {
        progress: f32,
        /// When `true`, the sector grows clockwise from 12 o'clock (screen
        /// coordinates, y-down). When `false`, grows counter-clockwise.
        clockwise: bool,
        arc_radius: u32,
        frame_inset: u16,
        corner_radius: u8,
        bg_color: Rgb565,
        arc_color: Rgb565,
        frame_color: Rgb565,
    },
    #[cfg(feature = "rich-widgets")]
    Chart {
        values: &'a [f32],
        min: f32,
        max: f32,
        thickness: u8,
        fill_under: bool,
        markers: bool,
        mode: ChartMode,
        show_grid: bool,
        show_axes: bool,
        show_labels: bool,
    },
    Plotter {
        values: &'a [f32],
        head: usize,
        min: f32,
        max: f32,
        thickness: u8,
        show_grid: bool,
        show_axes: bool,
    },
    CircularList {
        items: &'a [&'a str],
        selected: usize,
        offset: usize,
        visible_rows: usize,
    },
    Spinner {
        phase: f32,
    },
    /// Wearable system status bar: a centered clock plus battery/Bluetooth/DND icons.
    #[cfg(feature = "rich-widgets")]
    StatusBar {
        time: &'a str,
    },
    /// 12- or 24-hour time picker with hour/minute/period segments.
    #[cfg(feature = "rich-widgets")]
    TimePicker {
        hour: u8,
        minute: u8,
        is_12h: bool,
        is_pm: bool,
    },
    /// Numeric range picker with a unit suffix.
    #[cfg(feature = "rich-widgets")]
    NumberPicker {
        value: i32,
        min: i32,
        max: i32,
        unit: &'a str,
    },
    /// Arrow hinting at scrollable content beyond the edge.
    #[cfg(feature = "rich-widgets")]
    ContentIndicator {
        count: usize,
        active: usize,
    },
    /// Pagination dots showing position in a set.
    #[cfg(feature = "rich-widgets")]
    Crumbs {
        count: usize,
        active: usize,
    },
    #[cfg(feature = "rich-widgets")]
    Dropdown {
        items: &'a [&'a str],
        selected: usize,
        open: bool,
        /// Where the selected item -- and the rows of the popup -- are drawn horizontally. Upstream always
        /// left-aligned them; a design can now ask for middle or right.
        align: TextAlign,
    },
    #[cfg(feature = "rich-widgets")]
    Roller {
        items: &'a [&'a str],
        selected: usize,
        /// How a finger picks an item on it: a flick, or a touch on a bar (`RollerSelection`). A design that
        /// names nothing gets the flick, which is what the roller did before the choice existed.
        selection: RollerSelection,
    },
    #[cfg(feature = "rich-widgets")]
    Table {
        rows: &'a [&'a [&'a str]],
        separators: bool,
        cell_padding: u8,
        align: TextAlign,
    },
    #[cfg(feature = "rich-widgets")]
    Scale {
        mode: ScaleMode,
        value: f32,
        min: f32,
        max: f32,
        major_ticks: u8,
        minor_ticks: u8,
        start_angle: i16,
        end_angle: i16,
        show_labels: bool,
        show_needle: bool,
        tick_color: Rgb565,
        needle_color: Rgb565,
    },
    #[cfg(feature = "rich-widgets")]
    Spinbox {
        value: i32,
        min: i32,
        max: i32,
        step: i32,
        digits: u8,
        decimals: u8,
        focused_digit: u8,
        /// The focused digit's underline. Upstream hard-coded `CSS_CYAN` here.
        accent_color: Rgb565,
        /// The `-`/`+` chevron outlines. Upstream hard-coded `CSS_GRAY` here.
        chevron_color: Rgb565,
    },
    #[cfg(feature = "rich-widgets")]
    TextArea {
        text_buf: [u8; TEXTAREA_CAPACITY],
        text_len: u8,
        cursor: usize,
        placeholder: &'a str,
        selection: Option<(usize, usize)>,
        cursor_visible: bool,
        read_only: bool,
        single_line: bool,
        accept_newline: bool,
    },
    /// A read-only panel of text lines, each folded to the widget's own width. See [`TextLines`].
    #[cfg(feature = "rich-widgets")]
    TextLines {
        lines: TextLines<'a>,
    },
    #[cfg(feature = "rich-widgets")]
    Keyboard {
        keys: &'a [char],
        selected: usize,
        cols: u8,
        alt_keys: Option<&'a [char]>,
        layout: KeyboardLayout,
        target: Option<WidgetId>,
    },
    Image {
        image: ImageRef<'a>,
        fit: ImageFit,
    },
    /// Vertically scrolling wrap-around list drawn as a single widget so the
    /// slot falloff, edge fade, and chrome masks stay identical between host
    /// preview and firmware.
    Carousel {
        items: &'a [&'a str],
        selected: usize,
        spec: CarouselSpec,
    },
    /// Multi-part 1bpp glyph whose parts are individually toggled and tinted.
    CompositeIcon {
        parts: &'a [IconPart<'a>],
        spec: CompositeIconSpec,
    },
    Border,
    #[default]
    Spacer,
    #[cfg(feature = "rich-widgets")]
    Menu {
        items: &'a [&'a str],
        selected: usize,
    },
    #[cfg(feature = "rich-widgets")]
    RichMenu {
        cells: &'a [MenuCell<'a>],
        selected: usize,
        offset: usize,
        visible_rows: usize,
    },
    #[cfg(feature = "rich-widgets")]
    PeekReveal {
        icon: ImageRef<'a>,
        title: &'a str,
        subtitle: &'a str,
        progress: f32,
    },
    #[cfg(feature = "rich-widgets")]
    GlanceTile {
        icon: char,
        title: &'a str,
        subtitle: &'a str,
        highlighted: bool,
    },
    #[cfg(feature = "rich-widgets")]
    CardDeck {
        titles: &'a [&'a str],
        selected: usize,
    },
    #[cfg(feature = "rich-widgets")]
    Reel {
        player: ReelPlayer<'a>,
        fit: ImageFit,
    },
    #[cfg(feature = "rich-widgets")]
    StateSurface {
        state: SurfaceState,
        title: &'a str,
        message: &'a str,
        action: Option<&'a str>,
        busy_phase: f32,
    },
    #[cfg(feature = "rich-widgets")]
    HeadsUpBanner {
        level: NotificationLevel,
        text: &'a str,
        ttl_ms: u32,
    },
    #[cfg(feature = "rich-widgets")]
    NotificationActionSheet {
        level: NotificationLevel,
        title: &'a str,
        body: &'a str,
        actions: &'a [&'a str],
        selected: usize,
        open: bool,
    },
    #[cfg(feature = "rich-widgets")]
    FeedTimeline {
        items: &'a [&'a str],
        selected: usize,
        offset: usize,
        visible_rows: usize,
        expanded: bool,
    },
    Dial {
        value: f32,
        min: f32,
        max: f32,
    },
    RlePlayer {
        rle_data: &'static [u8],
        frame_width: u16,
        frame_height: u16,
        total_frames: usize,
        current_frame: usize,
        elapsed_ms: u32,
        frame_duration_ms: u32,
    },
    AutoComplete {
        text_buf: [u8; 32],
        text_len: u8,
        suggestions: &'a [&'a str],
        filtered: [Option<&'a str>; 8],
        filter_count: u8,
        selected: Option<usize>,
        expanded: bool,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChartMode {
    Line,
    Bars,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyboardLayout {
    Normal,
    Shift,
    Symbols,
}

impl WidgetKind<'_> {
    pub fn focusable(self) -> bool {
        if let Self::Custom(c) = self {
            return c.widget.focusable();
        }
        #[cfg(feature = "rich-widgets")]
        if matches!(
            self,
            Self::Toggle { .. }
                | Self::Checkbox { .. }
                | Self::Slider { .. }
                | Self::IconButton { .. }
                | Self::List { .. }
                | Self::CircularList { .. }
                | Self::ScrollView { .. }
                | Self::Tabs { .. }
                | Self::Dropdown { .. }
                | Self::Roller { .. }
                | Self::TextArea { .. }
                | Self::Keyboard { .. }
                | Self::Keypad(_)
                | Self::Menu { .. }
                | Self::RichMenu { .. }
                | Self::FeedTimeline { .. }
                | Self::Dial { .. }
                | Self::AutoComplete { .. }
                // The four controls that could be *seen* but not *touched*: `pointer_hit` only
                // considers focusable widgets, so a Spinbox, NumberPicker, TimePicker or
                // Carousel could not be tapped or dragged at all until they were listed here.
                // They are controls rather than displays (a Gauge, Chart or Plotter stays
                // unreachable on purpose).
                | Self::Spinbox { .. }
                | Self::NumberPicker { .. }
                | Self::TimePicker { .. }
                | Self::Carousel { .. }
        ) {
            return true;
        }
        matches!(self, Self::Button { .. } | Self::RlePlayer { .. })
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WidgetNode<'a> {
    pub id: WidgetId,
    pub parent: Option<WidgetId>,
    pub style_class: Option<StyleClassId>,
    pub focus_group: FocusGroupId,
    pub rect: Rect,
    pub style: WidgetStyle,
    pub kind: WidgetKind<'a>,
    pub flags: WidgetFlags,
}

impl<'a> WidgetNode<'a> {
    pub fn new<S>(id: WidgetId, rect: impl Into<Rect>, kind: WidgetKind<'a>, style: S) -> Self
    where
        S: Into<WidgetStyle>,
    {
        Self {
            id,
            parent: None,
            style_class: None,
            focus_group: FocusGroupId::ROOT,
            rect: rect.into(),
            style: style.into(),
            kind,
            flags: default_flags(kind),
        }
    }

    pub const fn hidden(&self) -> bool {
        self.flags.contains(WidgetFlags::HIDDEN)
    }

    pub const fn disabled(&self) -> bool {
        self.flags.contains(WidgetFlags::DISABLED)
    }

    pub const fn clickable(&self) -> bool {
        self.flags.contains(WidgetFlags::CLICKABLE)
    }

    pub const fn scrollable(&self) -> bool {
        self.flags.contains(WidgetFlags::SCROLLABLE)
    }

    pub const fn clips_children(&self) -> bool {
        self.flags.contains(WidgetFlags::CLIP_CHILDREN)
    }

    pub const fn focusable(&self) -> bool {
        !self.hidden() && !self.disabled() && self.flags.contains(WidgetFlags::FOCUSABLE)
    }

    pub fn get_property(&self, key: PropertyKey) -> Option<PropertyValue<'a>> {
        match (key, &self.kind) {
            (PropertyKey::Value, WidgetKind::ProgressBar { value })
            | (PropertyKey::Progress, WidgetKind::ProgressBar { value }) => {
                Some(PropertyValue::Float(*value))
            }
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::Value, WidgetKind::Slider { value, .. }) => {
                Some(PropertyValue::Float(*value))
            }
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::Min, WidgetKind::Slider { min, .. }) => Some(PropertyValue::Float(*min)),
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::Max, WidgetKind::Slider { max, .. }) => Some(PropertyValue::Float(*max)),
            (PropertyKey::Text, WidgetKind::Label(text)) => Some(PropertyValue::Str(text)),
            (PropertyKey::Text, WidgetKind::Button(text)) => Some(PropertyValue::Str(text)),
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::State, WidgetKind::Toggle { on, .. }) => Some(PropertyValue::Bool(*on)),
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::State, WidgetKind::Checkbox { checked, .. }) => {
                Some(PropertyValue::Bool(*checked))
            }
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::Selected, WidgetKind::List { selected, .. }) => {
                Some(PropertyValue::Usize(*selected))
            }
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::Selected, WidgetKind::Tabs { selected, .. }) => {
                Some(PropertyValue::Usize(*selected))
            }
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::Selected, WidgetKind::RichMenu { selected, .. }) => {
                Some(PropertyValue::Usize(*selected))
            }
            // A scale is the one widget whose entire purpose is to display a value that changes, and upstream
            // had no arm here at all: `set_widget_property(.., Value, ..)` answered `NotFound` for it, so a
            // gauge could only ever show whatever the markup was built with. `ScaleWidget` already implements
            // both accessors; these arms are what connect the node to them.
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::Value, WidgetKind::Scale { value, .. }) => {
                Some(PropertyValue::Float(*value))
            }
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::Min, WidgetKind::Scale { min, .. }) => Some(PropertyValue::Float(*min)),
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::Max, WidgetKind::Scale { max, .. }) => Some(PropertyValue::Float(*max)),
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::Text, WidgetKind::StatusBar { time }) => Some(PropertyValue::Str(time)),
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::Value, WidgetKind::NumberPicker { value, .. }) => {
                Some(PropertyValue::Int(*value))
            }
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::Min, WidgetKind::NumberPicker { min, .. }) => {
                Some(PropertyValue::Int(*min))
            }
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::Max, WidgetKind::NumberPicker { max, .. }) => {
                Some(PropertyValue::Int(*max))
            }
            // Mirrors the node's other `Selected` arms (`List`, `Tabs`, `RichMenu`) and the `usize`
            // `active` these two indicators carry. `CrumbsIndicatorWidget::get_property` spells the same
            // key as `Int`; the node arm uses `Usize` so `get`/`set` round-trip here.
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::Selected, WidgetKind::ContentIndicator { active, .. }) => {
                Some(PropertyValue::Usize(*active))
            }
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::Selected, WidgetKind::Crumbs { active, .. }) => {
                Some(PropertyValue::Usize(*active))
            }
            _ => None,
        }
    }

    pub fn set_property(
        &mut self,
        key: PropertyKey,
        val: PropertyValue<'a>,
    ) -> Result<(), PropertyError> {
        match (key, &mut self.kind, val) {
            (
                PropertyKey::Value | PropertyKey::Progress,
                WidgetKind::ProgressBar { value },
                PropertyValue::Float(v),
            ) => {
                *value = v.clamp(0.0, 1.0);
                Ok(())
            }
            #[cfg(feature = "rich-widgets")]
            (
                PropertyKey::Value,
                WidgetKind::Slider {
                    value, min, max, ..
                },
                PropertyValue::Float(v),
            ) => {
                *value = v.clamp(*min, *max);
                Ok(())
            }
            #[cfg(feature = "rich-widgets")]
            (
                PropertyKey::Value,
                WidgetKind::Scale {
                    value, min, max, ..
                },
                PropertyValue::Float(v),
            ) => {
                *value = v.clamp(*min, *max);
                Ok(())
            }
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::Min, WidgetKind::Scale { min, .. }, PropertyValue::Float(m)) => {
                *min = m;
                Ok(())
            }
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::Max, WidgetKind::Scale { max, .. }, PropertyValue::Float(m)) => {
                *max = m;
                Ok(())
            }
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::Text, WidgetKind::StatusBar { time }, PropertyValue::Str(s)) => {
                *time = s;
                Ok(())
            }
            #[cfg(feature = "rich-widgets")]
            (
                PropertyKey::Value,
                WidgetKind::NumberPicker {
                    value, min, max, ..
                },
                PropertyValue::Int(v),
            ) => {
                *value = v.clamp((*min).min(*max), (*min).max(*max));
                Ok(())
            }
            #[cfg(feature = "rich-widgets")]
            (
                PropertyKey::Min,
                WidgetKind::NumberPicker {
                    value, min, max, ..
                },
                PropertyValue::Int(m),
            ) => {
                *min = m;
                // Keep the displayed value inside the range the design just named.
                *value = (*value).clamp((*min).min(*max), (*min).max(*max));
                Ok(())
            }
            #[cfg(feature = "rich-widgets")]
            (
                PropertyKey::Max,
                WidgetKind::NumberPicker {
                    value, min, max, ..
                },
                PropertyValue::Int(m),
            ) => {
                *max = m;
                *value = (*value).clamp((*min).min(*max), (*min).max(*max));
                Ok(())
            }
            #[cfg(feature = "rich-widgets")]
            (
                PropertyKey::Selected,
                WidgetKind::ContentIndicator { count, active },
                PropertyValue::Usize(s),
            ) => {
                *active = s.min((*count).saturating_sub(1));
                Ok(())
            }
            #[cfg(feature = "rich-widgets")]
            (
                PropertyKey::Selected,
                WidgetKind::Crumbs { count, active },
                PropertyValue::Usize(s),
            ) => {
                *active = s.min((*count).saturating_sub(1));
                Ok(())
            }
            (PropertyKey::Text, WidgetKind::Label(text), PropertyValue::Str(s)) => {
                *text = s;
                Ok(())
            }
            (PropertyKey::Text, WidgetKind::Button(text), PropertyValue::Str(s)) => {
                *text = s;
                Ok(())
            }
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::Text, WidgetKind::Toggle { label, .. }, PropertyValue::Str(s)) => {
                *label = s;
                Ok(())
            }
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::Text, WidgetKind::Checkbox { label, .. }, PropertyValue::Str(s)) => {
                *label = s;
                Ok(())
            }
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::State, WidgetKind::Toggle { on, .. }, PropertyValue::Bool(b)) => {
                *on = b;
                Ok(())
            }
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::State, WidgetKind::Checkbox { checked, .. }, PropertyValue::Bool(b)) => {
                *checked = b;
                Ok(())
            }
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::Selected, WidgetKind::List { selected, .. }, PropertyValue::Usize(s)) => {
                *selected = s;
                Ok(())
            }
            #[cfg(feature = "rich-widgets")]
            (PropertyKey::Selected, WidgetKind::Tabs { selected, .. }, PropertyValue::Usize(s)) => {
                *selected = s;
                Ok(())
            }
            #[cfg(feature = "rich-widgets")]
            (
                PropertyKey::Selected,
                WidgetKind::RichMenu {
                    cells,
                    selected: current,
                    offset: current_offset,
                    visible_rows,
                },
                PropertyValue::Usize(s),
            ) => {
                let len = cells.len();
                let mut state = ListState::new(*current, *current_offset, *visible_rows);
                let changed = state.set_selected(s.min(len.saturating_sub(1)), len);
                if changed {
                    *current = state.selected;
                    *current_offset = state.offset;
                }
                Ok(())
            }
            _ => Err(PropertyError::NotFound),
        }
    }

    /// The sub-rect of `bounds` a property change actually dirties, when narrower
    /// than the whole widget. `set_widget_property` records this instead of
    /// always marking `bounds` dirty, so a gauge needle only triggers a repaint
    /// of the spoke it sweeps through -- the ticks and labels are left alone.
    ///
    /// Every other (widget, property) pair returns `bounds`, which is exactly
    /// the previous whole-widget repaint, so progress bars, sliders, and friends
    /// are unaffected.
    pub fn dirty_region_for_property(
        &self,
        key: PropertyKey,
        new_val: &PropertyValue<'a>,
        bounds: Rect,
    ) -> Rect {
        match (key, &self.kind, new_val) {
            #[cfg(feature = "rich-widgets")]
            (
                PropertyKey::Value,
                WidgetKind::Scale {
                    mode,
                    value,
                    min,
                    max,
                    major_ticks,
                    minor_ticks,
                    start_angle,
                    end_angle,
                    show_labels,
                    show_needle,
                    tick_color,
                    needle_color,
                },
                PropertyValue::Float(new),
            ) => {
                let style = self.style.resolve(VisualState::Normal);
                let scale = ScaleWidget {
                    mode: *mode,
                    value: *value,
                    min: *min,
                    max: *max,
                    major_ticks: *major_ticks,
                    minor_ticks: *minor_ticks,
                    start_angle: *start_angle,
                    end_angle: *end_angle,
                    show_labels: *show_labels,
                    show_needle: *show_needle,
                    tick_color: *tick_color,
                    needle_color: *needle_color,
                };
                // The spoke the needle is leaving must be repainted to erase it,
                // and the spoke it is arriving on must be repainted to draw it:
                // old + new, unioned into one dirty band.
                scale
                    .needle_extent(*value, bounds, style)
                    .union(scale.needle_extent(*new, bounds, style))
            }
            _ => bounds,
        }
    }

    pub fn render<D, C>(
        &self,
        ctx: &mut RenderCtx<'_, D, C>,
        state: VisualState,
    ) -> Result<(), D::Error>
    where
        D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
        C: Compositor<D>,
    {
        self.render_at(ctx, self.rect, state)
    }

    pub fn render_at<D, C>(
        &self,
        ctx: &mut RenderCtx<'_, D, C>,
        rect: Rect,
        state: VisualState,
    ) -> Result<(), D::Error>
    where
        D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
        C: Compositor<D>,
    {
        if self.hidden() {
            return Ok(());
        }

        match self.kind {
            WidgetKind::Custom(c) => {
                let mut canvas = crate::render::RenderCtxCanvas { ctx };
                let _ = c.widget.render(&mut canvas, rect, &self.style, state);
                Ok(())
            }
            WidgetKind::Panel => render_panel(ctx, rect, self.style, state),
            WidgetKind::Label(text) => render_label(ctx, rect, text, self.style),
            WidgetKind::Button(text) => render_button(ctx, rect, text, self.style, state),
            WidgetKind::ProgressBar { value } => {
                render_progress(ctx, rect, value, self.style, state)
            }
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Toggle {
                label,
                on,
                off_color,
                track_border,
                track_border_width,
            } => render_toggle(
                ctx,
                rect,
                label,
                on,
                off_color,
                track_border,
                track_border_width,
                self.style,
                state,
            ),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Checkbox {
                label,
                checked,
                box_width,
                box_height,
                label_position,
                box_color,
            } => render_checkbox(
                ctx,
                rect,
                label,
                checked,
                box_width,
                box_height,
                label_position,
                box_color,
                self.style,
                state,
            ),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Slider {
                value,
                min,
                max,
                knob_w,
            } => render_slider(ctx, rect, value, min, max, knob_w, self.style, state),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Clock(clock) => clock.render(ctx, rect, self.style, state),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Keypad(pad) => pad.render(ctx, rect, self.style, state),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::ValueLabel { label, value } => {
                render_value_label(ctx, rect, label, value, self.style, state)
            }
            #[cfg(feature = "rich-widgets")]
            WidgetKind::IconButton { icon, label } => {
                render_icon_button(ctx, rect, icon, label, self.style, state)
            }
            #[cfg(feature = "rich-widgets")]
            WidgetKind::List {
                items,
                selected,
                offset,
                visible_rows,
            } => render_list(
                ctx,
                rect,
                items,
                selected,
                offset,
                visible_rows,
                self.style,
                state,
            ),
            WidgetKind::CircularList {
                items,
                selected,
                offset,
                visible_rows,
            } => render_circular_list(
                ctx,
                rect,
                items,
                selected,
                offset,
                visible_rows,
                self.style,
                state,
            ),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::ScrollView {
                offset_y,
                content_h,
            } => render_scroll_view(ctx, rect, offset_y, content_h, self.style, state),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Tabs { labels, selected } => {
                render_tabs(ctx, rect, labels, selected, self.style, state)
            }
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Dialog { title, body } => {
                render_dialog(ctx, rect, title, body, self.style, state)
            }
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Toast { text, ttl_ms } => {
                render_toast(ctx, rect, text, ttl_ms, self.style, state)
            }
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Meter { value, min, max } => {
                render_meter(ctx, rect, value, min, max, self.style, state)
            }
            #[cfg(feature = "rich-widgets")]
            WidgetKind::ArcGauge {
                value,
                min,
                max,
                start_deg,
                end_deg,
                thickness,
                antialias,
                major_ticks,
                minor_ticks,
                show_value,
            } => render_arc_gauge(
                ctx,
                rect,
                value,
                min,
                max,
                start_deg,
                end_deg,
                thickness,
                antialias,
                major_ticks,
                minor_ticks,
                show_value,
                self.style,
                state,
            ),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Gauge {
                value,
                min,
                max,
                major_ticks,
                minor_ticks,
                show_value,
            } => render_gauge(
                ctx,
                rect,
                value,
                min,
                max,
                major_ticks,
                minor_ticks,
                show_value,
                self.style,
                state,
            ),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::GaugeNeedle {
                value,
                min,
                max,
                start_deg,
                end_deg,
            } => render_gauge_needle(
                ctx, rect, value, min, max, start_deg, end_deg, self.style, state,
            ),
            WidgetKind::SweepingArc {
                progress,
                clockwise,
                arc_radius,
                frame_inset,
                corner_radius,
                bg_color,
                arc_color,
                frame_color,
            } => render_sweeping_arc(
                ctx,
                rect,
                progress,
                clockwise,
                arc_radius,
                frame_inset,
                corner_radius,
                bg_color,
                arc_color,
                frame_color,
            ),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Chart {
                values,
                min,
                max,
                thickness,
                fill_under,
                markers,
                mode,
                show_grid,
                show_axes,
                show_labels,
            } => render_chart(
                ctx,
                rect,
                values,
                min,
                max,
                thickness,
                fill_under,
                markers,
                mode,
                show_grid,
                show_axes,
                show_labels,
                self.style,
                state,
            ),
            WidgetKind::Plotter {
                values,
                head,
                min,
                max,
                thickness,
                show_grid,
                show_axes,
            } => render_plotter(
                ctx, rect, values, head, min, max, thickness, show_grid, show_axes, self.style,
                state,
            ),
            WidgetKind::Spinner { phase } => render_spinner(ctx, rect, phase, self.style, state),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::StatusBar { time } => render_status_bar(ctx, rect, time, self.style, state),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::TimePicker {
                hour,
                minute,
                is_12h,
                is_pm,
            } => render_time_picker(ctx, rect, hour, minute, is_12h, is_pm, self.style, state),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::NumberPicker {
                value,
                min,
                max,
                unit,
            } => render_number_picker(ctx, rect, min, max, value, unit, self.style, state),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::ContentIndicator { count, active } => {
                render_content_indicator(ctx, rect, count, active, self.style, state)
            }
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Crumbs { count, active } => {
                render_crumbs(ctx, rect, count, active, self.style, state)
            }
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Dropdown {
                items,
                selected,
                open,
                align,
            } => render_dropdown(ctx, rect, items, selected, open, align, self.style, state),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Roller {
                items, selected, ..
            } => render_roller(ctx, rect, items, selected, self.style, state),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Table {
                rows,
                separators,
                cell_padding,
                align,
            } => render_table(
                ctx,
                rect,
                rows,
                separators,
                cell_padding,
                align,
                self.style,
                state,
            ),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Scale {
                mode,
                value,
                min,
                max,
                major_ticks,
                minor_ticks,
                start_angle,
                end_angle,
                show_labels,
                show_needle,
                tick_color,
                needle_color,
            } => {
                let scale = ScaleWidget {
                    mode,
                    value,
                    min,
                    max,
                    major_ticks,
                    minor_ticks,
                    start_angle,
                    end_angle,
                    show_labels,
                    show_needle,
                    tick_color,
                    needle_color,
                };
                scale.render(ctx, rect, self.style, state)
            }
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Spinbox {
                value,
                min,
                max,
                step,
                digits,
                decimals,
                focused_digit,
                accent_color,
                chevron_color,
            } => {
                let spinbox = SpinboxWidget {
                    value,
                    min,
                    max,
                    step,
                    digits,
                    decimals,
                    focused_digit,
                    accent_color,
                    chevron_color,
                };
                spinbox.render(ctx, rect, self.style, state)
            }
            #[cfg(feature = "rich-widgets")]
            WidgetKind::TextArea {
                text_buf,
                text_len,
                cursor,
                placeholder,
                selection,
                cursor_visible,
                ..
            } => render_textarea(
                ctx,
                rect,
                textarea_text(&text_buf, text_len),
                cursor,
                placeholder,
                selection,
                cursor_visible,
                self.style,
                state,
            ),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Keyboard {
                keys,
                selected,
                cols,
                alt_keys,
                layout,
                ..
            } => render_keyboard(
                ctx, rect, keys, selected, cols, alt_keys, layout, self.style, state,
            ),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::TextLines { lines } => {
                render_text_lines(ctx, rect, &lines, self.style, state)
            }
            WidgetKind::Image { image, fit } => {
                render_image(ctx, rect, image, fit, self.style, state)
            }
            WidgetKind::Carousel {
                items,
                selected,
                spec,
            } => render_carousel(ctx, rect, items, selected, &spec, self.style, state),
            WidgetKind::CompositeIcon { parts, spec } => {
                render_composite_icon(ctx, rect, parts, &spec, self.style, state)
            }
            WidgetKind::Border => ctx.stroke_rect(rect, self.style.resolve(state).border),
            WidgetKind::Spacer => Ok(()),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Menu { items, selected } => {
                render_menu(ctx, rect, items, selected, self.style, state)
            }
            #[cfg(feature = "rich-widgets")]
            WidgetKind::RichMenu {
                cells,
                selected,
                offset,
                visible_rows,
            } => render_rich_menu(
                ctx,
                rect,
                cells,
                selected,
                offset,
                visible_rows,
                self.style,
                state,
            ),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::PeekReveal {
                icon,
                title,
                subtitle,
                progress,
            } => render_peek_reveal(
                ctx, rect, icon, title, subtitle, progress, self.style, state,
            ),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::GlanceTile {
                icon,
                title,
                subtitle,
                highlighted,
            } => render_glance_tile(
                ctx,
                rect,
                icon,
                title,
                subtitle,
                highlighted,
                self.style,
                state,
            ),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::CardDeck { titles, selected } => {
                render_card_deck(ctx, rect, titles, selected, self.style, state)
            }
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Reel { player, fit } => {
                render_reel(ctx, rect, player, fit, self.style, state)
            }
            #[cfg(feature = "rich-widgets")]
            WidgetKind::StateSurface {
                state: surface_state,
                title,
                message,
                action,
                busy_phase,
            } => render_state_surface(
                ctx,
                rect,
                surface_state,
                title,
                message,
                action,
                busy_phase,
                self.style,
                state,
            ),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::HeadsUpBanner {
                level,
                text,
                ttl_ms,
            } => render_heads_up_banner(ctx, rect, level, text, ttl_ms, self.style, state),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::NotificationActionSheet {
                level,
                title,
                body,
                actions,
                selected,
                open,
            } => render_notification_action_sheet(
                ctx, rect, level, title, body, actions, selected, open, self.style, state,
            ),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::FeedTimeline {
                items,
                selected,
                offset,
                visible_rows,
                expanded,
            } => render_feed_timeline(
                ctx,
                rect,
                items,
                selected,
                offset,
                visible_rows,
                expanded,
                self.style,
                state,
            ),
            WidgetKind::Dial { value, min, max } => {
                render_dial(ctx, rect, value, min, max, self.style, state)
            }
            WidgetKind::RlePlayer {
                rle_data,
                frame_width,
                frame_height,
                current_frame,
                ..
            } => render_rle_player(
                ctx,
                rect,
                rle_data,
                current_frame,
                frame_width,
                frame_height,
                self.style,
                state,
            ),
            WidgetKind::AutoComplete {
                text_buf,
                text_len,
                filtered,
                filter_count,
                selected,
                expanded,
                ..
            } => render_autocomplete(
                ctx,
                rect,
                &text_buf,
                text_len,
                &filtered,
                filter_count,
                selected,
                expanded,
                self.style,
                state,
            ),
        }
    }
}

fn default_flags(kind: WidgetKind<'_>) -> WidgetFlags {
    let mut flags = WidgetFlags::from_bits(
        WidgetFlags::CLIP_CHILDREN.bits() | WidgetFlags::EVENT_BUBBLE.bits(),
    );
    if kind.focusable() {
        flags = WidgetFlags::from_bits(
            flags.bits() | WidgetFlags::FOCUSABLE.bits() | WidgetFlags::CLICKABLE.bits(),
        );
    }
    #[cfg(feature = "rich-widgets")]
    if matches!(kind, WidgetKind::ScrollView { .. }) {
        flags = WidgetFlags::from_bits(flags.bits() | WidgetFlags::SCROLLABLE.bits());
    }
    flags
}

fn render_panel<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    Block::styled(style).render(rect, ctx)
}

fn render_label<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    text: &str,
    style: WidgetStyle,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(VisualState::Normal);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    let inner = block.inner(rect);
    ctx.draw_text_in(
        inner,
        text,
        TextStyle::new(style.text).with_font(style.font),
    )
}

fn render_button<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    text: &str,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let active_style = style.resolve(state);
    let block = Block::styled(active_style);
    block.render(rect, ctx)?;
    let inner = block.inner(rect);
    ctx.draw_text_in(
        inner,
        text,
        TextStyle::new(active_style.text)
            .with_font(active_style.font)
            .centered(),
    )
}

fn render_progress<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    value: f32,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    let inner = block.inner(rect);
    let fill_w = ((inner.w as f32 * value.clamp(0.0, 1.0)) as u32).min(inner.w);
    if fill_w > 0 {
        // Always the foreground: the fill used to switch to the accent while the bar had focus, so the
        // same value read differently depending on where the focus happened to be. That is the same report
        // as the focused block colour (2026-10-14).
        ctx.fill_rect(
            Rect::new(inner.x, inner.y, fill_w, inner.h),
            style.foreground,
        )?;
    }
    Ok(())
}

#[cfg(feature = "rich-widgets")]
fn render_toggle<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    label: &str,
    on: bool,
    off_color: Rgb565,
    track_border: Option<Rgb565>,
    track_border_width: u8,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    let inner = block.inner(rect);
    let knob_w = (inner.w / 4).max(8).min(inner.w);
    let track = Rect::new(
        inner.right() - knob_w as i32 - 2,
        inner.y + 1,
        knob_w,
        inner.h.saturating_sub(2),
    );
    ctx.fill_rect(track, if on { style.accent } else { off_color })?;
    // The track outline a design can ask for. `None` or a zero width draws nothing, so a toggle built
    // through `add_toggle` still looks exactly as it did before this field existed.
    if track_border_width > 0 {
        if let Some(color) = track_border {
            ctx.stroke_rect(
                track,
                Border {
                    color,
                    width: track_border_width,
                },
            )?;
        }
    }
    ctx.draw_text_in(
        Rect::new(
            inner.x,
            inner.y,
            inner.w.saturating_sub(knob_w + 4),
            inner.h,
        ),
        label,
        TextStyle::new(style.text).with_font(style.font),
    )
}

#[cfg(feature = "rich-widgets")]
fn render_status_bar<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    time: &str,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let resolved = style.resolve(state);
    // The status bar owns its colours; the design's background, text and accent are mapped onto them so a
    // configured style reaches the glass instead of being ignored.
    Block::styled(resolved).render(rect, ctx)?;
    let mut bar = StatusBarWidget::new(time);
    if let Some(background) = resolved.background {
        bar.background_color = background;
    }
    bar.foreground_color = resolved.text;
    bar.accent_color = resolved.accent;
    bar.font = resolved.font;
    // `StatusBarWidget::render` reports draw failures as its own `StatusBarError`, which the node's
    // `D::Error` return cannot carry; the background has already been painted by the time one can happen.
    let _ = bar.render(ctx, rect);
    Ok(())
}

#[cfg(feature = "rich-widgets")]
fn render_time_picker<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    hour: u8,
    minute: u8,
    is_12h: bool,
    is_pm: bool,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let resolved = style.resolve(state);
    Block::styled(resolved).render(rect, ctx)?;
    let mut picker = if is_12h {
        TimePickerWidget::new_12h(hour, minute, is_pm)
    } else {
        TimePickerWidget::new_24h(hour, minute)
    };
    if let Some(background) = resolved.background {
        picker.background_color = background;
    }
    picker.text_color = resolved.text;
    picker.focus_color = resolved.accent;
    picker.font = resolved.font;
    let _ = picker.render(ctx, rect);
    Ok(())
}

#[cfg(feature = "rich-widgets")]
fn render_number_picker<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    min: i32,
    max: i32,
    value: i32,
    unit: &str,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let resolved = style.resolve(state);
    Block::styled(resolved).render(rect, ctx)?;
    // No colour field exists on `NumberPickerWidget` for a style to override; its rounded card paints over
    // the block, so the value simply renders in the crate's own colours.
    let mut picker = NumberPickerWidget::new(min, max, value, unit);
    // The picker paints its own card and reads no colours from the style, but the face the value is drawn in
    // is the design's to choose, so it is handed over rather than left at the crate's smallest.
    picker.font = resolved.font;
    let _ = picker.render(ctx, rect);
    Ok(())
}

#[cfg(feature = "rich-widgets")]
fn render_content_indicator<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    count: usize,
    active: usize,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let resolved = style.resolve(state);
    Block::styled(resolved).render(rect, ctx)?;
    // `ContentIndicatorWidget::new` wants a direction, but the `content_indicator` markup carries the same
    // `count`/`active` pagination pair as `crumbs` and no direction attribute, so the direction is inferred:
    // while items remain below the active one the hint points down, and on the last item it points up.
    let direction = if count > 1 && active.saturating_add(1) >= count {
        ContentIndicatorDirection::Up
    } else {
        ContentIndicatorDirection::Down
    };
    let mut indicator = ContentIndicatorWidget::new(direction);
    indicator.color = resolved.accent;
    indicator.render(ctx, rect)
}

#[cfg(feature = "rich-widgets")]
fn render_crumbs<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    count: usize,
    active: usize,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let resolved = style.resolve(state);
    Block::styled(resolved).render(rect, ctx)?;
    let count = count.min(u8::MAX as usize) as u8;
    let active = active.min(count.saturating_sub(1) as usize) as u8;
    let mut crumbs = CrumbsIndicatorWidget::new(count, active);
    crumbs.active_color = resolved.accent;
    crumbs.render(ctx, rect)
}

#[cfg(feature = "rich-widgets")]
fn render_checkbox<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    label: &str,
    checked: bool,
    box_width: u8,
    box_height: u8,
    label_position: CheckboxLabelPosition,
    box_color: Option<Rgb565>,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    let inner = block.inner(rect);
    // `0` is upstream's rule, so a design that says nothing about the size renders exactly as before. A named
    // size is still capped by the cell: a box wider or taller than the widget would draw outside it, where the
    // engine clips it and the designer's canvas could not show it.
    let box_w = if box_width == 0 {
        inner.w.min(8)
    } else {
        (box_width as u32).min(inner.w)
    };
    let box_h = if box_height == 0 {
        inner.h.min(8)
    } else {
        (box_height as u32).min(inner.h)
    };
    // The crate's own spacing between box and label, kept so an unconfigured checkbox is unchanged.
    let gap = 3u32;
    let text_h = style.font.line_height().min(inner.h).max(1);

    // Where the box goes and which rect the label is drawn in. A left or right label shares the row with the
    // box; a top or bottom label stacks, and the box is centred in the band the label leaves rather than being
    // pushed off the widget when it is taller than that band.
    let (box_rect, label_rect) = match label_position {
        CheckboxLabelPosition::Right => (
            Rect::new(
                inner.x,
                inner.y + (inner.h.saturating_sub(box_h) as i32 / 2),
                box_w,
                box_h,
            ),
            Rect::new(
                inner.x + box_w as i32 + gap as i32,
                inner.y,
                inner.w.saturating_sub(box_w + gap),
                inner.h,
            ),
        ),
        CheckboxLabelPosition::Left => {
            let label_w = inner.w.saturating_sub(box_w + gap);
            (
                Rect::new(
                    inner.x + label_w as i32 + gap as i32,
                    inner.y + (inner.h.saturating_sub(box_h) as i32 / 2),
                    box_w,
                    box_h,
                ),
                Rect::new(inner.x, inner.y, label_w, inner.h),
            )
        }
        CheckboxLabelPosition::Top => {
            let label_h = text_h;
            let band_h = inner.h.saturating_sub(label_h + gap);
            (
                Rect::new(
                    inner.x + (inner.w.saturating_sub(box_w) as i32 / 2),
                    inner.y
                        + label_h as i32
                        + gap as i32
                        + (band_h.saturating_sub(box_h) as i32 / 2),
                    box_w,
                    box_h,
                ),
                Rect::new(inner.x, inner.y, inner.w, label_h),
            )
        }
        CheckboxLabelPosition::Bottom => {
            let label_h = text_h;
            let band_h = inner.h.saturating_sub(label_h + gap);
            (
                Rect::new(
                    inner.x + (inner.w.saturating_sub(box_w) as i32 / 2),
                    inner.y + (band_h.saturating_sub(box_h) as i32 / 2),
                    box_w,
                    box_h,
                ),
                Rect::new(
                    inner.x,
                    inner.y + inner.h.saturating_sub(label_h) as i32,
                    inner.w,
                    label_h,
                ),
            )
        }
    };
    ctx.stroke_rect(box_rect, Border::one(box_color.unwrap_or(style.text)))?;
    // The tick is inset by a quarter of the box's shorter side, so it grows and shrinks with the box instead of
    // being a fixed two pixels that a large box would swallow and a small one would leave no room in.
    let inset = ((box_w.min(box_h) / 4).max(1)) as i16;
    let tick = box_rect.inset(crate::geometry::EdgeInsets::all(inset));
    if checked && tick.w > 0 && tick.h > 0 {
        ctx.fill_rect(tick, style.accent)?;
    }
    ctx.draw_text_in(
        label_rect,
        label,
        // Centred on the side it was given rather than pushed to that side's start: the label is one thing
        // sitting beside (or above, or below) the box, and hugging the far edge of a wide band reads as a
        // misplaced label rather than as a deliberate one. `centered()` sets both axes, so a left or right
        // label is centred on the box's own line and a top or bottom one is centred over the box.
        TextStyle::new(style.text).with_font(style.font).centered(),
    )
}

/// Where a slider's grip can travel, and how wide it is.
///
/// Both halves are shared with the touch path ([`slider_value_at_x`]), so the pixel a finger
/// presses is the pixel the grip is drawn at: one geometry, two callers.
#[cfg(feature = "rich-widgets")]
pub(crate) fn slider_geometry(rect: Rect, style: Style, knob_w: u32) -> (Rect, u32) {
    let inner = Block::styled(style).inner(rect);
    // The grip fills the block's inner height -- the space between the top and bottom borders -- and
    // travels across `inner.w - knob_w`, so at either end it sits flush with the block's inner edge
    // rather than hanging over it. `0` keeps the default width of eight pixels, and a width wider
    // than the widget is clamped so a design cannot draw outside its own cell.
    let knob_w = if knob_w == 0 { 8 } else { knob_w };
    (inner, knob_w.clamp(1, inner.w.max(1)))
}

/// The value a finger at `x` is asking a slider for.
///
/// The grip is centred on the finger, which is what makes a drag feel attached to it rather than
/// offset by half a grip: the left edge is `x - knob_w / 2`, clamped to the travel the grip has,
/// and the fraction across that travel is the fraction across the range.
#[cfg(feature = "rich-widgets")]
pub fn slider_value_at_x(rect: Rect, style: Style, min: f32, max: f32, knob_w: u32, x: i32) -> f32 {
    let (inner, knob_w) = slider_geometry(rect, style, knob_w);
    let travel = inner.w.saturating_sub(knob_w);
    if travel == 0 {
        // A grip as wide as its track cannot move, so anywhere on it is the whole range.
        return min;
    }
    let left = x - inner.x - knob_w as i32 / 2;
    let t = (left as f32 / travel as f32).clamp(0.0, 1.0);
    min + (max - min) * t
}

#[cfg(feature = "rich-widgets")]
fn render_slider<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    value: f32,
    min: f32,
    max: f32,
    knob_w: u32,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    let (inner, knob_w) = slider_geometry(rect, style, knob_w);
    let range = (max - min).max(f32::EPSILON);
    let t = ((value - min) / range).clamp(0.0, 1.0);
    let track_y = inner.y + inner.h as i32 / 2;
    ctx.fill_rect(Rect::new(inner.x, track_y, inner.w, 1), style.text)?;
    if inner.h == 0 {
        return Ok(());
    }
    let knob_x = inner.x + ((inner.w.saturating_sub(knob_w) as f32 * t) as i32);
    ctx.fill_rect(Rect::new(knob_x, inner.y, knob_w, inner.h), style.accent)
}

fn render_dial<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    value: f32,
    min: f32,
    max: f32,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    let inner = block.inner(rect);

    let cx = inner.x + inner.w as i32 / 2;
    let cy = inner.y + inner.h as i32 / 2;
    let radius = (inner.w.min(inner.h) as i32 / 2).saturating_sub(2);

    if radius > 0 {
        ctx.stroke_circle(cx, cy, radius as u32, style.text)?;

        let range = (max - min).max(f32::EPSILON);
        let t = ((value - min) / range).clamp(0.0, 1.0);

        #[cfg(not(feature = "std"))]
        use crate::math::F32Ext as _;

        let angle = t * 2.0 * core::f32::consts::PI - (core::f32::consts::PI / 2.0);
        let cos_val = angle.cos();
        let sin_val = angle.sin();

        let px = cx + (radius as f32 * cos_val).round() as i32;
        let py = cy + (radius as f32 * sin_val).round() as i32;

        ctx.draw_line(cx, cy, px, py, style.accent)?;
        ctx.fill_circle(cx, cy, 2, style.accent)?;
    }

    Ok(())
}

#[allow(clippy::too_many_arguments, clippy::needless_range_loop)]
fn render_rle_player<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    rle_data: &[u8],
    current_frame: usize,
    frame_w: u16,
    frame_h: u16,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    let inner = block.inner(rect);

    if rle_data.len() < 3 {
        return Ok(());
    }
    let total_frames = u16::from_le_bytes([rle_data[0], rle_data[1]]) as usize;
    if current_frame >= total_frames {
        return Ok(());
    }
    let offset_start = 2 + current_frame * 4;
    if offset_start + 4 > rle_data.len() {
        return Ok(());
    }
    let frame_offset = u32::from_le_bytes([
        rle_data[offset_start],
        rle_data[offset_start + 1],
        rle_data[offset_start + 2],
        rle_data[offset_start + 3],
    ]) as usize;

    if frame_offset >= rle_data.len() {
        return Ok(());
    }
    let pal_size = rle_data[frame_offset] as usize;
    let mut pal_colors = [Rgb565::BLACK; 256];
    let pal_colors_start = frame_offset + 1;
    for i in 0..pal_size {
        let idx = pal_colors_start + i * 2;
        if idx + 2 <= rle_data.len() {
            let color_u16 = u16::from_le_bytes([rle_data[idx], rle_data[idx + 1]]);
            let r = ((color_u16 >> 11) & 0x1F) as u8;
            let g = ((color_u16 >> 5) & 0x3F) as u8;
            let b = (color_u16 & 0x1F) as u8;
            pal_colors[i] = Rgb565::new(r, g, b);
        }
    }

    let runs_start = pal_colors_start + pal_size * 2;
    let mut cur_x = 0i32;
    let mut cur_y = 0i32;
    let mut idx = runs_start;

    while idx + 2 <= rle_data.len() {
        let run_len = rle_data[idx] as i32;
        let pal_idx = rle_data[idx + 1] as usize;
        idx += 2;

        if run_len == 0 {
            break;
        }

        let color = if pal_idx < pal_size {
            pal_colors[pal_idx]
        } else {
            Rgb565::BLACK
        };

        for _ in 0..run_len {
            if cur_y >= frame_h as i32 {
                break;
            }
            let px = inner.x + cur_x;
            let py = inner.y + cur_y;
            if inner.contains(px, py) {
                ctx.fill_rect(Rect::new(px, py, 1, 1), color)?;
            }

            cur_x += 1;
            if cur_x >= frame_w as i32 {
                cur_x = 0;
                cur_y += 1;
            }
        }
    }

    Ok(())
}

#[allow(clippy::too_many_arguments, clippy::needless_range_loop)]
fn render_autocomplete<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    text_buf: &[u8; 32],
    text_len: u8,
    filtered: &[Option<&str>; 8],
    filter_count: u8,
    selected: Option<usize>,
    expanded: bool,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);

    let row_h = style.font.line_height();
    let input_h = row_h.saturating_add(4);
    let input_rect = Rect::new(rect.x, rect.y, rect.w, input_h);

    block.render(input_rect, ctx)?;
    let inner = block.inner(input_rect);

    let current_text = core::str::from_utf8(&text_buf[..text_len as usize]).unwrap_or("");
    if text_len == 0 {
        ctx.draw_text_in(
            inner,
            "Search...",
            TextStyle::new(Rgb565::new(16, 32, 16)).with_font(style.font),
        )?;
    } else {
        ctx.draw_text_in(
            inner,
            current_text,
            TextStyle::new(style.text).with_font(style.font),
        )?;

        if state == VisualState::Focused {
            let cursor_x =
                inner.x + current_text.chars().count() as i32 * style.font.advance() as i32;
            if cursor_x < inner.right() {
                ctx.fill_rect(Rect::new(cursor_x, inner.y, 1, inner.h), style.accent)?;
            }
        }
    }

    ctx.draw_text_in(
        Rect::new(inner.right() - 7, inner.y, 7, inner.h),
        if expanded { "^" } else { "v" },
        TextStyle::new(style.accent)
            .with_font(style.font)
            .centered(),
    )?;

    if expanded && filter_count > 0 {
        let popup_h = (row_h.saturating_add(2))
            .saturating_mul(filter_count as u32)
            .min(100);
        let popup = Rect::new(rect.x, input_rect.bottom() + 1, rect.w, popup_h);
        ctx.fill_rect(popup, style.background.unwrap_or(Rgb565::new(4, 6, 8)))?;
        ctx.stroke_rect(popup, Border::one(style.border.color))?;

        for i in 0..filter_count as usize {
            if let Some(s) = filtered[i] {
                let row_y = popup.y + i as i32 * (row_h as i32 + 2);
                let row_rect = Rect::new(popup.x + 1, row_y + 1, popup.w.saturating_sub(2), row_h);

                if selected == Some(i) {
                    ctx.fill_rect(row_rect, style.accent)?;
                    ctx.draw_text_in(
                        Rect::new(row_rect.x + 2, row_rect.y, row_rect.w - 2, row_rect.h),
                        s,
                        TextStyle::new(style.foreground).with_font(style.font),
                    )?;
                } else {
                    ctx.draw_text_in(
                        Rect::new(row_rect.x + 2, row_rect.y, row_rect.w - 2, row_rect.h),
                        s,
                        TextStyle::new(style.text).with_font(style.font),
                    )?;
                }
            }
        }
    }

    Ok(())
}

#[cfg(feature = "rich-widgets")]
fn render_value_label<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    label: &str,
    value: i32,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    let inner = block.inner(rect);
    ctx.draw_text_in(
        Rect::new(inner.x, inner.y, inner.w / 2, inner.h),
        label,
        TextStyle::new(style.text).with_font(style.font),
    )?;
    draw_i32_right(
        ctx,
        Rect::new(
            inner.x + (inner.w / 2) as i32,
            inner.y,
            inner.w - inner.w / 2,
            inner.h,
        ),
        value,
        style.accent,
    )
}

#[cfg(feature = "rich-widgets")]
fn render_icon_button<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    icon: char,
    label: &str,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    let inner = block.inner(rect);
    let mut icon_buf = [0u8; 4];
    let icon_str = icon.encode_utf8(&mut icon_buf);
    ctx.draw_text_in(
        Rect::new(inner.x, inner.y, 8, inner.h),
        icon_str,
        TextStyle::new(style.accent)
            .with_font(style.font)
            .centered(),
    )?;
    ctx.draw_text_in(
        Rect::new(inner.x + 10, inner.y, inner.w.saturating_sub(10), inner.h),
        label,
        TextStyle::new(style.text).with_font(style.font),
    )
}

#[allow(clippy::too_many_arguments)]
#[cfg(feature = "rich-widgets")]
fn render_list<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    items: &[&str],
    selected: usize,
    offset: usize,
    visible_rows: usize,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    if items.is_empty() {
        return Ok(());
    }
    let inner = block.inner(rect);
    let rows = visible_rows.max(1).min(items.len());
    let row_h = (inner.h / rows as u32).max(1);
    for row_idx in 0..rows {
        let item_idx = offset.saturating_add(row_idx);
        if item_idx >= items.len() {
            break;
        }
        let row = Rect::new(
            inner.x,
            inner.y + (row_idx as u32 * row_h) as i32,
            inner.w,
            row_h,
        );
        if item_idx == selected {
            ctx.fill_rect(row, style.accent)?;
        }
        ctx.draw_text_in(
            row.inset(crate::geometry::EdgeInsets::symmetric(2, 1)),
            items[item_idx],
            TextStyle {
                color: style.text,
                font: style.font,
                opacity: style.opacity,
                align: TextAlign::Left,
                vertical_align: VerticalAlign::Middle,
                wrap: TextWrap::None,
                overflow: crate::render::TextOverflow::Clip,
                overflow_policy: crate::render::TextOverflowPolicy::Global(
                    crate::render::TextOverflow::Clip,
                ),
                kerning: false,
                max_lines: None,
                ellipsis: crate::render::EllipsisMode::ThreeDots,
                line_spacing: 0,
            },
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn render_circular_list<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    items: &[&str],
    selected: usize,
    offset: usize,
    visible_rows: usize,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    if items.is_empty() {
        return Ok(());
    }
    let inner = block.inner(rect);
    let rows = visible_rows.max(1).min(items.len());
    let row_h = (inner.h / rows as u32).max(1);

    let center_y = inner.y + (inner.h as i32) / 2;
    let half_h = (inner.h as f32 / 2.0).max(1.0);
    let max_shift = (inner.w as f32 * 0.25).max(8.0);

    for row_idx in 0..rows {
        let item_idx = offset.saturating_add(row_idx);
        if item_idx >= items.len() {
            break;
        }

        let item_center_y = inner.y + (row_idx as u32 * row_h + row_h / 2) as i32;
        let dy = (item_center_y - center_y) as f32;

        let normalized_dist = dy / half_h;
        let x_shift = (normalized_dist * normalized_dist * max_shift) as i32;

        let row = Rect::new(
            inner.x + x_shift,
            inner.y + (row_idx as u32 * row_h) as i32,
            inner.w.saturating_sub(x_shift as u32),
            row_h,
        );

        if item_idx == selected {
            ctx.fill_rect(row, style.accent)?;
        }

        ctx.draw_text_in(
            row.inset(crate::geometry::EdgeInsets::symmetric(2, 4)),
            items[item_idx],
            TextStyle {
                color: if item_idx == selected {
                    style.background.unwrap_or(style.text)
                } else {
                    style.text
                },
                font: style.font,
                opacity: style.opacity,
                align: TextAlign::Left,
                vertical_align: VerticalAlign::Middle,
                wrap: TextWrap::None,
                overflow: crate::render::TextOverflow::Clip,
                overflow_policy: crate::render::TextOverflowPolicy::Global(
                    crate::render::TextOverflow::Clip,
                ),
                kerning: false,
                max_lines: None,
                ellipsis: crate::render::EllipsisMode::ThreeDots,
                line_spacing: 0,
            },
        )?;
    }
    Ok(())
}

#[cfg(feature = "rich-widgets")]
fn render_scroll_view<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    offset_y: i32,
    content_h: u32,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    if content_h > rect.h {
        let inner = block.inner(rect);
        let thumb_h = ((inner.h as u64 * inner.h as u64) / content_h.max(1) as u64)
            .max(4)
            .min(inner.h as u64) as u32;
        let max_offset = content_h.saturating_sub(inner.h).max(1) as i32;
        let y = inner.y
            + ((inner.h.saturating_sub(thumb_h) as i32 * offset_y.clamp(0, max_offset))
                / max_offset);
        ctx.fill_rect(Rect::new(inner.right() - 3, y, 2, thumb_h), style.accent)?;
    }
    Ok(())
}

#[cfg(feature = "rich-widgets")]
fn render_tabs<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    labels: &[&str],
    selected: usize,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    if labels.is_empty() {
        return Ok(());
    }
    let inner = block.inner(rect);
    let tab_w = (inner.w / labels.len() as u32).max(1);
    for (idx, label) in labels.iter().enumerate() {
        let tab = Rect::new(
            inner.x + (idx as u32 * tab_w) as i32,
            inner.y,
            tab_w,
            inner.h,
        );
        if idx == selected {
            ctx.fill_rect(tab, style.accent)?;
        }
        ctx.draw_text_in(
            tab.inset(EdgeInsets::all(1)),
            label,
            TextStyle::new(style.text).with_font(style.font).centered(),
        )?;
    }
    Ok(())
}

#[cfg(feature = "rich-widgets")]
fn render_dialog<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    title: &str,
    body: &str,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style)
        .title(title)
        .title_align(TextAlign::Center);
    block.render(rect, ctx)?;
    let inner = block.content_area(rect);
    ctx.draw_text_in(
        inner,
        body,
        TextStyle {
            color: style.text,
            font: style.font,
            opacity: style.opacity,
            align: TextAlign::Center,
            vertical_align: VerticalAlign::Middle,
            wrap: TextWrap::Character,
            overflow: crate::render::TextOverflow::Clip,
            overflow_policy: crate::render::TextOverflowPolicy::Global(
                crate::render::TextOverflow::Clip,
            ),
            kerning: false,
            max_lines: None,
            ellipsis: crate::render::EllipsisMode::ThreeDots,
            line_spacing: 1,
        },
    )
}

#[cfg(feature = "rich-widgets")]
fn render_toast<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    text: &str,
    ttl_ms: u32,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    if ttl_ms == 0 {
        return Ok(());
    }
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    ctx.draw_text_in(
        block.inner(rect),
        text,
        TextStyle {
            color: style.text,
            font: style.font,
            opacity: style.opacity,
            align: TextAlign::Center,
            vertical_align: VerticalAlign::Middle,
            wrap: TextWrap::Character,
            overflow: crate::render::TextOverflow::Clip,
            overflow_policy: crate::render::TextOverflowPolicy::Global(
                crate::render::TextOverflow::Clip,
            ),
            kerning: false,
            max_lines: None,
            ellipsis: crate::render::EllipsisMode::ThreeDots,
            line_spacing: 0,
        },
    )
}

#[cfg(feature = "rich-widgets")]
fn render_meter<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    value: f32,
    min: f32,
    max: f32,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    let inner = block.inner(rect);
    let range = (max - min).max(f32::EPSILON);
    let t = ((value - min) / range).clamp(0.0, 1.0);
    let bars = 10usize;
    let gap = 1u32;
    let bar_w = inner
        .w
        .saturating_sub(gap * (bars as u32 - 1))
        .max(bars as u32)
        / bars as u32;
    for i in 0..bars {
        let x = inner.x + (i as u32 * (bar_w + gap)) as i32;
        let active = (i as f32) < t * bars as f32;
        let h = ((inner.h as f32 * (i + 1) as f32 / bars as f32) as u32).max(1);
        let y = inner.bottom() - h as i32;
        ctx.fill_rect(
            Rect::new(x, y, bar_w, h),
            if active {
                style.accent
            } else {
                Rgb565::new(5, 8, 8)
            },
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[cfg(feature = "rich-widgets")]
fn render_arc_gauge<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    value: f32,
    min: f32,
    max: f32,
    start_deg: i32,
    end_deg: i32,
    thickness: u8,
    antialias: bool,
    major_ticks: u8,
    minor_ticks: u8,
    show_value: bool,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    let inner = block.inner(rect);
    let cx = inner.x + inner.w as i32 / 2;
    let cy = inner.y + inner.h as i32 / 2;
    let radius = (inner.w.min(inner.h) / 2).saturating_sub(1);
    let track = Rgb565::new(5, 8, 8);
    draw_arc_ticks(
        ctx,
        cx,
        cy,
        radius.saturating_sub((thickness.max(1) / 2) as u32),
        start_deg,
        end_deg,
        major_ticks,
        minor_ticks,
        track,
    )?;
    ctx.stroke_arc_styled(
        cx,
        cy,
        radius,
        start_deg,
        end_deg,
        StrokeStyle::new(track)
            .with_width(thickness)
            .with_antialias(antialias),
    )?;
    let range = (max - min).max(f32::EPSILON);
    let t = ((value - min) / range).clamp(0.0, 1.0);
    let active_end = start_deg + (((end_deg - start_deg) as f32) * t) as i32;
    ctx.stroke_arc_styled(
        cx,
        cy,
        radius,
        start_deg,
        active_end,
        StrokeStyle::new(style.accent)
            .with_width(thickness)
            .with_antialias(antialias),
    )?;
    if show_value {
        draw_gauge_value_label(ctx, inner, value, min, max, style)?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn render_sweeping_arc<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    progress: f32,
    clockwise: bool,
    arc_radius: u32,
    frame_inset: u16,
    corner_radius: u8,
    bg_color: Rgb565,
    arc_color: Rgb565,
    frame_color: Rgb565,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    // Solid background behind the sweep.
    ctx.fill_rect(rect, bg_color)?;
    // Sweeping pie-sector from 12 o'clock; sign selects screen-wise direction.
    let cx = rect.x + rect.w as i32 / 2;
    let cy = rect.y + rect.h as i32 / 2;
    let sweep = progress.clamp(0.0, 1.0) * 360.0;
    let signed_sweep = if clockwise { -sweep } else { sweep };
    ctx.fill_sector_sweep(cx, cy, arc_radius, -90.0, signed_sweep, arc_color)?;
    // Rounded-rect "window" punched in the middle for the caller's value.
    let inset = frame_inset as i32;
    let fw = (rect.w as i32 - 2 * inset).max(0) as u32;
    let fh = (rect.h as i32 - 2 * inset).max(0) as u32;
    let frame = Rect::new(rect.x + inset, rect.y + inset, fw, fh);
    ctx.fill_rounded_rect(frame, corner_radius, frame_color)?;
    ctx.stroke_rounded_rect(frame, corner_radius, Border::one(frame_color))?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[cfg(feature = "rich-widgets")]
fn render_gauge<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    value: f32,
    min: f32,
    max: f32,
    major_ticks: u8,
    minor_ticks: u8,
    show_value: bool,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    render_arc_gauge(
        ctx,
        rect,
        value,
        min,
        max,
        135,
        405,
        2,
        true,
        major_ticks,
        minor_ticks,
        show_value,
        style,
        state,
    )
}

#[allow(clippy::too_many_arguments)]
#[cfg(feature = "rich-widgets")]
fn render_gauge_needle<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    value: f32,
    min: f32,
    max: f32,
    start_deg: i32,
    end_deg: i32,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    let inner = block.inner(rect);
    let cx = inner.x + inner.w as i32 / 2;
    let cy = inner.y + inner.h as i32 / 2;
    let radius = (inner.w.min(inner.h) / 2).saturating_sub(2);
    ctx.stroke_arc_styled(
        cx,
        cy,
        radius,
        start_deg,
        end_deg,
        StrokeStyle::new(Rgb565::new(8, 10, 10)).with_width(1),
    )?;
    let range = (max - min).max(f32::EPSILON);
    let t = ((value - min) / range).clamp(0.0, 1.0);
    let angle = (start_deg as f32 + (end_deg - start_deg) as f32 * t).to_radians();
    let nx = cx + (radius as f32 * angle.cos()) as i32;
    let ny = cy + (radius as f32 * angle.sin()) as i32;
    ctx.draw_line_styled(
        cx,
        cy,
        nx,
        ny,
        StrokeStyle::new(style.accent)
            .with_width(2)
            .with_antialias(true)
            .with_cap(crate::render::StrokeCap::Round),
    )?;
    ctx.fill_circle(cx, cy, 2, style.accent)
}

#[allow(clippy::too_many_arguments)]
#[cfg(feature = "rich-widgets")]
fn render_chart<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    values: &[f32],
    min: f32,
    max: f32,
    thickness: u8,
    fill_under: bool,
    markers: bool,
    mode: ChartMode,
    show_grid: bool,
    show_axes: bool,
    show_labels: bool,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    if values.len() < 2 {
        return Ok(());
    }
    let inner = block.inner(rect);
    if show_grid {
        for row in [1u32, 2, 3] {
            let y = inner.y + ((inner.h.saturating_sub(1) * row) / 4) as i32;
            ctx.draw_line_styled(
                inner.x,
                y,
                inner.right().saturating_sub(1),
                y,
                StrokeStyle::new(Rgb565::new(6, 10, 10)).with_width(1),
            )?;
        }
    }
    if show_axes {
        let axis = Rgb565::new(12, 18, 18);
        ctx.draw_line_styled(
            inner.x,
            inner.y,
            inner.x,
            inner.bottom().saturating_sub(1),
            StrokeStyle::new(axis).with_width(1),
        )?;
        ctx.draw_line_styled(
            inner.x,
            inner.bottom().saturating_sub(1),
            inner.right().saturating_sub(1),
            inner.bottom().saturating_sub(1),
            StrokeStyle::new(axis).with_width(1),
        )?;
    }
    if show_labels {
        let mut max_label: String<12> = String::new();
        let _ = write!(&mut max_label, "{:.1}", max);
        let mut min_label: String<12> = String::new();
        let _ = write!(&mut min_label, "{:.1}", min);
        ctx.draw_text_in(
            Rect::new(
                inner.x + 1,
                inner.y,
                inner.w.saturating_sub(2),
                style.font.line_height(),
            ),
            max_label.as_str(),
            TextStyle::new(style.text).with_font(style.font),
        )?;
        ctx.draw_text_in(
            Rect::new(
                inner.x + 1,
                inner
                    .bottom()
                    .saturating_sub(style.font.line_height() as i32),
                inner.w.saturating_sub(2),
                style.font.line_height(),
            ),
            min_label.as_str(),
            TextStyle::new(style.text).with_font(style.font),
        )?;
    }
    let range = (max - min).max(f32::EPSILON);
    match mode {
        ChartMode::Line => {
            let dx = (inner.w.saturating_sub(1) as f32) / (values.len().saturating_sub(1) as f32);
            for i in 1..values.len() {
                let v0 = ((values[i - 1] - min) / range).clamp(0.0, 1.0);
                let v1 = ((values[i] - min) / range).clamp(0.0, 1.0);
                let x0 = inner.x + ((i - 1) as f32 * dx) as i32;
                let x1 = inner.x + (i as f32 * dx) as i32;
                let y0 = inner.bottom() - 1 - (v0 * (inner.h.saturating_sub(1)) as f32) as i32;
                let y1 = inner.bottom() - 1 - (v1 * (inner.h.saturating_sub(1)) as f32) as i32;
                if fill_under {
                    let base = inner.bottom() - 1;
                    ctx.fill_polygon(
                        &[
                            embedded_graphics_core::geometry::Point::new(x0, base),
                            embedded_graphics_core::geometry::Point::new(x0, y0),
                            embedded_graphics_core::geometry::Point::new(x1, y1),
                            embedded_graphics_core::geometry::Point::new(x1, base),
                        ],
                        Rgb565::new(2, 8, 2),
                    )?;
                }
                ctx.draw_line_styled(
                    x0,
                    y0,
                    x1,
                    y1,
                    StrokeStyle::new(style.accent)
                        .with_width(thickness.max(1))
                        .with_antialias(true),
                )?;
                if markers {
                    ctx.fill_circle(x0, y0, 1, style.accent)?;
                    ctx.fill_circle(x1, y1, 1, style.accent)?;
                }
            }
        }
        ChartMode::Bars => {
            let count = values.len() as u32;
            let gap = 1u32;
            let bar_w = inner
                .w
                .saturating_sub(gap.saturating_mul(count.saturating_sub(1)))
                .max(count)
                / count;
            for (i, value) in values.iter().copied().enumerate() {
                let t = ((value - min) / range).clamp(0.0, 1.0);
                let h = (t * inner.h.saturating_sub(1) as f32) as u32;
                let x = inner.x + (i as u32 * (bar_w + gap)) as i32;
                let y = inner.bottom().saturating_sub(h as i32 + 1);
                let bar = Rect::new(x, y, bar_w.max(1), h.max(1));
                ctx.fill_rect(bar, style.accent)?;
                if markers {
                    ctx.fill_circle(x + (bar_w / 2) as i32, y, 1, style.text)?;
                }
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn render_plotter<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    values: &[f32],
    head: usize,
    min: f32,
    max: f32,
    thickness: u8,
    show_grid: bool,
    show_axes: bool,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    if values.len() < 2 {
        return Ok(());
    }
    let inner = block.inner(rect);
    if show_grid {
        for row in [1u32, 2, 3] {
            let y = inner.y + ((inner.h.saturating_sub(1) * row) / 4) as i32;
            ctx.draw_line_styled(
                inner.x,
                y,
                inner.right().saturating_sub(1),
                y,
                StrokeStyle::new(Rgb565::new(6, 10, 10)).with_width(1),
            )?;
        }
    }
    if show_axes {
        let axis = Rgb565::new(12, 18, 18);
        ctx.draw_line_styled(
            inner.x,
            inner.y,
            inner.x,
            inner.bottom().saturating_sub(1),
            StrokeStyle::new(axis).with_width(1),
        )?;
        ctx.draw_line_styled(
            inner.x,
            inner.bottom().saturating_sub(1),
            inner.right().saturating_sub(1),
            inner.bottom().saturating_sub(1),
            StrokeStyle::new(axis).with_width(1),
        )?;
    }

    let range = (max - min).max(f32::EPSILON);
    let dx = (inner.w.saturating_sub(1) as f32) / (values.len().saturating_sub(1) as f32);

    for i in 1..values.len() {
        let idx0 = (head + i - 1) % values.len();
        let idx1 = (head + i) % values.len();

        let v0 = ((values[idx0] - min) / range).clamp(0.0, 1.0);
        let v1 = ((values[idx1] - min) / range).clamp(0.0, 1.0);

        let x0 = inner.x + ((i - 1) as f32 * dx) as i32;
        let x1 = inner.x + (i as f32 * dx) as i32;

        let y0 = inner.bottom() - 1 - (v0 * (inner.h.saturating_sub(1)) as f32) as i32;
        let y1 = inner.bottom() - 1 - (v1 * (inner.h.saturating_sub(1)) as f32) as i32;

        ctx.draw_line_styled(
            x0,
            y0,
            x1,
            y1,
            StrokeStyle::new(style.accent)
                .with_width(thickness.max(1))
                .with_antialias(true),
        )?;
    }

    Ok(())
}

fn render_spinner<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    phase: f32,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    let inner = block.inner(rect);
    let cx = inner.x + inner.w as i32 / 2;
    let cy = inner.y + inner.h as i32 / 2;
    let radius = (inner.w.min(inner.h) / 2).saturating_sub(1);
    let base = ((phase.fract() * 360.0) as i32).rem_euclid(360);
    ctx.stroke_arc_styled(
        cx,
        cy,
        radius,
        base,
        base + 120,
        StrokeStyle::new(style.accent)
            .with_width(2)
            .with_antialias(true),
    )
}

#[cfg(feature = "rich-widgets")]
fn render_dropdown<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    items: &[&str],
    selected: usize,
    open: bool,
    align: TextAlign,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    let inner = block.inner(rect);
    let text = items.get(selected).copied().unwrap_or("-");
    ctx.draw_text_in(
        Rect::new(inner.x, inner.y, inner.w.saturating_sub(8), inner.h),
        text,
        TextStyle::new(style.text)
            .with_font(style.font)
            .with_align(align),
    )?;
    ctx.draw_text_in(
        Rect::new(inner.right() - 7, inner.y, 7, inner.h),
        if open { "^" } else { "v" },
        TextStyle::new(style.accent)
            .with_font(style.font)
            .centered(),
    )?;
    if open {
        let row_h = style.font.line_height().max(6);
        let popup_h = (row_h.saturating_mul(items.len() as u32))
            .min(40)
            .max(row_h);
        let popup = Rect::new(inner.x, inner.bottom() + 1, inner.w, popup_h);
        ctx.fill_rect(popup, style.background.unwrap_or(Rgb565::new(8, 12, 16)))?;
        ctx.stroke_rect(popup, Border::one(style.border.color))?;
        let visible = (popup_h / row_h).max(1) as usize;
        let start = selected
            .saturating_sub(visible / 2)
            .min(items.len().saturating_sub(visible));
        for (i, item) in items.iter().enumerate().skip(start).take(visible) {
            let row = Rect::new(
                popup.x + 1,
                popup.y + ((i - start) as u32 * row_h) as i32,
                popup.w.saturating_sub(2),
                row_h,
            );
            if i == selected {
                ctx.fill_rect(row, style.accent)?;
            }
            ctx.draw_text_in(
                row.inset(EdgeInsets::all(1)),
                item,
                TextStyle::new(style.text)
                    .with_font(style.font)
                    .with_align(align),
            )?;
        }
    }
    Ok(())
}

/// How many rows a roller draws (previous / current / next).
///
/// One definition, because two things depend on it and they must agree: the renderer divides the
/// inner height by this to place the rows, and the flick distance is one of those rows — so the
/// wheel turns once the finger has moved by the height of the row it is looking at
/// (`GuiContext::drag_step_selection`).
#[cfg(feature = "rich-widgets")]
pub(crate) const ROLLER_ROWS: u32 = 3;

/// The rect one of a roller's bars is drawn in, so the drawing and the touch that selects a bar cannot
/// disagree about which bar the finger landed on.
///
/// `RollerSelection::Touch` maps a touch to a bar, and the bar it selects has to be the bar the finger saw —
/// which is why this is not written out twice (`render_roller` and the touch share it).
#[cfg(feature = "rich-widgets")]
pub(crate) fn roller_row(inner: Rect, index: u32) -> Rect {
    let row_h = (inner.h / ROLLER_ROWS).max(1);
    Rect::new(inner.x, inner.y + (index * row_h) as i32, inner.w, row_h)
}

#[cfg(feature = "rich-widgets")]
fn render_roller<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    items: &[&str],
    selected: usize,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    if items.is_empty() {
        return Ok(());
    }
    let inner = block.inner(rect);
    let prev = items[(selected + items.len() - 1) % items.len()];
    let cur = items[selected];
    let next = items[(selected + 1) % items.len()];
    let rows = [prev, cur, next];
    for (idx, text) in rows.iter().enumerate() {
        let row = roller_row(inner, idx as u32);
        if idx == 1 {
            ctx.fill_rect(row, style.accent)?;
        }
        ctx.draw_text_in(
            row,
            text,
            TextStyle::new(style.text).with_font(style.font).centered(),
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[cfg(feature = "rich-widgets")]
fn render_table<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    rows: &[&[&str]],
    separators: bool,
    cell_padding: u8,
    align: TextAlign,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    if rows.is_empty() {
        return Ok(());
    }
    let inner = block.inner(rect);
    let row_h = (inner.h / rows.len() as u32).max(1);
    let max_cols = rows.iter().map(|row| row.len()).max().unwrap_or(1).max(1);
    let col_w = (inner.w / max_cols as u32).max(1);
    for (r, cols) in rows.iter().enumerate() {
        for c in 0..max_cols {
            let text = cols.get(c).copied().unwrap_or("");
            let cell = Rect::new(
                inner.x + (c as u32 * col_w) as i32,
                inner.y + (r as u32 * row_h) as i32,
                col_w,
                row_h,
            );
            if separators {
                ctx.stroke_rect(cell, Border::one(style.border.color))?;
            }
            ctx.draw_text_in(
                cell.inset(EdgeInsets::all(cell_padding as i16)),
                text,
                TextStyle::new(style.text)
                    .with_font(style.font)
                    .with_align(align),
            )?;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[cfg(feature = "rich-widgets")]
fn draw_arc_ticks<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    cx: i32,
    cy: i32,
    radius: u32,
    start_deg: i32,
    end_deg: i32,
    major_ticks: u8,
    minor_ticks: u8,
    color: Rgb565,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let major_ticks = major_ticks.max(1);
    let minor_ticks = minor_ticks.max(1);
    let total_steps = (major_ticks as u32).saturating_mul(minor_ticks as u32);
    for step in 0..=total_steps {
        let t = if total_steps == 0 {
            0.0
        } else {
            step as f32 / total_steps as f32
        };
        let angle = (start_deg as f32 + (end_deg - start_deg) as f32 * t).to_radians();
        let is_major = step % minor_ticks as u32 == 0;
        let tick_len = if is_major { 4 } else { 2 };
        let outer_x = cx + (radius as f32 * angle.cos()) as i32;
        let outer_y = cy + (radius as f32 * angle.sin()) as i32;
        let inner_x = cx + ((radius.saturating_sub(tick_len)) as f32 * angle.cos()) as i32;
        let inner_y = cy + ((radius.saturating_sub(tick_len)) as f32 * angle.sin()) as i32;
        ctx.draw_line_styled(
            inner_x,
            inner_y,
            outer_x,
            outer_y,
            StrokeStyle::new(color).with_width(1),
        )?;
    }
    Ok(())
}

#[cfg(feature = "rich-widgets")]
fn draw_gauge_value_label<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    inner: Rect,
    value: f32,
    min: f32,
    max: f32,
    style: Style,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let range = (max - min).max(f32::EPSILON);
    let percent = (((value - min) / range).clamp(0.0, 1.0) * 100.0).round() as i32;
    let mut label: String<8> = String::new();
    let _ = write!(&mut label, "{}%", percent);
    ctx.draw_text_in(
        Rect::new(
            inner.x,
            inner.y + (inner.h as i32 / 2) - (style.font.line_height() as i32 / 2),
            inner.w,
            style.font.line_height(),
        ),
        label.as_str(),
        TextStyle::new(style.text)
            .with_font(style.font)
            .with_align(TextAlign::Center),
    )
}

#[allow(clippy::too_many_arguments)]
#[cfg(feature = "rich-widgets")]
fn render_textarea<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    text: &str,
    cursor: usize,
    placeholder: &str,
    selection: Option<(usize, usize)>,
    cursor_visible: bool,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    let inner = block.inner(rect).inset(EdgeInsets::all(1));
    let max_chars = (inner.w / style.font.advance()).max(1) as usize;
    let shown = if text.is_empty() { placeholder } else { text };
    let color = if text.is_empty() {
        Rgb565::new(
            style.text.r().saturating_sub(8),
            style.text.g().saturating_sub(10),
            style.text.b().saturating_sub(8),
        )
    } else {
        style.text
    };
    if !text.is_empty() {
        if let Some((start, end)) = selection {
            let start = start.min(end).min(text.chars().count());
            let end = end.max(start).min(text.chars().count());
            for idx in start..end {
                let (col, row) = textarea_grid_position(text, idx, max_chars);
                let sel_rect = Rect::new(
                    inner.x + (col as u32 * style.font.advance()) as i32,
                    inner.y + (row as u32 * style.font.line_height()) as i32,
                    style.font.advance(),
                    style.font.line_height().min(inner.h),
                );
                ctx.fill_rect(sel_rect, style.accent)?;
            }
        }
    }
    ctx.draw_text_in(
        inner,
        shown,
        TextStyle::new(color)
            .with_font(style.font)
            .with_wrap(TextWrap::Character),
    )?;
    let chars = text.chars().count();
    let cursor = cursor.min(chars);
    if state == VisualState::Focused && cursor_visible {
        let (col, row) = textarea_grid_position(text, cursor, max_chars);
        let x = inner.x + (col as u32 * style.font.advance()) as i32;
        let y = inner.y + (row as u32 * style.font.line_height()) as i32;
        let caret = Rect::new(x, y, 1, style.font.line_height().min(inner.h));
        ctx.fill_rect(caret, style.accent)?;
    }
    Ok(())
}

/// Draws a panel of folded lines, stacking each one under the last by the height it folded to.
///
/// `count_lines` walks exactly the wrap boundaries `draw_text_in` will, so an entry that folds to
/// three rows pushes the next entry down by three rows rather than one. The rect is the window: an
/// entry that does not fit whole is not drawn, and three dots in the corner say that something is
/// hidden -- which is the difference between "this is all of it" and "there is more" that a plain
/// clip cannot make.
/// The numbers a text-line panel lays its text out with: characters per row, the font's line
/// height, the line spacing the text is drawn with, and how many pixels of the panel's inside are
/// available.
///
/// A shared function rather than four lines copied into the renderer and the mutators, because the
/// two have to agree exactly: the mutators use it to decide whether a line still fits, and the
/// renderer uses it to decide where to stop drawing. Two copies would drift, and a line the caller
/// was allowed to add would then be a line that is never drawn.
#[cfg(feature = "rich-widgets")]
pub(crate) fn text_lines_metrics(
    style: crate::style::Style,
    inner: Rect,
) -> (usize, u32, u32, u32) {
    let text_style = text_lines_text_style(style);
    (
        (inner.w / style.font.advance()).max(1) as usize,
        style.font.line_height(),
        text_style.line_spacing as u32,
        inner.h,
    )
}

/// The text style a text-line panel draws each entry with.
///
/// Word wrap, because that is what folding means to a reader; the crate's `line_len_at` falls back to
/// a character split when a single word is wider than the panel, so a long token still folds.
#[cfg(feature = "rich-widgets")]
pub(crate) fn text_lines_text_style(style: crate::style::Style) -> TextStyle {
    TextStyle::new(style.text)
        .with_font(style.font)
        .with_wrap(TextWrap::Word)
}

#[allow(clippy::too_many_arguments)]
#[cfg(feature = "rich-widgets")]
fn render_text_lines<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    lines: &TextLines<'_>,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    let inner = block.inner(rect);
    if inner.is_empty() || lines.is_empty() {
        return Ok(());
    }
    let (max_chars, line_h, spacing, _) = text_lines_metrics(style, inner);

    let mut y = inner.y;
    for index in 0..lines.len() {
        let text = match lines.get(index) {
            Some(text) => text,
            None => break,
        };
        let rows = crate::render::count_lines(text, max_chars, TextWrap::Word).max(1) as u32;
        let height = rows * line_h + rows.saturating_sub(1) * spacing;
        if y + height as i32 > inner.bottom() {
            break;
        }
        ctx.draw_text_in(
            Rect::new(inner.x, y, inner.w, height),
            text,
            text_lines_text_style(style),
        )?;
        y += height as i32 + lines.gap as i32;
    }

    // Only after a line was cut: a panel showing all of its text says nothing, so a design that
    // merely has blank space below its last line keeps that space blank.
    if lines
        .first_hidden(max_chars, line_h, spacing, inner.h)
        .is_some()
    {
        // Three one-pixel dots, right-aligned in the last row the panel can show. Small enough not
        // to be mistaken for content, and the only glyph that needs no assumption about the font.
        let dot_y = inner.bottom() - 1;
        let dot_w = 1u32;
        let gap = 1u32;
        let total = 3 * dot_w + 2 * gap;
        let x = inner.right() - total as i32 - 1;
        for dot in 0..3 {
            ctx.fill_rect(
                Rect::new(x + (dot * (dot_w + gap)) as i32, dot_y, dot_w, 1),
                style.text,
            )?;
        }
    }
    Ok(())
}

#[cfg(feature = "rich-widgets")]
fn textarea_grid_position(text: &str, cursor: usize, max_chars: usize) -> (usize, usize) {
    let mut row = 0usize;
    let mut col = 0usize;
    for ch in text.chars().take(cursor) {
        if ch == '\n' {
            row += 1;
            col = 0;
            continue;
        }
        col += 1;
        if col >= max_chars {
            row += 1;
            col = 0;
        }
    }
    (col, row)
}

#[cfg(feature = "rich-widgets")]
fn textarea_text(buf: &[u8; TEXTAREA_CAPACITY], len: u8) -> &str {
    let used = (len as usize).min(TEXTAREA_CAPACITY);
    core::str::from_utf8(&buf[..used]).unwrap_or("")
}

#[allow(clippy::too_many_arguments)]
#[cfg(feature = "rich-widgets")]
fn render_keyboard<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    keys: &[char],
    selected: usize,
    cols: u8,
    alt_keys: Option<&[char]>,
    layout: KeyboardLayout,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    if keys.is_empty() {
        return Ok(());
    }
    let inner = block.inner(rect).inset(EdgeInsets::all(1));
    let cols = cols.max(1) as usize;
    let rows = keys.len().div_ceil(cols).max(1);
    let cell_w = (inner.w / cols as u32).max(1);
    let cell_h = (inner.h / rows as u32).max(1);
    for (idx, key) in keys.iter().copied().enumerate() {
        let col = idx % cols;
        let row = idx / cols;
        let cell = Rect::new(
            inner.x + (col as u32 * cell_w) as i32,
            inner.y + (row as u32 * cell_h) as i32,
            cell_w,
            cell_h,
        );
        if idx == selected.min(keys.len() - 1) {
            ctx.fill_rect(cell, style.accent)?;
        }
        let rendered = keyboard_key_for_layout(key, idx, keys, alt_keys, layout);
        let mut label = [0u8; 4];
        let text = rendered.encode_utf8(&mut label);
        ctx.draw_text_in(
            cell.inset(EdgeInsets::all(1)),
            text,
            TextStyle::new(style.text).with_font(style.font).centered(),
        )?;
    }
    Ok(())
}

#[cfg(feature = "rich-widgets")]
fn keyboard_key_for_layout(
    base: char,
    idx: usize,
    base_keys: &[char],
    alt_keys: Option<&[char]>,
    layout: KeyboardLayout,
) -> char {
    match layout {
        KeyboardLayout::Normal => base,
        KeyboardLayout::Shift => {
            if base.is_ascii_alphabetic() {
                base.to_ascii_uppercase()
            } else {
                base
            }
        }
        KeyboardLayout::Symbols => alt_keys
            .and_then(|keys| keys.get(idx).copied())
            .or_else(|| {
                const FALLBACK: [char; 10] = ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')'];
                FALLBACK.get(idx % FALLBACK.len()).copied()
            })
            .unwrap_or_else(|| base_keys.get(idx).copied().unwrap_or(base)),
    }
}

#[cfg(feature = "rich-widgets")]
fn render_menu<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    items: &[&str],
    selected: usize,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;

    if items.is_empty() {
        return Ok(());
    }

    let inner = block.inner(rect);
    let row_h = (inner.h / items.len() as u32).max(1);
    for (i, item) in items.iter().enumerate() {
        let row = Rect::new(inner.x, inner.y + (i as u32 * row_h) as i32, inner.w, row_h);
        let is_selected = i == selected;
        if is_selected {
            ctx.fill_rect(row, style.accent)?;
        }
        ctx.draw_text_in(
            row.inset(crate::geometry::EdgeInsets::symmetric(2, 1)),
            item,
            TextStyle {
                color: style.text,
                font: style.font,
                opacity: style.opacity,
                align: TextAlign::Left,
                vertical_align: VerticalAlign::Middle,
                wrap: TextWrap::None,
                overflow: crate::render::TextOverflow::Clip,
                overflow_policy: crate::render::TextOverflowPolicy::Global(
                    crate::render::TextOverflow::Clip,
                ),
                kerning: false,
                max_lines: None,
                ellipsis: crate::render::EllipsisMode::ThreeDots,
                line_spacing: 0,
            },
        )?;
    }
    Ok(())
}

#[cfg(feature = "rich-widgets")]
fn render_menu_icon<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    icon: MonoBitmap<'_>,
    left: i32,
    top: i32,
    ink: Rgb565,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    for y in 0..icon.height {
        for x in 0..icon.width {
            if icon.is_ink(x, y) {
                ctx.fill_rect(Rect::new(left + x as i32, top + y as i32, 1, 1), ink)?;
            }
        }
    }
    Ok(())
}

#[cfg(feature = "rich-widgets")]
#[allow(clippy::too_many_arguments)]
fn render_rich_menu<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    cells: &[MenuCell<'_>],
    selected: usize,
    offset: usize,
    visible_rows: usize,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;

    if cells.is_empty() {
        return Ok(());
    }

    let inner = block.inner(rect);
    let rows = visible_rows.max(1).min(cells.len());
    let row_h = (inner.h / rows as u32).max(1);
    let line_h = style.font.line_height();

    for row_idx in 0..rows {
        let item_idx = offset.saturating_add(row_idx);
        let Some(cell) = cells.get(item_idx) else {
            break;
        };

        let row = Rect::new(
            inner.x,
            inner.y + (row_idx as u32 * row_h) as i32,
            inner.w,
            row_h,
        );
        let is_selected = item_idx == selected;

        if is_selected {
            ctx.fill_rect(row, style.accent)?;
        }

        let has_subtitle = cell.subtitle.is_some();
        let icon_w = cell.icon.map(|icon| icon.width).unwrap_or(0);
        let text_x = inner.x + icon_w as i32 + 3;
        let text_w = inner.w.saturating_sub(icon_w + 4).max(1);

        if let Some(icon) = cell.icon {
            let icon_h = icon.height;
            let icon_y = row.y + (row.h.saturating_sub(icon_h) as i32 / 2);
            render_menu_icon(ctx, icon, inner.x + 1, icon_y, style.text)?;
        }

        let text_color = if cell.enabled {
            style.text
        } else {
            // Keep the row visible but clearly de-emphasized.
            Rgb565::new(style.text.r() / 2, style.text.g() / 2, style.text.b() / 2)
        };
        let text_opacity = if cell.enabled {
            style.opacity
        } else {
            style.opacity.saturating_div(2).max(1)
        };

        let title_area = if has_subtitle && row.h >= line_h.saturating_mul(2) {
            Rect::new(text_x, row.y + 1, text_w, line_h)
        } else {
            Rect::new(text_x, row.y + 1, text_w, row.h.saturating_sub(2).max(1))
        };

        ctx.draw_text_in(
            title_area,
            cell.title,
            TextStyle {
                color: text_color,
                font: style.font,
                opacity: text_opacity,
                align: TextAlign::Left,
                vertical_align: if has_subtitle && row.h >= line_h.saturating_mul(2) {
                    VerticalAlign::Top
                } else {
                    VerticalAlign::Middle
                },
                wrap: TextWrap::None,
                overflow: crate::render::TextOverflow::Clip,
                overflow_policy: crate::render::TextOverflowPolicy::Global(
                    crate::render::TextOverflow::Clip,
                ),
                kerning: false,
                max_lines: None,
                ellipsis: crate::render::EllipsisMode::ThreeDots,
                line_spacing: 0,
            },
        )?;

        if let Some(subtitle) = cell.subtitle {
            if row.h >= line_h.saturating_mul(2) {
                ctx.draw_text_in(
                    Rect::new(text_x, row.y + 1 + line_h as i32, text_w, line_h),
                    subtitle,
                    TextStyle {
                        color: text_color,
                        font: style.font,
                        opacity: text_opacity.saturating_div(2).max(1),
                        align: TextAlign::Left,
                        vertical_align: VerticalAlign::Top,
                        wrap: TextWrap::None,
                        overflow: crate::render::TextOverflow::Clip,
                        overflow_policy: crate::render::TextOverflowPolicy::Global(
                            crate::render::TextOverflow::Clip,
                        ),
                        kerning: false,
                        max_lines: None,
                        ellipsis: crate::render::EllipsisMode::ThreeDots,
                        line_spacing: 0,
                    },
                )?;
            }
        }
    }
    Ok(())
}

fn render_image<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    image: ImageRef<'_>,
    fit: ImageFit,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    ctx.draw_image(block.inner(rect), image, fit)
}

fn render_carousel<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    items: &[&str],
    selected: usize,
    spec: &CarouselSpec,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    let inner = block.inner(rect);
    if items.is_empty() || inner.is_empty() {
        return Ok(());
    }

    let count = items.len() as i32;
    let step = spec.item_step.max(1) as i32;
    let half = spec.visible_slots.max(1) as i32 / 2;
    let center_y = inner.y + inner.h as i32 / 2;
    let advance = style.font.advance() as i32;
    let line_height = style.font.line_height() as i32;
    let selected = selected.min(items.len() - 1);

    let text_left = |text: &str| {
        let width = text.chars().count() as i32 * advance;
        (inner.x + (inner.w as i32 - width) / 2, width)
    };

    for rel in -half..=half {
        let row_center = center_y + rel * step + spec.shift as i32;
        if row_center + line_height / 2 < inner.y || row_center - line_height / 2 >= inner.bottom()
        {
            continue;
        }
        let idx = (selected as i32 + rel).rem_euclid(count) as usize;
        let text = items[idx];
        let color = carousel_slot_color(style.text, rel.unsigned_abs());
        let (x, _) = text_left(text);
        ctx.draw_text_with_font(x, row_center - line_height / 2, text, color, style.font)?;
    }

    let background = style.background.unwrap_or(Rgb565::BLACK);

    if spec.fade_edges {
        // Two rows of backdrop then two progressively brighter rows, so items
        // dissolve into the bezel instead of being cut off.
        for i in 0..6i32 {
            let shade = match i {
                0 | 1 => background,
                2 | 3 => scale_rgb565(style.text, 1, 2),
                _ => scale_rgb565(style.text, 2, 4),
            };
            ctx.fill_rect(Rect::new(inner.x, inner.y + i, inner.w, 1), shade)?;
            ctx.fill_rect(
                Rect::new(inner.x, inner.bottom() - 1 - i, inner.w, 1),
                shade,
            )?;
        }
    }

    if spec.indicator {
        let glow = scale_rgb565(
            style.accent,
            (spec.indicator_pulse as u16 * 31) / 255,
            (spec.indicator_pulse as u16 * 63) / 255,
        );
        let bar_w = spec.indicator_bar_w.max(1);
        let bar_h = spec.indicator_bar_h.max(1);
        let (left, width) = text_left(items[selected]);
        let y = center_y + spec.shift as i32 - bar_h as i32 / 2;
        let left_x = left - spec.indicator_gap as i32 - bar_w as i32;
        let right_x = left + width + spec.indicator_gap as i32;
        if left_x >= inner.x {
            ctx.fill_rect(Rect::new(left_x, y, bar_w as u32, bar_h as u32), glow)?;
        }
        if right_x + bar_w as i32 <= inner.right() {
            ctx.fill_rect(Rect::new(right_x, y, bar_w as u32, bar_h as u32), glow)?;
        }
    }

    if spec.mask_top > 0 {
        ctx.fill_rect(
            Rect::new(
                rect.x,
                rect.y - spec.mask_top as i32,
                rect.w,
                spec.mask_top as u32,
            ),
            background,
        )?;
    }
    if spec.mask_bottom > 0 {
        ctx.fill_rect(
            Rect::new(rect.x, rect.bottom(), rect.w, spec.mask_bottom as u32),
            background,
        )?;
    }

    Ok(())
}

fn render_composite_icon<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    parts: &[IconPart<'_>],
    spec: &CompositeIconSpec,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    let inner = block.inner(rect);
    if parts.is_empty() || inner.is_empty() {
        return Ok(());
    }

    let scale = spec.scale.max(1) as i32;
    // Bounds cover every part, visible or not, so toggling a part never
    // shifts the ones that stay on screen.
    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    let mut max_x = i32::MIN;
    let mut max_y = i32::MIN;
    for part in parts {
        min_x = min_x.min(part.dx);
        min_y = min_y.min(part.dy);
        max_x = max_x.max(part.dx + part.bitmap.width as i32);
        max_y = max_y.max(part.dy + part.bitmap.height as i32);
    }
    let content_w = (max_x - min_x).max(0) * scale;
    let content_h = (max_y - min_y).max(0) * scale;

    let (origin_x, origin_y) = match spec.align {
        IconAlign::TopLeft => (inner.x, inner.y),
        IconAlign::Center => (
            inner.x + (inner.w as i32 - content_w) / 2,
            inner.y + (inner.h as i32 - content_h) / 2,
        ),
    };
    let origin_x = origin_x - min_x * scale;
    let origin_y = origin_y - min_y * scale;

    if let Some(paper) = spec.paper {
        ctx.fill_rect(
            Rect::new(
                origin_x + min_x * scale,
                origin_y + min_y * scale,
                content_w.max(0) as u32,
                content_h.max(0) as u32,
            ),
            paper,
        )?;
    }

    for part in parts {
        if !part.visible {
            continue;
        }
        let ink = part.tint.unwrap_or(style.foreground);
        for y in 0..part.bitmap.height {
            for x in 0..part.bitmap.width {
                if !part.bitmap.is_ink(x, y) {
                    continue;
                }
                let px = origin_x + (part.dx + x as i32) * scale;
                let py = origin_y + (part.dy + y as i32) * scale;
                ctx.fill_rect(Rect::new(px, py, scale as u32, scale as u32), ink)?;
            }
        }
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[cfg(feature = "rich-widgets")]
fn render_peek_reveal<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    icon: ImageRef<'_>,
    title: &str,
    subtitle: &str,
    progress: f32,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    let inner = block.inner(rect);
    let t = progress.clamp(0.0, 1.0);
    let icon_size = ((inner.h.min(inner.w / 3) as f32) * (0.2 + 0.8 * t))
        .max(2.0)
        .round() as u32;
    let icon_rect = Rect::new(inner.x + 1, inner.y + 1, icon_size, icon_size);
    ctx.draw_image(icon_rect, icon, ImageFit::Stretch)?;
    if t > 0.25 {
        ctx.draw_text_in(
            Rect::new(
                inner.x + icon_size as i32 + 2,
                inner.y,
                inner.w.saturating_sub(icon_size + 2),
                inner.h / 2,
            ),
            title,
            TextStyle::new(style.text).with_font(style.font),
        )?;
    }
    if t > 0.5 {
        ctx.draw_text_in(
            Rect::new(
                inner.x + icon_size as i32 + 2,
                inner.y + (inner.h / 2) as i32,
                inner.w.saturating_sub(icon_size + 2),
                inner.h / 2,
            ),
            subtitle,
            TextStyle::new(style.accent).with_font(style.font),
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[cfg(feature = "rich-widgets")]
fn render_glance_tile<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    icon: char,
    title: &str,
    subtitle: &str,
    highlighted: bool,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    let inner = block.inner(rect);
    if highlighted {
        ctx.fill_rect(Rect::new(inner.x, inner.y, inner.w, 2), style.accent)?;
    }
    let mut icon_buf = [0u8; 4];
    let icon_str = icon.encode_utf8(&mut icon_buf);
    ctx.draw_text_in(
        Rect::new(inner.x, inner.y, 10, inner.h),
        icon_str,
        TextStyle::new(style.accent)
            .with_font(style.font)
            .centered(),
    )?;
    ctx.draw_text_in(
        Rect::new(
            inner.x + 12,
            inner.y,
            inner.w.saturating_sub(12),
            inner.h / 2,
        ),
        title,
        TextStyle::new(style.text).with_font(style.font),
    )?;
    ctx.draw_text_in(
        Rect::new(
            inner.x + 12,
            inner.y + (inner.h / 2) as i32,
            inner.w.saturating_sub(12),
            inner.h / 2,
        ),
        subtitle,
        TextStyle::new(style.accent).with_font(style.font),
    )?;
    Ok(())
}

#[cfg(feature = "rich-widgets")]
fn render_card_deck<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    titles: &[&str],
    selected: usize,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    let inner = block.inner(rect);
    if titles.is_empty() {
        return Ok(());
    }
    let active = titles[selected.min(titles.len() - 1)];
    ctx.draw_text_in(
        inner,
        active,
        TextStyle::new(style.text).with_font(style.font).centered(),
    )?;
    Ok(())
}

#[cfg(feature = "rich-widgets")]
fn render_reel<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    player: ReelPlayer<'_>,
    fit: ImageFit,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    if let Some(src) = player.current_sprite_rect() {
        let inner = block.inner(rect);
        let frame_index = (src.x / player.sheet.sprite_w.max(1) as i32) as u8
            + ((src.y / player.sheet.sprite_h.max(1) as i32) as u8) * 2;
        let accent = match frame_index & 0x03 {
            0 => Rgb565::new(0, 40, 31),
            1 => Rgb565::new(31, 20, 0),
            2 => Rgb565::new(20, 0, 31),
            _ => Rgb565::new(31, 40, 0),
        };
        ctx.stroke_rect(inner, Border::one(accent))?;
        let w = inner.w.saturating_sub(4);
        let h = inner.h.saturating_sub(4);
        let bar_w = (w / 4).max(1);
        for i in 0..4u32 {
            let x = inner.x + 2 + (i * bar_w) as i32;
            let bar = Rect::new(x, inner.y + 2, bar_w.saturating_sub(1), h);
            let active = i as u8 <= (frame_index & 0x03);
            ctx.fill_rect(bar, if active { accent } else { Rgb565::new(4, 6, 6) })?;
        }
        if matches!(fit, ImageFit::Stretch | ImageFit::Center) {
            // Keep fit consumed so API remains stable while reel internals stay lightweight.
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[cfg(feature = "rich-widgets")]
fn render_state_surface<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    surface: SurfaceState,
    title: &str,
    message: &str,
    action: Option<&str>,
    busy_phase: f32,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style)
        .title(title)
        .title_align(TextAlign::Center);
    block.render(rect, ctx)?;
    let inner = block.content_area(rect);

    let badge = match surface {
        SurfaceState::Ready => "READY",
        SurfaceState::Loading => "LOADING",
        SurfaceState::Empty => "EMPTY",
        SurfaceState::Error => "ERROR",
        SurfaceState::Offline => "OFFLINE",
    };
    ctx.draw_text_in(
        Rect::new(inner.x, inner.y, inner.w, style.font.line_height()),
        badge,
        TextStyle::new(style.accent)
            .with_font(style.font)
            .centered(),
    )?;

    if matches!(surface, SurfaceState::Loading) {
        let y = inner.y + style.font.line_height() as i32 + 3;
        let w = inner.w.saturating_sub(10);
        let x = inner.x + 5;
        ctx.stroke_rect(Rect::new(x, y, w, 5), Border::one(style.border.color))?;
        let t = busy_phase.fract().abs();
        let pulse = ((w as f32 * 0.2) as u32).max(2);
        let offset = ((w.saturating_sub(pulse) as f32) * t) as i32;
        ctx.fill_rect(Rect::new(x + offset, y + 1, pulse, 3), style.accent)?;
    }

    ctx.draw_text_in(
        Rect::new(
            inner.x + 2,
            inner.y + style.font.line_height() as i32 + 10,
            inner.w.saturating_sub(4),
            inner.h.saturating_sub(style.font.line_height() + 20),
        ),
        message,
        TextStyle::new(style.text)
            .with_font(style.font)
            .with_align(TextAlign::Center)
            .with_wrap(TextWrap::Character),
    )?;

    if let Some(action_label) = action {
        let action_h = style.font.line_height() + 3;
        let action_rect = Rect::new(
            inner.x + 4,
            inner.bottom() - action_h as i32 - 2,
            inner.w.saturating_sub(8),
            action_h,
        );
        ctx.stroke_rect(action_rect, Border::one(style.accent))?;
        ctx.draw_text_in(
            action_rect,
            action_label,
            TextStyle::new(style.accent)
                .with_font(style.font)
                .with_align(TextAlign::Center),
        )?;
    }

    Ok(())
}

#[cfg(feature = "rich-widgets")]
fn render_heads_up_banner<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    level: NotificationLevel,
    text: &str,
    ttl_ms: u32,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    if ttl_ms == 0 {
        return Ok(());
    }
    let mut style = style.resolve(state);
    style.accent = match level {
        NotificationLevel::Info => Rgb565::new(0, 32, 31),
        NotificationLevel::Success => Rgb565::new(0, 50, 0),
        NotificationLevel::Warning => Rgb565::new(31, 40, 0),
        NotificationLevel::Error => Rgb565::new(31, 0, 0),
    };
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    ctx.draw_text_in(
        block.inner(rect),
        text,
        TextStyle::new(style.text)
            .with_font(style.font)
            .with_align(TextAlign::Center),
    )
}

#[allow(clippy::too_many_arguments)]
#[cfg(feature = "rich-widgets")]
fn render_notification_action_sheet<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    level: NotificationLevel,
    title: &str,
    body: &str,
    actions: &[&str],
    selected: usize,
    open: bool,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    if !open {
        return Ok(());
    }
    let mut style = style.resolve(state);
    style.accent = match level {
        NotificationLevel::Info => Rgb565::new(0, 32, 31),
        NotificationLevel::Success => Rgb565::new(0, 50, 0),
        NotificationLevel::Warning => Rgb565::new(31, 40, 0),
        NotificationLevel::Error => Rgb565::new(31, 0, 0),
    };
    let block = Block::styled(style)
        .title(title)
        .title_align(TextAlign::Center);
    block.render(rect, ctx)?;
    let inner = block.content_area(rect);
    let body_h = inner.h.saturating_sub(style.font.line_height() + 12);
    ctx.draw_text_in(
        Rect::new(inner.x + 2, inner.y + 2, inner.w.saturating_sub(4), body_h),
        body,
        TextStyle::new(style.text)
            .with_font(style.font)
            .with_wrap(TextWrap::Character),
    )?;
    if actions.is_empty() {
        return Ok(());
    }
    let action_h = style.font.line_height() + 2;
    let y = inner.bottom() - action_h as i32 - 2;
    let action_w = (inner.w / actions.len() as u32).max(1);
    for (i, action) in actions.iter().enumerate() {
        let cell = Rect::new(
            inner.x + (i as u32 * action_w) as i32,
            y,
            action_w,
            action_h,
        );
        if i == selected.min(actions.len() - 1) {
            ctx.fill_rect(cell, style.accent)?;
        } else {
            ctx.stroke_rect(cell, Border::one(style.border.color))?;
        }
        ctx.draw_text_in(
            cell,
            action,
            TextStyle::new(style.text)
                .with_font(style.font)
                .with_align(TextAlign::Center),
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[cfg(feature = "rich-widgets")]
fn render_feed_timeline<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    items: &[&str],
    selected: usize,
    offset: usize,
    visible_rows: usize,
    expanded: bool,
    style: WidgetStyle,
    state: VisualState,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let style = style.resolve(state);
    let block = Block::styled(style);
    block.render(rect, ctx)?;
    if items.is_empty() {
        return Ok(());
    }
    let inner = block.inner(rect);
    let rows = visible_rows.max(1).min(items.len());
    let row_h = (inner.h / rows as u32).max(1);
    for row_idx in 0..rows {
        let item_idx = offset.saturating_add(row_idx);
        if item_idx >= items.len() {
            break;
        }
        let row = Rect::new(
            inner.x,
            inner.y + (row_idx as u32 * row_h) as i32,
            inner.w,
            row_h,
        );
        let is_selected = item_idx == selected;
        if is_selected {
            ctx.fill_rect(row, style.accent)?;
        }
        ctx.draw_text_in(
            row.inset(EdgeInsets::symmetric(2, 1)),
            items[item_idx],
            TextStyle::new(style.text)
                .with_font(style.font)
                .with_wrap(TextWrap::Character),
        )?;
        if expanded && is_selected && row_h > style.font.line_height() + 4 {
            let detail = Rect::new(
                row.x + 2,
                row.y + style.font.line_height() as i32,
                row.w.saturating_sub(4),
                row.h.saturating_sub(style.font.line_height()),
            );
            ctx.draw_text_in(
                detail,
                "details...",
                TextStyle::new(style.text).with_font(style.font),
            )?;
        }
    }
    Ok(())
}

#[cfg(feature = "rich-widgets")]
fn draw_i32_right<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    rect: Rect,
    value: i32,
    color: Rgb565,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let mut buf = [0u8; 12];
    let mut n = value.unsigned_abs();
    let negative = value < 0;
    let mut pos = buf.len();
    if n == 0 {
        pos -= 1;
        buf[pos] = b'0';
    } else {
        while n > 0 && pos > usize::from(negative) {
            pos -= 1;
            buf[pos] = b'0' + (n % 10) as u8;
            n /= 10;
        }
    }
    if negative && pos > 0 {
        pos -= 1;
        buf[pos] = b'-';
    }
    let text = core::str::from_utf8(&buf[pos..]).unwrap_or("?");
    ctx.draw_text_in(
        rect,
        text,
        TextStyle {
            color,
            font: crate::font::FontId::Tiny3x5,
            opacity: 255,
            align: TextAlign::Right,
            vertical_align: VerticalAlign::Middle,
            wrap: TextWrap::None,
            overflow: crate::render::TextOverflow::Clip,
            overflow_policy: crate::render::TextOverflowPolicy::Global(
                crate::render::TextOverflow::Clip,
            ),
            kerning: false,
            max_lines: None,
            ellipsis: crate::render::EllipsisMode::ThreeDots,
            line_spacing: 0,
        },
    )
}

impl Default for WidgetNode<'_> {
    fn default() -> Self {
        Self::new(
            WidgetId::new(0),
            Rect::empty(),
            WidgetKind::Spacer,
            WidgetStyle::new(Style {
                background: None,
                gradient: None,
                font: crate::font::FontId::Tiny3x5,
                foreground: Rgb565::WHITE,
                text: Rgb565::WHITE,
                accent: Rgb565::WHITE,
                opacity: 255,
                corner_radius: 0,
                shadow: None,
                border: Border::none(),
                padding: crate::geometry::EdgeInsets::all(0),
            }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::framebuffer::Framebuffer;

    fn node<'a>(kind: WidgetKind<'a>) -> WidgetNode<'a> {
        WidgetNode::new(
            WidgetId::new(1),
            Rect::new(0, 0, 10, 10),
            kind,
            Style::new(),
        )
    }

    #[test]
    fn widget_node_property_get_set() {
        let mut progress = node(WidgetKind::ProgressBar { value: 0.25 });
        assert_eq!(
            progress.get_property(PropertyKey::Value),
            Some(PropertyValue::Float(0.25))
        );
        assert!(progress
            .set_property(PropertyKey::Progress, PropertyValue::Float(2.0))
            .is_ok());
        assert_eq!(
            progress.get_property(PropertyKey::Value),
            Some(PropertyValue::Float(1.0))
        );

        let mut label = node(WidgetKind::Label("hi"));
        assert_eq!(
            label.get_property(PropertyKey::Text),
            Some(PropertyValue::Str("hi"))
        );
        assert!(label
            .set_property(PropertyKey::Text, PropertyValue::Str("yo"))
            .is_ok());

        let mut button = node(WidgetKind::Button("a"));
        assert!(button
            .set_property(PropertyKey::Text, PropertyValue::Str("b"))
            .is_ok());
        assert_eq!(
            button.get_property(PropertyKey::Text),
            Some(PropertyValue::Str("b"))
        );

        let mut slider = node(WidgetKind::Slider {
            value: 5.0,
            min: 0.0,
            max: 10.0,
            knob_w: 3,
        });
        assert_eq!(
            slider.get_property(PropertyKey::Min),
            Some(PropertyValue::Float(0.0))
        );
        assert_eq!(
            slider.get_property(PropertyKey::Max),
            Some(PropertyValue::Float(10.0))
        );
        assert!(slider
            .set_property(PropertyKey::Value, PropertyValue::Float(99.0))
            .is_ok());
        assert_eq!(
            slider.get_property(PropertyKey::Value),
            Some(PropertyValue::Float(10.0))
        );

        let mut toggle = node(WidgetKind::Toggle {
            label: "t",
            on: false,
            off_color: Rgb565::new(7, 10, 10),
            track_border: None,
            track_border_width: 0,
        });
        assert!(toggle
            .set_property(PropertyKey::State, PropertyValue::Bool(true))
            .is_ok());
        assert_eq!(
            toggle.get_property(PropertyKey::State),
            Some(PropertyValue::Bool(true))
        );

        let mut checkbox = node(WidgetKind::Checkbox {
            label: "c",
            checked: true,
            box_width: 0,
            box_height: 0,
            label_position: CheckboxLabelPosition::Right,
            box_color: None,
        });
        assert!(checkbox
            .set_property(PropertyKey::State, PropertyValue::Bool(false))
            .is_ok());
        assert_eq!(
            checkbox.get_property(PropertyKey::State),
            Some(PropertyValue::Bool(false))
        );

        let mut list = node(WidgetKind::List {
            items: &["a", "b"],
            selected: 0,
            offset: 0,
            visible_rows: 2,
        });
        assert!(list
            .set_property(PropertyKey::Selected, PropertyValue::Usize(1))
            .is_ok());
        assert_eq!(
            list.get_property(PropertyKey::Selected),
            Some(PropertyValue::Usize(1))
        );

        let mut tabs = node(WidgetKind::Tabs {
            labels: &["a", "b"],
            selected: 0,
        });
        assert!(tabs
            .set_property(PropertyKey::Selected, PropertyValue::Usize(1))
            .is_ok());

        let cells = [
            MenuCell::new("one").with_subtitle("sub"),
            MenuCell::new("two").with_enabled(false),
        ];
        let mut rich = node(WidgetKind::RichMenu {
            cells: &cells,
            selected: 0,
            offset: 0,
            visible_rows: 2,
        });
        assert_eq!(
            rich.get_property(PropertyKey::Selected),
            Some(PropertyValue::Usize(0))
        );
        assert!(rich
            .set_property(PropertyKey::Selected, PropertyValue::Usize(5))
            .is_ok());
        assert_eq!(
            rich.get_property(PropertyKey::Selected),
            Some(PropertyValue::Usize(1))
        );

        let mut spacer = node(WidgetKind::Spacer);
        assert_eq!(spacer.get_property(PropertyKey::Value), None);
        assert!(spacer
            .set_property(PropertyKey::Value, PropertyValue::Float(0.0))
            .is_err());
    }

    #[test]
    fn widget_node_flags_and_focusability() {
        let mut btn = node(WidgetKind::Button("x"));
        assert!(btn.clickable());
        assert!(btn.focusable());

        let panel = node(WidgetKind::Panel);
        assert!(!panel.focusable());
        assert!(panel.clips_children());

        btn.flags.insert(WidgetFlags::SCROLLABLE);
        assert!(btn.scrollable());

        btn.flags.insert(WidgetFlags::CLIP_CHILDREN);
        assert!(btn.clips_children());

        btn.flags.set(WidgetFlags::HIDDEN, true);
        assert!(btn.hidden());
        assert!(!btn.focusable());

        btn.flags.set(WidgetFlags::HIDDEN, false);
        btn.flags.set(WidgetFlags::DISABLED, true);
        assert!(btn.disabled());
        assert!(!btn.focusable());

        let spec = CarouselSpec::new(12, 4);
        assert_eq!(spec.item_step, 12);
        assert_eq!(spec.visible_slots, 4);
    }

    /// The grip the renderer draws and the pixel a finger presses are the same geometry.
    ///
    /// Drawn first, then read back: the middle of the accent block is fed through the touch path
    /// and has to give the value the block was drawn for. A drift between the two -- the grip
    /// travelling `inner.w - knob_w` while the finger is mapped across `inner.w` -- is exactly the
    /// kind of bug that makes a slider feel "off by an inch" on a panel.
    #[cfg(feature = "rich-widgets")]
    #[test]
    fn a_sliders_grip_and_its_finger_share_one_geometry() {
        use crate::context::GuiContext;
        use crate::test_buffer::TestBuffer;

        let rect = Rect::new(10, 10, 200, 24);
        let style = Style::panel();
        let mut ctx: GuiContext<16, 8, 8> = GuiContext::new(Rect::new(0, 0, 240, 60));
        let _ = ctx
            .add_slider_sized(rect, 25.0, 0.0, 100.0, 12, style)
            .unwrap();
        let mut buffer = TestBuffer::new(240, 60);
        ctx.render(&mut buffer).unwrap();

        // The accent block is the grip, and `Style::panel()`'s accent is the only accent on the
        // panel -- the track is `text` and the face is a gradient.
        let (inner, knob_w) = slider_geometry(rect, style, 12);
        let mut left = None;
        let mut right = None;
        let y = inner.y + inner.h as i32 / 2;
        for x in 0..240i32 {
            if buffer.pixel_at(x, y) == Some(style.accent) {
                left.get_or_insert(x);
                right = Some(x);
            }
        }
        let (left, right) = (left.expect("the grip was drawn"), right.unwrap());
        assert_eq!(
            right - left + 1,
            knob_w as i32,
            "the grip is as wide as it was asked to be"
        );

        let centre = (left + right) / 2;
        let asked = slider_value_at_x(rect, style, 0.0, 100.0, 12, centre);
        assert!(
            (asked - 25.0).abs() < 1.5,
            "the middle of the drawn grip asks for 25, got {asked}"
        );
    }

    #[test]
    fn widget_node_render_and_hidden_noop() {
        let mut fb = Framebuffer::<100>::new(10, 10);
        let mut ctx = RenderCtx::new(&mut fb, Rect::new(0, 0, 10, 10));
        let panel_node = node(WidgetKind::Panel);
        assert!(panel_node.render(&mut ctx, VisualState::Normal).is_ok());

        let mut hidden = node(WidgetKind::Button("x"));
        hidden.flags.insert(WidgetFlags::HIDDEN);
        assert!(hidden.render(&mut ctx, VisualState::Normal).is_ok());
        assert!(hidden
            .render_at(&mut ctx, Rect::new(0, 0, 5, 5), VisualState::Pressed)
            .is_ok());
    }

    #[test]
    fn widget_node_textarea_and_keyboard_render() {
        let mut fb = Framebuffer::<40_000>::new(200, 200);
        let mut ctx = RenderCtx::new(&mut fb, Rect::new(0, 0, 200, 200));

        let mut buf = [0u8; TEXTAREA_CAPACITY];
        let text = b"hello\nworld";
        buf[..text.len()].copy_from_slice(text);
        let ta = WidgetKind::TextArea {
            text_buf: buf,
            text_len: text.len() as u8,
            cursor: 7,
            placeholder: "type...",
            selection: Some((0, 5)),
            cursor_visible: true,
            read_only: false,
            single_line: false,
            accept_newline: true,
        };
        let node = WidgetNode::new(WidgetId::new(2), Rect::new(0, 0, 100, 60), ta, Style::new());
        assert!(node
            .render_at(&mut ctx, Rect::new(0, 0, 100, 60), VisualState::Focused)
            .is_ok());

        let empty_buf = [0u8; TEXTAREA_CAPACITY];
        let placeholder_ta = WidgetKind::TextArea {
            text_buf: empty_buf,
            text_len: 0,
            cursor: 0,
            placeholder: "empty",
            selection: None,
            cursor_visible: false,
            read_only: false,
            single_line: false,
            accept_newline: false,
        };
        let placeholder_node = WidgetNode::new(
            WidgetId::new(3),
            Rect::new(0, 60, 100, 40),
            placeholder_ta,
            Style::new(),
        );
        assert!(placeholder_node
            .render_at(&mut ctx, Rect::new(0, 60, 100, 40), VisualState::Normal)
            .is_ok());

        let keys = ['a', 'b', 'c', 'd', 'e', 'f'];
        let alt_keys = ['A', 'B', 'C', 'D', 'E', 'F'];
        for layout in [
            KeyboardLayout::Normal,
            KeyboardLayout::Shift,
            KeyboardLayout::Symbols,
        ] {
            let kb = WidgetKind::Keyboard {
                keys: &keys,
                selected: 3,
                cols: 3,
                alt_keys: Some(&alt_keys),
                layout,
                target: None,
            };
            let kb_node = WidgetNode::new(
                WidgetId::new(4),
                Rect::new(0, 110, 100, 60),
                kb,
                Style::new(),
            );
            assert!(kb_node
                .render_at(&mut ctx, Rect::new(0, 110, 100, 60), VisualState::Focused)
                .is_ok());
        }

        let empty_kb = WidgetKind::Keyboard {
            keys: &[],
            selected: 0,
            cols: 1,
            alt_keys: None,
            layout: KeyboardLayout::Normal,
            target: None,
        };
        let empty_node = WidgetNode::new(
            WidgetId::new(5),
            Rect::new(0, 180, 50, 20),
            empty_kb,
            Style::new(),
        );
        assert!(empty_node
            .render_at(&mut ctx, Rect::new(0, 180, 50, 20), VisualState::Normal)
            .is_ok());
    }

    #[test]
    fn rich_menu_subtitle_and_tall_row_render() {
        let mut fb = Framebuffer::<40_000>::new(200, 200);
        let mut ctx = RenderCtx::new(&mut fb, Rect::new(0, 0, 200, 200));
        let cells = [
            MenuCell::new("Alpha").with_subtitle("subtitle alpha"),
            MenuCell::new("Beta")
                .with_subtitle("subtitle beta")
                .with_enabled(false),
        ];
        let menu = WidgetKind::RichMenu {
            cells: &cells,
            selected: 0,
            offset: 0,
            visible_rows: 1,
        };
        let node = WidgetNode::new(
            WidgetId::new(6),
            Rect::new(0, 0, 100, 60),
            menu,
            Style::new(),
        );
        assert!(node
            .render_at(&mut ctx, Rect::new(0, 0, 100, 60), VisualState::Focused)
            .is_ok());
    }
}

#[cfg(test)]
#[cfg(feature = "rich-widgets")]
mod text_lines_tests {
    use super::*;
    use crate::context::GuiContext;
    use crate::test_buffer::TestBuffer;
    use crate::{font::Font as _, FontId, GuiError};

    /// Folding is the font's business, not the caller's: a line too wide for the box takes two rows,
    /// and the line under it starts two rows down.
    #[test]
    fn folding_and_stacking_follow_the_font() {
        let line_h = FontId::Mono6x10.line_height();
        let mut panel = TextLines::new();
        // Twelve characters, no space to break on: the word-wrap has to fall back to a character split,
        // which is the case a log line of a path or a hex dump hits.
        assert!(panel.push("aaaaaaaaaaaa"));
        let two_rows = line_h * 2 + 1; // the crate's own default line spacing is one pixel
        assert_eq!(panel.height_at(10, line_h, 1), two_rows);
        assert_eq!(panel.first_hidden(10, line_h, 1, two_rows - 1), Some(0));
        assert_eq!(panel.first_hidden(10, line_h, 1, two_rows), None);

        // A short entry is one row, and the gap is between entries rather than after the last.
        let stacked = TextLines::from_slice(&["short", "short"]).gap(4);
        assert_eq!(stacked.height_at(10, line_h, 1), line_h * 2 + 4);
        assert_eq!(stacked.first_hidden(10, line_h, 1, line_h + 3), Some(1));
        assert_eq!(stacked.first_hidden(10, line_h, 1, line_h * 2 + 4), None);
    }

    /// A borrowed line costs nothing, a copied one is bounded, and both answer the same text.
    #[test]
    fn lines_borrow_copy_and_delete_by_index() {
        let mut panel = TextLines::from_slice(&["one", "two", "three"]);
        assert_eq!(panel.len(), 3);
        assert_eq!(panel.get(1), Some("two"));
        assert!(panel.remove(1));
        assert_eq!(panel.get(1), Some("three"));
        assert_eq!(panel.len(), 2);
        assert!(panel.set(0, "zero"));
        assert_eq!(panel.get(0), Some("zero"));

        // The copy keeps as much as fits, and stops on a character boundary rather than inside one.
        let long = "x".repeat(TEXT_LINE_BYTES + 8);
        assert!(panel.set_owned(0, &long));
        assert_eq!(panel.get(0).map(str::len), Some(TEXT_LINE_BYTES));
        let wide = "ä".repeat(TEXT_LINE_BYTES);
        assert!(panel.set_owned(0, &wide));
        let kept = panel.get(0).unwrap();
        assert!(kept.len() <= TEXT_LINE_BYTES);
        assert!(kept.chars().all(|ch| ch == 'ä'), "a character was split");

        // Storage is bounded, and a full panel says so instead of overwriting.
        let mut full = TextLines::new();
        for _ in 0..TEXT_LINES_CAPACITY {
            assert!(full.push("x"));
        }
        assert!(!full.push("y"));
        assert_eq!(full.len(), TEXT_LINES_CAPACITY);
        full.clear();
        assert!(full.is_empty());
    }

    /// The mutators reach the glass and refuse without mutating.
    #[test]
    fn mutations_reach_the_panel_and_a_refusal_changes_nothing() {
        let style = Style::panel();
        let mut gui: GuiContext<16, 8, 8> = GuiContext::new(Rect::new(0, 0, 120, 60));
        let id = gui
            .add_text_lines(
                Rect::new(0, 0, 120, 60),
                &["first", "second", "third"],
                2,
                style,
            )
            .unwrap();
        assert_eq!(gui.text_line_count(id), Some(3));
        assert_eq!(gui.text_line(id, 1), Some("second"));

        let ink = |buffer: &TestBuffer| -> usize {
            let mut count = 0;
            for y in 0..60 {
                for x in 0..120 {
                    if buffer.pixel_at(x, y) == Some(style.text) {
                        count += 1;
                    }
                }
            }
            count
        };

        let mut before = TestBuffer::new(120, 60);
        gui.render(&mut before).unwrap();
        let three_lines = ink(&before);

        assert!(gui.remove_text_line(id, 1).is_ok());
        assert_eq!(gui.text_line_count(id), Some(2));
        assert_eq!(gui.text_line(id, 1), Some("third"));
        let mut after = TestBuffer::new(120, 60);
        gui.render(&mut after).unwrap();
        assert!(
            ink(&after) < three_lines,
            "the deleted line is still on the glass: {} vs {}",
            ink(&after),
            three_lines
        );

        // A runtime-built line, then a font change: both are what code has to be able to do.
        assert!(gui.push_text_line_owned(id, "fourth").is_ok());
        assert_eq!(gui.text_line(id, 2), Some("fourth"));
        assert!(gui.set_widget_font(id, FontId::Mono8x16).is_ok());

        // A 60-pixel panel of 16-pixel rows runs out of room. The refusal is `LinesFull`, and the
        // panel is exactly as it was -- otherwise a caller looping until it is refused would leave a
        // half-written line behind.
        let refusal = loop {
            match gui.push_text_line(id, "more") {
                Ok(()) => {}
                Err(error) => break error,
            }
        };
        assert_eq!(refusal, GuiError::LinesFull);
        let full = gui.text_line_count(id).unwrap();
        assert_eq!(gui.push_text_line(id, "more"), Err(GuiError::LinesFull));
        assert_eq!(gui.text_line_count(id), Some(full));
        assert!(full >= 3);

        // It still draws with nothing left to give.
        let mut full_frame = TestBuffer::new(120, 60);
        gui.render(&mut full_frame).unwrap();
    }

    /// A panel whose text does not fit says so, and one that fits says nothing.
    #[test]
    fn an_overflowing_panel_marks_itself() {
        let style = Style::panel();
        let lines = [
            "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta",
        ];

        let draw = |rect: Rect| -> TestBuffer {
            let mut gui: GuiContext<16, 8, 8> = GuiContext::new(Rect::new(0, 0, 120, 90));
            gui.add_text_lines(rect, &lines, 2, style).unwrap();
            let mut buffer = TestBuffer::new(120, 90);
            gui.render(&mut buffer).unwrap();
            buffer
        };

        // Three dots in the last row the panel can show -- the row inside its own border and padding,
        // which is where the renderer puts them.
        let dots = |buffer: &TestBuffer, rect: Rect| -> usize {
            let inner = crate::block::Block::styled(style).inner(rect);
            let y = inner.bottom() - 1;
            let mut count = 0;
            for x in inner.x..inner.right() {
                if buffer.pixel_at(x, y) == Some(style.text) {
                    count += 1;
                }
            }
            count
        };

        let cramped = draw(Rect::new(0, 0, 120, 20));
        assert!(
            dots(&cramped, Rect::new(0, 0, 120, 20)) >= 3,
            "no marker on a clipped panel"
        );
        let roomy = draw(Rect::new(0, 0, 120, 90));
        assert_eq!(
            dots(&roomy, Rect::new(0, 0, 120, 90)),
            0,
            "a marker on a panel with room to spare"
        );
    }
}
