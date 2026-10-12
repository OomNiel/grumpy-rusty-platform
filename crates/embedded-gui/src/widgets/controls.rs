use crate::{
    geometry::Rect,
    style::Style,
    widget::{PropertyError, PropertyKey, PropertyValue, Widget},
};

/// Interactive slider widget.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SliderWidget {
    pub value: f32,
    pub min: f32,
    pub max: f32,
}

impl SliderWidget {
    pub fn new(value: f32, min: f32, max: f32) -> Self {
        Self {
            value: value.clamp(min, max),
            min,
            max,
        }
    }
}

impl Widget for SliderWidget {
    fn render_widget_bounds(&self, _bounds: Rect, _style: &Style) {}

    fn get_property(&self, key: PropertyKey) -> Option<PropertyValue<'_>> {
        match key {
            PropertyKey::Value => Some(PropertyValue::Float(self.value)),
            PropertyKey::Min => Some(PropertyValue::Float(self.min)),
            PropertyKey::Max => Some(PropertyValue::Float(self.max)),
            _ => None,
        }
    }

    fn set_property<'a>(
        &mut self,
        key: PropertyKey,
        val: PropertyValue<'a>,
    ) -> Result<(), PropertyError> {
        match (key, val) {
            (PropertyKey::Value, PropertyValue::Float(v)) => {
                self.value = v.clamp(self.min, self.max);
                Ok(())
            }
            _ => Err(PropertyError::NotFound),
        }
    }
}

/// Toggle switch widget.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ToggleWidget<'a> {
    pub label: &'a str,
    pub on: bool,
}

impl<'a> ToggleWidget<'a> {
    pub fn new(label: &'a str, on: bool) -> Self {
        Self { label, on }
    }
}

impl<'a> Widget for ToggleWidget<'a> {
    fn render_widget_bounds(&self, _bounds: Rect, _style: &Style) {}

    fn get_property(&self, key: PropertyKey) -> Option<PropertyValue<'_>> {
        match key {
            PropertyKey::State => Some(PropertyValue::Bool(self.on)),
            PropertyKey::Text => Some(PropertyValue::Str(self.label)),
            _ => None,
        }
    }

    fn set_property<'b>(
        &mut self,
        key: PropertyKey,
        val: PropertyValue<'b>,
    ) -> Result<(), PropertyError> {
        match (key, val) {
            (PropertyKey::State, PropertyValue::Bool(b)) => {
                self.on = b;
                Ok(())
            }
            _ => Err(PropertyError::NotFound),
        }
    }
}

/// Where a checkbox's label sits relative to its box.
///
/// The box and the label are two things in one widget, and the arrangement used to be fixed: the label was
/// always drawn to the right of the box. Naming the side is what lets a design put the label above a box that
/// is wider than any row, or to its left where a thumb reaches from the other side.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckboxLabelPosition {
    /// The label to the left of the box.
    Left,
    /// The label to the right of the box -- the crate's own arrangement, so a design that says nothing keeps
    /// the layout it has always had.
    Right,
    /// The label above the box.
    Top,
    /// The label below the box.
    Bottom,
}

impl Default for CheckboxLabelPosition {
    fn default() -> Self {
        Self::Right
    }
}

impl CheckboxLabelPosition {
    /// The name the markup uses, which is also the name this reports back under.
    pub const fn name(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
            Self::Top => "top",
            Self::Bottom => "bottom",
        }
    }

    /// Parses the markup's name. Anything unrecognised is the crate's own arrangement, which is what a design
    /// written before this field existed expects.
    pub fn from_name(name: &str) -> Self {
        match name {
            "left" => Self::Left,
            "top" => Self::Top,
            "bottom" => Self::Bottom,
            _ => Self::Right,
        }
    }
}

/// Checkbox widget.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CheckboxWidget<'a> {
    pub label: &'a str,
    pub checked: bool,
}

impl<'a> Widget for CheckboxWidget<'a> {
    fn render_widget_bounds(&self, _bounds: Rect, _style: &Style) {}

    fn get_property(&self, key: PropertyKey) -> Option<PropertyValue<'_>> {
        match key {
            PropertyKey::State => Some(PropertyValue::Bool(self.checked)),
            PropertyKey::Text => Some(PropertyValue::Str(self.label)),
            _ => None,
        }
    }
}
