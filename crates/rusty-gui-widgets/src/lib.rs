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
        let cx = rect.x + (rect.w as i32 >> 1);
        let cy = rect.y + (rect.h as i32 >> 1);
        let r = (rect.w.min(rect.h) >> 1) as i32;
        if r <= 0 {
            return Ok(());
        }
        let r2 = r as i64 * r as i64;
        // A pen of zero means *no outline*, which is what the designer's canvas draws and what its
        // `line_thickness` of 0 promises: only the annulus is skipped, the disc still fills.
        let pen = self.stroke_width as i32;
        let ring = if self.stroke.is_some() && pen > 0 {
            let inner = (r - pen).max(0) as i64;
            Some(inner * inner)
        } else {
            None
        };

        for y in (cy - r)..=(cy + r) {
            let dy = (y - cy) as i64;
            let dy2 = dy * dy;
            for x in (cx - r)..=(cx + r) {
                let dx = (x - cx) as i64;
                let d = dx * dx + dy2;
                if d > r2 {
                    continue;
                }
                if let Some(c) = self.fill {
                    canvas.draw_pixel(x, y, c)?;
                }
                if let Some(inner2) = ring {
                    if d > inner2 {
                        if let Some(c) = self.stroke {
                            canvas.draw_pixel(x, y, c)?;
                        }
                    }
                }
            }
        }
        Ok(())
    }
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
        if rect.w >= rect.h {
            let y = rect.y + (rect.h as i32 >> 1);
            draw_thick_line(canvas, (rect.x, y), (rect.right(), y), thick, color)?;
        } else {
            let x = rect.x + (rect.w as i32 >> 1);
            draw_thick_line(canvas, (x, rect.y), (x, rect.bottom()), thick, color)?;
        }
        Ok(())
    }
}

/// A triangle inscribed in the cell `rect` -- apex at the top edge centre, base on
/// the bottom edge, the same way the designer's canvas draws it. Fill is a scanline
/// rasteriser over the signed-area vertices; stroke walks each edge with a thick
/// pen. The three vertices are derived from the rect, never parsed.
pub struct Triangle {
    pub stroke_width: u8,
    pub fill: Option<Rgb565>,
    pub stroke: Option<Rgb565>,
}

impl CustomWidget for Triangle {
    fn render(
        &self,
        canvas: &mut dyn CustomCanvas,
        rect: Rect,
        _style: &WidgetStyle,
        _state: VisualState,
    ) -> Result<(), GuiError> {
        let cx = rect.x + (rect.w as i32 >> 1);
        if rect.h == 0 || rect.w == 0 {
            return Ok(());
        }
        // top, bottom-left, bottom-right
        let v: [(i32, i32); 3] = [(cx, rect.y), (rect.x, rect.bottom()), (rect.right(), rect.bottom())];

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
                    for x in lo..=hi {
                        canvas.draw_pixel(x, y, c)?;
                    }
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
            canvas.draw_line((x0 + r, y0), (x1 - r, y0), color)?;
            canvas.draw_line((x0 + r, y1), (x1 - r, y1), color)?;
            canvas.draw_line((x0, y0 + r), (x0, y1 - r), color)?;
            canvas.draw_line((x1, y0 + r), (x1, y1 - r), color)?;
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
