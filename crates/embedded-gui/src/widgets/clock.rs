//! A clock face: hour and minute ticks, hour numerals, three hands, and a date block.
//!
//! The date block sits under the pivot and above the six: the weekday, the month and year, and the
//! day number in a rounded box. All three lines share one face and one colour and have a relative size
//! each, magnified the same way the hour numerals are -- one block per glyph pixel, no fitting. The
//! date is part of the widget's own state, exactly like the time, because a clock on a board with an
//! RTC must roll it at midnight without the application drawing anything.
//!
//! Drawn the way [`ScaleWidget`](super::scale::ScaleWidget) draws its radial mode -- the same
//! centre, radius and angle convention -- because a clock *is* a radial scale whose needle the
//! caller moves: twelve fixed positions instead of a value between a minimum and a maximum, and
//! three needles rather than one.
//!
//! The angles here follow the gauge's: degrees, `y` increasing downwards, so `-90°` is twelve
//! o'clock. The hour hand sits *between* the numerals (`3:30` points halfway between 3 and 4) and
//! moves once a minute; the minute hand steps half a minute tick at a time, so it is on the mark for
//! the first half of the minute and halfway between marks for the second half; the second hand steps
//! a sixth of a turn per second, and is the only hand that moves on every tick.

use core::fmt::Write as _;

use embedded_graphics_core::pixelcolor::{Rgb565, RgbColor, WebColors};
use heapless::String;

#[cfg(not(feature = "std"))]
use crate::math::F32Ext as _;
use crate::{
    block::Block,
    font::{packed_font, Font as _, FontId},
    geometry::Rect,
    render::{Compositor, RenderCtx, StrokeCap, StrokeStyle},
    style::{Border, Style, VisualState, WidgetStyle},
};

/// Where twelve o'clock is, in the crate's angle convention (degrees, `y` down).
const TWELVE_OCLOCK: f32 = -90.0;

/// One hour of a hand's travel, in degrees.
const HOUR_STEP: f32 = 30.0;

/// One minute of the minute or second hand's travel, in degrees.
const MINUTE_STEP: f32 = 6.0;

/// The calendar names the date block draws, in the order of their index.
const WEEKDAY_NAMES: [&str; 7] = [
    "SUNDAY",
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
];
const MONTH_NAMES: [&str; 12] = [
    "JANUARY",
    "FEBRUARY",
    "MARCH",
    "APRIL",
    "MAY",
    "JUNE",
    "JULY",
    "AUGUST",
    "SEPTEMBER",
    "OCTOBER",
    "NOVEMBER",
    "DECEMBER",
];

/// A clock face showing `hour:minute:second`.
///
/// Every colour is a field because each is the design's to choose: three hands, the ticks of two
/// lengths, and the numerals. The numerals' face comes from the widget's style (`style.font`), their
/// size from [`Self::label_scale`], which magnifies every glyph pixel -- the built-in faces are fixed
/// bitmaps, so a scale is the only honest way to offer a size that is independent of the face.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ClockWidget {
    /// 0-23. Twelve-hour positions are derived; the value is stored as it is given.
    pub hour: u8,
    /// 0-59.
    pub minute: u8,
    /// 0-59.
    pub second: u8,
    /// The calendar year the date block shows, four digits.
    pub year: u16,
    /// 1-12.
    pub month: u8,
    /// 1-31, clamped to the month's own length when it is set.
    pub day: u8,
    pub hour_color: Rgb565,
    pub minute_color: Rgb565,
    pub second_color: Rgb565,
    /// The twelve long ticks.
    pub hour_tick_color: Rgb565,
    /// The forty-eight short ones between them.
    pub minute_tick_color: Rgb565,
    /// The colour the hour numerals are drawn in.
    pub label_color: Rgb565,
    /// How many pixels each glyph pixel of the numerals covers: `1` is the font's own size.
    pub label_scale: u8,
    /// How far the numerals sit *inside* the ring the hour ticks occupy, in character widths of the
    /// numerals' own face.
    ///
    /// A design sets it in tenths of a character (`0.5` is half a character); the shift is applied to the
    /// face on the glass, so a bigger `label_scale` moves the numerals proportionally. `0.0` puts them back
    /// where they sat before 2026-10-21.
    pub label_inset: f32,
    pub show_labels: bool,
    /// The shared face of the three date lines. `None` uses the widget's own style font.
    pub date_font: Option<FontId>,
    /// The colour all three date lines are drawn in.
    pub date_color: Rgb565,
    /// How many times the weekday's own glyph pixels are drawn: `1` is the font's size and `1.5` is
    /// half again as large.
    pub weekday_scale: f32,
    /// How many times the month and year's own glyph pixels are drawn.
    pub month_scale: f32,
    /// How many times the day number's own glyph pixels are drawn.
    pub day_scale: f32,
    /// Moves the whole date block up (positive) or down (negative), in pixels.
    ///
    /// This is the date block's own counterpart to [`Self::label_inset`]: a design nudges the three
    /// lines without changing their size, and a negative value pushes them towards, or past, the six.
    pub date_offset: i16,
    pub show_weekday: bool,
    pub show_month: bool,
    /// Whether the rounded day box (and the day number inside it) is drawn.
    pub show_date: bool,
    /// The box's fill; `date_box_opacity` is how solid it is (0 is transparent).
    pub date_box_fill: Rgb565,
    pub date_box_border: Rgb565,
    /// 0-8 pixels, drawn inside the box's edge.
    pub date_box_border_width: u8,
    /// The box's corner radius in pixels, scaled with the block.
    pub date_box_radius: u8,
    /// 0-255; 0 leaves the box's interior transparent, 255 is a solid fill.
    pub date_box_opacity: u8,
}

impl ClockWidget {
    /// A face showing `hour:minute:second`, in colours that read on a dark panel.
    ///
    /// The defaults are this fork's, not a theme's: the hands are white, white and red so they can be
    /// told apart at a glance, and the ticks are two greys so the hour marks stand out from the
    /// minute marks without a second colour to pick.
    pub const fn new(hour: u8, minute: u8, second: u8) -> Self {
        Self {
            hour,
            minute,
            second,
            // The same neutral day the chip RTCs count from, so a face with no date set says 2000
            // rather than pretending to know today.
            year: 2000,
            month: 1,
            day: 1,
            hour_color: Rgb565::WHITE,
            minute_color: Rgb565::WHITE,
            second_color: Rgb565::CSS_RED,
            hour_tick_color: Rgb565::CSS_GRAY,
            minute_tick_color: Rgb565::new(10, 20, 10),
            label_color: Rgb565::WHITE,
            label_scale: 1,
            label_inset: 0.5,
            show_labels: true,
            date_font: None,
            date_color: Rgb565::WHITE,
            weekday_scale: 1.0,
            month_scale: 1.0,
            day_scale: 1.0,
            date_offset: 0,
            show_weekday: true,
            show_month: true,
            show_date: true,
            date_box_fill: Rgb565::BLACK,
            date_box_border: Rgb565::WHITE,
            date_box_border_width: 1,
            date_box_radius: 4,
            date_box_opacity: 255,
        }
    }

    /// The same face showing another time, with each field clamped to its range.
    pub fn with_time(&self, hour: u8, minute: u8, second: u8) -> Self {
        Self {
            hour: hour.min(23),
            minute: minute.min(59),
            second: second.min(59),
            ..*self
        }
    }

    /// The same face showing another date, with each field clamped to its range.
    pub fn with_date(&self, year: u16, month: u8, day: u8) -> Self {
        let month = month.clamp(1, 12);
        Self {
            year: year.clamp(2000, 9999),
            month,
            day: day.clamp(1, days_in_month(year, month)),
            ..*self
        }
    }

    /// The same face showing another date and time, with each field clamped to its range.
    pub fn with_datetime(
        &self,
        year: u16,
        month: u8,
        day: u8,
        hour: u8,
        minute: u8,
        second: u8,
    ) -> Self {
        self.with_date(year, month, day)
            .with_time(hour, minute, second)
    }

    /// The weekday the face's date falls on: `0` is Sunday, `6` is Saturday.
    pub fn weekday(&self) -> u8 {
        weekday(self.year, self.month, self.day)
    }

    /// One second later, carrying into the minutes, the hours and the calendar.
    ///
    /// The date is part of the time now, so midnight rolls the day, the month and the year with it --
    /// a running clock with a date block must not sit on 31 December for ever.
    pub fn next_datetime(
        year: u16,
        month: u8,
        day: u8,
        hour: u8,
        minute: u8,
        second: u8,
    ) -> (u16, u8, u8, u8, u8, u8) {
        let (hour, minute, second) = Self::next_second(hour, minute, second);
        let (year, month, day) = if hour == 0 && minute == 0 && second == 0 {
            next_day(year, month, day)
        } else {
            (year, month, day)
        };
        (year, month, day, hour, minute, second)
    }

