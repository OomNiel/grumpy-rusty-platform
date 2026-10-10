//! Designer-native shapes the `embedded-gui` runtime will not paint for you.
//!
//! `embedded-gui 0.2.7` parses `circle`, `rect`/`rectangle`, `line`, and
//! `vector_path` KDL nodes but its code generator emits them as plain panels (or
//! spacers), so they render as the wrong primitive. This crate supplies
//! `CustomWidget` implementations that draw the real primitives through the
//! `CustomCanvas` the engine hands a custom widget at render time, and the forked
//! `embedded-gui-codegen` calls `add_custom_widget` for these tags instead of
//! `add_panel`/`add_spacer`.
//!
//! Geometry is **always** derived from the grid cell `rect` the engine lays out —
//! never from a parsed `radius` — so the board paints exactly what the designer's
//! canvas shows (the rect is the shared source of truth). `CustomCanvas` has no
//! `draw_circle`, so a circle is drawn with `draw_pixel`; fill is a disc, stroke is
//! an annulus, both by an integer distance test. A triangle is filled by a
//! scanline rasteriser over its three vertices; a rectangle and line honour their
//! `stroke_width` by drawing concentric borders / parallel offsets.
#![no_std]

use embedded_gui::prelude::{CustomCanvas, CustomWidget, GuiError, Rect, Rgb565};
use embedded_gui::style::{VisualState, WidgetStyle};

/// A circle inscribed in the cell `rect`: centre and radius are derived from the
/// rect so canvas and glass cannot disagree. `fill`/`stroke` ride in as parsed
/// colours (the codegen's `rgb565_expr`); `stroke_width` is the pen thickness.
pub struct Circle {
    pub stroke_width: u8,
    pub fill: Option<Rgb565>,
    pub stroke: Option<Rgb565>,
}

impl CustomWidget for Circle {
    fn render(
        &self,
        canvas: &mut dyn CustomCanvas,
        rect: Rect,
        _style: &WidgetStyle,
        _state: VisualState,
    ) -> Result<(), GuiError> {
        // The disc is inscribed in the box: a pixel belongs to it when the distance from the pixel's *centre*
        // to the box's centre is at most half the shorter side -- which is the circle the canvas draws with
        // `arc(x + w/2, y + h/2, min(w,h)/2)`.
        //
        // The arithmetic is done in doubled coordinates (pixel `i`'s centre is `2i + 1`, so the box's centre is
        // `w`), because the box's centre is a whole pixel only when its size is odd. Measuring in pixels, as
        // this used to, put the disc's extremes one pixel outside an even-sized box, where the engine's clip to
        // the widget's cell shaved them -- a circle with flattened top and bottom edges.
        let w = rect.w as i32;
        let h = rect.h as i32;
        let d = rect.w.min(rect.h) as i32;
        if d <= 0 {
            return Ok(());
        }
        let pen = self.stroke_width as i32;
        let ring = self.stroke.filter(|_| pen > 0);
        let inner_d = (d - 2 * pen).max(0);
        let outer = (d as i64) * (d as i64);
        let inner = (inner_d as i64) * (inner_d as i64);

        for row in 0..h {
            let dy = (2 * row + 1 - h) as i64;
            let dy2 = dy * dy;
            if dy2 > outer {
                // This row misses the disc: every row above or below it does too.
                continue;
            }
            let Some((x0, x1)) = column_span(w, isqrt(outer - dy2)) else {
                continue;
            };
            let inner_span = if pen > 0 && dy2 <= inner {
                column_span(w, isqrt(inner - dy2))
            } else {
                None
            };
            // `column_span` answers in box-relative columns, like `row` in rows.
            let (y, left) = (rect.y + row, rect.x);
            let (ax0, ax1) = (left + x0, left + x1);

            if let Some(c) = ring {
                match inner_span {
                    // The annulus is this row's outer span minus its inner one: two short runs.
                    Some((a, b)) => {
                        let (a, b) = (left + a, left + b);
                        run(canvas, ax0, y, a - ax0, c)?;
                        run(canvas, b + 1, y, ax1 - b, c)?;
                    }
                    // Nothing to leave unpainted on this row: the whole span is ring.
                    None => run(canvas, ax0, y, ax1 - ax0 + 1, c)?,
                }
            }
            if let Some(c) = self.fill {
                match (pen > 0, inner_span) {
                    (false, _) => run(canvas, ax0, y, ax1 - ax0 + 1, c)?,
                    (true, Some((a, b))) => run(canvas, left + a, y, b - a + 1, c)?,
                    (true, None) => {}
                }
            }
        }
        Ok(())
    }
}

/// The columns of a `w`-wide box whose doubled centre offset `2i + 1 - w` is within `half` of zero.
///
/// Answers in box-relative columns, clipped to the box, or `None` when the row has none -- which is what makes
/// the disc stay inside its cell without relying on the engine's clip.
fn column_span(w: i32, half: i64) -> Option<(i32, i32)> {
    let low = w as i64 - 1 - half;
    let high = w as i64 - 1 + half;
    let first = low.div_euclid(2) + i64::from(low.rem_euclid(2) != 0); // ceil(low / 2)
    let last = high.div_euclid(2);
    let first = first.max(0) as i32;
    let last = last.min(w as i64 - 1) as i32;
    if first > last {
        None
    } else {
        Some((first, last))
    }
}

