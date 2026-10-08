//! Does a declared font actually reach the pixels?
//!
//! The `Font id` field was once a text box that did nothing: a widget names a font the screen declares, and the
//! code generator drops an unresolvable name *without a word*. So "the design compiles and renders" is not
//! evidence that a font was applied -- the same build succeeds when the reference is silently ignored.
//!
//! This renders the fixture twice: once as it stands, and once with the font declarations removed and the
//! reference cleared. The two images must then differ **inside** the rectangle of the widget that was given a
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

    let (fx, fy, fw, fh) = FONTED_RECT;
    let (mut inside, mut outside) = (0usize, 0usize);
    let (mut inside_total, mut outside_total) = (0usize, 0usize);

    for y in 0..CANVAS_H as i32 {
        for x in 0..CANVAS_W as i32 {
            let same = with.pixel_at(x, y) == without.pixel_at(x, y);
            let in_fonted = x >= fx && x < fx + fw as i32 && y >= fy && y < fy + fh as i32;
            if in_fonted {
                inside_total += 1;
                if !same {
                    inside += 1;
                }
            } else {
                outside_total += 1;
                if !same {
                    outside += 1;
                }
            }
        }
    }

    let mut problems: Vec<String> = Vec::new();

    if inside == 0 {
        problems.push(format!(
            "the font changed nothing: all {inside_total} pixels of {} are identical with and without it, \
             so the reference was dropped",
            "the label that was given the font"
        ));
    }
    if outside != 0 {
        problems.push(format!(
            "the font changed {outside} of {outside_total} pixels outside that label, which means it leaked \
             into the rest of the design"
        ));
    }

    if problems.is_empty() {
        println!(
            "PASS: the font changed {inside} of {inside_total} pixels inside its label and none of the \
             {outside_total} outside it"
        );
        return;
    }
    for problem in &problems {
        eprintln!("FAIL: {problem}");
    }
    std::process::exit(1);
}
