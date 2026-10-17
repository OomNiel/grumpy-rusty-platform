#![allow(unused_imports)]

use crate::{
    geometry::Rect,
    haptics::HapticPattern,
    image::{ImageFit, ImageRef, ReelPlayer},
    mono::IconPart,
    render::TextAlign,
    style::{Style, WidgetStyle},
    widget::{FocusGroupId, StyleClassId, Widget, WidgetId},
    widgets::{
        CarouselSpec, ChartMode, CheckboxLabelPosition, CompositeIconSpec, KeyboardLayout,
        MenuCell, NotificationLevel, RollerSelection, ScaleMode, SurfaceState, WidgetKind,
    },
};
use embedded_graphics_core::pixelcolor::{Rgb565, WebColors};

use super::*;

pub struct WidgetBuilder<'a, 'ctx, W, const NODES: usize, const EVENTS: usize, const DIRTY: usize> {
    ctx: &'ctx mut GuiContext<'a, NODES, EVENTS, DIRTY>,
    rect: Rect,
    _widget: W,
    parent: Option<WidgetId>,
    style_class: Option<StyleClassId>,
    focus_group: FocusGroupId,
    style: Option<WidgetStyle>,
}

impl<'a, 'ctx, W, const NODES: usize, const EVENTS: usize, const DIRTY: usize>
    WidgetBuilder<'a, 'ctx, W, NODES, EVENTS, DIRTY>
where
    W: Widget + 'a,
{
    pub fn new(
        ctx: &'ctx mut GuiContext<'a, NODES, EVENTS, DIRTY>,
        rect: impl Into<Rect>,
        widget: W,
    ) -> Self {
        Self {
            ctx,
            rect: rect.into(),
            _widget: widget,
            parent: None,
            style_class: None,
            focus_group: FocusGroupId::ROOT,
            style: None,
        }
    }

    pub fn with_parent(mut self, parent: WidgetId) -> Self {
        self.parent = Some(parent);
        self
    }

    pub fn with_style_class(mut self, style_class: StyleClassId) -> Self {
        self.style_class = Some(style_class);
        self
    }

    pub fn with_focus_group(mut self, focus_group: FocusGroupId) -> Self {
        self.focus_group = focus_group;
        self
    }

    pub fn with_style(mut self, style: impl Into<WidgetStyle>) -> Self {
        self.style = Some(style.into());
        self
    }

    pub fn build(self) -> Result<WidgetId, GuiError> {
        let style = self
            .style
            .unwrap_or_else(|| WidgetStyle::from(Style::default()));
        let id = self.ctx.add_widget(self.rect, WidgetKind::Spacer, style)?;
        if let Some(parent) = self.parent {
            self.ctx.add_child(parent, id)?;
        }
        if let Some(class_id) = self.style_class {
            if let Some(node) = self.ctx.node_mut(id) {
                node.style_class = Some(class_id);
            }
        }
        if self.focus_group != FocusGroupId::ROOT {
            self.ctx.set_focus_group(id, self.focus_group)?;
        }
        Ok(id)
    }
}

impl<'a, 'ctx, W, const NODES: usize, const EVENTS: usize, const DIRTY: usize>
    crate::geometry::FluentBuilder for WidgetBuilder<'a, 'ctx, W, NODES, EVENTS, DIRTY>
{
}

