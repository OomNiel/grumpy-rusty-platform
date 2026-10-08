//! Reproduces the board's crash on the host: a design wider than the render target's bounding box.
//!
//! The CYD ran the Designer firmware and died with a `DivideByZero` exception in
//! `embedded_gui::layout::GridLayout::resolve_tracks` (layout.rs:718), and the register dump had 480 in the
//! numerator and 0 in the divisor. The design is 480 wide and every one of its grid tracks is a pixel track,
//! so there is no fractional track to divide the leftover space between -- and the leftover is zero anyway,
//! because mipidsi's `Display` reports the panel's *native* 320x480 bounding box even when its drawing area
//! has been swapped for a vertical rotation.
//!
//! This binary is that condition, on the host: the viewport is the design's 480x320 while the render target
//! is 320x480. If it panics here, the mechanism is confirmed and the fix can be developed without flashing.
//!
//! Finding it here matters more than finding it once: the board takes a flash per attempt, and this takes a
//! second.

#[path = "../ui.rs"]
mod ui;

/// The same handler module the dispatch harness uses, so nothing here depends on the board either.
mod ui_handlers {
    pub fn on_go_clicked() {}
}

include!("../starter_expectations.rs");

use embedded_gui::prelude::*;

fn main() {
    // The device's condition, in the two numbers that matter: the design's viewport, and the box the render
    // target reports (the panel's native size).
    let viewport = Rect::new(0, 0, CANVAS_W, CANVAS_H);
    let target_box = (CANVAS_H, CANVAS_W);

    println!(
        "design viewport {}x{}, render target {}x{}",
        viewport.w, viewport.h, target_box.0, target_box.1
    );

    let outcome = std::panic::catch_unwind(move || {
        // Exactly what the generated firmware does: build the screen at the design's size and paint it into
        // the target the panel provides.
        let mut screen = ui::Designer::new(viewport.w, viewport.h);
        let mut buffer = TestBuffer::new(target_box.0, target_box.1);
        screen.repaint(&mut buffer).map_err(|_| ())
    });

    match outcome {
        Ok(Ok(())) => {
            println!("PASS: no panic with a narrower target than the design");
        }
        Ok(Err(())) => {
            println!("PASS: the render reported an error instead of panicking");
        }
        Err(_) => {
            println!(
                "REPRODUCED: the layout panicked, exactly as the board did -- a design wider than the \
                 render target's bounding box, with no fractional track to divide the leftover between"
            );
            std::process::exit(1);
        }
    }
}
