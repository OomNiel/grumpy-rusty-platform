//! Wearable status bar: a label, a clock and a battery gauge.
//!
//! The three features are independent: the label is free text on the left, the clock can be shown or
//! hidden and is fed the same wall clock a `Clock` widget uses, and the battery gauge can be shown or
//! hidden. The clock and the battery can each be centred or right-aligned; two right-aligned items
//! are stacked along the right edge (clock first, battery at the far right), and two centred items
//! share the middle. One font scale applies to every feature, so a bar can be made legible on a
//! larger panel without a second design.
//!
//! The bar is a *display*: it holds the text it shows, and an app updates it at run time --
//! `GuiContext::set_status_bar_label` for the free-text label, `GuiContext::set_status_bar_time` for the
//! clock (the generated Designer module calls that one from the wall clock), and
//! `GuiContext::set_status_bar_battery` for the gauge. Battery percentage and charging state are ordinary
//! fields for an app that reads them.

use core::fmt;

use embedded_graphics_core::{
    draw_target::DrawTarget,
    pixelcolor::{Rgb565, WebColors},
};

#[cfg(not(feature = "std"))]
use crate::math::F32Ext as _;

use crate::{
    font::FontId,
    geometry::Rect,
    render::{Compositor, RenderCtx},
    round::UnobstructedArea,
    style::Border,
};

/// Errors produced during status bar operations.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusBarError {
    /// Render target failure.
    RenderError,
}

/// Battery charging state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum BatteryState {
    /// Discharging with percentage [0..100].
    #[default]
    Discharging,
    /// Actively charging with percentage [0..100].
    Charging,
    /// Fully charged (100%).
    Full,
}

/// Where the clock or the battery sits in the bar.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum StatusBarAlign {
    /// Centred in the bar; two centred features share the middle.
    #[default]
    Center,
    /// Along the right edge; two right-aligned features stack there (clock first, battery last).
    Right,
}

/// A small ASCII text field that stays `Copy`, because a context stores it in `WidgetKind`.
///
/// The bar needs its clock text to be replaceable at run time (the generated module sets it from the
/// wall clock), and the context copies widget kinds instead of holding references with a lifetime.
/// 24 bytes hold a label, a `HH:MM` clock and a `HH:MM:SS` one with room to spare.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct StatusBarText {
    bytes: [u8; 24],
    len: u8,
}

impl StatusBarText {
    pub const fn new() -> Self {
        Self {
            bytes: [0; 24],
            len: 0,
        }
    }

    /// A field holding `text`, truncated to what fits. Non-ASCII stops the copy: a truncated UTF-8
    /// character would make the field unprintable rather than shortened.
    pub fn from_str(text: &str) -> Self {
        let mut field = Self::new();
        field.set(text);
        field
    }

