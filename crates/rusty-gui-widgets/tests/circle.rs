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

/// True when a pixel belongs to the disc inscribed in `rect`: the distance from the pixel's centre to the
/// box's centre is at most half the shorter side.
///
/// This is the widget's own rule, written independently of it so the test can disagree with it. The arithmetic
/// is in doubled coordinates (pixel `i`'s centre is `2i + 1`, the box's centre is `w`) exactly as the widget
/// does it, because the box's centre is a whole pixel only when its size is odd -- and getting that wrong is
/// what used to push the disc outside an even-sized box, where the clip flattened its edges.
fn on_inscribed_disc(x: i32, y: i32, rect: Rect, diameter: i32) -> bool {
    let dx = (2 * (x - rect.x) + 1 - rect.w as i32) as i64;
    let dy = (2 * (y - rect.y) + 1 - rect.h as i32) as i64;
    let d = diameter as i64;
    dx * dx + dy * dy <= d * d
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
    let rect = Rect::new(0, 0, 30, 30);
    let mut m = Mock::default();
    let c = rusty_gui_widgets::Circle {
        stroke_width: 0,
        fill: Some(Rgb565::new(31, 63, 31)),
        stroke: None,
    };
    c.render(&mut m, rect, &WidgetStyle::default(), VisualState::default())
        .unwrap();
    let ink = covered(&m);
    assert!(!ink.contains(&(0, 0)), "the box's corner is outside the disc");
    for y in -2..32 {
        for x in -2..32 {
            let inside_box = x >= 0 && y >= 0 && x < 30 && y < 30;
            assert_eq!(
                ink.contains(&(x, y)),
                inside_box && on_inscribed_disc(x, y, rect, 30),
                "pixel ({x},{y}) mismatch"
            );
        }
    }
    // The bug this convention fixes: the disc reached outside its cell, and the engine's clip flattened the
    // top and bottom edges. Nothing may be drawn outside the box at all.
    for &(x, y) in &ink {
        assert!(x >= 0 && y >= 0 && x < 30 && y < 30, "({x},{y}) is outside the box");
    }
}

#[test]
fn circle_strokes_only_the_annulus() {
    let rect = Rect::new(0, 0, 30, 30);
    // A pen of two eats one pixel of radius on each side of the outline.
    let on_ring = |x: i32, y: i32| {
        on_inscribed_disc(x, y, rect, 30) && !on_inscribed_disc(x, y, rect, 26)
    };
    let mut m = Mock::default();
    let c = rusty_gui_widgets::Circle {
        stroke_width: 2,
        fill: None,
        stroke: Some(Rgb565::new(31, 0, 0)),
    };
    c.render(&mut m, rect, &WidgetStyle::default(), VisualState::default())
        .unwrap();
    let ink = covered(&m);
    assert!(!ink.contains(&(15, 15)), "centre is not stroked when unfilled");
    assert!(!ink.contains(&(0, 0)), "corner outside is not stroked");
    for y in -2..32 {
        for x in -2..32 {
            assert_eq!(ink.contains(&(x, y)), on_ring(x, y), "pixel ({x},{y}) not on the ring");
        }
    }
    for &(x, y) in &ink {
        assert!(x >= 0 && y >= 0 && x < 30 && y < 30, "({x},{y}) is outside the box");
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
    let cx = 8; // rect 0,0,16,16 -> apex (8,0), base (0,15)-(15,15) (the base is the cell's last row)
    let mut m = Mock::default();
    rusty_gui_widgets::Triangle {
        stroke_width: 1,
        fill: Some(Rgb565::new(0, 0, 0)),
        stroke: Some(Rgb565::new(31, 0, 0)),
        points: rusty_gui_widgets::DEFAULT_TRIANGLE_POINTS,
    }
    .render(&mut m, Rect::new(0, 0, 16, 16), &WidgetStyle::default(), VisualState::default())
        .unwrap();
    let pixels = covered(&m);
    // The apex and the base midpoint are inside the triangle.
    assert!(pixels.contains(&(cx, 0)), "apex is filled");
    assert!(pixels.contains(&(cx, 15)), "base midpoint is filled");
    assert!(!pixels.contains(&(cx, 16)), "and the base is the cell's last row, not a row outside it");
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
        points: rusty_gui_widgets::DEFAULT_TRIANGLE_POINTS,
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

    // One call per row of the box: 80 rows, where the per-pixel version made about pi*r^2 = 5027 calls.
    assert!(m.pixels.is_empty(), "a disc makes no per-pixel calls at all");
    assert_eq!(m.rects.len(), (2 * r) as usize, "one run per row of the box");
    for rect in &m.rects {
        assert_eq!(rect.h, 1, "every run is exactly one row tall");
    }
    // And it is the inscribed disc: the runs cover exactly the pixels whose centres lie within `r`, and none
    // of them is outside the box.
    let box_rect = Rect::new(0, 0, (2 * r) as u32, (2 * r) as u32);
    let ink = covered(&m);
    let expected = (0..2 * r)
        .flat_map(|y| (0..2 * r).map(move |x| (x, y)))
        .filter(|&(x, y)| on_inscribed_disc(x, y, box_rect, 2 * r))
        .count() as i64;
    assert_eq!(ink.len() as i64, expected, "the runs cover exactly the disc");
    for &(x, y) in &ink {
        assert!(x >= 0 && y >= 0 && x < 2 * r && y < 2 * r, "({x},{y}) is outside the box");
    }
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
        points: rusty_gui_widgets::DEFAULT_TRIANGLE_POINTS,
    }
    .render(&mut m, Rect::new(0, 0, 40, 30), &WidgetStyle::default(), VisualState::default())
        .unwrap();
    assert!(m.pixels.is_empty(), "the interior is filled by runs");
    // The base sits on the cell's last row (29), so the 30-row cell costs 30 runs -- a run is never emitted
    // outside the cell.
    assert_eq!(m.rects.len(), 30, "one run per scanline of the triangle");
    assert!(
        m.rects.iter().all(|r| r.y >= 0 && r.y < 30),
        "no run lands outside the cell"
    );
    assert!(m.rects.iter().all(|rect| rect.h == 1), "each one row tall");
    // Half the cell, give or take the row the two slanted edges land on: an exact number here would only be
    // the scanline algorithm written a second time.
    let area = covered(&m).len() as i32;
    assert!((area - 600).abs() <= 40, "the runs cover about half the cell, got {area}");
}

