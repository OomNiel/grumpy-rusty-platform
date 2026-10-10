//! The vector-path widget: what it strokes, where, and how much of it.
//!
//! A path is the one shape whose *cost* is not obvious from its cell: a curve is a handful of straight segments
//! on the glass, and the number of them is a fixed property of this crate rather than of the design that drew
//! it. So the tests count segments, not just "something was drawn" -- an implementation that flattened a curve
//! adaptively, or not at all, would still paint a line and would still look right at a glance.

use embedded_gui::prelude::{CustomCanvas, CustomWidget, GuiError, Rect, Rgb565};
use embedded_gui::style::{VisualState, WidgetStyle};
use rusty_gui_widgets::{PathVerb, VectorPath, CURVE_STEPS};

/// A colour to stroke with. `INK` is behind a trait this crate does not depend on, and the tests only
/// care that *a* colour is used, so the value is written the crate's own way.
const INK: Rgb565 = Rgb565::new(31, 0, 0);

#[derive(Default)]
struct Mock {
    pixels: Vec<(i32, i32)>,
    lines: Vec<((i32, i32), (i32, i32))>,
    rects: Vec<Rect>,
}

impl CustomCanvas for Mock {
    fn fill_rect(&mut self, rect: Rect, _color: Rgb565) -> Result<(), GuiError> {
        self.rects.push(rect);
        Ok(())
    }
    fn fill_rounded_rect(&mut self, _rect: Rect, _radius: u8, _color: Rgb565) -> Result<(), GuiError> {
        Ok(())
    }
    fn draw_rect(&mut self, rect: Rect, _color: Rgb565) -> Result<(), GuiError> {
        self.rects.push(rect);
        Ok(())
    }
    fn draw_line(&mut self, p1: (i32, i32), p2: (i32, i32), _color: Rgb565) -> Result<(), GuiError> {
        self.lines.push((p1, p2));
        Ok(())
    }
    fn draw_pixel(&mut self, x: i32, y: i32, _color: Rgb565) -> Result<(), GuiError> {
        self.pixels.push((x, y));
        Ok(())
    }
    fn draw_text(
        &mut self,
        _text: &str,
        _x: i32,
        _y: i32,
        _color: Rgb565,
        _font: embedded_gui::FontId,
    ) -> Result<(), GuiError> {
        Ok(())
    }
}

static TRIANGLE: [PathVerb; 4] = [
    PathVerb::MoveTo { x: 0, y: 0 },
    PathVerb::LineTo { x: 10, y: 0 },
    PathVerb::LineTo { x: 5, y: 10 },
    PathVerb::Close,
];

fn path(colour: Option<Rgb565>, stroke_width: u8, verbs: &'static [PathVerb]) -> VectorPath {
    VectorPath {
        stroke_width,
        colour,
        verbs,
    }
}

fn render(widget: &VectorPath, rect: Rect) -> Mock {
    let mut mock = Mock::default();
    widget
        .render(&mut mock, rect, &WidgetStyle::default(), VisualState::default())
        .unwrap();
    mock
}

#[test]
fn a_closed_path_strokes_every_edge_and_honours_the_cell_origin() {
    // Three edges: move-line, line-line, close-line. One `draw_line` each at a pen width of one.
    let mock = render(&path(Some(INK), 1, &TRIANGLE), Rect::new(0, 0, 20, 20));
    assert_eq!(mock.lines.len(), 3, "a triangle is three segments");
    assert!(mock.pixels.is_empty(), "a path is stroked, not stamped per pixel");
    // The last segment closes the subpath, back to where `MoveTo` put the pen -- not to the last point drawn.
    assert_eq!(mock.lines[2], ((5, 10), (0, 0)), "the closing edge returns to the start");

    // The same path in a cell that is not at the origin is drawn relative to that cell.
    let offset = render(&path(Some(INK), 1, &TRIANGLE), Rect::new(100, 50, 20, 20));
    assert_eq!(
        offset.lines[0],
        ((100, 50), (110, 50)),
        "the cell's origin is added to the design's coordinates"
    );
}

