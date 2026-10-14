#![allow(unused_imports)]

#[cfg(not(feature = "std"))]
use crate::math::F32Ext as _;
use crate::{
    geometry::Rect,
    haptics::HapticPattern,
    input::{
        InputEvent, NavDirection, PointerState, UiEvent, UiEventFilter, WidgetDispatchPolicy,
        WidgetEvent, WidgetEventKind,
    },
    state::{FeedTimelineState, ListState, ScrollState, SliderState, TabsState},
    style::{VisualState, WidgetStyle},
    widget::{EventPhase, EventPolicy, WidgetId},
    widgets::{KeyboardLayout, WidgetKind, WidgetNode, ROLLER_ROWS, TEXTAREA_CAPACITY},
};

use super::*;

impl<'a, const NODES: usize, const EVENTS: usize, const DIRTY: usize>
    GuiContext<'a, NODES, EVENTS, DIRTY>
{
    pub fn handle_input(&mut self, event: InputEvent) -> Result<(), GuiError> {
        match event {
            InputEvent::Home => {
                if let Some(_id) = self.focus {
                    #[cfg(feature = "rich-widgets")]
                    if matches!(
                        self.node(_id).map(|n| n.kind),
                        Some(WidgetKind::TextArea { .. })
                    ) {
                        self.set_textarea_cursor_line_home(_id)?;
                        return Ok(());
                    }
                }
                Ok(())
            }
            InputEvent::End => {
                if let Some(_id) = self.focus {
                    #[cfg(feature = "rich-widgets")]
                    if matches!(
                        self.node(_id).map(|n| n.kind),
                        Some(WidgetKind::TextArea { .. })
                    ) {
                        self.set_textarea_cursor_line_end(_id)?;
                        return Ok(());
                    }
                }
                Ok(())
            }
            InputEvent::WordLeft => {
                if let Some(_id) = self.focus {
                    #[cfg(feature = "rich-widgets")]
                    if matches!(
                        self.node(_id).map(|n| n.kind),
                        Some(WidgetKind::TextArea { .. })
                    ) {
                        self.move_textarea_cursor_word(_id, -1)?;
                        return Ok(());
                    }
                }
                Ok(())
            }
            InputEvent::WordRight => {
                if let Some(_id) = self.focus {
                    #[cfg(feature = "rich-widgets")]
                    if matches!(
                        self.node(_id).map(|n| n.kind),
                        Some(WidgetKind::TextArea { .. })
                    ) {
                        self.move_textarea_cursor_word(_id, 1)?;
                        return Ok(());
                    }
                }
                Ok(())
            }
            InputEvent::Undo => {
                if let Some(_id) = self.focus {
                    #[cfg(feature = "rich-widgets")]
                    if matches!(
                        self.node(_id).map(|n| n.kind),
                        Some(WidgetKind::TextArea { .. })
                    ) {
                        self.textarea_undo(_id)?;
                    }
                }
                Ok(())
            }
            InputEvent::Redo => {
                if let Some(_id) = self.focus {
                    #[cfg(feature = "rich-widgets")]
                    if matches!(
                        self.node(_id).map(|n| n.kind),
                        Some(WidgetKind::TextArea { .. })
                    ) {
                        self.textarea_redo(_id)?;
                    }
                }
                Ok(())
            }
            InputEvent::SelectLeft => {
                if let Some(_id) = self.focus {
                    #[cfg(feature = "rich-widgets")]
                    if matches!(
                        self.node(_id).map(|n| n.kind),
                        Some(WidgetKind::TextArea { .. })
                    ) {
                        self.move_textarea_cursor_select(_id, -1)?;
                        return Ok(());
                    }
                }
                Ok(())
            }
            InputEvent::SelectRight => {
                if let Some(_id) = self.focus {
                    #[cfg(feature = "rich-widgets")]
                    if matches!(
                        self.node(_id).map(|n| n.kind),
                        Some(WidgetKind::TextArea { .. })
                    ) {
                        self.move_textarea_cursor_select(_id, 1)?;
                        return Ok(());
                    }
                }
                Ok(())
            }
            InputEvent::SelectHome => {
                if let Some(_id) = self.focus {
                    #[cfg(feature = "rich-widgets")]
                    if matches!(
                        self.node(_id).map(|n| n.kind),
                        Some(WidgetKind::TextArea { .. })
                    ) {
                        self.set_textarea_cursor_line_home_select(_id)?;
                        return Ok(());
                    }
                }
                Ok(())
            }
            InputEvent::SelectEnd => {
                if let Some(_id) = self.focus {
                    #[cfg(feature = "rich-widgets")]
                    if matches!(
                        self.node(_id).map(|n| n.kind),
                        Some(WidgetKind::TextArea { .. })
                    ) {
                        self.set_textarea_cursor_line_end_select(_id)?;
                        return Ok(());
                    }
                }
                Ok(())
            }
            InputEvent::SelectWordLeft => {
                if let Some(_id) = self.focus {
                    #[cfg(feature = "rich-widgets")]
                    if matches!(
                        self.node(_id).map(|n| n.kind),
                        Some(WidgetKind::TextArea { .. })
                    ) {
                        self.move_textarea_cursor_word_select(_id, -1)?;
                        return Ok(());
                    }
                }
                Ok(())
            }
            InputEvent::SelectWordRight => {
                if let Some(_id) = self.focus {
                    #[cfg(feature = "rich-widgets")]
                    if matches!(
                        self.node(_id).map(|n| n.kind),
                        Some(WidgetKind::TextArea { .. })
                    ) {
                        self.move_textarea_cursor_word_select(_id, 1)?;
                        return Ok(());
                    }
                }
                Ok(())
            }
            InputEvent::Up => {
                if !self.adjust_focused_selection(-1)?
                    && !self.move_focus_direction(NavDirection::Up)?
                {
                    self.focus_prev()?;
                }
                Ok(())
            }
            InputEvent::Down => {
                if !self.adjust_focused_selection(1)?
                    && !self.move_focus_direction(NavDirection::Down)?
                {
                    self.focus_next()?;
                }
                Ok(())
            }
            InputEvent::Left => {
                if !self.adjust_focused_scalar(-1.0)?
                    && !self.move_focus_direction(NavDirection::Left)?
                {
                    self.focus_prev()?;
                }
                Ok(())
            }
            InputEvent::Right => {
                if !self.adjust_focused_scalar(1.0)?
                    && !self.move_focus_direction(NavDirection::Right)?
                {
                    self.focus_next()?;
                }
                Ok(())
            }
            InputEvent::Encoder { delta } if delta > 0 => {
                if !self.adjust_focused_selection(1)? {
                    self.focus_next()?;
                }
                Ok(())
            }
            InputEvent::Encoder { delta } if delta < 0 => {
                if !self.adjust_focused_selection(-1)? {
                    self.focus_prev()?;
                }
                Ok(())
            }
            InputEvent::Select => {
                if let Some(id) = self.focus {
                    match self.key_bindings_for(id).select {
                        KeyBindingAction::Default | KeyBindingAction::Activate => {
                            self.handle_select_activation(id)?
                        }
                        KeyBindingAction::Back => self.handle_back_action()?,
                        KeyBindingAction::Ignore => {}
                    }
                }
                Ok(())
            }
            InputEvent::SelectPressed => {
                if let Some(id) = self.focus {
                    if self.key_input_policy_for(id).raw_select {
                        self.dispatch_key_pressed(id)?;
                    }
                }
                Ok(())
            }
            InputEvent::SelectReleased => {
                if let Some(id) = self.focus {
                    if self.key_input_policy_for(id).raw_select {
                        self.dispatch_key_released(id)?;
                        self.handle_select_activation(id)?;
                    }
                }
                Ok(())
            }
            InputEvent::Back => {
                if let Some(id) = self.focus {
                    match self.key_bindings_for(id).back {
                        KeyBindingAction::Default | KeyBindingAction::Back => {
                            self.handle_back_action()
                        }
                        KeyBindingAction::Activate => self.handle_select_activation(id),
                        KeyBindingAction::Ignore => Ok(()),
                    }
                } else {
                    self.handle_back_action()
                }
            }
            InputEvent::BackPressed => {
                if let Some(id) = self.focus {
                    if self.key_input_policy_for(id).raw_back {
                        self.dispatch_key_pressed(id)?;
                    }
                }
                Ok(())
            }
            InputEvent::BackReleased => {
                if let Some(id) = self.focus {
                    if self.key_input_policy_for(id).raw_back {
                        self.dispatch_key_released(id)?;
                        return self.handle_back_action();
                    }
                }
                Ok(())
            }
            InputEvent::Pointer {
                x,
                y,
                state: PointerState::Pressed,
                ..
            } => self.handle_pointer_pressed(x, y),
            InputEvent::Pointer {
                x,
                y,
                state: PointerState::Released,
                ..
            } => self.handle_pointer_released(x, y),
            InputEvent::Pointer {
                x,
                y,
                state: PointerState::Moved,
                ..
            } => self.handle_pointer_moved(x, y),
            _ => Ok(()),
        }
    }

    pub fn tick_input(&mut self, dt_ms: u32) -> Result<(), GuiError> {
        if self.last_select_id.is_some() {
            self.select_elapsed_ms = self.select_elapsed_ms.saturating_add(dt_ms);
            if self.select_elapsed_ms > self.select_double_window_ms {
                self.last_select_id = None;
                self.select_elapsed_ms = 0;
            }
        }
        if self.last_pointer_id.is_some() {
            self.pointer_elapsed_ms = self.pointer_elapsed_ms.saturating_add(dt_ms);
            if self.pointer_elapsed_ms > self.pointer_double_window_ms {
                self.last_pointer_id = None;
                self.pointer_elapsed_ms = 0;
            }
        }
        self.tick_state_transitions(dt_ms)?;
        self.tick_theme_transition(dt_ms)?;
        self.haptic_sequencer.tick(dt_ms);
        self.tick_rle_animations(dt_ms)?;
        #[cfg(feature = "rich-widgets")]
        if let Some(mut inertia) = self.inertia_scroll {
            if inertia.velocity.abs() < self.scroll_physics.velocity_threshold {
                self.inertia_scroll = None;
                self.maybe_start_scroll_spring_back(inertia.id);
            } else {
                let current = self.scroll_offset(inertia.id).unwrap_or(0);
                let delta = (inertia.velocity * (dt_ms as f32 / 16.0)).round() as i32;
                if delta != 0 {
                    let next = if self.scroll_physics.rubber_band {
                        self.scroll_by_rubber_band(inertia.id, -delta)?
                    } else {
                        let target = current.saturating_sub(delta);
                        self.set_scroll_offset(inertia.id, target)?;
                        self.scroll_offset(inertia.id).unwrap_or(current)
                    };
                    if next != current {
                        self.push_event(UiEvent::Scroll {
                            id: inertia.id,
                            delta: next - current,
                        })?;
                    }
                }
                inertia.velocity *= self
                    .scroll_physics
                    .velocity_decay
                    .powf((dt_ms as f32 / 16.0).max(1.0));
                self.inertia_scroll = Some(inertia);
            }
        }
        #[cfg(feature = "rich-widgets")]
        if let Some(mut back) = self.scroll_spring_back {
            let current = self
                .scroll_offset(back.id)
                .unwrap_or(back.spring.value as i32);
            let value = back.spring.tick(dt_ms);
            let done = back.spring.is_done();
            let next = if done {
                back.spring.target as i32
            } else {
                value.round() as i32
            };
            if next != current {
                self.set_scroll_offset_raw(back.id, next)?;
                self.push_event(UiEvent::Scroll {
                    id: back.id,
                    delta: next - current,
                })?;
            }
            self.scroll_spring_back = if done { None } else { Some(back) };
        }
        #[cfg(feature = "rich-widgets")]
        self.tick_textarea_cursor_blink(dt_ms)?;
        let Some(mut pressed) = self.pressed else {
            return Ok(());
        };
        if !self.effective_visible(pressed.id) || !self.effective_enabled(pressed.id) {
            self.pressed = None;
            return Ok(());
        }
        let timing = self.press_timing_for(pressed.id);
        pressed.elapsed_ms = pressed.elapsed_ms.saturating_add(dt_ms);
        pressed.repeat_elapsed_ms = pressed.repeat_elapsed_ms.saturating_add(dt_ms);
        if !pressed.long_emitted && pressed.elapsed_ms >= timing.long_press_ms {
            let mut events = heapless::Vec::<WidgetEvent, NODES>::new();
            self.dispatch_widget_event(
                pressed.id,
                WidgetEventKind::LongPressed,
                &mut events,
                |_| EventPolicy::Continue,
            )?;
            self.push_event(UiEvent::LongPressed(pressed.id))?;
            self.play_haptic(HapticPattern::LongPress);
            pressed.long_emitted = true;
        }
        if pressed.repeat_elapsed_ms >= timing.repeat_delay_ms
            && self.repeatable_widget(pressed.id)
            && pressed.long_emitted
        {
            let intervals =
                (pressed.repeat_elapsed_ms - timing.repeat_delay_ms) / timing.repeat_interval_ms;
            if intervals > 0 {
                self.dispatch_repeat_activation(pressed.id)?;
                pressed.repeat_elapsed_ms = timing.repeat_delay_ms;
            }
        }
        self.pressed = Some(pressed);
        Ok(())
    }

    pub fn pop_event(&mut self) -> Option<UiEvent> {
        if self.events.is_empty() {
            None
        } else {
            Some(self.events.remove(0))
        }
    }

    pub fn set_event_filter(
        &mut self,
        id: WidgetId,
        filter: UiEventFilter,
    ) -> Result<(), GuiError> {
        self.node(id).ok_or(GuiError::NotFound)?;
        if let Some((_, current)) = self
            .subscriptions
            .iter_mut()
            .find(|(sub_id, _)| *sub_id == id)
        {
            *current = filter;
            return Ok(());
        }
        self.subscriptions
            .push((id, filter))
            .map_err(|_| GuiError::WidgetsFull)
    }

    pub fn event_filter(&self, id: WidgetId) -> Result<UiEventFilter, GuiError> {
        self.node(id).ok_or(GuiError::NotFound)?;
        Ok(self
            .subscriptions
            .iter()
            .find(|(sub_id, _)| *sub_id == id)
            .map(|(_, filter)| *filter)
            .unwrap_or(UiEventFilter::ALL))
    }

    pub fn clear_event_filter(&mut self, id: WidgetId) -> Result<(), GuiError> {
        self.node(id).ok_or(GuiError::NotFound)?;
        if let Some(pos) = self
            .subscriptions
            .iter()
            .position(|(sub_id, _)| *sub_id == id)
        {
            self.subscriptions.remove(pos);
        }
        Ok(())
    }

    pub fn set_dispatch_policy(
        &mut self,
        id: WidgetId,
        policy: WidgetDispatchPolicy,
    ) -> Result<(), GuiError> {
        self.node(id).ok_or(GuiError::NotFound)?;
        if let Some((_, current)) = self
            .dispatch_policies
            .iter_mut()
            .find(|(policy_id, _)| *policy_id == id)
        {
            *current = policy;
            return Ok(());
        }
        self.dispatch_policies
            .push((id, policy))
            .map_err(|_| GuiError::WidgetsFull)
    }

    pub fn dispatch_policy(&self, id: WidgetId) -> Result<Option<WidgetDispatchPolicy>, GuiError> {
        self.node(id).ok_or(GuiError::NotFound)?;
        Ok(self
            .dispatch_policies
            .iter()
            .find(|(policy_id, _)| *policy_id == id)
            .map(|(_, policy)| *policy))
    }

    pub fn clear_dispatch_policy(&mut self, id: WidgetId) -> Result<(), GuiError> {
        self.node(id).ok_or(GuiError::NotFound)?;
        if let Some(pos) = self
            .dispatch_policies
            .iter()
            .position(|(policy_id, _)| *policy_id == id)
        {
            self.dispatch_policies.remove(pos);
        }
        Ok(())
    }

    pub(crate) fn add_widget<S>(
        &mut self,
        rect: impl Into<Rect>,
        kind: WidgetKind<'a>,
        style: S,
    ) -> Result<WidgetId, GuiError>
    where
        S: Into<WidgetStyle>,
    {
        let rect = rect.into();
        let id = WidgetId::new(self.next_id);
        self.next_id = self.next_id.saturating_add(1).max(1);
        let node = WidgetNode::new(id, rect, kind, style);
        self.widgets.push(node).map_err(|_| GuiError::WidgetsFull)?;
        self.dirty.add(rect)?;
        Ok(id)
    }

    pub(crate) fn node(&self, id: WidgetId) -> Option<&WidgetNode<'a>> {
        self.widgets.iter().find(|node| node.id == id)
    }

    pub(crate) fn intrinsic_size(&self, id: WidgetId) -> Option<(u32, u32)> {
        let node = self.node(id)?;
        let style = node.style.resolve(VisualState::Normal);
        let pad_x = style.padding.left.max(0) as u32 + style.padding.right.max(0) as u32;
        let pad_y = style.padding.top.max(0) as u32 + style.padding.bottom.max(0) as u32;
        let border = style.border.width as u32 * 2;
        let text_width = |text: &str| text.chars().count() as u32 * style.font.advance();
        let text_height = style.font.line_height();

        let content = match node.kind {
            WidgetKind::Label(text) => (text_width(text), text_height),
            WidgetKind::Button(text) => (text_width(text).saturating_add(6), text_height),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Toggle { label, .. } => (text_width(label).saturating_add(12), text_height),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Checkbox {
                label,
                box_width,
                box_height,
                ..
            } => {
                // The hint has to allow for the box as well as the text, or a design that asks for a wide box
                // is measured as if it were the old eight-pixel one and the widget is laid out too narrow.
                let box_w = if box_width == 0 { 8 } else { box_width as u32 };
                let box_h = if box_height == 0 {
                    8
                } else {
                    box_height as u32
                };
                (
                    text_width(label).saturating_add(box_w + 3),
                    text_height.max(box_h),
                )
            }
            #[cfg(feature = "rich-widgets")]
            WidgetKind::ValueLabel { label, .. } => {
                (text_width(label).saturating_add(16), text_height)
            }
            #[cfg(feature = "rich-widgets")]
            WidgetKind::IconButton { label, .. } => {
                (text_width(label).saturating_add(10), text_height)
            }
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Tabs { labels, .. } => {
                let max = labels.iter().map(|s| text_width(s)).max().unwrap_or(0);
                (
                    max.saturating_mul(labels.len() as u32).saturating_add(4),
                    text_height,
                )
            }
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Dialog { title, body } => {
                let w = text_width(title).max(text_width(body)).saturating_add(8);
                (w, text_height.saturating_mul(3))
            }
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Toast { text, .. } => (
                text_width(text).saturating_add(8),
                text_height.saturating_add(2),
            ),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Dropdown {
                items, selected, ..
            } => (
                text_width(items.get(selected).copied().unwrap_or("-")).saturating_add(10),
                text_height.saturating_add(2),
            ),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::TextArea {
                text_buf,
                text_len,
                placeholder,
                ..
            } => (
                text_width(if text_len == 0 {
                    placeholder
                } else {
                    textarea_text(&text_buf, text_len)
                })
                .saturating_add(10),
                text_height.saturating_add(4),
            ),
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Keyboard { keys, cols, .. } => {
                let cols = cols.max(1) as u32;
                let rows = (keys.len() as u32).div_ceil(cols).max(1);
                (
                    cols.saturating_mul(style.font.advance().saturating_add(4)),
                    rows.saturating_mul(style.font.line_height().saturating_add(4)),
                )
            }
            #[cfg(feature = "rich-widgets")]
            WidgetKind::List {
                items,
                visible_rows,
                ..
            }
            | WidgetKind::CircularList {
                items,
                visible_rows,
                ..
            } => {
                let max = items.iter().map(|s| text_width(s)).max().unwrap_or(0);
                (
                    max.saturating_add(6),
                    (text_height.saturating_add(2))
                        .saturating_mul(visible_rows as u32)
                        .max(text_height),
                )
            }
            #[cfg(feature = "rich-widgets")]
            WidgetKind::Menu { items, .. } => {
                let max = items.iter().map(|s| text_width(s)).max().unwrap_or(0);
                (
                    max.saturating_add(6),
                    (text_height.saturating_add(2))
                        .saturating_mul(items.len() as u32)
                        .max(text_height),
                )
            }
            #[cfg(feature = "rich-widgets")]
            WidgetKind::RichMenu {
                cells,
                visible_rows,
                ..
            } => {
                let has_subtitles = cells.iter().any(|cell| cell.subtitle.is_some());
                let row_h = if has_subtitles {
                    text_height.saturating_mul(2).saturating_add(2)
                } else {
                    text_height.saturating_add(2)
                };
                let max = cells
                    .iter()
                    .map(|cell| text_width(cell.title))
                    .max()
                    .unwrap_or(0)
                    .saturating_add(10);
                (
                    max,
                    row_h
                        .saturating_mul(visible_rows.max(1) as u32)
                        .max(text_height),
                )
            }
            #[cfg(feature = "rich-widgets")]
            WidgetKind::FeedTimeline {
                items,
                visible_rows,
                expanded,
                ..
            } => {
                let max = items.iter().map(|s| text_width(s)).max().unwrap_or(0);
                let row_h = if expanded {
                    text_height.saturating_mul(2).saturating_add(2)
                } else {
                    text_height.saturating_add(2)
                };
                (
                    max.saturating_add(8),
                    row_h.saturating_mul(visible_rows as u32).max(text_height),
                )
            }
            _ => (node.rect.w.max(1), node.rect.h.max(1)),
        };

        Some((
            content
                .0
                .saturating_add(pad_x)
                .saturating_add(border)
                .max(1),
            content
                .1
                .saturating_add(pad_y)
                .saturating_add(border)
                .max(1),
        ))
    }

    pub(crate) fn node_mut(&mut self, id: WidgetId) -> Option<&mut WidgetNode<'a>> {
        self.widgets.iter_mut().find(|node| node.id == id)
    }

    pub(crate) fn effective_visible(&self, id: WidgetId) -> bool {
        let mut current = Some(id);
        let mut depth = 0;
        while let Some(widget_id) = current {
            if depth >= NODES {
                return false;
            }
            let Some(node) = self.node(widget_id) else {
                return false;
            };
            if node.hidden() {
                return false;
            }
            current = node.parent;
            depth += 1;
        }
        true
    }

    pub(crate) fn inherited_clip(&self, id: WidgetId) -> Option<Rect> {
        let mut clip = self.viewport;
        let mut chain = heapless::Vec::<WidgetId, NODES>::new();
        let mut current = Some(id);
        while let Some(widget_id) = current {
            chain.push(widget_id).ok()?;
            current = self.node(widget_id)?.parent;
        }
        for widget_id in chain.iter().rev().copied() {
            let node = self.node(widget_id)?;
            if widget_id == id || node.clips_children() {
                clip = clip.intersection(self.absolute_rect(widget_id)?);
            }
            if clip.is_empty() {
                return None;
            }
        }
        Some(clip)
    }

    pub(crate) fn effective_enabled(&self, id: WidgetId) -> bool {
        let mut current = Some(id);
        let mut depth = 0;
        while let Some(widget_id) = current {
            if depth >= NODES {
                return false;
            }
            let Some(node) = self.node(widget_id) else {
                return false;
            };
            if node.disabled() {
                return false;
            }
            current = node.parent;
            depth += 1;
        }
        true
    }

    pub(crate) fn effective_focusable(&self, id: WidgetId) -> bool {
        self.node(id).is_some_and(|node| {
            self.node_in_active_group(node)
                && node.focusable()
                && self.effective_visible(id)
                && self.effective_enabled(id)
        })
    }

    pub(crate) fn ensure_focus(&mut self) {
        if self.focus.is_none() {
            self.focus = self
                .widgets
                .iter()
                .find(|node| self.effective_focusable(node.id))
                .map(|n| n.id);
        }
    }

    pub(crate) fn focus_next(&mut self) -> Result<(), GuiError> {
        self.move_focus(1)
    }

    pub(crate) fn focus_prev(&mut self) -> Result<(), GuiError> {
        self.move_focus(-1)
    }

    pub(crate) fn move_focus(&mut self, delta: i8) -> Result<(), GuiError> {
        let focusable = self
            .widgets
            .iter()
            .filter(|node| self.effective_focusable(node.id))
            .count();
        if focusable == 0 {
            return Ok(());
        }

        let current_pos = self
            .widgets
            .iter()
            .filter(|node| self.effective_focusable(node.id))
            .position(|node| Some(node.id) == self.focus)
            .unwrap_or(0);

        let next_pos = if delta >= 0 {
            (current_pos + 1) % focusable
        } else if current_pos == 0 {
            focusable - 1
        } else {
            current_pos - 1
        };

        let next = self
            .widgets
            .iter()
            .filter(|node| self.effective_focusable(node.id))
            .nth(next_pos)
            .map(|node| node.id);
        self.set_focus(next)
    }

    /// Moves focus in a 2D spatial direction (`Up`, `Down`, `Left`, `Right`)
    /// based on candidate bounding box alignment and perpendicular overlap.
    ///
    /// Returns `Ok(true)` if focus moved to a candidate in that direction,
    /// or `Ok(false)` if no candidate was found.
    pub fn move_focus_direction(&mut self, dir: NavDirection) -> Result<bool, GuiError> {
        let current_id = match self.focus {
            Some(id) => id,
            None => {
                if let Some(first) = self.widgets.iter().find(|n| self.effective_focusable(n.id)) {
                    self.set_focus(Some(first.id))?;
                    return Ok(true);
                }
                return Ok(false);
            }
        };

        let origin_node = match self.node(current_id) {
            Some(node) => node,
            None => return Ok(false),
        };
        let origin = origin_node.rect;
        let ox = origin.x + origin.w as i32 / 2;
        let oy = origin.y + origin.h as i32 / 2;

        let mut best_id = None;
        let mut best_score = f32::INFINITY;

        for node in &self.widgets {
            if node.id == current_id || !self.effective_focusable(node.id) {
                continue;
            }
            let cand = node.rect;
            let cx = cand.x + cand.w as i32 / 2;
            let cy = cand.y + cand.h as i32 / 2;

            let (dir_x, dir_y) = match dir {
                NavDirection::Up => (0.0, -1.0),
                NavDirection::Down => (0.0, 1.0),
                NavDirection::Left => (-1.0, 0.0),
                NavDirection::Right => (1.0, 0.0),
            };

            let to_x = (cx - ox) as f32;
            let to_y = (cy - oy) as f32;
            let center_dist = (to_x * to_x + to_y * to_y).sqrt();
            if center_dist <= 0.0 {
                continue;
            }

            let alignment = (to_x * dir_x + to_y * dir_y) / center_dist;
            if alignment <= 0.05 {
                continue;
            }

            let overlap = match dir {
                NavDirection::Up | NavDirection::Down => {
                    let a_min = origin.x;
                    let a_max = origin.right();
                    let b_min = cand.x;
                    let b_max = cand.right();
                    let o = (a_max.min(b_max) - a_min.max(b_min)).max(0);
                    let span = (a_max - a_min).min(b_max - b_min);
                    if span > 0 {
                        (o as f32) / (span as f32)
                    } else {
                        0.0
                    }
                }
                NavDirection::Left | NavDirection::Right => {
                    let a_min = origin.y;
                    let a_max = origin.bottom();
                    let b_min = cand.y;
                    let b_max = cand.bottom();
                    let o = (a_max.min(b_max) - a_min.max(b_min)).max(0);
                    let span = (a_max - a_min).min(b_max - b_min);
                    if span > 0 {
                        (o as f32) / (span as f32)
                    } else {
                        0.0
                    }
                }
            };

            let dx = (cand.x - origin.right())
                .max(origin.x - cand.right())
                .max(0) as f32;
            let dy = (cand.y - origin.bottom())
                .max(origin.y - cand.bottom())
                .max(0) as f32;
            let edge_dist = (dx * dx + dy * dy).sqrt();

            let alignment_penalty = (1.0 - alignment) * edge_dist * 2.0;
            let overlap_bonus = overlap * 15.0;
            let score = edge_dist + alignment_penalty - overlap_bonus;

            if score < best_score {
                best_score = score;
                best_id = Some(node.id);
            }
        }

        if let Some(next_id) = best_id {
            self.set_focus(Some(next_id))?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Stub for the `rich-widgets`-off build: none of the gated kinds this
    /// handles (List/Menu/Dropdown/Roller/ScrollView/FeedTimeline/Keyboard)
    /// exist, so there's nothing to adjust -- always fall through to the
    /// caller's plain focus_prev()/focus_next().
    #[cfg(not(feature = "rich-widgets"))]
    pub(crate) fn adjust_focused_selection(&mut self, _delta: i8) -> Result<bool, GuiError> {
        Ok(false)
    }

    #[cfg(feature = "rich-widgets")]
    pub(crate) fn adjust_focused_selection(&mut self, delta: i8) -> Result<bool, GuiError> {
        let Some(id) = self.focus else {
            return Ok(false);
        };
        let wrap_navigation = self.menu_contract.wrap_navigation;

        let mut changed_rect = None;
        let mut changed = false;

        if let Some(node) = self.node_mut(id) {
            match node.kind {
                WidgetKind::Menu {
                    items,
                    selected: ref mut current,
                } => {
                    if items.is_empty() {
                        return Ok(true);
                    }
                    changed = bump_index_with_wrap(current, items.len(), delta, wrap_navigation);
                    changed_rect = changed.then_some(node.rect);
                }
                WidgetKind::RichMenu {
                    cells,
                    selected: ref mut current,
                    ref mut offset,
                    visible_rows,
                } => {
                    if cells.is_empty() {
                        return Ok(true);
                    }
                    let mut next = *current;
                    let mut bumped = false;
                    for _ in 0..cells.len() {
                        let stepped =
                            bump_index_with_wrap(&mut next, cells.len(), delta, wrap_navigation);
                        if !stepped {
                            break;
                        }
                        bumped = true;
                        if cells[next].enabled {
                            break;
                        }
                    }
                    changed = bumped && next != *current;
                    if changed {
                        let mut state = ListState::new(next, *offset, visible_rows);
                        state.set_selected(next, cells.len());
                        *current = state.selected;
                        *offset = state.offset;
                        changed_rect = changed.then_some(node.rect);
                    }
                }
                WidgetKind::Dropdown {
                    items,
                    selected: ref mut current,
                    open,
                } => {
                    if !open {
                        return Ok(false);
                    }
                    if items.is_empty() {
                        return Ok(true);
                    }
                    changed = bump_index_with_wrap(current, items.len(), delta, wrap_navigation);
                    changed_rect = changed.then_some(node.rect);
                }
                WidgetKind::Roller {
                    items,
                    selected: ref mut current,
                } => {
                    if items.is_empty() {
                        return Ok(true);
                    }
                    changed = bump_index_with_wrap(current, items.len(), delta, wrap_navigation);
                    changed_rect = changed.then_some(node.rect);
                }
                // The carousel is the roller's sibling (a wrap-around list of its own) and had no
                // key path at all until it gained this one. It is stepped here rather than in a
                // second place so the arrow keys and a finger drag cannot disagree about it.
                WidgetKind::Carousel {
                    items,
                    selected: ref mut current,
                    ..
                } => {
                    if items.is_empty() {
                        return Ok(true);
                    }
                    changed = bump_index_with_wrap(current, items.len(), delta, wrap_navigation);
                    changed_rect = changed.then_some(node.rect);
                }
                WidgetKind::Keyboard {
                    keys,
                    selected: ref mut current,
                    ..
                } => {
                    if keys.is_empty() {
                        return Ok(true);
                    }
                    changed = bump_index_with_wrap(current, keys.len(), delta, wrap_navigation);
                    changed_rect = changed.then_some(node.rect);
                }
                WidgetKind::List {
                    items,
                    selected: ref mut current,
                    ref mut offset,
                    visible_rows,
                }
                | WidgetKind::CircularList {
                    items,
                    selected: ref mut current,
                    ref mut offset,
                    visible_rows,
                } => {
                    if items.is_empty() {
                        return Ok(true);
                    }
                    let mut state = ListState::new(*current, *offset, visible_rows);
                    let mut next = state.selected;
                    changed = bump_index_with_wrap(&mut next, items.len(), delta, wrap_navigation);
                    if changed {
                        let _ = state.set_selected(next, items.len());
                    }
                    *current = state.selected;
                    *offset = state.offset;
                    changed_rect = changed.then_some(node.rect);
                }
                WidgetKind::FeedTimeline {
                    items,
                    selected: ref mut current,
                    ref mut offset,
                    visible_rows,
                    expanded,
                } => {
                    if items.is_empty() {
                        return Ok(true);
                    }
                    let mut state =
                        FeedTimelineState::new(*current, *offset, visible_rows, expanded);
                    let mut next = state.selected;
                    changed = bump_index_with_wrap(&mut next, items.len(), delta, wrap_navigation);
                    if changed {
                        let _ = state.set_selected(next, items.len());
                    }
                    *current = state.selected;
                    *offset = state.offset;
                    changed_rect = changed.then_some(node.rect);
                }
                WidgetKind::ScrollView {
                    offset_y: ref mut offset,
                    content_h,
                } => {
                    let mut state = ScrollState::new(*offset, content_h);
                    changed = state.scroll_by(delta as i32 * 8);
                    *offset = state.offset_y;
                    changed_rect = changed.then_some(node.rect);
                }
                WidgetKind::AutoComplete {
                    filtered: _,
                    filter_count,
                    selected: ref mut current,
                    expanded,
                    ..
                } => {
                    if !expanded || filter_count == 0 {
                        return Ok(false);
                    }
                    let idx = current.unwrap_or(0);
                    let mut next = idx;
                    changed = bump_index_with_wrap(
                        &mut next,
                        filter_count as usize,
                        delta,
                        wrap_navigation,
                    );
                    *current = Some(next);
                    changed_rect = changed.then_some(node.rect);
                }
                _ => return Ok(false),
            }
        }

        if let Some(rect) = changed_rect {
            self.dirty.add(rect)?;
        }
        if changed {
            self.push_event(UiEvent::ValueChanged(id))?;
        }
        Ok(true)
    }

    /// Stub for the `rich-widgets`-off build: none of the gated kinds this
    /// handles (Slider/Tabs/TextArea) exist, so always fall through to the
    /// caller's plain focus_prev()/focus_next().
    #[cfg(not(feature = "rich-widgets"))]
    pub(crate) fn adjust_focused_scalar(&mut self, _direction: f32) -> Result<bool, GuiError> {
        Ok(false)
    }

    #[cfg(feature = "rich-widgets")]
    pub(crate) fn adjust_focused_scalar(&mut self, direction: f32) -> Result<bool, GuiError> {
        let Some(id) = self.focus else {
            return Ok(false);
        };

        let mut changed_rect = None;
        let mut changed = false;

        if let Some(node) = self.node_mut(id) {
            match node.kind {
                WidgetKind::Slider {
                    value: ref mut current,
                    min,
                    max,
                } => {
                    let mut state = SliderState::new(*current, min, max);
                    changed = state.step_by(direction);
                    *current = state.value;
                    changed_rect = changed.then_some(node.rect);
                }
                WidgetKind::Tabs {
                    labels,
                    selected: ref mut current,
                } => {
                    if labels.is_empty() {
                        return Ok(true);
                    }
                    let mut state = TabsState::new(*current);
                    changed = state.bump(labels.len(), if direction >= 0.0 { 1 } else { -1 });
                    *current = state.selected;
                    changed_rect = changed.then_some(node.rect);
                }
                WidgetKind::TextArea {
                    text_buf,
                    text_len,
                    cursor: ref mut current,
                    ..
                } => {
                    let text = textarea_text(&text_buf, text_len);
                    let len = text.chars().count();
                    if direction >= 0.0 {
                        let next = (*current + 1).min(len);
                        changed = next != *current;
                        *current = next;
                    } else {
                        let next = current.saturating_sub(1);
                        changed = next != *current;
                        *current = next;
                    }
                    changed_rect = changed.then_some(node.rect);
                }
                WidgetKind::Dial {
                    value: ref mut current,
                    min,
                    max,
                } => {
                    let mut state = SliderState::new(*current, min, max);
                    changed = state.step_by(direction);
                    *current = state.value;
                    changed_rect = changed.then_some(node.rect);
                }
                _ => return Ok(false),
            }
        }

        if let Some(rect) = changed_rect {
            self.dirty.add(rect)?;
        }
        if changed {
            self.push_event(UiEvent::ValueChanged(id))?;
        }
        Ok(true)
    }

    /// Stub for the `rich-widgets`-off build: none of the gated kinds this
    /// handles (Checkbox/Dropdown/Keyboard/Toggle) exist, so activation for
    /// whatever's focused is just the generic click dispatch already done
    /// by the caller.
    #[cfg(not(feature = "rich-widgets"))]
    pub(crate) fn activate_focused(&mut self, _id: WidgetId) -> Result<bool, GuiError> {
        Ok(false)
    }

    /// Runs the focused widget's activation, and says whether it changed anything.
    ///
    /// The answer is what `dispatch_activation` uses to let go of the focus a pointer press took: a
    /// checkbox that has just been toggled, or a keyboard that has just typed a letter, is done with the
    /// touch and has no business keeping the highlight.
    #[cfg(feature = "rich-widgets")]
    pub(crate) fn activate_focused(&mut self, id: WidgetId) -> Result<bool, GuiError> {
        let mut changed_rect = None;
        let mut changed = false;
        let mut dropdown_state_event = None;
        let select_opens_dropdown = self.menu_contract.select_opens_dropdown;

        if let Some(node) = self.node_mut(id) {
            match node.kind {
                WidgetKind::Toggle { on: ref mut v, .. } => {
                    *v = !*v;
                    changed = true;
                    changed_rect = Some(node.rect);
                }
                WidgetKind::Checkbox {
                    checked: ref mut v, ..
                } => {
                    *v = !*v;
                    changed = true;
                    changed_rect = Some(node.rect);
                }
                WidgetKind::Keyboard {
                    keys,
                    alt_keys,
                    selected,
                    layout,
                    target,
                    ..
                } => {
                    if let Some(ch) = keyboard_char_for_layout(keys, alt_keys, selected, layout) {
                        changed = true;
                        changed_rect = Some(node.rect);
                        if let Some(target) = target {
                            let _ = self.push_event(UiEvent::TextInput { id: target, ch });
                            let _ = self.push_event(UiEvent::ValueChanged(target));
                        }
                    }
                }
                WidgetKind::Dropdown {
                    open: ref mut is_open,
                    ..
                } if select_opens_dropdown => {
                    *is_open = !*is_open;
                    changed = true;
                    changed_rect = Some(node.rect);
                    dropdown_state_event = Some(*is_open);
                }
                _ => {}
            }
        }

        if let Some(open) = dropdown_state_event {
            let mut events = heapless::Vec::<WidgetEvent, NODES>::new();
            self.dispatch_widget_event(
                id,
                if open {
                    WidgetEventKind::Opened
                } else {
                    WidgetEventKind::Closed
                },
                &mut events,
                |_| EventPolicy::Continue,
            )?;
            self.push_event(if open {
                UiEvent::Opened(id)
            } else {
                UiEvent::Closed(id)
            })?;
        }

        if let Some(rect) = changed_rect {
            self.dirty.add(rect)?;
        }
        if changed {
            self.push_event(UiEvent::ValueChanged(id))?;
        }
        Ok(changed)
    }

    pub(crate) fn node_in_active_group(&self, node: &WidgetNode<'_>) -> bool {
        self.active_focus_group
            .is_none_or(|group| node.focus_group == group)
    }

    pub(crate) fn handle_pointer_pressed(&mut self, x: i32, y: i32) -> Result<(), GuiError> {
        let hit = self.pointer_hit(x, y, true);

        if let Some(id) = hit {
            self.dispatch_activation(id, true)?;
            self.update_dial_value_at_pointer(id, x, y)?;
            self.pressed = Some(PressTracker {
                id,
                start_x: x,
                start_y: y,
                last_x: x,
                last_y: y,
                elapsed_ms: 0,
                long_emitted: false,
                gesture_emitted: false,
                repeat_elapsed_ms: 0,
                scroll_velocity: 0.0,
                drag_accum_y: 0,
            });
            self.inertia_scroll = None;
            #[cfg(feature = "rich-widgets")]
            {
                self.scroll_spring_back = None;
            }
        }
        Ok(())
    }

    pub(crate) fn handle_pointer_released(&mut self, _x: i32, _y: i32) -> Result<(), GuiError> {
        let mut released_id = None;
        if let Some(pressed) = self.pressed {
            if let Some(scroll_id) = self.scrollable_ancestor(pressed.id) {
                let started_spring_back = self.maybe_start_scroll_spring_back(scroll_id);
                if !started_spring_back
                    && pressed.scroll_velocity.abs() > self.scroll_physics.velocity_threshold
                {
                    self.inertia_scroll = Some(InertiaScroll {
                        id: scroll_id,
                        velocity: pressed.scroll_velocity,
                    });
                }
            }
            released_id = Some(pressed.id);
        }
        self.pressed = None;
        if let Some(id) = released_id {
            let to = if !self.effective_enabled(id) {
                VisualState::Disabled
            } else if Some(id) == self.focus {
                VisualState::Focused
            } else {
                VisualState::Normal
            };
            self.start_state_transition(id, VisualState::Pressed, to);
            let mut events = heapless::Vec::<WidgetEvent, NODES>::new();
            self.dispatch_widget_event(id, WidgetEventKind::Released, &mut events, |_| {
                EventPolicy::Continue
            })?;
            self.push_event(UiEvent::Released(id))?;
            self.push_event(UiEvent::PointerReleased(id))?;
            let double_pointer = self.last_pointer_id == Some(id)
                && self.pointer_elapsed_ms <= self.pointer_double_window_ms;
            if double_pointer {
                self.dispatch_double_clicked(id)?;
                self.last_pointer_id = None;
                self.pointer_elapsed_ms = 0;
            } else {
                self.last_pointer_id = Some(id);
                self.pointer_elapsed_ms = 0;
            }
        }
        Ok(())
    }

    pub(crate) fn handle_pointer_moved(&mut self, x: i32, y: i32) -> Result<(), GuiError> {
        let Some(mut pressed) = self.pressed else {
            return Ok(());
        };
        self.update_dial_value_at_pointer(pressed.id, x, y)?;
        #[allow(unused_variables)]
        let dy = y - pressed.last_y;
        pressed.last_x = x;
        pressed.last_y = y;

        // A finger that landed on a selector turns it (see `drag_step_selection`). The answer is
        // remembered rather than recomputed below: it is what decides whether an enclosing
        // ScrollView is allowed to scroll, and the widget under the finger wins.
        #[cfg(feature = "rich-widgets")]
        let dragged = self.drag_step_selection(&mut pressed, dy)?;

        let moved_from_start =
            (x - pressed.start_x).unsigned_abs() + (y - pressed.start_y).unsigned_abs();
        if !pressed.gesture_emitted && moved_from_start >= 6 {
            let mut events = heapless::Vec::<WidgetEvent, NODES>::new();
            self.dispatch_widget_event(pressed.id, WidgetEventKind::Gesture, &mut events, |_| {
                EventPolicy::Continue
            })?;
            self.push_event(UiEvent::Gesture(pressed.id))?;
            pressed.gesture_emitted = true;
        }

        #[cfg(feature = "rich-widgets")]
        let scroll_target = if dragged {
            // The finger was on a selector, so the selector has it.
            None
        } else {
            self.scrollable_ancestor(pressed.id)
        };
        #[cfg(feature = "rich-widgets")]
        if let Some(scroll_id) = scroll_target {
            let current = self.scroll_offset(scroll_id).unwrap_or(0);
            let next = if self.scroll_physics.rubber_band {
                self.scroll_by_rubber_band(scroll_id, -dy)?
            } else {
                let target = current.saturating_sub(dy);
                self.set_scroll_offset(scroll_id, target)?;
                self.scroll_offset(scroll_id).unwrap_or(current)
            };
            if next != current {
                self.push_event(UiEvent::Scroll {
                    id: scroll_id,
                    delta: next - current,
                })?;
                let mut events = heapless::Vec::<WidgetEvent, NODES>::new();
                self.dispatch_widget_event(
                    scroll_id,
                    WidgetEventKind::Scroll {
                        delta: next - current,
                    },
                    &mut events,
                    |_| EventPolicy::Continue,
                )?;
            }
            let blend = self.scroll_physics.drag_velocity_blend;
            pressed.scroll_velocity = pressed.scroll_velocity * (1.0 - blend) + (dy as f32) * blend;
        }
        self.pressed = Some(pressed);
        Ok(())
    }

    /// The finger turns the selector it landed on: one item — or one value step — per drawn row of
    /// travel, accumulated across samples.
    ///
    /// Only the widget the press focused is turned, and a press focuses whatever is focusable under
    /// it (`dispatch_activation`), so this is "the widget the finger is on" without a second
    /// hit-test that could disagree with the one that started the press.
    ///
    /// Returns `true` when the widget owns the movement, so an enclosing `ScrollView` leaves it
    /// alone: a finger that landed on a roller must not also scroll the page behind it.
    #[cfg(feature = "rich-widgets")]
    pub(crate) fn drag_step_selection(
        &mut self,
        pressed: &mut PressTracker,
        dy: i32,
    ) -> Result<bool, GuiError> {
        let id = pressed.id;
        if self.focus != Some(id) {
            return Ok(false);
        }
        let Some(node) = self.node(id) else {
            return Ok(false);
        };
        let selector = is_drag_selector(&node.kind);
        let value_selector = matches!(
            node.kind,
            WidgetKind::Spinbox { .. }
                | WidgetKind::NumberPicker { .. }
                | WidgetKind::TimePicker { .. }
        );
        if !selector && !value_selector {
            return Ok(false);
        }
        let step = ((node.rect.h as i32) / drag_rows(&node.kind)).max(MIN_DRAG_STEP_PX);
        let rect = node.rect;

        pressed.drag_accum_y += dy;
        let raw = pressed.drag_accum_y / step;
        if raw == 0 {
            // Half a row is half a row: nothing moves yet, but the widget still owns the movement,
            // or a short drag inside it would leak to the view behind it.
            return Ok(true);
        }
        let steps = raw.clamp(-MAX_DRAG_STEPS_PER_SAMPLE, MAX_DRAG_STEPS_PER_SAMPLE) as i8;
        pressed.drag_accum_y -= i32::from(steps) * step;

        if selector {
            // One call per item, not one call with a bigger number: `adjust_focused_selection` — like
            // the arrow keys it serves — steps by a *single* item and only reads the sign of the
            // delta. Spending the travel one item at a time is also what keeps a rich menu from
            // skipping over its disabled cells.
            for _ in 0..steps.unsigned_abs() {
                self.adjust_focused_selection(steps.signum())?;
            }
        } else {
            // Read before the node is borrowed mutably: the borrowing rule is not a detail worth a
            // second copy of the setting.
            let wrap = self.menu_contract.wrap_navigation;
            if let Some(node) = self.node_mut(id) {
                if drag_step_value(&mut node.kind, steps, wrap) == Some(true) {
                    self.dirty.add(rect)?;
                    self.push_event(UiEvent::ValueChanged(id))?;
                }
            }
        }
        Ok(true)
    }

    pub(crate) fn dispatch_activation(
        &mut self,
        id: WidgetId,
        is_pointer: bool,
    ) -> Result<(), GuiError> {
        let is_autocomplete = matches!(
            self.node(id).map(|n| &n.kind),
            Some(WidgetKind::AutoComplete { .. })
        );
        if is_autocomplete {
            self.autocomplete_confirm_selection(id)?;
            return Ok(());
        }

        let mut events = heapless::Vec::<WidgetEvent, NODES>::new();
        self.dispatch_widget_event(id, WidgetEventKind::Pressed, &mut events, |_| {
            EventPolicy::Continue
        })?;
        if self.effective_focusable(id) {
            self.set_focus(Some(id))?;
        }
        self.push_event(UiEvent::Pressed(id))?;
        if is_pointer {
            self.push_event(UiEvent::PointerPressed(id))?;
        }
        let from = if Some(id) == self.focus {
            VisualState::Focused
        } else {
            VisualState::Normal
        };
        self.start_state_transition(id, from, VisualState::Pressed);

        // An activation that changed the widget hands the focus back: a toggle that has just been thrown,
        // or a keyboard key that has just been typed, is done with the finger -- and the widget's own
        // colours are what should stay on screen, not a highlight (asked 2026-10-14: *"when the widget's
        // action was performed, that widget should automatically lose focus"*). A tap that changed nothing
        // -- a roller, a list, a text area -- keeps it, which is what keeps a caret visible.
        let acted = self.activate_focused(id)?;
        if is_pointer && acted {
            self.set_focus(None)?;
        }
        self.dispatch_widget_event(id, WidgetEventKind::Clicked, &mut events, |_| {
            EventPolicy::Continue
        })?;
        self.push_event(UiEvent::Clicked(id))?;
        self.play_haptic(HapticPattern::Click);
        self.push_event(UiEvent::Activate(id))?;
        Ok(())
    }

    pub(crate) fn dispatch_repeat_activation(&mut self, id: WidgetId) -> Result<(), GuiError> {
        let mut events = heapless::Vec::<WidgetEvent, NODES>::new();
        self.dispatch_widget_event(id, WidgetEventKind::Clicked, &mut events, |_| {
            EventPolicy::Continue
        })?;
        self.push_event(UiEvent::Clicked(id))?;
        self.play_haptic(HapticPattern::Click);
        self.push_event(UiEvent::Activate(id))
    }

    pub(crate) fn dispatch_double_clicked(&mut self, id: WidgetId) -> Result<(), GuiError> {
        let mut events = heapless::Vec::<WidgetEvent, NODES>::new();
        self.dispatch_widget_event(id, WidgetEventKind::DoubleClicked, &mut events, |_| {
            EventPolicy::Continue
        })?;
        self.push_event(UiEvent::DoubleClicked(id))?;
        self.play_haptic(HapticPattern::DoubleClick);
        Ok(())
    }

    pub(crate) fn dispatch_key_pressed(&mut self, id: WidgetId) -> Result<(), GuiError> {
        let mut events = heapless::Vec::<WidgetEvent, NODES>::new();
        self.dispatch_widget_event(id, WidgetEventKind::Pressed, &mut events, |_| {
            EventPolicy::Continue
        })?;
        self.push_event(UiEvent::Pressed(id))
    }

    pub(crate) fn dispatch_key_released(&mut self, id: WidgetId) -> Result<(), GuiError> {
        let mut events = heapless::Vec::<WidgetEvent, NODES>::new();
        self.dispatch_widget_event(id, WidgetEventKind::Released, &mut events, |_| {
            EventPolicy::Continue
        })?;
        self.push_event(UiEvent::Released(id))
    }

    pub(crate) fn repeatable_widget(&self, id: WidgetId) -> bool {
        self.node(id).is_some_and(|node| {
            #[cfg(feature = "rich-widgets")]
            if matches!(node.kind, WidgetKind::IconButton { .. }) {
                return true;
            }
            matches!(node.kind, WidgetKind::Button(_))
        })
    }

    pub(crate) fn pointer_hit(&self, x: i32, y: i32, clickable_only: bool) -> Option<WidgetId> {
        self.widgets
            .iter()
            .rev()
            .find(|node| {
                (!clickable_only || node.clickable())
                    && self.effective_visible(node.id)
                    && self.effective_enabled(node.id)
                    && self
                        .absolute_rect(node.id)
                        .is_some_and(|rect| rect.contains(x, y))
            })
            .map(|node| node.id)
    }

    pub(crate) fn scrollable_ancestor(&self, id: WidgetId) -> Option<WidgetId> {
        let mut current = Some(id);
        let mut depth = 0usize;
        while let Some(widget_id) = current {
            if depth >= NODES {
                return None;
            }
            let node = self.node(widget_id)?;
            if node.scrollable() {
                return Some(widget_id);
            }
            current = node.parent;
            depth += 1;
        }
        None
    }

    /// If `id`'s `ScrollView` is overscrolled and `scroll_physics.rubber_band`
    /// is enabled, starts a spring-back animation to the nearest boundary
    /// (see `crate::motion::SpringAnimator::rubber_band_snap_back`) and
    /// returns `true`. Otherwise leaves any existing scroll state alone and
    /// returns `false`.
    #[cfg(feature = "rich-widgets")]
    pub(crate) fn maybe_start_scroll_spring_back(&mut self, id: WidgetId) -> bool {
        if !self.scroll_physics.rubber_band {
            return false;
        }
        let Some(node) = self.node(id) else {
            return false;
        };
        let WidgetKind::ScrollView {
            offset_y,
            content_h,
        } = node.kind
        else {
            return false;
        };
        let state = ScrollState::new(offset_y, content_h);
        if !state.is_overscrolled() {
            return false;
        }
        self.scroll_spring_back = Some(ScrollSpringBack {
            id,
            spring: crate::motion::SpringAnimator::rubber_band_snap_back(
                offset_y as f32,
                state.nearest_bound() as f32,
            ),
        });
        true
    }

    /// Stub for the `rich-widgets`-off build: ScrollView doesn't exist, so
    /// nothing is ever overscrolled.
    #[cfg(not(feature = "rich-widgets"))]
    pub(crate) fn maybe_start_scroll_spring_back(&mut self, _id: WidgetId) -> bool {
        false
    }

    pub(crate) fn mark_focus_pair(
        &mut self,
        old: Option<WidgetId>,
        new: Option<WidgetId>,
    ) -> Result<(), GuiError> {
        if let Some(id) = old {
            if let Some(rect) = self.absolute_rect(id) {
                self.dirty.add(rect)?;
            }
        }
        if let Some(id) = new {
            if let Some(rect) = self.absolute_rect(id) {
                self.dirty.add(rect)?;
            }
        }
        Ok(())
    }

    pub(crate) fn start_focus_transitions(&mut self, old: Option<WidgetId>, new: Option<WidgetId>) {
        if self.state_transition_ms == 0 {
            return;
        }
        if let Some(id) = old {
            self.start_state_transition(id, VisualState::Focused, VisualState::Normal);
        }
        if let Some(id) = new {
            self.start_state_transition(id, VisualState::Normal, VisualState::Focused);
        }
    }

    pub(crate) fn start_state_transition(
        &mut self,
        id: WidgetId,
        from: VisualState,
        to: VisualState,
    ) {
        if self.state_transition_ms == 0 || from == to {
            return;
        }
        if let Some(entry) = self
            .state_transitions
            .iter_mut()
            .find(|entry| entry.id == id)
        {
            *entry = StateTransition {
                id,
                from,
                to,
                elapsed_ms: 0,
            };
            return;
        }
        if self.state_transitions.len() == self.state_transitions.capacity() {
            self.state_transitions.remove(0);
        }
        let _ = self.state_transitions.push(StateTransition {
            id,
            from,
            to,
            elapsed_ms: 0,
        });
    }

    pub(crate) fn tick_state_transitions(&mut self, dt_ms: u32) -> Result<(), GuiError> {
        if self.state_transitions.is_empty() || self.state_transition_ms == 0 {
            return Ok(());
        }
        let mut i = 0usize;
        let mut completed_pressed = heapless::Vec::<WidgetId, NODES>::new();
        while i < self.state_transitions.len() {
            let mut remove = false;
            let id;
            let to;
            {
                let entry = &mut self.state_transitions[i];
                entry.elapsed_ms = entry.elapsed_ms.saturating_add(dt_ms);
                if entry.elapsed_ms >= self.state_transition_ms {
                    remove = true;
                }
                id = entry.id;
                to = entry.to;
            }
            if let Some(rect) = self.absolute_rect(id) {
                self.dirty.add(rect)?;
            }
            if remove {
                if to == VisualState::Pressed {
                    let _ = completed_pressed.push(id);
                }
                self.state_transitions.remove(i);
            } else {
                i += 1;
            }
        }
        for id in completed_pressed {
            // Pointer-held presses keep visual pressed state until release.
            if self.pressed.is_some_and(|pressed| pressed.id == id) {
                continue;
            }
            let to = self.resting_visual_state(id);
            self.start_state_transition(id, VisualState::Pressed, to);
        }
        Ok(())
    }

    pub(crate) fn state_transition_progress(
        &self,
        id: WidgetId,
    ) -> Option<(VisualState, VisualState, f32)> {
        let duration = self.state_transition_ms.max(1);
        self.state_transitions
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| {
                let t = (entry.elapsed_ms as f32 / duration as f32).clamp(0.0, 1.0);
                (entry.from, entry.to, t)
            })
    }

    /// Stub for the `rich-widgets`-off build: TextArea doesn't exist, so
    /// there's no cursor blink state to update.
    #[cfg(not(feature = "rich-widgets"))]
    pub(crate) fn set_textarea_cursor_visible(&mut self, _id: Option<WidgetId>, _visible: bool) {}

    #[cfg(feature = "rich-widgets")]
    pub(crate) fn set_textarea_cursor_visible(&mut self, id: Option<WidgetId>, visible: bool) {
        let Some(id) = id else {
            return;
        };
        let Some(rect) = self.absolute_rect(id) else {
            return;
        };
        let Some(node) = self.node_mut(id) else {
            return;
        };
        if let WidgetKind::TextArea {
            cursor_visible: ref mut current,
            ..
        } = node.kind
        {
            *current = visible;
            let _ = self.dirty.add(rect);
        }
    }

    pub(crate) fn tick_theme_transition(&mut self, dt_ms: u32) -> Result<(), GuiError> {
        if let (Some(from), Some(to)) = (self.theme_transition_from, self.theme_transition_to) {
            let elapsed = self.theme_transition_elapsed_ms.saturating_add(dt_ms);
            self.theme_transition_elapsed_ms = elapsed;
            if elapsed >= self.theme_transition_duration_ms {
                self.theme = to;
                self.theme_transition_from = None;
                self.theme_transition_to = None;
            } else {
                let t = elapsed as f32 / self.theme_transition_duration_ms as f32;
                self.theme = crate::style::lerp_theme(from, to, t);
            }
            self.dirty.mark_all(self.viewport)?;
        }
        Ok(())
    }

    #[cfg(feature = "rich-widgets")]
    pub(crate) fn tick_textarea_cursor_blink(&mut self, dt_ms: u32) -> Result<(), GuiError> {
        let Some(id) = self.focus else {
            return Ok(());
        };
        let is_textarea = matches!(
            self.node(id).map(|n| n.kind),
            Some(WidgetKind::TextArea { .. })
        );
        if !is_textarea {
            return Ok(());
        }
        self.textarea_cursor_blink_elapsed_ms =
            self.textarea_cursor_blink_elapsed_ms.saturating_add(dt_ms);
        if self.textarea_cursor_blink_elapsed_ms < self.textarea_cursor_blink_ms {
            return Ok(());
        }
        self.textarea_cursor_blink_elapsed_ms = 0;
        let rect = self.absolute_rect(id).ok_or(GuiError::NotFound)?;
        let node = self.node_mut(id).ok_or(GuiError::NotFound)?;
        if let WidgetKind::TextArea {
            cursor_visible: ref mut visible,
            ..
        } = node.kind
        {
            *visible = !*visible;
            self.dirty.add(rect)?;
        }
        Ok(())
    }

    pub(crate) fn push_event(&mut self, event: UiEvent) -> Result<(), GuiError> {
        if self.should_emit_event(event)? {
            self.events.push(event).map_err(|_| GuiError::EventsFull)?;
        }
        Ok(())
    }

    pub(crate) fn should_emit_event(&self, event: UiEvent) -> Result<bool, GuiError> {
        let Some(target) = event.target() else {
            return Ok(true);
        };
        let filter = self.event_filter(target)?;
        Ok(filter.contains(event.filter()))
    }

    #[cfg(feature = "rich-widgets")]
    pub(crate) fn stop_due_to_builtin_widget_behavior(&self, event: WidgetEvent) -> bool {
        if event.phase != EventPhase::Capture || event.current == event.target {
            return false;
        }
        let is_pointer_kind = matches!(
            event.kind,
            WidgetEventKind::Pressed | WidgetEventKind::Released | WidgetEventKind::Clicked
        );
        is_pointer_kind
            && self
                .node(event.current)
                .is_some_and(|node| matches!(node.kind, WidgetKind::ScrollView { .. }))
    }

    /// Stub for the `rich-widgets`-off build: ScrollView doesn't exist, so
    /// no event ever needs stopping for this reason.
    #[cfg(not(feature = "rich-widgets"))]
    pub(crate) fn stop_due_to_builtin_widget_behavior(&self, _event: WidgetEvent) -> bool {
        false
    }

    pub(crate) fn stop_due_to_registered_policy(&self, event: WidgetEvent) -> bool {
        self.dispatch_policies
            .iter()
            .find(|(id, _)| *id == event.current)
            .is_some_and(|(_, policy)| policy.stop && policy.allows(event.kind, event.phase))
    }

    pub(crate) fn resting_visual_state(&self, id: WidgetId) -> VisualState {
        if !self.effective_enabled(id) {
            VisualState::Disabled
        } else if Some(id) == self.focus {
            VisualState::Focused
        } else {
            VisualState::Normal
        }
    }

    pub(crate) fn current_visual_state(&self, id: WidgetId) -> VisualState {
        if self.pressed.is_some_and(|pressed| pressed.id == id) {
            VisualState::Pressed
        } else {
            self.resting_visual_state(id)
        }
    }

    pub(crate) fn press_timing_for(&self, id: WidgetId) -> PressTiming {
        self.widget_press_timings
            .iter()
            .find(|(timing_id, _)| *timing_id == id)
            .map(|(_, timing)| *timing)
            .unwrap_or(PressTiming {
                long_press_ms: self.long_press_ms,
                repeat_delay_ms: self.press_repeat_delay_ms,
                repeat_interval_ms: self.press_repeat_interval_ms,
            })
    }

    pub(crate) fn key_input_policy_for(&self, id: WidgetId) -> WidgetKeyInputPolicy {
        self.widget_key_policies
            .iter()
            .find(|(policy_id, _)| *policy_id == id)
            .map(|(_, policy)| *policy)
            .unwrap_or_default()
    }

    pub(crate) fn key_bindings_for(&self, id: WidgetId) -> WidgetKeyBindings {
        self.widget_key_bindings
            .iter()
            .find(|(binding_id, _)| *binding_id == id)
            .map(|(_, bindings)| *bindings)
            .unwrap_or_default()
    }

    pub(crate) fn handle_select_activation(&mut self, id: WidgetId) -> Result<(), GuiError> {
        #[cfg(feature = "rich-widgets")]
        if let Some(node) = self.node(id) {
            if self.menu_contract.select_toggles_feed_expanded
                && matches!(node.kind, WidgetKind::FeedTimeline { .. })
            {
                let expanded = if let WidgetKind::FeedTimeline { expanded, .. } = node.kind {
                    expanded
                } else {
                    false
                };
                self.set_feed_expanded(id, !expanded)?;
                self.push_event(UiEvent::ValueChanged(id))?;
            }
        }
        let double_select = self.last_select_id == Some(id)
            && self.select_elapsed_ms <= self.select_double_window_ms;
        self.dispatch_activation(id, false)?;
        if double_select {
            self.dispatch_double_clicked(id)?;
            self.last_select_id = None;
            self.select_elapsed_ms = 0;
        } else {
            self.last_select_id = Some(id);
            self.select_elapsed_ms = 0;
        }
        Ok(())
    }

    pub(crate) fn handle_back_action(&mut self) -> Result<(), GuiError> {
        #[cfg(feature = "rich-widgets")]
        if let Some(id) = self.focus {
            if matches!(
                self.node(id).map(|n| n.kind),
                Some(WidgetKind::TextArea { .. })
            ) {
                self.textarea_backspace(id)?;
                return Ok(());
            }
            if matches!(
                self.node(id).map(|n| n.kind),
                Some(WidgetKind::AutoComplete { .. })
            ) {
                let expanded = if let Some(WidgetKind::AutoComplete { expanded, .. }) =
                    self.node(id).map(|n| n.kind)
                {
                    expanded
                } else {
                    false
                };
                if expanded {
                    let has_chars = if let Some(WidgetKind::AutoComplete { text_len, .. }) =
                        self.node(id).map(|n| n.kind)
                    {
                        text_len > 0
                    } else {
                        false
                    };
                    if has_chars {
                        self.delete_autocomplete_char(id)?;
                    } else {
                        let rect = self.absolute_rect(id).ok_or(GuiError::NotFound)?;
                        let node = self.node_mut(id).ok_or(GuiError::NotFound)?;
                        if let WidgetKind::AutoComplete { expanded, .. } = &mut node.kind {
                            *expanded = false;
                        }
                        self.dirty.add(rect)?;
                    }
                    return Ok(());
                }
            }
            if matches!(
                self.node(id).map(|n| n.kind),
                Some(WidgetKind::Dropdown { open: true, .. })
            ) && self.menu_contract.back_closes_dropdown
            {
                self.set_dropdown_open(id, false)?;
                return Ok(());
            }
            if matches!(
                self.node(id).map(|n| n.kind),
                Some(WidgetKind::NotificationActionSheet { open: true, .. })
            ) && self.menu_contract.back_closes_notification_sheet
            {
                self.set_notification_sheet_open(id, false)?;
                return Ok(());
            }
        }
        self.push_event(UiEvent::Back)
    }

    pub(crate) fn update_dial_value_at_pointer(
        &mut self,
        id: WidgetId,
        x: i32,
        y: i32,
    ) -> Result<(), GuiError> {
        let rect = self.absolute_rect(id).ok_or(GuiError::NotFound)?;
        let node = self.node_mut(id).ok_or(GuiError::NotFound)?;
        if let WidgetKind::Dial { value, min, max } = &mut node.kind {
            let cx = rect.x + rect.w as i32 / 2;
            let cy = rect.y + rect.h as i32 / 2;
            let dx = (x - cx) as f32;
            let dy = (y - cy) as f32;
            if dx != 0.0 || dy != 0.0 {
                #[cfg(not(feature = "std"))]
                use crate::math::F32Ext as _;

                let angle_rad = dy.atan2(dx);
                let mut angle_norm = angle_rad + core::f32::consts::PI;
                if angle_norm < 0.0 {
                    angle_norm += 2.0 * core::f32::consts::PI;
                }
                let progress = (angle_norm / (2.0 * core::f32::consts::PI)).clamp(0.0, 1.0);
                let next_val = *min + progress * (*max - *min);
                if (*value - next_val).abs() > 0.001 {
                    *value = next_val;
                    self.dirty.add(rect)?;
                    self.push_event(UiEvent::ValueChanged(id))?;
                }
            }
        }
        Ok(())
    }

    pub(crate) fn tick_rle_animations(&mut self, dt_ms: u32) -> Result<(), GuiError> {
        let mut dirty_rects = heapless::Vec::<Rect, NODES>::new();
        for node in self.widgets.iter_mut() {
            if let WidgetKind::RlePlayer {
                total_frames,
                ref mut current_frame,
                ref mut elapsed_ms,
                frame_duration_ms,
                ..
            } = node.kind
            {
                if total_frames > 1 && frame_duration_ms > 0 {
                    *elapsed_ms = elapsed_ms.saturating_add(dt_ms);
                    if *elapsed_ms >= frame_duration_ms {
                        let frames_to_advance = *elapsed_ms / frame_duration_ms;
                        *elapsed_ms %= frame_duration_ms;
                        *current_frame =
                            (*current_frame + frames_to_advance as usize) % total_frames;
                        let _ = dirty_rects.push(node.rect);
                    }
                }
            }
        }
        for rect in dirty_rects {
            self.dirty.add(rect)?;
        }
        Ok(())
    }
}