/// The integer square root: the largest `r` with `r * r <= n`.
///
/// A bit at a time, because the platform's `sqrt` is a float and this crate is `no_std`; the spans are what
/// decide where a shape's runs start, so they are worth being exact about.
fn isqrt(n: i64) -> i64 {
    if n <= 0 {
        return 0;
    }
    let mut bit = 1i64 << 62;
    while bit > n {
        bit >>= 2;
    }
    let (mut root, mut rest) = (0i64, n);
    while bit != 0 {
        if rest >= root + bit {
            rest -= root + bit;
            root = (root >> 1) + bit;
        } else {
            root >>= 1;
        }
        bit >>= 2;
    }
    root
}

/// Paints one horizontal run, if it has any length. Empty and zero-length runs draw nothing, so a shape
/// never makes a call it would immediately clip away.
///
/// A run is a row of the shape, and it is deliberately *one* canvas call: on a display with no framebuffer
/// each call is an address window over SPI, so this is where a shape's cost is decided, not in how many
/// pixels it covers.
fn run(canvas: &mut dyn CustomCanvas, x: i32, y: i32, len: i32, color: Rgb565) -> Result<(), GuiError> {
    if len <= 0 {
        return Ok(());
    }
    canvas.fill_rect(Rect::new(x, y, len as u32, 1), color)
}

/// Paints one vertical run, if it has any length. The column counterpart of [`run`].
fn run_vertical(canvas: &mut dyn CustomCanvas, x: i32, y: i32, len: i32, color: Rgb565) -> Result<(), GuiError> {
    if len <= 0 {
        return Ok(());
    }
    canvas.fill_rect(Rect::new(x, y, 1, len as u32), color)
}

/// A rectangle: fill paints the whole cell, stroke paints concentric borders so the
/// thickness follows `stroke_width` (a single-pixel `draw_rect`, scaled up). `radius`
/// is honoured through `fill_rounded_rect` when the codegen supplies one.
pub struct Rectangle {
    pub stroke_width: u8,
    pub radius: u8,
    pub fill: Option<Rgb565>,
    pub stroke: Option<Rgb565>,
}

impl CustomWidget for Rectangle {
    fn render(
        &self,
        canvas: &mut dyn CustomCanvas,
        rect: Rect,
        _style: &WidgetStyle,
        _state: VisualState,
    ) -> Result<(), GuiError> {
        if let Some(c) = self.fill {
            if self.radius > 0 {
                canvas.fill_rounded_rect(rect, self.radius, c)?;
            } else {
                canvas.fill_rect(rect, c)?;
            }
        }
        // The outline follows the same rounded path the fill does -- a rounded rectangle drawn with square
        // corners is a different shape, and the canvas rounds both. `stroke_width` of 0 is no outline at all.
        if let Some(c) = self.stroke {
            let thick = self.stroke_width as i32;
            if thick > 0 {
                stroke_rounded_rect(canvas, rect, self.radius, thick, c)?;
            }
        }
        Ok(())
    }
}

/// A line along the cell's longer axis. The codegen's `line` tag carries only a
/// colour and a thickness (no direction), so the line is horizontal when the cell is
/// wider than it is tall, and vertical otherwise.
pub struct Line {
    pub stroke_width: u8,
    pub color: Option<Rgb565>,
}

impl CustomWidget for Line {
    fn render(
        &self,
        canvas: &mut dyn CustomCanvas,
        rect: Rect,
        _style: &WidgetStyle,
        _state: VisualState,
    ) -> Result<(), GuiError> {
        let color = match self.color {
            Some(color) => color,
            None => return Ok(()),
        };
        let thick = self.stroke_width as i32;
        if thick <= 0 {
            return Ok(());
        }
        // The line is axis-aligned by construction (it follows the longer axis of the cell), so it is one
        // rectangle -- one address window -- rather than a per-pixel segment stamped `thick` times, which is
        // what a slanted line would need and what this shape never is. The centring matches the stamping it
        // replaces: offsets `-thick/2 ..= thick/2` around the cell's centre row/column.
        let offset = thick >> 1;
        if rect.w >= rect.h {
            let y = rect.y + (rect.h as i32 >> 1) - offset;
            canvas.fill_rect(Rect::new(rect.x, y, rect.w, thick as u32), color)?;
        } else {
            let x = rect.x + (rect.w as i32 >> 1) - offset;
            canvas.fill_rect(Rect::new(x, rect.y, thick as u32, rect.h), color)?;
        }
        Ok(())
    }
}

