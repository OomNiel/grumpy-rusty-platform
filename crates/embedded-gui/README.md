# embedded-gui (vendored fork)

This is **upstream `embedded-gui` 0.2.7, vendored**, plus the appearance and interaction fixes a WYSIWYG
designer needs. Upstream is a `no_std` GUI toolkit whose *code generator* is what turns KDL markup into Rust;
the extension already vendors a fork of that generator (`crates/embedded-gui-codegen`). This fork is the other
half: the **runtime the generated code calls**, so that a control the designer shows can be configured from the
design instead of being fixed inside the renderer.

Provenance:

* Package: `embedded-gui` 0.2.7 (`publish = false` here)
* Origin: <https://github.com/leftger/embedded-gui> (crates.io `embedded-gui` 0.2.7)
* Licence: MIT OR Apache-2.0 — see `LICENSE`, `LICENSE-MIT`, `LICENSE-APACHE`
* Copyright (c) 2026 embedded-gui contributors

The upstream README is kept as `UPSTREAM-README.md`; this file describes the fork.

## Why vendor the runtime at all

Four values the designer has to offer live *inside* the crate's renderers, where no markup can reach them:

| Where | Upstream | Here |
| --- | --- | --- |
| `WidgetKind::Checkbox` | the box is `inner.h.min(8)` pixels, always | a `box_size` field; `0` keeps upstream's rule |
| `add_scale` | tick and needle colours, tick counts and the 135°/45° sweep are hard-coded | `add_scale_styled(..)` takes them |
| `render_toggle` | the track's "off" colour is a literal `Rgb565::new(7, 10, 10)` | an `off_color` field |
| `SpinboxWidget::render` | the focused-digit underline is `CSS_CYAN` and the chevron borders `CSS_GRAY` | `accent_color`/`chevron_color` fields |

and one defect that makes a gauge useless in a running application: **a `scale`'s value cannot be changed after
it is created**. `ScaleWidget` implements `Widget::get_property`/`set_property` for `Value`/`Min`/`Max`, but the
node dispatch in `widgets/mod.rs` has no arm for `WidgetKind::Scale`, so `set_widget_property(.., Value, ..)`
returns `NotFound` for the one widget whose whole purpose is to display a changing number.

An alternative was to render these controls with `add_custom_widget` from `rusty-gui-widgets`, as the shapes
already are. That was rejected after reading the engine: `WidgetKind::Custom` forwards `focusable()` to the
widget but **not** `get_property`/`set_property`, so a custom checkbox could not be read with `checked_value`
or set with `set_checked`, and a custom gauge could not be given a value at all. Interactivity is the point of
those two controls, so the runtime is patched instead — additively, and in the crate's own idiom.

## What differs from upstream

Everything is additive: no existing function changes signature, no existing field changes meaning, and the
`0`/`None` cases reproduce upstream's behaviour exactly, so a project that patches to this fork but writes plain
upstream markup renders identically. The changed files are listed in `NOTES.md` §109.

* `context/builders.rs` — `add_checkbox_sized`, `add_toggle_colored`, `add_spinbox_styled`,
  `add_scale_styled`, alongside the upstream builders (which now fill in the old constants).
* `widgets/mod.rs` — the new fields on `WidgetKind::{Checkbox, Toggle, Spinbox, Scale}`, the renderers that read
  them, and the missing `Scale` arms in `WidgetNode::get_property`/`set_property`.
* `widgets/scale.rs`, `widgets/spinbox.rs` — reading the configured colours.
* `src/tests` inside those modules — the new behaviour, next to upstream's own tests.

## Why a copy, and what it costs

A generated project builds offline and has to be a folder that can be handed to someone else, so the crates it
builds against travel with it: the wizard copies these three into the project's `codegen/`, and the generated
`Cargo.toml` redirects the crates.io dependencies with `[patch.crates-io]`. That is also why the **version must
stay `0.2.7`**: a patch only applies to a matching requirement.

The cost is divergence: upstream fixes do not arrive by themselves. The compensation is that every change here
is small, additive and covered by a test in this crate, and that the designer's canvas is checked against this
runtime on the host (see `tests/tools/designer-sim.js`) rather than against a description of it.
