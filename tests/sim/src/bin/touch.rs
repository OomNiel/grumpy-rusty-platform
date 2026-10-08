//! The event half of the designer's proof: does a touch land on the widget it looks like it should?
//!
//! The geometry half (`designer-sim`) proves the layout engine puts every widget on the rectangle the canvas
//! showed. This proves the other half of the same promise: that a *finger* at those coordinates reaches that
//! widget and raises its event. It is the question a flash and a finger would answer, and it is answered here
//! instead -- deterministically, with no board -- by driving the crate's own input path:
//! `handle_input(InputEvent::Pointer { .. })` and `pop_event()`.
//!
//! Every check is generated from the fixture in `tests/tools/designer-sim.js`, so the coordinates under test
//! are the ones the canvas drew, not ones written out by hand here.

use embedded_gui::prelude::*;

mod screen {
    use embedded_gui::prelude::*;
    embedded_gui::include_gui!("screens/panel.kdl");
}

include!("../expectations.rs");

fn main() {
    let mut gui = GuiContext::<256, 64, 256>::new(Rect::new(0, 0, CANVAS_W, CANVAS_H));
    let app = match screen::SimPanelApp::build(&mut gui) {
        Ok(app) => app,
        Err(err) => {
            eprintln!("FAIL: the screen did not build: {err:?}");
            std::process::exit(1);
        }
    };
    // A first frame, so the widgets are laid out and hit-testable before anything is tapped. Without this the
    // engine has no rectangles to test a point against.
    let mut buffer = TestBuffer::new(CANVAS_W, CANVAS_H);
    if let Err(err) = gui.render(&mut buffer) {
        eprintln!("FAIL: the screen did not render: {err:?}");
        std::process::exit(1);
    }

    let problems = touch_checks(&mut gui, &app.widgets);
    if problems.is_empty() {
        println!("PASS: every tapped widget received its own event, and empty canvas claimed nothing");
        return;
    }
    for problem in &problems {
        eprintln!("FAIL: {problem}");
    }
    std::process::exit(1);
}
