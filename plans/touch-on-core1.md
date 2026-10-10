# Plan: the touch sampling on the second core

**Status: deferred by the user, 2026-10-09** — "*Note the option to move touch to core1. We will get to it
later.*" Nothing below is implemented; this file is the record of what was worked out so the work can be picked
up without re-deriving it.

## Context / why

Every board this platform generates for is **dual core** and the firmware uses **one core**:

* **ESP32 / ESP32-S3** — the prologue in `src/generate/esp.ts` (`espBootBlock`) is `#[esp_rtos::main]` plus
  `esp_rtos::start(timg0.timer0, peripherals.FROM_CPU_INTR0)`. esp-rtos 0.4.0 pins that context to the first
  core, logs "Starting scheduler for the first core" and asserts `Cpu::current() == Cpu::ProCpu`
  (`esp-rtos-0.4.0/src/lib.rs:375-405`). The second core only runs if `esp_rtos::start_second_core(...)` is
  called (`src/lib.rs:452`), and nothing calls it.
* **RP2040 / RP2350** — `#[embassy_executor::main(executor = "embassy_rp::executor::Executor", …)]`, which is
  core 0. Core 1 needs `embassy_rp::multicore::spawn_core1(...)`, which appears nowhere.

So core 1 (`AppCpu`) sits in the boot ROM while core 0 runs the panel, the touch sampling, the GUI, the card
reader and the radio glue.

**What it would and would not buy.** Measured in §113 and §116, the time in this firmware goes to *single-bus
I/O*: the card read (about a second for a 3 MB photo at 10 MHz, on SPI3) and the panel writes (SPI2). One SPI
bus cannot be split across cores, so a second core makes no frame draw faster. What it buys is **responsiveness
during a long draw**: the touch sampling loop and the Wi-Fi/Bluetooth glue share core 0 with the drawing task, so
a full-frame repaint stalls the finger. 0.0.74 removed the per-touch card re-read, so the remaining stall is a
full repaint only (`ui::Designer::repaint`, or the first frame).

## Decision summary

* **Move the touch sampling to core 1; keep the GUI and every draw on core 0.** The drawing task stays the only
  owner of the display, which is what the engine's damage tracking assumes.
* **ESP first** (the CYD, `sunton-3248s035r`), because that is the board the user tests on; the RP variant is the
  same shape and can follow.
* The sampling task publishes samples into a small `Signal`/`Mutex` that the main loop drains — it must **not**
  call into the GUI (the engine is not `Sync`, and its damage state is per-core state in practice).

## What has to change (ESP)

1. **A stack and the second-core start** in `espBootBlock`:

   ```rust
   use static_cell::ConstStaticCell;
   use esp_hal::system::Stack;

   static CORE1_STACK: ConstStaticCell<Stack<8192>> = ConstStaticCell::new(Stack::new());
   esp_rtos::start_second_core(
       peripherals.CPU_CTRL,
       peripherals.FROM_CPU_INTR1,
       CORE1_STACK.take(),
       || { /* the second core's main function */ },
   );
   ```

   `Stack<8192>` is esp-rtos's own example size; the DRAM cost is real on the classic ESP32 (no PSRAM, 128 KiB
   in the DRAM linker segment, already carrying the Wi-Fi heap when the wifi template is used).

2. **Sharing the panel/touch bus across cores.** The generator's touch code puts the panel's `Spi` in a `RefCell`
   and hands the touch a `RefCellDevice` (`src/generate/esp.ts`, the panel/touch section; the bus is re-clocked to
   1 MHz around each touch burst and put back afterwards). `RefCell` is not `Sync`, so the same bus from two cores
   needs `embedded_hal_bus::spi::CriticalSectionDevice` (or the `atomic`/`mutex` device variants —
   `embedded-hal-bus 0.3.0` is already a dependency, and its `critical_section` module is written for exactly
   this). The re-clock dance must stay *inside* the same lock as the burst it belongs to.

3. **The touch task** — the sampling loop, the idle baseline, and the "a touch this soon after boot means
   recalibrate" rule all move together. Calibration draws to the panel, so it has to hand the frame to core 0
   rather than painting from core 1.

4. **The SD mount is already cross-core-safe**: `src/sd.rs` keeps it in a `critical_section::Mutex<RefCell<…>>`
   and `with_file` runs inside one critical section, so it needs no change if the card is ever touched from core
   1 — worth knowing, not needed for this step.

## Verification

* **Suite**: `node tests/runner.js` (the t3 golden snapshots for the ESP designer template will need re-recording
  with `UPDATE_SNAPSHOTS=1`, since `main.rs` changes).
* **Chip**: the recipe used for §111/§113 — a project generated into `tests/tmp/sd-project`, then
  `source ~/export-esp.sh` and
  `CARGO_HOME=$PWD/tests/tmp/cargo-home CARGO_TARGET_DIR=$PWD/tests/out/sd-project cargo check --offline --target xtensa-esp32-none-elf`.
* **Hardware** (the only real proof): the CYD on `/dev/ttyUSB0`, rotation 3. Put a 3 MB photo on the card, force a
  full repaint (first frame, or a screen switch), and tap the button while it draws: the tap must land, and the
  serial log must not show the touch sampling stalled. Before the change the finger is dead for about a second.

## Risks to weigh before starting

* The second stack's DRAM, especially in the `wifi`/`bluetooth` templates where the radio heap is already tens of
  kilobytes.
* `Send` bounds on anything that crosses: esp-hal peripherals are owned and not `Sync`, which is why the bus has
  to go behind a device that takes a critical section.
* Two cores touching the panel is the failure mode to avoid entirely — the constraint is "core 1 samples, core 0
  draws", not "either may draw".
* If the sampling moves, the *touch controller's* IRQ (`GPIO36`) and the calibrated thresholds belong to core 1,
  while anything the GUI needs (press/release edges) has to be queued for core 0.
