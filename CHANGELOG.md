# Changelog

All notable changes to **Grumpy's Rusty Platform for VS Code** are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version number matches
`package.json`; until the extension reaches the Marketplace it is installed from the packaged
`.vsix`.

## [Unreleased]

_Nothing yet._

## [0.0.22] - 2026-10-05

### Added

- **The ESP `display` template draws a diagnostic screen instead of a flat fill.** A colour fill looks
  identical whether the active area is cropped or shifted, the colour order is swapped or the image is
  rotated, so the generated screen is made to be **read**: a full-panel frame (a missing side means the
  panel is cropped), four differently coloured corner markers — red top-left, green top-right, blue
  bottom-left, white bottom-right, so a shift is measurable — five bars named left to right, a cross
  centred on the panel size, `"Hello Grumpy!"`, and a line of status text that says what the screen
  should look like. One small square blinks while the loop runs, placed clear of every diagnostic so
  "the picture is right" and "the loop is alive" stay two separate facts.
- The geometry is **solved from the panel size**, not hard-coded for the 3.5" CYD, because the same
  template is offered to the T-QT's 128×128 panel: the corner markers shrink, the bars are fitted into
  the width, the greeting drops from `FONT_10X20` to `FONT_6X10` under 200 px, the bands are packed in
  order (corners, bars, greeting, status, blinking square) and a status line is only emitted if it fits.
- The screen needs drawing primitives, which live in the full `embedded-graphics` crate rather than in
  `embedded-graphics-core`: the template now depends on `embedded-graphics = "0.8"` and takes `DrawTarget`
  and `RgbColor` from its prelude, with `Text`, `Line`, `Rectangle` and the fonts from their own modules.

### Fixed

- **The panel's mirroring was board data the generator silently dropped.** The CYD's catalog entry has
  declared `mirrorX: true` (its panel's X axis runs opposite to the controller's default, per the
  community board definition) since the board was added, and the template emitted `colorOrder` while
  ignoring `mirrorX`/`mirrorY` — two of the four panel facts were dead data. The first flash of the new
  diagnostic screen is what reported it: the whole image came out mirrored, text included, with the red
  corner marker in the top-right. The builder chain now emits
  `.orientation(Orientation::new().flip_horizontal())` from the board data (mipidsi applies it through
  MADCTL, so drawing coordinates are unchanged) for **every** panel, so a board that needs no flip says
  so in the generated code instead of relying on a default.
- The generated `display` project also no longer carries the unused `display-interface-spi` dependency,
  and its `log::info!` output actually appears (see 0.0.21).

### Notes

- Verified on the real Sunton ESP32-3248S035R, by building and flashing the generated project: clean
  release build with no warnings, `App/part. size: 116,480/4,128,768 bytes, 2.82%`, and the board logging
  `panel ready: 3.5" ST7796 320x480` → `diagnostics drawn: frame, corners, 5 bars, cross and text` →
  `alive (tick 0)`. After the orientation fix, the screen showed red top-left, `"Hello Grumpy!"` reading
  normally, correct colours, and the white square blinking in the bottom-right corner — so the hardware
  confirms the board definition's mirroring claim. `NOTES.md` §51.
- The DevKitC and T-QT panels have **not** been flashed. Their generated code is covered by the layout and
  orientation assertions, but not by their own silicon.
- Test suite: **596 passed, 0 skipped**.


## [0.0.21] - 2026-10-05

### Fixed

- **Generated ESP apps printed nothing on the serial port.** `main.rs` calls `log::info!` and
  `.cargo/esp-config.toml` sets `ESP_LOG = "info"`, but **no logger was ever installed** — esp-println's own
  README requires `init_logger(…)` for the `log-04` feature — so every log line was dropped and a healthy app
  looked dead. Found by flashing a generated project to a real board: the bootloader reported
  *"Loaded app from partition at offset 0x10000"* and then nothing at all, for thirty seconds.
  `esp_println::logger::init_logger_from_env();` is now emitted right after `esp_rtos::start(…)`, and the
  `ESP_LOG` comment names what reads it. Ten snapshots (five ESP boards × both templates).

### Notes