    /// The time one second later, carrying into the minutes and the hours and wrapping at midnight.
    ///
    /// Pure on purpose: this is the whole of a clock's arithmetic, so it can be tested without a
    /// framebuffer -- and the movement an app attaches to the widget is then just "call this once a
    /// second".
    pub fn next_second(hour: u8, minute: u8, second: u8) -> (u8, u8, u8) {
        let second = second + 1;
        if second < 60 {
            return (hour, minute, second);
        }
        let minute = minute + 1;
        if minute < 60 {
            return (hour, minute, 0);
        }
        // Midnight rolls to zero: a clock has no 24, and a movement must not stall at one.
        (if hour >= 23 { 0 } else { hour + 1 }, 0, 0)
    }

    /// The angle of a hand, in degrees, with `-90` at twelve o'clock.
    fn hand_angle(&self, value: f32, step: f32) -> f32 {
        TWELVE_OCLOCK + value * step
    }

    /// The face's three hands as it draws them: `(angle, length as a share of the radius, width)`.
    ///
    /// Neither of the two slow hands creeps. The hour hand takes its place from the minutes only, so
    /// it moves once a minute; the minute hand takes *half* a minute tick, so it is on the mark for
    /// the first half of the minute and halfway between marks for the second half, and moves twice a
    /// minute. Only the second hand steps every second.
    ///
    /// Reported 2026-10-17: "The minute hand must only redraw when sufficient time has passed so that
    /// the hand have passed more than half of the time between minute ticks. So the minute hand
    /// updates basically once every 30 seconds. The hour hand can update every minute." On the glass
    /// a creeping hand and a stepping one look the same at a glance, and the stepping one costs the
    /// panel a repaint of the minute hand twice a minute instead of sixty times.
    fn hand_spec(&self) -> [(f32, f32, u8); 3] {
        let hour_value = (self.hour % 12) as f32 + self.minute as f32 / 60.0;
        let minute_value = self.minute as f32 + if self.second >= 30 { 0.5 } else { 0.0 };
        [
            (self.hand_angle(hour_value, HOUR_STEP), 0.50f32, 3u8),
            (self.hand_angle(minute_value, MINUTE_STEP), 0.72f32, 2u8),
            (
                self.hand_angle(self.second as f32, MINUTE_STEP),
                0.88f32,
                1u8,
            ),
        ]
    }

    pub fn render<D, C>(
        &self,
        ctx: &mut RenderCtx<'_, D, C>,
        rect: Rect,
        style: WidgetStyle,
        state: VisualState,
    ) -> Result<(), D::Error>
    where
        D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
        C: Compositor<D>,
    {
        let resolved = style.resolve(state);
        Block::styled(resolved).render(rect, ctx)?;
        let inner = Block::styled(resolved).inner(rect);
        let cx = inner.x + (inner.w as i32 / 2);
        let cy = inner.y + (inner.h as i32 / 2);
        let radius = (inner.w.min(inner.h) / 2).saturating_sub(4);
        // Below this there is no room for a tick, never mind a hand.
        if radius < 12 {
            return Ok(());
        }

        self.draw_ticks(ctx, cx, cy, radius)?;
        if self.show_labels {
            self.draw_labels(ctx, cx, cy, radius, resolved)?;
        }
        self.draw_hands(ctx, cx, cy, radius)?;
        // The date block is drawn last: it overdraws the hands, which is what the design asked for.
        if let Some(block) = self.date_block(rect, resolved) {
            block.render(ctx, self, resolved)?;
        }
        Ok(())
    }

    /// A tick from `radius` inwards by `length`.
    fn tick<D, C>(
        ctx: &mut RenderCtx<'_, D, C>,
        cx: i32,
        cy: i32,
        radius: u32,
        angle: f32,
        length: u32,
        width: u8,
        colour: Rgb565,
    ) -> Result<(), D::Error>
    where
        D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
        C: Compositor<D>,
    {
        let radians = angle.to_radians();
        let outer = radius as f32;
        let inner_r = radius.saturating_sub(length) as f32;
        ctx.draw_line_styled(
            cx + (inner_r * radians.cos()) as i32,
            cy + (inner_r * radians.sin()) as i32,
            cx + (outer * radians.cos()) as i32,
            cy + (outer * radians.sin()) as i32,
            StrokeStyle::new(colour).with_width(width),
        )
    }

    fn draw_ticks<D, C>(
        &self,
        ctx: &mut RenderCtx<'_, D, C>,
        cx: i32,
        cy: i32,
        radius: u32,
    ) -> Result<(), D::Error>
    where
        D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
        C: Compositor<D>,
    {
        // The minutes first: an hour mark is drawn over the one it shares a position with, so the
        // long tick is never half-hidden behind a short one.
        for minute in 0..60u32 {
            if minute % 5 == 0 {
                continue;
            }
            Self::tick(
                ctx,
                cx,
                cy,
                radius,
                TWELVE_OCLOCK + minute as f32 * MINUTE_STEP,
                4u32,
                1u8,
                self.minute_tick_color,
            )?;
        }
        for hour in 0..12u32 {
            Self::tick(
                ctx,
                cx,
                cy,
                radius,
                TWELVE_OCLOCK + hour as f32 * HOUR_STEP,
                8u32,
                2u8,
                self.hour_tick_color,
            )?;
        }
        Ok(())
    }

    fn draw_labels<D, C>(
        &self,
        ctx: &mut RenderCtx<'_, D, C>,
        cx: i32,
        cy: i32,
        radius: u32,
        style: Style,
    ) -> Result<(), D::Error>
    where
        D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
        C: Compositor<D>,
    {
        if radius <= 24 {
            // The numerals would eat the face: a tick and a hand need what is left.
            return Ok(());
        }
        let scale = self.label_scale.max(1) as u32;
        // How far in the numerals sit is the design's `label_inset`, in character widths of the face on the
        // glass: `0.5` is half a character, `0` puts them back on the old ring. The advance is the label's
        // own at its magnification, so a larger `Number size` moves proportionally.
        let advance = style.font.advance() as f32 * scale as f32;
        let inward = (advance * self.label_inset).max(0.0).round() as u32;
        let inset = radius.saturating_sub(16 + inward);
        for hour in 1..=12u32 {
            // 12 is at the top, which is `hour 12`'s own angle: twelve steps of thirty from -90.
            let radians = (TWELVE_OCLOCK + hour as f32 * HOUR_STEP).to_radians();
            let lx = cx + ((inset as f32) * radians.cos()) as i32;
            let ly = cy + ((inset as f32) * radians.sin()) as i32;
            let mut label: String<3> = String::new();
            let _ = write!(&mut label, "{}", hour);
            draw_scaled_text(
                ctx,
                lx,
                ly,
                label.as_str(),
                style.font,
                self.label_color,
                scale,
            )?;
        }
        Ok(())
    }

    /// The face the date block wears: the design's own date font, or the widget's style font.
    fn date_face(&self, style: Style) -> FontId {
        self.date_font.unwrap_or(style.font)
    }

    /// The pixels the date block covers, if anything of it is shown.
    ///
    /// This is what a date change has to repaint. The block is drawn after the hands, so it owns the
    /// pixels it covers; a new day only needs its own three lines and the box -- not the face.
    pub fn date_rect(&self, rect: Rect, style: Style) -> Option<Rect> {
        let block = self.date_block(rect, style)?;
        let mut region: Option<Rect> = None;
        let mut include = |part: Rect| {
            let part = part.intersection(rect);
            if part.is_empty() {
                return;
            }
            region = Some(match region {
                None => part,
                Some(so_far) => so_far.union(part),
            });
        };
        if let Some(line) = &block.weekday {
            include(line.rect(block.cx, block.weekday_top));
        }
        if let Some(line) = &block.month {
            include(line.rect(block.cx, block.month_top));
        }
        if block.day.is_some() {
            include(block.box_rect);
        }
        region
    }