/// How far a finger must travel to move a selector by one step, at least.
///
/// A roller draws its rows across the whole widget, so one row is a third of its height — which is
/// only a few pixels for a short one (the sim's fixture roller is 18 px tall). The floor is what
/// keeps a small widget from stepping on every touch sample.
#[cfg(feature = "rich-widgets")]
const MIN_DRAG_STEP_PX: i32 = 12;

/// The most items one touch sample may move.
///
/// A finger is sampled about sixteen times a second on the ESP touch loop, but a slow frame can
/// still leave a long gap between two samples; without a ceiling, the catch-up travel would land as
/// a jump several items long instead of a turn.
#[cfg(feature = "rich-widgets")]
const MAX_DRAG_STEPS_PER_SAMPLE: i32 = 8;

/// How many rows a widget draws — the divisor that turns its height into a drag step.
///
/// The list-like widgets know their own row count (`visible_rows`); everything else that shows a
/// single selected line is treated like the roller, and the roller's own number comes from
/// `ROLLER_ROWS` so the renderer and the drag cannot drift apart.
#[cfg(feature = "rich-widgets")]
fn drag_rows(kind: &WidgetKind<'_>) -> i32 {
    let rows = match kind {
        WidgetKind::Roller { .. } => ROLLER_ROWS,
        WidgetKind::List { visible_rows, .. }
        | WidgetKind::CircularList { visible_rows, .. }
        | WidgetKind::RichMenu { visible_rows, .. }
        | WidgetKind::FeedTimeline { visible_rows, .. } => (*visible_rows).max(1) as u32,
        _ => ROLLER_ROWS,
    };
    rows.max(1) as i32
}

