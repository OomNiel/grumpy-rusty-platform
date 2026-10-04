# Changelog

All notable changes to **Grumpy's Rusty Platform for VS Code** are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version number matches
`package.json`; until the extension reaches the Marketplace it is installed from the packaged
`.vsix`.

## [Unreleased]

_Nothing yet._

## [0.0.8] - 2026-10-04

### Added

**"Implement this code" under a chat answer**

- When an answer in the AI Assist view contains Rust code, a button appears under it — *"Implement `fn
  flash_led` in the project…"*, one per block, labelled by the item it defines. Pressing it writes that code
  into the Rust file you have open:
  - the **same-named function is replaced in place**, keeping your file's attributes and signature (a
    refactored `main` cannot lose `#[embassy_executor::main]`);
  - a **new function is added** to the file;
  - only a **whole file** replaces the file — recognised by `#![…]` or by `use` lines beside `fn main`, so a
    refactored `main` body is not mistaken for one (that mistake would have replaced `main.rs` with a single
    function and deleted the rest of it — caught by the test written for it);
  - a `Cargo.toml`, shell or JSON block in the same answer is **not** offered, and a block cut off by the
    token budget is not offered either.
- The result opens as a **diff** and nothing is written until you press **Apply** — the same review step as
  *Implement in Function* and *Fix with AI* — and the write is one undoable edit. The diff names the file
  (`AI: fn main → main.rs`), which is why the target needs no question: the file in front of you is it, and
  the picker appears only when no Rust file is open (or to create a new one).

### Notes

- Verified against a real file, through the compiled modules with a stubbed `vscode`: a refactored `main`
  produced a diff whose proposed text had the new body, the old body gone, and `#![no_std]`, the embassy
  attribute, `use embassy_time::Timer;` and an unrelated function all intact — with the file on disk unchanged
  until Apply. `NOTES.md` §38.
- Test suite: **571 passed, 0 skipped** (was 562).

## [0.0.7] - 2026-10-04

### Changed

**The extension no longer relies on you having llama.cpp** — if it is on this machine it is started and used,
and if it is not, the install is offered.

