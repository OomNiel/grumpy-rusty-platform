# Changelog

All notable changes to **Grumpy's Rusty Platform for VS Code** are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version number matches
`package.json`; until the extension reaches the Marketplace it is installed from the packaged
`.vsix`.

## [Unreleased]

### Added

**AI coding assist (optional, off by default)**

- **A model-agnostic core** (`src/ai/assistant.ts`): an OpenAI-compatible chat client over `fetch` with SSE
  streaming, an inactivity watchdog (a slow CPU model is not cut off while it is still writing), token
  budgeting, and defensive answer parsing. No npm dependency was added.
- **Editor flows that never write behind your back**: a `✎ AI` prompt block at the caret, "implement in the
  function I am in" (or a brand-new function when the caret is outside one), a whole-file proposal **diff**
  that is applied as a normal undoable edit, and `Rusty AI: Fix the Build…` — the designer's build-driven
  repair loop with `cargo check` as the oracle.
- **Rust-specific safety** (`src/ai/rustCode.ts`): brace matching that understands Rust trivia (strings,
  raw strings, char literals and lifetimes), function/impl spans, insertion that snaps to the caret and never
  escapes the enclosing item, and **signature/attribute preservation** — `#[embassy_executor::main]`, the
  parameter list and the return type survive whatever the model does to them.
- **Grounded prompts**: the board profile (LED kind, CYW43 wiring, panel SPI pins, flash/PSRAM), the
  `Cargo.toml` crate list, the file header and one sibling function are handed to the model, so it is told
  what the hardware is instead of guessing.
- **House rules that are measured, not guessed** (`src/ai/conventions.ts`): indentation, `pub` on helpers,
  `?` versus `.unwrap()`, `defmt` logging, doc comments, constant/type naming and `#[cfg(test)]` modules —
  each with its sample count, accepted by the user, and put in every prompt.
- **Three ways to a model**, as in the designer: an external OpenAI-compatible server, LM Studio via `lms`,
  or the extension's own runtime. Downloads from Hugging Face are verified against the published SHA-256.
- **A Rust sidecar** (`sidecar/`) replacing the designer's .NET `ModelHost`: `llama-cpp-2` + `axum`, built
  with `cargo build --release` on the user's machine, speaking the same `/health`, `/v1/models` and
  `/v1/chat/completions` subset, with the native backend chosen by a cargo feature (`cpu` by default).
- **An AI Assist view** in the sidebar: a streaming chat with the active file as context, plus the model
  and backend settings.
- New commands under the **Rusty AI** category, two keybindings (`Ctrl+Alt+Enter` / `Ctrl+Alt+Escape`), and
  the `rustyPlatform.assistant.*` settings.

## [0.0.2] - 2026-10-03

A second silicon family, without pretending it is the same as the first. Packaged as
`grumpy-rusty-platform-0.0.2.vsix` (63 files). Its SHA-256 belongs with the release notes on
GitHub, not here: `vsce` writes fresh ZIP metadata on every run, so two builds of the same
sources differ in bytes and a hash recorded in this file could never match the artifact that
ships it.

### Added

**Espressif (ESP32) support**

