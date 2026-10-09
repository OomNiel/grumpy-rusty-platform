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

/// The pixels that ended up painted, from either primitive.
///
/// The shapes draw in *runs* -- one `fill_rect` per row, because on a display with no framebuffer an address
/// window per pixel is what costs -- so a test that only looked at `pixels` would see nothing at all. Expanding
/// the rectangles keeps every assertion about the *shape* the same whether it was drawn by runs or by pixels.
fn covered(mock: &Mock) -> HashSet<(i32, i32)> {
    let mut out: HashSet<(i32, i32)> = mock.pixels.iter().copied().collect();
    for rect in &mock.rects {
        for y in rect.y..rect.y + rect.h as i32 {
            for x in rect.x..rect.x + rect.w as i32 {
                out.insert((x, y));
            }
        }
    }
    out
}

/// The pixels a mock was asked for, as a sorted list, for comparing two renders with each other.
fn covered_sorted(mock: &Mock) -> Vec<(i32, i32)> {
    let mut out: Vec<(i32, i32)> = covered(mock).into_iter().collect();
    out.sort();
    out
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
    assert!(covered(&m).contains(&(cx, cy)), "centre is filled");
    assert!(covered(&m).contains(&(cx + r, cy)), "rim is filled");
    assert!(!covered(&m).contains(&(0, 0)), "corner outside the disc is not filled");
    for y in 0..=30 {
        for x in 0..=30 {
            assert_eq!(covered(&m).contains(&(x, y)), on_disc(x, y), "pixel ({x},{y}) mismatch");
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
    assert!(!covered(&m).contains(&(cx, cy)), "centre is not stroked when unfilled");
    assert!(covered(&m).contains(&(cx + r, cy)), "outer rim is stroked");
    assert!(!covered(&m).contains(&(0, 0)), "corner outside is not stroked");
    for y in 0..=30 {
        for x in 0..=30 {
            assert_eq!(covered(&m).contains(&(x, y)), on_ring(x, y), "pixel ({x},{y}) not on the ring");
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
    let da = covered_sorted(&a);
    let db = covered_sorted(&b);
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
    let pixels = covered(&m);
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
    let da = covered_sorted(&a);
    let db = covered_sorted(&b);
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
    // One rectangle, not `thickness` per-pixel lines: the line follows an axis by construction.
    assert_eq!(m.rects.len(), 1, "a wide cell draws one rectangle");
    let ink = covered(&m);
    assert!(ink.contains(&(0, 5)), "it sits on the vertical centre");
    assert!(ink.contains(&(29, 5)), "and spans the cell's width");
    assert!(!ink.contains(&(0, 0)), "without filling the cell");
    assert_eq!(ink.len(), 30 * 3, "three rows of the cell's width, nothing more");
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
    assert!(covered(&m).is_empty(), "a zero-width pen draws nothing at all");

    // The disc still fills: it is the *outline* that a zero pen removes.
    let mut filled = Mock::default();
    let c = rusty_gui_widgets::Circle {
        stroke_width: 0,
        fill: Some(Rgb565::new(31, 63, 31)),
        stroke: Some(Rgb565::new(0, 0, 0)),
    };
    c.render(&mut filled, Rect::new(0, 0, 40, 40), &WidgetStyle::default(), VisualState::default())
        .unwrap();
    assert!(covered(&filled).contains(&(20, 20)), "the disc is still filled");
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
    let ink = covered(&m);

    // The straight runs: top/bottom shortened by the radius, left/right likewise.
    assert!(ink.contains(&(5, 0)), "the top run starts where the corner ends");
    assert!(ink.contains(&(14, 0)), "and stops where the next corner starts");
    assert!(ink.contains(&(0, 5)) && ink.contains(&(0, 14)), "the left run");
    assert!(m.rects.len() >= 4, "the four straight runs are rectangles, not per-pixel lines");
    // Only the corner arcs are drawn per pixel, and each point must sit on one of them -- the straight runs,
    // which are the bulk of any real outline, are the rectangles above.
    assert!(!m.pixels.is_empty(), "the corner arcs are drawn as pixels");
    for &(px, py) in &m.pixels {
        // The mid-point circle is within half a pixel of the true radius, so its points sit at distance^2
        // 25 +/- 6; anything further out would be a stray straight-run pixel leaking into the arc pass.
        let on_an_arc = [(5, 5), (14, 5), (5, 14), (14, 14)]
            .iter()
            .any(|&(ccx, ccy)| ((px - ccx).pow(2) + (py - ccy).pow(2) - 25).abs() <= 6);
        assert!(on_an_arc, "pixel ({px},{py}) is not on a corner arc");
    }

    // The corners are arcs: the sharp corner is *not* ink, but points on the arc are.
    assert!(!ink.contains(&(0, 0)), "the sharp corner is rounded away");
    assert!(!ink.contains(&(19, 19)), "at every corner");
    assert!(!ink.contains(&(19, 0)) && !ink.contains(&(0, 19)), "including the other two");
    assert!(ink.contains(&(2, 1)) && ink.contains(&(1, 2)), "the arc is drawn through the corner");
}

// ---------------------------------------------------------------- how much work a shape asks for
//
// On the boards this crate targets there is no framebuffer, so the panel is written over SPI and *each canvas
// call is an address window*: a window per pixel is what makes a shape slow, not the number of pixels. These
// tests therefore pin the number of calls, not just the picture: a regression back to `draw_pixel` per pixel
// would still look right and would be an order of magnitude slower.

#[test]
fn a_filled_disc_is_one_run_per_row() {
    let r = 40i32;
    let mut m = Mock::default();
    rusty_gui_widgets::Circle {
        stroke_width: 0,
        fill: Some(Rgb565::new(31, 63, 31)),
        stroke: None,
    }
    .render(&mut m, Rect::new(0, 0, (2 * r) as u32, (2 * r) as u32), &WidgetStyle::default(), VisualState::default())
        .unwrap();

    // 2r+1 rows, one call each: 81 calls where the per-pixel version made about pi*r^2 = 5027.
    assert!(m.pixels.is_empty(), "a disc makes no per-pixel calls at all");
    assert_eq!(m.rects.len(), (2 * r + 1) as usize, "one run per row");
    for rect in &m.rects {
        assert_eq!(rect.h, 1, "every run is exactly one row tall");
    }
    // And it is still the disc: the runs cover the same pixels the distance test would.
    let area = covered(&m).len() as i64;
    // `0..=2r`: the widget draws the boundary row and column too -- the engine clips a custom widget to its
    // rect, so on the board those two pixels are dropped, and `circle_fills_its_disc` pins that extent.
    let expected = (0..=2 * r)
        .flat_map(|y| (0..=2 * r).map(move |x| (x, y)))
        .filter(|&(x, y)| (x - r).pow(2) + (y - r).pow(2) <= r * r)
        .count() as i64;
    assert_eq!(area, expected, "the runs cover exactly the disc");
}

#[test]
fn a_ring_costs_at_most_two_runs_a_row() {
    let r = 40i32;
    let mut m = Mock::default();
    rusty_gui_widgets::Circle {
        stroke_width: 4,
        fill: None,
        stroke: Some(Rgb565::new(31, 0, 0)),
    }
    .render(&mut m, Rect::new(0, 0, (2 * r) as u32, (2 * r) as u32), &WidgetStyle::default(), VisualState::default())
        .unwrap();
    assert!(m.pixels.is_empty(), "an unfilled ring is runs too, not pixels");
    assert!(
        m.rects.len() <= 2 * (2 * r + 1) as usize,
        "two runs per row at most (the annulus's left and right arcs)"
    );
    assert!(m.rects.iter().all(|rect| rect.h == 1), "all of them one row tall");
}

#[test]
fn a_filled_triangle_is_one_run_per_row() {
    let mut m = Mock::default();
    rusty_gui_widgets::Triangle {
        stroke_width: 0,
        fill: Some(Rgb565::new(0, 0, 0)),
        stroke: None,
    }
    .render(&mut m, Rect::new(0, 0, 40, 30), &WidgetStyle::default(), VisualState::default())
        .unwrap();
    assert!(m.pixels.is_empty(), "the interior is filled by runs");
    assert_eq!(m.rects.len(), 31, "one run per scanline of the triangle");
    assert!(m.rects.iter().all(|rect| rect.h == 1), "each one row tall");
    // Half the cell, give or take the row the two slanted edges land on: an exact number here would only be
    // the scanline algorithm written a second time.
    let area = covered(&m).len() as i32;
    assert!((area - 620).abs() <= 31, "the runs cover about half the cell, got {area}");
}
