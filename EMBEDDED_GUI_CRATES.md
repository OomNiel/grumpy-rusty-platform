# Crates that can draw Buttons (etc.) on this LCD

This project targets the **ESP32-035 LCD Panel**: a 3.5" **ST7796** TFT,
320×480, driven over SPI through `mipidsi` (the MIPI-CSI display driver) and
painted with `embedded-graphics` 0.8 primitives. The question asked: are there
any crates that can draw **buttons and other widgets** on this display instead
of hand-rolling every rectangle and text glyph?

Short answer: **yes**. Below are the options that fit an `embedded-graphics`
0.8 / `esp-hal` / `embassy` stack, ranked by how directly useful they are here.

---

## Your existing stack (relevant bits from `Cargo.toml`)

| Layer | Crate | Version |
|---|---|---|
| Chip / HAL | `esp-hal` (esp32) | ~1.2.2 |
| Async runtime | `esp-rtos` / `embassy-executor` / `embassy-time` | 0.4 / 0.10 / 0.5 |
| Display driver | `mipidsi` (ST7796) | 0.10.0 |
| Drawing primitives | `embedded-graphics` | 0.8 |
| SPI device glue | `embedded-hal-bus` | 0.3.0 |

Because `mipidsi`'s `Display` implements the `embedded-graphics` `DrawTarget`
trait, **any** crate that produces `embedded-graphics` primitives (or draws via
that trait) can render onto your screen. That opens up the whole
`embedded-graphics` ecosystem to you.

---

## Option 1 — `embedded-gui` (recommended pure-Rust choice)

- **Crate:** [`embedded-gui`](https://crates.io/crates/embedded-gui) 0.2.7 ([`leftger/embedded-gui`](https://github.com/leftger/embedded-gui))
- **Tagline:** "no_std GUI and HUD primitives for embedded-graphics displays."
- **Widgets shipped:**
  - **Buttons** (`ButtonWidget` / `IconButton` / `WidgetKind::Button`),
  - **Sliders** (`SliderWidget`),
  - **Toggles** (`ToggleWidget`), **Checkboxes** (`CheckboxWidget`),
  - plus gauges, meters, spinboxes, progress bars, status bars, tables, an
    on-screen keyboard, charts/plotter, notification sheets, timelines, etc.
- **Why it fits this project:**
  - `no_std` + **zero allocation** (storage via `heapless`) — good for the
    ESP32's modest RAM.
  - Targets **`embedded-graphics` 0.8**, exactly what you already use.
  - Has an **`embassy`** feature flag that pulls in `embassy-sync` +
    `embassy-time` — directly matches your `embassy-time` 0.5 runtime.
  - Built-in **layout engine** (CSS-style grid/flex), a **dirty-rect
    buffered renderer** (excellent for slow SPI like your 24 MHz link), and an
    optional **KDL markup → Rust codegen** build-time DSL.
- **How to add it:**
  ```toml
  embedded-gui = { version = "0.2", default-features = false, features = [
      "rich_widgets",        # Button / Slider / Toggle / Checkbox / …
      "embedded-graphics",   # hooks into your existing eg 0.8
      "embassy",             # async integration with your embassy runtime
  ] }
  ```
  > Note: its `default` feature set includes `std`, so you **must** set
  > `default-features = false` on a `no_std` MCU build.
- **Caveat:** it is actively developed and impressive, but **young** (≈580 total
  downloads, v0.2.x). API surface is large and still settling. Best for a
  "let's try the pure-Rust widget toolkit" approach; see Option 2 for the
  more proven path.

---

## Option 2 — LVGL via Rust bindings (most proven on ESP32)

- **Crate:** [`lvgl`](https://crates.io/crates/lvgl) 0.6 (full feature set,
  links the C library) or [`oxivgl`](https://crates.io/crates/oxivgl) 0.9
  (a `no_std`-friendly, more Rust-idiomatic spin on the same).
- **Widgets:** buttons, sliders, switches, checkboxes, dropdowns, keyboards,
  lists, charts, everything LVGL has — i.e. a complete embedded GUI.
- **Pros:** battle-tested on ESP32 (LVGL is *the* standard embedded GUI); lots
  of community examples; rich styling/theming.
- **Cons:** pulls in the **C library** (heavier ROM/RAM footprint), requires
  the LVGL C sources in your build, and FFI marshalling. `oxivgl` is the
  lighter/no_std-friendly variant if you go this route.

---

## Option 3 — `qingui` (LVGL-inspired, very new)

- **Crate:** [`qingui`](https://crates.io/crates/qingui) 0.2.0
- **Tagline:** "A lightweight embedded GUI library (LVGL-inspired subset):
  PFB rendering, dirty rects, animation, keypad input."
- **Status:** only ≈63 downloads — effectively experimental. Mentioned for
  completeness; not recommended over Options 1 or 2 yet.

---

## Option 4 — Hand-rolled widget helpers on `embedded-graphics` (this project's choice)

You don't strictly need a widget crate. `embedded-graphics` already gives you
`Rectangle`, `PrimitiveStyle::with_fill`/`with_stroke`, and `Text`. A "button"
is just a filled rectangle, a stroked frame, and centered text — a handful of
primitives you can wrap in a one-line helper.

This repo's `src/ui.rs` now provides exactly that: a `draw_button` helper that
draws a bordered button with a centered label, rendered on top of the
existing diagnostic screen. It's zero-dependency (uses only what you already
have), trivially testable, and a clean place to bolt on touch handling later
once the XPT2046 touch driver is wired up (see the README "Notes" section).

---

## Recommendation

| Goal | Pick |
|---|---|
| Stay pure-Rust, idiomatic with `embedded-graphics` 0.8, try a real widget crate | **`embedded-gui`** |
| Most proven / full-featured, OK linking the C LVGL library | **`lvgl`** or **`oxivgl`** |
| Keep it tiny, zero new dependencies, ship now | **hand-rolled** (`src/ui.rs`) |

This project currently ships the hand-rolled path. Swapping in
`embedded-gui` later is a clean, localized change since the display is already
an `embedded-graphics` `DrawTarget`.