/// A triangle whose three vertices the design chooses.
///
/// Each vertex is two per-mille offsets into the cell (`0..=1000` of its width and height), so the triangle
/// scales with its cell instead of being fixed to one shape: the designer drops one as an isosceles triangle
/// (apex top centre, base along the bottom) and any vertex can then be dragged anywhere in the control. Fill is
/// a scanline rasteriser over the vertices; the stroke walks each edge with a thick pen.
///
/// The per-mille form is what keeps the board independent of the designer's pixel arithmetic: the *cell* is the
/// same rectangle on both sides, so `x = cell.x + p * cell.w / 1000` is exact for any cell the grid produces.
pub struct Triangle {
    pub stroke_width: u8,
    pub fill: Option<Rgb565>,
    pub stroke: Option<Rgb565>,
    /// `[p1x, p1y, p2x, p2y, p3x, p3y]`, per-mille of the cell. The default is the isosceles triangle the
    /// designer has always dropped.
    pub points: [i16; 6],
}

impl Triangle {
    /// The three vertices in cell coordinates, clamped to the cell.
    fn vertices(&self, rect: Rect) -> [(i32, i32); 3] {
        let w = rect.w as i32;
        let h = rect.h as i32;
        let place = |px: i16, py: i16| {
            let x = rect.x + (px.clamp(0, 1000) as i32 * w) / 1000;
            let y = rect.y + (py.clamp(0, 1000) as i32 * h) / 1000;
            (x.clamp(rect.x, rect.x + w - 1), y.clamp(rect.y, rect.y + h - 1))
        };
        [
            place(self.points[0], self.points[1]),
            place(self.points[2], self.points[3]),
            place(self.points[4], self.points[5]),
        ]
    }
}

/// The default triangle: apex at the top centre, base along the bottom edge -- the shape the designer drops.
pub const DEFAULT_TRIANGLE_POINTS: [i16; 6] = [500, 0, 0, 1000, 1000, 1000];

impl CustomWidget for Triangle {
    fn render(
        &self,
        canvas: &mut dyn CustomCanvas,
        rect: Rect,
        _style: &WidgetStyle,
        _state: VisualState,
    ) -> Result<(), GuiError> {
        if rect.h == 0 || rect.w == 0 {
            return Ok(());
        }
        let v = self.vertices(rect);

        if let Some(c) = self.fill {
            // Sort the three vertices top-to-bottom by y. A fixed `[T; 3]` does not resolve slice
            // methods in `#![no_std]`, and borrow-checking rejects two simultaneous `&mut` element
            // borrows, so unpack the vertices into distinct locals and swap them directly.
            let (mut v0, mut v1, mut v2) = (v[0], v[1], v[2]);
            if v0.1 > v1.1 { let t = v0; v0 = v1; v1 = t; }
            if v1.1 > v2.1 { let t = v1; v1 = v2; v2 = t; }
            if v0.1 > v1.1 { let t = v0; v0 = v1; v1 = t; }
            let verts = [v0, v1, v2];
            let ymin = verts[0].1;
            let ymax = verts[2].1;
            for y in ymin..=ymax {
                // Collect up to two edge x-intersections on this scanline. A triangle contributes at most two.
                let mut xs: [i32; 2] = [0, 0];
                let mut count = 0i32;
                for edge in [(0usize, 1usize), (1, 2), (0, 2)] {
                    if count >= 2 {
                        break;
                    }
                    if let Some(x) = edge_cross_y(verts[edge.0], verts[edge.1], y) {
                        xs[count as usize] = x;
                        count += 1;
                    }
                }
                if count >= 2 {
                    let (lo, hi) = (xs[0].min(xs[1]), xs[0].max(xs[1]));
                    // One run per scanline: the same pixels the per-pixel loop covered, for the price of one
                    // address window instead of one per pixel.
                    run(canvas, lo, y, hi - lo + 1, c)?;
                }
            }
        }

        if let Some(c) = self.stroke {
            let thick = self.stroke_width as i32;
            if thick > 0 {
                draw_thick_line(canvas, v[0], v[1], thick, c)?;
                draw_thick_line(canvas, v[1], v[2], thick, c)?;
                draw_thick_line(canvas, v[2], v[0], thick, c)?;
            }
        }
        Ok(())
    }
}

/// `x` where edge `a-b` crosses scanline `y`, if it does. Integer lerp along the
/// edge, skipping horizontal edges (they contribute no single x to a scanline fill).
fn edge_cross_y(a: (i32, i32), b: (i32, i32), y: i32) -> Option<i32> {
    let (ya, yb) = (a.1, b.1);
    if y < ya.min(yb) || y > ya.max(yb) {
        return None;
    }
    let dy = yb - ya;
    if dy == 0 {
        return None;
    }
    Some(a.0 + (b.0 - a.0) * (y - ya) / dy)
}