- Three boards, with every pin taken from a primary source (the vendor's scaffolding, the board's
  schematic or the community board definition) rather than from memory:
  - **Espressif ESP32-DevKitC V4** — ESP32-WROOM-32, 4 MB, USB-UART. Espressif's own user guide
    lists no user LED on this board, so the template drives an *offered* pin (GPIO4) and says so
    instead of claiming a built-in LED.
  - **LilyGo T-QT** — ESP32-S3, 4 MB QD flash, 0.85" 128×128 panel. LilyGo shipped two panel
    revisions under one name, so the wizard asks which one you have and the answer becomes a cargo
    feature (`panel-gc9107` / `panel-gc9a01`) that can be flipped without regenerating anything.
  - **Sunton ESP32-3248S035R** (3.5" CYD) — ESP32, ST7796 320×480, XPT2046 resistive touch and a
    microSD socket.
- An ESP generator that shares nothing with the RP one: `Cargo.toml` (esp-hal `~1.2.2`, esp-rtos
  0.4, esp-bootloader-esp-idf, esp-println, esp-backtrace; edition 2024, rust-version 1.95),
  `.cargo/config.toml` with the `espflash` runner and `build-std`, `.cargo/esp-config.toml`,
  `rust-toolchain.toml` on espup's `esp` channel, and a `build.rs` that turns a missing Xtensa
  linker into the command that installs it. No `memory.x`, no UF2, no CYW43 — those stay Raspberry
  Pi concerns.
- Templates `blinky` (periodic task) and `display` (panel bring-up plus colour bars), the latter the
  default for a board with a panel.
- **Guided toolchain install.** Creating an ESP project checks for `espup`, the Xtensa toolchain,
  `~/export-esp.sh` and `espflash`, then offers to install what is missing — and only for the chips
  your boards need. `export-esp.sh` is applied to every build, flash and monitor the extension
  runs, so a shell that never sourced it can still link Xtensa. Also available as
  **Install ESP Toolchain…** in the palette.
- **Flash and Monitor over USB serial** with `espflash`: a one-shot write that releases the port,
  and a monitor that holds it on purpose. The port is chosen from `/dev/serial/by-id` by name *and*
  USB vendor id, and Raspberry Pi boards are refused outright.
- **Debug** on an ESP board explains that Xtensa needs JTAG for breakpoints, and runs flash +
  monitor chained in one terminal instead.

### Changed

- `BoardProfile` is now a discriminated RP/ESP union, so the compiler — not a comment — is what
  stops a Pico assumption from leaking into an ESP project.
- The rustup-based install plan covers the RP targets only: the Xtensa triples come from espup and
  `rustup target add` cannot install them.
- `Check Toolchain` reports the ESP toolchain, deliberately never as a *problem* for a setup that
  only builds for Raspberry Pi.
- New settings: `rustyPlatform.espflashPath` and `rustyPlatform.serialPort`.

### Fixed

- The generated ESP firmware had three defects that only reading the generated files could find:
  `Output::new` was called with two arguments (esp-hal 1.2 takes three), the display template used
  `SPIInterface` without importing it, and a board whose name contains a quote
  (`Sunton … (3.5" CYD)`) produced Rust that could not compile.
- `rustyPlatform.defaultBoard` did not list the new boards, so the wizard could not pre-select them.

### Tests

370 hermetic checks (t1 345 · t2 21 · t3 4). The RP-only invariants are now explicitly scoped to RP
boards — which is how the two silent holes in the UF2 path were found — and the ESP side adds 28
board/generator assertions, 12 toolchain-plan assertions, 8 flash-command and serial-port
assertions, 5 process-level detection tests against new `espup`/`espflash` shims, and 45 recorded
golden files (45 of the suite's 131).

### Known gaps

- The ESP firmware has **not been compiled or flashed yet**: it is verified against the vendor's
  scaffolding and the crates' published APIs, and the flags are verified against `espflash`'s
  source, but the first real build is still to come.
- There is no `wifi` template for ESP yet, so the wizard offers only the two implemented templates
  rather than generating a project that would compile into nothing.

## [0.0.1] - 2026-10-03

First build: everything the extension does today, packaged as `grumpy-rusty-platform-0.0.1.vsix`.

### Added

**Project creation**

- New Project wizard: board (Pico, Pico 2, Pico W, Pico 2 W), template (`blinky`, `wifi`,
  `wifi-bluetooth`), name → a complete workspace (`Cargo.toml`, `.cargo/config.toml`, `memory.x`,
  `build.rs`, `rust-toolchain.toml`, `src/main.rs`, `.vscode/{settings,launch}.json`, `.gitignore`,
  `README.md`), with the CYW43 firmware blobs downloaded once and verified against pinned SHA-256
  hashes.
- The generated `memory.x` region arithmetic is checked against the chip's flash, every board
  reserves its drive region, and a generated project is detected back as the board it was made for.

**Toolchain**

- Detection of cargo, rustup, installed targets, probe-rs and probe health, plus Boards and Project
  side views.
- One-click installer for whatever is missing (rustup, targets, prebuilt probe-rs with SHA-256
  verification, udev rules), and **Add Cargo to PATH…** for rustup installs made with
  `--no-modify-path`.
- Debug Probe firmware update flow over BOOTSEL + UF2, behind a confirmation gate.

**Build, flash, run**

- Status bar — Build / Flash / Debug / Debug Stop / Monitor / Clean, each with a tooltip — and the
  same buttons in the side bar's **Controls** section, rendered from one shared list so the two can
  never drift. Debug Stop appears only while a probe-rs session is running.
- Flash through the probe: builds the debug image, writes it with `probe-rs download`, starts it with
  `probe-rs reset`, and **releases the probe** when it is done. Without a probe: our own ELF → UF2
  conversion, the BOOTSEL volume check for both RP2040 and RP2350 revisions, and a dialog that names
  the board before anything is written. Both routes write the same image the debug configurations
  load, Wi-Fi credentials included.
- Monitor: `probe-rs attach` for defmt output over RTT without reflashing.
- crates.io Library Manager: bundled catalog plus live sparse-index search, adding dependencies by
  editing `Cargo.toml` with a purpose-built editor (never `cargo add`), and never changing a version
  the project already pins.

**Debugging**

- Debug: finds the `probe-rs*` configuration in `.vscode/launch.json`, offers the
  `probe-rs.probe-rs-debugger` extension when it is missing, builds the debug profile as a visible
  task, then starts the session with RTT.
- Debug Stop: stops a running probe-rs session. It is hidden unless one is running, and it never
  touches another debugger's session.
- **Four** debug configurations per project, all on the **debug** build: flash & run with RTT, flash
  & halt on the reset vector, restart without flashing (a `launch` with `flashingEnabled: false`,
  which still resets the chip, so breakpoints in `main` and in startup code bind), and attach, which
  keeps a running program and can therefore only stop in code that runs again. Debugging never uses a
  release image, whose optimised lines leave breakpoints hollow.
- **Chip check:** before a no-flash session the extension compares the chip's flash with the build
  that session will use (`probe-rs verify`) and offers to flash instead when the two differ, rather
  than letting breakpoints silently fail to bind. A check that cannot be made says so and does not
  block the session.
- The Debug picker says which entry matches the last flash, and each one-line description says what
  the session does to the chip — including that an attach cannot reach code that has already run.
- The Debug button asks which configuration to start when a project offers more than one, so a
  session can run with or without flashing first.

**Wi-Fi (Pico W / Pico 2 W)**

- `wifi` and `wifi-bluetooth` templates: CYW43 bring-up over PIO SPI, association, and DHCP or a
  fixed address.
- Credentials prompt: on the first Flash or Debug the extension asks for the network name, password
  and an optional fixed IP address, keeps them in the editor keyring, and compiles them into the
  image as `WIFI_SSID`, `WIFI_PASSWORD`, `WIFI_STATIC_IP` and `WIFI_GATEWAY`. **Set Wi-Fi
  Credentials…** and **Clear Wi-Fi Credentials** manage them afterwards.
- Wi-Fi diagnostics in the template: a boot marker that separates the current run from replayed RTT
  history, the association logged, the lease wait bounded (30 s and retrying), and a warning that
  describes the symptom and names the fixed-address escape hatch.

**Tests**

- Layered suite, hermetic by default: t1 pure logic, t2 CLI shims, t3 golden files, plus opt-in t4
  (real `cargo build`) and t5 (real flash and defmt capture over RTT).
- `tests/tools/dap-session.js` (`npm run dap-session`): drives a real `probe-rs dap-server` session
  over DAP — attach or launch, one breakpoint or many — and reports whether each was programmed and
  whether one fired. It is how the attach behaviour and the chip's breakpoint budget were measured.

### Changed

- Terminals and spawned tools now inherit `~/.cargo/bin` on PATH, so `cargo` is found even when the
  editor was started from a desktop launcher.
- RP2350 `memory.x` aligns `_stext` explicitly, which removes the `rust-lld` "section .text is not a
  multiple of alignment" warning from every generated Pico 2 project.
- The generated wireless `README.md` and `src/main.rs` now present the credentials prompt as the
  normal route and keep the build-time variables as the alternative.
- Flash, the USB route and the debug build task build with the same environment (Wi-Fi credentials
  and an optional `DEFMT_LOG`), so the image a session expects is the image a flash wrote.

### Fixed

- Flash: the probe check is explained only when it turns slow, instead of showing a progress
  notification that blinks in and out on a fast machine.
- Flash no longer leaves the debug probe claimed. It used to run `cargo run --release`, whose runner
  stays attached for RTT, so the next debug session failed with "The selected USB device could not be
  opened" — a message that reads like a dead probe. A probe another program holds is now diagnosed as
  such and names what to close, and Flash offers to stop a running debug session before using it.
- Flash and Debug agree on the build again. Flash wrote the release image while every debug
  configuration loads the debug image, so "the chip is not running the build" was reported for an
  image that had *just* been flashed — a mismatch that existed by construction, not a fault.
- The USB/UF2 route built its image without the Wi-Fi credentials, so a probe-less flash could carry
  the template's placeholder SSID.
- USB permissions are no longer reported as missing when a rule someone else installed grants access
  (Raspberry Pi's own `99-picoprobe.rules`, for instance), or when probe-rs can already open a probe.
- USB flashing: the route is re-checked per run, `dist/` is handled, and a multi-board decision is
  made in a single dialog.
- Debug now flashes the build it debugs. `flashingConfig.flashingEnabled` defaults to `false`, so a
  session used to attach to whatever was on the chip while decoding its RTT with the debug ELF —
  which fabricates log lines that were never printed.

### Notes

- `t4-e2e` and `t5-hil` are opt-in: they need network access and a real debug probe.
- Windows is untested — the installer URLs are platform-aware, but probe-rs needs WinUSB/libusb
  handling that differs from Linux.

[Unreleased]: https://github.com/OomNiel/grumpy-rusty-platform/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/OomNiel/grumpy-rusty-platform/releases/tag/v0.0.2
[0.0.1]: https://github.com/OomNiel/grumpy-rusty-platform/releases/tag/v0.0.1