#[test]
fn triangle_vertices_come_from_the_design() {
    // The default is the isosceles triangle the designer drops: apex at the top centre, base along the bottom.
    let rect = Rect::new(0, 0, 40, 30);
    let mut m = Mock::default();
    rusty_gui_widgets::Triangle {
        stroke_width: 1,
        fill: Some(Rgb565::new(31, 63, 31)),
        stroke: None,
        points: rusty_gui_widgets::DEFAULT_TRIANGLE_POINTS,
    }
    .render(&mut m, rect, &WidgetStyle::default(), VisualState::default())
    .unwrap();
    let apex = covered(&m);
    assert!(apex.contains(&(20, 0)), "the apex is at the top centre");
    assert!(apex.contains(&(0, 29)) && apex.contains(&(39, 29)), "and the base along the bottom");
    assert!(!apex.contains(&(0, 0)), "so the top-left corner is outside it");

    // The same widget with vertices of its own draws that triangle instead: a right triangle with the
    // right-angle at the bottom right, and nothing where the isosceles apex used to be.
    let mut skewed = Mock::default();
    rusty_gui_widgets::Triangle {
        stroke_width: 1,
        fill: Some(Rgb565::new(31, 63, 31)),
        stroke: None,
        points: [0, 0, 0, 1000, 1000, 1000],
    }
    .render(&mut skewed, rect, &WidgetStyle::default(), VisualState::default())
    .unwrap();
    let right = covered(&skewed);
    assert!(right.contains(&(0, 0)), "the top-left corner is a vertex now");
    assert!(right.contains(&(39, 29)) && right.contains(&(0, 29)), "and the base is along the bottom");
    assert!(!right.contains(&(20, 0)), "nothing is drawn at the old apex");

    // Per-mille of the cell: a vertex at 500/1000 of a 40x30 cell is (20, 29), and the same triangle in a cell
    // of another size keeps its shape.
    let mut wide = Mock::default();
    rusty_gui_widgets::Triangle {
        stroke_width: 1,
        fill: Some(Rgb565::new(31, 63, 31)),
        stroke: None,
        points: [500, 0, 0, 1000, 1000, 1000],
    }
    .render(&mut wide, Rect::new(0, 0, 80, 60), &WidgetStyle::default(), VisualState::default())
    .unwrap();
    let ink = covered(&wide);
    assert!(ink.contains(&(40, 0)), "the apex follows the cell's width");
    assert!(ink.contains(&(0, 59)) && ink.contains(&(79, 59)), "and the base its height");
    for &(x, y) in &ink {
        assert!(x < 80 && y < 60, "({x},{y}) is outside the cell");
    }
}