    /// The text, or an empty string if the bytes are not valid UTF-8 (never the case for `set`).
    pub fn as_str(&self) -> &str {
        core::str::from_utf8(&self.bytes[..self.len as usize]).unwrap_or("")
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Replaces the text, truncated to the field's capacity.
    pub fn set(&mut self, text: &str) {
        self.len = 0;
        for byte in text.bytes() {
            if !byte.is_ascii() || self.len as usize >= self.bytes.len() {
                break;
            }
            self.bytes[self.len as usize] = byte;
            self.len += 1;
        }
    }

    /// Writes a 24-hour `HH:MM` clock.
    pub fn set_time(&mut self, hour: u8, minute: u8) {
        let hour = hour.min(23);
        let minute = minute.min(59);
        self.len = 5;
        self.bytes[0] = b'0' + hour / 10;
        self.bytes[1] = b'0' + hour % 10;
        self.bytes[2] = b':';
        self.bytes[3] = b'0' + minute / 10;
        self.bytes[4] = b'0' + minute % 10;
    }
}

impl Default for StatusBarText {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for StatusBarText {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Everything about the bar a design can set, in the form the context stores.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StatusBarConfig {
    /// Free text on the left; empty draws nothing.
    pub label: StatusBarText,
    /// The clock's text, and what it shows until a wall clock is handed over.
    pub time: StatusBarText,
    pub show_clock: bool,
    pub clock_align: StatusBarAlign,
    pub show_battery: bool,
    pub battery_align: StatusBarAlign,
    /// Every feature's text and the battery gauge are drawn at this magnification (1.0 = the face).
    pub font_scale: f32,
    /// The three feature colours; `None` uses the style's text colour.
    pub label_color: Option<Rgb565>,
    pub clock_color: Option<Rgb565>,
    pub battery_color: Option<Rgb565>,
    /// The ADC pin the battery voltage is measured on, when the design named one.
    pub battery_pin: Option<u8>,
    /// What multiplies the pin's voltage to give the battery's: 2 for a divider that halves it.
    pub battery_scale: f32,
    /// The level the gauge shows, updated at run time from that pin.
    pub battery_percent: u8,
    /// Whether the battery is charging; a charging gauge is drawn green when no colour is set.
    pub battery_charging: bool,
}

impl Default for StatusBarConfig {
    fn default() -> Self {
        Self {
            label: StatusBarText::new(),
            time: StatusBarText::from_str("12:00"),
            show_clock: true,
            clock_align: StatusBarAlign::Center,
            show_battery: true,
            battery_align: StatusBarAlign::Right,
            font_scale: 1.0,
            label_color: None,
            clock_color: None,
            battery_color: None,
            battery_pin: None,
            battery_scale: 2.0,
            battery_percent: 85,
            battery_charging: false,
        }
    }
}

/// The status bar: one label, a clock and a battery gauge.
#[derive(Clone, Debug)]
pub struct StatusBarWidget {
    /// What the design asked for: text, features, alignment, scale and colours.
    pub config: StatusBarConfig,
    /// Battery level percentage [0..100].
    pub battery_percent: u8,
    /// Battery charging state.
    pub battery_state: BatteryState,
    /// Background color of the status bar.
    pub background_color: Rgb565,
    /// Colour the text falls back to when a feature names none.
    pub foreground_color: Rgb565,
    /// Optional bottom separator line colour.
    pub separator_color: Option<Rgb565>,
    /// Font the bar's own text is drawn in, before `config.font_scale`.
    pub font: FontId,
    /// Standard bar height in pixels (typically 18..24).
    pub height: u16,
    /// Visibility toggle.
    pub is_visible: bool,
}

impl Default for StatusBarWidget {
    fn default() -> Self {
        Self {
            config: StatusBarConfig::default(),
            battery_percent: 85,
            battery_state: BatteryState::Discharging,
            background_color: Rgb565::new(2, 4, 8),
            foreground_color: Rgb565::CSS_WHITE,
            separator_color: Some(Rgb565::new(6, 12, 18)),
            font: FontId::Tiny3x5,
            height: 20,
            is_visible: true,
        }
    }
}

impl StatusBarWidget {
    /// Creates a bar showing `time` with the default label, features and colours.
    pub fn new(time: &str) -> Self {
        let mut widget = Self::default();
        widget.config.time = StatusBarText::from_str(time);
        widget
    }

    /// Creates a bar from a design's configuration.
    pub fn configured(config: StatusBarConfig) -> Self {
        let battery_percent = config.battery_percent.min(100);
        let charging = config.battery_charging;
        Self {
            config,
            battery_percent,
            battery_state: if charging {
                BatteryState::Charging
            } else {
                BatteryState::Discharging
            },
            ..Self::default()
        }
    }

    /// Sets the clock text.
    pub fn set_time(&mut self, time_str: &str) {
        self.config.time.set(time_str);
    }

    /// Sets the free-text label on the bar's left edge.
    pub fn set_label(&mut self, label: &str) {
        self.config.label.set(label);
    }

    /// Updates battery metrics.
    pub fn set_battery(&mut self, percent: u8, state: BatteryState) {
        self.battery_percent = percent.min(100);
        self.battery_state = state;
    }

    /// The label it is showing, empty when it has none.
    pub fn label(&self) -> &str {
        self.config.label.as_str()
    }

    /// Applies the status bar bounds to an `UnobstructedArea`.
    pub fn apply_to_unobstructed_area(&self, area: &mut UnobstructedArea) {
        if self.is_visible && self.height > 0 {
            area.set_insets(self.height, 0, 0, 0);
        }
    }

