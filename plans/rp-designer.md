# The WYSIWYG Designer on the four Raspberry Pi Pico boards

Decided 2026-10-26. This is the plan the implementation follows; it is not user documentation.

## What is being built

The Designer works today on ESP boards only, because a board's panel is a *soldered* fact there
(`board.displays`). A Pico has no panel: somebody wires a TFT module to GPIOs. So the panel becomes a
project fact — a **module** plus the **GPIO numbers it is wired to** — and the Designer gets a panel of
inputs for those numbers.

Modules supported (the same three modules the ESP32-DevKitC option already catalogues, so the colour
order and mirroring facts are the ones verified on real glass):

| id | module | panel | touch | card socket |
|----|--------|-------|-------|-------------|
| `st7789` | Generic 1.54" TFT SPI ST7789 | 240x240 | — | yes |
| `ili9341` | Generic 2.8" TFT SPI ILI9341 | 240x320 | XPT2046 | yes |
| `st7796` | 4-Inch-SPI-TFT-ST7796 | 320x480 | XPT2046 | yes |

## Answers the user gave

1. **SD**: full driver (`embedded-sdmmc`) with an `sd` cargo feature and the toolbar switch, like the CYD.
   The card socket on these modules has **its own SPI pins**, separate from the panel's — "they act like
   a separate SD card socket module". So the wiring carries a second four-pin set, and sharing the panel
   bus stays allowed but is not the default.
2. **Clock**: no Pico has an RTC on the chip, so all four get a **software RTC**.
   - `pico`, `pico2`: set from **the time it was flashed**.
   - `picow`, `pico2w`: **Wi-Fi SNTP** by default, with a switch for a battery-backed RTC module.
   - The battery-backed RTC module itself is a later feature; the setting exists, the option is not
     offered until there is a driver for it.
3. **Templates on Pico**: `designer`, `display` (panel diagnostic) and `sdcard`.
4. **Default wiring** (all editable): panel on SPI0 — SCK 18, MOSI 19, MISO 16, CS 17, DC 20, RST 21,
   BL 22; touch CS 14 / IRQ 15; card on SPI1 — SCK 10, MOSI 11, MISO 12, CS 13.
5. **Docs**: code and tests only.

## How the pins reach the firmware

`src/main.rs` is written once and never rewritten (the rule that keeps a user's own setup/loop code
alive). The pins therefore live in a **generated `src/panel.rs`**, which the Designer rewrites on every
save — the same relationship `ui.rs` already has with `ui.kdl`.

main.rs holds one fixed call:

```rust
let (mut hw, rest) = panel::init(p);     // p is the whole Peripherals
```

`panel` consumes the peripheral tokens it needs and hands back a generated `Rest` struct with the ones
it did not (the CYW43 pins and PIO/DMA on the W boards), so Wi-Fi remains reachable with `main.rs`
untouched. This is why `panel::init` takes `Peripherals` **by value** instead of `&mut Peripherals`: an
exclusive borrow of the whole struct would make the radio unreachable.

## Firmware shape

- One blocking `embassy_rp::spi::Spi` per bus. The panel, its touch controller and (when the card
  shares the bus) the card each get a `critical_section` CS device over it.
- `mipidsi 0.10` + `display-interface-spi` for the panel; the three controllers are stock models.
- XPT2046 hand-rolled over the same `SpiDevice` (no crate exists for it in the registry).
- Backlight on `embassy_rp::pwm::Pwm` — the pin decides slice and channel, so a wrong pin cannot build.
- `embedded-sdmmc 0.8.2` for the card, with the clock controller switching 400 kHz → 12 MHz.
- Every pin is a **typed** peripheral in embassy-rp (`ClkPin<SPI0>`, `ChannelAPin<Slice>`), so a wrong
  GPIO is a compile error. The wiring validator is the friendly version of the same check.

## Files

- `src/boards/panels.ts` — module catalogue, wiring model, defaults, validation (pure).
- `src/generate/rp-panel.ts` — `src/panel.rs` emitter + the RP bring-up text (pure).
- `src/generate/files.ts` — the three templates for `kind: 'rp'`.
- `src/designer/editor.ts`, `protocol.ts`, `webview/designer/*` — the Hardware panel and the gate.
- `designer/panel.hardware.json` — the wiring, beside `designer/panel.ui.json`.

## Verification

- `tsc -p ./`, t1 (model, validation, emitted Rust text), t2 (the form), t3 goldens for
  4 boards x 3 modules.
- Real `cargo build` per board family (thumbv6m and thumbv8m) with each module.