/// Outlines a rounded rectangle: the four straight runs plus one quadrant of a mid-point circle per corner.
///
/// The canvas has no rounded-outline primitive (only `fill_rounded_rect`), so the corners are drawn as integer
/// arc points -- no floats, no allocation, and no dependence on `std`. `thickness` rings are drawn
/// concentrically, each inset by one pixel, which is how the pen gets its width.
fn stroke_rounded_rect(
    canvas: &mut dyn CustomCanvas,
    rect: Rect,
    radius: u8,
    thickness: i32,
    color: Rgb565,
) -> Result<(), GuiError> {
    let mut edge = rect;
    let mut corner = radius as i32;
    for _ in 0..thickness {
        if edge.w == 0 || edge.h == 0 {
            break;
        }
        let w = edge.w as i32;
        let h = edge.h as i32;
        let r = corner.min(w / 2).min(h / 2).max(0);
        if r == 0 {
            canvas.draw_rect(edge, color)?;
        } else {
            let (x0, y0) = (edge.x, edge.y);
            let (x1, y1) = (edge.x + w - 1, edge.y + h - 1);
            // The four straight runs between the corners, each one rectangle: a run is the bulk of the
            // outline, and `draw_line` would charge an address window per pixel for it.
            run(canvas, x0 + r, y0, x1 - r - (x0 + r) + 1, color)?;
            run(canvas, x0 + r, y1, x1 - r - (x0 + r) + 1, color)?;
            run_vertical(canvas, x0, y0 + r, y1 - r - (y0 + r) + 1, color)?;
            run_vertical(canvas, x1, y0 + r, y1 - r - (y0 + r) + 1, color)?;
            // `sx`/`sy` pick the quadrant, so one symmetric walk serves all four corners.
            draw_corner_arc(canvas, x0 + r, y0 + r, r, -1, -1, color)?;
            draw_corner_arc(canvas, x1 - r, y0 + r, r, 1, -1, color)?;
            draw_corner_arc(canvas, x0 + r, y1 - r, r, -1, 1, color)?;
            draw_corner_arc(canvas, x1 - r, y1 - r, r, 1, 1, color)?;
        }
        edge = Rect::new(
            edge.x + 1,
            edge.y + 1,
            edge.w.saturating_sub(2),
            edge.h.saturating_sub(2),
        );
        corner -= 1;
    }
    Ok(())
}

/// One quadrant of a mid-point circle, at the quadrant `sx`/`sy` select (`-1` or `1` each).
fn draw_corner_arc(
    canvas: &mut dyn CustomCanvas,
    cx: i32,
    cy: i32,
    r: i32,
    sx: i32,
    sy: i32,
    color: Rgb565,
) -> Result<(), GuiError> {
    if r <= 0 {
        return Ok(());
    }
    let (mut x, mut y) = (0i32, r);
    let mut d = 1 - r;
    while x <= y {
        canvas.draw_pixel(cx + sx * x, cy + sy * y, color)?;
        canvas.draw_pixel(cx + sx * y, cy + sy * x, color)?;
        if d < 0 {
            d += 2 * x + 3;
        } else {
            d += 2 * (x - y) + 5;
            y -= 1;
        }
        x += 1;
    }
    Ok(())
}

/// Draws a line of `thickness` by stamping `thickness` parallel, 1px-offset copies of
/// the unit segment `p1-p2`. The perpendicular offset `(-dy, dx)` is normalised by the
/// segment's longer axis so each stamp is a whole pixel off -- no floats, no alloc.
fn draw_thick_line(
    canvas: &mut dyn CustomCanvas,
    p1: (i32, i32),
    p2: (i32, i32),
    thickness: i32,
    color: Rgb565,
) -> Result<(), GuiError> {
    let dx = p2.0 - p1.0;
    let dy = p2.1 - p1.1;
    let len = dx.unsigned_abs().max(dy.unsigned_abs()).max(1) as i32;
    // Unit perpendicular (integer, truncated): (-dy, dx) / len.
    let (px, py) = (-dy / len, dx / len);
    for o in 0..thickness {
        let off = o - (thickness >> 1);
        let q1 = (p1.0 + px * off, p1.1 + py * off);
        let q2 = (p2.0 + px * off, p2.1 + py * off);
        canvas.draw_line(q1, q2, color)?;
    }
    Ok(())
}

// NOTE: `VectorPath` is deferred. Its codegen arm still emits `add_panel` (a stub
// panel) until a `Path` CustomWidget replays `PathVerb`s through `draw_line`.

/// One command in a [`VectorPath`], in design pixels relative to the widget's top-left corner.
///
/// The variants are **struct** variants with named fields, and that is the point: the runtime's own
/// `render::stroke::PathVerb` is declared the same way, and a generated file that built a tuple variant would
/// not compile. This enum exists rather than reusing the runtime's so that the shape of a path is this crate's
/// business -- the code generator writes these literals, and the two now agree by construction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathVerb {
    MoveTo { x: i32, y: i32 },
    LineTo { x: i32, y: i32 },
    /// A quadratic curve: one control point, then the end point.
    QuadTo { cx: i32, cy: i32, x: i32, y: i32 },
    /// A cubic curve: two control points, then the end point.
    CubicTo { c1x: i32, c1y: i32, c2x: i32, c2y: i32, x: i32, y: i32 },
    /// A straight line back to the point the current subpath started at.
    Close,
}

/// How many straight segments a curve is flattened into, per command.
///
/// A fixed count rather than an adaptive one, because the glass pays for each segment with an address window:
/// a design should be able to predict what a curve costs, and 12 is enough for a widget-sized curve at this
/// screen resolution. It is also what makes the canvas replica and the board agree -- both flatten the same
/// way, from the same verbs, with the same number.
pub const CURVE_STEPS: i32 = 12;

