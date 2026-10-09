# Plan: designer-native Circle shape (SHAPES toolbox)

## Context / why
- `Shapes -> Circle` renders as a square because `embedded-gui-codegen` 0.2.7 emits `gui.add_panel(...)` for a
  `circle` tag (verified via `cargo expand`), and `Style::panel()` has `corner_radius: 2` and is always a
  rectangle. There is no `add_circle` in the runtime, so no markup can make the board draw a circle.
- Pivot (per user): stop fighting embedded-ui for shapes. The Circle becomes a **designer-native** tool: it
  lives in the Toolbox, is edited in the settings panel, and the **canvas paints it as a real circle**. The
  board side is deferred to a future "own crate of tools" — for now a native widget is **not emitted to KDL**
  (so the generated project still builds; it simply omits the not-yet-renderable shape).

## Decision summary
- **Tag**: reuse `circle` (already a parser-accepted tag, so the catalogue test `KDL_WIDGETS tags == PARSER_TAGS`
  keeps passing). Replace its spec in `KDL_WIDGETS`.
- **Representation**: the `DesignerWidget` rect (`x,y,w,h`) stays the single source of truth (bounding box,
  square by default). `centre_x`/`centre_y`/`radius` are *derived* from the rect — shown in a Circle-specific
  Geometry form and used for rendering. The remaining four props live in `spec.props` and auto-generate
  editors. This reuses all existing rect-based move/resize/hit logic (no sync layer, no divergence).
- **7 settable fields in the settings panel**: Centre X, Centre Y, Radius (Geometry) + Line colour, Line
  thickness, Fill (bool), Fill colour (Properties, auto-generated from 4 `spec.props`).
- **KDL policy**: a widget with `native: true` is skipped by `emitKdl` (filtered before grid layout to keep
  placements aligned). `layoutDocument` (used only by the canvas/test) still sees all widgets.

## Changes

### 1. `src/designer/catalog.ts`
- `KdlWidgetSpec.draws` union: add `'circle'` (canvas paints an arc; no embedded-gui board equivalent yet).
- `KdlWidgetSpec.native?: boolean` field (true => not emitted to KDL).
- Replace the `circle` entry:
  - `draws: 'circle'`, `native: true`.
  - `note`: "Drawn by the designer as a circle; the board renders this once your own widgets crate provides one."
  - `defaultSize: { width: 64, height: 64 }`.
  - `props` (4, NOT `ignoredByCodegen`): `line_color` (color, `#ffffff`), `line_thickness` (int, 1, min 0, max 32),
    `fill` (bool, true), `fill_color` (color, `#3a6ea5`).
  - Keep `radius` out of `props` (it is geometry, derived from the rect).
- `WIDGET_HELP['circle']`: -> "A circle drawn by the designer".
- `TAG_PROPERTY_HELP`: add `circle.fill` ("Whether the circle is filled"); remove `circle.radius` (orphaned).
- `PROPERTY_HELP`: add `line_color` ("Colour of the circle's outline"), `line_thickness` ("Width of the outline, in pixels"), `fill_color` ("Colour inside the circle") (circle-specific is fine shared-or-tagged; use tag entries to avoid leaking into rect).
  - Note: rect's `fill` (color, ignoredByCodegen) stays; circle's `fill` is a bool -> needs its own tag help.
- `toolboxGroups()` already includes `circle` under `shape`. No change. But the toolbox test
  (`usable = KDL_WIDGETS.filter(unavailable===undefined)`) still counts the circle as offered -> unchanged count.

### 2. `src/designer/model.ts`
- Import `canvasOf`? (state exposes it). Add circle geometry helpers (pure, testable):
  - `circleCentre(widget)` -> `{cx, cy}` = `{ x + floor(w/2), y + floor(h/2) }`.
  - `circleRadius(widget)` -> `Math.min(width, height) / 2` (rounded).
  - `circleRect(cx, cy, r)` -> `{ x: cx-r, y: cy-r, width: 2r, height: 2r }`.
- Extend `draws` type if it is declared here too (it is only in `catalog.ts`). No version bump (additive).

### 3. `webview/designer/theme.ts`
- In `drawWidget`, add `if (draws === 'circle')` branch:
  - `cx = x + width/2`, `cy = y + height/2`, `radius = min(width,height)/2`.
  - `context.beginPath(); context.arc(cx, cy, radius, 0, 2*Math.PI);`
  - if `widget.props.fill` is true -> `fillStyle = props.fill_color ?? palette.themePanel; fill()`.
  - if `line_thickness > 0` and `line_color` set -> `strokeStyle = line_color; lineWidth = line_thickness; stroke()`.
  - Draw the id label as today (inside bounds). Selection handles use the rect (bounding box) — `drawSelection` unchanged.

### 4. `webview/designer/panels.ts`
- In `renderProperties`, call a `circleGeometryForm` when `spec.draws === 'circle'` instead of `geometryForm`.
- `circleGeometryForm(state, widget, callbacks)`:
  - Centre X: `numberInput(cx, 0, canvas.width, v => moveWidget(state, id, v - r, y))`.
  - Centre Y: `numberInput(cy, 0, canvas.height, v => moveWidget(state, id, x, v - r))`.
  - Radius: `numberInput(r, 1, Math.min(canvas)/2, v => resizeWidget(state, id, circleRect(cx, cy, v)))`.
  - Uses `canvasOf(state.document)` for bounds; `circleCentre`/`circleRadius`/`circleRect` from model.
- `propertyForm` already auto-generates the 4 appearance props (int/color/bool kinds are handled). No change.

### 5. `src/designer/kdl.ts`
- In `emitKdl`, filter `native` widgets out before `layoutToGrid` + emission loop (keeps placements aligned).
  - `const emittable = document.widgets.filter((w) => widgetSpec(w.tag)?.native !== true);`
  - lay out `emittable`; loop `emittable`.

### 6. Tests (`tests/layers/t1-logic/designer.test.js`)
- Update `250 shapes that do not paint themselves are marked`:
  - `draws('circle')` -> `'circle'`.
  - remove `circle` from the `['rect','circle','line']` ignored-props loop (now `['rect','line']`); circle props are real (not ignored).
  - circle keeps a `note` (assert separately).
- Update `631 every widget gets an explicit span`: circle is native (omitted) -> swap the `circle` fixture for an emittable widget (`rect`) so the span assertion still has 2 lines.
- Update `998 every property ... has help`: add help for circle's 4 props; `circle.fill` via tag help.
- Update `1013 two properties differ per widget`: drop the `circle.radius` pair (radius is geometry now); keep `scale.mode`, `image.fit`? (only scale/icon/mesh scale asserted). Remove `circle.radius` from `TAG_PROPERTY_HELP`.
- Add new tests:
  - circle geometry helpers (`circleCentre`/`circleRadius`/`circleRect`) round-trip.
  - native circle is omitted by `emitKdl` (a doc with only a circle emits a grid with no widget lines).
  - circle spec defaults: 4 props with expected defaults; `draws === 'circle'`; `native === true`.

## Out of scope (deferred)
- Rectangle, Line, Vector Path SHAPES (replaced later with the same native pattern).
- Board-side rendering of the circle (the "own crate of tools").
- Circle-aware hit-test/resize (reuse the rect bounding box; corner drag can briefly make it non-square, radius = min/2).

## Verification
- `node_modules/.bin/tsc -p ./ --noEmit` (exit 0)
- `node_modules/.bin/tsc -p tsconfig.webview.json` (exit 0)
- `node tests/runner.js` (existing 786 pass + new tests; 0 failures)
- `node scripts/build-webview.mjs` (exit 0)
