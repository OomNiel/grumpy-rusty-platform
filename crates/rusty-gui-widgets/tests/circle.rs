//! Host-side check of the shape `CustomWidget`s: they must draw through the
//! `CustomCanvas` the engine provides. A mock canvas records the primitive calls so
//! the shape math can be asserted without a framebuffer.

use std::collections::HashSet;

use embedded_gui::prelude::{CustomCanvas, CustomWidget, GuiError, Rect, Rgb565};
use embedded_gui::style::{VisualState, WidgetStyle};

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

fn drawn(mock: &Mock) -> HashSet<(i32, i32)> {
    mock.pixels.iter().copied().collect()
}

#[test]
fn circle_fills_its_disc() {
    let cx = 15;
    let cy = 15;
    let r = 15i32;
    let mut m = Mock::default();
    let c = rusty_gui_widgets::Circle {
        stroke_width: 0,
        fill: Some(Rgb565::new(31, 63, 31)),
        stroke: None,
    };
    c.render(&mut m, Rect::new(0, 0, 30, 30), &WidgetStyle::default(), VisualState::default())
        .unwrap();
    let on_disc = |x: i32, y: i32| (x - cx).pow(2) + (y - cy).pow(2) <= r * r;
    assert!(drawn(&m).contains(&(cx, cy)), "centre is filled");
    assert!(drawn(&m).contains(&(cx + r, cy)), "rim is filled");
    assert!(!drawn(&m).contains(&(0, 0)), "corner outside the disc is not filled");
    for y in 0..=30 {
        for x in 0..=30 {
            assert_eq!(drawn(&m).contains(&(x, y)), on_disc(x, y), "pixel ({x},{y}) mismatch");
        }
    }
}

#[test]
fn circle_strokes_only_the_annulus() {
    let cx = 15;
    let cy = 15;
    let r = 15i32;
    let sw = 2i32;
    let inner = r - sw;
    let on_ring = |x: i32, y: i32| {
        let d2 = (x - cx).pow(2) + (y - cy).pow(2);
        d2 <= r * r && d2 > inner * inner
    };
    let mut m = Mock::default();
    let c = rusty_gui_widgets::Circle {
        stroke_width: 2,
        fill: None,
        stroke: Some(Rgb565::new(31, 0, 0)),
    };
    c.render(&mut m, Rect::new(0, 0, 30, 30), &WidgetStyle::default(), VisualState::default())
        .unwrap();
    assert!(!drawn(&m).contains(&(cx, cy)), "centre is not stroked when unfilled");
    assert!(drawn(&m).contains(&(cx + r, cy)), "outer rim is stroked");
    assert!(!drawn(&m).contains(&(0, 0)), "corner outside is not stroked");
    for y in 0..=30 {
        for x in 0..=30 {
            assert_eq!(drawn(&m).contains(&(x, y)), on_ring(x, y), "pixel ({x},{y}) not on the ring");
        }
    }
}

#[test]
fn circle_ignores_radius_attr_and_uses_the_rect() {
    // The board derives geometry from the cell rect only; a different rect must
    // shift the drawn disc by exactly the delta in both axes.
    let mut a = Mock::default();
    let mut b = Mock::default();
    let circle = rusty_gui_widgets::Circle {
        stroke_width: 1,
        fill: Some(Rgb565::new(0, 0, 0)),
        stroke: None,
    };
    circle
        .render(&mut a, Rect::new(10, 20, 30, 30), &WidgetStyle::default(), VisualState::default())
        .unwrap();
    circle
        .render(&mut b, Rect::new(12, 22, 30, 30), &WidgetStyle::default(), VisualState::default())
        .unwrap();
    let mut da: Vec<(i32, i32)> = a.pixels;
    da.sort();
    let mut db: Vec<(i32, i32)> = b.pixels;
    db.sort();
    assert_eq!(
        db,
        da.iter().map(|(x, y)| (x + 2, y + 2)).collect::<Vec<_>>(),
        "shifting the rect by (2,2) shifts every drawn pixel the same way"
    );
}

#[test]
fn rectangle_fills_then_borders() {
    let mut m = Mock::default();
    rusty_gui_widgets::Rectangle {
        stroke_width: 1,
        radius: 0,
        fill: Some(Rgb565::new(0, 0, 0)),
        stroke: Some(Rgb565::new(31, 0, 0)),
    }
    .render(&mut m, Rect::new(0, 0, 10, 10), &WidgetStyle::default(), VisualState::default())
        .unwrap();
    assert_eq!(m.rects.len(), 2, "fill and stroke each produce a rect op");
    assert!(m.pixels.is_empty() && m.lines.is_empty());
}

#[test]
fn triangle_fills_its_interior_and_strokes_the_edges() {
    let cx = 8; // rect 0,0,16,16 -> apex (8,0), base (0,16)-(16,16)
    let mut m = Mock::default();
    rusty_gui_widgets::Triangle {
        stroke_width: 1,
        fill: Some(Rgb565::new(0, 0, 0)),
        stroke: Some(Rgb565::new(31, 0, 0)),
    }
    .render(&mut m, Rect::new(0, 0, 16, 16), &WidgetStyle::default(), VisualState::default())
        .unwrap();
    let pixels = drawn(&m);
    // The apex and the base midpoint are inside the triangle.
    assert!(pixels.contains(&(cx, 0)), "apex is filled");
    assert!(pixels.contains(&(cx, 16)), "base midpoint is filled");
    // A corner outside the triangle (top-left of the cell) is not.
    assert!(!pixels.contains(&(0, 0)), "the top-left corner is outside the triangle");
    // The three stroke edges each contributed a line.
    assert_eq!(m.lines.len(), 3, "the three edges are stroked");
}