    /// The three date lines and the day box, laid out inside the face.
    ///
    /// The block is anchored to the bottom of the dial: the day box sits directly above the six o'clock
    /// numeral (or above the six o'clock tick when the numerals are off), the weekday above it, and the
    /// month and year above those. The gaps are half the height of the line above them, every line is
    /// centred on the hands' pivot, and `date_offset` moves the whole stack up or down by pixels.
    fn date_block(&self, rect: Rect, style: Style) -> Option<DateBlock> {
        if !self.show_weekday && !self.show_month && !self.show_date {
            return None;
        }
        let inner = Block::styled(style).inner(rect);
        let cx = inner.x + (inner.w as i32 / 2);
        let cy = inner.y + (inner.h as i32 / 2);
        let radius = (inner.w.min(inner.h) / 2).saturating_sub(4);
        if radius < 24 {
            return None;
        }
        let font = self.date_face(style);
        // What the six o'clock numeral occupies decides where the block begins. With the numerals off the
        // six o'clock tick's inner end is the same landmark.
        let labels = self.show_labels && radius > 24;
        let bottom = if labels {
            let scale = self.label_scale.max(1) as u32;
            let advance = style.font.advance() as f32 * scale as f32;
            let inward = (advance * self.label_inset).max(0.0).round() as u32;
            let inset = radius.saturating_sub(16 + inward) as i32;
            let numeral = label_ink_box(style.font, 1, scale).1;
            cy + inset - numeral / 2 - 2
        } else {
            cy + radius as i32 - 8 - 2
        };
        if bottom <= cy + 2 {
            return None;
        }

        let weekday_text = weekday_name(self.weekday());
        let mut month_text: String<16> = String::new();
        let _ = write!(&mut month_text, "{} {}", month_name(self.month), self.year);
        let mut day_text: String<16> = String::new();
        let _ = write!(&mut day_text, "{}", self.day);
        // The design's own sizes, each glyph pixel magnified by the number given -- the same rule the
        // hour numerals follow. Deliberately no fit to the control: a size of two is twice the font
        // whatever the cell measures, which is what makes the date text predictable. A fractional size
        // resamples the glyph bitmap: `1.5` covers alternate glyph pixels with one and two rows of the
        // panel, so the line is half again as large rather than rounded to the next whole step.
        let weekday_scale = self.weekday_scale.max(1.0);
        let month_scale = self.month_scale.max(1.0);
        let day_scale = self.day_scale.max(1.0);

        let weekday = self
            .show_weekday
            .then(|| DateLine::new(font, weekday_text, weekday_scale));
        let month = self
            .show_month
            .then(|| DateLine::new(font, &month_text, month_scale));
        let day = self
            .show_date
            .then(|| DateLine::new(font, &day_text, day_scale));

        // From the bottom up: box, then the weekday above it, then the month and year above that.
        let day_line = day.as_ref();
        // One glyph pixel of air between the ink and the border's inner edge, plus the border itself:
        // without it a scaled-up digit paints over the frame.
        let border_px = (f32::from(self.date_box_border_width) * day_scale).round() as i32;
        let pad = if self.show_date {
            (border_px + glyph_pixel(font, day_scale)).max(2)
        } else {
            0
        };
        let box_h = day_line.map_or(0, |line| line.height) + 2 * pad;
        let box_w = if self.show_date {
            // Two digits' worth: a clock turning over from the 9th to the 10th must not grow it.
            measure_ink(font, "88", day_scale).0 + 2 * pad
        } else {
            0
        };
        // Positive moves the block up, negative down; the whole stack moves together.
        let shift = i32::from(self.date_offset);
        let box_rect = Rect::new(
            cx - box_w / 2,
            bottom - box_h - shift,
            box_w.max(1) as u32,
            box_h.max(1) as u32,
        );
        let mut cursor = box_rect.y;
        let weekday_top = match &weekday {
            Some(line) => {
                let top = cursor - line.height / 2 - line.height;
                cursor = top;
                top
            }
            None => cursor,
        };
        let month_top = match &month {
            Some(line) => cursor - line.height / 2 - line.height,
            None => cursor,
        };
        let box_radius = ((f32::from(self.date_box_radius) * day_scale).round() as u32)
            .min(box_rect.w.min(box_rect.h) / 2) as u8;
        Some(DateBlock {
            weekday,
            weekday_top,
            month,
            month_top,
            day,
            box_rect,
            box_radius,
            // A border is a design pixel at scale one, and grows with the number it surrounds.
            border_width: (f32::from(self.date_box_border_width) * day_scale)
                .round()
                .clamp(0.0, 255.0) as u8,
            cx,
        })
    }

    /// The pixels this face's hands cover, at the size and style it is drawn with.
    ///
    /// The ticks and the numerals never move, so a second on the clock only has anything to repaint
    /// where a hand is -- or was. The damage for a time change is the union of the hands before and
    /// after it (see `GuiContext::set_clock_time`), which is what makes a running clock cost a few
    /// hundred pixels a second instead of a whole face of ticks and numerals.
    ///
    /// A hand is a line from the centre outwards with a round cap, so its box is the two endpoints
    /// grown by half the stroke and a pixel for the cap.
    pub fn hands_rect(&self, rect: Rect, style: Style) -> Rect {
        let Some(hands) = self.hand_boxes(rect, style) else {
            // Nothing is drawn on a face this small, so the whole cell is what "nothing changed"
            // looks like to a caller.
            return rect;
        };
        // Inside the face only: a hand that would reach past it is clipped when it is drawn, so
        // damaging the frame or the widget next door would repaint pixels nothing changed.
        hands
            .iter()
            .fold(None::<Rect>, |so_far, (_, hand)| {
                Some(match so_far {
                    None => *hand,
                    Some(so_far) => so_far.union(*hand),
                })
            })
            .map_or(rect, |all| all.intersection(rect))
    }

    /// The pixels a move from this time to `next` has to repaint: **only the hands that moved**.
    ///
    /// The second hand moves every second and drags its own box in with it; the hour hand moves once
    /// a minute and the minute hand twice, so most of a minute's ticks damage the second hand alone.
    /// Unioning all three hands, as a whole-face clock needs to, would repaint the long minute hand
    /// sixty times a minute for fifty-eight ticks where it has not moved at all.
    ///
    /// `None` means the hands are where they were, so there is nothing to repaint.
    pub fn hand_damage_rect(&self, next: &Self, rect: Rect, style: Style) -> Option<Rect> {
        let (Some(here), Some(then)) = (self.hand_boxes(rect, style), next.hand_boxes(rect, style))
        else {
            // A face too small to draw hands on: keep the caller's answer safe rather than clever.
            return Some(rect);
        };
        let mut damage: Option<Rect> = None;
        for (index, (angle, now)) in here.iter().enumerate() {
            let (next_angle, later) = then[index];
            if (angle - next_angle).abs() < f32::EPSILON {
                continue;
            }
            // Where the hand was and where it is going: both, or the old one is left on the glass.
            let moved = now.union(later);
            damage = Some(match damage {
                None => moved,
                Some(so_far) => so_far.union(moved),
            });
        }
        damage
            .map(|hands| hands.intersection(rect))
            .filter(|hands| !hands.is_empty())
    }

    /// The box of each hand, paired with its angle, in the order the face draws them.
    ///
    /// `None` for a face too small to draw any: below twelve pixels of radius there is no hand at
    /// all (`render` returns before drawing), so there is no geometry to answer with.
    fn hand_boxes(&self, rect: Rect, style: Style) -> Option<[(f32, Rect); 3]> {
        let inner = Block::styled(style).inner(rect);
        let cx = inner.x + (inner.w as i32 / 2);
        let cy = inner.y + (inner.h as i32 / 2);
        let radius = (inner.w.min(inner.h) / 2).saturating_sub(4);
        if radius < 12 {
            return None;
        }
        let mut boxes: [(f32, Rect); 3] = [(0.0, rect); 3];
        for (slot, (angle, fraction, width)) in self.hand_spec().into_iter().enumerate() {
            let radians = angle.to_radians();
            let length = radius as f32 * fraction;
            let tip_x = cx + (length * radians.cos()) as i32;
            let tip_y = cy + (length * radians.sin()) as i32;
            // A line from the centre outwards with a round cap: two endpoints grown by half the
            // stroke and a pixel for the cap.
            let pad = width as i32 / 2 + 1;
            let box_x = cx.min(tip_x) - pad;
            let box_y = cy.min(tip_y) - pad;
            let box_w = (cx.max(tip_x) + pad - box_x + 1) as u32;
            let box_h = (cy.max(tip_y) + pad - box_y + 1) as u32;
            boxes[slot] = (angle, Rect::new(box_x, box_y, box_w, box_h));
        }
        Some(boxes)
    }

