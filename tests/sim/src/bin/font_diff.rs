//! Does a font actually reach the pixels?
//!
//! The `Font id` field was once a text box that did nothing: a widget names a font the screen declares, and the
//! code generator drops an unresolvable name *without a word*. So "the design compiles and renders" is not
//! evidence that a font was applied -- the same build succeeds when the reference is silently ignored.
//!
//! There are two ways to ask for a font and they travel differently: a *declared* one is a BDF file the screen
//! declares and a widget names with `font=`, a *built-in* one ships inside the crate and is only reachable
//! through a `style` expression. Both are measured here, since a typo in either is equally silent.
//!
//! This renders the fixture twice: once as it stands, and once with the font declarations removed and every
//! reference cleared. The two images must then differ **inside** the rectangle of every widget that was given a
//! font, and be **identical everywhere else**. The second half is what stops the check passing for the wrong
//! reason: a build where nothing at all was painted would fail it.

use embedded_gui::prelude::*;

/// The design as it is: it declares a font and gives it to one label.
mod with_font {
    use embedded_gui::prelude::*;
    embedded_gui::include_gui!("screens/panel.kdl");
}

/// The same design with no font at all.
mod without_font {
    use embedded_gui::prelude::*;
    embedded_gui::include_gui!("screens/panel-nofont.kdl");
}

include!("../font_diff_expectations.rs");

fn render<A>(
    app: fn(&mut GuiContext<'static, 256, 64, 256>) -> A,
) -> TestBuffer {
    let mut gui = GuiContext::<256, 64, 256>::new(Rect::new(0, 0, CANVAS_W, CANVAS_H));
    let _ = app(&mut gui);
    let mut buffer = TestBuffer::new(CANVAS_W, CANVAS_H);
    gui.render(&mut buffer).expect("the design did not render");
    buffer
}

fn main() {
    let with = render(|gui| with_font::SimPanelApp::build(gui).expect("the design builds"));
    let without = render(|gui| without_font::SimPanelApp::build(gui).expect("the design builds"));

    // One bucket per region the design gave a font to. `changed` counts the pixels that differ between the
    // two renders; `total` is the region's area, so a failure can say how much of it moved.
    let mut inside = [(0usize, 0usize); FONTED_RECTS.len()];
    let mut outside = 0usize;
    let mut outside_total = 0usize;

    for y in 0..CANVAS_H as i32 {
        for x in 0..CANVAS_W as i32 {
            let same = with.pixel_at(x, y) == without.pixel_at(x, y);
            let region = FONTED_RECTS.iter().position(|&(rx, ry, rw, rh)| {
                x >= rx && x < rx + rw as i32 && y >= ry && y < ry + rh as i32
            });
            match region {
                Some(index) => {
                    inside[index].1 += 1;
                    if !same {
                        inside[index].0 += 1;
                    }
                }
                None => {
                    outside_total += 1;
                    if !same {
                        outside += 1;
                    }
                }
            }
        }
    }

    let mut problems: Vec<String> = Vec::new();

    for (index, &(rx, ry, rw, rh)) in FONTED_RECTS.iter().enumerate() {
        let (changed, total) = inside[index];
        if changed == 0 {
            problems.push(format!(
                "the font changed nothing: all {total} pixels of the widget at ({rx}, {ry}) {rw}x{rh} are \
                 identical with and without it, so the reference was dropped"
            ));
        }
    }
    if outside != 0 {
        problems.push(format!(
            "the font changed {outside} of {outside_total} pixels outside those widgets, which means it leaked \
             into the rest of the design"
        ));
    }

    if problems.is_empty() {
        let report: Vec<String> = FONTED_RECTS
            .iter()
            .enumerate()
            .map(|(index, _)| format!("{} of {}", inside[index].0, inside[index].1))
            .collect();
        println!(
            "PASS: the fonts changed {} pixels inside their widgets (one count per widget: {}) and none of \
             the {outside_total} outside them",
            inside.iter().map(|&(changed, _)| changed).sum::<usize>(),
            report.join(", ")
        );
        return;
    }
    for problem in &problems {
        eprintln!("FAIL: {problem}");
    }
    std::process::exit(1);
}