- Verified on the hardware, immediately after: regenerate → `cargo build --release` → flash → monitor gives
  `=== <name> 0.1.0 starting ===`, the board line, and **`panel ready: 3.5" ST7796 320x480`** followed by the
  colour cycle. So the chain works end to end, and the board itself confirms its panel controller — `mipidsi`'s
  `Builder::init()` only returns if the ST7796 answered, which resolves the question the firmware dump could
  not answer. `NOTES.md` §50.
- Worth knowing when flashing any ESP board: `espflash flash <elf>` also writes **its own bootloader and
  default partition table**, so the factory OTA layout is replaced. That is espflash's behaviour, and it is
  reversible byte-for-byte from a verified full-flash backup (`espflash write-bin 0 0x400000 <backup>.bin`).
- Test suite: **593 passed, 0 skipped**.

## [0.0.20] - 2026-10-05

### Fixed

- **The generated display projects declared a dependency they never used.** `display-interface-spi` was still
  in the ESP display template's dependency list, and **no line of generated code references it** — it went dead
  when the buffered `mipidsi::interface::SpiInterface` replaced it in 0.0.19, and the comment above it still
  described the old arrangement. Both are gone, along with the now-unused version constant. An unused
  dependency compiles, links nothing and warns about nothing, so no test could have caught it: it was found by
  **diffing a real project against the generator**. `NOTES.md` §49.

### Notes

- Projects generated before this version carry that one extra line in `Cargo.toml`; removing it is optional
  (it changes nothing at runtime) and is a one-line edit plus `cargo update`.
- Test suite: **593 passed, 0 skipped**.

## [0.0.19] - 2026-10-05

### Fixed

**The ESP `display` template now compiles** — found by building a generated project rather than reading it
(§48), after the report *"see the terminal for build error"*:

- **`let mut delay = Delay;`** → `E0423`; esp-hal 1.2.2 has `Delay::new()`.
- **esp-hal's `Spi` is a `SpiBus`, and mipidsi wants a `SpiDevice`.** The template called `.with_cs(pin)` on the
  bus, which does not make one — the compiler's `E0277` note pointed at the trait impl in **`embedded-hal-bus`**,
  a crate the template never depended on. It does now (`0.3.0`), and the device is built with
  `ExclusiveDevice::new(bus, cs, delay)`.
- **`Rgb565::RED`/`WHITE`/… needed the `RgbColor` trait in scope** — one missing import, nine errors.

Verified: a **freshly generated** Sunton display project compiles with no warnings (29.74 s), and the user's
own project (repaired in place, its `build.rs` still carrying the 0.0.17 fix) builds too (1.35 s incremental).

### Notes

- Both ESP display boards share the template and `mipidsi 0.10` carries the T-QT's controller, so the fix covers
  `lilygo-tqt` as well — its own **build** was not run (a different chip means a cold `esp-hal` build), and that
  is stated rather than assumed.
- The gap this exposed is worth more than the fixes: `t3-golden` compares **text** against snapshots, so it
  pinned `SPIInterface::new(spi, dc, &mut buffer)` beside the wrong import for weeks — snapshot and generator
  agreeing with each other. A golden test proves the generator is *stable*, not that its output *compiles*; that
  check belongs in the opt-in `t4-e2e` layer. `NOTES.md` §48.
- Test suite: **593 passed, 0 skipped**.

## [0.0.18] - 2026-10-05

### Fixed