- **A request that had nowhere to go now fixes that itself.** The chat, *Implement in Function*, *Fix* and
  *Repair* all go through one path: if the address in the settings has nothing behind it, the extension uses a
  llama-server that is answering on another local port (saying so: *"nothing is answering at
  http://127.0.0.1:1234/v1 — using the llama-server on port 8080 instead"*), otherwise it starts the binary
  you have with the model the settings already know, otherwise it offers to download llama.cpp — and then
  sends your question again. Previously it stopped at *"No server answered"* however much llama.cpp was on the
  disk.
- **Only ever when that is the right thing to do**: an `external` backend, a **local** address (a remote
  endpoint that is down must not make this machine start a process nobody asked for), and a "nothing
  answered" failure — a `400`, a cancel or a timeout is reported as before. Nothing is retried once part of an
  answer has been streamed in, so a retry can never print it twice.
- **A llama.cpp this extension installed is now found without the setting that points at it.** The lookup
  reads `<global storage>/llama.cpp/<tag>/…` for itself, so clearing `llamaServerPath`, opening a second
  window or moving a profile no longer hides a verified build (and no longer offers to fetch it again). The
  status dialog says which it is: *"(installed by this extension)"*.

### Notes

- Verified on a machine with nothing installed: the offer appears with
  **Download llama.cpp** / **Point at my own build…** / **Cancel**, the ~18 MB prebuilt lands and is verified
  in **4.1 s**, and the next lookup finds it as `installed: true`. With a dead endpoint configured, the
  reported failing prompt now answers by reusing the running server and pinning it. `NOTES.md` §37.
- Test suite: **562 passed, 0 skipped** (was 557).

## [0.0.6] - 2026-10-04

### Fixed

- **Choosing "use the llama-server already running" updated the settings but not the panel**, so the *Model
  and settings* section went on showing the old endpoint — and pressing **Save** wrote that stale address
  back over the correct one, after which every prompt failed with *"No server answered"*. The extension's own
  log has the exact sequence (the reuse at 09:33, two saves at 09:34, the failure at 09:36) and the
  llama-server logged **no request at all** at 09:36, which is how the stale endpoint was caught rather than
  guessed. Three things changed:
  - the view is refreshed after **every** pin write (`useRunningLlamaServer`, `startOwnLlamaServer`), so the
    form shows what the settings say;
  - **Save now sends only the fields you changed** — an empty diff is not a write, it answers "Nothing
    changed" — so a form that has not caught up can never revert a decision it never saw;
  - the failure **names the address it tried** (*"No server answered at http://127.0.0.1:1234/v1"*) and, when
    a probe finds a llama-server answering somewhere else, says so: *"A llama-server IS answering on port
    8080 (qwen3-coder-30b-a3b-instruct-q4_k_s.gguf) — the settings point at http://127.0.0.1:1234/v1, so the
    endpoint above is the thing to change."*

### Notes

- Verified against this machine's real 30 B service through the compiled modules with a stubbed `vscode`: the
  reuse pins `backend`/`endpoint`/`model` **and** posts `state {endpoint: http://127.0.0.1:8080/v1, model:
  qwen3-coder-local}` to the open view; an empty diff writes nothing; a one-key diff writes one key.
  `NOTES.md` §36 has the log excerpts.
- Test suite: **557 passed, 0 skipped** (was 552).

## [0.0.5] - 2026-10-04

### Fixed

- **"My own llama-server" could not be reached at all.** The model picker's *My own llama-server* entry
  ran `rustyPlatform.assistant.startLlamaServer`, a command nothing ever registered, so choosing it
  failed with "command not found"; and the seven settings that path writes
  (`llamaServerPath`, `llamaServerArgs`, `llamaServerService`, `llamaServerStartTarget`,
  `loadContextLength`, `loadGpu`, `loadTtlSeconds`) were never declared in `package.json`, so writing
  any of them raised *"… is not a registered configuration"*. Both the commands and the settings are
  declared now, and `tests/layers/t1-logic/ai-wiring.test.js` checks the source against the manifest in
  **both** directions — the existing check only walked *registered → declared*, which is blind to a
  command that was never registered in the first place.

### Added

**`llama-server` installs itself, and so does its model**

- **The prebuilt server, when this machine has none.** Where the flow used to say "install llama.cpp
  yourself", it now offers to download llama.cpp's own prebuilt build for this platform (~18 MB) into
  the extension's storage, verify it against the `sha256:` digest GitHub publishes, unpack it with the
  system `tar`, and point `llamaServerPath` at it. A build you compiled yourself is still one click
  away ("Point at my own build…"), and no GPU build is ever downloaded: those are 150-600 MB and depend
  on a driver this extension cannot inspect.
- **The 27B, when it is not on the machine.** The palette command and the panel's Load button resolve
  the model in the order "the `modelPath` setting → a verified copy already in the extension's storage →
  one picker", and the picker's first entry is the known 27B
  (`lmstudio-community/Qwen3.8-27B-GGUF`, `Qwen3.8-27B-Q4_K_M.gguf`, 16 810 714 336 bytes,
  sha256 `e00082f7…43e520` — the model the Avalonia Designer steps up to, and the numbers are confirmed
  against Hugging Face's own API). If those weights already exist anywhere the searcher reaches, they
  are adopted instead of downloaded.
- **The two engines keep their own model.** `modelPath` is the *built-in* runtime's pin (the panel marks a
  bundled entry as loaded by comparing it with it), so the user's own server now has its own
  `llamaServerModelPath`. A file the built-in runtime knows by name is not an answer to "which model does
  your llama-server run": on this machine `modelPath` held the Designer's copy of the shipped 4.4 GB 7B, so
  the old rule would have started that silently instead of the 27B.
- **Once both answers are known, nothing is asked.** The command starts your `llama-server` and loads
  the weights: the flags question appears only when the model was just chosen by hand, and the one
  question that does survive is "a llama-server is already running — use it or start another?", which
  exists because two models of this size do not fit in the same RAM.
- New commands **Rusty AI: Start My llama-server…** and **Rusty AI: Stop My llama-server**.
- `llamaServerPath`, `llamaServerArgs`, `llamaServerService`, `llamaServerStartTarget`,
  `loadContextLength`, `loadGpu` and `loadTtlSeconds` now appear in the Settings UI with descriptions,
  instead of being written by code into keys the manifest had never heard of.

### Notes

- The known 27B **was not on this machine** when this was written: only LM Studio's record of the
  download survives, so the download offer is the only route to it here (15.7 GB).
- Verified for real, not assumed: the installer reaches a running `llama-server --version` in **4.4 s**
  (`0.5.0-dev`, build 11384), and the start path reaches `/health {"status":"ok"}` plus a real chat
  completion in **4.0 s**. `NOTES.md` §35 has the evidence, including the trap that
  `/releases/latest` on llama.cpp answers `v0.5.0` — a release with no binaries in it at all.
- Test suite: **552 passed, 0 skipped** (was 530).

## [0.0.4] - 2026-10-03

### Added

- **A local model is looked for on this machine before it is downloaded.** Choosing the built-in
  runtime's model now searches the usual model folders (`~/Downloads`, LM Studio, the Hugging Face
  cache, the storage of every installed extension (`globalStorage/<extension>/models`), `/media`, `/run/media`, `/mnt`, `/Volumes`) for the same weights — by exact name or exact size — and adopts the first
  candidate whose **SHA-256 matches the published hash**. A hard link puts it in the extension's
  storage without duplicating the bytes; across filesystems it falls back to a copy. The search is
  bounded in depth (5) and time (15 s), says what it is doing, and hashes only plausible candidates,
  so it cannot cost more than the download it avoids. The panel’s list of `.gguf` files on the machine uses the same roots. Previously a model already on the disk was
  fetched again.

