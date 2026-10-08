// The code behind your design's events -- yours to keep.
//
// The designer appends a stub here for each event it is asked for, and never rewrites what is already
// written. Rename the bodies, move them into modules, call them from anywhere: the only thing that has to
// stay is the name and the signature, because `src/ui.rs` calls them by name.
//
// rusty-designer-handlers

/// Raised by the design. Called from `ui::Designer::pump`.
pub fn on_go_clicked() {
    log::info!("design: on_go_clicked fired");
}