- **Setup asked rustup for a target only Espressif's toolchain has**, which ends as
  *"rustup exited with 1: … toolchain 'stable-x86_64-unknown-linux-gnu' has no prebuilt artifacts available for
  target 'xtensa-esp32-none-elf'"* — reported from an ESP32 project. The catalog already documents the split
  (`rpTargets()`/`espTargets()`: *"Xtensa triples are not rustup targets at all … so a plan that lumps them
  together asks rustup to do the impossible"*), but both planners built their `rustup target add <triple>`
  steps from the project's whole target list. They now filter through `isRustupTarget()`, and a test asserts
  **both** sites do (one filtered and one not is how this survived the split).

### Notes

- Setup now finishes instead of erroring; the **ESP toolchain is still its own command** —
  *Rusty: Install ESP Toolchain* (`espup`, which also writes `~/export-esp.sh`) — and the build path already
  names it when the Xtensa linker is missing. Making the setup plan chain into that command is a fair
  follow-up. `NOTES.md` §47.
- Still open from §46: the ESP **`display`** template's own code does not compile (three defects, listed with
  the compiler's output). ESP `blinky` is the one to build.
- Test suite: **593 passed, 0 skipped**.

## [0.0.17] - 2026-10-05

### Fixed

Two defects in the **ESP** generator, found by inspecting a user's Sunton project and then building a freshly
generated one with the real Xtensa toolchain:

- **`build.rs` did not compile at all.** Its panic message escaped backticks (`\``), and Rust has no such
  escape — `error: unknown character escape`. **Every ESP board and both ESP templates** were affected: the build
  script is compiled before anything else, so no ESP project could get past it.
- **The panel's SPI interface was the two-argument one, called with three.** The template emitted
  `use display_interface_spi::SPIInterface;` and then `SPIInterface::new(spi, dc, &mut buffer)`:
  `display-interface-spi-0.5`'s `new` takes two arguments, `mipidsi-0.10`'s buffered
  `interface::SpiInterface::new` takes three. It now imports mipidsi's. Affected `sunton-3248s035r` and
  `lilygo-tqt`; the user's project had been fixed by hand, which is what led to the inspection.

### Known broken

- **The ESP `display` template still does not compile.** With `build.rs` fixed, esp-hal and the whole dependency
  tree now build and the template's own `main.rs` fails with nine errors: `let mut delay = Delay;` is `E0423`
  (esp-hal 1.2.2 has `Delay::new()`); esp-hal's `Spi` is a `SpiBus` and mipidsi's buffered `SpiInterface` wants
  a `SpiDevice` (which `.with_cs(...)` does not construct); and `Rgb565::RED`/`WHITE` need the `RgbColor` trait
  in scope. `NOTES.md` §46 records all three with the compiler's own output. **ESP `blinky` projects should build
  now; `display` ones will not until these are fixed.**

### Tests

- The ESP board test now pins the import and the buffered call **together**, so they cannot drift apart again;
  the golden snapshots are regenerated for the two changed templates. Suite: **592 passed, 0 skipped**.

## [0.0.16] - 2026-10-05

### Documentation

- **`README.md`** catches up with everything shipped since the port: the three **Controls** additions
  (*Publish .deb*, *Install .deb*, *Back Up Project*) in the feature and command tables, the **editor-tab chat**
  that can be dragged onto a second monitor, and the **Hugging Face** flow for choosing any model rather than the
  two built-in ones.
- **`AI_ASSIST.md`** — *Get a model* now leads with what the extension does by itself (installing llama.cpp and
  fetching the 27B for your own server; adding any `.gguf` from the Hub with its size, quantisation and fit for
  this machine), the view section documents the editor tab and the second monitor, and the commands and settings
  sections name the new commands, `llamaServerModelPath` and `gpuVramGb`.
- `NOTES.md` (§35–§45) and this file were written with each release; no code changed in this version.

### Notes

- Test suite unchanged: **592 passed, 0 skipped**.

## [0.0.15] - 2026-10-05

### Added

- **Back Up Project** — a third control in the Controls section: copies the project folder **next to itself** as
  `<folder>-<date>_<time>` (local time, so two backups sort in the order they were taken, and a second backup
  within the same second gets `-2` instead of replacing the first).
  - `target/` is **not** copied: compiler output, routinely tens of gigabytes, regenerated by the next build.
    `.git/` **is** copied — that is the project's history, not an artifact. A *file* named `target` is your own
    work and is kept; only the directory is skipped.
  - One `fs.cpSync` with that filter; symlinks stay symlinks. The report names the folder and offers to reveal it.

### Notes

- Verified on a project-shaped tree: a 3 MB `target/release/junk/big.bin` was left out while `Cargo.toml`,
  `src/` and `.git/HEAD` landed in `proj-2026-10-05_180409` beside the original. `NOTES.md` §45.
- Test suite: **592 passed, 0 skipped** (was 587).

## [0.0.14] - 2026-10-05

### Added

**Publish the project as a `.deb`, and install it on the host** — two new controls in the **Controls** section.

- **Publish .deb** builds the firmware for release and packs what the build produced into a Debian package **in
  the project root**: `/usr/share/<package>/` gets the `.elf`/`.bin`/`.uf2` and `/usr/bin/<package>-flash` is a
  small wrapper that runs `probe-rs` on whichever of them is there. So installing it on a host means that host
  can flash the board (`<package>-flash`, any probe-rs arguments passed through) with no project checked out.
  `Architecture:` is the **host's** — claiming `arm64` because the microcontroller is an ARM Cortex-M would make
  dpkg refuse to install it on the x86-64 machine that built it.
- **Install .deb** shows `dpkg-deb --info` for the package this project published and then runs `sudo dpkg -i`
  in a VS Code terminal, so you can type your password (and the command stays in the scrollback).
- Both are rows in the Controls section only — not in the status bar, which has to stay short — and both say why
  they cannot work on Windows/macOS instead of failing at the shell.

### Notes

- A Debian package cannot install anything onto a microcontroller, so the package is the *firmware plus a flash
  helper*; the ambiguity was put to the user before building it. `NOTES.md` §44.
- Verified against the real `dpkg` here: `dpkg-deb --build` exit 0, `my-blinky-pico2w_0.1.0_amd64.deb` (81 370
  bytes) in the project root, control fields and contents as intended, the wrapper executable at `0755`.
- Test suite: **587 passed, 0 skipped** (was 582).

## [0.0.13] - 2026-10-05

### Added

- **The move to an editor pane is now reachable from the Rusty Platform side panel itself**: a button
  **In Editor Tab…** in the AI Assist view's footer (beside *Status…/Unload*), and an action in the view's
  title bar. Both run the existing **Rusty AI: Open the Assistant in an Editor Tab** command, so the palette
  route and the in-panel routes cannot drift apart.

### Notes

- `NOTES.md` §43. Test suite: **582 passed, 0 skipped** (was 581).

## [0.0.12] - 2026-10-05

### Fixed

- **The editor-tab assistant now comes back after a reload or a restart**, in the window it was moved into.
  VS Code only restores a custom webview panel when its extension registers a `WebviewPanelSerializer` for
  that panel's view type; without one the tab was simply gone, which is what 0.0.11 shipped. The transcript is
  not carried in the panel state — it comes from the chat store through the webview's normal handshake, so a
  copy dragged onto another monitor (restored by a separate window, with its own extension host) fills in
  correctly; only the title travels, so a tab you renamed keeps its name.

### Notes

- The window's **placement** is restored by VS Code, not by this extension: nothing about the monitor is
  stored, and the code says so rather than implying control it does not have. `NOTES.md` §42.
- Test suite: **581 passed, 0 skipped** (was 580).

## [0.0.11] - 2026-10-05

### Added

**The assistant as an editor tab — so it can live on a second monitor**

- New command **Rusty AI: Open the Assistant in an Editor Tab** opens the same chat as a **webview panel in
  the editor area**. Drag that tab out of the VS Code window (or use *View: Move Editor into New Window*) and it
  becomes a real OS window you can put on another monitor, with the conversation live in both places at once.
  This is the only shape that can leave the window: a side-bar *view* is always docked.
- It is the **same conversation**, not a second copy: the transcript, the chat history and the request path are
  shared, `post` broadcasts to every open surface, and a surface that just opened draws the history
  immediately. Asking twice reveals the tab that already exists instead of stacking copies, and
  `retainContextWhenHidden` keeps the transcript while it is behind another tab.

### Notes

- `NOTES.md` §41. Test suite: **580 passed, 0 skipped** (was 579).

## [0.0.10] - 2026-10-04

### Fixed

**Windows 11: three decisions that assumed Linux**

The extension installs and runs on Windows (`"os"` restricts nothing), the toolchain/flash layer already has
its Windows branches, nothing spawns through a shell, and the Rust sidecar has no Unix-only code. Three
AI-side decisions were Linux-shaped and are put right:

- **Start server no longer asks systemd for a unit on Windows.** `systemctl` does not exist there, so the
  first Start failed against it and only then fell back to a process. The default is now the platform's —
  a systemd user unit on Linux, a child process elsewhere — and a setting you chose explicitly is always
  honoured.
- **The model search looks at your other drives.** It walked `/media`, `/run/media`, `/mnt`, `/Volumes` (which
  do not exist on Windows and were skipped) and never `D:`-`Z:`, so a `.gguf` on a second drive was invisible
  to every scan and reachable only through the file dialog. `C:` is deliberately not walked: the interesting
  folders on it are your own, which are already roots.
- **"Who is holding this port?" no longer claims "nothing".** That answer came from `ss` and `/proc`, which are
  Linux-only — so on Windows the panel said nothing was running while a server answered requests. It now says
  *"running, but this platform cannot say who started it"*, and the stop flow tells you where to end it
  instead of pretending it checked.

### Notes

- **Good news found in the audit**: the GPU probe already covers Windows (PowerShell/WMI) and macOS
  (`system_profiler`) and classifies discrete versus integrated cards, so the VRAM-aware offload works there
  too; `gpuVramGb` covers anything the probe cannot see.
- **Still unverified on Windows**: a first-run sidecar build with MSVC, and the ESP toolchain install — both
  audited, neither run. Recorded in `NOTES.md` §40, along with one follow-up this audit surfaced: there are now
  two VRAM readers (the host gate's probe and `sys.ts`) which agree in practice and should be one.
- Test suite: **579 passed, 0 skipped** (was 575).

## [0.0.9] - 2026-10-04

### Changed

**The model list is no longer sized for one machine** — you can choose what suits *your* hardware.

- **Add your own models from Hugging Face.** New command **Rusty AI: Add a Model from Hugging Face…** (also an
  entry in *Choose a Local Model…*): give it `owner/repo` or a Hub link and it lists that repo's `.gguf` files
  with **size, quantisation and whether they fit here**; pick one and it joins the model list, downloads with
  progress and a SHA-256 check, and appears in the panel's dropdown like any built-in entry. **Rusty AI: Remove
  a Model I Added…** takes it off the list again (the weights stay on disk). This flow had been ported in an
  earlier version and was **unreachable** — nothing called it — which is why the only choosable models were two
  4.4 GB entries.
- **No model is refused because of this machine any more.** The old rule vetoed anything whose RAM requirement
  exceeded the machine's, and for a model added from the Hub that requirement was *twice its own file size* —
  so a 16.8 GB 27B was "not offered here" on the 28 GB machine that loads it in 16.5 GiB. Every model is now
  offered: one that may not fit is marked with the arithmetic (*"needs about 24.4 GB free (21.3 GB free now,
  28 GB in total)"*) and asking for it confirms once.
- **The graphics card is asked, not assumed.** The offload rule was `size > 8 GB → CPU only`, written for a
  shared-memory iGPU — on a 24 GB card it pinned a 27B to the CPU. VRAM now comes from `nvidia-smi`, the
  amdgpu driver, or the new **`gpuVramGb`** setting, and the decision is whether the weights **plus their
  context** fit the card, with a sentence either way. An AMD APU's figure is a slice of system RAM (this
  machine's integrated Radeon reports 3.2 GB, where offload is *faster*: 9.7 s against 13.0 s), so a figure
  under 8 GB is deliberately ignored.
- **Threads and context scale.** `min(cores − 1, 16)` instead of a cap of 8 (this 12-thread machine now gets
  11), and the recommended context is 64 k at 96 GB of RAM, 32 k at 48 GB, 16 k at 20 GB — unchanged below
  that. Both are still overridable in the settings.

### Notes

- Verified on the real machine and the real Hub: the 27B is now offered here (needs 18.8 GB, 21.3 GB free),
  threads 11, GPU offload on a 24 GB card; and `lmstudio-community/Qwen3.8-27B-GGUF` listed its four files and
  added the Q4_K_M to `user-models.json` and to the model list. `NOTES.md` §39.
- Test suite: **575 passed, 0 skipped** (was 571).

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