/// True for the kinds a finger drag turns.
///
/// This is `adjust_focused_selection`'s set — the widgets the Up/Down keys already step — and the
/// carousel, which that function steps too (it used to have no key path at all), so one rule covers
/// the keys and the finger alike. Two of the kinds that function handles are left out on purpose:
///
/// * the `ScrollView` scrolls *itself*; that is what the drag defers to when nothing else claims
///   the movement, and it is not a selection to turn;
/// * the `AutoComplete` cannot be reached at all. A press on it runs
///   `autocomplete_confirm_selection` and **returns** (`dispatch_activation`) — which collapses the
///   list and leaves the focus where it was — so by the time a finger moves, there is nothing
///   expanded to step and no focused widget to step it.
#[cfg(feature = "rich-widgets")]
fn is_drag_selector(kind: &WidgetKind<'_>) -> bool {
    matches!(
        kind,
        WidgetKind::Menu { .. }
            | WidgetKind::RichMenu { .. }
            | WidgetKind::Dropdown { .. }
            | WidgetKind::Roller { .. }
            | WidgetKind::Carousel { .. }
            | WidgetKind::Keyboard { .. }
            | WidgetKind::List { .. }
            | WidgetKind::CircularList { .. }
            | WidgetKind::FeedTimeline { .. }
    )
}