impl<'a, const NODES: usize, const EVENTS: usize, const DIRTY: usize>
    GuiContext<'a, NODES, EVENTS, DIRTY>
{
    pub fn spawn<'ctx, W>(
        &'ctx mut self,
        rect: impl Into<Rect>,
        widget: W,
    ) -> WidgetBuilder<'a, 'ctx, W, NODES, EVENTS, DIRTY>
    where
        W: Widget + 'a,
    {
        WidgetBuilder::new(self, rect, widget)
    }

    pub fn add_custom_widget<S>(
        &mut self,
        rect: impl Into<Rect>,
        widget: &'a (dyn crate::widget::CustomWidget + 'a),
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        let id = self.add_widget(
            rect,
            WidgetKind::Custom(crate::widget::CustomWidgetRef::new(widget)),
            style,
        )?;
        self.ensure_focus();
        Ok(id)
    }

    pub fn add_panel<S>(&mut self, rect: impl Into<Rect>, style: S) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(rect, WidgetKind::Panel, style)
    }

    pub fn add_themed_panel(&mut self, rect: impl Into<Rect>) -> Result<WidgetId, GuiError> {
        self.add_panel(rect, self.theme.panel)
    }

    pub fn add_label<S>(
        &mut self,
        rect: impl Into<Rect>,
        text: &'a str,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(rect, WidgetKind::Label(text), style)
    }

    pub fn add_themed_label(
        &mut self,
        rect: impl Into<Rect>,
        text: &'a str,
    ) -> Result<WidgetId, GuiError> {
        self.add_label(rect, text, self.theme.label)
    }

    pub fn add_button<S>(
        &mut self,
        rect: impl Into<Rect>,
        text: &'a str,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        let id = self.add_widget(rect, WidgetKind::Button(text), style)?;
        self.ensure_focus();
        Ok(id)
    }

    pub fn add_themed_button(
        &mut self,
        rect: impl Into<Rect>,
        text: &'a str,
    ) -> Result<WidgetId, GuiError> {
        self.add_button(rect, text, self.theme.button)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_progress_bar<S>(
        &mut self,
        rect: impl Into<Rect>,
        value: f32,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(
            rect,
            WidgetKind::ProgressBar {
                value: value.clamp(0.0, 1.0),
            },
            style,
        )
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_themed_progress_bar(
        &mut self,
        rect: impl Into<Rect>,
        value: f32,
    ) -> Result<WidgetId, GuiError> {
        self.add_progress_bar(rect, value, self.theme.progress)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_toggle<S>(
        &mut self,
        rect: impl Into<Rect>,
        label: &'a str,
        on: bool,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_toggle_colored(rect, label, on, Rgb565::new(7, 10, 10), None, 0, style)
    }

    /// A toggle whose track colour while *off* is the design's, with an optional outline on that track.
    ///
    /// Upstream's `add_toggle` passes a near-black literal for that one colour, so an off switch was invisible
    /// on a dark panel and no markup could change it. The colour when *on* is `style.accent`, as upstream.
    /// `track_border`/`track_border_width` outline the track: `None` and `0` draw nothing, which is what
    /// `add_toggle` passes, so its output is unchanged.
    #[cfg(feature = "rich-widgets")]
    pub fn add_toggle_colored<S>(
        &mut self,
        rect: impl Into<Rect>,
        label: &'a str,
        on: bool,
        off_color: Rgb565,
        track_border: Option<Rgb565>,
        track_border_width: u8,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        let id = self.add_widget(
            rect,
            WidgetKind::Toggle {
                label,
                on,
                off_color,
                track_border,
                track_border_width,
            },
            style,
        )?;
        self.ensure_focus();
        Ok(id)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_themed_toggle(
        &mut self,
        rect: impl Into<Rect>,
        label: &'a str,
        on: bool,
    ) -> Result<WidgetId, GuiError> {
        self.add_toggle(rect, label, on, self.theme.toggle)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_checkbox<S>(
        &mut self,
        rect: impl Into<Rect>,
        label: &'a str,
        checked: bool,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_checkbox_sized(
            rect,
            label,
            checked,
            0,
            0,
            CheckboxLabelPosition::Right,
            None,
            style,
        )
    }

    /// A checkbox whose box has a size of its own and whose label can be put on any of its four sides.
    ///
    /// A `box_width` or `box_height` of `0` means upstream's rule -- `inner.h.min(8)` -- and is what
    /// `add_checkbox` passes, so nothing changes for markup that says nothing. `box_color` of `None` keeps
    /// upstream's outline colour, which is `style.text`, the same colour the label is drawn in.
    #[cfg(feature = "rich-widgets")]
    pub fn add_checkbox_sized<S>(
        &mut self,
        rect: impl Into<Rect>,
        label: &'a str,
        checked: bool,
        box_width: u8,
        box_height: u8,
        label_position: CheckboxLabelPosition,
        box_color: Option<Rgb565>,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        let id = self.add_widget(
            rect,
            WidgetKind::Checkbox {
                label,
                checked,
                box_width,
                box_height,
                label_position,
                box_color,
            },
            style,
        )?;
        self.ensure_focus();
        Ok(id)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_themed_checkbox(
        &mut self,
        rect: impl Into<Rect>,
        label: &'a str,
        checked: bool,
    ) -> Result<WidgetId, GuiError> {
        self.add_checkbox(rect, label, checked, self.theme.checkbox)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_slider<S>(
        &mut self,
        rect: Rect,
        value: f32,
        min: f32,
        max: f32,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        let value = value.clamp(min.min(max), min.max(max));
        let id = self.add_widget(rect, WidgetKind::Slider { value, min, max }, style)?;
        self.ensure_focus();
        Ok(id)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_themed_slider(
        &mut self,
        rect: Rect,
        value: f32,
        min: f32,
        max: f32,
    ) -> Result<WidgetId, GuiError> {
        self.add_slider(rect, value, min, max, self.theme.slider)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_value_label<S>(
        &mut self,
        rect: Rect,
        label: &'a str,
        value: i32,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(rect, WidgetKind::ValueLabel { label, value }, style)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_themed_value_label(
        &mut self,
        rect: Rect,
        label: &'a str,
        value: i32,
    ) -> Result<WidgetId, GuiError> {
        self.add_value_label(rect, label, value, self.theme.value_label)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_icon_button<S>(
        &mut self,
        rect: Rect,
        icon: char,
        label: &'a str,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        let id = self.add_widget(rect, WidgetKind::IconButton { icon, label }, style)?;
        self.ensure_focus();
        Ok(id)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_themed_icon_button(
        &mut self,
        rect: Rect,
        icon: char,
        label: &'a str,
    ) -> Result<WidgetId, GuiError> {
        self.add_icon_button(rect, icon, label, self.theme.icon_button)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_list<S>(
        &mut self,
        rect: Rect,
        items: &'a [&'a str],
        selected: usize,
        visible_rows: usize,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        let selected = selected.min(items.len().saturating_sub(1));
        let id = self.add_widget(
            rect,
            WidgetKind::List {
                items,
                selected,
                offset: selected,
                visible_rows: visible_rows.max(1),
            },
            style,
        )?;
        self.ensure_focus();
        Ok(id)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_feed_timeline<S>(
        &mut self,
        rect: Rect,
        items: &'a [&'a str],
        selected: usize,
        visible_rows: usize,
        expanded: bool,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        let selected = selected.min(items.len().saturating_sub(1));
        let id = self.add_widget(
            rect,
            WidgetKind::FeedTimeline {
                items,
                selected,
                offset: selected,
                visible_rows: visible_rows.max(1),
                expanded,
            },
            style,
        )?;
        self.ensure_focus();
        Ok(id)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_themed_list(
        &mut self,
        rect: Rect,
        items: &'a [&'a str],
        selected: usize,
        visible_rows: usize,
    ) -> Result<WidgetId, GuiError> {
        self.add_list(rect, items, selected, visible_rows, self.theme.list)
    }

    pub fn add_circular_list<S>(
        &mut self,
        rect: Rect,
        items: &'a [&'a str],
        selected: usize,
        visible_rows: usize,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        let selected = selected.min(items.len().saturating_sub(1));
        let id = self.add_widget(
            rect,
            WidgetKind::CircularList {
                items,
                selected,
                offset: selected,
                visible_rows: visible_rows.max(1),
            },
            style,
        )?;
        self.ensure_focus();
        Ok(id)
    }

    pub fn add_themed_circular_list(
        &mut self,
        rect: Rect,
        items: &'a [&'a str],
        selected: usize,
        visible_rows: usize,
    ) -> Result<WidgetId, GuiError> {
        self.add_circular_list(rect, items, selected, visible_rows, self.theme.list)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_scroll_view<S>(
        &mut self,
        rect: Rect,
        offset_y: i32,
        content_h: u32,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        let id = self.add_widget(
            rect,
            WidgetKind::ScrollView {
                offset_y,
                content_h,
            },
            style,
        )?;
        self.ensure_focus();
        Ok(id)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_themed_scroll_view(
        &mut self,
        rect: Rect,
        offset_y: i32,
        content_h: u32,
    ) -> Result<WidgetId, GuiError> {
        self.add_scroll_view(rect, offset_y, content_h, self.theme.list)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_tabs<S>(
        &mut self,
        rect: Rect,
        labels: &'a [&'a str],
        selected: usize,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        let selected = selected.min(labels.len().saturating_sub(1));
        let id = self.add_widget(rect, WidgetKind::Tabs { labels, selected }, style)?;
        self.ensure_focus();
        Ok(id)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_themed_tabs(
        &mut self,
        rect: Rect,
        labels: &'a [&'a str],
        selected: usize,
    ) -> Result<WidgetId, GuiError> {
        self.add_tabs(rect, labels, selected, self.theme.tabs)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_dialog<S>(
        &mut self,
        rect: Rect,
        title: &'a str,
        body: &'a str,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        let id = self.add_widget(rect, WidgetKind::Dialog { title, body }, style)?;
        self.play_haptic(HapticPattern::Alert);
        Ok(id)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_themed_dialog(
        &mut self,
        rect: Rect,
        title: &'a str,
        body: &'a str,
    ) -> Result<WidgetId, GuiError> {
        self.add_dialog(rect, title, body, self.theme.dialog)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_toast<S>(
        &mut self,
        rect: Rect,
        text: &'a str,
        ttl_ms: u32,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        let id = self.add_widget(rect, WidgetKind::Toast { text, ttl_ms }, style)?;
        self.play_haptic(HapticPattern::Success);
        Ok(id)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_themed_toast(
        &mut self,
        rect: Rect,
        text: &'a str,
        ttl_ms: u32,
    ) -> Result<WidgetId, GuiError> {
        self.add_toast(rect, text, ttl_ms, self.theme.toast)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_meter<S>(
        &mut self,
        rect: Rect,
        value: f32,
        min: f32,
        max: f32,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(rect, WidgetKind::Meter { value, min, max }, style)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_themed_meter(
        &mut self,
        rect: Rect,
        value: f32,
        min: f32,
        max: f32,
    ) -> Result<WidgetId, GuiError> {
        self.add_meter(rect, value, min, max, self.theme.meter)
    }

    #[allow(clippy::too_many_arguments)]
    #[cfg(feature = "rich-widgets")]
    pub fn add_arc_gauge<S>(
        &mut self,
        rect: Rect,
        value: f32,
        min: f32,
        max: f32,
        start_deg: i32,
        end_deg: i32,
        thickness: u8,
        antialias: bool,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(
            rect,
            WidgetKind::ArcGauge {
                value,
                min,
                max,
                start_deg,
                end_deg,
                thickness: thickness.max(1),
                antialias,
                major_ticks: 6,
                minor_ticks: 2,
                show_value: false,
            },
            style,
        )
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_gauge<S>(
        &mut self,
        rect: Rect,
        value: f32,
        min: f32,
        max: f32,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(
            rect,
            WidgetKind::Gauge {
                value,
                min,
                max,
                major_ticks: 6,
                minor_ticks: 2,
                show_value: false,
            },
            style,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add_sweeping_arc<S>(
        &mut self,
        rect: Rect,
        progress: f32,
        clockwise: bool,
        arc_radius: u32,
        frame_inset: u16,
        corner_radius: u8,
        bg_color: Rgb565,
        arc_color: Rgb565,
        frame_color: Rgb565,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(
            rect,
            WidgetKind::SweepingArc {
                progress: progress.clamp(0.0, 1.0),
                clockwise,
                arc_radius,
                frame_inset,
                corner_radius,
                bg_color,
                arc_color,
                frame_color,
            },
            style,
        )
    }

    #[allow(clippy::too_many_arguments)]
    #[cfg(feature = "rich-widgets")]
    pub fn add_gauge_needle<S>(
        &mut self,
        rect: Rect,
        value: f32,
        min: f32,
        max: f32,
        start_deg: i32,
        end_deg: i32,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(
            rect,
            WidgetKind::GaugeNeedle {
                value,
                min,
                max,
                start_deg,
                end_deg,
            },
            style,
        )
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_chart<S>(
        &mut self,
        rect: Rect,
        values: &'a [f32],
        min: f32,
        max: f32,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(
            rect,
            WidgetKind::Chart {
                values,
                min,
                max,
                thickness: 1,
                fill_under: false,
                markers: false,
                mode: ChartMode::Line,
                show_grid: false,
                show_axes: false,
                show_labels: false,
            },
            style,
        )
    }

    pub fn add_plotter<S>(
        &mut self,
        rect: Rect,
        values: &'a [f32],
        head: usize,
        min: f32,
        max: f32,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(
            rect,
            WidgetKind::Plotter {
                values,
                head,
                min,
                max,
                thickness: 1,
                show_grid: false,
                show_axes: false,
            },
            style,
        )
    }

    pub fn add_themed_plotter(
        &mut self,
        rect: Rect,
        values: &'a [f32],
        head: usize,
        min: f32,
        max: f32,
    ) -> Result<WidgetId, GuiError> {
        self.add_plotter(rect, values, head, min, max, self.theme.panel)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn set_plotter_style(&mut self, id: WidgetId, thickness: u8) -> Result<(), GuiError> {
        let rect = self.absolute_rect(id).ok_or(GuiError::NotFound)?;
        let node = self.node_mut(id).ok_or(GuiError::NotFound)?;
        match node.kind {
            WidgetKind::Plotter {
                thickness: ref mut t,
                ..
            } => {
                *t = thickness.max(1);
                self.dirty.add(rect)?;
                Ok(())
            }
            _ => Err(GuiError::NotFound),
        }
    }

    #[cfg(feature = "rich-widgets")]
    pub fn set_plotter_decoration(
        &mut self,
        id: WidgetId,
        show_grid: bool,
        show_axes: bool,
    ) -> Result<(), GuiError> {
        let rect = self.absolute_rect(id).ok_or(GuiError::NotFound)?;
        let node = self.node_mut(id).ok_or(GuiError::NotFound)?;
        match node.kind {
            WidgetKind::Plotter {
                show_grid: ref mut grid,
                show_axes: ref mut axes,
                ..
            } => {
                *grid = show_grid;
                *axes = show_axes;
                self.dirty.add(rect)?;
                Ok(())
            }
            _ => Err(GuiError::NotFound),
        }
    }

    #[cfg(feature = "rich-widgets")]
    pub fn set_chart_style(
        &mut self,
        id: WidgetId,
        thickness: u8,
        fill_under: bool,
        markers: bool,
    ) -> Result<(), GuiError> {
        let rect = self.absolute_rect(id).ok_or(GuiError::NotFound)?;
        let node = self.node_mut(id).ok_or(GuiError::NotFound)?;
        match node.kind {
            WidgetKind::Chart {
                thickness: ref mut t,
                fill_under: ref mut fill,
                markers: ref mut mark,
                ..
            } => {
                *t = thickness.max(1);
                *fill = fill_under;
                *mark = markers;
                self.dirty.add(rect)?;
                Ok(())
            }
            _ => Err(GuiError::NotFound),
        }
    }

    #[cfg(feature = "rich-widgets")]
    pub fn set_chart_decoration(
        &mut self,
        id: WidgetId,
        mode: ChartMode,
        show_grid: bool,
        show_axes: bool,
        show_labels: bool,
    ) -> Result<(), GuiError> {
        let rect = self.absolute_rect(id).ok_or(GuiError::NotFound)?;
        let node = self.node_mut(id).ok_or(GuiError::NotFound)?;
        match node.kind {
            WidgetKind::Chart {
                mode: ref mut chart_mode,
                show_grid: ref mut grid,
                show_axes: ref mut axes,
                show_labels: ref mut labels,
                ..
            } => {
                *chart_mode = mode;
                *grid = show_grid;
                *axes = show_axes;
                *labels = show_labels;
                self.dirty.add(rect)?;
                Ok(())
            }
            _ => Err(GuiError::NotFound),
        }
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_spinner<S>(&mut self, rect: Rect, phase: f32, style: S) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(rect, WidgetKind::Spinner { phase }, style)
    }

    /// A wearable status bar showing the given clock string.
    #[cfg(feature = "rich-widgets")]
    pub fn add_status_bar<S>(
        &mut self,
        rect: Rect,
        time: &'a str,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(rect, WidgetKind::StatusBar { time }, style)
    }

    /// A 12- or 24-hour time picker.
    #[cfg(feature = "rich-widgets")]
    #[allow(clippy::too_many_arguments)]
    pub fn add_time_picker<S>(
        &mut self,
        rect: Rect,
        hour: u8,
        minute: u8,
        is_12h: bool,
        is_pm: bool,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(
            rect,
            WidgetKind::TimePicker {
                hour,
                minute,
                is_12h,
                is_pm,
            },
            style,
        )
    }

    /// A numeric range picker with a unit suffix.
    #[cfg(feature = "rich-widgets")]
    #[allow(clippy::too_many_arguments)]
    pub fn add_number_picker<S>(
        &mut self,
        rect: Rect,
        min: i32,
        max: i32,
        value: i32,
        unit: &'a str,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(
            rect,
            WidgetKind::NumberPicker {
                value: value.clamp(min.min(max), min.max(max)),
                min,
                max,
                unit,
            },
            style,
        )
    }

    /// An arrow hinting at scrollable content beyond the edge.
    #[cfg(feature = "rich-widgets")]
    pub fn add_content_indicator<S>(
        &mut self,
        rect: Rect,
        count: usize,
        active: usize,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(rect, WidgetKind::ContentIndicator { count, active }, style)
    }

    /// Pagination dots showing position in a set.
    #[cfg(feature = "rich-widgets")]
    pub fn add_crumbs_indicator<S>(
        &mut self,
        rect: Rect,
        count: usize,
        active: usize,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(rect, WidgetKind::Crumbs { count, active }, style)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_dropdown<S>(
        &mut self,
        rect: Rect,
        items: &'a [&'a str],
        selected: usize,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        let selected = selected.min(items.len().saturating_sub(1));
        let id = self.add_widget(
            rect,
            WidgetKind::Dropdown {
                items,
                selected,
                open: false,
            },
            style,
        )?;
        self.ensure_focus();
        Ok(id)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_roller<S>(
        &mut self,
        rect: Rect,
        items: &'a [&'a str],
        selected: usize,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_roller_with_selection(rect, items, selected, RollerSelection::default(), style)
    }

    /// A roller that says how a finger picks an item on it (`RollerSelection`).
    ///
    /// `add_roller` is the design that says nothing, and it gets `RollerSelection::Flick` — the gesture the
    /// roller has had here since 0.0.90, and the behaviour every design already written expects. This is the
    /// builder the markup uses when a design *does* say: `selection="touch"` on the roller. Upstream's
    /// `add_roller` keeps its signature, so a project that patches to this fork and writes plain markup still
    /// builds.
    #[cfg(feature = "rich-widgets")]
    pub fn add_roller_with_selection<S>(
        &mut self,
        rect: Rect,
        items: &'a [&'a str],
        selected: usize,
        selection: RollerSelection,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        let selected = selected.min(items.len().saturating_sub(1));
        let id = self.add_widget(
            rect,
            WidgetKind::Roller {
                items,
                selected,
                selection,
            },
            style,
        )?;
        self.ensure_focus();
        Ok(id)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_table<S>(
        &mut self,
        rect: Rect,
        rows: &'a [&'a [&'a str]],
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(
            rect,
            WidgetKind::Table {
                rows,
                separators: true,
                cell_padding: 1,
                align: TextAlign::Left,
            },
            style,
        )
    }

    #[cfg(feature = "rich-widgets")]
    pub fn set_table_style(
        &mut self,
        id: WidgetId,
        separators: bool,
        cell_padding: u8,
        align: TextAlign,
    ) -> Result<(), GuiError> {
        let rect = self.absolute_rect(id).ok_or(GuiError::NotFound)?;
        let node = self.node_mut(id).ok_or(GuiError::NotFound)?;
        match node.kind {
            WidgetKind::Table {
                separators: ref mut cell_sep,
                cell_padding: ref mut pad,
                align: ref mut table_align,
                ..
            } => {
                *cell_sep = separators;
                *pad = cell_padding.min(6);
                *table_align = align;
                self.dirty.add(rect)?;
                Ok(())
            }
            _ => Err(GuiError::NotFound),
        }
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_scale<S>(
        &mut self,
        rect: Rect,
        mode: ScaleMode,
        min: f32,
        max: f32,
        value: f32,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(
            rect,
            WidgetKind::Scale {
                mode,
                value: value.clamp(min, max),
                min,
                max,
                major_ticks: 5,
                minor_ticks: 3,
                start_angle: 135,
                end_angle: 45,
                show_labels: true,
                show_needle: true,
                tick_color: Rgb565::CSS_GRAY,
                needle_color: Rgb565::CSS_RED,
            },
            style,
        )
    }

    /// A graduated scale configured from the design: mode, range, tick counts, sweep and both colours.
    ///
    /// Upstream's `add_scale` hard-codes the tick and needle colours (`CSS_GRAY`/`CSS_RED`), the tick counts
    /// (`5`/`3`), the sweep (`135`..`45`) and the label/needle switches, so a gauge built with it looked the
    /// same whatever the design said. The runtime has always *carried* these on `WidgetKind::Scale`; this is
    /// the builder that lets generated code reach them.
    #[allow(clippy::too_many_arguments)]
    #[cfg(feature = "rich-widgets")]
    pub fn add_scale_styled<S>(
        &mut self,
        rect: Rect,
        mode: ScaleMode,
        min: f32,
        max: f32,
        value: f32,
        major_ticks: u8,
        minor_ticks: u8,
        start_angle: i16,
        end_angle: i16,
        show_labels: bool,
        show_needle: bool,
        tick_color: Rgb565,
        needle_color: Rgb565,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(
            rect,
            WidgetKind::Scale {
                mode,
                value: value.clamp(min, max),
                min,
                max,
                major_ticks: major_ticks.max(1),
                minor_ticks: minor_ticks.max(1),
                start_angle,
                end_angle,
                show_labels,
                show_needle,
                tick_color,
                needle_color,
            },
            style,
        )
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_radial_scale<S>(
        &mut self,
        rect: Rect,
        min: f32,
        max: f32,
        value: f32,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_scale(rect, ScaleMode::Radial, min, max, value, style)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_linear_scale<S>(
        &mut self,
        rect: Rect,
        min: f32,
        max: f32,
        value: f32,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_scale(rect, ScaleMode::LinearHorizontal, min, max, value, style)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_spinbox<S>(
        &mut self,
        rect: Rect,
        min: i32,
        max: i32,
        value: i32,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_spinbox_styled(
            rect,
            min,
            max,
            value,
            4,
            0,
            Rgb565::CSS_CYAN,
            Rgb565::CSS_GRAY,
            style,
        )
    }

    /// A spinbox built the way the design asked: how many digits it shows, how many of them are decimals, and
    /// the two colours upstream's `add_spinbox` hard-codes (`CSS_CYAN` for the focused digit's underline,
    /// `CSS_GRAY` for the two chevron outlines). Everything else -- the block, the value text and the `-`/`+`
    /// glyphs -- is already the resolved style.
    #[allow(clippy::too_many_arguments)]
    #[cfg(feature = "rich-widgets")]
    pub fn add_spinbox_styled<S>(
        &mut self,
        rect: Rect,
        min: i32,
        max: i32,
        value: i32,
        digits: u8,
        decimals: u8,
        accent_color: Rgb565,
        chevron_color: Rgb565,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(
            rect,
            WidgetKind::Spinbox {
                value: value.clamp(min, max),
                min,
                max,
                step: 1,
                digits: digits.max(1),
                decimals,
                focused_digit: 0,
                accent_color,
                chevron_color,
            },
            style,
        )
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_textarea<S>(
        &mut self,
        rect: Rect,
        text: &'a str,
        placeholder: &'a str,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        let cursor = text.chars().count();
        let (text_buf, text_len) = textarea_storage_from_str(text);
        let id = self.add_widget(
            rect,
            WidgetKind::TextArea {
                text_buf,
                text_len,
                cursor,
                placeholder,
                selection: None,
                cursor_visible: true,
                read_only: false,
                single_line: false,
                accept_newline: true,
            },
            style,
        )?;
        self.ensure_focus();
        Ok(id)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_keyboard<S>(
        &mut self,
        rect: Rect,
        keys: &'a [char],
        cols: u8,
        target: Option<WidgetId>,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_keyboard_with_alt(rect, keys, None, cols, target, style)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_keyboard_with_alt<S>(
        &mut self,
        rect: Rect,
        keys: &'a [char],
        alt_keys: Option<&'a [char]>,
        cols: u8,
        target: Option<WidgetId>,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        let id = self.add_widget(
            rect,
            WidgetKind::Keyboard {
                keys,
                selected: 0,
                cols: cols.max(1),
                alt_keys,
                layout: KeyboardLayout::Normal,
                target,
            },
            style,
        )?;
        self.ensure_focus();
        Ok(id)
    }

    pub fn add_image<S>(
        &mut self,
        rect: Rect,
        image: ImageRef<'a>,
        fit: ImageFit,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(rect, WidgetKind::Image { image, fit }, style)
    }

    /// Adds a wrap-around carousel. Drive `spec.shift` and `selected` from the
    /// caller's animation clock to scroll it.
    pub fn add_carousel<S>(
        &mut self,
        rect: Rect,
        items: &'a [&'a str],
        selected: usize,
        spec: CarouselSpec,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(
            rect,
            WidgetKind::Carousel {
                items,
                selected,
                spec,
            },
            style,
        )
    }

    /// Adds a multi-part 1bpp icon whose parts are toggled and tinted per state.
    pub fn add_composite_icon<S>(
        &mut self,
        rect: Rect,
        parts: &'a [IconPart<'a>],
        spec: CompositeIconSpec,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(rect, WidgetKind::CompositeIcon { parts, spec }, style)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_peek_reveal<S>(
        &mut self,
        rect: Rect,
        icon: ImageRef<'a>,
        title: &'a str,
        subtitle: &'a str,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(
            rect,
            WidgetKind::PeekReveal {
                icon,
                title,
                subtitle,
                progress: 0.0,
            },
            style,
        )
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_glance_tile<S>(
        &mut self,
        rect: Rect,
        icon: char,
        title: &'a str,
        subtitle: &'a str,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        let id = self.add_widget(
            rect,
            WidgetKind::GlanceTile {
                icon,
                title,
                subtitle,
                highlighted: false,
            },
            style,
        )?;
        self.ensure_focus();
        Ok(id)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_card_deck<S>(
        &mut self,
        rect: Rect,
        titles: &'a [&'a str],
        selected: usize,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(
            rect,
            WidgetKind::CardDeck {
                titles,
                selected: selected.min(titles.len().saturating_sub(1)),
            },
            style,
        )
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_reel<S>(
        &mut self,
        rect: Rect,
        player: ReelPlayer<'a>,
        fit: ImageFit,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(rect, WidgetKind::Reel { player, fit }, style)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_state_surface<S>(
        &mut self,
        rect: Rect,
        state: SurfaceState,
        title: &'a str,
        message: &'a str,
        action: Option<&'a str>,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(
            rect,
            WidgetKind::StateSurface {
                state,
                title,
                message,
                action,
                busy_phase: 0.0,
            },
            style,
        )
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_heads_up_banner<S>(
        &mut self,
        rect: Rect,
        level: NotificationLevel,
        text: &'a str,
        ttl_ms: u32,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(
            rect,
            WidgetKind::HeadsUpBanner {
                level,
                text,
                ttl_ms,
            },
            style,
        )
    }

    #[allow(clippy::too_many_arguments)]
    #[cfg(feature = "rich-widgets")]
    pub fn add_notification_action_sheet<S>(
        &mut self,
        rect: Rect,
        level: NotificationLevel,
        title: &'a str,
        body: &'a str,
        actions: &'a [&'a str],
        selected: usize,
        open: bool,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(
            rect,
            WidgetKind::NotificationActionSheet {
                level,
                title,
                body,
                actions,
                selected: selected.min(actions.len().saturating_sub(1)),
                open,
            },
            style,
        )
    }

    pub fn add_border<S>(&mut self, rect: Rect, style: S) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(rect, WidgetKind::Border, style)
    }

    pub fn add_spacer(&mut self, rect: Rect) -> Result<WidgetId, GuiError> {
        self.add_widget(rect, WidgetKind::Spacer, Style::default())
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_menu<S>(
        &mut self,
        rect: Rect,
        items: &'a [&'a str],
        selected: usize,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        let selected = selected.min(items.len().saturating_sub(1));
        let id = self.add_widget(rect, WidgetKind::Menu { items, selected }, style)?;
        self.ensure_focus();
        Ok(id)
    }

    #[cfg(feature = "rich-widgets")]
    pub fn add_rich_menu<S>(
        &mut self,
        rect: Rect,
        cells: &'a [MenuCell<'a>],
        selected: usize,
        visible_rows: usize,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        let selected = selected.min(cells.len().saturating_sub(1));
        let id = self.add_widget(
            rect,
            WidgetKind::RichMenu {
                cells,
                selected,
                offset: selected,
                visible_rows: visible_rows.max(1),
            },
            style,
        )?;
        self.ensure_focus();
        Ok(id)
    }

    pub fn add_dial<S>(
        &mut self,
        rect: Rect,
        value: f32,
        min: f32,
        max: f32,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        let value = value.clamp(min, max);
        let id = self.add_widget(rect, WidgetKind::Dial { value, min, max }, style)?;
        self.ensure_focus();
        Ok(id)
    }

    pub fn add_themed_dial(
        &mut self,
        rect: Rect,
        value: f32,
        min: f32,
        max: f32,
    ) -> Result<WidgetId, GuiError> {
        self.add_dial(rect, value, min, max, self.theme.button)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add_rle_player<S>(
        &mut self,
        rect: impl Into<Rect>,
        rle_data: &'static [u8],
        frame_width: u16,
        frame_height: u16,
        total_frames: usize,
        frame_duration_ms: u32,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        self.add_widget(
            rect,
            WidgetKind::RlePlayer {
                rle_data,
                frame_width,
                frame_height,
                total_frames,
                current_frame: 0,
                elapsed_ms: 0,
                frame_duration_ms,
            },
            style,
        )
    }

    pub fn add_themed_rle_player(
        &mut self,
        rect: Rect,
        rle_data: &'static [u8],
        frame_width: u16,
        frame_height: u16,
        total_frames: usize,
        frame_duration_ms: u32,
    ) -> Result<WidgetId, GuiError> {
        self.add_rle_player(
            rect,
            rle_data,
            frame_width,
            frame_height,
            total_frames,
            frame_duration_ms,
            self.theme.panel,
        )
    }

    pub fn add_autocomplete_widget<S>(
        &mut self,
        rect: Rect,
        suggestions: &'a [&'a str],
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        let id = self.add_widget(
            rect,
            WidgetKind::AutoComplete {
                text_buf: [0; 32],
                text_len: 0,
                suggestions,
                filtered: [None; 8],
                filter_count: 0,
                selected: None,
                expanded: false,
            },
            style,
        )?;
        self.ensure_focus();
        Ok(id)
    }

    pub fn add_themed_autocomplete(
        &mut self,
        rect: Rect,
        suggestions: &'a [&'a str],
    ) -> Result<WidgetId, GuiError> {
        self.add_autocomplete_widget(rect, suggestions, self.theme.panel)
    }
}

/// The vendored fork's own tests: the values a design can now name, and the gauge that could not be moved.
///
/// These render through the real `GuiContext` and read pixels back, because the point of the changes is what
/// reaches the glass, not what reaches a struct field. `add_*` upstream builders keep passing the old
/// constants, so a markup that says nothing about any of this renders exactly as it did before the fork --
/// that is asserted here too, or the fork would be a behaviour change rather than an addition.
#[cfg(all(test, feature = "rich-widgets"))]
mod fork_tests {
    use super::*;
    use crate::style::Style;
    use crate::widget::{PropertyKey, PropertyValue};
    use crate::TestBuffer;
    use embedded_graphics_core::pixelcolor::{RgbColor, WebColors};

    fn gui() -> GuiContext<'static, 32, 16, 32> {
        GuiContext::<32, 16, 32>::new(Rect::new(0, 0, 200, 80))
    }

    fn render(gui: &GuiContext<'static, 32, 16, 32>) -> TestBuffer {
        let mut buffer = TestBuffer::new(200, 80);
        gui.render(&mut buffer).expect("the design renders");
        buffer
    }

    #[test]
    fn a_checkbox_box_can_be_sized_and_the_upstream_builder_still_caps_at_eight() {
        // Upstream's rule is `inner.h.min(8)`, which is why a checkbox on a 24-pixel row drew an eight-pixel
        // box. A design can now name the size.
        let mut small = gui();
        small
            .add_checkbox_sized(
                Rect::new(0, 0, 80, 20),
                "x",
                true,
                0,
                0,
                CheckboxLabelPosition::Right,
                None,
                Style::label(),
            )
            .unwrap();
        let big = {
            let mut gui = gui();
            gui.add_checkbox_sized(
                Rect::new(0, 0, 80, 20),
                "x",
                true,
                16,
                16,
                CheckboxLabelPosition::Right,
                None,
                Style::label(),
            )
            .unwrap();
            gui
        };
        // The box outline is `style.text` (white) on a label style, and the tick inside it is `style.accent`.
        // Counting the outline's pixels is what separates a 16-pixel box from an 8-pixel one: 4*size - 4,
        // give or take the corners the tick covers.
        let outline = |buffer: &TestBuffer| {
            (0..20)
                .flat_map(|y| (0..20).map(move |x| (x, y)))
                .filter(|&(x, y)| buffer.pixel_at(x, y) == Some(Rgb565::WHITE))
                .count()
        };
        let small_box = outline(&render(&small));
        let big_box = outline(&render(&big));
        assert!(
            big_box > small_box,
            "a 16-pixel box must draw more outline than an 8-pixel one: {big_box} vs {small_box}"
        );
        assert!(small_box > 0, "the default box is still drawn");
        // And a box taller than its row cannot escape it: the engine clips, and the canvas could not show it.
        let mut capped = gui();
        capped
            .add_checkbox_sized(
                Rect::new(0, 0, 80, 12),
                "x",
                false,
                40,
                40,
                CheckboxLabelPosition::Right,
                None,
                Style::label(),
            )
            .unwrap();
        let pixels = render(&capped);
        assert_eq!(
            pixels.pixel_at(0, 11),
            Some(Rgb565::WHITE),
            "a 40-pixel box in a 12-pixel row is capped to the row, and its outline is on the last row"
        );
        assert_eq!(
            pixels.pixel_at(0, 12),
            Some(Rgb565::BLACK),
            "and nothing is below it"
        );
    }

    #[test]
    fn the_switches_track_colours_come_from_the_design() {
        let style = Style::new();
        let mut off = gui();
        off.add_toggle_colored(
            Rect::new(0, 0, 80, 20),
            "x",
            false,
            Rgb565::CSS_BLUE,
            None,
            0,
            style,
        )
        .unwrap();
        let mut on = gui();
        on.add_toggle_colored(
            Rect::new(0, 0, 80, 20),
            "x",
            true,
            Rgb565::CSS_BLUE,
            None,
            0,
            style,
        )
        .unwrap();
        let has_blue = |gui: &GuiContext<'static, 32, 16, 32>| {
            let buffer = render(gui);
            (0..20)
                .flat_map(|y| (0..80).map(move |x| (x, y)))
                .any(|(x, y)| buffer.pixel_at(x, y) == Some(Rgb565::CSS_BLUE))
        };
        assert!(
            has_blue(&off),
            "an off switch paints its design's track colour"
        );
        // The on colour is `style.accent`, as upstream, so the design's colour is *replaced* rather than added.
        assert!(
            !has_blue(&on),
            "an on switch uses the style's accent, not the off colour"
        );
        assert_eq!(
            style.accent,
            Style::new().accent,
            "and the two agree on what that is"
        );
    }

    #[test]
    fn a_spinbox_underline_and_chevrons_use_the_colours_the_design_names() {
        let mut plain = gui();
        plain
            .add_spinbox(Rect::new(0, 0, 100, 20), 0, 100, 42, Style::label())
            .unwrap();
        let mut styled = gui();
        styled
            .add_spinbox_styled(
                Rect::new(0, 0, 100, 20),
                0,
                100,
                42,
                4,
                0,
                Rgb565::CSS_ORANGE,
                Rgb565::CSS_PURPLE,
                Style::label(),
            )
            .unwrap();
        let has = |gui: &GuiContext<'static, 32, 16, 32>, colour: Rgb565| {
            let buffer = render(gui);
            (0..20)
                .flat_map(|y| (0..100).map(move |x| (x, y)))
                .any(|(x, y)| buffer.pixel_at(x, y) == Some(colour))
        };
        assert!(
            has(&plain, Rgb565::CSS_CYAN),
            "upstream's underline is still the default"
        );
        assert!(
            has(&plain, Rgb565::CSS_GRAY),
            "and so are its chevron outlines"
        );
        assert!(
            has(&styled, Rgb565::CSS_ORANGE),
            "the design's underline is used"
        );
        assert!(
            has(&styled, Rgb565::CSS_PURPLE),
            "and the design's chevron colour"
        );
        assert!(
            !has(&styled, Rgb565::CSS_CYAN),
            "instead of the upstream one"
        );
    }

    #[test]
    fn a_spinbox_shows_the_number_of_digits_the_design_asked_for() {
        // `digits` and `decimals` reach the renderer's formatter, which is the difference between a design that
        // says "four digits" and one that says "six": `add_spinbox` fixed both at 4 and 0, so a design could not
        // change them however the panel was set.
        let white = |gui: &GuiContext<'static, 32, 16, 32>| {
            let buffer = render(gui);
            (0..20)
                .flat_map(|y| (0..100).map(move |x| (x, y)))
                .filter(|&(x, y)| buffer.pixel_at(x, y) == Some(Rgb565::WHITE))
                .count()
        };
        let mut one = gui();
        one.add_spinbox_styled(
            Rect::new(0, 0, 100, 20),
            0,
            99,
            42,
            1,
            0,
            Rgb565::CSS_CYAN,
            Rgb565::CSS_GRAY,
            Style::label(),
        )
        .unwrap();
        let mut six = gui();
        six.add_spinbox_styled(
            Rect::new(0, 0, 100, 20),
            0,
            99,
            42,
            6,
            0,
            Rgb565::CSS_CYAN,
            Rgb565::CSS_GRAY,
            Style::label(),
        )
        .unwrap();
        assert!(
            white(&six) > white(&one),
            "six digits must paint more text than one: {} vs {}",
            white(&six),
            white(&one)
        );
    }

    #[test]
    fn a_scale_is_built_from_the_design_and_its_value_moves() {
        let mut gui = gui();
        let id = gui
            .add_scale_styled(
                Rect::new(0, 0, 100, 100),
                ScaleMode::Radial,
                0.0,
                100.0,
                25.0,
                4,
                2,
                180,
                0,
                false,
                true,
                Rgb565::CSS_ORANGE,
                Rgb565::CSS_BLUE,
                Style::label(),
            )
            .unwrap();
        // The whole point of a gauge: its value is readable and writable after it is built. Upstream answered
        // `NotFound` to both, because the node dispatch had no arm for a scale.
        assert_eq!(
            gui.get_widget_property(id, PropertyKey::Value),
            Some(PropertyValue::Float(25.0))
        );
        gui.set_widget_property(id, PropertyKey::Value, PropertyValue::Float(80.0))
            .expect("a gauge's value can be set");
        assert_eq!(
            gui.get_widget_property(id, PropertyKey::Value),
            Some(PropertyValue::Float(80.0))
        );
        // Clamped to the range, like every other value widget.
        gui.set_widget_property(id, PropertyKey::Value, PropertyValue::Float(500.0))
            .unwrap();
        assert_eq!(
            gui.get_widget_property(id, PropertyKey::Value),
            Some(PropertyValue::Float(100.0))
        );

        // And the colours the design named are the ones on the glass. The needle is at 100 now: the top of a
        // 180..0 sweep is the top of the dial, so orange ticks and a blue needle are both somewhere in the
        // buffer.
        let buffer = render(&gui);
        let drawn = |colour: Rgb565| {
            (0..100)
                .flat_map(|y| (0..100).map(move |x| (x, y)))
                .any(|(x, y)| buffer.pixel_at(x, y) == Some(colour))
        };
        assert!(
            drawn(Rgb565::CSS_ORANGE),
            "the ticks are the design's colour"
        );
        assert!(drawn(Rgb565::CSS_BLUE), "and the needle is too");
        assert!(!drawn(Rgb565::CSS_GRAY), "not upstream's grey ticks");
    }

    #[test]
    fn a_scale_value_change_dirties_only_the_needle_sweep() {
        let mut gui = gui();
        let widget = Rect::new(0, 0, 100, 100);
        // `Style::panel()` is opaque, so the dirty repaint of the band erases the
        // old needle -- the result must be pixel-identical to a full paint at the
        // new value. That only holds if the band covers the old + new needle.
        let id = gui
            .add_scale_styled(
                widget,
                ScaleMode::Radial,
                0.0,
                100.0,
                25.0,
                4,
                2,
                180,
                0,
                false,
                true,
                Rgb565::CSS_ORANGE,
                Rgb565::CSS_BLUE,
                Style::panel(),
            )
            .unwrap();

        // Baseline: the full dial painted at value 25.
        let mut base = TestBuffer::new(200, 80);
        gui.render(&mut base)
            .expect("baseline paints the whole dial");
        gui.clear_dirty();

        // Move the needle 25 -> 80. The designer now marks only the needle's sweep
        // dirty, not the entire dial -- a strict sub-rectangle of the widget.
        gui.set_widget_property(id, PropertyKey::Value, PropertyValue::Float(80.0))
            .expect("a gauge's value can be set");
        let dirty = gui.dirty_regions();
        assert_eq!(dirty.len(), 1, "a value change should dirty one band");
        let region = dirty[0];
        assert!(
            region.x >= widget.x
                && region.y >= widget.y
                && region.right() <= widget.right()
                && region.bottom() <= widget.bottom(),
            "needle dirty region {region:?} must stay inside the widget {widget:?}"
        );
        assert!(
            region.w * region.h < widget.w * widget.h / 2,
            "needle dirty region {region:?} must be a small part of the widget {widget:?}"
        );

        // The dirty render repaints only that band: because the panel background is
        // opaque, the old needle is erased and the new one drawn, so the result is
        // pixel-identical to a full render at the new value.
        let mut frame = base.clone();
        gui.render_dirty(&mut frame)
            .expect("the dirty band repaints");
        let mut full = TestBuffer::new(200, 80);
        gui.render(&mut full).expect("full render at the new value");
        assert_eq!(
            frame, full,
            "dirty repaint must reproduce a full paint at the new value"
        );
    }

    /// Whether any pixel of `rect` is not the buffer's background, i.e. the widget drew in its own cell.
    fn cell_has_ink(buffer: &TestBuffer, rect: Rect) -> bool {
        (rect.y..rect.bottom())
            .flat_map(|y| (rect.x..rect.right()).map(move |x| (x, y)))
            .any(|(x, y)| {
                buffer
                    .pixel_at(x, y)
                    .is_some_and(|pixel| pixel != Rgb565::BLACK)
            })
    }

    fn cell_has_colour(buffer: &TestBuffer, rect: Rect, colour: Rgb565) -> bool {
        (rect.y..rect.bottom())
            .flat_map(|y| (rect.x..rect.right()).map(move |x| (x, y)))
            .any(|(x, y)| buffer.pixel_at(x, y) == Some(colour))
    }

    #[test]
    fn a_toggles_track_outline_is_drawn_only_when_asked_for() {
        let red = Rgb565::CSS_RED;
        let has_red = |gui: &GuiContext<'static, 32, 16, 32>| {
            let buffer = render(gui);
            cell_has_colour(&buffer, Rect::new(0, 0, 80, 20), red)
        };
        let mut outlined = gui();
        outlined
            .add_toggle_colored(
                Rect::new(0, 0, 80, 20),
                "x",
                false,
                Rgb565::CSS_BLUE,
                Some(red),
                1,
                Style::new(),
            )
            .unwrap();
        assert!(
            has_red(&outlined),
            "the track outlines in the colour asked for"
        );

        // Neither a missing colour nor a zero width may draw an outline: `add_toggle` passes `None, 0`, so
        // its output has to stay exactly what upstream drew.
        let mut absent = gui();
        absent
            .add_toggle_colored(
                Rect::new(0, 0, 80, 20),
                "x",
                false,
                Rgb565::CSS_BLUE,
                None,
                1,
                Style::new(),
            )
            .unwrap();
        assert!(!has_red(&absent), "no colour means no outline");

        let mut zero = gui();
        zero.add_toggle_colored(
            Rect::new(0, 0, 80, 20),
            "x",
            false,
            Rgb565::CSS_BLUE,
            Some(red),
            0,
            Style::new(),
        )
        .unwrap();
        assert!(!has_red(&zero), "a zero width means no outline");
    }

    #[test]
    fn each_new_widget_paints_inside_its_cell() {
        let mut design = gui();
        let status = Rect::new(0, 0, 120, 18);
        let time = Rect::new(0, 20, 120, 24);
        let number = Rect::new(0, 46, 120, 18);
        let content = Rect::new(140, 0, 40, 30);
        let crumbs = Rect::new(140, 40, 40, 20);
        design
            .add_status_bar(status, "10:42", Style::new())
            .unwrap();
        design
            .add_time_picker(time, 10, 30, true, false, Style::new())
            .unwrap();
        design
            .add_number_picker(number, 0, 100, 42, "BPM", Style::new())
            .unwrap();
        design
            .add_content_indicator(content, 3, 1, Style::new())
            .unwrap();
        design
            .add_crumbs_indicator(crumbs, 5, 2, Style::new())
            .unwrap();

        let buffer = render(&design);
        assert!(
            cell_has_ink(&buffer, status),
            "a status bar paints its strip"
        );
        assert!(
            cell_has_ink(&buffer, time),
            "a time picker paints its cells"
        );
        assert!(
            cell_has_ink(&buffer, number),
            "a number picker paints its card"
        );
        assert!(
            cell_has_ink(&buffer, content),
            "a content indicator paints its arrow"
        );
        assert!(cell_has_ink(&buffer, crumbs), "crumbs paint their dots");
    }

    #[test]
    fn the_new_widgets_properties_can_be_read_and_written() {
        let mut gui = gui();
        let bar = gui
            .add_status_bar(Rect::new(0, 0, 120, 18), "10:42", Style::new())
            .unwrap();
        assert_eq!(
            gui.get_widget_property(bar, PropertyKey::Text),
            Some(PropertyValue::Str("10:42"))
        );
        gui.set_widget_property(bar, PropertyKey::Text, PropertyValue::Str("07:15"))
            .expect("a status bar's clock string can be set");
        assert_eq!(
            gui.get_widget_property(bar, PropertyKey::Text),
            Some(PropertyValue::Str("07:15"))
        );

        let picker = gui
            .add_number_picker(Rect::new(0, 20, 120, 18), 0, 100, 42, "BPM", Style::new())
            .unwrap();
        assert_eq!(
            gui.get_widget_property(picker, PropertyKey::Value),
            Some(PropertyValue::Int(42))
        );
        assert_eq!(
            gui.get_widget_property(picker, PropertyKey::Min),
            Some(PropertyValue::Int(0))
        );
        assert_eq!(
            gui.get_widget_property(picker, PropertyKey::Max),
            Some(PropertyValue::Int(100))
        );
        gui.set_widget_property(picker, PropertyKey::Value, PropertyValue::Int(7))
            .expect("a number picker's value can be set");
        assert_eq!(
            gui.get_widget_property(picker, PropertyKey::Value),
            Some(PropertyValue::Int(7))
        );
        // Out of range clamps against the range the design named, as the spinbox and the gauge do.
        gui.set_widget_property(picker, PropertyKey::Value, PropertyValue::Int(500))
            .unwrap();
        assert_eq!(
            gui.get_widget_property(picker, PropertyKey::Value),
            Some(PropertyValue::Int(100))
        );

        let content = gui
            .add_content_indicator(Rect::new(140, 0, 40, 30), 4, 0, Style::new())
            .unwrap();
        assert_eq!(
            gui.get_widget_property(content, PropertyKey::Selected),
            Some(PropertyValue::Usize(0))
        );
        gui.set_widget_property(content, PropertyKey::Selected, PropertyValue::Usize(3))
            .expect("a content indicator's active step can be set");
        assert_eq!(
            gui.get_widget_property(content, PropertyKey::Selected),
            Some(PropertyValue::Usize(3))
        );

        let crumbs = gui
            .add_crumbs_indicator(Rect::new(140, 40, 40, 20), 5, 1, Style::new())
            .unwrap();
        let first = render(&gui);
        gui.set_widget_property(crumbs, PropertyKey::Selected, PropertyValue::Usize(4))
            .expect("a crumbs indicator's active dot can be set");
        assert_eq!(
            gui.get_widget_property(crumbs, PropertyKey::Selected),
            Some(PropertyValue::Usize(4))
        );
        assert_ne!(
            first,
            render(&gui),
            "moving the selection moves the highlighted dot"
        );
        // Selecting beyond the set lands on the last dot rather than on none of them.
        gui.set_widget_property(crumbs, PropertyKey::Selected, PropertyValue::Usize(99))
            .unwrap();
        assert_eq!(
            gui.get_widget_property(crumbs, PropertyKey::Selected),
            Some(PropertyValue::Usize(4))
        );
    }

    #[test]
    fn a_new_widgets_style_reaches_the_glass() {
        let accent = Rgb565::CSS_ORANGE;
        let has_accent = |gui: &GuiContext<'static, 32, 16, 32>| {
            let buffer = render(gui);
            cell_has_colour(&buffer, Rect::new(0, 0, 120, 30), accent)
        };
        let mut styled = gui();
        styled
            .add_time_picker(
                Rect::new(0, 0, 120, 30),
                10,
                30,
                true,
                false,
                Style::label().with_accent(accent),
            )
            .unwrap();
        assert!(
            has_accent(&styled),
            "the time picker's focused cell uses the style's accent"
        );

        let mut plain = gui();
        plain
            .add_time_picker(
                Rect::new(0, 0, 120, 30),
                10,
                30,
                true,
                false,
                Style::label(),
            )
            .unwrap();
        assert!(!has_accent(&plain), "the default accent is not that colour");
    }
}
