use thiserror::Error;

#[derive(Error, Debug)]
pub enum CodegenError {
    #[error("KDL parse error: {0}")]
    Parse(#[from] kdl::KdlError),
    #[error("Missing required attribute '{0}' on node '{1}'")]
    MissingAttribute(&'static str, String),
    #[error("Invalid attribute value for '{0}': {1}")]
    InvalidValue(String, String),
    #[error("Invalid track specification: {0}")]
    InvalidTrack(String),
    #[error("Unknown widget or container node: '{0}'")]
    UnknownNode(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum GridTrackDef {
    Px(u32),
    Fr(u8),
    Auto,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GridPlacementDef {
    pub col: usize,
    pub row: usize,
    pub col_span: usize,
    pub row_span: usize,
    /// Optional motion applied to this widget by the generated app and Studio preview.
    pub animation: Option<WidgetAnimationDef>,
}

impl Default for GridPlacementDef {
    fn default() -> Self {
        Self {
            col: 0,
            row: 0,
            col_span: 1,
            row_span: 1,
            animation: None,
        }
    }
}

/// Declarative animation attached to a widget node in KDL.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WidgetAnimationDef {
    /// Named preset, for example `fade_in_up`, `slide_in_left`, or `pulse`.
    pub preset: String,
    /// `screen_enter`, `screen_exit`, `click`, or `loop`.
    pub trigger: String,
    pub duration_ms: u32,
    pub delay_ms: u32,
    /// An `embedded_gui::animation::Easing` variant in snake case.
    pub easing: String,
    /// Number of plays. `0` means repeat forever.
    pub repeat: u16,
}

impl Default for WidgetAnimationDef {
    fn default() -> Self {
        Self {
            preset: "fade_in_up".into(),
            trigger: "screen_enter".into(),
            duration_ms: 400,
            delay_ms: 0,
            easing: "out_cubic".into(),
            repeat: 1,
        }
    }
}

/// Default transition used when this screen is navigated to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScreenTransitionDef {
    /// A named `TransitionPreset`, stored in snake case.
    pub preset: String,
    pub duration_ms: u32,
    pub easing: String,
    pub origin: String,
}

impl Default for ScreenTransitionDef {
    fn default() -> Self {
        Self {
            preset: "window_push".into(),
            duration_ms: 300,
            easing: "in_out_sine".into(),
            origin: "center".into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum PathVerbDef {
    MoveTo(i32, i32),
    LineTo(i32, i32),
    QuadTo(i32, i32, i32, i32),
    CubicTo(i32, i32, i32, i32, i32, i32),
    Close,
}

#[derive(Clone, Debug, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum WidgetDef {
    Label {
        id: Option<String>,
        text: String,
        style: Option<String>,
        /// Name of a `font` declared on the screen, e.g. a BDF import.
        font: Option<String>,
    },
    Button {
        id: Option<String>,
        text: String,
        on_click: Option<String>,
        style: Option<String>,
        bg: Option<String>,
        fg: Option<String>,
        text_color: Option<String>,
        pressed_bg: Option<String>,
        pressed_fg: Option<String>,
        pressed_text: Option<String>,
        disabled_bg: Option<String>,
        disabled_fg: Option<String>,
        disabled_text: Option<String>,
        focused_bg: Option<String>,
        focused_fg: Option<String>,
        focused_text: Option<String>,
        border_color: Option<String>,
        corner_radius: Option<u8>,
    },
    Toggle {
        id: Option<String>,
        label: String,
        checked: bool,
        off_color: Option<String>,
        track_border: Option<String>,
        track_border_width: u8,
        style: Option<String>,
    },
    Checkbox {
        id: Option<String>,
        label: String,
        checked: bool,
        /// How wide the box is, in pixels. `0` asks the crate for its own rule.
        box_width: u8,
        /// How tall the box is, in pixels. `0` asks the crate for its own rule.
        box_height: u8,
        /// Which side of the box the label is drawn on: `left`, `right`, `top` or `bottom`.
        label_position: String,
        box_color: Option<String>,
        style: Option<String>,
    },
    Slider {
        id: Option<String>,
        min: f32,
        max: f32,
        value: f32,
        style: Option<String>,
    },
    Dropdown {
        id: Option<String>,
        options: Vec<String>,
        selected: usize,
        style: Option<String>,
    },
    Roller {
        id: Option<String>,
        options: Vec<String>,
        selected: usize,
        style: Option<String>,
    },
    Scale {
        id: Option<String>,
        mode: String,
        min: f32,
        max: f32,
        value: f32,
        major_ticks: u8,
        minor_ticks: u8,
        start_angle: i16,
        end_angle: i16,
        show_labels: bool,
        show_needle: bool,
        tick_color: Option<String>,
        needle_color: Option<String>,
        style: Option<String>,
    },
    Spinbox {
        id: Option<String>,
        min: i32,
        max: i32,
        value: i32,
        digits: u8,
        decimals: u8,
        accent_color: Option<String>,
        chevron_color: Option<String>,
        style: Option<String>,
    },
    Table {
        id: Option<String>,
        headers: Option<Vec<String>>,
        rows: Vec<Vec<String>>,
        style: Option<String>,
    },
    ProgressBar {
        id: Option<String>,
        value: f32,
        style: Option<String>,
    },
    SweepingArc {
        id: Option<String>,
        progress: f32,
        clockwise: bool,
        arc_radius: u32,
        frame_inset: u16,
        corner_radius: u8,
        bg_color: String,
        arc_color: String,
        frame_color: String,
        style: Option<String>,
    },
    BusyWheel {
        id: Option<String>,
        phase: f32,
        style: Option<String>,
    },
    /// A line chart over a fixed series of points.
    Chart {
        id: Option<String>,
        values: Vec<f32>,
        min: f32,
        max: f32,
        style: Option<String>,
    },
    /// A streaming plotter over a fixed series with a moving head.
    Plotter {
        id: Option<String>,
        values: Vec<f32>,
        head: usize,
        min: f32,
        max: f32,
        style: Option<String>,
    },
    StatusBar {
        id: Option<String>,
        time: String,
        style: Option<String>,
    },
    TimePicker {
        id: Option<String>,
        hour: u8,
        minute: u8,
        is_12h: bool,
        is_pm: bool,
        style: Option<String>,
    },
    NumberPicker {
        id: Option<String>,
        min: i32,
        max: i32,
        value: i32,
        unit: String,
        style: Option<String>,
    },
    Dialog {
        id: Option<String>,
        title: String,
        message: String,
        dialog_type: String,
        style: Option<String>,
    },
    ContentIndicator {
        id: Option<String>,
        count: u8,
        active: u8,
        style: Option<String>,
    },
    CrumbsIndicator {
        id: Option<String>,
        count: u8,
        active: u8,
        style: Option<String>,
    },
    Panel {
        id: Option<String>,
        style: Option<String>,
    },
    Image {
        id: Option<String>,
        source: String,
        fit: String,
        mode: String,
        tint: Option<String>,
    },
    /// An image the *device* reads at runtime -- a file on a mounted card -- rather than one embedded at build
    /// time.
    ///
    /// Its own variant because the build-time asset pipeline is not ours: the `include_gui!` macro reads every
    /// `Image`'s file off disk, refuses paths outside the project, and decodes them with the `image` crate. A
    /// card path does not exist on the build machine at all, so an `SdImage` must be something the macro's
    /// `let ... else { continue }` skips -- and it is, because it is not an `Image`.
    SdImage {
        id: Option<String>,
        /// The path as the driver wants it, without the `sd:` prefix the design writes.
        path: String,
        fit: String,
    },
    /// Wrap-around scrolling list with slot falloff, edge fade, and chrome masks.
    Carousel {
        id: Option<String>,
        items: Vec<String>,
        selected: usize,
        item_step: u16,
        visible: u8,
        shift: i16,
        mask_top: u16,
        mask_bottom: u16,
        fade: bool,
        indicator: bool,
        pulse: u8,
        style: Option<String>,
        font: Option<String>,
    },
    /// Stacked 1bpp bitmap parts, each independently toggled and tinted.
    CompositeIcon {
        id: Option<String>,
        parts: Vec<IconPartDef>,
        scale: u8,
        align: String,
        tint: Option<String>,
        threshold: u8,
        invert: bool,
    },
    /// A mesh rendered through embedded-3dgfx inside the widget rect.
    Mesh3d {
        id: Option<String>,
        source: String,
        shading: String,
        color: Option<String>,
        scale: f32,
        roll: f32,
        pitch: f32,
        yaw: f32,
        camera_distance: f32,
        fov: f32,
    },
    Spacer,
    VectorPath {
        id: Option<String>,
        stroke_width: u8,
        colour: Option<String>,
        verbs: Vec<PathVerbDef>,
    },
    RectShape {
        id: Option<String>,
        radius: u8,
        stroke_width: u8,
        fill_color: Option<String>,
        stroke_color: Option<String>,
    },
    LineShape {
        id: Option<String>,
        stroke_width: u8,
        color: Option<String>,
    },
    CircleShape {
        id: Option<String>,
        radius: u16,
        stroke_width: u8,
        fill_color: Option<String>,
        stroke_color: Option<String>,
    },
    TriangleShape {
        id: Option<String>,
        stroke_width: u8,
        fill_color: Option<String>,
        stroke_color: Option<String>,
        /// The three vertices as per-mille offsets into the cell: `[p1x, p1y, p2x, p2y, p3x, p3y]`. The
        /// designer chooses them; absent ones are the isosceles triangle it drops by default.
        points: [i16; 6],
    },
}

/// One layer of a [`WidgetDef::CompositeIcon`].
#[derive(Clone, Debug, PartialEq)]
pub struct IconPartDef {
    pub source: String,
    pub dx: i32,
    pub dy: i32,
    pub visible: bool,
    pub tint: Option<String>,
}

/// A font imported by a screen, resolved to bitmap data by a project-aware
/// caller such as `include_gui!`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FontAssetDef {
    /// Name referenced by `font=` on widgets.
    pub name: String,
    pub source: String,
    /// Characters to embed; empty means the font's full range.
    pub chars: String,
}

/// RGB565 image data resolved by a project-aware caller such as `include_gui!`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImageAssetDef {
    pub source: String,
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u16>,
}

impl WidgetDef {
    pub fn id(&self) -> Option<&str> {
        match self {
            WidgetDef::Label { id, .. }
            | WidgetDef::Button { id, .. }
            | WidgetDef::Toggle { id, .. }
            | WidgetDef::Checkbox { id, .. }
            | WidgetDef::Slider { id, .. }
            | WidgetDef::Dropdown { id, .. }
            | WidgetDef::Roller { id, .. }
            | WidgetDef::Scale { id, .. }
            | WidgetDef::Spinbox { id, .. }
            | WidgetDef::Table { id, .. }
            | WidgetDef::ProgressBar { id, .. }
            | WidgetDef::SweepingArc { id, .. }
            | WidgetDef::BusyWheel { id, .. }
            | WidgetDef::Chart { id, .. }
            | WidgetDef::Plotter { id, .. }
            | WidgetDef::StatusBar { id, .. }
            | WidgetDef::TimePicker { id, .. }
            | WidgetDef::NumberPicker { id, .. }
            | WidgetDef::Dialog { id, .. }
            | WidgetDef::ContentIndicator { id, .. }
            | WidgetDef::CrumbsIndicator { id, .. }
            | WidgetDef::Panel { id, .. }
            | WidgetDef::Image { id, .. }
            | WidgetDef::SdImage { id, .. }
            | WidgetDef::Carousel { id, .. }
            | WidgetDef::CompositeIcon { id, .. }
            | WidgetDef::Mesh3d { id, .. }
            | WidgetDef::VectorPath { id, .. }
            | WidgetDef::RectShape { id, .. }
            | WidgetDef::LineShape { id, .. }
            | WidgetDef::CircleShape { id, .. }
            | WidgetDef::TriangleShape { id, .. } => id.as_deref(),
            WidgetDef::Spacer => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct GridLayoutDef {
    pub id: Option<String>,
    pub cols: Vec<GridTrackDef>,
    pub rows: Vec<GridTrackDef>,
    pub gap: u16,
    pub padding: u16,
    pub children: Vec<(GridPlacementDef, WidgetDef)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ScreenDef {
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub theme: Option<String>,
    /// Transition used by project navigation when this screen is the destination.
    pub transition: Option<ScreenTransitionDef>,
    /// Fonts imported by this screen, referenced by `font=` on widgets.
    pub fonts: Vec<FontAssetDef>,
    pub grid: GridLayoutDef,
}