#[test]
fn triangle_ignores_radius_and_derives_geometry_from_rect() {
    let mut a = Mock::default();
    let mut b = Mock::default();
    let tri = rusty_gui_widgets::Triangle {
        stroke_width: 2,
        fill: Some(Rgb565::new(0, 0, 0)),
        stroke: None,
    };
    tri.render(&mut a, Rect::new(0, 0, 20, 20), &WidgetStyle::default(), VisualState::default())
        .unwrap();
    tri.render(&mut b, Rect::new(3, 4, 20, 20), &WidgetStyle::default(), VisualState::default())
        .unwrap();
    let mut da: Vec<(i32, i32)> = a.pixels;
    da.sort();
    let mut db: Vec<(i32, i32)> = b.pixels;
    db.sort();
    assert_eq!(
        db,
        da.iter().map(|(x, y)| (x + 3, y + 4)).collect::<Vec<_>>(),
        "shifting the rect shifts every drawn pixel by the same delta"
    );
}

#[test]
fn line_runs_along_the_long_axis() {
    let mut m = Mock::default();
    rusty_gui_widgets::Line {
        stroke_width: 3,
        color: Some(Rgb565::new(0, 0, 0)),
    }
    .render(&mut m, Rect::new(0, 0, 30, 10), &WidgetStyle::default(), VisualState::default())
        .unwrap();
    assert!(!m.lines.is_empty(), "a wide rectangle draws a horizontal line");
    assert!(
        m.lines.iter().any(|((_, y), _)| *y == 5),
        "one of the stroke lines sits on the vertical centre"
    );
}

// ---------------------------------------------------------------- zero-thickness pens and rounded outlines
//
// The designer's canvas skips the outline when the thickness is zero (`if (thickness > 0)`), so a pen of zero
// must mean *no outline* here too -- otherwise a design with `line thickness: 0` grows a 1px ring on the glass
// that the canvas never showed. And a rounded rectangle's outline has to be rounded on the board as well, since
// that is what the canvas strokes.

#[test]
fn circle_with_a_zero_width_pen_draws_no_ring() {
    let mut m = Mock::default();
    let c = rusty_gui_widgets::Circle {
        stroke_width: 0,
        fill: None,
        stroke: Some(Rgb565::new(31, 63, 31)),
    };
    c.render(&mut m, Rect::new(0, 0, 40, 40), &WidgetStyle::default(), VisualState::default())
        .unwrap();
    assert!(drawn(&m).is_empty(), "a zero-width pen draws nothing at all");

    // The disc still fills: it is the *outline* that a zero pen removes.
    let mut filled = Mock::default();
    let c = rusty_gui_widgets::Circle {
        stroke_width: 0,
        fill: Some(Rgb565::new(31, 63, 31)),
        stroke: Some(Rgb565::new(0, 0, 0)),
    };
    c.render(&mut filled, Rect::new(0, 0, 40, 40), &WidgetStyle::default(), VisualState::default())
        .unwrap();
    assert!(drawn(&filled).contains(&(20, 20)), "the disc is still filled");
}

#[test]
fn rectangle_with_a_zero_width_pen_draws_no_border() {
    let mut m = Mock::default();
    let r = rusty_gui_widgets::Rectangle {
        stroke_width: 0,
        radius: 0,
        fill: None,
        stroke: Some(Rgb565::new(31, 63, 31)),
    };
    r.render(&mut m, Rect::new(0, 0, 20, 20), &WidgetStyle::default(), VisualState::default())
        .unwrap();
    assert!(m.pixels.is_empty() && m.rects.is_empty() && m.lines.is_empty(), "no pen, no outline");
}

#[test]
fn rectangle_rounds_its_outline_when_it_has_a_radius() {
    let mut m = Mock::default();
    let r = rusty_gui_widgets::Rectangle {
        stroke_width: 1,
        radius: 5,
        fill: None,
        stroke: Some(Rgb565::new(31, 63, 31)),
    };
    r.render(&mut m, Rect::new(0, 0, 20, 20), &WidgetStyle::default(), VisualState::default())
        .unwrap();
    let ink = drawn(&m);

    // The straight runs: top/bottom shortened by the radius, left/right likewise.
    assert!(ink.contains(&(5, 0)), "the top run starts where the corner ends");
    assert!(ink.contains(&(14, 0)), "and stops where the next corner starts");
    assert!(ink.contains(&(0, 5)) && ink.contains(&(0, 14)), "the left run");
    assert!(m.lines.len() >= 4, "four straight runs are drawn as lines, not pixels");

    // The corners are arcs: the sharp corner is *not* ink, but points on the arc are.
    assert!(!ink.contains(&(0, 0)), "the sharp corner is rounded away");
    assert!(!ink.contains(&(19, 19)), "at every corner");
    assert!(!ink.contains(&(19, 0)) && !ink.contains(&(0, 19)), "including the other two");
    assert!(ink.contains(&(2, 1)) && ink.contains(&(1, 2)), "the arc is drawn through the corner");
}
