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