/// A vector outline: an SVG-like list of path commands, stroked in the design's colour.
///
/// Coordinates are pixels relative to the widget's top-left, which is what an SVG path is and what the designer
/// writes. The path is *not* scaled to its cell: a 32x32 path in a 96x96 widget draws 32x32 in its corner, and
/// resizing the widget moves the path with it rather than magnifying it. Curves are flattened to straight
/// segments (`CURVE_STEPS` each); everything is stroked through the canvas's own `draw_line`, so the board and
/// the canvas show the same segments rather than two rasterisers that agree only sometimes.
///
/// A `stroke_width` above one stamps the same segment several times with small offsets, the way the crate's own
/// pen does, because `CustomCanvas` has a one-pixel line and no pen width.
pub struct VectorPath {
    pub stroke_width: u8,
    pub colour: Option<Rgb565>,
    pub verbs: &'static [PathVerb],
}

impl VectorPath {
    /// Strokes one segment, with the pen's width spread symmetrically around it.
    fn stroke(
        canvas: &mut dyn CustomCanvas,
        rect: Rect,
        from: (i32, i32),
        to: (i32, i32),
        colour: Rgb565,
        half: i32,
    ) -> Result<(), GuiError> {
        // The cell's origin is added here rather than in the design's coordinates, so a path is written
        // relative to its widget and the widget can be moved without touching the path.
        let (ax, ay) = (rect.x + from.0, rect.y + from.1);
        let (bx, by) = (rect.x + to.0, rect.y + to.1);
        for oy in -half..=half {
            for ox in -half..=half {
                canvas.draw_line((ax + ox, ay + oy), (bx + ox, by + oy), colour)?;
            }
        }
        Ok(())
    }

    /// One quadratic curve, as straight segments through the de Casteljau construction.
    fn quad(
        canvas: &mut dyn CustomCanvas,
        rect: Rect,
        from: (i32, i32),
        control: (i32, i32),
        to: (i32, i32),
        colour: Rgb565,
        half: i32,
    ) -> Result<(), GuiError> {
        let mut previous = from;
        for step in 1..=CURVE_STEPS {
            let t = step;
            let inv = CURVE_STEPS - step;
            // (1-t)^2 p0 + 2(1-t)t c + t^2 p1, in integer arithmetic scaled by CURVE_STEPS^2.
            let denominator = CURVE_STEPS * CURVE_STEPS;
            let x = (inv * inv * from.0 + 2 * inv * t * control.0 + t * t * to.0) / denominator;
            let y = (inv * inv * from.1 + 2 * inv * t * control.1 + t * t * to.1) / denominator;
            Self::stroke(canvas, rect, previous, (x, y), colour, half)?;
            previous = (x, y);
        }
        Ok(())
    }

    /// One cubic curve, flattened the same way.
    fn cubic(
        canvas: &mut dyn CustomCanvas,
        rect: Rect,
        from: (i32, i32),
        first: (i32, i32),
        second: (i32, i32),
        to: (i32, i32),
        colour: Rgb565,
        half: i32,
    ) -> Result<(), GuiError> {
        let mut previous = from;
        for step in 1..=CURVE_STEPS {
            let t = step;
            let inv = CURVE_STEPS - step;
            let denominator = CURVE_STEPS * CURVE_STEPS * CURVE_STEPS;
            let x = (inv * inv * inv * from.0
                + 3 * inv * inv * t * first.0
                + 3 * inv * t * t * second.0
                + t * t * t * to.0)
                / denominator;
            let y = (inv * inv * inv * from.1
                + 3 * inv * inv * t * first.1
                + 3 * inv * t * t * second.1
                + t * t * t * to.1)
                / denominator;
            Self::stroke(canvas, rect, previous, (x, y), colour, half)?;
            previous = (x, y);
        }
        Ok(())
    }
}

impl CustomWidget for VectorPath {
    fn render(
        &self,
        canvas: &mut dyn CustomCanvas,
        rect: Rect,
        _style: &WidgetStyle,
        _state: VisualState,
    ) -> Result<(), GuiError> {
        let colour = match self.colour {
            Some(colour) => colour,
            None => return Ok(()),
        };
        if self.verbs.is_empty() || rect.w == 0 || rect.h == 0 {
            return Ok(());
        }
        let half = (self.stroke_width.max(1) as i32) >> 1;

        let mut pen = (0i32, 0i32);
        let mut start = (0i32, 0i32);
        let mut open = false;
        for verb in self.verbs {
            match *verb {
                PathVerb::MoveTo { x, y } => {
                    pen = (x, y);
                    start = (x, y);
                    open = true;
                }
                PathVerb::LineTo { x, y } => {
                    // A `LineTo` before any `MoveTo` starts a subpath at the origin, which is what the SVG
                    // grammar means by it: the pen is already there.
                    if !open {
                        start = pen;
                        open = true;
                    }
                    Self::stroke(canvas, rect, pen, (x, y), colour, half)?;
                    pen = (x, y);
                }
                PathVerb::QuadTo { cx, cy, x, y } => {
                    if !open {
                        start = pen;
                        open = true;
                    }
                    Self::quad(canvas, rect, pen, (cx, cy), (x, y), colour, half)?;
                    pen = (x, y);
                }
                PathVerb::CubicTo {
                    c1x,
                    c1y,
                    c2x,
                    c2y,
                    x,
                    y,
                } => {
                    if !open {
                        start = pen;
                        open = true;
                    }
                    Self::cubic(canvas, rect, pen, (c1x, c1y), (c2x, c2y), (x, y), colour, half)?;
                    pen = (x, y);
                }
                PathVerb::Close => {
                    Self::stroke(canvas, rect, pen, start, colour, half)?;
                    pen = start;
                    open = false;
                }
            }
        }
        Ok(())
    }
}