/// The value selectors: a finger step moves the value by one of the widget's own steps.
///
/// `None` means "not a value selector", which is a different answer from `Some(false)` — a value
/// selector that was already standing at its end and had nowhere to go.
#[cfg(feature = "rich-widgets")]
fn drag_step_value(kind: &mut WidgetKind<'_>, direction: i8, wrap: bool) -> Option<bool> {
    match kind {
        WidgetKind::Spinbox {
            value,
            min,
            max,
            step,
            ..
        } => {
            let (lo, hi) = ((*min).min(*max), (*min).max(*max));
            let next = value
                .saturating_add(i32::from(direction) * (*step).max(1))
                .clamp(lo, hi);
            let changed = next != *value;
            *value = next;
            Some(changed)
        }
        WidgetKind::NumberPicker {
            value, min, max, ..
        } => {
            let (lo, hi) = ((*min).min(*max), (*min).max(*max));
            let next = value.saturating_add(i32::from(direction)).clamp(lo, hi);
            let changed = next != *value;
            *value = next;
            Some(changed)
        }
        WidgetKind::TimePicker {
            hour,
            is_12h,
            is_pm,
            ..
        } => {
            let (next_hour, next_pm) = step_time_of_day(*hour, *is_pm, *is_12h, direction, wrap);
            let changed = next_hour != *hour || next_pm != *is_pm;
            *hour = next_hour;
            *is_pm = next_pm;
            Some(changed)
        }
        _ => None,
    }
}

