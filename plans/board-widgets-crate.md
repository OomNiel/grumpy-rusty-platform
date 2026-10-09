# Plan: board-side shapes (the "own crate of tools")

## Overview
The designer-native Circle renders on the canvas but is dropped from `src/ui.kdl`
(`emitKdl` skips `native` widgets), so the board never sees it. To make shapes
render on glass — Circle *and* the Rectangle/Line/Vector-Path you'll add after —
we build the missing link that `embedded-gui 0.2.7` lacks: a tiny no_std
`CustomWidget` crate plus a forked codegen that actually instantiates the crate's
primitives instead of stubbing them to `add_panel`.

Key facts that make this bounded:
- `embedded-gui-codegen 0.2.7` **already parses** `circle`/`rect`/`line`/`vector_path`
  (parser.rs `parse_widget`, ~line 731) into `WidgetDef::CircleShape/..` with attrs
  `radius`, `stroke_width`, `fill`, `stroke`, `color`.
- Its **emitter** stubs all four to `gui.add_panel(.., Style::panel())?;` (emitter.rs
  ~line 548 circle / 530 rect / 538 line / 514 path). That is the only thing making
  them render as squares/bars.
- `embedded-gui 0.2.7` exposes a **public, ungated** extension point:
  `GuiContext::add_custom_widget(&mut self, rect, &dyn CustomWidget, style)` and the
  `CustomWidget` trait whose `render` is handed a `CustomCanvas` with
  `fill_rect`/`draw_rect`/`draw_line`/`draw_pixel`/`fill_rounded_rect`/`draw_text`
  (no `draw_circle` → circle via a mid-point `draw_pixel` loop). The generated project
  already turns on `rich-widgets`, so the trait is available on no_std.
- The designer already treats the rect as the source of truth (`circleCentre`/
  `circleRadius`/`circleRect`). The board side will **derive** centre+radius from the
  grid cell `rect` the engine lays out — so canvas and glass can never disagree.

Approach: vendor (do **not** publish to crates.io yet) a `rusty-gui-widgets`
no_std crate and an `embedded-gui-codegen` fork into the generated project, wiring
them through `[patch.crates-io]`. Shapes move from `native: true` (canvas-only,
emitted as nothing) to `draws`-driven real KDL nodes whose props the fork reads.