/// A byte stream a [`BmpImage`] reads from, which is all this crate needs to know about a storage device.
///
/// The generated project implements this over the card it has mounted; this crate never links a filesystem or
/// a driver, so the same widget works with a card, a flash chip, or a slice in a test. `read` follows the usual
/// short-read rule: fewer bytes than asked for means the end of the stream.
pub trait ByteSource {
    fn read(&mut self, buf: &mut [u8]) -> Result<usize, ()>;
}

/// Opens a file and hands it to `use_file` for as long as it is needed.
///
/// A **callback** rather than an open/read/close triple because the reader in a generated project borrows the
/// card's mounted volume for the duration, and a borrowed file cannot be stored between calls. The widget runs
/// its whole read inside this one call, which is what makes the borrow legal without any global state here.
pub type WithFile = fn(&str, &mut dyn FnMut(&mut dyn ByteSource) -> Result<(), ()>) -> Result<(), ()>;

/// The widest image this widget can draw, in pixels.
///
/// One row of converted pixels is held on the stack so that a source row feeding several destination rows is
/// read once, and the buffer is what sets this limit. It is the widest panel the platform supports (480), and
/// a wider file is refused rather than drawn wrong.
pub const MAX_ROW_PIXELS: usize = 480;

/// Bytes read from the card at a time while converting a row. A multiple of four keeps the reads aligned with
/// the FAT cluster the driver is fetching anyway.
const READ_CHUNK: usize = 128;

/// An image read from a BMP file when it is drawn, streamed a row at a time.
///
/// The design carries a *path* instead of the pixels: an embedded asset is turned into a static array at build
/// time, which costs flash for every image in a design, while this draws from a card the application has
/// mounted. Rows are read and painted in one pass -- no seeking backwards, no whole-image buffer -- so a
/// full-screen image costs a row of stack rather than 300 KB of RAM.
///
/// The file is uncompressed BMP, which any image editor writes: 24- or 32-bit `BI_RGB`, or 16-bit with a
/// 5-5-5 or 5-6-5 layout. Both row orders are handled (a negative height means the file is already top-down).
pub struct BmpImage {
    /// The file on the card, as the driver wants it named (a FAT short name fits without an allocator).
    pub path: &'static str,
    /// True to fill the widget's cell, false to draw at the file's own size in the middle of it.
    pub stretch: bool,
    /// The generated project's reader: `sd::with_file` where the board has a card.
    pub with_file: WithFile,
}

/// What the header says about the pixels that follow it.
struct BmpHeader {
    data_offset: u32,
    width: u32,
    height: u32,
    /// True when the rows are stored top-to-bottom (BMP says this with a negative height).
    top_down: bool,
    bits: u16,
    compression: u32,
    /// Row stride in bytes, padded to a four-byte boundary as the format requires.
    stride: u32,
    red: ChannelMask,
    green: ChannelMask,
    blue: ChannelMask,
}

/// Where a colour channel sits in a pixel and how wide it is, so 5-5-5, 5-6-5 and 8-8-8 all convert.
#[derive(Clone, Copy)]
struct ChannelMask {
    shift: u32,
    bits: u32,
}

impl ChannelMask {
    /// The channel of one pixel, scaled to the five or six bits `Rgb565` wants.
    fn to565(self, pixel: u32, target_bits: u32) -> u8 {
        if self.bits == 0 {
            return 0;
        }
        let value = (pixel >> self.shift) & ((1u32 << self.bits) - 1);
        if self.bits >= target_bits {
            (value >> (self.bits - target_bits)) as u8
        } else {
            (value << (target_bits - self.bits)) as u8
        }
    }
}

/// A little-endian reader over a byte stream, which is all the parsing this format needs.
struct Stream<'a> {
    source: &'a mut dyn ByteSource,
}

impl<'a> Stream<'a> {
    fn read_exact(&mut self, buf: &mut [u8]) -> Result<(), ()> {
        let mut filled = 0;
        while filled < buf.len() {
            let read = self.source.read(&mut buf[filled..])?;
            if read == 0 {
                return Err(());
            }
            filled += read;
        }
        Ok(())
    }