    /// Renders the status bar inside the provided bounds.
    pub fn render<D, C>(
        &self,
        ctx: &mut RenderCtx<'_, D, C>,
        bounds: Rect,
    ) -> Result<(), StatusBarError>
    where
        D: DrawTarget<Color = Rgb565>,
        C: Compositor<D>,
    {
        if !self.is_visible || bounds.is_empty() {
            return Ok(());
        }

        ctx.fill_rect(bounds, self.background_color)
            .map_err(|_| StatusBarError::RenderError)?;
        if let Some(sep_color) = self.separator_color {
            ctx.fill_rect(
                Rect::new(bounds.x, bounds.bottom() - 1, bounds.w, 1),
                sep_color,
            )
            .map_err(|_| StatusBarError::RenderError)?;
        }

        let centre_y = bounds.y + (bounds.h as i32 / 2);
        let scale = self.config.font_scale.max(1.0);
        let line_height = (self.font.line_height() as f32 * scale).round() as i32;
        let top = centre_y - line_height / 2;
        let inset = (6.0 * scale).round().max(2.0) as i32;
        let gap = (4.0 * scale).round().max(2.0) as i32;
        let fallback = self.foreground_color;

        // The label owns the left edge; an empty one draws nothing at all.
        if !self.config.label.is_empty() {
            draw_scaled_text(
                ctx,
                bounds.x + inset,
                top,
                self.config.label.as_str(),
                self.font,
                self.config.label_color.unwrap_or(fallback),
                scale,
            )?;
        }

        let clock_on = self.config.show_clock && !self.config.time.is_empty();
        let clock_text = self.config.time.as_str();
        let clock_width = if clock_on {
            text_width(self.font, clock_text, scale)
        } else {
            0
        };
        let battery_on = self.config.show_battery;
        let battery_width = if battery_on {
            battery_extent(self.font, scale, self.battery_state)
        } else {
            0
        };

        // The right-aligned features share the right edge, clock first and battery last; the centred
        // ones share the middle the same way.
        let clock_right = clock_on && self.config.clock_align == StatusBarAlign::Right;
        let battery_right = battery_on && self.config.battery_align == StatusBarAlign::Right;
        let right_count = i32::from(clock_right) + i32::from(battery_right);
        if right_count > 0 {
            let total = (if clock_right { clock_width } else { 0 })
                + (if battery_right { battery_width } else { 0 })
                + gap * (right_count - 1);
            let mut cursor = bounds.right() - inset - total;
            if clock_right {
                draw_scaled_text(
                    ctx,
                    cursor,
                    top,
                    clock_text,
                    self.font,
                    self.config.clock_color.unwrap_or(fallback),
                    scale,
                )?;
                cursor += clock_width + gap;
            }
            if battery_right {
                draw_battery(
                    ctx,
                    cursor,
                    centre_y,
                    top,
                    self.font,
                    scale,
                    self.battery_percent,
                    self.battery_state,
                    self.config.battery_color.unwrap_or_else(|| {
                        if self.battery_percent <= 15 {
                            Rgb565::CSS_RED
                        } else if self.battery_state == BatteryState::Charging {
                            Rgb565::CSS_GREEN
                        } else {
                            fallback
                        }
                    }),
                )?;
            }
        }

        let clock_centre = clock_on && self.config.clock_align == StatusBarAlign::Center;
        let battery_centre = battery_on && self.config.battery_align == StatusBarAlign::Center;
        let centre_count = i32::from(clock_centre) + i32::from(battery_centre);
        if centre_count > 0 {
            let total = (if clock_centre { clock_width } else { 0 })
                + (if battery_centre { battery_width } else { 0 })
                + gap * (centre_count - 1);
            let mut cursor = bounds.x + (bounds.w as i32 - total) / 2;
            if clock_centre {
                draw_scaled_text(
                    ctx,
                    cursor,
                    top,
                    clock_text,
                    self.font,
                    self.config.clock_color.unwrap_or(fallback),
                    scale,
                )?;
                cursor += clock_width + gap;
            }
            if battery_centre {
                draw_battery(
                    ctx,
                    cursor,
                    centre_y,
                    top,
                    self.font,
                    scale,
                    self.battery_percent,
                    self.battery_state,
                    self.config.battery_color.unwrap_or_else(|| {
                        if self.battery_percent <= 15 {
                            Rgb565::CSS_RED
                        } else if self.battery_state == BatteryState::Charging {
                            Rgb565::CSS_GREEN
                        } else {
                            fallback
                        }
                    }),
                )?;
            }
        }

        Ok(())
    }
}

/// The pixels `text` occupies at `scale`, from the face's own advance.
fn text_width(font: FontId, text: &str, scale: f32) -> i32 {
    (text.chars().count() as f32 * font.advance() as f32 * scale).round() as i32
}

/// One text line with its left edge at `x` and its top at `y`, every glyph pixel magnified by `scale`.
///
/// The same rule the clock's date block uses: the face's glyph pixels are resampled rather than the
/// text fitted, so `1.5` is half again the font and never rounds to the next whole step.
fn draw_scaled_text<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    x: i32,
    y: i32,
    text: &str,
    font: FontId,
    colour: Rgb565,
    scale: f32,
) -> Result<(), StatusBarError>
where
    D: DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let base = super::clock::label_block(font, 1);
    let advance = font.advance() as i32;
    let mut pen = 0i32;
    for ch in text.chars() {
        let mut pixels: heapless::Vec<(i32, i32), 256> = heapless::Vec::new();
        crate::font::for_each_glyph_pixel(font, ch, &mut |dx, dy| {
            let _ = pixels.push((dx, dy));
        });
        for (dx, dy) in pixels {
            let x0 = pen + dx * base;
            let y0 = dy * base;
            let x1 = x0 + base;
            let y1 = y0 + base;
            let px0 = x + (x0 as f32 * scale).round() as i32;
            let py0 = y + (y0 as f32 * scale).round() as i32;
            let px1 = x + (x1 as f32 * scale).round() as i32;
            let py1 = y + (y1 as f32 * scale).round() as i32;
            ctx.fill_rect(
                Rect::new(
                    px0,
                    py0,
                    (px1 - px0).max(1) as u32,
                    (py1 - py0).max(1) as u32,
                ),
                colour,
            )
            .map_err(|_| StatusBarError::RenderError)?;
        }
        pen += advance;
    }
    Ok(())
}

/// The width a battery item takes: the gauge plus, when charging, the mark before it.
fn battery_extent(font: FontId, scale: f32, state: BatteryState) -> i32 {
    let shell = battery_shell_width(scale);
    if state == BatteryState::Charging {
        shell + (4.0 * scale).round().max(2.0) as i32 + text_width(font, "~", scale)
    } else {
        shell
    }
}

fn battery_shell_width(scale: f32) -> i32 {
    (16.0 * scale).round().max(6.0) as i32
}

/// The gauge: shell, terminal nipple, fill, and the charging mark when the board says it is charging.
fn draw_battery<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    x: i32,
    centre_y: i32,
    text_top: i32,
    font: FontId,
    scale: f32,
    percent: u8,
    state: BatteryState,
    colour: Rgb565,
) -> Result<(), StatusBarError>
where
    D: DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let gap = (4.0 * scale).round().max(2.0) as i32;
    let mut shell_x = x;
    if state == BatteryState::Charging {
        draw_scaled_text(ctx, x, text_top, "~", font, colour, scale)?;
        shell_x += text_width(font, "~", scale) + gap;
    }
    let width = battery_shell_width(scale) as u32;
    let height = (8.0 * scale).round().max(3.0) as u32;
    let top = centre_y - height as i32 / 2;
    ctx.stroke_rect(Rect::new(shell_x, top, width, height), Border::one(colour))
        .map_err(|_| StatusBarError::RenderError)?;
    let terminal_w = (2.0 * scale).round().max(1.0) as u32;
    let terminal_h = (4.0 * scale).round().max(1.0) as u32;
    ctx.fill_rect(
        Rect::new(
            shell_x + width as i32,
            top + (height as i32 - terminal_h as i32) / 2,
            terminal_w,
            terminal_h,
        ),
        colour,
    )
    .map_err(|_| StatusBarError::RenderError)?;
    let inset = (2.0 * scale).round().max(1.0) as u32;
    let inner_w = width.saturating_sub(2 * inset);
    let inner_h = height.saturating_sub(2 * inset);
    let fill = ((percent as u32 * inner_w) / 100).max(1).min(inner_w);
    ctx.fill_rect(
        Rect::new(
            shell_x + inset as i32,
            top + inset as i32,
            fill,
            inner_h.max(1),
        ),
        colour,
    )
    .map_err(|_| StatusBarError::RenderError)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_buffer::TestBuffer;
    use crate::widgets::{PropertyKey, PropertyValue};

    /// The bar rendered on its own, as `(pixels, width, height)`.
    fn render(bar: &StatusBarWidget, width: u32, height: u32) -> TestBuffer {
        let screen = Rect::new(0, 0, width, height);
        let mut buffer = TestBuffer::new(width, height);
        let mut ctx = RenderCtx::new(&mut buffer, screen);
        bar.render(&mut ctx, screen).unwrap();
        buffer
    }

    fn pixels_of(
        buffer: &TestBuffer,
        colour: Rgb565,
        width: u32,
        height: u32,
    ) -> (usize, i32, i32) {
        let mut count = 0;
        let mut min_x = i32::MAX;
        let mut max_x = i32::MIN;
        for y in 0..height as i32 {
            for x in 0..width as i32 {
                if buffer.pixel_at(x, y) == Some(colour) {
                    count += 1;
                    min_x = min_x.min(x);
                    max_x = max_x.max(x);
                }
            }
        }
        (count, min_x, max_x)
    }

    #[test]
    fn a_text_field_holds_ascii_only_and_times_are_two_digits() {
        let mut text = StatusBarText::from_str("HELLO");
        assert_eq!(text.as_str(), "HELLO");
        text.set_time(7, 5);
        assert_eq!(text.as_str(), "07:05");
        text.set_time(99, 99);
        assert_eq!(text.as_str(), "23:59");
        // A long label is truncated to the field, and a non-ASCII byte stops the copy rather than
        // leaving half a character in it.
        let long = StatusBarText::from_str("012345678901234567890123456789");
        assert_eq!(long.as_str().len(), 24);
        let mixed = StatusBarText::from_str("AB\u{00e9}CD");
        assert_eq!(mixed.as_str(), "AB");
    }

    #[test]
    fn the_three_features_are_independently_shown_and_coloured() {
        let mut bar = StatusBarWidget::new("09:41");
        bar.config.label = StatusBarText::from_str("WiFi");
        bar.config.label_color = Some(Rgb565::CSS_RED);
        bar.config.clock_color = Some(Rgb565::CSS_GREEN);
        bar.config.battery_color = Some(Rgb565::CSS_BLUE);
        let buffer = render(&bar, 240, 20);
        assert!(
            pixels_of(&buffer, Rgb565::CSS_RED, 240, 20).0 > 0,
            "the label is painted"
        );
        assert!(
            pixels_of(&buffer, Rgb565::CSS_GREEN, 240, 20).0 > 0,
            "the clock is painted"
        );
        assert!(
            pixels_of(&buffer, Rgb565::CSS_BLUE, 240, 20).0 > 0,
            "the battery is painted"
        );

        let mut bare = bar.clone();
        bare.config.show_clock = false;
        bare.config.show_battery = false;
        let buffer = render(&bare, 240, 20);
        assert_eq!(
            pixels_of(&buffer, Rgb565::CSS_GREEN, 240, 20).0,
            0,
            "clock switched off"
        );
        assert_eq!(
            pixels_of(&buffer, Rgb565::CSS_BLUE, 240, 20).0,
            0,
            "battery switched off"
        );
        assert!(
            pixels_of(&buffer, Rgb565::CSS_RED, 240, 20).0 > 0,
            "the label stays"
        );
    }

    #[test]
    fn right_aligned_features_stack_with_the_battery_at_the_edge() {
        let mut bar = StatusBarWidget::new("09:41");
        bar.config.clock_align = StatusBarAlign::Right;
        bar.config.battery_align = StatusBarAlign::Right;
        bar.config.clock_color = Some(Rgb565::CSS_RED);
        bar.config.battery_color = Some(Rgb565::CSS_BLUE);
        let buffer = render(&bar, 240, 20);
        let clock = pixels_of(&buffer, Rgb565::CSS_RED, 240, 20);
        let battery = pixels_of(&buffer, Rgb565::CSS_BLUE, 240, 20);
        assert!(
            clock.2 < battery.1,
            "the clock is left of the battery: clock ends {}, battery starts {}",
            clock.2,
            battery.1
        );
        assert!(
            battery.2 >= 230,
            "the battery ends near the right edge: {}",
            battery.2
        );

        // One right-aligned feature takes the edge on its own.
        let mut clock_only = bar.clone();
        clock_only.config.show_battery = false;
        let buffer = render(&clock_only, 240, 20);
        let clock = pixels_of(&buffer, Rgb565::CSS_RED, 240, 20);
        assert!(
            clock.2 >= 230,
            "a lone right-aligned clock sits at the edge: {}",
            clock.2
        );

        // Centred means the middle of the bar.
        let mut centred = bar.clone();
        centred.config.clock_align = StatusBarAlign::Center;
        centred.config.show_battery = false;
        let buffer = render(&centred, 240, 20);
        let clock = pixels_of(&buffer, Rgb565::CSS_RED, 240, 20);
        let middle = (clock.1 + clock.2) / 2;
        assert!((middle - 120).abs() <= 8, "the clock is centred: {middle}");
    }

    #[test]
    fn the_font_scale_magnifies_every_feature_and_the_gauge() {
        let mut bar = StatusBarWidget::new("09:41");
        bar.config.label = StatusBarText::from_str("WiFi");
        bar.config.label_color = Some(Rgb565::CSS_RED);
        bar.config.clock_color = Some(Rgb565::CSS_GREEN);
        bar.config.battery_color = Some(Rgb565::CSS_BLUE);
        let small = render(&bar, 320, 20);
        let small_clock = pixels_of(&small, Rgb565::CSS_GREEN, 320, 20);
        let small_battery = pixels_of(&small, Rgb565::CSS_BLUE, 320, 20);

        bar.config.font_scale = 1.5;
        let large = render(&bar, 320, 40);
        let large_clock = pixels_of(&large, Rgb565::CSS_GREEN, 320, 40);
        let large_battery = pixels_of(&large, Rgb565::CSS_BLUE, 320, 40);
        assert!(
            large_clock.0 > small_clock.0
                && large_clock.2 - large_clock.1 > small_clock.2 - small_clock.1,
            "the clock grows with the scale: {small_clock:?} -> {large_clock:?}"
        );
        assert!(
            large_battery.2 - large_battery.1 > small_battery.2 - small_battery.1,
            "the gauge grows with the scale: {small_battery:?} -> {large_battery:?}"
        );
    }

    #[test]
    fn battery_metrics_and_insets_are_kept() {
        let screen = Rect::new(0, 0, 240, 240);
        let mut bar = StatusBarWidget::new("09:41");
        bar.set_battery(72, BatteryState::Charging);
        let mut area = UnobstructedArea::new(screen);
        bar.apply_to_unobstructed_area(&mut area);
        assert_eq!(area.visible_rect(), Rect::new(0, 20, 240, 220));
        bar.is_visible = false;
        let mut hidden = UnobstructedArea::new(screen);
        bar.apply_to_unobstructed_area(&mut hidden);
        assert_eq!(hidden.visible_rect(), screen);
    }

    #[test]
    fn the_context_sets_the_battery_and_repaints_only_when_it_changes() {
        let mut ctx: crate::context::GuiContext<'_, 16, 8, 8> =
            crate::context::GuiContext::new(Rect::new(0, 0, 240, 20));
        let id = ctx
            .add_status_bar_configured(
                Rect::new(0, 0, 240, 20),
                StatusBarConfig::default(),
                crate::style::Style::panel(),
            )
            .unwrap();
        ctx.clear_dirty();
        ctx.set_status_bar_battery(id, 42, true).unwrap();
        assert_eq!(
            ctx.get_widget_property(id, PropertyKey::Value),
            Some(PropertyValue::Int(42))
        );
        assert_eq!(
            ctx.get_widget_property(id, PropertyKey::State),
            Some(PropertyValue::Bool(true))
        );
        assert!(!ctx.dirty_regions().is_empty(), "a new level is damage");
        ctx.clear_dirty();
        ctx.set_status_bar_battery(id, 42, true).unwrap();
        assert!(
            ctx.dirty_regions().is_empty(),
            "an unchanged level is not damage"
        );
        ctx.set_status_bar_battery(id, 255, false).unwrap();
        assert_eq!(
            ctx.get_widget_property(id, PropertyKey::Value),
            Some(PropertyValue::Int(100)),
            "the gauge clamps to 100"
        );
    }

    #[test]
    fn the_context_sets_the_clock_and_repaints_only_when_the_minute_changes() {
        let mut ctx: crate::context::GuiContext<'_, 16, 8, 8> =
            crate::context::GuiContext::new(Rect::new(0, 0, 240, 20));
        let id = ctx
            .add_status_bar_configured(
                Rect::new(0, 0, 240, 20),
                StatusBarConfig::default(),
                crate::style::Style::panel(),
            )
            .unwrap();
        ctx.clear_dirty();
        ctx.set_status_bar_time(id, 10, 42).unwrap();
        assert_eq!(
            ctx.get_widget_property(id, PropertyKey::Text),
            Some(PropertyValue::Str("10:42"))
        );
        assert!(!ctx.dirty_regions().is_empty(), "a new minute is damage");
        ctx.clear_dirty();
        ctx.set_status_bar_time(id, 10, 42).unwrap();
        assert!(
            ctx.dirty_regions().is_empty(),
            "an unchanged minute is not damage"
        );
    }

    #[test]
    fn the_context_sets_the_label_without_touching_the_clock() {
        // Asked for 2026-11-28: an app that knows something the design cannot -- the network it joined, the
        // mode it is in -- replaces the label on the bar's left edge. `PropertyKey::Text` is the *clock* on
        // this widget, so the label needs a setter of its own or the two texts would fight over one key.
        let mut ctx: crate::context::GuiContext<'_, 16, 8, 8> =
            crate::context::GuiContext::new(Rect::new(0, 0, 240, 20));
        let mut config = StatusBarConfig::default();
        config.label = StatusBarText::from_str("Design");
        config.time = StatusBarText::from_str("09:41");
        let id = ctx
            .add_status_bar_configured(
                Rect::new(0, 0, 240, 20),
                config,
                crate::style::Style::panel(),
            )
            .unwrap();
        ctx.clear_dirty();

        ctx.set_status_bar_label(id, "WiFi").unwrap();
        assert_eq!(ctx.status_bar_label(id), Some("WiFi"), "the label is replaced");
        assert_eq!(
            ctx.get_widget_property(id, PropertyKey::Text),
            Some(PropertyValue::Str("09:41")),
            "and the clock is untouched"
        );
        assert!(!ctx.dirty_regions().is_empty(), "a new label is damage");

        ctx.clear_dirty();
        ctx.set_status_bar_label(id, "WiFi").unwrap();
        assert!(
            ctx.dirty_regions().is_empty(),
            "the same label again is not damage"
        );

        // Copied into the bar's own field: a line built at run time costs nothing on the heap, and a label
        // longer than the field is truncated rather than refused.
        let mut built = [0u8; 32];
        let line = {
            built[..8].copy_from_slice(b"Net 1.2%");
            core::str::from_utf8(&built[..8]).unwrap()
        };
        ctx.set_status_bar_label(id, line).unwrap();
        assert_eq!(ctx.status_bar_label(id), Some("Net 1.2%"));
        let long = "abcdefghijklmnopqrstuvwxyz";
        ctx.set_status_bar_label(id, long).unwrap();
        assert_eq!(
            ctx.status_bar_label(id),
            Some(&long[..24]),
            "the field holds what fits"
        );

        // A widget that is not a status bar answers NotFound rather than silently doing nothing, and the
        // read-back tells "not a bar" apart from "a bar with no label".
        let label_id = ctx
            .add_label(Rect::new(0, 0, 40, 10), "x", crate::style::Style::label())
            .unwrap();
        assert!(ctx.set_status_bar_label(label_id, "no").is_err());
        assert_eq!(ctx.status_bar_label(label_id), None);
    }
}