#[test]
fn a_thicker_pen_stamps_the_segment_rather_than_widening_it() {
    // `CustomCanvas` has a one-pixel line, so a width of three is nine stamps of the same segment. That is the
    // crate's own pen shape (a square around the line), and the count is what says so.
    let thin = render(&path(Some(INK), 1, &TRIANGLE), Rect::new(0, 0, 20, 20));
    let thick = render(&path(Some(INK), 3, &TRIANGLE), Rect::new(0, 0, 20, 20));
    assert_eq!(thin.lines.len(), 3, "one stamp per segment at width one");
    assert_eq!(thick.lines.len(), 27, "nine stamps per segment at width three");
    assert!(
        thick.lines.contains(&((0, 0), (10, 0))),
        "and the original segment is still one of them, so the line does not drift"
    );
}

#[test]
fn curves_are_flattened_into_the_fixed_number_of_segments() {
    let quadratic: &'static [PathVerb] = &[
        PathVerb::MoveTo { x: 0, y: 0 },
        PathVerb::QuadTo {
            cx: 10,
            cy: 0,
            x: 10,
            y: 10,
        },
    ];
    let cubic: &'static [PathVerb] = &[
        PathVerb::MoveTo { x: 0, y: 0 },
        PathVerb::CubicTo {
            c1x: 4,
            c1y: 0,
            c2x: 6,
            c2y: 10,
            x: 10,
            y: 10,
        },
    ];
    let quad = render(&path(Some(INK), 1, quadratic), Rect::new(0, 0, 20, 20));
    let cube = render(&path(Some(INK), 1, cubic), Rect::new(0, 0, 20, 20));
    assert_eq!(quad.lines.len(), CURVE_STEPS as usize, "a quadratic is flattened");
    assert_eq!(cube.lines.len(), CURVE_STEPS as usize, "and so is a cubic");
    // The curve ends where its end point says, not where a straight line would have put it.
    let last = quad.lines[quad.lines.len() - 1].1;
    assert_eq!(last, (10, 10), "the flattening finishes on the curve's end point");
    assert!(
        quad.lines.iter().any(|&(_, (_, y))| y > 0 && y < 10),
        "and it bends: some segment is between the two y extremes"
    );

    // A curve that starts without a `MoveTo` is drawn from the origin, which is where the pen already is.
    let no_move: &'static [PathVerb] = &[PathVerb::LineTo { x: 5, y: 5 }];
    let from_origin = render(&path(Some(INK), 1, no_move), Rect::new(0, 0, 20, 20));
    assert_eq!(from_origin.lines, vec![((0, 0), (5, 5))], "a lead-off line starts at the origin");
}

#[test]
fn nothing_is_drawn_without_a_colour_or_a_command() {
    // A path with no colour is a path that is not painted -- the same rule the other shapes follow, so a
    // design that clears the colour does not get a black outline instead.
    let colourless = render(&path(None, 1, &TRIANGLE), Rect::new(0, 0, 20, 20));
    assert!(colourless.lines.is_empty(), "no colour, no stroke");
    let empty = render(&path(Some(INK), 1, &[]), Rect::new(0, 0, 20, 20));
    assert!(empty.lines.is_empty(), "no commands, no stroke");
    let flat = render(&path(Some(INK), 1, &TRIANGLE), Rect::new(0, 0, 0, 0));
    assert!(flat.lines.is_empty(), "a cell with no area draws nothing rather than dividing by it");
}

#[test]
fn a_zero_width_pen_still_draws_a_hairline_rather_than_nothing() {
    // The other shapes treat `stroke_width` 0 as "no outline", but a path has no fill to fall back on: a path
    // with no stroke is invisible, which is never what a design means by it. So the pen floors at one pixel.
    let hairline = render(&path(Some(INK), 0, &TRIANGLE), Rect::new(0, 0, 20, 20));
    assert_eq!(hairline.lines.len(), 3, "a zero width is a one-pixel pen");
}