    /// Reads and throws away, for the rows and padding between the ones being drawn.
    fn skip(&mut self, mut count: u32) -> Result<(), ()> {
        let mut scratch = [0u8; READ_CHUNK];
        while count > 0 {
            let step = (count as usize).min(scratch.len());
            self.read_exact(&mut scratch[..step])?;
            count -= step as u32;
        }
        Ok(())
    }

    fn u16(&mut self) -> Result<u16, ()> {
        let mut buf = [0u8; 2];
        self.read_exact(&mut buf)?;
        Ok(u16::from_le_bytes(buf))
    }

    fn u32(&mut self) -> Result<u32, ()> {
        let mut buf = [0u8; 4];
        self.read_exact(&mut buf)?;
        Ok(u32::from_le_bytes(buf))
    }
}

impl BmpHeader {
    /// Reads the fields a drawing pass needs, in one pass over the two headers.
    fn parse(stream: &mut Stream<'_>) -> Result<Self, ()> {
        let mut magic = [0u8; 2];
        stream.read_exact(&mut magic)?;
        if &magic != b"BM" {
            return Err(());
        }
        let _file_size = stream.u32()?;
        let _reserved = stream.u32()?;
        let data_offset = stream.u32()?;
        let header_size = stream.u32()?;
        if header_size < 40 {
            // The OS/2 header is 12 bytes and has no compression or mask fields; nothing writes it any more.
            return Err(());
        }
        let width = stream.u32()?;
        let raw_height = stream.u32()? as i32;
        let _planes = stream.u16()?;
        let bits = stream.u16()?;
        let compression = stream.u32()?;
        let _image_size = stream.u32()?;
        let _x_ppm = stream.u32()?;
        let _y_ppm = stream.u32()?;
        let _colours_used = stream.u32()?;
        let _important = stream.u32()?;

        let top_down = raw_height < 0;
        let height = raw_height.unsigned_abs();
        if width == 0 || height == 0 || width > MAX_ROW_PIXELS as u32 {
            return Err(());
        }
        let (red, green, blue) = match (bits, compression) {
            // BI_BITFIELDS carries the masks after the 40-byte header; BI_RGB's 16-bit is the 5-5-5 layout
            // BMP has meant since Windows 3, which is *not* the 5-6-5 everything else uses.
            (16, 3) => {
                let r = stream.u32()?;
                let g = stream.u32()?;
                let b = stream.u32()?;
                (mask_of(r), mask_of(g), mask_of(b))
            }
            (16, 0) => (mask_of(0x7C00), mask_of(0x03E0), mask_of(0x001F)),
            (24, 0) | (32, 0) => (
                ChannelMask { shift: 16, bits: 8 },
                ChannelMask { shift: 8, bits: 8 },
                ChannelMask { shift: 0, bits: 8 },
            ),
            _ => return Err(()),
        };
        let stride = ((bits as u32 * width + 31) / 32) * 4;
        Ok(Self {
            data_offset,
            width,
            height,
            top_down,
            bits,
            compression,
            stride,
            red,
            green,
            blue,
        })
    }

    /// One pixel of a row, as the canvas wants it.
    #[inline]
    fn colour(&self, bytes: &[u8]) -> Rgb565 {
        let pixel = match self.bits {
            24 => (bytes[2] as u32) << 16 | (bytes[1] as u32) << 8 | bytes[0] as u32,
            32 => (bytes[2] as u32) << 16 | (bytes[1] as u32) << 8 | bytes[0] as u32,
            _ => u16::from_le_bytes([bytes[0], bytes[1]]) as u32,
        };
        Rgb565::new(
            self.red.to565(pixel, 5),
            self.green.to565(pixel, 6),
            self.blue.to565(pixel, 5),
        )
    }

    /// Bytes per pixel, which is what walks a row.
    fn bytes_per_pixel(&self) -> u32 {
        (self.bits as u32 + 7) / 8
    }
}

/// The mask a `0xRRGGBB`-style bit pattern describes.
fn mask_of(pattern: u32) -> ChannelMask {
    if pattern == 0 {
        return ChannelMask { shift: 0, bits: 0 };
    }
    let shift = pattern.trailing_zeros();
    let bits = pattern.count_ones();
    ChannelMask { shift, bits }
}