/// One drag step of a time picker's hour, in the widget's own terms.
///
/// `wrap` is the same `menu_contract.wrap_navigation` the list-like selectors obey: off, the hour
/// stops at the end of its range; on, it rolls over. The 12-hour case is why this is a function of
/// its own — the arithmetic has to happen on a 24-hour value and be written back to two fields,
/// because 12 AM + 1 hour is 1 AM while 12 PM + 1 hour is 1 PM, and a bare `hour + 1` would quietly
/// turn one of those into the other.
#[cfg(feature = "rich-widgets")]
fn step_time_of_day(hour: u8, is_pm: bool, is_12h: bool, direction: i8, wrap: bool) -> (u8, bool) {
    let step = |from: i32, span: i32| {
        if wrap {
            (from + i32::from(direction)).rem_euclid(span)
        } else {
            (from + i32::from(direction)).clamp(0, span - 1)
        }
    };
    if !is_12h {
        return (step(i32::from(hour.min(23)), 24) as u8, is_pm);
    }
    let hour12 = i32::from(hour.clamp(1, 12));
    let day_hour = if hour12 == 12 { 0 } else { hour12 } + if is_pm { 12 } else { 0 };
    let next = step(day_hour, 24);
    let back = match next % 12 {
        0 => 12,
        other => other as u8,
    };
    (back, next >= 12)
}

