# embedded-gui-codegen (vendored fork)

This is **upstream `embedded-gui-codegen` 0.2.7, vendored**, plus one change: the emitter's shape arms.

Upstream, `circle`, `rect`, `line` and `vector_path` parse fine but are emitted as `gui.add_panel(..)` (or
`add_spacer(..)`) stubs, so they render as the wrong primitive — a circle is a rectangle on the glass. The fork
emits `gui.add_custom_widget(cells[..], &STATIC, ..)` for `circle`/`rect`/`line` and (newly parsed) `triangle`,
building a `rusty_gui_widgets::Circle`/`Rectangle`/`Line`/`Triangle` from the parsed colours. Everything else is
upstream verbatim; the four files that differ are listed in `NOTES.md` §102.

Provenance:

* Package: `embedded-gui-codegen` 0.2.7 (`publish = false` here)
* Origin: <https://github.com/leftger/embedded-gui> (crates.io `embedded-gui-codegen` 0.2.7)
* Licence: MIT OR Apache-2.0 — see `LICENSE`, `LICENSE-MIT`, `LICENSE-APACHE`
* Copyright (c) 2026 embedded-gui contributors

It is vendored (rather than published) because a generated project needs it offline and because the shape API it
targets ships alongside it as `rusty-gui-widgets`. The generated `Cargo.toml` redirects the crates.io dependency
with `[patch.crates-io]`, which is why the version here **must** stay in step with the version upstream is
depended on (`0.2.7`): a patch only applies to a matching requirement.