    fn draw_hands<D, C>(
        &self,
        ctx: &mut RenderCtx<'_, D, C>,
        cx: i32,
        cy: i32,
        radius: u32,
    ) -> Result<(), D::Error>
    where
        D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
        C: Compositor<D>,
    {
        // The angles are `hand_spec`'s, which is what the damage is measured from: a hand drawn from
        // one set of angles and damaged from another would leave a smear of its old positions.
        for ((angle, fraction, width), colour) in self.hand_spec().into_iter().zip([
            self.hour_color,
            self.minute_color,
            self.second_color,
        ]) {
            let radians = angle.to_radians();
            let length = radius as f32 * fraction;
            ctx.draw_line_styled(
                cx,
                cy,
                cx + (length * radians.cos()) as i32,
                cy + (length * radians.sin()) as i32,
                StrokeStyle::new(colour)
                    .with_width(width)
                    .with_cap(StrokeCap::Round),
            )?;
        }
        ctx.fill_circle(cx, cy, 3, self.hour_color)
    }
}

/// One measured line of the date block: its text, its face, the scale it is drawn at, and its ink.
struct DateLine {
    text: String<16>,
    font: FontId,
    /// The design's own size: `1.0` is the face's pixels, `1.5` half again as large.
    scale: f32,
    /// The ink's size in pixels.
    width: i32,
    height: i32,
    /// The ink's origin inside the first glyph's cell, in pixels at scale one.
    ink_x: i32,
    ink_y: i32,
}

impl DateLine {
    fn new(font: FontId, text: &str, scale: f32) -> Self {
        let scale = scale.max(1.0);
        let (width, height, ink_x, ink_y) = measure_ink(font, text, scale);
        let mut line: String<16> = String::new();
        let _ = line.push_str(text);
        Self {
            text: line,
            font,
            scale,
            width,
            height,
            ink_x,
            ink_y,
        }
    }

    /// The box this line's ink occupies when its left edge is centred on `cx` and its ink above `top`.
    fn rect(&self, cx: i32, top: i32) -> Rect {
        Rect::new(
            cx - self.width / 2,
            top,
            self.width.max(1) as u32,
            self.height.max(1) as u32,
        )
    }
}

/// The date block as it is laid out on one face: three measured lines and the day box.
struct DateBlock {
    weekday: Option<DateLine>,
    weekday_top: i32,
    month: Option<DateLine>,
    month_top: i32,
    day: Option<DateLine>,
    box_rect: Rect,
    box_radius: u8,
    border_width: u8,
    /// The pivot's x, which every line is centred on.
    cx: i32,
}

impl DateBlock {
    fn render<D, C>(
        &self,
        ctx: &mut RenderCtx<'_, D, C>,
        clock: &ClockWidget,
        _style: Style,
    ) -> Result<(), D::Error>
    where
        D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
        C: Compositor<D>,
    {
        if let Some(day) = &self.day {
            if clock.date_box_opacity > 0 {
                ctx.fill_rounded_rect_alpha(
                    self.box_rect,
                    self.box_radius,
                    clock.date_box_fill,
                    clock.date_box_opacity,
                )?;
            }
            if self.border_width > 0 {
                ctx.stroke_rounded_rect(
                    self.box_rect,
                    self.box_radius,
                    Border {
                        color: clock.date_box_border,
                        width: self.border_width,
                    },
                )?;
            }
            // The day is centred in its box, ink and all.
            let top = self.box_rect.y + (self.box_rect.h as i32 - day.height) / 2;
            draw_ink_line(
                ctx,
                day,
                clock.date_color,
                self.box_rect.x + self.box_rect.w as i32 / 2,
                top,
            )?;
        }
        if let Some(month) = &self.month {
            draw_ink_line(ctx, month, clock.date_color, self.cx, self.month_top)?;
        }
        if let Some(weekday) = &self.weekday {
            draw_ink_line(ctx, weekday, clock.date_color, self.cx, self.weekday_top)?;
        }
        Ok(())
    }
}

/// How many pixels one glyph pixel of `font` covers at `scale`, rounded to whole pixels.
fn glyph_pixel(font: FontId, scale: f32) -> i32 {
    (label_block(font, 1) as f32 * scale.max(1.0))
        .round()
        .max(1.0) as i32
}

/// How many pixels the ink of `text` occupies at `scale`, and where it starts in its cell.
///
/// `label_ink_box` measures a digit's cell, which is right for the numerals and wrong for a word:
/// `MONDAY` has a different ink from `18`. This walks the real glyph pixels of the face, so a line
/// is centred on what it paints rather than on an advance that includes the gaps between letters.
/// The scale may be fractional: both edges are rounded once, so a line at `1.5` is exactly as wide
/// as the pixels it paints.
fn measure_ink(font: FontId, text: &str, scale: f32) -> (i32, i32, i32, i32) {
    let scale = scale.max(1.0);
    let block = label_block(font, 1);
    let advance = font.advance() as i32;
    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    let mut max_x = i32::MIN;
    let mut max_y = i32::MIN;
    let mut pen = 0i32;
    for ch in text.chars() {
        crate::font::for_each_glyph_pixel(font, ch, &mut |dx, dy| {
            let x = pen + dx * block;
            let y = dy * block;
            min_x = min_x.min(x);
            max_x = max_x.max(x + block);
            min_y = min_y.min(y);
            max_y = max_y.max(y + block);
        });
        pen += advance;
    }
    if min_x >= max_x {
        // Nothing painted -- a space alone: give it the width it occupies and no height.
        let width = (advance * text.chars().count() as i32) as f32 * scale;
        return (width.round() as i32, 0, 0, 0);
    }
    (
        ((max_x - min_x) as f32 * scale).round() as i32,
        ((max_y - min_y) as f32 * scale).round() as i32,
        min_x,
        min_y,
    )
}

/// Draws one measured line with its ink's left edge on `centre_x` and its top ink row at `ink_top`.
fn draw_ink_line<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    line: &DateLine,
    colour: Rgb565,
    centre_x: i32,
    ink_top: i32,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let block = label_block(line.font, 1);
    let advance = line.font.advance() as i32;
    let scale = line.scale.max(1.0);
    let left = centre_x - line.width / 2;
    let mut pen = 0i32;
    for ch in line.text.chars() {
        let mut pixels: heapless::Vec<(i32, i32), 256> = heapless::Vec::new();
        crate::font::for_each_glyph_pixel(line.font, ch, &mut |dx, dy| {
            let _ = pixels.push((dx, dy));
        });
        for (dx, dy) in pixels {
            // One glyph pixel spans `block` pixels of the face; both edges are scaled and rounded
            // separately, so a fractional scale tiles the glyph exactly with no seams and no overlap.
            let x0 = pen + dx * block - line.ink_x;
            let y0 = dy * block - line.ink_y;
            let x1 = x0 + block;
            let y1 = y0 + block;
            let px0 = left + (x0 as f32 * scale).round() as i32;
            let py0 = ink_top + (y0 as f32 * scale).round() as i32;
            let px1 = left + (x1 as f32 * scale).round() as i32;
            let py1 = ink_top + (y1 as f32 * scale).round() as i32;
            ctx.fill_rect(
                Rect::new(
                    px0,
                    py0,
                    (px1 - px0).max(1) as u32,
                    (py1 - py0).max(1) as u32,
                ),
                colour,
            )?;
        }
        pen += advance;
    }
    Ok(())
}

/// The weekday's full name, as the date block prints it.
fn weekday_name(weekday: u8) -> &'static str {
    WEEKDAY_NAMES[(weekday as usize).min(6)]
}

/// The month's full name, as the date block prints it.
fn month_name(month: u8) -> &'static str {
    MONTH_NAMES[(month.clamp(1, 12) - 1) as usize]
}

/// Whether `year` is a leap year in the Gregorian calendar.
pub fn is_leap_year(year: u16) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