#[cfg(feature = "rich-widgets")]
pub(crate) fn bump_index_with_wrap(current: &mut usize, len: usize, delta: i8, wrap: bool) -> bool {
    if len == 0 {
        return false;
    }
    let next = if delta >= 0 {
        if *current + 1 >= len {
            if wrap {
                0
            } else {
                *current
            }
        } else {
            *current + 1
        }
    } else if *current == 0 {
        if wrap {
            len - 1
        } else {
            *current
        }
    } else {
        *current - 1
    };
    if next != *current {
        *current = next;
        true
    } else {
        false
    }
}

#[cfg(feature = "rich-widgets")]
pub(crate) fn keyboard_char_for_layout(
    keys: &[char],
    alt_keys: Option<&[char]>,
    selected: usize,
    layout: KeyboardLayout,
) -> Option<char> {
    let base = keys.get(selected).copied()?;
    Some(match layout {
        KeyboardLayout::Normal => base,
        KeyboardLayout::Shift => {
            if base.is_ascii_alphabetic() {
                base.to_ascii_uppercase()
            } else {
                base
            }
        }
        KeyboardLayout::Symbols => alt_keys
            .and_then(|keys| keys.get(selected).copied())
            .unwrap_or('#'),
    })
}

#[cfg(feature = "rich-widgets")]
pub(crate) fn textarea_text(buf: &[u8; TEXTAREA_CAPACITY], len: u8) -> &str {
    let used = (len as usize).min(TEXTAREA_CAPACITY);
    core::str::from_utf8(&buf[..used]).unwrap_or("")
}