## Implementation approach
1. **New crate `rusty-gui-widgets`** (`crates/rusty-gui-widgets/`, `#![no_std]`, dep
   `embedded-gui = "0.2.7"`). `lib.rs` implements `CustomWidget` for `Circle`,
   `Rectangle`, `Line`, `VectorPath`. The struct fields are exactly what the
   fork passes from the parsed `WidgetDef` (const-constructible so the codegen can
   `static`-them):
   ```rust
   pub struct Circle { pub stroke_width: u8, pub fill: Option<Rgb565>, pub stroke: Option<Rgb565> }
   impl CustomWidget for Circle {
       fn render(&self, canvas: &mut dyn CustomCanvas, rect: Rect, _s, _st) -> Result<(), GuiError> {
           // CustomCanvas has no draw_circle: derive centre+radius from the cell `rect`
           // (floor(min(w,h)/2), matching the designer), fill with horizontal draw_line
           // scanlines, stroke with a mid-point draw_pixel ring at `radius - sw`.
           Ok(())
       }
   }
   ```
   `Rectangle`→`fill_rect`/`draw_rect`, `Line`→`draw_line` (rect's corners),
   `VectorPath`→replay `PathVerb`s via `draw_line` (`VectorPath`/`PathVerb`/`Point`
   already exist in embedded-gui and are what the codegen names for the path arm).

2. **Fork `embedded-gui-codegen`** (`crates/embedded-gui-codegen/`, verbatim 0.2.7
   source + 4 edit arms in `emitter.rs`). Replace the stub arms with
   `add_custom_widget` calls that build the right struct from the parsed
   `WidgetDef` colours using the existing `rgb565_expr` helper.

   **Lifetime detail (found while building):** `add_custom_widget` stores a
   `&'a dyn CustomWidget` that must outlive the gui, so an inline
   `&Circle{..}` temporary would not compile. Shapes are *const-constructible*
   though (`Rgb565::new` is `const fn`, all fields are `u8`/`Option<Rgb565>`), and
   the codegen already emits `static` + `Rgb565::new` inside `include_gui!`
   expansions for icons — so emit a function-local `static` per shape and borrow
   it (the icon arm in `emitter.rs` is the exact template to copy). `Rgb565` and
   `Style` are already in scope inside `mod design` for that same reason.

   Circle arm:
   ```rust
   WidgetDef::CircleShape { stroke_width, fill_color, stroke_color, .. } => {
       let fill = fill_color.as_ref().map(|c| rgb565_expr(c)).unwrap_or_else(|| "None".to_string());
       let stroke = stroke_color.as_ref().map(|c| rgb565_expr(c)).unwrap_or_else(|| "None".to_string());
       writeln!(&out,
           "        static __shape_{v}: rusty_gui_widgets::Circle = rusty_gui_widgets::Circle {{ stroke_width: {sw}, fill: {fill}, stroke: {stroke} }};\n\
            let {v} = gui.add_custom_widget(cells[{i}], &__shape_{v}, Style::default())?;",
           v = var_name, i = idx, sw = stroke_width, fill = fill, stroke = stroke)?;
   }
   ```
   `Style::default()` is used (the shape's look is carried by its own
   fill/stroke, not the panel style); fall back to `Style::panel()` if the
   generated code doesn't accept `Default` for `Style`. Mirror the arm for
   `RectShape`/`LineShape`/`VectorPath`, mapping each to the matching
   `rusty_gui_widgets` struct. Keep `native`/`draws` handling out of codegen —
   the fork only changes *emitted Rust for the four shape `WidgetDef`s*. Do **not**
   emit the parsed `radius`; the widget derives geometry from the cell rect,
   matching the designer.

3. **Generate the project with the fork + crate vendored.** In `src/generate/esp.ts`
   (designer template), append to the generated `Cargo.toml`:
   ```toml
   [dependencies]
   rusty-gui-widgets = { path = "codegen/rusty-gui-widgets" }
   [patch.crates-io]
   embedded-gui-codegen = { path = "codegen/embedded-gui-codegen" }
   ```
   …and have the wizard copy `crates/rusty-gui-widgets/` → `<project>/codegen/`
   and the fork → `<project>/codegen/embedded-gui-codegen/`. (Vendoring keeps the
   generated project building offline and self-contained; publishing to crates.io
   later shrinks it.)

4. **Designer emits real shape KDL.** In `src/designer/kdl.ts`, remove
   `native: true` from the `circle` entry in `catalog.ts` (keep `draws: 'circle'`
   for the canvas paint + Geometry form), and specialise `widgetLine` so a
   `draws === 'circle'` widget emits the codegen-understood attributes mapped from
   the designer props (geometry stays in the grid placement):
   ```ts
   // in widgetLine, for circle:
   parts.push(`stroke_width=${literal(widget.props.line_thickness)}`);
   if (widget.props.fill === true) { parts.push(`fill=${literal(widget.props.fill_color)}`); }
   if (widget.props.line_color) { parts.push(`stroke=${literal(widget.props.line_color)}`); }
   // radius omitted: board derives from the cell rect
   ```
   Repeat the mapping for `rectangle`/`line`/`vector_path` as those tags are added.

5. **Sim wiring (the proof, host-side).** `tests/sim/Cargo.toml` gets the same
   `[patch.crates-io]` + `rusty-gui-widgets` path dep (pointing at the repo's
   `crates/`). `tests/sim/src/ui.kdl` and `expectations.rs` are regenerated by
   `tests/tools/designer-sim.js` (fixture already has `id="knob" tag="circle"`)
   so the circle now appears in the KDL and the expectations add an
   `absolute_rect(knob)` + a pixel probe inside the inscribed circle. `cargo build`
   the sim → the fork's `add_custom_widget` runs through the real `include_gui!`
   and the `Circle` compiles against `embedded-gui`'s `CustomCanvas`.

6. **t1 tests.** `emitKdl` now emits a `circle` node with `stroke_width`/`fill`/
   `stroke` + grid placement; the "native widget omitted from markup" test flips to
   asserting the circle is **present** (and a still-native sentinel, if any, is not).

## Testing strategy
Run `node tests/tools/designer-sim.js` so `tests/sim` recompiles the emitted KDL
through the real `include_gui!` with the forked codegen; assert the sim prints
`PASS` (track layout matches + the knob cell paints a non-background colour on its
arc pixels). Add a `rusty-gui-widgets` lib unit test that draws a `Circle` into a
`no_std`-free mock `CustomCanvas` and asserts `draw_pixel` was called at the
mid-point-circle coordinates. Regenerate the t3-golden snapshots for the new
generated `Cargo.toml` (`[patch.crates-io]` + vendored crate), and re-run
`node tests/runner.js` (t1 emitKdl assertions + the existing t2 canvas arc test).
The vsix rebuild (`npm run compile && vsce package --out mytest.vsix`) is unchanged
in shape but now ships a project that renders the circle on glass.
