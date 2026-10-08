//! The host-side half of the designer's proof.
//!
//! The designer promises that what is on the canvas is what the panel draws, and the markup it emits has no
//! absolute positioning -- a widget becomes a grid placement across pixel tracks. Whether that translation
//! actually lands on the designed rectangle is a property of `embedded-gui`'s layout engine, not of our
//! arithmetic, so it cannot be tested in TypeScript: it has to be rendered and measured.
//!
//! This binary does that on the host, with no board attached. `tests/tools/designer-sim.js` writes
//! `screens/panel.kdl` and `src/expectations.rs` from `fixture.json` using the extension's own emitter, and
//! this program compiles that markup through the real `include_gui!` macro, builds it into a real
//! `GuiContext`, renders it into a `TestBuffer`, and asks the engine where each widget ended up.
//!
//! `absolute_rect` is the assertion that matters: it is the engine's own answer, in canvas coordinates, so a
//! widget that lands a pixel off is a failure here rather than a surprise on glass. The pixel probe is a
//! second, independent check that something of the right colour was actually painted.

use embedded_gui::prelude::*;

mod screen {
    use embedded_gui::prelude::*;
    embedded_gui::include_gui!("screens/panel.kdl");
}

// Generated: CANVAS_W/CANVAS_H, EXPECTED_FILL and check().
include!("expectations.rs");

fn main() {
    // Budgets are for the host, so generous: the fixture has eight widgets and the engine's node, edge and
    // damage capacities are what these const generics size.
    let mut gui = GuiContext::<256, 64, 256>::new(Rect::new(0, 0, CANVAS_W, CANVAS_H));

    let app = match screen::SimPanelApp::build(&mut gui) {
        Ok(app) => app,
        Err(err) => {
            eprintln!("FAIL: the screen did not build: {err:?}");
            std::process::exit(1);
        }
    };

    let mut buffer = TestBuffer::new(CANVAS_W, CANVAS_H);
    if let Err(err) = gui.render(&mut buffer) {
        eprintln!("FAIL: the screen did not render: {err:?}");
        std::process::exit(1);
    }

    let mut problems = check(&|id| gui.absolute_rect(id), &app.widgets);

    // Did the widget paint at all? This is the claim the harness can make without depending on how the
    // theme resolves colours: the probed widget's own rectangle must differ from the pixel just outside it.
    //
    // What it deliberately does *not* assert is that the pixel equals the colour the document asked for.
    // It does not, and that is a finding rather than a bug in the markup: `WidgetStyle::with_bg` sets
    // `normal.background`, but `WidgetStyle::button()` also carries a default vertical gradient
    // (top `Rgb565::new(6, 12, 16)`, bottom `Rgb565::new(2, 4, 8)`) which nothing in the KDL surface can
    // clear, so the gradient is painted over the background and the visible fill is the theme's. The
    // observed colour is reported below so the behaviour is visible rather than hidden.
    let (probe_x, probe_y, requested) = EXPECTED_FILL;
    let (ref_x, ref_y) = PROBE_REFERENCE;
    let inside = buffer.pixel_at(probe_x, probe_y);
    let outside = buffer.pixel_at(ref_x, ref_y);
    match (inside, outside) {
        (Some(painted), Some(background)) => {
            if painted == background {
                problems.push(format!(
                    "the probed widget painted nothing: ({probe_x}, {probe_y}) and ({ref_x}, {ref_y}) are both {painted:?}"
                ));
                let (rx, ry, rw, rh) = PROBE_RECT;
                let step = 4i32.max((rw as i32 / 12).max(1));
                for y in (ry..ry + rh as i32).step_by(step as usize) {
                    let mut row = String::new();
                    for x in (rx..rx + rw as i32).step_by(step as usize) {
                        row.push(match buffer.pixel_at(x, y) {
                            Some(px) if px == painted => '.',
                            Some(_) => '#',
                            None => '?',
                        });
                    }
                    problems.push(format!("  y={y:<4} {row}"));
                }
            } else {
                println!(
                    "  the probed widget painted {painted:?} where the document asked for {requested:?} \
                     ({} pixels of the requested colour)",
                    buffer.count_color(requested)
                );
            }
        }
        _ => problems.push(format!(
            "the buffer is missing a probe pixel: ({probe_x}, {probe_y}) or ({ref_x}, {ref_y})"
        )),
    }

    if problems.is_empty() {
        println!("PASS: all {CANVAS_W}x{CANVAS_H} tracks landed where the canvas placed them");
        return;
    }
    for problem in &problems {
        eprintln!("FAIL: {problem}");
    }
    std::process::exit(1);
}