#[cfg(feature = "rich-widgets")]
pub(crate) fn textarea_storage_from_str(text: &str) -> ([u8; TEXTAREA_CAPACITY], u8) {
    let mut out = [0u8; TEXTAREA_CAPACITY];
    let mut len = 0usize;
    for ch in text.chars() {
        let mut tmp = [0u8; 4];
        let enc = ch.encode_utf8(&mut tmp).as_bytes();
        if len + enc.len() > TEXTAREA_CAPACITY {
            break;
        }
        out[len..len + enc.len()].copy_from_slice(enc);
        len += enc.len();
    }
    (out, len as u8)
}

#[cfg(feature = "rich-widgets")]
pub(crate) fn textarea_storage_from_chars(
    chars: &heapless::Vec<char, TEXTAREA_CAPACITY>,
) -> ([u8; TEXTAREA_CAPACITY], u8) {
    let mut out = [0u8; TEXTAREA_CAPACITY];
    let mut len = 0usize;
    for ch in chars {
        let mut tmp = [0u8; 4];
        let enc = ch.encode_utf8(&mut tmp).as_bytes();
        if len + enc.len() > TEXTAREA_CAPACITY {
            break;
        }
        out[len..len + enc.len()].copy_from_slice(enc);
        len += enc.len();
    }
    (out, len as u8)
}

#[cfg(feature = "rich-widgets")]
pub(crate) fn char_at(text: &str, idx: usize) -> Option<char> {
    text.chars().nth(idx)
}

#[cfg(feature = "rich-widgets")]
pub(crate) fn prev_word_boundary(text: &str, cursor: usize) -> usize {
    let mut pos = cursor.min(text.chars().count());
    while pos > 0 && char_at(text, pos - 1).is_some_and(|ch| ch.is_whitespace()) {
        pos -= 1;
    }
    while pos > 0 && char_at(text, pos - 1).is_some_and(|ch| !ch.is_whitespace()) {
        pos -= 1;
    }
    pos
}

#[cfg(feature = "rich-widgets")]
pub(crate) fn next_word_boundary(text: &str, cursor: usize) -> usize {
    let len = text.chars().count();
    let mut pos = cursor.min(len);
    while pos < len && char_at(text, pos).is_some_and(|ch| !ch.is_whitespace()) {
        pos += 1;
    }
    while pos < len && char_at(text, pos).is_some_and(|ch| ch.is_whitespace()) {
        pos += 1;
    }
    pos
}

#[cfg(feature = "rich-widgets")]
pub(crate) fn delete_selection_if_any(
    chars: &mut heapless::Vec<char, TEXTAREA_CAPACITY>,
    cursor: &mut usize,
    selection: &mut Option<(usize, usize)>,
) -> bool {
    let Some((start, end)) = *selection else {
        return false;
    };
    let start = start.min(end).min(chars.len());
    let end = end.max(start).min(chars.len());
    if end <= start {
        *selection = None;
        *cursor = start;
        return false;
    }
    for _ in start..end {
        chars.remove(start);
    }
    *cursor = start;
    *selection = None;
    true
}

#[cfg(feature = "rich-widgets")]
pub(crate) fn textarea_row_col_at_cursor(
    text: &str,
    cursor: usize,
    wrap_cols: usize,
) -> (usize, usize) {
    let mut row = 0usize;
    let mut col = 0usize;
    for ch in text.chars().take(cursor) {
        if ch == '\n' {
            row += 1;
            col = 0;
            continue;
        }
        col += 1;
        if col >= wrap_cols {
            row += 1;
            col = 0;
        }
    }
    (row, col)
}

#[cfg(feature = "rich-widgets")]
pub(crate) fn textarea_cursor_from_row_col(
    text: &str,
    target_row: usize,
    target_col: usize,
    wrap_cols: usize,
) -> usize {
    let mut row = 0usize;
    let mut col = 0usize;
    let mut idx = 0usize;
    for ch in text.chars() {
        if row == target_row && col >= target_col {
            break;
        }
        if ch == '\n' {
            if row == target_row {
                break;
            }
            row += 1;
            col = 0;
            idx += 1;
            continue;
        }
        idx += 1;
        col += 1;
        if col >= wrap_cols {
            if row == target_row {
                break;
            }
            row += 1;
            col = 0;
        }
    }
    idx
}

#[cfg(feature = "rich-widgets")]
pub(crate) fn textarea_row_end_col(text: &str, target_row: usize, wrap_cols: usize) -> usize {
    let mut row = 0usize;
    let mut col = 0usize;
    for ch in text.chars() {
        if row == target_row {
            if ch == '\n' {
                break;
            }
            col += 1;
            if col >= wrap_cols {
                break;
            }
        } else if ch == '\n' {
            row += 1;
            col = 0;
        } else {
            col += 1;
            if col >= wrap_cols {
                row += 1;
                col = 0;
            }
        }
    }
    col
}

/// The finger as a way to turn a selector (`GuiContext::drag_step_selection`).
///
/// A drag is driven the way the firmware drives it: `Pointer` events with `PointerState::Moved`
/// between a press and a release — exactly what the generated `ui.rs` `pointer()` sends while a
/// finger is down on the panel, and what no test had ever sent to a selector before.
#[cfg(all(test, feature = "rich-widgets"))]
mod drag_tests {
    use super::{is_drag_selector, step_time_of_day, MAX_DRAG_STEPS_PER_SAMPLE, MIN_DRAG_STEP_PX};
    use crate::geometry::Rect;
    use crate::input::{InputEvent, PointerButton, PointerState, UiEvent};
    use crate::widget::{MenuContract, WidgetId};
    use crate::widgets::WidgetKind;
    use crate::GuiContext;
    use crate::Style;

    /// The roller the designer drops by default.
    const SIZE: u32 = 80;
    /// One drawn row of it: `rect.h / ROLLER_ROWS`, which is one item of drag.
    const ROW: i32 = SIZE as i32 / 3;
    const ITEMS: &[&str] = &["one", "two", "three", "four"];

    /// The context under test, with room for the events a press and a drag raise: the default
    /// `<32, 16, 16>` fills up during one press and the next call answers `EventsFull`.
    type Ctx = GuiContext<'static, 32, 64, 16>;

    fn roller(size: (u32, u32)) -> (Ctx, WidgetId) {
        let mut ctx: Ctx = GuiContext::new(Rect::new(0, 0, 320, 240));
        let id = ctx
            .add_roller(
                Rect::new(100, 100, size.0, size.1),
                ITEMS,
                0,
                Style::panel(),
            )
            .unwrap();
        (ctx, id)
    }

    fn point(ctx: &mut Ctx, x: i32, y: i32, state: PointerState) {
        ctx.handle_input(InputEvent::Pointer {
            x,
            y,
            state,
            button: PointerButton::Primary,
        })
        .unwrap();
    }

    /// Press at `at`, then move by each offset in turn.
    fn drag(ctx: &mut Ctx, at: (i32, i32), moves: &[i32]) {
        point(ctx, at.0, at.1, PointerState::Pressed);
        let mut y = at.1;
        for dy in moves {
            y += dy;
            point(ctx, at.0, y, PointerState::Moved);
        }
    }

    /// The index any index-keeping widget shows.
    fn index_of(ctx: &Ctx, id: WidgetId) -> Option<usize> {
        let node = ctx.widgets().iter().find(|n| n.id == id)?;
        Some(match node.kind {
            WidgetKind::Roller { selected, .. }
            | WidgetKind::Menu { selected, .. }
            | WidgetKind::RichMenu { selected, .. }
            | WidgetKind::Dropdown { selected, .. }
            | WidgetKind::List { selected, .. }
            | WidgetKind::CircularList { selected, .. }
            | WidgetKind::Carousel { selected, .. }
            | WidgetKind::FeedTimeline { selected, .. }
            | WidgetKind::Keyboard { selected, .. } => selected,
            _ => return None,
        })
    }

    /// The value a numeric control shows.
    fn value_of(ctx: &Ctx, id: WidgetId) -> Option<i32> {
        let node = ctx.widgets().iter().find(|n| n.id == id)?;
        match node.kind {
            WidgetKind::Spinbox { value, .. } | WidgetKind::NumberPicker { value, .. } => {
                Some(value)
            }
            _ => None,
        }
    }

    /// Whether a checkbox is checked.
    fn checked_of(ctx: &Ctx, id: WidgetId) -> Option<bool> {
        let node = ctx.widgets().iter().find(|n| n.id == id)?;
        match node.kind {
            WidgetKind::Checkbox { checked, .. } => Some(checked),
            _ => None,
        }
    }

    /// A time picker's hour and period.
    fn time_of(ctx: &Ctx, id: WidgetId) -> Option<(u8, bool)> {
        let node = ctx.widgets().iter().find(|n| n.id == id)?;
        match node.kind {
            WidgetKind::TimePicker { hour, is_pm, .. } => Some((hour, is_pm)),
            _ => None,
        }
    }

    fn is_value_changed(ctx: &Ctx, id: WidgetId) -> bool {
        ctx.events
            .iter()
            .any(|e| matches!(e, UiEvent::ValueChanged(w) if *w == id))
    }

    #[test]
    fn a_drag_turns_the_roller_one_item_per_drawn_row() {
        let (mut ctx, id) = roller((SIZE, SIZE));
        drag(&mut ctx, (140, 140), &[ROW]);
        assert_eq!(
            index_of(&ctx, id),
            Some(1),
            "one drawn row of travel is one item"
        );
        assert!(
            is_value_changed(&ctx, id),
            "and the design is told, like the arrow keys tell it"
        );
        drag(&mut ctx, (140, 140), &[ROW, ROW]);
        assert_eq!(index_of(&ctx, id), Some(3));
        drag(&mut ctx, (140, 140), &[-ROW]);
        assert_eq!(index_of(&ctx, id), Some(2), "dragging up steps back");
    }

    #[test]
    fn half_a_row_waits_and_the_remainder_is_carried() {
        let (mut ctx, id) = roller((SIZE, SIZE));
        drag(&mut ctx, (140, 140), &[ROW / 2]);
        assert_eq!(
            index_of(&ctx, id),
            Some(0),
            "half a row is not a whole item"
        );
        // The other half finishes the row, because the movement is accumulated rather than rounded:
        // that is the difference between a wheel that follows the finger and one that needs a full
        // row per touch sample.
        point(&mut ctx, 140, 140 + ROW, PointerState::Moved);
        assert_eq!(
            index_of(&ctx, id),
            Some(1),
            "the two halves add up to one item"
        );
    }

    #[test]
    fn a_short_roller_uses_the_floor_rather_than_a_third_of_its_height() {
        // 18 px tall is the sim fixture's roller; a third of it is 6 px, which would step on every
        // sample the panel sends.
        let (mut ctx, id) = roller((150, 18));
        drag(&mut ctx, (175, 109), &[MIN_DRAG_STEP_PX]);
        assert_eq!(
            index_of(&ctx, id),
            Some(1),
            "one item costs the floor, not 6 px"
        );
        drag(&mut ctx, (175, 109), &[MIN_DRAG_STEP_PX - 1]);
        assert_eq!(
            index_of(&ctx, id),
            Some(1),
            "and just under it does not step"
        );
    }

    #[test]
    fn a_jump_is_capped_so_a_slow_frame_cannot_skip_the_list() {
        let (mut ctx, id) = roller((SIZE, SIZE));
        drag(
            &mut ctx,
            (140, 140),
            &[ROW * (MAX_DRAG_STEPS_PER_SAMPLE + 4)],
        );
        assert_eq!(
            index_of(&ctx, id),
            Some(MAX_DRAG_STEPS_PER_SAMPLE as usize % ITEMS.len()),
            "one sample moves at most the cap, however far the finger travelled"
        );
    }

    #[test]
    fn the_drag_obeys_the_wrap_setting_the_arrow_keys_use() {
        let (mut ctx, id) = roller((SIZE, SIZE));
        drag(&mut ctx, (140, 140), &[-ROW]);
        assert_eq!(
            index_of(&ctx, id),
            Some(3),
            "wrapping on: back from the first item is the last"
        );
        drag(&mut ctx, (140, 140), &[ROW]);
        assert_eq!(
            index_of(&ctx, id),
            Some(0),
            "and forward from the last is the first"
        );
        ctx.set_menu_contract(MenuContract {
            wrap_navigation: false,
            ..Default::default()
        });
        drag(&mut ctx, (140, 140), &[-ROW]);
        assert_eq!(
            index_of(&ctx, id),
            Some(0),
            "wrapping off: it stops at the first item, as the keys do"
        );
    }