## [0.0.3] - 2026-10-03

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

- **The AI assist says what it is doing while it works.** Every request reports a live line — *“Writing… 42
  tokens · 6.8 tokens/s (6.2s) · context 40% (1640/4096)”* — on a half-second heartbeat, so a long prompt read
  (*“The model is reading the prompt… (3.2s)”*) no longer looks like a hang. The bundled runtime sends the
  real tokenized prompt size before it generates, which makes the context percentage a measurement rather
  than a guess; against an external server the window is not ours to know, and no percentage is shown.
- **The compiled runtime survives extension updates.** The sidecar’s build output moved from the installed
  extension folder to global storage, with a marker recording the backend and a fingerprint of the exact
  sources it was built from — so an update reuses the existing llama.cpp build instead of compiling it
  again for identical sources, and switching CPU/Vulkan still rebuilds.
- **The AI chat remembers your conversations.** They are saved per workspace folder
  (`globalStorage/ai-chats.json`), restored when the view opens, and switchable from a picker with **New**
  and **Delete** — so a reload continues where you left off instead of showing an empty page.
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

### Changed

- **“Choose a local model…” announces its wait.** The first check of a session also starts LM Studio’s
  helper service (measured at ~4.3 s), and the picker could not be built before that finished; the command
  now shows a progress notification — *“Looking for local models…”* — while it asks LM Studio and reads
  the machine, so a slow first click no longer looks like a dead button.
### Fixed

- **Models inside LM Studio’s folder are no longer invisible.** The scan dropped every `.gguf` under
  `~/.lmstudio/models` because `lms ls` was expected to list them; when the `lms` binary is installed but
  its daemon will not start (“Timed out waiting for LM Studio daemon to start”), that list is empty and the
  files were offered nowhere. They are scanned now, they appear in **Choose a Local Model…** as well, and
  a file already inside LM Studio’s folder is served in place by the extension’s own runtime rather than
  “imported” — `lms import` refuses those, and with the daemon down our runtime is the only route to it.
- **`backend: bundled` really starts the bundled runtime.** Two initialisers (`initModelRuntime`,
  `initLlamaServer`) were never called, and no request path resolved the runtime’s own endpoint, so a chat
  with a perfectly good local model went to the settings’ default address — LM Studio’s — and came back
  *“No server answered — is the local model server running (and the endpoint correct)?”*. Both runtimes are
  created at activation now, and every chat resolves the endpoint first (`configWithEndpoint`).
- **The sidecar’s first build finds the C headers.** `libclang` resolves `#include <stdbool.h>` only when
  something points at the compiler’s include directory, so on a machine with `libclang` but no `clang`
  package the build died there. The installed compiler is asked (`gcc -print-file-name=include`) and the
  answer is passed as `BINDGEN_EXTRA_CLANG_ARGS`, unless the environment already sets it.
- **A regression that broke every request is fixed.** The live-progress work called its first tick before
  the outcome object it reads existed, so `chatDetailed` threw *“Cannot access ‘outcome’ before
  initialization”* and no request ever reached the model. The declaration now precedes the first tick, and
  a test drives `chatDetailed` against an injected SSE stream — the coverage whose absence let it ship.
- **An answer is no longer printed twice in the chat.** The streamed pieces drew the answer and the closing
  message added the whole thing again as a second turn; the closing message now *settles* the live turn,
  replacing the streamed text with the authoritative answer.
[Unreleased]: https://github.com/OomNiel/grumpy-rusty-platform/compare/v0.0.4...HEAD
[0.0.4]: https://github.com/OomNiel/grumpy-rusty-platform/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/OomNiel/grumpy-rusty-platform/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/OomNiel/grumpy-rusty-platform/releases/tag/v0.0.2
[0.0.1]: https://github.com/OomNiel/grumpy-rusty-platform/releases/tag/v0.0.1
