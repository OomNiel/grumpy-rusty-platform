//! Drives the *generated* Rust side of a Designer project, on the host.
//!
//! Everything else in `tests/sim` tests the crate: that it lays the design out where the canvas drew it, and
//! that a tap reaches the widget drawn there. This tests what the extension generates -- `ui::Designer`'s
//! press/release state machine, its dispatch `match`, and its render calls -- which would otherwise only ever
//! be proven to compile.
//!
//! `src/ui.rs` and `src/ui.kdl` are the real generated files, written by `tests/tools/designer-sim.js` from
//! the design a new project starts with. The handler module is this test's own, with a counter instead of a
//! log line, because the thing under test is that `ui.rs` calls its handlers *by name*: rename one on either
//! side and this stops compiling, which is the failure worth having.

#[path = "../ui.rs"]
mod ui;

/// The code behind the design's events, as a test: one counter per handler.
mod ui_handlers {
    use core::sync::atomic::{AtomicUsize, Ordering};

    /// How many times the starter design's button handler has been called.
    pub static TAPS: AtomicUsize = AtomicUsize::new(0);

    pub fn on_go_clicked() {
        TAPS.fetch_add(1, Ordering::SeqCst);
    }
}

include!("../starter_expectations.rs");

use embedded_gui::prelude::*;

fn main() {
    let mut problems: Vec<String> = Vec::new();
    let mut screen = ui::Designer::new(CANVAS_W, CANVAS_H);

    // The first frame: a full render, which is also what tells the widgets where they are so a point can be
    // hit-tested against them.
    let mut buffer = TestBuffer::new(CANVAS_W, CANVAS_H);
    if let Err(err) = screen.repaint(&mut buffer) {
        eprintln!("FAIL: the design did not paint: {err:?}");
        std::process::exit(1);
    }
    let taps = |expected: usize, what: &str, problems: &mut Vec<String>| {
        let seen = ui_handlers::TAPS.load(core::sync::atomic::Ordering::SeqCst);
        if seen != expected {
            problems.push(format!("{what}: expected {expected} handler call(s), saw {seen}"));
        }
    };

    // A tap: down, then up. The wrapper is what turns that into the crate's Pressed/Released pair, and the
    // crate is what turns the pair into a click.
    screen.pointer(BUTTON_X, BUTTON_Y, true);
    screen.pointer(BUTTON_X, BUTTON_Y, false);
    screen.pump();
    taps(1, "a tap on the button", &mut problems);

    // A second tap, so the counter is not simply stuck at one.
    screen.pointer(BUTTON_X, BUTTON_Y, true);
    screen.pointer(BUTTON_X, BUTTON_Y, false);
    screen.pump();
    taps(2, "a second tap", &mut problems);

    // A press **captures** the widget it lands on: a finger that goes down on the button and lifts somewhere
    // else still clicks it. That is the crate's dispatch semantics, not a choice this layer makes -- and it is
    // not what every toolkit does, so it is asserted rather than assumed. (Found by writing this test with the
    // opposite expectation, which failed.)
    screen.pointer(BUTTON_X, BUTTON_Y, true);
    screen.pointer(BUTTON_X + 4, BUTTON_Y, true);
    screen.pointer(EMPTY_X, EMPTY_Y, true);
    screen.pointer(EMPTY_X, EMPTY_Y, false);
    screen.pump();
    taps(3, "a drag that started on the button", &mut problems);

    // The other side of the same rule: a press that starts where there is nothing clicks nothing, even when it
    // ends right on the button. So the capture follows where the finger went *down*, not where it came up.
    screen.pointer(EMPTY_X, EMPTY_Y, true);
    screen.pointer(BUTTON_X, BUTTON_Y, true);
    screen.pointer(BUTTON_X, BUTTON_Y, false);
    screen.pump();
    taps(3, "a drag that started on empty canvas and ended on the button", &mut problems);

    // The rest of the generated API has to work whether or not anything changed: a dirty render and the
    // damage check are called on every frame in the firmware.
    let _ = screen.is_dirty();
    if let Err(err) = screen.render(&mut buffer) {
        problems.push(format!("the dirty render failed: {err:?}"));
    }

    if problems.is_empty() {
        println!("PASS: the generated ui.rs dispatched every tap to its handler, and only taps");
        return;
    }
    for problem in &problems {
        eprintln!("FAIL: {problem}");
    }
    std::process::exit(1);
}