    #[test]
    fn a_selector_inside_a_scroll_view_takes_the_drag_and_the_view_stays_put() {
        let mut ctx: Ctx = GuiContext::new(Rect::new(0, 0, 320, 240));
        let view = ctx
            .add_scroll_view(Rect::new(0, 0, 200, 200), 0, 800, Style::panel())
            .unwrap();
        let roll = ctx
            .add_roller(Rect::new(20, 20, SIZE, SIZE), ITEMS, 0, Style::panel())
            .unwrap();
        ctx.add_child(view, roll).unwrap();

        drag(&mut ctx, (60, 60), &[ROW]);
        assert_eq!(
            index_of(&ctx, roll),
            Some(1),
            "the finger was on the roller, so the roller turns"
        );
        assert_eq!(
            ctx.scroll_offset(view),
            Some(0),
            "and the view behind it does not also scroll"
        );
    }

    #[test]
    fn a_drag_on_the_view_itself_still_scrolls_it() {
        let mut ctx: Ctx = GuiContext::new(Rect::new(0, 0, 320, 240));
        let view = ctx
            .add_scroll_view(Rect::new(0, 0, 200, 200), 0, 800, Style::panel())
            .unwrap();
        drag(&mut ctx, (100, 100), &[-40]);
        assert!(
            ctx.scroll_offset(view).unwrap_or(0) > 0,
            "an empty part of the view is still a scroll gesture"
        );
    }

    #[test]
    fn the_other_index_selectors_turn_with_the_same_finger() {
        // One rule for keys and finger: these are the kinds `adjust_focused_selection` steps, and
        // the drag calls it, so each is asserted through the event it raises rather than through a
        // getter per widget.
        let mut ctx: Ctx = GuiContext::new(Rect::new(0, 0, 320, 240));
        let list = ctx
            .add_list(Rect::new(0, 0, 120, 120), ITEMS, 0, 4, Style::panel())
            .unwrap();
        let menu = ctx
            .add_menu(Rect::new(140, 0, 120, 120), ITEMS, 0, Style::panel())
            .unwrap();
        let carousel = ctx
            .add_carousel(
                Rect::new(0, 140, 120, 80),
                ITEMS,
                0,
                crate::widgets::CarouselSpec::new(16, 4),
                Style::panel(),
            )
            .unwrap();

        // Each widget costs its own drawn row, so each is dragged by its own step: a list divides its
        // height by `visible_rows`, and a menu and a carousel by their three rows. The dropdown is
        // the one that needs a word of its own — see the two tests below.
        for (id, at, step) in [
            (list, (60, 60), 120 / 4),
            (menu, (200, 60), 120 / 3),
            (carousel, (60, 180), 80 / 3),
        ] {
            ctx.events.clear();
            drag(&mut ctx, at, &[step]);
            assert_eq!(
                ctx.focus(),
                Some(id),
                "the press lands on and focuses the widget under it"
            );
            assert_eq!(
                index_of(&ctx, id),
                Some(1),
                "a drag turns it, like the keys do"
            );
            assert!(is_value_changed(&ctx, id), "and raises ValueChanged");
        }
    }

    #[test]
    fn an_open_dropdown_turns_by_drag_when_a_press_does_not_toggle_it() {
        // The drag reaches a dropdown when the app has taken the toggle contract off and opens it
        // itself; the next test pins why that is the only way it can work.
        let mut ctx: Ctx = GuiContext::new(Rect::new(0, 0, 320, 240));
        ctx.set_menu_contract(MenuContract {
            select_opens_dropdown: false,
            ..Default::default()
        });
        let drop = ctx
            .add_dropdown(Rect::new(140, 140, 120, 20), ITEMS, 0, Style::panel())
            .unwrap();
        ctx.set_dropdown_open(drop, true).unwrap();

        drag(&mut ctx, (200, 150), &[MIN_DRAG_STEP_PX]);
        assert_eq!(
            index_of(&ctx, drop),
            Some(1),
            "the open list turns under the finger"
        );
        assert!(is_value_changed(&ctx, drop));
    }

    #[test]
    fn with_the_default_contract_a_press_closes_a_dropdown_instead_of_stepping_it() {
        // `select_opens_dropdown` means a press *toggles* the list — so the press that would start a
        // drag is also the one that dismisses it. That is the contract's own behaviour and not
        // something the drag may quietly override, so it is pinned here rather than worked around.
        let mut ctx: Ctx = GuiContext::new(Rect::new(0, 0, 320, 240));
        let drop = ctx
            .add_dropdown(Rect::new(140, 140, 120, 20), ITEMS, 0, Style::panel())
            .unwrap();
        ctx.set_dropdown_open(drop, true).unwrap();

        drag(&mut ctx, (200, 150), &[MIN_DRAG_STEP_PX]);
        assert_eq!(
            index_of(&ctx, drop),
            Some(0),
            "the press closed the list instead of stepping it"
        );
    }

    #[test]
    fn a_drag_steps_a_spinbox_number_picker_and_time_picker_by_their_own_step() {
        let mut ctx: Ctx = GuiContext::new(Rect::new(0, 0, 320, 240));
        let spin = ctx
            .add_spinbox(Rect::new(0, 0, 80, 24), 0, 100, 50, Style::panel())
            .unwrap();
        let pick = ctx
            .add_number_picker(Rect::new(0, 40, 80, 24), 0, 10, 5, " kg", Style::panel())
            .unwrap();
        let time = ctx
            .add_time_picker(Rect::new(0, 80, 80, 24), 11, 30, true, true, Style::panel())
            .unwrap();

        drag(&mut ctx, (40, 12), &[MIN_DRAG_STEP_PX]);
        drag(&mut ctx, (40, 52), &[-MIN_DRAG_STEP_PX]);
        drag(&mut ctx, (40, 92), &[-MIN_DRAG_STEP_PX]);

        assert!(
            value_of(&ctx, spin).unwrap() > 50,
            "the spinbox moved by its own step"
        );
        assert_eq!(
            value_of(&ctx, pick),
            Some(4),
            "the number picker moved by exactly one"
        );
        assert_eq!(
            time_of(&ctx, time),
            Some((10, true)),
            "11 PM back an hour is 10 PM: the period follows the hour it was on"
        );
    }

    #[test]
    fn a_value_control_stops_at_its_bounds() {
        let mut ctx: Ctx = GuiContext::new(Rect::new(0, 0, 320, 240));
        let pick = ctx
            .add_number_picker(Rect::new(0, 0, 80, 24), 0, 3, 3, "", Style::panel())
            .unwrap();
        drag(&mut ctx, (40, 12), &[MIN_DRAG_STEP_PX, MIN_DRAG_STEP_PX]);
        assert_eq!(
            value_of(&ctx, pick),
            Some(3),
            "a value selector has no wrapping to obey"
        );
    }

    #[test]
    fn a_twelve_hour_picker_rolls_the_period_with_the_hour() {
        // 11 PM + 1 is 12 AM, and 11 AM + 1 is 12 PM: a bare `hour + 1` turns one of those into the
        // other, which is why the pair is computed from a 24-hour value.
        assert_eq!(step_time_of_day(11, true, true, 1, true), (12, false));
        assert_eq!(step_time_of_day(11, false, true, 1, true), (12, true));
        assert_eq!(
            step_time_of_day(12, false, true, -1, true),
            (11, true),
            "12 AM back one hour is 11 PM"
        );
        assert_eq!(
            step_time_of_day(12, true, true, 1, true),
            (1, true),
            "12 PM forward is 1 PM"
        );
    }

    #[test]
    fn a_twenty_four_hour_picker_clamps_or_wraps_by_the_same_setting() {
        assert_eq!(
            step_time_of_day(23, false, false, 1, false),
            (23, false),
            "wrapping off stops at 23:00"
        );
        assert_eq!(
            step_time_of_day(23, false, false, 1, true),
            (0, false),
            "wrapping on rolls into 00:00"
        );
        assert_eq!(step_time_of_day(0, false, false, -1, false), (0, false));
        assert_eq!(step_time_of_day(0, false, false, -1, true), (23, false));
    }

    #[test]
    fn an_action_that_changed_the_widget_gives_the_focus_back() {
        // Asked 2026-10-14: *"When the widgits action was performed (e.g. a checkbox sate was toggled), that
        // widgit should automatically lose focus."*
        let mut ctx: Ctx = GuiContext::new(Rect::new(0, 0, 320, 240));
        let check = ctx
            .add_checkbox(Rect::new(0, 0, 120, 24), "Enable", false, Style::panel())
            .unwrap();

        point(&mut ctx, 60, 12, PointerState::Pressed);
        // This engine activates on the *press*, so the focus is taken and handed straight back inside that
        // one event: the widget never stays highlighted, which is the whole point of the report.
        assert_eq!(
            ctx.focus(),
            None,
            "the widget acted, so it did not keep the focus"
        );
        assert!(
            ctx.events
                .iter()
                .any(|e| matches!(e, UiEvent::Focused(id) if *id == check)),
            "it did take the focus on the way in"
        );
        assert!(
            ctx.events
                .iter()
                .any(|e| matches!(e, UiEvent::Defocused(id) if *id == check)),
            "and gave it back again"
        );
        point(&mut ctx, 60, 12, PointerState::Released);

        assert_eq!(checked_of(&ctx, check), Some(true), "the tap toggled it");
        assert_eq!(ctx.focus(), None, "and nothing is left focused afterwards");
    }

    #[test]
    fn a_tap_that_changed_nothing_keeps_the_focus() {
        // The roller is the other half of the same report: a tap selects nothing (a drag does), so it keeps
        // the focus -- which no longer recolours anything, so nothing is hidden by it either.
        let (mut ctx, id) = roller((SIZE, SIZE));
        point(&mut ctx, 140, 140, PointerState::Pressed);
        point(&mut ctx, 140, 140, PointerState::Released);
        assert_eq!(
            ctx.focus(),
            Some(id),
            "nothing changed, so nothing is given up"
        );
    }

    #[test]
    fn a_drag_that_turns_a_selector_keeps_the_focus_it_needs() {
        // The drag needs the widget focused to know which one to turn (see `drag_step_selection`), so the
        // auto-defocus must not fire on a movement that changed the selection -- only on an activation.
        let (mut ctx, id) = roller((SIZE, SIZE));
        drag(&mut ctx, (140, 140), &[ROW]);
        assert_eq!(index_of(&ctx, id), Some(1));
        assert_eq!(ctx.focus(), Some(id), "a turned roller still has the focus");
    }

    #[test]
    fn the_drag_set_is_the_key_step_set_and_never_the_view() {
        assert!(is_drag_selector(&WidgetKind::Roller {
            items: ITEMS,
            selected: 0
        }));
        assert!(is_drag_selector(&WidgetKind::List {
            items: ITEMS,
            selected: 0,
            offset: 0,
            visible_rows: 4
        }));
        assert!(
            !is_drag_selector(&WidgetKind::ScrollView {
                offset_y: 0,
                content_h: 400
            }),
            "the view scrolls itself; that is what the drag defers to"
        );
        // A press on an autocomplete confirms the selection and collapses the list — and does not
        // focus the widget — so a finger can never find it expanded and focused. Its own test above
        // pins the dropdown's version of the same contract problem.
        let mut ctx: Ctx = GuiContext::new(Rect::new(0, 0, 320, 240));
        let auto = ctx
            .add_autocomplete_widget(Rect::new(0, 0, 160, 60), ITEMS, Style::panel())
            .unwrap();
        let kind = ctx
            .widgets()
            .iter()
            .find(|n| n.id == auto)
            .map(|n| n.kind)
            .unwrap();
        assert!(
            !is_drag_selector(&kind),
            "an autocomplete cannot be reached by a finger"
        );
        // A value control is stepped as a value, not as an index. Built through the builder so the
        // test does not have to restate the widget's own defaults to name the kind.
        let mut ctx: Ctx = GuiContext::new(Rect::new(0, 0, 320, 240));
        let spin = ctx
            .add_spinbox(Rect::new(0, 0, 80, 24), 0, 9, 0, Style::panel())
            .unwrap();
        let kind = ctx
            .widgets()
            .iter()
            .find(|n| n.id == spin)
            .map(|n| n.kind)
            .unwrap();
        assert!(
            !is_drag_selector(&kind),
            "a value control is stepped as a value, not as an index"
        );
    }
}