/// The number of days in `month` of `year`; `0` for a month outside 1..=12.
pub fn days_in_month(year: u16, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// The day after `(year, month, day)`, carrying into the month and the year.
fn next_day(year: u16, month: u8, day: u8) -> (u16, u8, u8) {
    let month = month.clamp(1, 12);
    let day = day.max(1);
    if day < days_in_month(year, month) {
        (year, month, day + 1)
    } else if month < 12 {
        (year, month + 1, 1)
    } else if year < 9999 {
        (year + 1, 1, 1)
    } else {
        // The end of the four-digit calendar: a clock may not roll into a year it cannot print.
        (9999, 12, 31)
    }
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's `days_from_civil`).
///
/// Integer arithmetic only, `no_std`, and `div_euclid` keeps dates before the epoch correct too.
pub fn days_from_civil(year: i64, month: u8, day: u8) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let month = if month > 2 {
        i64::from(month) - 3
    } else {
        i64::from(month) + 9
    };
    let doy = (153 * month + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The civil date `days` days after 1970-01-01 (Howard Hinnant's `civil_from_days`).
pub fn civil_from_days(days: i64) -> (u16, u8, u8) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 157_908) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let month_day = (5 * doy + 2) / 153;
    let day = (doy - (153 * month_day + 2) / 5 + 1) as u8;
    let month = if month_day < 10 {
        month_day + 3
    } else {
        month_day - 9
    } as u8;
    if month <= 2 {
        year += 1;
    }
    (year as u16, month, day)
}

/// The weekday of a civil date: `0` is Sunday, `6` is Saturday.
///
/// 1970-01-01 was a Thursday, which is why the day count is offset by four.
pub fn weekday(year: u16, month: u8, day: u8) -> u8 {
    let days = days_from_civil(year as i64, month.clamp(1, 12), day.max(1));
    ((days + 4).rem_euclid(7)) as u8
}

/// The size of the box a numeral's **ink** occupies, in pixels.
///
/// Three columns and five rows per glyph is what a packed face's ink can occupy (`glyph_rows` is
/// `[u8; 5]` and `draw_glyph` reads three bits of each row), so this is the box a numeral has to be
/// centred on to sit on its tick. The block a glyph pixel covers is the face's own -- two pixels for
/// `Scaled6x10`, whose glyphs the text engine draws as two-by-two blocks, one for everything else --
/// times the size the design asked for.
pub fn label_ink_box(font: FontId, glyphs: usize, scale: u32) -> (i32, i32) {
    let block = label_block(font, scale);
    let advance = font.advance() as i32 * scale.max(1) as i32;
    let glyphs = glyphs.max(1) as i32;
    let (glyph_width, glyph_height) = crate::font::glyph_ink_box(font, '0');
    (
        i32::from(glyph_width) * block + (glyphs - 1) * advance,
        i32::from(glyph_height) * block,
    )
}

/// How many pixels of a numeral one glyph pixel of `font` covers, at `scale`.
pub fn label_block(font: FontId, scale: u32) -> i32 {
    // Two faces draw a glyph pixel as a block of their own: `Scaled6x10` is the 3x5 table at 2x2, and
    // a rasterised face is already the size it says it is. Everything else is one pixel per bit.
    let base = if font == FontId::Scaled6x10 { 2 } else { 1 };
    base * scale.max(1) as i32
}

/// Text centred on `(x, y)` with every glyph pixel magnified by `scale`.
///
/// Two things make the numeral's *ink* land on the point rather than near it:
///
/// - the box that is centred is the glyph's ink (three columns, five rows), not its cell -- a packed
///   digit's ink is three of the four pixels of its advance, so centring the cell leaves the number
///   visibly off to one side;
/// - the block a glyph pixel covers is the face's own, times the size the design asked for. The text
///   engine draws `Scaled6x10` as two-by-two blocks of the 3x5 table and everything else one pixel
///   per bit (`render/mod.rs`), so a numeral has to follow the same rule or it is half the size of
///   the same face everywhere else on the screen.
///
/// `for_each_glyph_pixel` gives the pixels of the face the design chose -- the 3x5 table for the
/// packed faces, the rasterised glyphs for the two `Mono` faces -- which is what makes a scaled
/// numeral read as a digit of *that* face rather than as a blocky 3x5 one, and the designer's canvas
/// draws the same pixels from the same tables.
fn draw_scaled_text<D, C>(
    ctx: &mut RenderCtx<'_, D, C>,
    x: i32,
    y: i32,
    text: &str,
    font: FontId,
    colour: Rgb565,
    scale: u32,
) -> Result<(), D::Error>
where
    D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
    C: Compositor<D>,
{
    let block = label_block(font, scale);
    let advance = font.advance() as i32 * scale.max(1) as i32;
    let (width, ink_height) = label_ink_box(font, text.chars().count(), scale);
    let top = y - ink_height / 2;
    let mut left = x - width / 2;
    for ch in text.chars() {
        let mut pixels: heapless::Vec<(i32, i32), 256> = heapless::Vec::new();
        crate::font::for_each_glyph_pixel(font, ch, &mut |dx, dy| {
            let _ = pixels.push((dx, dy));
        });
        for (dx, dy) in pixels {
            ctx.fill_rect(
                Rect::new(
                    left + dx * block,
                    top + dy * block,
                    block as u32,
                    block as u32,
                ),
                colour,
            )?;
        }
        left += advance;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The hands step: the minute hand by half a minute tick, the hour hand by a whole minute.
    ///
    /// Reported 2026-10-17: "The minute hand must only redraw when sufficient time has passed so that
    /// the hand have passed more than half of the time between minute ticks. So the minute hand
    /// updates basically once every 30 seconds. The hour hand can update every minute."
    #[test]
    fn the_minute_hand_steps_half_a_minute_and_the_hour_hand_a_whole_one() {
        let spec = |hour, minute, second| ClockWidget::new(hour, minute, second).hand_spec();
        let minute_angle = |time: [(f32, f32, u8); 3]| time[1].0;
        let hour_angle = |time: [(f32, f32, u8); 3]| time[0].0;

        // The first half of the minute: the hand sits on the minute's own mark and does not creep.
        assert_eq!(
            minute_angle(spec(10, 10, 0)),
            minute_angle(spec(10, 10, 29)),
            "the minute hand must not move before half the tick has passed"
        );
        // At the half minute it moves to halfway between the marks -- three degrees of its six.
        assert_eq!(
            minute_angle(spec(10, 10, 30)) - minute_angle(spec(10, 10, 0)),
            3.0
        );
        // And it holds that position until the next minute.
        assert_eq!(
            minute_angle(spec(10, 10, 30)),
            minute_angle(spec(10, 10, 59))
        );
        // The hour hand takes nothing from the seconds: within a minute it is one position ...
        assert_eq!(hour_angle(spec(10, 10, 0)), hour_angle(spec(10, 10, 59)));
        // ... and the minute rolling over is what moves it.
        assert_ne!(hour_angle(spec(10, 10, 59)), hour_angle(spec(10, 11, 0)));
    }

    /// A tick damages the second hand alone, except on the two ticks a minute that move the minute
    /// hand and the one that moves the hour hand.
    ///
    /// The old damage was the union of all three hands, so a face repainted its long minute hand
    /// sixty times a minute for the fifty-eight seconds it was not moving. This checks both halves of
    /// that: the tips of the hands that did not move stay out of the damage, and the tips of the ones
    /// that did are in it.
    #[test]
    fn only_the_hands_that_moved_are_damaged() {
        use crate::context::GuiContext;
        use crate::test_buffer::TestBuffer;

        let rect = Rect::new(10, 20, 120, 120);
        let style = Style::new();
        // The renderer's geometry: the centre of the cell and a radius trimmed by four.
        let (cx, cy, radius) = (70, 80, 56);
        let tip = |angle: f32, fraction: f32| {
            let radians = angle.to_radians();
            let length = radius as f32 * fraction;
            (
                cx + (length * radians.cos()) as i32,
                cy + (length * radians.sin()) as i32,
            )
        };
        let tips = |clock: ClockWidget| {
            let spec = clock.hand_spec();
            [
                tip(spec[0].0, spec[0].1),
                tip(spec[1].0, spec[1].1),
                tip(spec[2].0, spec[2].1),
            ]
        };

        // One second into a quarter past ten: only the second hand moves.
        let before = ClockWidget::new(10, 15, 0);
        let after = ClockWidget::new(10, 15, 1);
        let moved = before.hand_damage_rect(&after, rect, style).unwrap();
        let (old, new) = (tips(before), tips(after));
        assert!(
            moved.contains(new[2].0, new[2].1),
            "the second hand's new tip"
        );
        assert!(moved.contains(old[2].0, old[2].1), "and the one it left");
        for hand in [0usize, 1] {
            assert!(
                !moved.contains(old[hand].0, old[hand].1),
                "hand {hand} did not move, so its tip is not repainted: {moved:?}"
            );
        }

        // The half minute: the minute hand steps, and both of its positions are repainted.
        let half = ClockWidget::new(10, 15, 30);
        let moved = before.hand_damage_rect(&half, rect, style).unwrap();
        let (old_half, new_half) = (tips(before), tips(half));
        assert!(
            moved.contains(old_half[1].0, old_half[1].1),
            "the minute hand's old tip is erased"
        );
        assert!(
            moved.contains(new_half[1].0, new_half[1].1),
            "the minute hand's new tip is drawn"
        );

        // The minute rolling over: the hour hand moves too.
        let next_minute = ClockWidget::new(10, 16, 0);
        let moved = ClockWidget::new(10, 15, 59)
            .hand_damage_rect(&next_minute, rect, style)
            .unwrap();
        let hour_before = tips(ClockWidget::new(10, 15, 59));
        let hour_after = tips(next_minute);
        assert!(
            moved.contains(hour_before[0].0, hour_before[0].1),
            "the hour hand's old tip is erased"
        );
        assert!(
            moved.contains(hour_after[0].0, hour_after[0].1),
            "and its new one drawn"
        );

        // Nothing moved at all: nothing to repaint, so the caller is told so.
        assert_eq!(
            before.hand_damage_rect(&before, rect, style),
            None,
            "a clock set to the time it already shows has no damage"
        );

        // And the hands that are drawn are the hands that were measured, on the glass: a clock whose
        // ink moved without its damage moving would leave a second hand behind.
        let mut ctx: GuiContext<32, 16, 16> = GuiContext::new(Rect::new(0, 0, 160, 160));
        let id = ctx
            .add_clock_styled(rect, ClockWidget::new(10, 15, 0), style)
            .unwrap();
        let mut buffer = TestBuffer::new(160, 160);
        ctx.render(&mut buffer).unwrap();
        ctx.clear_dirty();
        // 10:15:29 -- a second hand tick with the minute hand still where it was.
        ctx.set_clock_time(id, 10, 15, 29).unwrap();
        let damaged = ctx.dirty_regions();
        assert_eq!(damaged.len(), 1, "one region for one second");
    }

    #[test]
    fn a_numeral_is_measured_by_its_ink_and_its_face() {
        // One digit of the 3x5 face: three columns, five rows, one pixel per bit.
        assert_eq!(label_ink_box(FontId::Tiny3x5, 1, 1), (3, 5));
        // The design's own size magnifies every pixel, so both axes grow with it.
        assert_eq!(label_ink_box(FontId::Tiny3x5, 1, 2), (6, 10));
        // `Scaled6x10` is two-by-two blocks of the same table in the text engine, so its numeral is
        // twice the size of the same text in `Tiny3x5` ...
        assert_eq!(label_block(FontId::Scaled6x10, 1), 2);
        assert_eq!(label_ink_box(FontId::Scaled6x10, 1, 1), (6, 10));
        // ... and one step of the design's size on top of that is four-by-four blocks.
        assert_eq!(label_ink_box(FontId::Scaled6x10, 1, 2), (12, 20));
        // Two digits: the second starts one advance later, so the box is one advance wider than one
        // glyph's ink -- which is what centres `12` on its tick rather than centring its first digit.
        assert_eq!(label_ink_box(FontId::Tiny3x5, 2, 1), (3 + 4, 5));
        assert_eq!(label_ink_box(FontId::Scaled6x10, 2, 1), (6 + 7, 10));
        // An empty label still has a box, so a caller cannot divide by a nonsense width.
        assert_eq!(label_ink_box(FontId::Tiny3x5, 0, 1), (3, 5));
    }

    /// The complaint, on the glass: the hour numerals were hung off a corner of their text box
    /// instead of centred on their tick. This renders the face through the real engine and measures
    /// the ink, so it fails if either the drawing or the centring drifts.
    ///
    /// The anchor is the renderer's: sixteen pixels inside the rim, and then half a character width further
    /// in (asked for 2026-10-21, revised from a whole advance the same day because it moved them too far).
    /// The measured centre is compared against that expression, so dropping the half advance puts every
    /// numeral outside the tolerance.
    #[test]
    fn the_numerals_are_centred_on_their_ticks_on_the_glass() {
        use crate::context::GuiContext;
        use crate::test_buffer::TestBuffer;

        let mut ctx: GuiContext<32, 16, 16> = GuiContext::new(Rect::new(0, 0, 160, 160));
        let mut clock = ClockWidget::new(10, 10, 30);
        // Only the numerals are white, so a white pixel is a numeral pixel: the hands, both tick
        // lengths and the pivot are black. The date block is off: it sits under the six and is
        // measured by its own test.
        clock.hour_color = Rgb565::BLACK;
        clock.minute_color = Rgb565::BLACK;
        clock.second_color = Rgb565::BLACK;
        clock.hour_tick_color = Rgb565::BLACK;
        clock.minute_tick_color = Rgb565::BLACK;
        clock.label_color = Rgb565::WHITE;
        clock.show_weekday = false;
        clock.show_month = false;
        clock.show_date = false;
        ctx.add_clock_styled(Rect::new(0, 0, 160, 160), clock, crate::style::Style::new())
            .unwrap();
        let mut buffer = TestBuffer::new(160, 160);
        ctx.render(&mut buffer).unwrap();

        // The geometry the renderer uses: centre, then a radius trimmed by four, with the numerals
        // sixteen pixels inside it and half a character width further in again.
        let (cx, cy, radius) = (80, 80, 76);
        let inward = (crate::style::Style::new().font.advance() / 2).max(1);
        let inset = radius - 16 - inward;

        let ink_around = |ax: i32, ay: i32| {
            let mut bounds: Option<(i32, i32, i32, i32)> = None;
            for y in (ay - 8)..=(ay + 8) {
                for x in (ax - 8)..=(ax + 8) {
                    if buffer.pixel_at(x, y) == Some(Rgb565::WHITE) {
                        bounds = Some(match bounds {
                            None => (x, y, x, y),
                            Some((x0, y0, x1, y1)) => (x0.min(x), y0.min(y), x1.max(x), y1.max(y)),
                        });
                    }
                }
            }
            bounds
        };

        for hour in 1..=12i32 {
            let radians = (TWELVE_OCLOCK + hour as f32 * HOUR_STEP).to_radians();
            let ax = cx + (inset as f32 * radians.cos()) as i32;
            let ay = cy + (inset as f32 * radians.sin()) as i32;
            let (x0, y0, x1, y1) = ink_around(ax, ay).unwrap_or_else(|| {
                panic!("no numeral drawn at hour {hour}, expecting ({ax}, {ay})")
            });
            // `x1` and `y1` are the last pixels of the ink, so the box is `x0..=x1`.
            let centre_x2 = x0 + x1;
            let centre_y2 = y0 + y1;
            assert!(
                (centre_x2 - 2 * ax).abs() <= 2,
                "hour {hour}: numeral x centre {} is not on the tick ({ax})",
                centre_x2 as f32 / 2.0
            );
            assert!(
                (centre_y2 - 2 * ay).abs() <= 2,
                "hour {hour}: numeral y centre {} is not on the tick ({ay})",
                centre_y2 as f32 / 2.0
            );
        }
    }

    /// The design sets how far the numerals sit inside the ring, in tenths of a character width
    /// (asked for 2026-10-21: "make the displacement settable in the designer in steps of 0.1 of the
    /// current font char width").
    #[test]
    fn a_design_sets_the_number_inset_in_tenths_of_a_character() {
        use crate::context::GuiContext;
        use crate::test_buffer::TestBuffer;

        // The twelve o'clock numeral's ink, at an inset, measured on the glass: `(x0 + x1, y0 + y1)`.
        let twelve = |inset: f32| -> (i32, i32) {
            let mut ctx: GuiContext<16, 8, 8> = GuiContext::new(Rect::new(0, 0, 160, 160));
            let mut clock = ClockWidget::new(10, 10, 30);
            clock.hour_color = Rgb565::BLACK;
            clock.minute_color = Rgb565::BLACK;
            clock.second_color = Rgb565::BLACK;
            clock.hour_tick_color = Rgb565::BLACK;
            clock.minute_tick_color = Rgb565::BLACK;
            clock.label_color = Rgb565::WHITE;
            clock.label_inset = inset;
            ctx.add_clock_styled(Rect::new(0, 0, 160, 160), clock, crate::style::Style::new())
                .unwrap();
            let mut buffer = TestBuffer::new(160, 160);
            ctx.render(&mut buffer).unwrap();
            let mut bounds: Option<(i32, i32, i32, i32)> = None;
            for y in 0..70 {
                for x in 70..=90 {
                    if buffer.pixel_at(x, y) == Some(Rgb565::WHITE) {
                        bounds = Some(match bounds {
                            None => (x, y, x, y),
                            Some((x0, y0, x1, y1)) => (x0.min(x), y0.min(y), x1.max(x), y1.max(y)),
                        });
                    }
                }
            }
            let (x0, y0, x1, y1) = bounds.expect("the twelve o'clock numeral is drawn");
            (x0 + x1, y0 + y1)
        };

        let advance = FontId::Tiny3x5.advance() as i32;
        let (x_flat, y_flat) = twelve(0.0);
        let (x_half, y_half) = twelve(0.5);
        let (x_one, y_one) = twelve(1.0);
        assert_eq!(
            (x_flat, x_half, x_one),
            (x_flat, x_flat, x_flat),
            "the numerals move radially, never sideways"
        );
        assert_eq!(
            y_one - y_flat,
            2 * advance,
            "one character width is one advance closer to the centre (higher y at twelve o'clock)"
        );
        assert_eq!(
            (y_half - y_flat) * 2,
            y_one - y_flat,
            "and half a character is half as far, to the pixel"
        );
    }

    /// A second on the clock is a few hundred pixels, not a whole face.
    ///
    /// Reported 2026-10-17: "the complete clock widget is redrawn at 1 sec intervals. Only the hands
    /// should be redrawn as and when needed." The damage for a time change is now the union of the
    /// hands before and after, so the rim -- sixty ticks, twelve numerals and the frame -- is not
    /// painted at all while the clock runs.
    #[test]
    fn a_second_damages_only_the_hands_and_never_the_rim() {
        use crate::context::GuiContext;
        use crate::test_buffer::TestBuffer;

        let rect = Rect::new(10, 20, 120, 120);
        let style = crate::style::Style::new();
        let mut ctx: GuiContext<32, 16, 16> = GuiContext::new(Rect::new(0, 0, 160, 160));
        let id = ctx
            .add_clock_styled(rect, ClockWidget::new(10, 30, 30), style)
            .unwrap();
        let mut buffer = TestBuffer::new(160, 160);
        ctx.render(&mut buffer).unwrap();
        ctx.clear_dirty();

        ctx.advance_clock(id).unwrap();
        let damaged = ctx.dirty_regions();
        assert_eq!(damaged.len(), 1, "a second damages one region");
        let damage = damaged[0];
        assert!(
            damage.w < rect.w && damage.h < rect.h,
            "the damage is a part of the clock, not the clock: {damage:?}"
        );

        // The geometry the renderer uses: the centre of the cell, and a radius trimmed by four.
        let (cx, cy, radius) = (70, 80, 56);
        // Both second-hand positions have to be inside it, or the old hand would be left behind.
        for second in [30.0f32, 31.0] {
            let radians = (TWELVE_OCLOCK + second * MINUTE_STEP).to_radians();
            let length = radius as f32 * 0.88;
            let tip_x = cx + (length * radians.cos()) as i32;
            let tip_y = cy + (length * radians.sin()) as i32;
            assert!(
                damage.contains(tip_x, tip_y),
                "the {second} s hand tip ({tip_x}, {tip_y}) is outside the damage {damage:?}"
            );
        }
        // And the rim is untouched: twelve o'clock's tick sits `radius` from the centre, which is
        // beyond the longest hand the face draws.
        assert!(
            !damage.contains(cx, cy - radius),
            "the rim was damaged: {damage:?}"
        );
        for (x, y) in [
            (cx, cy - radius),
            (cx + radius, cy),
            (cx, cy + radius),
            (cx - radius, cy),
        ] {
            assert!(
                !damage.contains(x, y),
                "rim pixel ({x}, {y}) damaged by a second"
            );
        }
    }

    /// The complaint, on the glass: the hands drew their new positions and the old ones stayed.
    ///
    /// A design's clock has no face of its own -- the designer emits `Style::label()` for it, so its
    /// background is `None` -- and the panel is cleared once, before the first frame. A partial
    /// repaint therefore has to clear the damaged regions itself, which is what
    /// `GuiContext::paint_damage` is for and what the generated `render` calls. This holds the two
    /// paths to the same pixels: a damaged repaint of the new time must look exactly like a whole
    /// one.
    #[test]
    fn a_moved_hand_leaves_no_trace_when_the_damage_is_cleared() {
        use crate::context::GuiContext;
        use crate::test_buffer::TestBuffer;

        let mut ctx: GuiContext<32, 16, 16> = GuiContext::new(Rect::new(0, 0, 160, 160));
        // A transparent face, like the designer's: only the hands and the ticks paint.
        let mut clock = ClockWidget::new(10, 10, 30);
        clock.show_labels = false;
        let id = ctx
            .add_clock_styled(
                Rect::new(0, 0, 160, 160),
                clock,
                crate::style::Style::label(),
            )
            .unwrap();

        let mut partial = TestBuffer::new(160, 160);
        partial.clear_color(Rgb565::BLACK);
        ctx.render(&mut partial).unwrap();
        ctx.clear_dirty();

        // Half a minute on: the second hand lands on the far side of the dial, where the old one
        // was not.
        ctx.set_clock_time(id, 10, 10, 45).unwrap();
        assert_eq!(
            ctx.dirty_regions().len(),
            1,
            "the clock's own cell is damaged"
        );

        ctx.paint_damage(&mut partial, Rgb565::BLACK).unwrap();
        ctx.render_dirty(&mut partial).unwrap();

        // What a whole repaint of the same design would have produced.
        let mut whole = TestBuffer::new(160, 160);
        whole.clear_color(Rgb565::BLACK);
        ctx.render(&mut whole).unwrap();

        let mut different = 0usize;
        for y in 0..160i32 {
            for x in 0..160i32 {
                if partial.pixel_at(x, y) != whole.pixel_at(x, y) {
                    different += 1;
                }
            }
        }
        assert_eq!(
            different, 0,
            "{different} pixels differ between a cleared partial repaint and a whole one"
        );
    }

    #[test]
    fn a_second_carries_into_minutes_hours_and_past_midnight() {
        assert_eq!(ClockWidget::next_second(10, 10, 30), (10, 10, 31));
        assert_eq!(ClockWidget::next_second(10, 10, 59), (10, 11, 0));
        assert_eq!(ClockWidget::next_second(10, 59, 59), (11, 0, 0));
        // 23:59:59 is the last second of the day; a movement must not stall or show 24 o'clock.
        assert_eq!(ClockWidget::next_second(23, 59, 59), (0, 0, 0));
    }

    #[test]
    fn a_time_set_on_a_clock_is_clamped_and_repaints_only_that_cell() {
        use crate::context::GuiContext;
        use crate::test_buffer::TestBuffer;

        let mut ctx: GuiContext<32, 16, 16> = GuiContext::new(Rect::new(0, 0, 320, 240));
        let mut clock = ClockWidget::new(10, 10, 30);
        clock.hour_color = Rgb565::BLACK;
        clock.minute_color = Rgb565::BLACK;
        clock.second_color = Rgb565::BLACK;
        clock.hour_tick_color = Rgb565::BLACK;
        clock.minute_tick_color = Rgb565::BLACK;
        let id = ctx
            .add_clock_styled(
                Rect::new(10, 20, 100, 100),
                clock,
                crate::style::Style::new(),
            )
            .unwrap();

        assert_eq!(ctx.clock_time(id), Some((10, 10, 30)));
        // One frame first: until something has been painted the whole panel is damaged, which would
        // hide whether the movement damages its own cell or everything.
        let mut buffer = TestBuffer::new(320, 240);
        ctx.render(&mut buffer).unwrap();
        ctx.clear_dirty();
        // A field past its range is clamped rather than wrapped, so a bad input cannot show 99:00.
        ctx.set_clock_time(id, 30, 90, 90).unwrap();
        assert_eq!(ctx.clock_time(id), Some((23, 59, 59)));
        // The movement: one call, one second, and only the clock's own rectangle to repaint.
        ctx.advance_clock(id).unwrap();
        assert_eq!(ctx.clock_time(id), Some((0, 0, 0)));
        let damaged = ctx.dirty_regions();
        assert_eq!(damaged.len(), 1, "one damaged region, not the whole panel");
        assert!(
            damaged[0].w <= 100 && damaged[0].h <= 100,
            "and it is the clock's own cell, not the panel: {:?}",
            damaged[0]
        );
        // A widget that is not a clock is not a clock.
        let label = ctx
            .add_label(Rect::new(0, 0, 40, 20), "x", crate::style::Style::new())
            .unwrap();
        assert_eq!(ctx.clock_time(label), None);
        assert!(ctx.advance_clock(label).is_err());
    }

    /// The date is part of the time now, so midnight rolls the calendar -- including February in a
    /// leap year and the century rule.
    #[test]
    fn a_second_rolls_the_calendar_at_midnight() {
        assert_eq!(
            ClockWidget::next_datetime(2026, 11, 23, 23, 59, 59),
            (2026, 11, 24, 0, 0, 0)
        );
        assert_eq!(
            ClockWidget::next_datetime(2026, 11, 30, 23, 59, 59),
            (2026, 12, 1, 0, 0, 0)
        );
        assert_eq!(
            ClockWidget::next_datetime(2026, 12, 31, 23, 59, 59),
            (2027, 1, 1, 0, 0, 0)
        );
        assert_eq!(
            ClockWidget::next_datetime(2024, 2, 28, 23, 59, 59),
            (2024, 2, 29, 0, 0, 0),
            "2024 is a leap year"
        );
        assert_eq!(
            ClockWidget::next_datetime(2024, 2, 29, 23, 59, 59),
            (2024, 3, 1, 0, 0, 0)
        );
        assert_eq!(
            ClockWidget::next_datetime(2100, 2, 28, 23, 59, 59),
            (2100, 3, 1, 0, 0, 0),
            "2100 is not a leap year"
        );
        // A day past the month is a design mistake, clamped rather than drawn.
        let clamped = ClockWidget::new(0, 0, 0).with_date(2026, 2, 31);
        assert_eq!((clamped.year, clamped.month, clamped.day), (2026, 2, 28));
        let leap = ClockWidget::new(0, 0, 0).with_date(2024, 2, 31);
        assert_eq!((leap.year, leap.month, leap.day), (2024, 2, 29));
        // The weekday follows the date: 2026-11-23 is a Monday.
        assert_eq!(weekday(2026, 11, 23), 1);
        assert_eq!(weekday(2000, 1, 1), 6, "the RTC's base is a Saturday");
    }

    /// The block sits where the design asked: above the six, the weekday above it, and the month and
    /// year above that -- all on the pivot's own vertical line, and the text keeps the design's size
    /// whatever the control measures, exactly like the hour numerals.
    #[test]
    fn the_date_block_is_anchored_above_the_six_at_a_fixed_size() {
        let style = crate::style::Style::new();
        let clock = ClockWidget::new(10, 10, 30).with_date(2026, 11, 23);
        let small = clock.date_block(Rect::new(0, 0, 96, 96), style).unwrap();
        let large = clock.date_block(Rect::new(0, 0, 192, 192), style).unwrap();
        let small_weekday = small.weekday.as_ref().unwrap();
        let large_weekday = large.weekday.as_ref().unwrap();
        assert_eq!(
            small_weekday.height, large_weekday.height,
            "the date text does not grow with the control: {} at 96, {} at 192",
            small_weekday.height, large_weekday.height
        );
        for (name, side, block) in [("small", 96, &small), ("large", 192, &large)] {
            let cy = side / 2;
            // The box is above the six o'clock numeral, and below the pivot.
            assert!(
                block.box_rect.y > cy && block.box_rect.bottom() < side,
                "{name}: the day box is between the pivot and the rim: {:?}",
                block.box_rect
            );
            // The three lines are stacked upward from the box, in the requested order.
            if let (Some(month), Some(weekday)) = (&block.month, &block.weekday) {
                assert!(
                    month.height > 0 && weekday.height > 0 && block.month_top < block.weekday_top,
                    "{name}: the month and year are above the weekday"
                );
            }
            // Centred on the pivot, which is the x every line shares.
            assert_eq!(block.cx, side / 2);
            assert_eq!(
                block.box_rect.x + block.box_rect.w as i32 / 2,
                block.cx,
                "{name}: the box is centred on the pivot"
            );
            // The day's ink stays clear of the frame: on every side there is the border plus at
            // least one glyph pixel of air.
            let day = block.day.as_ref().unwrap();
            let border = i32::from(block.border_width);
            let air = glyph_pixel(day.font, day.scale);
            assert!(
                block.box_rect.w as i32 >= day.width + 2 * (border + air),
                "{name}: the box leaves room for the border and air: {:?}",
                block.box_rect
            );
            assert!(
                block.box_rect.h as i32 >= day.height + 2 * (border + air),
                "{name}: and vertically: {:?}",
                block.box_rect
            );
        }

        // The offset moves the whole stack up for a positive value, down for a negative one.
        let offset = |pixels: i16| {
            let mut shifted = clock;
            shifted.date_offset = pixels;
            shifted
                .date_block(Rect::new(0, 0, 192, 192), style)
                .unwrap()
        };
        let plain = offset(0);
        let up = offset(6);
        let down = offset(-4);
        assert_eq!(up.box_rect.y, plain.box_rect.y - 6);
        assert_eq!(up.month_top, plain.month_top - 6);
        assert_eq!(up.weekday_top, plain.weekday_top - 6);
        assert_eq!(down.box_rect.y, plain.box_rect.y + 4);
    }

    /// A date line can be sized by a fraction, which is what the designer's size fields offer: `1.5`
    /// is half again the face's own pixels rather than a jump to the next whole step.
    #[test]
    fn a_date_line_can_be_sized_by_a_fraction() {
        let style = crate::style::Style::new();
        let heights = [1.0f32, 1.5, 2.0].map(|scale| {
            let mut clock = ClockWidget::new(10, 10, 30).with_date(2026, 11, 23);
            clock.day_scale = scale;
            let block = clock.date_block(Rect::new(0, 0, 192, 192), style).unwrap();
            block.day.as_ref().unwrap().height
        });
        assert!(
            heights[0] < heights[1] && heights[1] < heights[2],
            "a fractional size sits between the two whole ones: {heights:?}"
        );
        assert_eq!(
            heights[1],
            (heights[0] as f32 * 1.5).round() as i32,
            "and is exactly one and a half times the size it was: {heights:?}"
        );
    }

    /// A date change repaints the block and nothing of the dial's rim; a time change on the same day
    /// still repaints only the hands.
    #[test]
    fn a_date_change_damages_only_the_date_block() {
        use crate::context::GuiContext;
        use crate::test_buffer::TestBuffer;

        let rect = Rect::new(10, 20, 160, 160);
        let mut ctx: GuiContext<32, 16, 16> = GuiContext::new(Rect::new(0, 0, 320, 240));
        let id = ctx
            .add_clock_styled(
                rect,
                ClockWidget::new(10, 10, 30).with_date(2026, 11, 23),
                crate::style::Style::new(),
            )
            .unwrap();
        let mut buffer = TestBuffer::new(320, 240);
        ctx.render(&mut buffer).unwrap();
        ctx.clear_dirty();

        ctx.set_clock_date(id, 2026, 11, 24).unwrap();
        assert_eq!(ctx.clock_datetime(id), Some((2026, 11, 24, 10, 10, 30)));
        let damaged = ctx.dirty_regions();
        assert!(!damaged.is_empty(), "a new day has pixels to repaint");
        for region in damaged {
            assert!(
                !region.contains(90, 30),
                "the rim was not part of the date's damage: {region:?}"
            );
            assert!(
                region.y > 40,
                "and only the block below the top of the face: {region:?}"
            );
        }
    }

    /// The three date lines are on the glass, in the shared date colour.
    #[test]
    fn the_date_block_paints_its_three_lines_and_the_day_box() {
        use crate::context::GuiContext;
        use crate::test_buffer::TestBuffer;

        let rect = Rect::new(0, 0, 200, 200);
        let mut ctx: GuiContext<32, 16, 16> = GuiContext::new(Rect::new(0, 0, 200, 200));
        let mut clock = ClockWidget::new(10, 10, 30).with_date(2026, 11, 23);
        clock.hour_color = Rgb565::BLACK;
        clock.minute_color = Rgb565::BLACK;
        clock.second_color = Rgb565::BLACK;
        clock.hour_tick_color = Rgb565::BLACK;
        clock.minute_tick_color = Rgb565::BLACK;
        clock.label_color = Rgb565::BLACK;
        clock.date_color = Rgb565::WHITE;
        clock.date_box_fill = Rgb565::new(1, 2, 4);
        clock.date_box_border = Rgb565::WHITE;
        ctx.add_clock_styled(rect, clock, crate::style::Style::label())
            .unwrap();
        let mut buffer = TestBuffer::new(200, 200);
        ctx.render(&mut buffer).unwrap();

        // The box's fill is a colour nothing else on the face uses; some of it must be visible.
        let filled = (0..200i32)
            .flat_map(|y| (0..200i32).map(move |x| (x, y)))
            .filter(|(x, y)| buffer.pixel_at(*x, *y) == Some(Rgb565::new(1, 2, 4)))
            .count();
        assert!(filled > 0, "the day box is filled");
        // White ink below the pivot: the date lines and the border, none of which the numerals use.
        let ink = (100..200i32)
            .flat_map(|y| (0..200i32).map(move |x| (x, y)))
            .filter(|(x, y)| buffer.pixel_at(*x, *y) == Some(Rgb565::WHITE))
            .count();
        assert!(ink > 0, "the date text and the box's border are painted");
    }
}