impl BmpImage {
    /// Draws the file into `rect`, one row at a time.
    fn draw(
        &self,
        source: &mut dyn ByteSource,
        canvas: &mut dyn CustomCanvas,
        rect: Rect,
    ) -> Result<(), ()> {
        let mut stream = Stream { source };
        let header = BmpHeader::parse(&mut stream)?;

        // The destination: the whole cell when stretching, otherwise the file's own size centred in it.
        let area = if self.stretch {
            rect
        } else {
            let w = header.width.min(rect.w);
            let h = header.height.min(rect.h);
            Rect::new(
                rect.x + (rect.w.saturating_sub(w) / 2) as i32,
                rect.y + (rect.h.saturating_sub(h) / 2) as i32,
                w,
                h,
            )
        };
        if area.w == 0 || area.h == 0 {
            return Ok(());
        }

        // Skip whatever precedes the pixels (the colour table, usually).
        stream.skip(header.data_offset.saturating_sub(header_bytes_read(&header)))?;

        let bytes_per_pixel = header.bytes_per_pixel();
        let mut row = [Rgb565::new(0, 0, 0); MAX_ROW_PIXELS];
        let mut scratch = [0u8; READ_CHUNK];

        // Rows are visited in the order the *file* holds them, which is the only order a stream can be read in:
        // a bottom-up BMP (the usual one, and the reason a height is signed) stores the bottom row first, so the
        // destination rows are walked from the last to the first. Every destination row then maps to a source
        // row that is the same as the one before it or later in the file, never earlier -- which is exactly what
        // lets this be one pass with a single row of memory.
        let ascending = header.top_down;
        let mut cached: Option<u32> = None;
        for step in 0..area.h {
            let dy = if ascending { step } else { area.h - 1 - step };
            let visual = (dy as u64 * header.height as u64 / area.h as u64) as u32;
            let file_row = if ascending {
                visual
            } else {
                header.height - 1 - visual
            };

            if cached != Some(file_row) {
                let previous = cached.map(|row| row as i64).unwrap_or(-1);
                let ahead = file_row as i64 - previous - 1;
                if ahead < 0 {
                    // Only reachable with a hand-edited header: rows that would have to be read again.
                    return Ok(());
                }
                stream.skip(ahead as u32 * header.stride)?;
                read_row(&mut stream, &header, bytes_per_pixel, &mut row, &mut scratch)?;
                cached = Some(file_row);
            }
            // An enlarged image feeds one source row to several destination rows; the row is still cached, so
            // those cost a paint rather than another read.
            draw_row(canvas, &header, &row, area, dy);
        }
        Ok(())
    }
}

/// The header bytes `BmpHeader::parse` consumed, so the skip lands exactly on the pixel data.
fn header_bytes_read(header: &BmpHeader) -> u32 {
    // 14 (file header) + 40 (info header) + 12 when the bitfield masks are present.
    if header.bits == 16 && header.compression == 3 {
        66
    } else {
        54
    }
}

/// Reads one whole source row into `row`, converting as it goes and throwing the padding away.
///
/// A row is longer than the read buffer for any real image, so a pixel can straddle two reads. The carry is what
/// keeps that from losing its bytes: without it a 64-pixel row comes out right for the first 42 pixels and
/// shifted after that, which is a picture rather than an error.
fn read_row(
    stream: &mut Stream<'_>,
    header: &BmpHeader,
    bytes_per_pixel: u32,
    row: &mut [Rgb565; MAX_ROW_PIXELS],
    scratch: &mut [u8; READ_CHUNK],
) -> Result<(), ()> {
    let bytes = bytes_per_pixel as usize;
    let mut carry = [0u8; 4];
    let mut carried = 0usize;
    let mut x = 0usize;
    let mut remaining = header.stride;
    while remaining > 0 {
        let step = (remaining as usize).min(scratch.len());
        stream.read_exact(&mut scratch[..step])?;
        remaining -= step as u32;
        let mut offset = 0usize;
        while offset < step {
            let take = (bytes - carried).min(step - offset);
            carry[carried..carried + take].copy_from_slice(&scratch[offset..offset + take]);
            carried += take;
            offset += take;
            if carried == bytes {
                if x < header.width as usize {
                    row[x] = header.colour(&carry[..bytes]);
                    x += 1;
                }
                carried = 0;
            }
        }
    }
    Ok(())
}

/// Paints one converted source row across the destination row it belongs to, one run per colour change.
fn draw_row(
    canvas: &mut dyn CustomCanvas,
    header: &BmpHeader,
    row: &[Rgb565; MAX_ROW_PIXELS],
    area: Rect,
    destination_y: u32,
) {
    let mut run_start = 0u32;
    let mut run_colour = row[0];
    for dx in 1..=area.w {
        let source = (dx as u64 * header.width as u64 / area.w as u64) as usize;
        let colour = if source < header.width as usize { row[source] } else { run_colour };
        let changed = dx == area.w || colour != run_colour;
        if changed {
            let run_width = dx.saturating_sub(run_start);
            if run_width > 0 {
                let _ = canvas.fill_rect(
                    Rect::new(area.x + run_start as i32, area.y + destination_y as i32, run_width, 1),
                    run_colour,
                );
            }
            run_start = dx;
            run_colour = colour;
        }
    }
}

impl CustomWidget for BmpImage {
    fn render(
        &self,
        canvas: &mut dyn CustomCanvas,
        rect: Rect,
        _style: &WidgetStyle,
        _state: VisualState,
    ) -> Result<(), GuiError> {
        if rect.w == 0 || rect.h == 0 {
            return Ok(());
        }
        // The reader owns the file handle for this whole call; the closure is the drawing pass inside it. A
        // failure is not an error the engine has to carry: an image that is missing or not a BMP leaves the
        // cell as it was, which is what a placeholder does on the glass.
        let mut sink = |source: &mut dyn ByteSource| self.draw(source, canvas, rect);
        let _ = (self.with_file)(self.path, &mut sink);
        Ok(())
    }
}
