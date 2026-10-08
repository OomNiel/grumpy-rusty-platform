# Grumpy's Rusty Platform for VS Code

Embedded Rust development for **Raspberry Pi Pico** and **ESP32** boards, with a PlatformIO-style
experience on top of [Embassy](https://embassy.dev), [probe-rs](https://probe.rs) and, for the
Espressif boards, `espflash`.

> Status: **early but usable (v0.0.2)**. Wizard, toolchain installer, Library Manager,
> Build/Flash/Monitor, a real probe-rs debug session with RTT, and the Wi-Fi template flow all work
> on the bench for the Raspberry Pi boards. The ESP32 family can be generated, toolchained, flashed
> and monitored — but it has **no debugging** (no SWD), and its firmware has not been built on
> hardware yet. Windows is untested.

## What works today

| Area | State |
|---|---|
| Project Wizard (board → working workspace) | ✅ 7 boards: Pico · Pico 2 · Pico W · Pico 2 W (RP2040/RP2350) and ESP32-DevKitC V4 · LilyGo T-QT · Sunton ESP32-3248S035R (ESP32/ESP32-S3) |
| Generated workspace: `Cargo.toml`, `.cargo/config.toml`, `memory.x`, `build.rs`, `rust-toolchain.toml`, `src/main.rs`, `.vscode/{settings,launch}.json` | ✅ RP; ESP gets `esp-config.toml` instead of `memory.x`/`launch.json` |
| Templates | ✅ RP: `blinky`, `wifi`, `wifi-bluetooth` (with a credentials prompt) · ESP: periodic task, panel diagnostic screen, panel + touch, TF card, sensors + sound, the everything board test, and `wifi` / `bluetooth` |
| Toolchain detection (cargo, rustup, targets, probe-rs, probe health) | ✅ plus espup / Xtensa toolchain / espflash for ESP; the health check asks only for what the open board actually uses (no debug probe for an ESP32) |
| One-click installer (rustup, targets, prebuilt probe-rs with SHA-256 check, udev rules) | ✅ plus espup + espflash, only for the chips in use |
| `Add Cargo to PATH…` for shells that never received `~/.cargo/bin` | ✅ |
| Status bar, and the same buttons in the side bar's **Controls** section | ✅ |
| **Publish .deb** — the firmware plus a `<package>-flash` helper, packed into a `.deb` in the project root | ✅ |
| **Install .deb** — shows `dpkg-deb --info`, then `sudo dpkg -i` in a terminal | ✅ Linux |
| **Back Up Project** — a dated copy beside the project (`<folder>-2026-10-05_1804`), minus `target/` | ✅ |
| **Open Designer** — a Toolbox, a canvas at the board's real size and rotation, a property panel and undo; writes `designer/panel.ui.json` and the `src/ui.kdl` markup `include_gui!` compiles | ✅ canvas, markup and firmware |
| Debug session (probe-rs-debug + RTT) | ✅ RP only, verified against `probe-rs.probe-rs-debugger` 0.32.0. An ESP32 has no SWD, so **Debug** flashes and monitors instead |
| Four debug configurations, all on the **debug** build | ✅ RP: flash & run · flash & halt · restart without flashing · attach |
| Chip check before a no-flash session (`probe-rs verify`) | ✅ RP only |
| Flash / monitor over USB serial (`espflash`) | ✅ ESP — one-shot write, and a monitor that holds the port on purpose |
| crates.io Library Manager | ✅ curated catalog + live sparse index |
| Layered test suite | ✅ 732 hermetic (t1 707 · t2 21 · t3 4) + opt-in e2e (generated-project builds, and the designer's canvas-to-glass simulator) + 1 hardware HIL |
| Phase 4 guard rails: validate a launch config against the installed debugger | ⬜ |
| Windows support | ⬜ later (installer URLs are already platform-aware) |

## AI coding assist (optional)

Rusty Platform can carry its own coding assistant, so a generated project can be written with help even
with no Copilot and no cloud key. It is **off by default**: nothing is downloaded or started until you turn
it on.

- **Three ways to get a model.** Point it at a server you already run (LM Studio, Ollama, or your own
  `llama-server`) with `rustyPlatform.assistant.backend: "external"`, or let the extension build and run its
  own runtime (`"bundled"`) from `sidecar/` — a small Rust program that links llama.cpp and downloads one
  GGUF into the extension's storage. The bundled runtime needs `cargo`, `cmake`, a C++ compiler and
  `libclang` for its first build, which also compiles llama.cpp.
- **It edits one function at a time, and never behind your back.** `Rusty AI: Implement in Function…` puts a
  `✎ AI` block at the caret; write what you want as comments, then send it (`Ctrl+Alt+Enter`) or discard it
  (`Ctrl+Alt+Escape`). The model's answer arrives as a **diff** of the whole file — apply it or throw it
  away, and applying it is a normal, undoable edit. `rustyPlatform.assistant.showDiff: false` writes it
  straight in when you would rather not review first.
- **The attributes and the signature are not the model's to change.** `#[embassy_executor::main]`, the
  parameter list and the return type are taken from the original function; only the body is the model's.
- **The compiler is the oracle.** `Rusty AI: Fix the Build…` runs `cargo check`, takes the first error,
  rewrites the function it points at, rebuilds, keeps what helped — reverts what did not, skips what nothing
  can fix, and lists the rest. *Fix with the AI assist* also appears as a Quick Fix on compiler diagnostics.
- **It is told what your board actually is.** The prompt carries the board profile (the LED hangs off the
  CYW43 on a Pico W; a Sunton board's panel SPI pins; the crate list from `Cargo.toml`), because a small
  local model otherwise invents pin numbers that the compiler cannot catch.
- **House rules are measured, not guessed.** `Rusty AI: Learn the House Rules from My Code…` counts this
  project's own idioms (indentation, `pub` on helpers, `?` versus `.unwrap()`, `defmt`) and shows the
  evidence; what you keep goes into every prompt.
- The chat and the model settings live in the **AI Assist** view in the sidebar.
- **The chat can be an editor tab, so it can live on a second monitor.** *Rusty AI: Open the Assistant in an
  Editor Tab* (also a button in the AI Assist view) opens the same conversation beside your code; drag that tab
  out of the window and it becomes its own OS window. It comes back where you left it after a reload.
- **Any `.gguf` on Hugging Face, not just the two built-in ones.** *Rusty AI: Add a Model from Hugging Face…*
  lists a repo's files with their sizes and quantisation and says which fit this machine; the model joins the
  list and downloads with a checksum check. Nothing is refused because of one machine's specs — a model that may
  not fit is marked with the arithmetic and you decide.

A machine that cannot run a local model is told so, with the reason, by `Rusty AI: Status and Hardware
Check` — and can override the verdict with `rustyPlatform.assistant.ignoreHostCheck`.

For the step-by-step — turning it on, choosing a model, the `✎ AI` block, reviewing the diff and teaching
it your house rules — see [`AI_ASSIST.md`](AI_ASSIST.md).
## Wi-Fi credentials

The `wifi` and `wifi-bluetooth` templates read the network name and password at **compile time**
(`option_env!`), so they never end up in your source tree — but the build has to have them.

Press **Flash** or **Debug** and the extension asks for them the first time, then remembers them
in VS Code's keyring (never in settings, never in the project):

| Prompt | Notes |
|---|---|
| Network name (SSID) | required |
| Password | masked; leave empty for an open network |
| Fixed IP address | optional, e.g. `192.168.1.50/24`; **blank uses DHCP** |
| Router address | asked only if a fixed address was given |

Every Build / Flash / Debug then compiles with `WIFI_SSID`, `WIFI_PASSWORD` and, when set, the
static pair. The output channel records `wifi: using SSID "my-net" (DHCP)` — never the password.
Cancelling the prompt is allowed: the flash goes ahead, and a warning says the board will keep the
template's placeholder SSID and will not join anything.

* **Rusty Platform: Set Wi-Fi Credentials…** changes the network or adds a fixed address later
  (the fixed address is the way past a router whose DHCP server never answers).
* **Rusty Platform: Clear Wi-Fi Credentials** forgets them.

Building outside the editor still works the documented way:

```sh
WIFI_SSID="my-ssid" WIFI_PASSWORD="secret" cargo run --release
```

Wired boards are never asked: the prompt only appears for a project whose `src/main.rs` reads
`option_env!("WIFI_SSID")`.

## Commands

| Command | What it does |
|---|---|
| New Project | The first row of the **Controls** section: the wizard asks which board (the whole catalog, your default first), then the template, then **how the panel is mounted** when the template drives one, then the name, and writes the workspace. Also an icon in the Boards and Project views' title bars |
| Build for Debug / Build for Release | `cargo build` and `cargo build --release` in a terminal. The Debug *row* was replaced by these two; the **Rusty Platform: Debug** command is still in the palette, and on an ESP board it flashes and follows the log in one terminal |
| Clean | `cargo clean` |
| Publish .deb | Builds for release and packs the firmware artifacts plus a `<package>-flash` helper into `<name>_<version>_<arch>.deb` **in the project root** |
| Install .deb | `dpkg-deb --info`, then `sudo dpkg -i` in a terminal (Linux) |
| Back Up Project | `<folder>-<date>_<time>` beside the project, leaving out `target/` |
| Flash | Builds and writes the image — through the probe (`probe-rs download` + `reset`) for RP, or with `espflash` over USB serial for ESP. Which build it writes follows `rustyPlatform.flashProfile`: `auto` (the default) is **release for ESP** and **debug for RP**. One-shot in both cases: it releases the probe/port when it is done |
| Flash (debug) / Flash (release) | The same flash with the profile chosen for that one flash, overriding the setting. Sidebar only. Debug is the build a probe-rs session can step through, and on a panel it is the slow one; release is fast and small, with hollow breakpoints |
| Flash over USB (BOOTSEL)… | The UF2 route on purpose (recovery, or a board with no probe). On an ESP project it uses `espflash` instead |
| Debug / Stop Debugging | RP: build, flash and start a probe-rs session with RTT. ESP: says there are no breakpoints without JTAG, then flashes and monitors in one terminal |
| Monitor (defmt) | RP: `probe-rs attach` — RTT without reflashing. ESP: `espflash monitor` — the serial log. The Controls row and its tooltip are worded for the board in front of you. Both hold the device until their terminal is closed |
| Open Designer | The WYSIWYG designer for a board with a panel. Also an icon in the Project view's title bar |
| Add Dependency… | crates.io search (bundled catalog + live index); edits `Cargo.toml` |
| Set / Clear Wi-Fi Credentials | See above |
| Check Toolchain / Install Missing Toolchain… | Detection, and the one-click installer |
| Install ESP Toolchain (espup + espflash)… | The Espressif side of the same idea: installs espup, the Xtensa toolchain (only the chips in use) and espflash |
| Add Cargo to PATH… | Writes `~/.cargo/bin` into the login profile when rustup was installed with `--no-modify-path` |
| Install USB Permissions (udev)… / Update Debug Probe Firmware… / Show Connected Probes | Probe housekeeping |

## WYSIWYG designer

The **WYSIWYG designer** template in the wizard generates a project whose screen is a design rather than Rust,
and opens the canvas on it. **Open Designer** — the Project view's title bar, or the palette — reopens the
designer for the active project. Either way it works on a board that carries a panel: the **ESP32-035**
(320x480 with touch) or the **T-QT** (128x128, no touch).

- **Toolbox** — every widget tag the markup supports, grouped into text, input, values and gauges, containers,
  media and 3D, and shapes. Drag one onto the canvas, or click it to drop it in the middle.
- **Canvas** — the board's own panel at the rotation the project is built with, drawn in the board's dark
  palette rather than the editor's theme. Move widgets by dragging, resize them from their eight handles, snap
  them to a neighbour's edge or to the canvas, and reorder them from the layer list. **Right-click a control**
  for Duplicate, Bring forward, Send backward and Delete. **Ctrl+Z** undoes, and one drag is one undo step.
- **Properties** — position and size, every property the tag has, the events it can raise, its option list,
  table body or icon parts, and the layer order. Every field carries a **hover description**, and the Toolbox
  entries describe what each widget is.
- **Fonts** — a Font field lists everything a widget can be given: **five built-in fonts** from the crate
  (Tiny 3x5, the default, through Scaled 6x10 and two scales of the vector face) *and* any BDF font declared on
  the Screen panel (name, file, and which characters to embed). The `…` beside the field declares a new font
  from a file and selects it in one step, so a new face is one action rather than a trip to another list. The
  file is embedded into the firmware at build time, so the character set is worth narrowing: a title that only
  uses digits need not carry the alphabet. Assets are resolved from the project root, which is what the
  generated `project.kdl` anchors, and a file from outside the project is copied into `assets/`.

  Which widgets offer a font is the crate's shape rather than a preference, and the catalogue follows it: the
  built-ins travel as a `style` expression (the markup has no attribute for them) and so reach the widgets that
  honour a style — Label, Button and Carousel — while a *declared* BDF is read for Label and Carousel only. A
  Table is given no Font field at all, because the crate's table arm hard-codes its style and would drop one in
  silence.
- **A created project is loaded** — the folder the wizard writes becomes part of the window whatever the
  notification's answer is, so the Explorer, Source Control and the terminal are already pointing at it. Loading
  a folder can restart the extension host, so a Designer asked for at that moment reopens on the other side.
- **Touch is optional** — asked when the project is made and changeable from the toolbar. With it off there is no
  touch driver, no calibration read and no calibration screen; dropping a control that raises events turns it on
  by itself.

The design is the source of truth and lives in `designer/panel.ui.json`; `src/ui.kdl` is generated from it, and
the crate's `include_gui!` compiles that at build time. The rotation control writes the project's own
`LCD_ROTATION`, so a design and the build it belongs to cannot disagree about the orientation.

### What the canvas will not pretend

The markup's properties do not always reach the pixels, and a designer that hid that would be wrong about the
one thing it exists to show. Measured against `embedded-gui-codegen` 0.2.7:

| Tag | What the board really draws |
|---|---|
| `rect`, `circle` | a theme-styled panel: `fill`, `stroke`, `stroke_width` and `radius` are discarded |
| `line`, `spacer` | nothing at all; the space is reserved and left empty |
| `button` | the background colours are applied and then painted over by a default vertical gradient that no markup attribute can clear, so the visible fill is the theme's |
| `image`, `mesh`, `icon` | nothing until the asset they name is in the project — which the panel reports while you are still designing |

Properties the code generator ignores are shown struck through with the reason, and unresolved assets are
reported as problems rather than left to fail at the next compile.

### How a design reaches the board

`designer/panel.ui.json` is the design and the only thing the panel edits. Saving writes two generated files —
`src/ui.kdl`, which `include_gui!` compiles at build time, and `src/ui.rs`, which holds the budgets, the
pointer plumbing and the `match` that turns an event into a call — and *appends* to a third, `src/ui_handlers.rs`,
where the code behind your events lives. Nothing that exists in that file is ever rewritten, and `src/main.rs`
is untouched after the wizard writes it.

A generated Designer project compiles for both panel boards, and the toolkit costs about **105 KB of flash**
and no measurable extra static RAM against the same board's touch template.

### Status

The canvas, the model, the generated markup and the firmware all compile and are tested; the canvas-to-glass
mapping is verified by a host renderer (`node tests/tools/designer-sim.js`). What has **not** happened yet is a
flash: whether the design appears at the right size and place on glass, and whether a touch lands on the widget
it looks like it should, is the next thing to check on hardware.

## Debugging

Every project ships **four** configurations, all on the **debug** build — a release image is
optimised, so the compiler merges or removes lines and breakpoints there show up hollow. Press
<kbd>F5</kbd> or **Debug** and pick one:

| Configuration | Flashes? | Resets? | Stops when |
|---|---|---|---|
| `Flash & Debug` | yes | yes | at your breakpoints |
| `Flash & Halt at Reset` | yes | yes | on the reset vector, before any of your code |
| `Restart & Debug, no flashing` | **no** | yes | at your breakpoints — anywhere, including `main` |
| `Attach - keeps it running` | **no** | **no** | only in code that runs again (a loop, an interrupt) |

* **Flash and Debug agree on what is on the chip.** On RP, Flash writes the same debug build the debug
  configurations load, so Build → Flash → Debug just works: no prompt, no extra flashing, and
  breakpoints bind. On ESP there is no session to agree with, so `auto` writes **release** — a debug
  build there paints the generated display screen about 130× slower (28 834 ms against 221 ms, measured
  on a CYD). **Flash (debug)** / **Flash (release)** override the choice for one flash, and
  `rustyPlatform.flashProfile` sets the standing answer.
* **A no-flash session is checked first.** Before it starts, the extension reads the chip's flash
  with `probe-rs verify` (~10 s) and compares it with the build the session will use. If they differ
  it offers **Flash & Debug instead** rather than letting breakpoints silently fail to bind. If the
  check cannot be made (probe busy, build missing) the session still starts, and says so.
* **`Attach - keeps it running` cannot stop in code that has already run.** It joins a running
  program, and probe-rs forbids resetting it for an attach session — so breakpoints in `main`, in
  the boot banner or in the Wi-Fi setup look solid in the gutter and never fire. Use it for loops,
  interrupts and timers, and `Restart & Debug, no flashing` when you want startup code.
* **The breakpoint budget belongs to the chip, not the probe:** 8 on RP2350 (Pico 2 / Pico 2 W) and
  4 on RP2040 (Pico / Pico W). Conditional breakpoints and logpoints each take one, stepping needs
  one free, and past the limit the extras stay hollow with "No available hardware breakpoints".
* Halting stops the Wi-Fi and the timers, and defmt output stops with them — expected, not a fault.

Flash does not stream RTT; that is what **Monitor** is for (it holds the probe while its terminal is
open). One debugger at a time: press **Debug Stop** before flashing if a session is running.

### ESP32 boards: no breakpoints

An Xtensa chip has no SWD, so there is no probe-rs session to start and this section does not apply
to it. **Debug** on an ESP project says exactly that, and then does the useful thing instead: it
builds, writes the image with `espflash` and follows the serial log — chained in one terminal, so
the log only starts after a successful write. **Flash** and **Monitor** do the same two halves
separately if you prefer.

Debugging an ESP32 needs JTAG — an ESP-Prog, a USB-JTAG adapter, or a board with built-in JTAG pins
— plus OpenOCD. That is a different workflow from the Pico's and is not wired up here.

Before the first build the extension offers to install espup, the Xtensa toolchain and espflash;
see **Install ESP Toolchain** in the command list. Only the chips your boards need are downloaded.

## Quick start

```sh
npm install
npm run compile          # tsc -> out/
node tests/runner.js     # hermetic suite (t1 + t2 + t3)
```

To exercise the extension itself, open this folder in VS Code and press <kbd>F5</kbd>
(Run Extension Development Host). To drive a real probe-rs DAP session — how the breakpoint
behaviour in `NOTES.md` §24 and §27 was measured — use the repo's own tool:

```sh
npm run dap-session -- --project <dir> --line 92 --line 190
npm run dap-session -- --help
```

## Test layers

```sh
node tests/runner.js                       # t1 + t2 + t3  (fast, hermetic)
node tests/runner.js --layer t1-logic      # one layer
node tests/runner.js --file cargo-toml     # one file (substring match)
node tests/runner.js --e2e                 # + real `cargo build`, and the designer's host renderer
node tests/runner.js --hil                 # + flash real hardware and read defmt over RTT
UPDATE_SNAPSHOTS=1 node tests/runner.js --layer t3-golden   # re-record golden files
```

| Layer | What it proves |
|---|---|
| `t1-logic` | Board matrix (both families), generator, crate/binary naming, parsers, install planner, ESP toolchain plan |
| `t2-cli` | Toolchain detection against fake `cargo`/`rustup`/`probe-rs`/`espup`/`espflash` shims (real processes) |
| `t3-golden` | Byte-for-byte snapshots of generated projects |
| `t4-e2e` | The generated firmware really compiles and links, and the designer's pixel tracks land where the canvas placed them (opt-in, slow, needs network) |
| `t5-hil` | The firmware really flashes and logs over RTT (opt-in, needs a probe) |

## Supported boards

### Raspberry Pi

| Board | MCU | Target triple | probe-rs chip | embassy-rp features |
|---|---|---|---|---|
| Raspberry Pi Pico | RP2040 | `thumbv6m-none-eabi` | `RP2040` | `rp2040` |
| Raspberry Pi Pico 2 | RP2350 | `thumbv8m.main-none-eabihf` | `RP235x` | `rp235xa`, `binary-info` |

RP2350's RISC-V mode (`riscv32imac-unknown-none-elf`, chip `RP235x_riscv`) is deliberately
deferred.

### Espressif

| Board | MCU | Target triple | `espflash` chip | Flash | Panel / extras |
|---|---|---|---|---|---|
| Espressif ESP32-DevKitC V4 | ESP32-WROOM-32 | `xtensa-esp32-none-elf` | `esp32` | 4 MB | no user LED on the board |
| LilyGo T-QT | ESP32-S3 | `xtensa-esp32s3-none-elf` | `esp32s3` | 4 MB | 0.85" 128×128 panel — **two revisions** (GC9107 / GC9A01), asked at project creation |
| Sunton ESP32-3248S035R (3.5" CYD) | ESP32 | `xtensa-esp32-none-elf` | `esp32` | 4 MB | 320×480 ST7796, XPT2046 resistive touch, microSD socket |

ESP projects are built with esp-hal and esp-rtos and flashed with `espflash`; they have no
`memory.x`, no UF2 image and no CYW43. The panel, the XPT2046 touch controller and the TF card each
have a template that drives them. Wi-Fi is esp-radio with embassy-net on top: the radio joins the
access point, and the network stack owns the address (DHCP, or a fixed one from `WIFI_STATIC_IP`).
Bluetooth LE is esp-radio's controller driven by the `trouble-host` host stack, which is where
advertising and GATT live — a controller alone only moves bytes.

The ESP **panel diagnostic screen** is meant to be read off the display: a full-panel frame, four
corner markers (red top-left, green top-right, blue bottom-left, white bottom-right), five colour bars
named left to right, a centred cross, `"Hello Grumpy!"` and a line of status text — plus one small
square that blinks while the loop runs. Cropping, a shifted active area, a swapped colour order and a
rotated image each look like success on a flat colour fill and are obvious here. Generated `display`
projects have been built and flashed to the Sunton ESP32-3248S035R; the DevKitC and T-QT templates
have not been flashed yet (see `NOTES.md` in the repository).

The `wifi` and `bluetooth` projects have been compiled *and linked* for both the classic ESP32 and
the ESP32-S3, and the generated ESP32 Bluetooth project carries a linker workaround for three ROM
symbols missing from a published crate (see `NOTES.md`).

**Both templates are verified on hardware** (CYD/ESP32-035, 2026-10-06).

- *Wi-Fi*: association, the DHCP lease and the logged address, a fixed address from `WIFI_STATIC_IP`,
  recovery across a reset and an access-point power cycle, and the extension's credential prompt writing and
  reusing the keyring entry.
- *Bluetooth*: advertising as `Rusty-Platform` (the name really is in the advertisement payload, since a BLE
  scanner lists it), a completed connection, the GATT notification stream at ~2 s with plausible RSSI, a
  connection held for ~3.4 minutes, the disconnect reason reported in the stack's own words, and the return
  to advertising afterwards.

The GATT **read** and **write** paths, and a second central against `CONNECTIONS_MAX = 1`, have since been
exercised on the phone and behaved as intended.

One rough edge was found by that testing and has been fixed: a *read* of the battery-level characteristic
used to return its stored value while the notifications carried the counter, so the two disagreed. The
counter is now written into the characteristic before it is announced, and a failed write is logged rather
than passed over. Confirmed on hardware: a read now returns the counter the notifications carry.

A practical warning from that testing: a **phone's Bluetooth settings screen is not a BLE scanner** (the
advertisement is BLE-only, and those screens usually hide BLE peripherals), and the extension's Flash output
is not the board's log — the firmware only prints while the serial monitor is attached, and the Bluetooth
template is silent while advertising unless something connects.

### Turning the panel

Every panel project is generated with a rotation: **0** (no rotation, the default), **1** (90°
clockwise), **2** (180°) or **3** (270°). It is asked when the project is created and can be changed
afterwards with the `rustyPlatform.lcdRotation` setting, which is written into the project's
`.vscode/settings.json` and kept in step with `LCD_ROTATION` in `.cargo/esp-config.toml` — the line the
firmware actually reads, at **compile time**.

That indirection is the point: **`src/main.rs` is yours from the moment it is generated.** It is
written once by the wizard and never regenerated (the only way to lose it is to run *New Project* into
the same folder again and confirm the overwrite), so adding your own code to it is the expected
workflow. The rotation therefore lives in a config file, and the firmware logs the value it was built
with (`panel rotation setting: 1`) so a build can be checked from the serial log.

The rotation turns the interface **and the drawing area with it**: the generated screens are solved for the
shape the display driver is actually addressing, so a landscape rotation gives a landscape layout — frame, bars,
corner markers, status lines and touch targets — and a portrait rotation gives a portrait one. **Verified on
hardware at 270°**: every edge, corner and bar visible with nothing clipped, the `touch` and `board` screens
laid out for the landscaped area with touch landing where it is pressed, and the recalibration gesture working.

One subtlety is worth recording, because getting it wrong cost a release: the size handed to the driver is the
panel's **native** size, and mipidsi swaps the area it draws into for 90°/270° itself. It also computes its
clipping offset from that same passed-in size (`FRAMEBUFFER_SIZE - display_size`), so passing the *rotated* size
makes that subtraction underflow on the enlarged axis — with the mirroring this panel needs, that produced a
garbage address window and the panel stayed white (0.0.41, reverted in 0.0.42).

The touch calibration is versioned by rotation: a record measured in one orientation is discarded when the
rotation changes, with a log line saying which orientations disagree, instead of mapping every touch to a
plausible, wrong place. Changing the rotation therefore never needs anything erased.

To recalibrate **by hand** — after moving the panel, or because the mapping has drifted — touch the glass within
the first two seconds of a reset. The stored calibration is discarded, the confirmation tone sounds, the LED
returns to red (which means uncalibrated) and the corner screen comes back. Without that gesture the record
could only ever be replaced by completing a fresh calibration, never dropped.

## Documentation

Developer notes, verified version pins and hard-won traps live in `NOTES.md` in the project
repository. It is deliberately not shipped inside the extension package.

User-visible changes are recorded in [`CHANGELOG.md`](CHANGELOG.md), which *is* shipped, so VS Code
shows it in the extension's **Changelog** tab.

## License

Dual **MIT OR Apache-2.0**, the Rust ecosystem norm — see [`LICENSE`](LICENSE) for the choice,
with the full texts in [`LICENSE-MIT`](LICENSE-MIT) and [`LICENSE-APACHE`](LICENSE-APACHE).
