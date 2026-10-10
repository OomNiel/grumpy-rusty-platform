//! Does a triangle's designed shape reach the glass?
//!
//! A triangle used to be isosceles and nothing else: the crate derived its vertices from the cell rectangle.
//! Now the design names them (`p1x`..`p3y`, per-mille of the cell), which is six numbers travelling designer
//! -> markup -> parser -> generated Rust -> crate -> engine. Every one of those steps can drop them and still
//! *compile*: the parser falls back to the isosceles default, and a dropped field renders a perfectly
//! plausible triangle. So "the design builds" says nothing here, and neither does a pixel count -- the
//! fixture's right triangle and the default isosceles one fill exactly half of the same cell.
//!
//! What does say something is *where* the ink is. This renders the same design twice -- once as drawn, once
//! with the points reset to the crate's default -- and checks one pixel deep inside each shape: each render
//! must have its own triangle's fill there, and not the other's. A design whose points were ignored paints
//! the same triangle in both, which fails here rather than on someone's board.
//!
//! The pixel rather than the whole cell for a reason: the engine paints a custom widget over a styled cell,
//! so most of the cell differs from the screen's backdrop whatever shape was drawn. It is the *fill colour*
//! that says which triangle is on the glass.
//!
//! It also checks the two renders agree everywhere outside the triangle's own cell, so the check cannot pass
//! because of some unrelated difference.

use embedded_gui::prelude::*;

/// The fixture as it is: its triangle is a right triangle with the apex in the cell's top right corner.
mod designed {
    use embedded_gui::prelude::*;
    embedded_gui::include_gui!("screens/panel.kdl");
}

/// The same design with the triangle's points reset to the crate's default isosceles triangle.
mod isosceles {
    use embedded_gui::prelude::*;
    embedded_gui::include_gui!("screens/panel-isosceles.kdl");
}

include!("../shape_points_expectations.rs");

fn render<A>(app: fn(&mut GuiContext<'static, 256, 64, 256>) -> A) -> TestBuffer {
    let mut gui = GuiContext::<256, 64, 256>::new(Rect::new(0, 0, CANVAS_W, CANVAS_H));
    let _ = app(&mut gui);
    let mut buffer = TestBuffer::new(CANVAS_W, CANVAS_H);
    gui.render(&mut buffer).expect("the design did not render");
    buffer
}

/// The fill colour the fixture gives its triangle (`#ff0000`), which is what marks a pixel as *inside* it.
const TRIANGLE_FILL: Rgb565 = Rgb565::new(31, 0, 0);

fn main() {
    let drawn = render(|gui| designed::SimPanelApp::build(gui).expect("the design builds"));
    let default = render(|gui| isosceles::SimPanelApp::build(gui).expect("the design builds"));
    let (rx, ry, rw, rh) = TRIANGLE_RECT;
    let inside = |buffer: &TestBuffer, (x, y): (i32, i32)| buffer.pixel_at(x, y) == Some(TRIANGLE_FILL);

    let mut problems: Vec<String> = Vec::new();

    // Each shape has its fill at one probe pixel and not at the other's: the only difference between the two
    // renders is which six numbers the triangle was given.
    for (label, own, other, buffer) in [
        ("the design's right triangle", TOP_RIGHT, TOP_CENTRE, &drawn),
        ("the default isosceles triangle", TOP_CENTRE, TOP_RIGHT, &default),
    ] {
        if !inside(buffer, own) {
            problems.push(format!(
                "{label} is not filled at ({}, {}), which is inside it and outside the other shape: the points \
                 it was given did not reach the glass",
                own.0, own.1
            ));
        }
        if inside(buffer, other) {
            problems.push(format!(
                "{label} is filled at ({}, {}), which belongs to the *other* shape: the two renders drew the \
                 same triangle, so the design's points were ignored",
                other.0, other.1
            ));
        }
    }

    // The two designs differ only in those six numbers, so nothing outside the triangle's cell may move.
    let mut changed_in_cell = 0usize;
    let mut cell_total = 0usize;
    let mut outside_changed = 0usize;
    for y in 0..CANVAS_H as i32 {
        for x in 0..CANVAS_W as i32 {
            let in_cell = x >= rx && x < rx + rw as i32 && y >= ry && y < ry + rh as i32;
            if in_cell {
                cell_total += 1;
            }
            if drawn.pixel_at(x, y) != default.pixel_at(x, y) {
                if in_cell {
                    changed_in_cell += 1;
                } else {
                    outside_changed += 1;
                }
            }
        }
    }
    if changed_in_cell == 0 {
        problems.push(format!(
            "the two shapes are identical across all {cell_total} pixels of the cell, so nothing about the \
             triangle came from the design"
        ));
    }
    if outside_changed != 0 {
        problems.push(format!(
            "the triangle's points changed {outside_changed} pixels outside its own cell, which means the \
             shape was not clipped to it"
        ));
    }

    if problems.is_empty() {
        println!(
            "PASS: the design's right triangle and the default isosceles one differ in {changed_in_cell} of the \
             {cell_total} pixels of their cell -- each fills its own point at ({}, {}) and ({}, {}) and not the \
             other's -- and agree on every pixel outside it",
            TOP_RIGHT.0, TOP_RIGHT.1, TOP_CENTRE.0, TOP_CENTRE.1
        );
        return;
    }
    for problem in &problems {
        eprintln!("FAIL: {problem}");
    }
    std::process::exit(1);
}
