# Changelog

All notable changes to **Grumpy's Rusty Platform for VS Code** are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version number matches
`package.json`; until the extension reaches the Marketplace it is installed from the packaged
`.vsix`.

## [Unreleased]

_Nothing yet._

## [0.18.20] - 2026-11-01

### Added

- **The clock widget is drawn on the C++ canvas.** It was missing from the emitter's supported tags, so a design
  whose only widget was a clock emitted an empty view — the board showed a blank screen with the backlight on
  (bench, 2026-11-01). The face is now real LVGL objects: 60 minute ticks, 12 hour ticks, the numerals, and three
  `lv_line` hands. Ticks and numerals are fixed geometry, so it is worked out in the emitter and written as
  literals — no trigonometry is linked into the firmware, only a 60-entry table of unit vectors for the hands.
  `movement` makes it run a second at a time from `millis()` (what a board with no RTC can honestly do), and
  `ui_clock_<id>_set_time(hour, minute, second)` in `ui.h` is how an app that knows the real time (NTP, an RTC)
  hands it over.

## [0.18.19] - 2026-11-01

### Fixed

- **A flash that cannot go over USB now offers the debug probe instead of dead-ending.** With a Pico Probe
  attached, `arduino-cli upload` (the default UF2 method) ends at `No drive to deploy.` — the board is never in
  BOOTSEL mass-storage mode, because the probe programs over SWD. Flash now notices, asks once, writes
  `uploadmethod=picoprobe_cmsis_dap` into the project's `sketch.yaml`, rebuilds with that method (it decides the
  debug script and the maximum data size) and flashes again — no `-p` anywhere. The method is read from the
  core's own menu, so a board or core without one simply says so.

## [0.18.18] - 2026-11-01

### Fixed

- **A WYSIWYG project is no longer born called `blinky_pico2w`.** The name box was pre-filled `blinky-<board>`
  whatever template had been chosen, so the folder, the `.ino`, the README title and the generated code all said
  blinky for a project made from the *WYSIWYG designer* item — which is exactly what makes "a blinky was created"
  the honest reading of what you see. The default now follows the template (`designer-pico2w`), the prompt names
  the template being created, and the completion message uses its label rather than its id.
- **A project that is not the template that was asked for is refused, not written.** The wizard now checks each
  template's signature file before writing anything (a designer project must produce `designer/panel.ui.json`
  and the code-behind for its language) and says so instead of reporting success over the wrong project.

## [0.18.17] - 2026-11-01

### Fixed

- **A new C++ project from the wizard offers to open the canvas.** The template was called *Designer screen (no
  canvas yet)* long after the C++ canvas worked, and the wizard's "Open Designer" button was still gated on the
  Rust backend — so the WYSIWYG option could not be found, and a designer project could only be opened as a
  folder. The template is now **WYSIWYG designer**, its description says what it really does (`src/ui.cpp` as
  LVGL objects, events in `src/ui_handlers.cpp`), and the wizard offers **Open Designer** for either language.

### Verified

- A WYSIWYG project was generated and **compiled for all seven boards**: `pico` 303 KB, `picow` 562 KB,
  `pico2` 293 KB, `pico2w` 551 KB, `esp32-devkitc` 551 KB, `lilygo-tqt` 568 KB, `sunton-3248s035r` 551 KB — all
  with LVGL 9.6, no warnings, each starter design valid and emittable by the C++ Designer.

## [0.18.16] - 2026-10-31

### Fixed

- **Upload can flash through a debug probe (Pico Probe / CMSIS-DAP).** A probe programs over SWD and never
  appears as a serial port, so Flash stopped at *No board found on any port* before doing anything. There is now
  **Rusty Platform: Upload Method…**, which lists the methods the core itself offers (`default` = UF2 over USB,
  `picotool`, `picoprobe_cmsis_dap`) and writes the choice into the project's `sketch.yaml` as an FQBN option
  (`rp2040:rp2040:rpipico2w:uploadmethod=picoprobe_cmsis_dap`) — the option has to be on the *build* too, since
  it decides the debug script and the maximum data size. An upload whose method needs no port no longer asks for
  one.

### Also

- **The port list was always empty.** `arduino-cli board list` wraps each port in its own object
  (`{"port":{"address",…},"matching_boards":[…]}`) and the parser read `address` from the outer entry, so no
  board was ever found on any port — not on this bench, not for UF2 uploads either. Both shapes are read now, and
  a port with no recognised board keeps its device name instead of being dropped.

## [0.18.15] - 2026-10-31

### Fixed

- **Clean works on a designer project.** It ran `arduino-cli compile --fqbn … --clean`, and that flag means
  *clean, then compile* — so it preprocessed the sketch and stopped on `lv_conf.h`, because it was invoked
  without the LVGL `--build-property` a Build passes. Clean is now the `cargo clean` shape it should always have
  been: it removes this project's `build/` and `.arduino/build` folders (115 MB on the bench project), reports
  what it freed, and stops. The editor's config is left alone — it already carries the include paths, defines
  and compiler flags from the last build, so IntelliSense keeps working without the database the build wrote.

## [0.18.14] - 2026-10-31

### Fixed

- **The six "Cannot find" warnings in `c_cpp_properties.json` are gone.** arduino-pico's `core_inc.txt` still
  names pico-sdk 2.x include folders (`common/pico_base`, `common/pico_bit_ops`, `common/pico_divider`,
  `common/pico_stdlib`, `common/pico_usb_reset_interface`, `rp2_common/pico_platform`) that the rp2350 layout
  replaced with `…_headers` names. A compiler ignores a `-I` that does not exist; the C/C++ extension reported
  each one against the config file, for paths nobody chose. The editor config now carries only folders that are
  really on disk — the compilation database still holds everything the compiler was given.

## [0.18.13] - 2026-10-31

### Fixed

- **IntelliSense now sees what the compiler sees, so the Problems pane stops inventing errors.** Three things
  were wrong with the editor setup for a C++ project, all of them invisible to the build:
  - the refresh ran `arduino-cli compile --only-compilation-database` **without** the LVGL `--build-property`,
    so `lv_conf.h` was unresolved and every LVGL type undeclared;
  - the database named arduino-cli's **copy** of the sketch (`.arduino/build/sketch/src/ui.cpp`), and the C/C++
    extension matches entries to files by absolute path — so `src/ui.cpp` was not in it and every entry was
    ignored;
  - arduino-pico reaches sixty-odd pico-sdk include folders through `@response` files and `-iprefix`, which the
    C/C++ extension does not open — hence `lwip/init.h` and `<pico/stdlib.h>` reported as missing.

  The refresh now passes the same build properties as a build, rewrites the database with one entry per project
  file (response files inlined, `-iprefix` turned into ordinary `-I`), and carries the compiler's includes,
  `-D`s and `-mcpu`/`-march` flags into the config as well. A designer sketch of 551 KB now reads as zero
  problems in the editor, and the build is unchanged.

## [0.18.12] - 2026-10-31

### Fixed

- **A generated screen builds with no warnings on LVGL 9.6.** LVGL 9.6 deprecated `lv_obj_add_flag()` and
  `lv_obj_remove_flag()` in favour of one setter per flag, so a freshly generated `src/ui.cpp` put three
  `-Wdeprecated-declarations` warnings on the Problems pane for a design nobody had touched. The emitter now
  writes two small wrappers and asks the version once (`LVGL_VERSION_MAJOR`/`MINOR`): 9.6 and later call
  `lv_obj_set_hidden()`/`lv_obj_set_scrollable()`, older versions keep the flag pair they actually have — so
  one generated file builds on 9.2 and on 9.6 alike, and neither says a word.

## [0.18.11] - 2026-10-31

### Fixed

- **A new C++ project's screen and its handler file now agree, so the first build compiles.** The generator
  wrote a hand-made skeleton `src/ui.cpp` that called a handler of its own (`on_screen_tapped`), while the
  Designer rewrites `src/ui_handlers.h` from the design — which declares `on_go_clicked` and nothing else. The
  first build of a real project stopped at `'on_screen_tapped' was not declared in this scope`. All four
  Designer files are now generated from the starter design through the same emitters the Designer saves with,
  and a test checks, for every board, that everything `ui.cpp` calls is declared and defined, and that nothing
  is declared that `ui.cpp` never calls.
- **The Designer now rewrites a sketch's `src/ui.cpp` on save.** `syncModule` was gated on markup coming out,
  and a C++ project has no markup — so a save rewrote the handlers (unconditional) and left the screen at
  whatever the wizard wrote. The gate is now "the document validated", which is the same question for both
  languages and the only one a sketch can answer.

## [0.18.10] - 2026-10-31

### Fixed

- **Build, Flash and Monitor now actually run for a C++ project.** The shared command wrapper refused every
  non-Rust project *before* the command body ran — and the arduino-cli implementations live inside that body —
  so Build/Flash/Monitor/Clean and F5 all reported the same "that command is the Rust route" warning instead of
  doing anything. The wrapper now only runs the Rust toolchain check (and only for a crate); the commands that
  have a C++ implementation route inside their own bodies, and the library manager — the one command that
  really does edit `Cargo.toml` — refuses for a sketch itself, in its own words.

## [0.18.9] - 2026-10-31

### Fixed

- **`rustyPlatform.checkLaunchConfig` says the right thing for a sketch.** It inspects the Rust debugger's
  `launch.json`, which a C++ project has none of; it now says so instead of claiming the project is on the wrong
  route. The refusals are also written to the Rusty Platform log with the kind of command that hit them, so a
  button wired to the wrong command names itself.

## [0.18.8] - 2026-10-31

### Added

- **`rustyPlatform.arduinoCliPath`**, beside `cargoPath` and `probeRsPath`: a machine with two arduino-cli
  installs can say which one builds. Empty means auto-detect (`PATH`, `~/.local/bin`, `~/bin`, `~/.arduino15/bin`,
  `/usr/local/bin`, `/opt/homebrew/bin`). The **cores** are installed by arduino-cli itself
  (`arduino-cli core install rp2040:rp2040`, `esp32:esp32`); PlatformIO is not used and not needed.
- **Start Debugging (F5) does something useful on a sketch**: there is no debugger for a C++ project in this
  build, so it builds, writes the board and opens the serial log — instead of refusing.

### Fixed

- The "edits Cargo.toml" warning no longer appears for **Build** on a C++ project: it now only fires for the
  commands that really are the Rust route, and says which route it is.

## [0.18.7] - 2026-10-31

### Fixed

- **The Controls and the Project view speak arduino-cli in a C++ project.** Every row was worded for cargo —
  "cargo build", "cargo clean", and a red "cargo not found" for a project that never uses it — so a sketch
  looked like a project whose Build button was missing. A C++ window now shows **Build** (`arduino-cli
  compile`), **Flash** (`arduino-cli upload`), **Monitor** (`arduino-cli monitor`) and **Clean**
  (`arduino-cli compile --clean`), one build row instead of the debug/release pair the Arduino cores do not
  have, and the Project view reports arduino-cli, the board's core and the board instead of cargo, probe-rs and
  rustup targets.

## [0.18.6] - 2026-10-31

### Fixed

- **"The designer needs a board with a panel" on a C++ project.** A sketch carries its board in `sketch.yaml`
  as an FQBN, while the board detector only knew how to read `Cargo.toml` — so every C++ project had *no board
  at all*, and the Designer (which decides from the board whether there is a panel to draw) refused to open one
  even when `designer/panel.hardware.json` named a 2.8" module. The board is now resolved from the design
  document's own `boardId` first (two boards can share one FQBN), then from the FQBN, then from `Cargo.toml`.
- Opening the Designer on a sketch no longer offers to update the Rust vendored crates: a C++ project has no
  `codegen/` and does not build with cargo.

## [0.18.5] - 2026-10-31

### Fixed

- **`#include <Arduino.h>` resolves again, or for the first time.** The editor config pointed the C/C++
  extension at arduino-cli's compilation database and nothing else; when that extension refuses a database
  entry it does so silently, and every header from the core then reads as missing. The config now also names
  the core's own include paths and the compiler that comes with the package, both read from
  `arduino-cli compile --show-properties` — the same answer as the build, in the form that always works.

## [0.18.4] - 2026-10-31

### Fixed

- **Open Designer appears for a C++ project again.** A Designer project was recognised by
  `designer/panel.ui.json` alone, which the C++ side only started writing in 0.18.2 — so a sketch made before
  that had no design document and the sidebar offered no canvas. A sketch is now recognised by its generated
  `src/ui.cpp` as well (only the designer template writes one), and opening it writes the document.

## [0.18.3] - 2026-10-31

### Fixed

- **Moving a pin in a C++ project's Hardware panel now moves it in the sketch.** The Designer's save path had
  been rewritten for Rust only: a sketch keeps its pins in `src/panel.cpp`, and that file is now regenerated
  from `designer/panel.hardware.json` exactly as `src/panel.rs` is for a crate — one source of pins for both
  languages.

## [0.18.2] - 2026-10-31

### Added

- **The Designer opens a C++ project and writes the design as LVGL.** One canvas, two languages: the design is
  the same `designer/panel.ui.json`, and on a sketch the save path writes `src/ui.cpp` (the LVGL object tree),
  `src/ui.h`, and the handler stubs in `src/ui_handlers.cpp` — the append-only file a person owns, with the same
  `on_<widget>_<event>` names the Rust side uses.
- **Views and `navigate`** work in C++ too: each view is a container, the ones not on show are hidden, and a
  navigate event calls `ui_show_view("...")` with no code.
- A C++ designer project is born with the design document and, on a Pico, `designer/panel.hardware.json`, so
  the canvas has something to open.
- **Build / Upload / Monitor / Clean** for a C++ project, with `arduino-cli` diagnostics on the Problems pane
  (evidence: the compiler's JSON, falling back to gcc's text), a missing core offered as a one-click install,
  and Upload flashing exactly what Build produced.

### Changed

- A C++ designer project builds **LVGL 9** on top of the panel driver: `lv_conf.h` in the project,
  `src/lvgl_display.{h,cpp}` with the flush callback and a `millis()` tick. Our build passes
  `-DLV_CONF_INCLUDE_SIMPLE -I<project>` (the README shows the same command for a terminal), and the build
  offers `arduino-cli lib install lvgl` when the library is missing.

### Known limits

- Widgets LVGL has no object for are **reported rather than drawn** in C++: `chart`, `plotter`, `mesh`, `path`,
  `icon`, `status_bar`, `content_indicator`, `crumbs`, `carousel`, `dialog`, `table`, `busy_wheel`, `scale`,
  `spinbox`, `number_picker`, `time_picker`, `clock`, `image`. Everything else emits.
- Fonts and images are not emitted as LVGL assets yet, and the Designer does not rewrite `src/panel.cpp` from
  `designer/panel.hardware.json` (the pins are written when the project is created).

## [0.18.1] - 2026-10-31

### Added

- **A C++ project's editor now understands it.** A sketch's headers live inside the installed core, so the
  wizard asks `arduino-cli` for the compiler command line it would use
  (`compile --only-compilation-database`) and writes `.vscode/c_cpp_properties.json` pointing at it. No more
  red squiggles on `#include <Arduino.h>` or `#include <SPI.h>`, and every `-D` the build defines is there
  too.
- **`Arduino: Refresh C++ IntelliSense`** for when that answer outlives the project: after installing a
  library, upgrading a core, or changing the board in `sketch.yaml`. It also finishes off a project created
  before this version.
- The generated `.gitignore` keeps the compiler database (`.arduino/`) out of source control.

### Fixed

- The C++ `designer` template was called **"WYSIWYG designer (skeleton)"**, which promised a canvas that does
  not exist yet. It is now **"Designer screen (no canvas yet)"**, and its description says plainly that the
  WYSIWYG editor, the events and LVGL are Rust-only until the C++ designer lands.
- The Designer is no longer offered for a C++ project (the sidebar row and its command appear only for a Rust
  Designer project), instead of opening something that cannot edit a sketch.

## [0.18.0] - 2026-10-31

### Added

- **Arduino (C++) as a second language, beside Rust.** New Project now asks which language first, and a C++
  project is a real `arduino-cli` sketch: `sketch.yaml` records the board's FQBN, `<name>.ino` is the entry
  file Arduino needs, and the code lives in `src/` with the same split as the Rust templates.
  - Three C++ templates: **LED blinky**, **panel diagnostic screen** and **WYSIWYG designer (skeleton)** —
    `src/panel.cpp` (the wiring and the panel's init) plus `src/ui.cpp` and `src/ui_handlers.cpp` (the two
    files the Designer owns, and the one a person edits).
  - **No libraries are needed**: the generated sketch draws with its own panel driver, so it builds on a
    freshly installed core. Tested against `rp2040:rp2040` (arduino-pico) 6.3.1 and `esp32:esp32` 3.3.12.
  - Every board in the catalogue has a board definition: `rp2040:rp2040:rpipico{,w,2,2w}` and
    `esp32:esp32:esp32` / `esp32:esp32:esp32s3`. All seven compile.
  - The pins, the controller, the colour order, the mirroring and the rotation come from this extension's own
    board catalogue and panel wiring, not from a datasheet guess.
- A project records its language in `rusty.project.json`. A project **without** that file is Rust, so nothing
  on disk needs migrating — every existing project keeps working untouched.

### Changed

- The wizard, its template menu and the generated file list now go through a **sketch backend**, one per
  language, so the extension's shell stays language-free. The language step is only asked once there is more
  than one language to choose from.
- A C++ project's folder and `.ino` share one identifier (`blinky-pico` becomes `blinky_pico`), because
  Arduino requires it.
- Build, Flash and Monitor on a C++ project say plainly that the `arduino-cli` route is not wired up yet,
  instead of failing with a cargo error about a missing `Cargo.toml`.

## [0.17.14] - 2026-10-31

### Changed

- **The touch keypad's Shift is a phone keypad's Shift.** One tap capitalises **one** character and then goes
  back to lower case by itself; **tapping it twice** (the second tap before a letter is typed) locks capitals on
  until Shift is touched again. Asked for in these words: *"Toggling to upper case must only persist for one
  typed character, then revert back to lower case"* and *"Double tapping the SHIFT key must act like a
  'Shift-Lock' key."*
  - The key has three states — off, one shot, locked — and `press_shift()` moves round them. No clock is needed:
    typing a character is what spends the one-shot (`consume_shift()`), so the second tap of a double tap is the
    one that arrives while the one-shot is still unspent.
  - The design property *shift* ("letters start in upper case") starts the keypad **locked**, because that is
    what the property has always meant; only a tap on the glass can produce the one-letter state.
  - `toggle_shift()` is kept as the old name for `press_shift()`, so a design's own code still compiles.
  - The vendored crate changes, so a project's `codegen/embedded-gui` is refreshed by the usual *Update Crates*
    offer the next time the Designer opens.

## [0.17.13] - 2026-10-31

Everything since 0.13.30 in one release. Versions 0.14–0.17 were built and tested locally; this is the
release that carries them.

### Added — the WYSIWYG Designer on the four Raspberry Pi Pico boards

- **A Pico has no soldered panel, so the panel became a *project* fact**: which module, and which GPIOs it is
  wired to. Three modules — a 1.54" ST7789 (240×240), a 2.8" ILI9341 with XPT2046 touch (240×320) and a 4"
  ST7796 with XPT2046 touch (320×480) — under the same ids the ESP32-DevKitC option already uses, so the facts
  nobody can read off a datasheet (colour order, mirroring, the ST7796's slower clock) are the ones verified on
  real glass. `src/boards/panels.ts` is the single place that knows a legal wiring, and the Designer's panel of
  pin inputs is a *view* of its `validateWiring` rather than a second set of rules.
- **The card socket is its own four pins**, separate from the panel's bus (sharing stays allowed), with an `sd`
  cargo feature and the Designer's switch, as on the CYD.
- **Time on a board with no RTC**: `pico` and `pico2` start from **the time they were flashed** and `picow` /
  `pico2w` use Wi-Fi SNTP, so a clock design works on both without a battery-backed module.
- **Three templates** — `designer`, `display` (panel diagnostic) and `sdcard` — sharing one contract:
  `let (mut hardware, rest) = panel::init(p);`.
- **The pins live in a generated `src/panel.rs`**, which the Designer rewrites when the wiring changes, so
  `src/main.rs` is written once and never rewritten.
- **A `text_lines` widget**: read-only lines of text that fold to the panel width, written by your code — used
  by the test app as a log panel.

### Added — AI Assist reads the evidence the editor already has

- **The selected text is what a question is about.** With a selection in the active Rust file the prompt carries
  the selection, numbered, with a marked window either side — instead of the whole file clipped at 12 000
  characters, which used to cut off the very lines being asked about. Works from the side-bar view *and* from
  the editor-tab chat, which remembers the last Rust editor while it holds the focus.
- **The Problems pane** is in every prompt: errors first, then warnings, deduplicated across providers, rustc's
  explanation cut to its headline, and the cut stated out loud (`… 27 more are not shown`). Hints are left in
  the pane where they belong.
- **The Debug Console** is read through a debug adapter tracker (there is no pane API): output, `[stopped]` and
  `[exited]` kept in order, the tail sent (the end of a console is the failure), the buffer cleared when a new
  session starts.
- **Console only** — a checkbox beside the prompt that sends just the Debug Console, for "what does this output
  mean?" when a defmt stream would otherwise be crowded out.
- **Enter sends, Shift+Enter starts a new line** (`Ctrl`/`Cmd+Enter` still sends); the box says so on its
  tooltip.
- **The chat follows the newest row** while you are at the bottom, and stops the moment you scroll up to read
  something earlier; asking a question starts following again.
- **Abort** stops the answer in flight. It is enabled only while one is running, the partial answer is not kept
  (half a function is what the next question would be answered against), and stopping is reported as a stop, not
  as a failure.
- **The status line stops lying.** It said `not in memory yet; the next request loads it` for a model that had
  just written a whole answer, because "loaded" was only LM Studio's registry. An answer at that address now
  counts, and the line is redrawn when the reply arrives.

### Added — "Fix this line"

- **A quick fix on any diagnostic** — *Fix this line with the AI assist* — that asks the model for **one line**
  and substitutes it for the diagnosed line. It cannot delete anything else: the answer is parsed as exactly one
  line, the replacement must not change the file's bracket balance, and a stripped indentation is put back.
- The prompt is a **patcher**, not a rewriter, and the request is greedy and capped at **200 tokens** so a
  whole function cannot come back. `Longest answer` in the settings still governs every other request.
- Where it cannot work, it says so (`CANNOT FIX`) and points at the function-level fix.

### Fixed

- **A quoted line can no longer replace a function.** Asking about a stray character in a 100-line `main()`
  came back as `async fn main(spawner: Spawner) {9`, and applying it replaced the function with that line and
  left an unclosed brace. An answer that does not close what it opens is now refused outright, and the block is
  labelled `fn main (excerpt)` so the two blocks of a before/after answer can be told apart.
- **A refusal is no longer a dead end**: it offers *Apply the complete block* when the answer has one, *Fix just
  that line* when the compiler points at one, and *Ask for it in full* (which sends the question that asks for
  the whole function) otherwise.
- **An answer that replaces a function with a fraction of it asks first**, by name and with the numbers
  (`replaces 11 lines of fn main with 3 — 6 of them would be deleted`).
- **A fragment is refused**: statements with no item around them have nowhere to go, and used to be pasted
  between `#![no_std]` and `#![no_main]`.
- **A `use`-only answer no longer inserts three blank lines** into the file's header.
- **The answer's shape survives a rescued server**: `chatWithRescue` re-reads the settings for the address but
  keeps the request's own `maxTokens` and `temperature`, so the one-line budget is not replaced by 5120 tokens
  when a llama-server has just been started.

### Known gaps

- The chosen **Full Assist / Rust Assist** mode is not part of the settings snapshot, so a reloaded window comes
  back on Full Assist.
- The Terminal pane is **not** readable through any API; the AI is given captured build output instead, and the
  shell-integration route needs a higher `engines.vscode` than 1.90.

## [0.13.30] - 2026-10-25

### Added

- **Rust Assist**, beside Full Assist in the AI Assist panel: the radio buttons choose the mode. Rust Assist
  watches the active `.rs` file for a `//~ keyword` line and posts worked examples of that construct as the
  answer — `let`, `loop`, `if`, `match`, `fn`, `array`, `slice`, `string`, `struct`, `enum`, `option`,
  `result`, and `mod`/`module` — with every data type spelled out for `let` and the variations beside each other
  for `loop`. It needs AI Assist enabled, and says so instead of doing nothing when it is not.

### Changed

- **Build and flash close only the Build and Flash terminals**, leaving every other terminal alone — the
  shells you are working in and the AI chats you have open survive a build. The sweep of *every* terminal (added
  in 0.13.21 for the port-holder that was flashed over) is what this narrows: Monitor and `probe-rs attach` are
  still closed, because they are ours and they hold the port.

- **The chat is readable at any width.** Long lines wrap in the panel instead of scrolling sideways: the prose
  of a turn, an unbroken token or URL, a compiler message carrying a long path — and now the **code blocks**
  too, which were the last thing that widened the box (`pre` kept `white-space: pre` and `overflow-x: auto`, so
  one long Rust line scrolled the conversation). Wrapped code lines keep their indentation. Measured in a
  browser at 709 px and 320 px: the log, every turn and every block end at `scrollWidth === clientWidth`.

- **Each mode radio carries its name centred directly under it.** `Full Assist` and `Rust Assist` used to sit
  to the right of a radio stretched across half the row — the text field rule gives every `input` the full
  width, so the button ended up alone on its line and its name at the far left. The button is now sized to
  itself with the label centred beneath it.

### Notes

- Test suite: **1095** hermetic (t1 1014 · t2 77 · t3 4).

## [0.13.24] - 2026-10-24

### Fixed

- **A view that is not showing no longer damages the one that is.** With more than one view in a design, the
  code-behind kept ticking every clock, whether or not its view was on the panel. A hidden clock still moves,
  and the engine clears the damage it marks to the background but does not repaint a hidden widget — so black
  blocks appeared on the visible view about once a second (reported on a T-QT design, 2026-10-24).

  Each clock's second tick and each hand-over of the wall clock are now emitted behind
  `if self.view == View::<its own view>`: a clock on a view that is not showing does neither. Designs with a
  single view emit no such test at all, so existing firmware is generated exactly as before.

## [0.13.23] - 2026-10-24

### Fixed

- **The Designer draws your pictures.** An image (or a composite icon's parts) was always painted as a plain
  widget face — the webview cannot read the project's files — so a picture looked like an empty box, and a view
  holding nothing but an image looked like a blank screen (reported on a T-QT design, 2026-10-24).

  The extension now reads each file the design names and sends it to the panel as a data URL, and the **browser**
  decodes it: BMP, PNG, JPEG, GIF and WebP all arrive through the same door, so there is no image parser in this
  codebase to get wrong. `fit` is honoured (`stretch` fills the cell, `center` draws at the file's own size).
  An `sd:` image is still left to the board, a missing file is still reported, and a file over 1.5 MB is not
  shipped through a message.

- **An image whose pixels are not on the canvas says so**: a dashed frame in the selection colour plus the file's
  own name, so a widget that is waiting for its bytes never reads as an empty screen.

### Notes

- Test suite: **1092** hermetic (t1 1011 · t2 77 · t3 4). The canvas half is also measured in a real browser
  (the bundle, a stub of the VS Code API and the bench project's own design): the canvas went from 4 distinct
  colours on that view to 8 257, i.e. the photograph, not a face.

## [0.13.22] - 2026-10-24

### Fixed

- **A design that does not validate no longer writes a `ui.rs` the markup cannot build.** The markup (`ui.kdl`)
  is deliberately only written for a design that validates — but the Rust was regenerated from the document
  regardless, and it names the widgets the markup builds. A save made while the design was momentarily
  incomplete therefore left `src/ui.rs` mentioning a widget nothing compiled:
  `E0609: no field image on type RustyPanelWidgets`, met on a real project (an image whose asset had not been
  chosen yet).

  The Rust is now regenerated only alongside the markup, so the last good pair stays and the project keeps
  building while the design is finished. The design document is still written either way — it is the user's
  work.

## [0.13.21] - 2026-10-24

### Fixed

- **The T-QT's newer panel left its last row and column unwritten.** A complete band of random pixels ran down
  the right edge and the bottom edge of the GC9A01 revision. A full-display clear to red did not reach it, which
  ruled the design out: the glass is bonded **into the controller's RAM off the origin**, so the window
  `display_size(128, 128)` sets at (0, 0) stops short of what the panel shows.

  Panels now record that as a fact of the module (`EspDisplay.displayOffset`, emitted as
  `Builder::display_offset(x, y)`), the same way polarity and colour order are recorded. The offset moves the
  address window and not the logical coordinates, so nothing in a design moves with it; only the GC9A01
  revision declares one. **The two axes differ** — this glass covers RAM 2…129 across and 1…128 down, measured
  on the bench with a one-pixel frame drawn on the design's own edges — and mipidsi swaps the pair itself for a
  vertical rotation, so the catalogue carries one answer for every orientation.

### Added

- **A view can be the one the board starts on.** Right-click a tab → *Start the board on this view*; the tab
  carries a dot and the generated `new()` starts there. The tabs keep the order you gave them — the flag moves,
  the tab does not — and two views marked as the start is refused rather than left to `rustc`.

- **Duplicate view** (right-click a tab) copies a view and everything on it, right after the original: same
  widgets in the same places, ids re-named (`title` → `title_2`, and a copy of a copy counts on rather than
  stacking suffixes), the copy is never a second start view, and the panel switches to it.

- **All views** on the tab strip draws the other views' widgets as dashed outlines. Off by default, because
  what is on the glass is what is on the canvas; the outlines are never hit-tested or snapped to, so turning
  them on cannot change the design. It is the one way to see that a widget was dropped on the wrong view.

- **`navigate` now works wherever a widget reports an event**, not only on the three that raise a click: a
  dropdown switches view when its choice changes, a keypad when Enter is pressed. The switch borrows the event
  the widget already reports (`Clicked`, `ValueChanged`, `Submitted` — in that order of preference for a widget
  that reports several), and still needs no handler.

### Changed

- **Build, Clean and Flash close every terminal the window has open before they start.** A terminal is what
  holds the port: the Designer's clock listener keeps the serial port for the life of the panel, Monitor and
  `probe-rs attach` keep the port or the probe until they are closed, and a shell where `espflash monitor` was
  typed by hand holds it with no record of ours at all. Any of those turns the next flash into “could not open
  the device”, which reads as a hardware fault.

  The sweep is over `vscode.window.terminals` — every terminal, the user's own shells included — because that is
  the only list that covers a holder the extension did not start. The log names what was closed and why, and the
  flash no longer asks whether a Monitor terminal may be closed: it is already gone.

  The clock listener comes back when a flash ends (as before) or when the designer panel is reopened: a build
  does not restart it, so a design that wants its time back needs one of those two.

## [0.13.19] - 2026-10-24

### Added

- **The Designer can hold more than one view.** A design is no longer one screenful: a tab strip above the
  canvas adds a view (`+`), renames one (right-click, or double-click the tab), and deletes one (with its
  widgets, and never the last). Everything else follows the tab you are on — the canvas, hit-testing, the
  widget list, the Properties panel — so a layout can be built a screen at a time.

  A view is a **layer of the one screen**, not a second screen. Every widget is still emitted into the same
  grid, and the generated `ui.rs` hides the ones whose view is not on show, so a switch is a handful of flag
  writes: no rebuild, no re-layout, and the node budget does not double. Two consequences worth knowing:
  widget ids stay unique across the design (so every `on_...` handler and every `app.widgets.<id>` keeps
  working), and a hidden view still occupies its grid cells.

- **A button can switch views with no code.** Tick the new `navigate` event and choose where it goes; the
  generated `pump` calls `show_view` itself, and no handler stub is written for it. `design.show_view(View::X)`
  is still there for switches that are code-driven (a timer, a sensor).

- **Multi-view designs get a `View` enum** in `ui.rs` — one variant per view, `new()` hides the views the
  design does not start on, and `show_view`/`active_view` are the API the app's own code uses.

### Notes

- A **single-view design generates exactly what it generated before**: the markup is byte-identical (that is
  what keeps the goldens meaningful), and `ui.rs` carries no enum, no field and no method. `panel.ui.json`
  gained `version: 3` and a per-widget `view`, which a version 2 file loads without.
- Verified by `cargo check` with the esp toolchain on two generated projects (ESP32-035 and DevKitC with the
  ST7796 module), each with two views and a navigate button: clean and warning-free. Found and fixed on the
  way: the `View` enum was being emitted between the struct's doc comment and its `#[allow(dead_code)]`, so a
  no-touch board got two dead-code warnings.
- Test suite: **1079 hermetic** (t1 1000, t2 75, t3 4), `tsc` clean. Goldens re-recorded for the three
  Designer boards' `panel.ui.json` only.

## [0.13.18] - 2026-10-24

### Fixed

- **The T-QT's newer panel had red and blue swapped.** 0.13.17 fixed its inversion (white came out black);
  with that right, red showed as blue and green was correct — the GC9A01 glass also takes its colour in
  **BGR** order. The catalogue now records that per panel (`colorOrder: 'bgr'` on the GC9A01 revision; the
  older GC9107 stays RGB), and a project generated for it emits `ColorOrder::Bgr`.

  Two facts, two fixes: polarity is the panel's INVERTON setting and colour order is how it reads the pixel
  bytes. A wrong order turns white into a *colour*; an inverted panel turns it *black* — which is how each was
  told apart on the glass.

### Notes

- Verified by `cargo check` with the esp toolchain (vendored crates where the template needs them): T-QT
  `display` and T-QT Designer on the GC9A01 revision — clean and warning-free.
- Test suite: **1066 hermetic** (t1 988, t2 74, t3 4), `tsc` clean. Goldens unchanged: the t3 layer generates
  each board's default revision, the GC9107.

## [0.13.17] - 2026-10-24

### Fixed

- **The T-QT's newer panel drew white as black.** With the **GC9A01** revision chosen, the glass painted the
  negative of every colour: that panel's polarity is inverted, and nothing in the driver's default says so.
  Colour inversion is now a fact of the panel in the catalogue (`EspDisplay.invertColors`), the GC9A01
  revision sets it, and a project generated for it emits
  `Builder::invert_colors(ColorInversion::Inverted)` — with `ColorInversion` imported only where it is used,
  so every other project keeps its imports clean. The older **GC9107** revision is untouched: same board,
  and it was already right.

### Notes

- Verified by `cargo check` with the esp toolchain (vendored crates where the template needs them): T-QT
  `display` and T-QT Designer, both on the GC9A01 revision — clean and warning-free.
- Test suite: **1066 hermetic** (t1 988, t2 74, t3 4), `tsc` clean. Goldens unchanged: they are generated
  with each board's default revision, which for the T-QT is the GC9107.

## [0.13.16] - 2026-10-24

### Changed

- **The console hand-over carries the date.** A board told the time over the cable was given
  `TIME HH:MM:SS` — the hands only — so a board with no network counted the calendar from the RTC's
  2000 base and could not say which day it was. A Designer project now also parses
  `TIME YYYY-MM-DD HH:MM:SS` and tries it first, and both the flash hand-over and the
  **Answer Time Requests** listener write that line *and then* the bare `TIME HH:MM:SS`. That order is
  what keeps an older project working: its parser wants `HH:MM:SS` as the second word, ignores the
  line it cannot read, and takes the bare one exactly as before. The result is a cable alone being
  enough to set a whole wall clock, network or not.

### Notes

- Verified by `cargo check` with the esp toolchain: a DevKitC Designer project (ESP32, classic UART0
  console) and a T-QT Designer project (ESP32-S3, USB-Serial-JTAG console) — both clean and
  warning-free, so both console readers compile with the dated line in front.
- Test suite: **1065 hermetic** (t1 987, t2 74, t3 4), `tsc` clean; goldens re-recorded (6 files:
  `main.rs` + `MainHeader.rs` for the three Designer boards).

## [0.13.15] - 2026-10-23

Covers 0.13.13 and 0.13.14 as well: those builds were packaged and installed while this work was in progress,
and this entry is the version in `package.json`.

### Added

- **A 4" ST7796 320×480 module for the ESP32-DevKitC V4.** Its board option lists a third module, the
  `4-Inch-SPI-TFT-ST7796-320x480-Touch-XPT2046` panel with its own XPT2046 on the shared SPI bus (CS 33, PENIRQ
  36), driven at 24 MHz with BGR colour order and X mirrored — the same controller facts as the ESP32-035's
  panel. Like the other two it is recorded as a cargo feature (`panel-st7796`), so the Designer opens a 320×480
  canvas with touch for that project.
- **The clock keeps the date the network gave.** An SNTP answer now carries the calendar date as well as the
  time of day (`SYNCED_TIME` is a `(year, month, day, hour, minute, second)`), and a Designer project writes both
  into the chip's RTC, so a board that learned the date keeps it across a reset instead of counting from the
  2000 base. A host's `TIME HH:MM:SS` line — what a flash hands over, and which carries no date — now replaces
  only the time of day and leaves the RTC's calendar day alone. The civil-date arithmetic
  (`civil_from_days`/`days_from_civil`) sits in the generated `MainHeader.rs` and is shared by `net.rs` and
  `smtp.rs`.

### Changed

- **The Espressif ESP32-DevKitC V4 board option offers only the WYSIWYG designer and the Bluetooth LE
  peripheral.** Asked for directly. The board still generates its other templates — the panel diagnostic is
  how a display module is brought up, and the board/golden tests build it — but the New Project wizard no
  longer presents them, and the designer is the default it preselects.
- **The 2.8" ILI9341 module is drawn BGR with X mirrored**, which is what the module does; its catalogue entry
  had the controller's own defaults.
- **A Build or Flash terminal closes itself once its command has succeeded**, instead of being left behind for
  the rest of the session. A command that *fails* keeps its terminal, because that terminal holds the compiler's
  or the flasher's own words about what went wrong.

### Fixed

- **The terminal release listens to the terminal, not to the command line.** Matching the command text would
  have left the probe route as dead code — `probe-rs download …` contains neither "flash" nor "espflash" — and
  a stray `cargo` typed in any other terminal could have closed a build that was still running. One listener
  per terminal now, dropped when that terminal's command ends or when the terminal closes.

### Notes

- Test suite: **1065 hermetic** (t1 987, t2 74, t3 4), `tsc` clean. Golden snapshots re-recorded (11 files) for
  the new `panel-st7796` feature and the dated clock.
- Generated firmware verified by `cargo check` with the esp toolchain (vendored crates copied in): DevKitC
  Designer on the ST7796 module (touch, backlight) and DevKitC `display` on the same module — both clean and
  warning-free.

## [0.13.12] - 2026-10-22

Covers 0.13.11 as well: that build (the DevKitC display modules) was packaged and installed while this work was
in progress, and this entry is the version in `package.json`.

### Added

- **The Espressif ESP32-DevKitC V4 carries display modules.** Asked for directly. Its board option now lists
  two: a 1.54" **ST7789 240×240** (no touch) and a 2.8" **ILI9341 240×320 with an XPT2046**, both over SPI on
  GPIO18/23 (MISO 19 on the touch module). The board therefore generates `designer` and `display` projects.
  The chosen module is recorded as a `panel-<id>` cargo feature, which is also what the Designer reads back to
  get the canvas size and the touch controller — the generated `src/main.rs` is written once and cannot be
  queried.
- **Brightness setting for the panel backlight.** A **Brightness** slider (0 % – 100 %, steps of 5) in the
  Designer control bar. The value lives in `.cargo/esp-config.toml` as `BACKLIGHT_BRIGHTNESS` and is read at
  compile time, so changing it never touches `src/main.rs`; a project that does not mention the key is fully
  on, and a typo can never leave the panel dark. The firmware now drives the BL pin by **LEDC PWM** (10-bit,
  5 kHz) instead of holding it on, and inverts the duty automatically for a panel whose transistor switches on
  with a LOW level — the number in the file is always the brightness a person sees. The setting is offered
  **only when the chosen panel has a BL pin wired**, and a project whose `src/main.rs` predates the PWM
  backlight gets the slider disabled with the reason rather than a control that changes nothing.
- **Touch controllers can belong to a display module.** `EspDisplay.touch` complements the board-level
  controller, so a DevKitC with the ILI9341 module drives its XPT2046 exactly as the CYD drives its own.

### Changed

- **The New Project wizard asks for the panel before touching.** Which module is wired decides whether there
  is a touchscreen at all, so the touch question (and the generated `TOUCH_ENABLED` key) now follows the panel
  answer. A panel module without a controller is not asked about.
- **Generated panel docs** name the backlight as PWM and gain a *Backlight brightness* section; the
  `[features]` comment is board-neutral instead of talking about LilyGo on an Espressif board.

### Fixed

- **The `touch` and `board` templates did not compile.** Both emitted a Designer-only clock hand-over block
  that referenced an undefined `screen` (`E0425`), left behind when the RTC/host-time feature landed in
  0.13.0. Found by compiling the generated projects; the block now exists only for Designer projects, and
  `wall_clock`/`wall_clock_applied` are only part of `State` where a design can be told the time.
- **A DevKitC project used the wrong panel.** The Designer and the generator read `board.displays[0]` and
  `board.touch`, so an ILI9341 project opened a 240×240 canvas, offered no touch and generated touchless
  firmware. Both now resolve the panel from the project's manifest (`displayForProject`) and the controller
  from the panel (`touchFor`), across the sketch, imports, dependencies, `ui.rs` and `DESIGNER`/`TOUCH`.
- **No-touch Designer projects carried two warnings**, and the panel advised switching touch on where no
  controller exists. `touchEnabled` is now false when the chosen panel has no controller, and the advisory is
  only raised when there is something to switch on.
- **An unused `esp_hal::ram` import** in the `touch` and `board` templates (it is only a Designer heap).

### Notes

- Test suite: **1063 hermetic** (t1 985, t2 74, t3 4). Goldens re-recorded (47 files) and DevKitC
  `designer`/`display` snapshots added.
- Cross-compiled with the ESP toolchain, warning-free, for seven generated projects: DevKitC `designer`
  (ST7789), DevKitC `designer` (ILI9341 + touch), T-QT `designer` (active-low), T-QT `display`, CYD
  `designer`, CYD `board` and CYD `touch`.
- No crate change, so existing Designer projects do **not** need *Update now* for their `codegen/` copy; a
  project generated before this version keeps its old `main.rs` (hold-the-pin backlight) until it is
  regenerated or patched, which the Designer says out loud.

## [0.13.10] - 2026-10-21

### Removed

- **The *Install .deb* row in the Controls section of the sidebar.** Asked for directly. The
  `rustyPlatform.installDeb` command remains in the Command Palette: installing a package into `/usr` with sudo
  is a deliberate act, not something to keep one click away beside Build and Flash. *Publish .deb* and
  *Back Up Project* stay in the section.

### Notes

- Test suite: **1050 hermetic** (t1 973, t2 73, t3 4).

## [0.13.9] - 2026-10-21

Intermediate local builds 0.13.5–0.13.8 were packaged and installed while this work was in progress; this
entry covers the batch and is the version in `package.json`.

### Added

- **Keypad cursor keys and overwrite typing.** The touch keypad's bottom row is now `CLR | <- | -> | ENT` on
  all three pages (`0.13.5`). The two keys move the cursor one character, and the next key **overwrites the
  character under it** rather than only appending; Backspace deletes the character before the cursor. The
  caret is painted as a 2-px underline under the character that will be replaced (it used to be a `_` glyph
  after the line), and the entry box scrolls to keep it in view. Backspace is labelled **BKSP** now — a lone
  `<` beside two arrows would read as a third one.
- **SD and SMTP are toggle switches in the Designer control bar** (`0.13.6`, `0.13.9`). Both were/are
  *cargo features* — `sd` pulls in the FAT filesystem, `smtp` compiles `src/smtp.rs` and spawns its task — so
  they are on/off switches rather than a menu of values. The SMTP switch is offered disabled until the wizard
  has written the client, and both write only the `default = [...]` line of the generated manifest.
- **A settable Clock *Number inset*.** The hour numbers' displacement is now a Designer property in
  **character widths, stepped by 0.1** (default `0.5`; `0` restores the pre-2026-10-21 position), carried
  through the crate, the markup (`label_inset=0.5`), the code generator and the canvas.
- **The ESP32-035's board option offers the WYSIWYG designer alone** (`0.13.6`). The board still *generates*
  every template it supports (the panel diagnostic remains the way its glass is brought up, and the board and
  golden tests build it), but picking the board in the New Project wizard no longer asks: its one offered
  template — and its default — is the Designer.

### Changed

- **One radio task for the clock and SMTP.** `peripherals.WIFI` can be moved once per boot, so `smtp_task`
  now owns it and also performs the clock's SNTP query when the design needs one, publishing through
  `crate::net::SYNCED_TIME`. `main.rs` emits two `#[cfg(feature = "smtp")]`-gated spawn statements, so exactly
  one task exists per build. Previously SMTP was spawned only on boots where the clock did *not* need the
  time, which meant a clocked design never sent a post on a cold boot.
- **The Designer's SD control is a switch, not an `SD: on / SD: off` select**, mirroring Touch's neighbour.
- **The clock's hour numbers sit half a character inside the tick ring** by default (asked for, then
  softened from a whole character the same day).

### Fixed

- **The SMTP wizard's `main.rs` wiring did not compile.** `Spawner::spawn` returns `()` in embassy-executor
  0.10, and the emitted else-branch called `.unwrap()` on it.
- **A multi-line SMTP reply hung the keep-alive task.** The reply parser tested the *first* line's separator,
  so a normal `EHLO` response (`250-PIPELINING`, `250-AUTH`, …) never finished; it now tracks the current
  line's code and separator.
- **Malformed mail headers.** `Subject: ` was written as a line of its own, leaving the subject text as a
  malformed header; headers are now whole, `From:`/`To:` are included, and a body starting with `.` is
  dot-stuffed.
- **A window reload silently dropped the stored SMTP setup.** The build environment lives in the extension
  host, so a Flash/Build after a restart baked an empty `SMTP_HOST`; `ensureSmtpEnv` now re-injects it on
  Build, both Flash routes and Debug.
- **An SD/SMTP switch could lie on an older project.** A manifest without a `[features]` table is refused out
  loud, and the panel's report carries the manifest's own state back so the switch resets.
- **Dead-code warnings on a merged build.** `net.rs`'s clock task is compiled but unspawned when SMTP owns the
  radio, so it carries `#![allow(dead_code)]` with the reason (the wizard adds it to older projects).

### Notes

- Test suite: **1050 hermetic** (t1 973, t2 73, t3 4), plus the crate suites: `embedded-gui` **317**,
  `embedded-gui-codegen` **30**. `cargo check` with a Designer project's feature set
  (`--no-default-features --features "rich-widgets,embedded-graphics,macros,micromath"`) is warning-free.
- Verified by `cargo check` on the ESP toolchain for a freshly generated CYD Designer project in all four
  `smtp`/`sd` combinations, and by corrupting `smtp.rs` with the feature off (ignored) and on (compiled).

## [0.13.4] - 2026-10-21

### Added

- **SD card toggle in the Designer control bar.** The Sunton CYD (the only board with an SD slot) now has an
  *SD: on/off* switch in the Designer toolbar, mirroring the existing Touch toggle. SD is a *cargo feature*
  rather than a `.cargo/esp-config.toml` key, because enabling it is what adds the file system to the build: the
  generator declares `embedded-sdmmc` (FAT) and `critical-section` as `optional` dependencies behind an `sd`
  feature that ships `default`-on, and gates `#[cfg(feature = "sd")]` around `mod sd;` and the `sd::init(...)` call.
  The toggle rewrites that `default` line in `Cargo.toml` from the extension and posts a rebuild note; designs
  that name `sd:/NAME.BMP` images are flagged on save while the card is off. The dedicated `sdcard`/`board`
  templates keep SD mandatory and ungated, since those projects exist to mount a card.

### Notes

- Test suite: 1038 hermetic (t1 963, t2 71, t3 4).

## [0.13.3] - 2026-10-21

### Added

- **SMTP over Wi-Fi wizard.** A new *Set up SMTP over Wi-Fi…* command (palette entry and Designer
  control-bar button) guides the user through the relay host/port/credentials, STARTTLS, and a
  keep-alive post (sender, comma-separated recipients, cadence, subject, body). The credentials live
  in the editor keyring only — never in the project tree — and are injected into builds as
  `option_env!("SMTP_*")` variables, the same contract the Wi-Fi templates already use. The wizard
  writes a self-contained ESP32 `smtp_task` into `src/smtp.rs`, declares `mod smtp;` and spawns the
  task beside the clock in `src/main.rs`, and adds the `tcp` feature to `embassy-net` plus a direct
  `embedded-io-async` dependency to `Cargo.toml`. Re-running it overwrites the project files in
  place and refreshes the build environment.
- **Clock time over serial and Wi-Fi.** A design's clock follows the host PC's time: when the chip's
  RTC has never been set the firmware asks once a second (`TIME?`), and the Designer answers from the
  PC's clock, keeping the port open across cold boots. The listener is closed while Flash or Monitor
  hold the port and restarted when the flash command ends. A board with no PC on the cable falls
  back to Wi-Fi SNTP via a generated `src/net.rs`, and new ESP projects bake in the host's UTC offset.
- `HAS_CLOCK` is emitted as a `const` in `ui.rs`, and the clock-movement code (the tick bookkeeping
  and the `tick_clocks` call) is only generated when the design has a clock — a design without one is
  unchanged.

### Fixed

- **The generated `src/smtp.rs` now compiles.** `option_env!` is const, but `str::parse`, `str ==`,
  `Option::map_or` and lifetime elision across two inputs are not, so the port and STARTTLS flag are
  parsed and compared with hand-rolled `const fn`s; the DNS `Result` is flattened before `.first()` is
  called on it; the resolve return type is `core::net::Ipv4Addr`; `TcpSocket` borrows are spelled as
  `TcpSocket<'_>`; and `base64_encode` ties its input and output buffer with one explicit lifetime.
  The fix is pinned byte-for-byte against the compiling `retest` project, and a new t1 case locks each
  of them in.

### Notes

- TLS is recognised but not wired: with STARTTLS set the generated module logs a warning and sends in
  the clear on the LAN (a `no_std` TLS stack is the only missing piece; the firmware already has an
  allocator to back one).
- The SMTP password is the same identity class as the Wi-Fi credentials: both are merged into the
  environment of every `cargo` invocation the extension starts (terminal, Build, Debug, Flash), and
  the terminal cache key now folds in the SMTP env version so a terminal opened before the prompt is
  not reused after it.
- Test suite: 1029 hermetic (t1 954, t2 71, t3 4).

## [0.12.2] - 2026-10-19

The font size box is gone, and a font can be deleted from the list that chooses it.

### Added

- **Right-click a Font list to delete the font it names.** The menu appears only for a font the design
  declares -- there is nothing to delete about `(default)` or a face built into the crate, so those keep the
  browser's own menu. Deleting takes the declaration out *and* clears the reference from every widget that
  used it, in one undo step, which is what deleting a font means: a widget left pointing at a name that no
  longer exists is a validation error to hunt for.
- The menu item is marked as destructive and names the font, so a wrong click is obvious before it happens.

### Removed

- **The font size box beside the Font list**, at your request. A size could only ever be a redraw of the kept
  face, and the import's size prompt already covers the case; the machinery behind the box went with it (the
  `resizeFont`/`fontResized` messages, `state.setFontSize`, and the editor's redraw handler).
- What stays: the import still records the face and the size, because they are what the Font list shows
  (`DejaVu_24 (24 px)`) and what the Fonts section states (`Drawn from assets/... at 24 px`).

### Notes

- Deleting a font removes it from the design, not from `assets/`: the files are yours, and the Fonts list's own
  Remove button has always behaved that way.
- Test suite: 995 hermetic (t1 920, t2 71, t3 4).

## [0.12.1] - 2026-10-19

The canvas drew the default face for a font that was selected in the Font list.

### Fixed

- **A declared font now reaches the canvas on widgets that carry it in their style** -- the clock, a toggle, a
  spinbox and the rest. `designStyle` only ever put a *built-in* font into the style, so the markup named the
  imported face while the canvas went on painting the default one: the Font list showed the selection, and the
  design drew something else. It now takes the same route the markup does, asking the glyph table whether it
  has the face's pixels (they come from the extension, not from the design).
- New test (`designer-font-style.test.js`) paints one clock twice with two fonts of different weight and
  compares the ink with the default: a heavy face must paint more, a one-row face less. Before the fix both
  painted exactly the default's 195 501 pixels.

### Notes

- Test suite: 996 hermetic (t1 920, t2 72, t3 4).

## [0.12.0] - 2026-10-19

An imported system font is now reachable on **every** widget that offers a Font field, it says which face it
came from and at what size, and that size can be changed afterwards.

### Fixed

- **A declared font is offered wherever a Font field is.** Widgets that read only a style -- the clock, a
  button, a toggle, a spinbox -- listed the crate's own faces and nothing else, so an imported system font was
  in the design but invisible in the list, and the field read `(default)`. The font now reaches those widgets
  through `style.font = FontId::Bitmap(&__FONT_<ID>)`, the same bitmap static the codegen writes for a label's
  `font=` attribute. Labels and carousels keep the attribute route.
- **Import a Font** now points the selected widget at the new font, as the Font field's `...` always did --
  which is the other half of "it defaults to Default".
- A font name that is set but no longer declared is shown as `name (not in this project)` instead of drawing
  an empty box.

### Added

- **A size box beside the Font list.** For a font drawn from a system face it shows the pixel size and
  redraws the face when it changes, so a font imported at 24 px can be tried at 18 or 32 without starting
  over. It is disabled -- with a tooltip saying why -- for the crate's own faces, for a plain BDF, and for
  anything with no face behind it: a BDF is a bitmap, and a size that is not a redraw would be a scale.
- The import keeps the face it drew from in `assets/`, and the declaration records both the face and the size,
  so a later resize redraws the original rather than enlarging pixels. The Fonts list shows
  `Drawn from assets/<face> at <n> px`.
- Declared fonts are named with their size in the Font list: `DejaVu_24 (24 px)`.

### Notes

- Changing a font's size changes every widget that uses it, because a font is one drawing -- the tooltip says
  so. The change is one undo step, however many sizes you try.
- The emitted style was checked with the crate's own code generator (`tests/sim --bin expand`):
  `add_clock_styled(..., { let mut style = Style::label(); style.font = FontId::Bitmap(&__FONT_X); style })`.
- Test suite: 995 hermetic (t1 920, t2 71, t3 4).

## [0.11.1] - 2026-10-19

The Font field's `...` button could only see `.bdf` files, so a system font had to be found through the palette
command instead of where the font is actually chosen.

### Fixed

- The Font field's `...` picker now offers `.ttf`, `.otf` and `.ttc` as well as `.bdf`, and draws anything that
  is not a BDF into one at a size you pick -- so choosing a system font from a widget behaves exactly like
  **Import a Font**: the BDF is written to `assets/`, declared, and selected for that widget in one undo step.
- Cancelling the size prompt dismisses the request instead of leaving the field waiting, and a face the
  browser cannot read puts its reason beside the field.
- Importing the same face at the same size twice reuses the existing `assets/<name>.bdf` rather than writing an
  identical `_2` copy, so a project does not collect duplicate fonts every time a field is used.
- The same filter list feeds both font dialogs, and the button's hint says what a non-BDF is about to become.

### Notes

- Test suite: 989 hermetic (t1 918, t2 67, t3 4).

## [0.11.0] - 2026-10-18

Adapt a system font: **Rusty Platform: Import a Font...** turns a TTF or OTF into a project BDF the designer
and the crate both already understand.

### Added

- **Import a Font** (Command Palette). Picks a `.ttf`/`.otf`/`.ttc` or an existing `.bdf`, asks what pixel
  size to draw it at, and writes `assets/<name>-<size>.bdf` into the project with all 95 printable
  characters. The face is rasterised by the webview -- the only renderer this extension has -- and the file
  is written by the extension, which is the side that knows where the project is.
- The result is declared in the design straight away (one undo step), so it appears in every widget's Font
  list and is drawn on the canvas at its real pixels.
- A `.bdf` chosen in the same dialog skips the rasterising and is copied in as-is.
- Refuses politely when no designer is open, since an imported font is declared in a design.

### Notes

- The cell is the union of every glyph's ink, measured from one shared pen origin and baseline, so a
  proportional face keeps its relative placement. Ink is thresholded at half coverage: anti-aliased fringe
  below that is not baked into the font.
- The importer's arithmetic lives in `src/designer/fontRaster.ts` behind a canvas-shaped interface, so it is
  held to a measurement table in the tests rather than to whatever the browser produced. The BDF writer
  round-trips through the project's own reader: what the canvas drew is what the board draws.
- Test suite: 988 hermetic (t1 917, t2 67, t3 4).

## [0.10.0] - 2026-10-18

The rest of the font issues from 0.9.0: the 5x7 that was asked for, and a declared font that the canvas can
finally draw as itself.

### Added

- **`FontId::Medium5x7`** -- *Medium 5x7 (drawn)* in the Font field. A hand-drawn bitmap face, five columns by
  seven rows with a six-pixel advance, in the classic LCD character set's style: 80 characters across the
  480-pixel panel, a real lower case, and every printable character. Drawn and not rasterised because that is
  exactly the size where an outline face loses its letters (`NOTES.md` §148 measured it).
- About **0.7 KB** of flash, and no new type: it is a `BitmapFont`, the same route the rasterised faces take.

### Changed

- **The canvas draws a declared BDF font as itself.** It used to approximate one with the packed 3x5 default,
  which made any widget with a real face a lie in the preview. The panel cannot read a file, so the extension
  now parses each declared font (`src/designer/bitmapFont.ts`, a faithful port of the crate's `parse_bdf`
  -- same cell cropping, same per-glyph placement against the baseline) and sends the pixels with the
  document; `registerDesignFont` puts them beside the built-ins, where every measurement and every glyph
  lookup already goes. The pixels are only resent when the declarations change.
- Glyph rows are read by division rather than `1 << (columns - 1 - col)`, because a declared BDF may be wider
  than 32 columns, where a shift silently wraps.

### Tests

- crate **309**; extension **976** -- including a t1 file that parses the *crate's own* BDF fixtures and asserts
  the same numbers, and a t2 test that proves a declared font paints seven-row ink (the 3x5 fallback cannot).

## [0.9.0] - 2026-10-18

*"Those fonts are really terrible. Can we import some fonts from the internet or adapt system fonts?"*

They were: every built-in was a 3x5 bitmap, `Medium4x7` was that same drawing in a wider cell, and nothing in
the crate had a curve. Two faces are now rasterised from a real outline font.

### Added

- **`FontId::Mono6x10` and `FontId::Mono8x16`**, offered as *Mono 6x10 (DejaVu)* and *Mono 8x16 (DejaVu)* in
  the Font field. DejaVu Sans Mono, rasterised by FreeType's **monochrome** path (which grid-fits stems to whole
  pixels -- the anti-aliased render was grey mush at every size tried) into a 6x10 or an 8x16 cell:
  7-pixel advance and 12-pixel lines, or 9 and 19.
- The tables live with the other font assets (`crates/embedded-gui/assets/fonts/dejavu_*.txt`), are read by
  `build.rs` like the 3x5 overrides, and are reproducible from the TTF with
  `crates/embedded-gui/assets/fonts/from_truetype.py`. The Bitstream Vera licence travels with them.
- Flash cost: about **2.5 KB** for both faces, linked once.

### Changed

- **The clock's numerals follow the chosen face.** `label_ink_box` measured every face as three columns by five
  rows, and `draw_scaled_text` drew from the packed 3x5 table, so a big face would have drawn 3x5 numerals in a
  box measured for it. Both now ask the face (`font::glyph_ink_box`, `font::for_each_glyph_pixel`).
- The designer's canvas carries all seven faces: `tests/tools/glyph-table.js` now emits per-font width and
  height, and the canvas draws a glyph of any size from that rather than assuming 3x5.
- `build.rs` declares `rerun-if-changed` on the font folder. It declared only `rerun-if-env-changed`, and once
  any `rerun-if-*` is printed cargo stops scanning the package -- so editing a glyph table changed nothing until
  something else rebuilt the script.

### Not done, and why

- **A 5x7 face was the plan and is not here.** Rasterised below a 9-pixel em, DejaVu's letterforms collapse --
  `a`, `e` and `s` end up the same blob -- and the result was worse than the 3x5 it was meant to replace. A 5x7
  works when the glyphs are *drawn* at 5x7, which is a hand-drawing job rather than a rasterisation one.

## [0.8.0] - 2026-10-17

*"The shift key is not toggling uppercase/lowercase. Also, it seems that the the fonts does not
support symbols. check please."*

Both were the built-in 3x5 face, and both were real.

### Fixed

- **The face has lower case of its own.** `build.rs` folded case with `to_ascii_uppercase`, so `q` and
  `Q` were the same five rows: a keypad's Shift key changed the string and nothing a finger could see.
  The widget had grown a private capital table to paper over it, which changed the *centring* and not
  the shape. The table now carries a real lower case, the workaround table and its drawing path are
  gone, and `a`..`z` differ from `A`..`Z` on the glass and in the typed line.
- **Every printable character has a glyph.** Only nine punctuation marks did; the rest -- the whole
  `~ # $ ^ & ( ) = + [ ] \ { } | ; ' " , / < >` set -- fell through to the fallback, so a symbol page
  of keys each showed the same box. All of printable ASCII 32..126 is now drawn, and the fallback is a
  solid block rather than a hollow one (which was `0`'s own shape, so an unsupported character read as
  a nought).
- The designer's canvas is regenerated from the crate (`node tests/tools/glyph-table.js`), so the
  preview shows the same lower case and the same symbols.

## [0.7.9] - 2026-10-17

*"Place an 'Update Time' button in the Clock widgit's settings pane. This button must update the RTC on
the module but only if a Clock widget was dropped in the canvas. It must fail gracefully if no module is
connected."*

### Added

- **Update Time, in the clock's own pane.** It sends the same `TIME HH:MM:SS` line a flash sends, on the
  same port Flash would pick (so `rustyPlatform.serialPort` is honoured), without rebuilding anything --
  which is what a board that has drifted, or one that has been running since yesterday, needs.
- **The refusal is a sentence, not a spin.** No clock in the design, no board on a port, or a port that
  will not take the line (a Monitor terminal holds it) each come back as one line in the panel and a
  notification, with the shell's own words when there are any. Nothing throws: a designer click must
  never be an exception.
- The rules live in `src/flash/clockSync.ts` where a test can inject the shell runner, so "the line that
  would have been written" is asserted without a device on the bench.

## [0.7.8] - 2026-10-17

*"The text must be left-justified in the box (just centred between the top and bottom edges). Also,
change the cursor to an underscore character."*

### Fixed

- **0.7.7 read that request the wrong way.** The typed line was centred across the whole box, which
  makes a line jump sideways as it grows. It is left-justified again -- three pixels in, where it
  always was -- and only centred between the top and bottom edges, which is what was being asked for.
- **The caret is an underscore**, sitting on the line's own baseline instead of a bar running the
  full height of the glyph box. The designer's canvas draws the same.

## [0.7.7] - 2026-10-17

Asked for 2026-10-17: *"On the keypad, insert a numerical keys row above the 'qwerty' row ... change
the text on the '123' key to '%%...' ... A 'shift' keeps the numericals unchanged."* and *"centre the
text horizontally in the centre of the box"*.

### Changed

- **The letters page carries a row of digits above `qwerty`**, so a phone number can be typed without
  leaving it. Shift leaves those digits alone -- in the string and on the glass.
- **Two pages, not three.** With digits on the letters page, a page of nothing but digits was a second
  way to type the same ten keys, so the mode key goes letters ⇄ symbols and reads `%%...` on the
  letters page and `ABC` on the symbols page. A design whose `mode` starts at `numeric` still gets
  that page, and its mode key takes it back to the letters.
- **The symbol page is the set that was asked for**: `~!@#$%^&*()-=_+[]\{}|;':",./<>?`, in that
  order and broken at eight, in four rows. All three pages keep six rows, so switching pages does not
  resize the keys under a finger.
- **The typed line is centred in its entry box**, on both axes, instead of starting three pixels from
  the left edge. A short line is centred whole -- text and caret together -- and a line long enough to
  fill the box takes it edge to edge, so the text does not drift as it grows.
- A test measures the ink of the typed line against the box: it reads 14.5 against 159.5 on the old
  drawing, so the centring cannot silently regress.

## [0.7.6] - 2026-10-17

*"The minute hand must only redraw when sufficient time has passed so that the hand have passed more
than half of the time between minute ticks ... The hour hand can update every minute."*

### Changed

- **The hands step instead of creeping, and only the ones that moved are repainted.** The minute hand
  takes half a minute tick at a time -- on the mark for the first thirty seconds, halfway between
  marks for the second thirty -- and the hour hand counts whole minutes only. The second hand, which
  really does move every second, is the only hand a tick normally touches.
- The damage for a time change is now measured from the hands that moved, not from all three: a clock
  that repainted its long minute hand sixty times a minute (for the fifty-eight seconds it was not
  moving) now paints it twice. `ClockWidget::hand_damage_rect` is the new measurement;
  `hands_rect` still answers for the whole face.
- The designer's canvas draws the same hand angles, so a design previews what the panel will show.

## [0.7.5] - 2026-10-17

### Fixed

- **The keypad's typed line is set in the keys' own face.** The entry box reserved a line at the
  style's height and then drew the text in the library default (3x5), so a design using a larger face
  showed full-size keys above a line of text half their size. The caret follows it.
- A test draws the line at `Scaled6x10` and measures the ink in the entry box, so the two cannot drift
  apart again -- it reads 5 rows on the old code and 10 on the fix.

## [0.7.4] - 2026-10-17

*"The screen draws complete but then crash."* -- the log ended on `design: painted 480x320 in 691 ms`,
which was the loop stopping rather than a panic.

### Fixed

- **The console read no longer blocks the main loop.** `esp-hal`'s `Uart::read` *waits* for a byte when
  the FIFO is empty ("If the hardware buffer is empty, blocks until data is available"), so the first pass
  through the loop stopped dead after the first frame and waited for a byte that never came. It is now
  guarded by `read_ready`, which costs one register read and answers at once. Two lessons worth keeping:
  the 0.7.2/0.7.3 `.expect` was **not** the crash -- the UART opened fine -- and a firmware that paints
  once and then goes quiet is a loop that stopped, not a panic.

## [0.7.3] - 2026-10-17

*"project retest board is crashing after flash."*

### Fixed

- **The console UART can no longer take the panel down.** 0.7.2 opened UART0 with `.expect("console
  UART")`; a configuration the driver refuses is now a warning and the timer fallback, not a panic at
  boot. The receiver is optional in the state, and the loop reads it only when it opened, so a board that
  cannot give the console to the reader runs exactly as it did before the clock was made to follow a wall
  clock.

## [0.7.2] - 2026-10-17

*"The esp32 module have a RTC on-board. Drive the clock from the RTC instead of a 1 second timer. On boards with
no RTC, the timer steps in. Set up the RTC with the local system time when the firmware is flashed."*

### Added

- **The design's clock follows a wall clock when the board has been given one.** An ESP32's internal RTC has
  no battery, so the board cannot know the time after a power cycle -- the toolchain hands it over instead:
  `flash` now sends `TIME HH:MM:SS` (the PC's local time, no zone) down the console two seconds after the
  write finishes, and the generated `main.rs` reads it off UART0 (non-blocking, so a quiet console costs one
  register read a pass) and calls `Designer::set_wall_clock`. From then on the hands are *set* to what the
  anchor says rather than stepped by a count of ticks, so a slow frame or a sleeping loop cannot make the
  clock lose a second. `wall_clock()` reads the time back.
- **Without a wall clock the one-second timer still steps in**, which is the old behaviour exactly: the
  design's own hour/minute/second advanced by the seconds that have passed.
- The hand-over belongs *between* the flash and the monitor (`espFlashCommand` / `espFlashAndMonitorCommand`
  take an optional `ClockHandover`), written by the platform's own shell: `stty` + a redirect on a POSIX
  shell, `System.IO.Ports` in PowerShell. No serial library or native module was added.

### Notes

- The console reader is in the **touch** designer template (the CYD and its like). A designer project on a
  panel with no touch controller keeps the timer fallback, and the wall clock's API is there for the app to
  call directly (`set_wall_clock`).
- An external, battery-backed I2C RTC is the door this leaves open: the same `set_wall_clock` call is where
  its driver would hand the time over, so nothing above it has to change.

## [0.7.1] - 2026-10-17

For the keypad: *"replace 'C' with CLR, 'E' with ENT and shift with SHIFT (the shift key must be a toggle
key - caps lock). The key pad text must change with the shift state."*

### Fixed

- **The keys that act are labelled with words.** `CLR`, `ENT` and `SHIFT` replace `C`, `E` and `^` -- `C`
  and `E` read as letters of the alphabet on a keypad that types them. Backspace keeps its arrow.
- **Caps lock is visible.** Shift stays on until it is pressed again (it always did), but the built-in
  `Tiny3x5`/`Scaled6x10` face is a landmark font whose `a` and `A` are the same bitmap, so the letters on
  the glass never changed. The keypad now carries its own capitals for those faces and draws them at the
  face's own block size; a bitmap or vector font of the design's own is left alone, since it may have
  capitals of its own. The Shift key also wears the pressed face while caps lock is on, so the state is
  visible on the key itself.
- The designer canvas follows both: the words, the upper-case letters when the design starts shifted, and
  the lit Shift key.

## [0.7.0] - 2026-10-17

A new widget, asked for in full: *"Build a touch keypad ..."* -- a one-line entry box on the keypad's top
edge, three key sets (letters, digits, symbols), Shift, Backspace, Clear and Enter, and font and colour
settings.

### Added

- **`keypad`, a touch keypad in one widget** (`crates/embedded-gui/src/widgets/keypad.rs`). It fills the
  bottom of the panel -- a third of it in portrait, half in landscape -- so the designer pins its box
  there (`placeWidget`/`pinKeypads`) instead of leaving it to be dragged, and re-solves it when the
  rotation changes. Which of the two versions it draws follows the *panel*: the box spans the panel in
  both orientations, so its own aspect cannot tell them apart.
  - Keys stretch to fill the width in five rows, so the same face works at 320x480 and 480x320: ten
    letters across in text mode, three digits in numeric mode, eight symbols in symbol mode, plus the
    control rows.
  - The mode key cycles letters -> digits -> symbols and says where it goes; Shift toggles capitals; the
    typed line scrolls to keep its end in view.
  - Backspace deletes one character (not one byte), Clear empties the line, and Enter submits it: the
    line is handed to `on_<id>_submitted(text: &str)` and the box is cleared for the next one.
    `UiEvent::Submitted(id)` is the new event; `keypad_submitted(id)` is what the handler is given.
  - Seven colours are settings: typed text, key face, legend, pressed key, the accent worn by Shift / mode
    / Backspace / Clear / Enter, and the entry box's face and border. The font (and the size it measures)
    comes from the style, like every other widget.
  - A tap repaints the key and the entry box, not the face; a finger that slides off a key cancels it.

### Changed

- `set_keypad_text`, `set_keypad_mode`, `set_keypad_shift`, `keypad_text`, `keypad_submitted`,
  `keypad_mode` and `keypad_shift` are the app's route into a keypad's line and mode.
- The generated handler stub now logs a submitted line (`... fired: {}`) rather than leaving the
  argument unused, so a fresh project builds with no warnings.

## [0.6.2] - 2026-10-17

Three more from the same panel: *"Remove the Time Picker widget from the toolbox"*, *"The complete clock
widget is redrawn at 1 sec intervals. Only the hands should be redrawn as and when needed"*, and *"When I try
to drag the slider, or when long touching the screen, the screen calibration routine fires???"*.

### Changed

- **The Time picker is no longer in the Toolbox.** It is the Clock's older cousin and both in one palette
  invited the one that cannot run. It stays in the catalogue: a design that already contains one keeps
  working, keeps its properties and its handler, and still validates (`toolboxOffers` in the catalogue).
- **A running clock repaints only its hands.** A time change used to damage the clock's whole cell, so every
  second drew sixty ticks, twelve numerals and the frame again. The damage is now the union of the hands
  before and after the change (`ClockWidget::hands_rect`), which never reaches the rim -- the old second hand
  is erased over the few hundred pixels it used, and the face is left alone.

### Fixed

- **A slider drag, or a long touch, could throw a good touch calibration away.** The "forget the calibration"
  gesture was *any touch in the first two seconds after a reset*, which caught the ordinary touch of someone
  testing a slider straight after a flash -- and then the next touch started measuring corners. The gesture
  is now a finger held still in the top-left corner for about two seconds: a drag moves (so it never
  qualifies), and a press anywhere else, or a long press on a widget, clears the count. The README says so,
  and the boot window is gone entirely.

## [0.6.1] - 2026-10-17

Three reports from a real panel: *"Clock not running"*, *"the clock hand's previous positions are not erased as
the new positions are drawn"*, and *"the slider grab handle is not working (does not drag via the touch
screen)"*.

### Fixed

- **A clock's movement only ran while a finger was on the panel.** The generated `main.rs` asked the design
  whether it was dirty *inside* the touch branch (`if calibrated && (pressed || was_touched)`), so an idle panel
  never painted and a clock sat at whatever time it was flashed at. The design is now polled on every pass, after
  the touch handling, in both designer loop bodies -- the touch one and the paint-once-then-sleep body a panel
  without a touchscreen gets (which now polls every 100 ms instead of sleeping ten seconds, and keeps the design
  in `State` so the loop can ask it anything at all).
- **A moving clock left its hands behind.** A design paints no screen background of its own and the panel is
  cleared once, so a partial repaint only covered the pixels the new hands reached. The generated `render` now
  clears each damaged region to `SCREEN_BACKGROUND` before repainting it (new `GuiContext::paint_damage`), which
  makes a partial repaint pixel-for-pixel what a whole one would produce.
- **The slider's grip could not be dragged.** The value only ever moved from the arrow keys: a press focused the
  slider and drew it pressed, and every move was ignored. A press now puts the grip under the finger and every
  move carries it, through the same geometry the renderer draws with (`slider_value_at_x`), so the pixel pressed
  is the pixel seen. A press elsewhere on the panel still leaves the slider alone.

### Changed

- `set_clock_time`, `advance_clock` and `clock_time` are gated behind `rich-widgets`, like the clock widget they
  address: a `--no-default-features` build failed on them.

## [0.6.0] - 2026-10-17

Asked for as *"Add code behind to attach the clock widget to a 'movement' engine driven by a 1 sec timer. The
code behind must sync the three clock hands. The engine can be attached to the widget with a checkbox in the
clock settings panel."*

### Added
- **A clock's movement, as generated code-behind.** `Run (movement)` — a checkbox in the Clock's properties,
  on by default — makes the designer generate a one-second engine in the project's `ui.rs`:
  - it reads **embassy's clock** when the app paints, so nothing has to be awaited in `ui.rs` and no line of
    `main.rs` changes — the loop that already asks `is_dirty()` is told "yes" once a second;
  - it advances each attached clock by **every second that has passed**, so a frame that took two seconds
    does not make the hands lose one, and a panel that has been asleep catches up in one call;
  - each second damages **only the clock's own cell**, not the panel.
- The crate carries the movement's arithmetic, so the three hands are one time rather than three guesses:
  `ClockWidget::next_second` (59 → next minute, 59:59 → next hour, 23:59:59 → midnight) and
  `GuiContext::clock_time` / `set_clock_time` / `advance_clock`.

### Changed
- A property can now be **the designer's own** (`designerOnly` in the catalogue). The movement is the first:
  it says nothing about the face the crate draws, so it is never written into `ui.kdl` — an attribute the
  parser ignores would misrepresent what the build depends on.
- A design with no clock, or with its Run switched off, generates **exactly** the `ui.rs` it generated
  before: the extra import, field and methods are not emitted at all.

## [0.5.1] - 2026-10-17

Reported as *"The hour label text centres must allign properly with the hour ticks. They are currently
alligned with the left and bottom edges of the text."*

### Fixed
- **The clock's hour numbers are centred on their ticks.** The canvas read a glyph's low three bits as
  columns 5–7 instead of 0–2, so every numeral was drawn four or five pixels to the right of its tick —
  and twice that at `Number size` 2 and above.
- Both the canvas and the runtime now centre a numeral on its **ink** (three columns, five rows per
  glyph) rather than on its cell, which is what leaves the visible digits — not just their box — on the
  radial line of the tick that belongs to them.
- The numerals also follow the face's real block size, so `Scaled6x10` numbers are drawn as two-by-two
  blocks, the way the text engine draws that face everywhere else on the panel, instead of at half size.

## [0.5.0] - 2026-10-17

Asked for as *"Fix the Roller issue then: Next, add a Clock Widget (derived from the Gauge widget) with Hour,
Minute and Second hands (needles). Each hand's colour must be settable, as well as the hour number's label
font, colour and size. Tics must be provided for hours and minutes."*

### Added
- **Clock** widget, in the Toolbox's *value* group and drawn from the gauge's own dial maths:
  - **Hour and minute ticks** — twelve long, thick marks and forty-eight short, thin ones between
    them, each with its own colour (`Hour ticks`, `Minute ticks`). The hour mark is drawn over the
    position it shares with a minute mark, so the long tick is never half-hidden.
  - **Hour, minute and second hands**, each with its own colour and length (½, ¾ and just under the
    full radius), thin to thick: a hand sits *between* the marks as the smaller units pass, so
    `3:30` points halfway between 3 and 4.
  - **Hour numerals** — the face and colour are fields (`Number font`, `Number colour`), and the size
    is `Number size` (1–4): the built-in faces are fixed bitmaps, so a size is a magnification, one
    block per glyph pixel. `Hour numbers` switches them off.
  - The widget holds a **time**, not a running clock: the application sets `hour`/`minute`/`second` as
    it ticks, the way it sets a slider's value.

### Fixed
- **The minimal (`--no-default-features`) build of `embedded-gui` failed to compile**: `context/input.rs`
  imported `roller_row` and `ROLLER_ROWS` unconditionally, although both only exist with
  `rich-widgets`. The import is gated like the definitions now, and both supported no_std
  configurations (`libm`, `micromath`) build.

### Notes
- The new widget lives in the vendored crates (`embedded-gui`, `embedded-gui-codegen`), so a project's
  copy has to be updated before a clock appears on the glass. The marker moved with this version and the
  designer offers it as usual.

## [0.4.0] - 2026-10-17

Asked for as *"The slider widget's drag grip box is minute. The grip box height must fill the vertical area
(between top and bottom borders) and its width must be adjustable. Also, the Dropdown widget text items
centering must be adjustable (Left, Middle Right)."*

### Added
- **Slider — `Grip width`** (1–64 px, eight by default). The grip's *height* is not a setting: it is the
  block's inner height, so the grip now fills the space between the top and bottom borders whatever the
  widget's height is. It travels across `inner.w − grip` and so sits flush with either end. Upstream drew a
  fixed 3x5 block, which is why the grip was a speck in anything taller than a line of text.
- **Dropdown — `Text alignment`** (`left` · `middle` · `right`, left by default). The selected item *and*
  the popup rows follow it; the arrow keeps its own seven-pixel slot at the right edge. Upstream always
  left-aligned both.

### Changed
- `embedded-gui`: `WidgetKind::Slider` carries the grip width and `WidgetKind::Dropdown` its alignment;
  `add_slider_sized` and `add_dropdown_aligned` are the new builders, while `add_slider` and
  `add_dropdown` keep their signatures and pass the old behaviour (a grip that is now eight pixels wide,
  left alignment).
- `embedded-gui-codegen`: `slider` reads `knob_width` and `dropdown` reads `align`, and only a design that
  names one takes the new builder — so markup written before this release still compiles to the same calls.
- **A project's vendored crates must be updated for the new grip to appear on the glass**, and the marker
  moved with this version, so the designer offers it as usual.

## [0.3.1] - 2026-10-17

Asked for as *"Very few of the current widgets respond to their Font setting (e.g. Time Picker, Number
Picker, Dropdown etc.). Run though ALL the widgets that offer a Font setting and fix that please."*

### Fixed
- **Dropdown, Table and Dialog** previews read a bare `Style::panel()` instead of the widget's own style,
  so their Font — and every colour and base style they offer — changed nothing on the canvas.
- **Status bar, Time picker and Number picker** drew their text in a hard-coded `Tiny3x5` at a
  four-pixel advance. They now use the chosen font's own metrics for the run width, the line height, the
  centring and the focus carets, as the runtime does.
- **Spinbox** measured with the crate's fixed four-pixel cell while the runtime measures with the font's
  advance, which put the underline on the wrong digit as soon as a wider face was picked.
- **Choosing any appearance field no longer changes a widget's base style.** Nine tags (`status_bar`,
  `time_picker`, `number_picker`, `arc`, `busy_wheel`, `chart`, `plotter`, `content_indicator`, `crumbs`)
  were missing from the designer's base-style table, so setting a font or a colour emitted
  `Style::label()` where the codegen's own fallback is `Style::panel()`: the widget lost its background,
  border, shadow and rounding on the glass while the canvas still drew a panel. Choosing a Font is how it
  was noticed.

### Notes
- All fourteen widgets that offer a Font now respond to it on the canvas and on the glass: label, button,
  toggle, checkbox, dropdown, roller, spinbox, number picker, time picker, gauge, status bar, dialog,
  table, carousel. The runtime and the codegen already read `style.font` for every one of them, so **no
  vendored crate changed** and an existing project needs no "Update now".
- The base-style table is now checked against the codegen's own fallbacks (`emitter.rs`) by a test, and
  every font-capable widget is checked for a visible change in the canvas, so neither can drift again.

## [0.3.0] - 2026-10-17

Asked for as *"Do the launch-config guard rails and the Windows thing next."*

### Added
- **Check Debug Configuration** (`rustyPlatform.checkLaunchConfig`) — validates every `probe-rs`
  configuration in `.vscode/launch.json` against the schema the **installed** `probe-rs-debugger`
  publishes in its own `package.json`: unknown keys (with a "did you mean" for the likely rename,
  nested `coreConfigs` items included), missing `required` keys, and a `request` the debugger does
  not have. Nothing is checked against a version table here, so updating the debugger cannot make
  the check stale.
- **Regenerate** — when the file holds nothing but the four configurations this generator writes,
  the check offers to rewrite it from the template, keeping the old file as
  `.vscode/launch.json.old`. A file holding anything hand-written is reported and left alone.
- **Debug** runs the same check before starting a session, because VS Code accepts an unknown key
  silently and the session would then do something other than what the file says.
- Windows: COM-port enumeration (`Win32_PnPEntity`, so a port whose driver is still loading is
  still found), with the **vendor id kept** in the entry name so the Raspberry Pi Pico exclusion
  applies on Windows too.
- Windows: `export-esp.ps1` is read as well as `export-esp.sh`, so an ESP project built on Windows
  gets the Xtensa linker on PATH.

### Changed
- The flash-then-monitor command chain is platform-aware: `&&` on POSIX shells, and
  `; if ($LASTEXITCODE -eq 0) { … }` on Windows, where PowerShell 5.1 rejects `&&` outright.
- `espup`'s export file is looked for under both names, so the toolchain check is not confused by
  the Windows spelling.

### Notes
- Windows support is implemented and unit-tested for `win32`, but has **not been run on a Windows
  machine** — there is none on this bench. The macOS serial-port path is deliberately left to
  `espflash`'s own picker.

## [0.2.0] - 2026-10-17

Asked for as *"I feel we are trying to re-invent the wheel. PlatformIO already has all the functionality for c++
development for our target boards (except for the designer feature). Please strip all platformio related (c++) features
from this extension. Keep the Arduino c++ main file structure we implemented for the Rust language."*

### Removed

- **The whole Arduino C++ / PlatformIO family**, added between 0.1.0 and 0.1.5: the `platformio.ini` project generator,
  the `board_config.h` / `panel.h` / `main.cpp` emitters, PlatformIO detection and the `pio` build · upload · serial
  monitor · clean commands, the PlatformIO debug hand-off, the Arduino health family and its install prompts, the
  `Language` question in the wizard, the `pioPath` / `pioMonitorPort` / `pioMonitorSpeed` settings, the six
  `rustyPlatform.arduino*` / `installPio*` commands, the Arduino LCD-rotation carrier (`-DRUSTY_LCD_ROTATION` in
  `platformio.ini`), the Arduino half of the WYSIWYG designer (`src/designer/cpp.ts`, the family seam, the C++
  emitter and the vendored `lib/rusty_gui` widget runtime), and the tests, snapshots and docs that went with them.
- **Opening a PlatformIO folder is no longer a project of ours.** `readProjectAt` reads a `Cargo.toml` and nothing
  else, so a `platformio.ini` workspace simply gets no Rusty Platform controls — the PlatformIO IDE extension owns it.

### Kept

- **The Arduino-style sketch shape, for Rust.** Nothing about it changed: `src/main.rs` is still `setup()` plus
  `main()` (the loop inside `main()`), and `src/MainHeader.rs` still holds every import, type alias, constant and
  helper. That layout was the useful thing the Arduino family taught, and it stays exactly as it was.

### Notes

- The designer is Rust-only again, with no single-family abstraction left behind: `DesignerPanel` names
  `src/ui.kdl` / `src/ui.rs` / `src/ui_handlers.rs` directly, as it did before 0.1.5.
- Suite: **908 hermetic checks** (t1 849 · t2 55 · t3 4) — the 82 checks and 102 snapshots that covered the Arduino
  family are gone with it, not skipped.

## [0.1.5] - 2026-10-16

Asked for as *"Next please prepare the WYSIWYG template for the Arduino option"* — the designer, on the PlatformIO
side. The Rust Designer draws a canvas and compiles it into markup; the Arduino family has neither the markup nor
the runtime, so both had to exist first.

### Added

- **An Arduino `Designer (WYSIWYG)` template**, offered on exactly the boards the everything-test is (a panel **and**
  a touch controller — the CYD today), because a design is a picture of a screen with a finger on it. The wizard
  asks the project's name and the rotation as it does for the other templates, writes the project, copies the widget
  runtime into `lib/`, and offers *Open Designer* instead of *Open Project*.
- **A C++ emitter for a design** (`src/designer/cpp.ts`). A design becomes three files with two lifetimes:
  `include/ui.h` and `src/ui.cpp` are generated on every save, and `src/ui_handlers.cpp` is the user's — the designer
  appends a stub for each event and never rewrites what is written, exactly as it does for Rust. `src/main.cpp`
  calls `ui::setup(display)` once and `ui::loop(display)` forever.
- **`lib/rusty_gui`, the widget runtime** — a screen, a label, a button and the touch handling that makes a press
  and a release a pair, drawn with LovyanGFX at the design's own coordinates. It allocates nothing (the widgets are
  statics and a handler is a plain function), so a widget library cannot fragment the heap. Vendored into a project
  like the Rust crates are, with a version marker and an offer to refresh a copy that is not this extension's.
- **The designer now serves both families.** `src/designer/family.ts` says which files a design becomes and how a
  handler is found; the editor asks it instead of assuming Rust. The rotation the canvas draws for is read from
  `.cargo/esp-config.toml` or `platformio.ini` — whichever that project's build reads — and written back there.
  The sidebar's Designer row is no longer hard-coded off for Arduino projects.
- **What the runtime cannot draw is reported, not drawn wrongly.** Phase 1 is labels and buttons; a design
  containing anything else gets a line in the panel's problem list naming the widget and the reason, and the emitter
  leaves it out rather than emitting something that looks like the wrong control. A declared font, a border width and
  an event the runtime does not raise are reported the same way.
- **Tests:** a new t1 file for the C++ emitter and the family seam (identity of the runtime's API, the widget
  skip-and-report rule, handler append/prune where the user's own handler must survive, appearance resolution from
  both the `style` route and a button's own attributes, the family/board gates, and the wiring at both ends); eleven
  new goldens for the designer template; and a **real build of a generated designer project** in the e2e matrix,
  which is what caught the three bugs below.

### Fixed

- **Three C++ facts the compiler had to teach, all found by building a generated designer project:**
  - The runtime's `Rect` had default member initialisers and no constructor, which stops it being an aggregate under
    **C++11** — and the ESP32 core compiles sketches as `gnu++11`, so `Rect{16, 8, 288, 26}` did not compile there
    while it compiled happily under the RP core's C++17. It has a `constexpr` constructor now, with the reason
    written beside it.
  - A chained call is a statement, not an initialiser, so `Label w(id, rect, text).textSize(1);` is not C++: the
    widgets are declared plain and their looks are applied in `setup()`.
  - A handler stub is appended to the end of the user's file, so it cannot be inside a namespace that closed above
    it. The handlers are free functions declared at global scope; declaring them in `namespace ui` linked as
    `undefined reference to ui::on_go_clicked`.

### Notes

- **A design that drives nothing still compiles**, and so does one with a widget the runtime cannot draw: the screen
  is brought up with whatever it can show, and the panel says what it could not.
- The Arduino runtime has three text sizes (LovyanGFX `Font0` at 1..3) where the Rust crate has fonts and a vector
  face. A built-in font maps onto a size; a *declared* font (a BDF in the project) is reported, because drawing the
  default in silence would be a promise the glass cannot keep.

## [0.1.4] - 2026-10-16

Asked for as *"add the LCD rotation options, which is now not available in Arduino for the ESP32-025 board"* —
the rotation the Rust family has had since 0.0.x, brought over to the Arduino C++ projects.

### Added

- **LCD rotation for Arduino projects.** The wizard now asks *how is the panel mounted?* when the chosen template
  drives a panel (the same four choices, in the same words, as the Rust flow — no rotation, 90°, 180°, 270°
  clockwise), and the answer travels the same way it does in Rust: **into the build, not into the sketch**. It is
  written as `-DRUSTY_LCD_ROTATION=<n>` in the project's `platformio.ini`, guarded in `include/board_config.h`
  (`#ifndef` → `0`, so a project that loses the line still builds) and read by the sketch as
  `board::LCD_ROTATION`, which is what `display.setRotation()` is called with.
- **The diagnostic screen is laid out for the turned panel.** A quarter turn swaps the panel's sides — the CYD's
  glass is 320x480, so a turned project draws into 480x320 — and the layout solver is given the size the project
  will actually address. The Rust templates were already laid out this way; both families now agree, because it is
  the same solver. Half a turn changes which way up the picture is but not its shape, so those numbers stay put.
- **`rustyPlatform.lcdRotation` now reaches Arduino projects too.** Changing the setting rewrites the `platformio.ini`
  flag of an open Arduino project the same way it rewrites `.cargo/esp-config.toml` of a Rust one, and says
  *rebuild to apply it*. A project that drives no panel is left alone: the flag's presence is what marks a project
  as one that draws, which is the same rule the generator uses.
- **Tests.** Rotation round-trips through the ini (replace, add a `build_flags`, a section with none, a
  multi-environment file left byte-for-byte alone, idempotent), the three places it appears are asserted together
  (ini flag, header constant, workspace setting) and asserted *absent* for every board and template that draws
  nothing, the layout is held against the shared solver, and the wiring at both ends (the wizard's question, the
  settings listener) is guarded. The e2e matrix gained a **real build of a turned panel** — twelve `pio run`
  builds now — and asserts with PlatformIO's own `idedata` that the compiler sees `RUSTY_LCD_ROTATION=1`, and
  that a panel-less project defines no rotation at all: a `build_flags` line PlatformIO does not understand is
  ignored in silence, which is the one failure a successful build would hide.

### Notes

- The header holds the **fallback**, never the choice. Baking the rotation into `board_config.h` would mean that
  turning the setting and rebuilding did nothing, with nothing to see but a panel that stayed the wrong way up.
- A board with a panel carrying a template that does not draw (`blinky`) gets none of the three pieces. The gate is
  the pair — the board *and* the template — exactly as it is in the Rust generator.

## [0.1.3] - 2026-10-16

Asked for as *"create a template for Arduino and esp32-035 equivalent to the Board Test Everything option for
Rust"* — the Arduino counterpart of the Rust family's `board` template, and with it the panel support the ESP32
half had been missing.

### Added

- **Arduino `Board test (everything)`**, offered on any board that has a panel **and** a touch controller (the
  CYD today) — the same rule the Rust family uses for its template of the same name, so the two agree about what
  "everything" covers and for which boards. One sketch that brings up the panel, its touch controller, the RGB
  status LED, the card socket, the light sensor and the speaker, and reports all of them on the glass and on the
  serial port.
- **The diagnostic screen**, the same one the Rust template draws and for the same reason: a frame, four
  coloured corners, five named bars (`red green blue black white`), `Hello Grumpy!`, a line of status text, a
  blinking square as the heartbeat, and a crosshair under the finger with the raw touch values in the log. Each
  part answers one question no build can: is the drawing area the whole panel, is the image mirrored, is the
  colour order right, is a channel dead, does touch map to the glass.
- **The geometry comes from the same solver the Rust template uses** (`espDiagnosticLayout`), so the screen is
  laid out for the panel in front of you rather than for a 3.5" CYD — a small panel gets smaller markers and a
  smaller font rather than the CYD's pixel positions off its edge.
- **`include/panel.h`** — a generated panel + touch driver, written from the board's own pins: one LovyanGFX
  device class carrying the SPI bus, the panel, the touch controller and a PWM backlight. `lib_deps` gains
  `lovyan03/LovyanGFX@^1.2.33` for this template only; `blinky` and `serial-log` still pull in nothing.
- The generated `README.md` now explains what the screen is testing, as a table of *"on the glass"* → *"what it
  means if it is wrong"*.

### Notes

- **LovyanGFX, not TFT_eSPI**, which would be the more common pick for a CYD: TFT_eSPI is configured by editing
  `User_Setup.h` **inside the library**, and library code is not edited here (a PlatformIO upgrade would replace
  it anyway). LovyanGFX is configured by subclassing a device in the project's own header — and it brings the
  touch controller with it instead of needing a second library.
- Verified by a real build: the template is in the opt-in e2e matrix (the eleventh PlatformIO build) and
  compiles **warning-free**. The two things a build cannot prove are marked as one-line knobs in the generated
  header, the same two the Rust catalogue carries as `colorOrder` and `mirrorX`: `cfg.rgb_order` and the panel
  reset.

## [0.1.2] - 2026-10-16

Asked for as *"install everything required. I want to test the full product"* — and installing the pieces the
generated projects *ask for* turned out to be the best test the family has had. Three real bugs came out of it,
all of them in code that had been verified only against what this machine already had.

### Fixed

- **The Pico projects asked for the wrong PlatformIO platform.** `platform = raspberrypi@1.20.0` is, in the
  registry, the **mbed** platform: it has one RP2040 board (`pico`, ArduinoCore-mbed) and no `rpipico2`,
  `rpipicow` or `rpipico2w`. Reproduced in an empty core directory: a generated project built against it dies
  with `UnknownBoard: Unknown board ID 'rpipico2w'`. It only ever worked here because this machine already had
  maxgerhardt's **arduino-pico** platform installed from git under the same name. The generated `platformio.ini`
  now names that git URL, with the commit the builds were verified against recorded in a comment
  (`aa70b802…`) and a one-line note on how to pin it. Verified in a clean core: the URL resolves to a platform
  that ships all four Pico boards.
- **ESP32 boards could be built for the wrong module.** `esp32-s3-devkitc-1` is an **8 MB** board and LilyGo's
  T-QT is a 4 MB one, so the inherited partition table was sized for flash that is not there. The ini now states
  the module's own size (`board_build.flash_size`, from the same board data the Rust generator reads) for every
  ESP board — and deliberately *not* for the RP boards, whose platform already matches the chips.
- **Two of our boards are indistinguishable from a `platformio.ini` alone**, because PlatformIO's ids are shared
  — the CYD and the ESP32-DevKitC are both `esp32dev`. The generator now writes the catalogue board id as
  `custom_rusty_board = …` (PlatformIO ignores `custom_*` keys) and detection reads it first, falling back to the
  PlatformIO id for a project somebody else wrote. Without it, opening a CYD Arduino project told the health row
  it was a DevKitC.

### Verified for the first time

- **The ESP32 half of the Arduino family really builds.** With `espressif32@6.9.0` installed, the opt-in e2e
  layer now builds **ten** generated projects — four Pico boards (both templates) plus the ESP32-DevKitC, the
  T-QT and the CYD — in about 30 s once the cores are cached, each one checked for its artefact and for warnings
  in the generated sources. The ESP boards had never been built before; their board ids, flash size and
  "no debug route" claim were documentation until now.
- The artefact check learned a platform fact while doing it: an RP2040 build emits a **UF2** and an ESP32 build
  emits a **`.bin`** and no UF2 at all, so a single expectation for both was a false failure. Both emit an ELF,
  which is what a debugger loads.

## [0.1.1] - 2026-10-16

Another step on the Arduino C++ family — the debugging half of what the user asked for (*"I want to use the RP
Debug Probe for uploading and debugging (OpenOCD) for the pico boards"*), plus the test layers that keep the
whole route honest.

### Added

- **Debug now starts a real session on an Arduino project** instead of only explaining itself. It hands the job
  to PlatformIO's own debugger — `platformio-ide.startDebugging`, the command behind the PlatformIO IDE's Debug
  action — which drives OpenOCD over the probe and GDB over the ELF, using the `debug_tool = cmsis-dap` the
  generated `platformio.ini` already carries.
- Two things are said out loud instead of failing somewhere inside a debugger, because both are knowable:
  **the PlatformIO IDE extension is not installed** (with `pio debug` as the by-hand alternative) and **the
  project has not been built yet**, so there is no firmware for the debugger to load.
- `tests/layers/t2-cli/pio-detect.test.js`: PlatformIO detection driven by a fake `pio` in a fake
  `~/.platformio`, with real child processes. It caught a real bug on its first run — a **stray file** in
  `platforms/` was counted as an installed platform, so `platforms/README.md` would have claimed a platform that
  cannot build anything. The directory is now read for directories.
- `tests/layers/t4-e2e/arduino-build.test.js` (`--e2e`): **real `pio run` builds** of generated projects, six of
  them (four Pico boards × both templates), each checking that a UF2 came out and that **nothing warned about the
  generated sources**. A board whose platform is not installed is *skipped with that reason*, never downloaded —
  an `espressif32` fetch is a few hundred megabytes and a test suite that quietly spends them is one people stop
  running.

### Notes

- The suite's strongest check of the debug route reads the **installed PlatformIO IDE's own manifest** to confirm
  the command and debugger type it declares are the ones this code calls — and skips, rather than passing, on a
  machine without it.

## [0.1.0] - 2026-10-16

**The Arduino C++ family, phase 1.** Asked for and chosen in as many words: a *"third family inside this
extension"*, phase 1 being *"wizard + build + flash + monitor (PlatformIO core)"*, with *"both board families
from the start"* and uploads/debug sessions on a Pico going through *"the RP Debug Probe (OpenOCD)"* while the
ESP32 boards keep USB. This is a **minor** version rather than another `0.0.x`: it is the second language the
extension can generate, not another template in the first one.

### Added

- **New Project now begins with a language question** — *Rust (Embassy)* or *Arduino C++ (PlatformIO)* — and
  the same board list, the same boards and the same names follow either answer. A board is a board: what
  changes is who builds for it.
- **Arduino C++ projects are generated as PlatformIO projects**: `platformio.ini`, `include/board_config.h`,
  `src/main.cpp`, `.vscode/settings.json`, `.gitignore` and a `README.md`. `setup()` and `loop()` are the only
  functions in the sketch, exactly as asked for, and the file ends with the same *"your own code goes below
  this line"* guidance the Rust sketches end with, with a commented example.
- **`include/board_config.h` is the `MainHeader.rs` of an Arduino project**: the board's own facts in one place
  — its name and id, the on-board LED, and the panel, light sensor, speaker and card-reader pins a board
  carries. It holds the *same* board data the Rust generator uses, imported rather than copied, so a pin number
  exists once and both toolchains agree by construction.
- **Uploads and debug sessions on a Pico go through the RP Debug Probe**: `upload_protocol = cmsis-dap` and
  `debug_tool = cmsis-dap` in the generated ini, so PlatformIO drives its own OpenOCD over the probe. No
  BOOTSEL dance, no 1200-bps touch, and nothing is written without the probe. The ESP32 boards keep
  `upload_protocol = esptool` over USB, as they always were.
- **Build · Upload · Serial Monitor · Clean** in the Controls section and the status bar, worded for this
  route (`pio run`, `pio run -t upload`, `pio device monitor`, `pio run -t clean`). The rows that are
  statements about cargo — the two build profiles, the profile-override flashes, the `.deb` packaging pair —
  are not shown for an Arduino project. The Rust-named commands stay in the palette (and in any keybinding), so
  reaching for *Flash* with an Arduino project open runs an **upload** rather than a `cargo build` of a project
  that has no `Cargo.toml` — one delegation, so nothing about PlatformIO leaks into the Rust command bodies.
- **PlatformIO detection**, with the trap this machine taught: Core is installed by the PlatformIO IDE into
  `~/.platformio/penv/bin/pio` and is **not** on `PATH`, so that path is looked at first and `PATH` after it.
  `rustyPlatform.pioPath` overrides it.
- **`rustyPlatform.pioMonitorPort` and `rustyPlatform.pioMonitorSpeed`** (115200 by default): which serial port
  the monitor takes. Left empty, PlatformIO picks — and on a bench with two boards attached that is a guess,
  which is the one thing the extension has been careful never to make.
- **The load-time requirement prompt covers this family too** (0.0.99's feature, no new mechanism): an Arduino
  project is told about PlatformIO and the platform it asks for, with *Install PlatformIO…* and *Download
  Platform…* buttons, and about the debug probe on a board that uploads through it. It is **never** told about
  cargo, rustup or the ESP toolchain — none of which this route uses.

### Changed

- `HealthFamily` gained `'arduino'`, so the health row, the status-bar tooltip and the prompt all read one
  verdict per family, as they do for RP and ESP.
- `ActiveProject` gained a `kind` and an `arduino` facet: a folder with a `platformio.ini` is a project now, and
  a folder with **both** files stays a Rust project (a `Cargo.toml` is the stronger signal).
- `rustyPlatform.debug` on an Arduino project says what is true instead of starting a probe-rs session against a
  project with no Cargo.toml: PlatformIO drives the probe on that route (`pio debug`, or the PlatformIO IDE's
  Debug button — the ini is already configured for it).

### Notes

- **Verified on real hardware-time builds, not by reading the code**: all four Raspberry Pi boards × both
  templates build with the real PlatformIO 6.2.0 and the `earlephilhower` Arduino core, **`SUCCESS`, no
  warnings**, at 2.8–7.5 % flash. Two of those builds failed first and are the reason the header looks the way
  it does: the core already defines `BOARD_NAME` (redefined-macro warning), and embassy spells a pin `PIN_25`,
  which is not a C++ constant. The board facts are therefore `constexpr` constants in a `board` namespace;
  the pins are GPIO numbers, with the Rust spelling kept in a comment.
- The ESP32 half of this family is generated and its `platformio.ini` is written, but it has **not been built**:
  the `espressif32` platform is not installed on this machine and pulling it is a few hundred megabytes. The
  board ids (`esp32dev`, `esp32-s3-devkitc-1`) are the documented ones and are to be confirmed with
  `pio boards espressif32` on the first run — the RP ids are verified against the installed `raspberrypi`
  1.20.0 (`rpipico`, `rpipico2`, `rpipicow`, `rpipico2w`).
- Debugging an Arduino project from inside this extension (a launch configuration over the probe) is **phase
  1b**, together with the panel drivers for the CYD and the T-QT. `plans/arduino-cpp-family.md` is the plan.
  *(0.1.1 answered the debugging half: Debug hands the session to PlatformIO's own debugger.)*

## [0.0.99] - 2026-10-16

### Added

- **The extension asks about anything the toolchain is missing when a window loads** (asked for in as many
  words: *"The extension must prompt for any missing requirements when it loads."*). It used to wait to be
  asked: a window could open with no cargo, no probe-rs, or an ESP project and no Xtensa toolchain, and the
  status-bar row just sat there saying nothing. Now a warning names what is missing and offers the fix as a
  button — the same fixes the *Check Toolchain* modal offers, because both read the one health report.
- It also re-checks when the open project changes, which is when a *different* set of requirements becomes true
  (opening a CYD project in a window that had been sitting on a Pico one).
- **`Don't Show Again`** on the prompt remembers that particular set of requirements, in `globalState`, so it is
  silenced for good — while a set that later *changes* is still announced.
- **`rustyPlatform.promptMissingRequirements`** (on by default) switches the prompt off entirely, for anyone who
  would rather keep the health row as the only place this is said.

### Changed

The button text for each fix, and the command behind it, are now one list in `toolchain/health.ts`
(`HEALTH_ACTION_LABELS`/`HEALTH_ACTION_COMMANDS`) instead of the mapping being spelled out a second time in the
`Check Toolchain` command. Two doors onto the same fix, one definition of what each does.

## [0.0.98] - 2026-10-16

### Added

- **Both generated files now say where your own code goes.** `src/main.rs` ends with a block answering the
  question the two-file layout invites: your functions belong below `main()` (Rust does not mind about the order
  of items, so the top of the file keeps the shape of the sketch), a function that needs the hardware takes
  `state` (or one of its fields), anything that does *not* touch the hardware reads better in `MainHeader.rs`,
  and a driver that outgrows a couple of functions belongs in `src/my_driver.rs` with a `mod` line.
  `src/MainHeader.rs` ends with the matching note — including the visibility rule that bites first: `main.rs`
  reaches the header through a glob import, so a helper written there has to be `pub` to be callable at all.
- Both blocks carry a **commented-out example**, and it names a peripheral the board actually has: the LED
  channel on a CYD, `state.led` on a Pico, `gpio_set` on a Pico W (whose LED is a GPIO on the wireless chip),
  and a form naming no peripheral on a board with nothing to blink. A panel's backlight pin is never offered —
  the first version did, and that is precisely the sort of example that teaches the wrong lesson in the first
  file someone reads.

## [0.0.97] - 2026-10-16

### Added

- **Every generated project is an Arduino-style sketch now, in two files.** `src/main.rs` is `setup()` and
  `main()` — and nothing else but what those two need: the crate attributes, the side-effect imports, the
  statics and the `State` struct. `setup()` initiates every peripheral and instantiates every class once and
  hands the whole lot back as `State`; `main()` calls it and runs the implementation in a loop of its own, so
  the code you write lives in one function and reaches the hardware as `state.display`, `state.touch`, … The
  second file, **`src/MainHeader.rs`**, is the sketch's header: every `use` (re-exported, so the single
  `use main_header::*;` brings them all into scope), the type aliases for the nested driver types, the
  constants, and the helper types, functions and macros.
- **A generated project's Wi-Fi credentials and helper functions are where a sketch keeps them**: the four
  `WIFI_*` constants and the address parser are in the header beside everything else rather than in the middle
  of `main()`, and so are the touch helpers, the calibration record helpers and the `beep!` macro.

### Changed

- **The sidebar's Open Designer row appears only in a Designer project** — one with a
  `designer/panel.ui.json`, which is what the wizard writes for the `designer` template and for nothing else.
  Every other template has no design for the canvas to open, so the row only ever ended in one of the
  designer's own warnings. The **Project view's title-bar icon follows the same rule**, through a
  `rustyPlatform.designerProject` context key. The command itself stays in the Command Palette either way, so a
  `display` or `touch` project can still start a design.
- **A panel project's SPI bus and pixel buffer live in `StaticCell`s.** They have to outlive `setup()`, since
  the panel's driver is part of the `State` it hands back; a panel project therefore also depends on
  `static_cell`, and `panel_clock()`/`touch_clock()` are header functions rather than closures (a closure's type
  cannot be written into a struct field).
- The Wi-Fi credentials prompt recognises a wireless project by reading **both** of the sketch's files, so it
  still appears for projects generated by this version.

### Verified

- Every ESP template was compiled with the Xtensa toolchain (`cargo check`) on three boards — CYD, T-QT and
  ESP32-DevKitC, including both `designer` variants — and every Pico template with `cargo build` on
  thumbv6m/thumbv8m: **no errors and no warnings from the generated code.**

## [0.0.94] - 2026-10-14

### Added

- **A design that is not valid says so the moment it opens.** The panel's verdict used to arrive only after the
  first edit, which is the wrong moment to hear it: an invalid design is one whose markup is *not* written, so
  the board is compiling an older design than the canvas shows, and a user who is told nothing has no reason to
  touch the canvas and find out. Everything wrong with the design, and everything the load had to tidy up, is
  now listed under the properties as the panel opens, and the whole verdict is written to the output channel
  as well. A *value* the catalogue disagrees with (a box wider than its maximum, a colour that is not a colour)
  reaches the board this way; an unknown property is dropped on the way in instead, as of 0.0.93.

### Fixed

- **A problem that has been fixed is no longer left on screen.** The list was only ever added to, never
  rebuilt, so the first problem reported in a session stayed there for the rest of it.
- What a load dropped moved out of the footer and into that list, because the footer is a single clipped line
  (`overflow: hidden`, an ellipsis): a note appended to it can vanish exactly when the board is out of step.
- The panel now tolerates an init message that carries neither of those lists instead of failing to draw at
  all. They are extras on top of the document, like `loadError`, and the panel is the side that has to survive
  their absence.

## [0.0.93] - 2026-10-14

### Fixed

- **An older design is cleaned up when it is opened, instead of silently freezing the board at an older
  design.** A document carrying a property this version of the catalogue has no place for -- the checkbox's
  one-time `style`, say -- fails validation as a whole, and a design that does not validate never has its
  markup written. So `src/ui.kdl` kept whatever the last successful save had produced, the canvas went on
  accepting every edit, and the only sign of it was one line in the panel's problem list: the panel drew a
  checkbox labelled `RUN` from an old file while the canvas showed a 50x50 box labelled `Swing it!`.
  Properties the catalogue no longer offers are now dropped as the design loads, reported in the footer (and
  in full in the output channel), and the cleaned design **and** its markup are written straight away rather
  than waiting for the next edit -- the cleanup is usually the very thing that was blocking the markup.
  Hand-editing the JSON does not fix this on its own: the canvas holds the whole document and writes it back
  on every edit, so a leftover key returns with the next change.
- The validator and the cleanup ask the catalogue the same question through one function (`unknownProps`), so
  a property cannot be reported by one and tolerated by the other. Only unknown *keys* are dropped: a value
  this version disagrees with (a size past the maximum, a colour that is not one) stays, and the panel says
  so.

## [0.0.92] - 2026-10-14

### Fixed

- **A widget no longer recolours itself when it takes focus or is pressed.** The default focused and pressed
  styles were `Style::selected(true)`, which replaces the block's **background** with the accent — so a
  Checkbox's glyph was painted over the colour it is drawn in and could not be read, and a Roller's selected
  row (which *is* the accent) vanished into the block. Both states now brighten the **outline colour only**
  and leave the background, text, foreground and accent exactly as they were. The outline's *width* is
  deliberately untouched: `Block::inner` subtracts it, so a wider border on focus would move every widget's
  contents by a pixel and could re-wrap its text. A style with no border therefore shows no hint rather than
  a jumping one.
- **A widget that acts gives the focus back.** An activation that changed something — a Checkbox or Toggle
  thrown, a Dropdown opened, a Keyboard key typed — now drops the focus the press took, inside the same
  event, so nothing stays highlighted once the finger comes up. A tap that changed nothing (a Roller, a List,
  a TextArea) keeps it: that is what keeps a caret on screen, and what the drag needs to know which selector
  to turn.
- The ProgressBar's fill no longer switches from `foreground` to `accent` while the bar has focus, so the
  same value reads the same way wherever the focus happens to be.

## [0.0.91] - 2026-10-14

### Added

- **A design's own context is reachable from the app's code.** The generated `src/ui.rs` `Designer` now exposes
  `gui()` and `gui_mut()`, so an app that drives a widget itself can call any of the crate's named `set_*`
  methods, or the generic one — `gui_mut().set_widget_property(id, PropertyKey::Value, PropertyValue::Float(v))`
  — addressed by the ids in `widgets`: a sweeping needle becomes
  `let id = widgets.my_scale; gui_mut().set_widget_property(id, PropertyKey::Value, PropertyValue::Float(v))`.
  Before this a screen could be touched and painted but never *told* anything: `gui` was private with no way
  in, which is what a hand-written gauge sweep in a test app ran into (`no method named set_scale_value`).
  `Scale` is the one value widget with no named setter of its own (Gauge, Dial, Meter, Slider and ValueLabel
  have one); the generic property path covers it and dirties only what changed.
- The accessors carry `#[allow(dead_code)]` for the same reason the `widgets` field does: whether an app drives
  a widget itself is the app's business, and the warning would otherwise appear in every project that does not.

## [0.0.90] - 2026-10-14

### Added

- **A finger drag turns the selectors on the touch panel.** Drag up or down on a **Roller** and it rotates
  under your finger, one item per drawn row of travel. The same gesture turns a List, a Circular List, a Menu,
  a Rich Menu, a Keyboard and a Feed Timeline, and steps a **Spinbox** (by its own `step`), a **NumberPicker**
  (±1) and a **TimePicker** (the hour). It is exactly what the Up/Down keys do — the drag calls the same code
  — so the wrap setting, the damage and the event are shared: a generated `on_<widget>_value_changed` handler
  fires once per item the finger crosses.
- The step comes from the widget's own geometry — a roller's third-of-its-height row, a list's
  `visible_rows` — with a 12 px floor, because a short roller (the sim's is 18 px tall) would otherwise step
  on every touch sample, and the panel samples every ~60 ms. Travel is accumulated, so a slow drag lands
  where a fast one would, and one sample moves at most 8 items however far a stale finger travelled.

### Changed

- **The Spinbox, NumberPicker, TimePicker and Carousel could not be touched at all.** They were not
  focusable, and `pointer_hit` only considers focusable widgets, so no finger could ever land on them — no
  tap, no drag. They are controls rather than displays (a Gauge, Chart or Plotter stays unreachable), and
  they are in the Tab order now.
- **The widget under the finger wins over a `ScrollView` behind it.** A roller or list inside a scrolling
  view used to scroll the view when dragged; now the selector turns and the view stays where it is. A drag
  on the view itself still scrolls it.
- **The Carousel gained arrow-key stepping**, so the finger and the keys cannot disagree about it.
- **Two widgets keep the press they already had**, because the drag may not quietly override a contract: a
  press on a **Dropdown** toggles it (`select_opens_dropdown`), so the press that would start a drag is also
  the one that dismisses the list — set that contract off and open it yourself if you want to drag it; and a
  press on an **AutoComplete** confirms the selection and collapses it, so it is not in the drag set at all.

### Fixed

- The designer's catalogue no longer offers an event a widget cannot raise: the **Roller** and **Carousel**
  advertised `scroll` (only a `ScrollView` ancestor raises `UiEvent::Scroll`, and it carries the *view's*
  id) and the **Table** advertised `scroll` while not being focusable at all. A generated handler for any of
  them was dead code.

## [0.0.89] - 2026-10-14

### Removed

- **The AI Assist is local-only.** Everything that could hand a request to another agent is gone: the machine
  scan and its agent picker, the Poolside CLI (`pool`) driver, the Agnes Code CLI (`jcode`) driver, the cloud
  OpenAI-compatible provider with its secret-storage API key, the consent/progress/report flow, and the
  pre-flight "this request is beyond the local model" gate whose escape hatch they were. With them go the twelve
  settings they used (`handoff`, `handoffAgent`, `cloudEndpoint`, `cloudModel`, `poolCommand`, `poolAgent`,
  `poolAutoAllow`, `poolTimeoutSeconds`, `poolResume`, `jcodeCommand`, `jcodeProvider`, `jcodeModel`) and the
  three commands (`Rusty AI: Forget the Handed-off Conversation`, `Rusty AI: Choose the Hand-off Agent…`,
  `Rusty AI: Set the Hand-off API Key…`). The chat panel, the `✎ AI` block, the diff-and-apply review, the
  build-driven repair loop, the house rules and every local-model feature are unchanged.

### Changed

- **Nothing the assistant does leaves this machine.** The bundled runtime and the OpenAI-compatible server you
  point `endpoint` at are both yours, and there is no longer any path that sends code or a prompt anywhere else.
- **The chat's "Implement `fn …` in the project…" buttons stay**, because they use the local model and the same
  diff-and-apply review as the editor's own flows — nothing is written until you apply the diff.
- `rustyPlatform.assistant.maxTokens` again bounds every answer: there is no longer an uncapped request.

## [0.0.88] - 2026-10-13

**This entry covers everything since 0.0.80.** The numbers 0.0.81 to 0.0.87 were used while this work was being
built and were never released or tagged, so nothing is missing under them — but they are not entries you can
install, and this is the first release that carries the whole batch.

### Added

- **The hand-off can use any agent on your machine, and says which one it will use.** The setting was
  hard-wired to the Poolside CLI; the extension now scans the machine — CLI agents on the `PATH`, plus
  OpenAI-compatible servers answering on the usual local ports — and offers what it finds in *Which agent a
  hand-off uses*. An agent that is installed without a verified way to run it is listed too, marked unusable
  **with the reason**, because "the extension can see your agent and cannot drive it yet" is a different
  message from silence. Your own choice wins; *Automatic* takes the best available one, preferring an agent
  that can work in the project over one that can only answer. Every hand-off action — the chat's refusal
  button, the editor's dialog, the repair loop's last offer, the report header, the progress line — names the
  agent it will really use, so none of them keeps saying "pool" after pool stopped being the only answer.
- **The Agnes Code CLI (`jcode`) is a second agent the extension can drive**, implemented the way the
  Poolside CLI is — because it can do the same job: inspect the project, edit files, run commands, and keep a
  conversation. Unlike a cloud *endpoint*, which can only answer, this one works in your project, so a
  hand-off to it is a real hand-off: consent, a progress line, a report of every tool call it made, a
  conversation turn whose code can be reviewed as a diff, and `--resume` so the next hand-off continues the
  same session instead of starting over. Its invocation is **measured**, not guessed (jcode v0.75.0): the
  message is its one positional argument, `--ndjson` on stdout gives one JSON event per line, the session id
  comes back in the run's own output, and a tool call's arguments arrive in pieces that have to be put back
  together in order. Two settings, `jcodeProvider` and `jcodeModel`, choose what it talks to (empty lets
  jcode's own configuration decide, and the consent dialog names whatever is chosen); the command itself is
  `jcodeCommand`, and its own line in the panel says whether it was found.
- **A cloud OpenAI-compatible API as a hand-off provider** — for a model that is not installed here at all.
  The endpoint and model are settings, the API key is stored in **VS Code's secret storage** (never in
  `settings.json`, never logged, never echoed), and it is written *and read back* before the extension says
  "stored", because a key that was not saved is a hand-off that fails later with no explanation. The key can
  also be imported from an existing env file. A cloud provider cannot be discovered by scanning — nobody can
  guess another person's provider URL — so it is named in the panel and then appears in the agent list with
  everything else.
- **An answer that came back from a hand-off can be implemented like any other answer.** A hand-off from the
  chat stored its answer as a conversation turn but posted it without its code blocks, so the `Implement …`
  buttons only appeared after the panel was reloaded; a hand-off from the repair loop never entered the
  conversation at all. Both now land in the conversation as normal turns, and the code in them opens the
  usual diff (`Apply` / `Discard`), with a whole-file answer confirmed by name and an answer that dropped
  parts of the file refused with the reason. The notification for an answered hand-off offers
  **Review and implement…** where the user is already looking, with a picker when the answer carries several
  blocks.
- **House rules now reach every prompt.** `rustyPlatform.assistant.conventions` promised "put in every
  prompt" and was true of the editor flows and the repair hand-off, and false of the chat — which is the
  prompt every hand-off carries, and so the only place a cloud agent could ever be given rules, since it
  never sees your project. The rules are part of the facts block now, so the local chat and every hand-off
  get them.
- **The model's window and answer budget are on the panel** (`contextSize`, `maxTokens`), editable there
  because a refused request is usually refused because of one of them.

### Changed

- **A cloud hand-off's answer is no longer capped at the local answer budget.** The request now sends **no
  `max_tokens` at all**, so the provider's own maximum applies: a cloud agent is handed exactly the jobs the
  local model could not finish, and cutting it off at the local budget is the failure the hand-off exists to
  avoid. A local answer is still bounded by this machine's window.
- **Every agent's own settings are shown only when that agent will run.** With a cloud API chosen, a box
  asking which `pool` executable to run is a question with no referent — and the same is true of the Agnes
  Code CLI's provider and model when pool is the one that will run. The switch above them also stopped
  reading like a list of agents: it offers *Warn me and stop* or *Hand it to an agent*, which is what it
  actually decides.
- **"Open the AI settings" opens the AI settings.** It revealed the view and left the settings section
  collapsed, so pressing it while the view was already visible did nothing anyone could see. It now reveals
  the view, expands the section, and falls back to the editor-tab chat (with a logged reason) if the sidebar
  cannot be focused.
- The panel's Save no longer keeps its own list of keys. The manifest is the list, a key it does not declare
  is refused **and said out loud**, and adding a field to the form is enough to make it saveable.

### Fixed

- **The panel's Save silently dropped every setting added after it was written** — five of the twelve fields
  on the form were written, so `contextSize`, `maxTokens`, the cloud endpoint and the whole hand-off group
  were sent, compared, and then thrown away: the field reverted and the feature never saw the value. A
  developer's reasonable reading of that is "the extension did not save my setting", which is what was
  reported. A drift test now reads the real form source and the real manifest and fails if they part ways.
- **Storing an API key could lie.** It reported success without checking, so a key that was not saved looked
  exactly like one that was; it is now verified by reading it back, and a failure says so instead of
  claiming the opposite.
- **The gauge repainted the whole widget when the needle moved.** Changing the value dirtied the entire
  control — face, ticks, label and needle — on every step of a sweep. Only the needle's own region is
  dirtied now, so a moving needle redraws what moved and nothing else. This is the fix as it was worked out
  in the user's own test app, ported here unchanged. It lives in the **vendored crates**, so an existing
  project picks it up with **Update Crates** (or **Update now** where the designer offers it) — a new
  extension version on its own does not change the code already vendored into a project.

### Notes on upgrading

- Everything except the gauge fix is in the extension itself: install the new `.vsix` and reload.
- The gauge fix is in the crates a project vendors, so an existing project needs **Update Crates** before the
  needle stops repainting the whole control.

## [0.0.80] - 2026-10-12

**This entry covers everything since 0.0.76.** The numbers 0.0.77, 0.0.78 and 0.0.79 were used while this work
was being built and were never released or tagged, so nothing is missing under them — but they are not entries
you can install, and this is the first release that carries the whole batch.

### Added

- **A Tick Box that can be sized, labelled on any side, and styled.** The old check box was one fixed
  square with its label where the crate put it. It now takes a **box width and height** (0 keeps the crate's
  own rule), a **label position** — left, right, top or bottom of the box, with the label *centred* on that
  side rather than left where it lands — a **font** for the label and a **box colour**. It was asked for as
  *"identical to the existing one, but the box size must be settable to any width/height the user selects"*,
  and the old entry is gone from the toolbox rather than sitting beside the new one: there is one Tick Box,
  and it does everything the old one did.
  A design written before this still names the single `box_size`, which is why the catalogue keeps it as a
  **legacy** property: dropping it would have left every such design with a box of a size it never chose. The
  toolbox hides it (it is superseded), the validator still accepts it, and the codegen reads it as the
  fallback for both sides — "a design written before the box had two sides names it".
- **A font selector for every widget that draws text.** The catalogue now says where a font is *real*
  (`fontSupport`), because the renderer only passes one through in some places: a control whose text call
  hard-codes the built-in face must not offer a font setting that quietly does nothing. Where the crate
  needed a way to draw with a chosen face it got one (`draw_text_with_font`, since `RenderCtx::draw_text` is
  hard-wired to the small built-in font), and the codegen now carries `style` through the builders that
  would otherwise have thrown the font away — the dropdown, the dialog and the table.
- **Middle-click a widget in the designer to jump to its handler.** `auxclick` (button 1) on a widget with
  code behind it opens `src/ui_handlers.rs` at that item. Left-click still selects: a design tool where the
  primary button moves to another file would be unusable.
- **`$(diff) Implement Diff` in the status bar while a proposal is open.** The Apply/Discard buttons lived
  on a notification and a code lens, and a notification can be dismissed — after which there was no way to
  implement the diff at all. The status bar item is offered whenever a proposal exists, however it was
  raised, and it is what the proposal's own title bar and footer point at.
- **A pre-flight check on every ask prompt, before anything is sent.** *"The extension must inspect each ask
  prompt to verify that it is within the scope of the ai model capabilities. If not, warn the user and
  abort."* Six checks, worst first: the prompt does not fit the window (`prompt-overflow`), the file the
  answer must be written into does not fit it (`file-too-big`), one item is past the rewrite limit
  (`item-too-long`), the sentence asks for a whole file (`whole-file-intent`), it asks for work across files
  (`beyond-model`), or the answer has been left too little room (`answer-starved`). The four size checks are
  arithmetic and the message carries the numbers — a 41 KB `main.rs` is ~10,386 tokens against the ~4,032 a
  default window leaves for a prompt, and no wording of a request can fix that. The two intent checks are
  heuristics, they say so (*"read as: …"*), and every refusal offers **Send it anyway** beside Cancel,
  because a check that cannot be overridden would be wrong eventually and infuriating then.
- **The hand-off: a request the local model cannot take can go to the Poolside agent instead.** The other
  half of a refusal, and the answer to *"can we hand off the prompt ... to a listening cloud api agent?"* —
  on a machine with the `pool` CLI, yes. The agent runs in the project (`pool exec -o json -d <project>`),
  gets a **scripted prompt** carrying the request verbatim, why it came here, the same board/crate/house-rule
  facts the local prompt would have had, the file in focus when there is one, and an instruction to build and
  report what it verified. Its work is reported as it happens (one line per tool call) and its closing
  paragraph comes back into the conversation. `--continue` with the run's own ID means a second hand-off
  adds to what the first one did instead of starting over. The prompt goes in on **stdin**, never as an
  argument, so a developer's own code never appears in the process list.
- **Six settings for it**, under the assistant's settings: `handoff` (on by default), `poolCommand`,
  `poolAgent`, `poolAutoAllow`, `poolTimeoutSeconds`, `poolResume`. The AI panel's settings form carries the
  one that matters — and says whether the command was actually found, before a hand-off is ever attempted.
  Note what is *not* settable: `pool exec` has no model flag (`-m` is obsolete and points at
  `--agent-name`), so the model is the platform's own choice and this is a setting for an **agent**.

### Fixed

- **The Build, Flash and Monitor controls no longer appear in every window.** They were drawn whenever the
  status bar existed, which is to say always — in an unrelated folder, in a plain text file, in a workspace
  that has nothing to do with embedded Rust. They are now gated on a loaded project, the same rule the rest
  of the extension already used.
- **A dropped widget's context menu no longer draws some of its rows in black.** `.context-item` had no
  colour of its own, and a `<button>` does not inherit one — so the rows that were not `.danger` and were not
  hovered were painted in the platform's default, which on a dark menu is black on black. The rule is now
  explicit, and it is a rule rather than a colour so it holds in every theme.
- **"Fix the Build" did nothing on a real project.** Three separate causes, all of them found by running it
  against a project that would not compile:
  1. the build ran **without the ESP environment**: an ESP32 project cannot link without the Xtensa linker
     that `source ~/export-esp.sh` puts on the PATH, and the extension host has never sourced it — so cargo
     died in `build.rs` with no diagnostics at all and the loop had nothing to fix. Both in-process build
     paths now read that file and use it (`espEnv()`, the same one the terminal commands use).
  2. the designer wrote `src/ui.kdl` but **never regenerated `src/ui.rs`**, so a save that removed a widget
     left the generated module calling a handler for a widget that no longer existed — a build error that no
     amount of AI could fix. The module is now written on every designer save, with the markup it belongs to.
  3. every error sat inside an **852-line `main`**, over the 120-line limit a small local model can rewrite,
     and each one was skipped in silence. The report now says why each error was skipped, which turns
     "nothing was attempted" from a broken feature into an explanation.
- **The assistant could replace a whole file it had only half-read.** The prompt asks for the changed item
  only, the answer is refused if it elides anything (`...`, `// ...`), and a whole-file-shaped answer is
  confirmed in a modal that names the file before it can be applied. This is the failure that prompted all of
  it: a request against a 41 KB `main.rs` came back as a whole file with the parts the model could not see
  left out, and every item it did not reproduce was deleted.
- **The answer budget is measured, not assumed.** The window is shared with the prompt and the answer gets
  what is actually left; the default context went from 4096 to 8192, `contextForBudget` — which existed and
  was never called — is now what decides the window a request starts with, and an answer squeezed into too
  little room says so, with the numbers, instead of coming back cut short for no visible reason.
- **A design that raises no event generated a dead-code warning.** With no event arms nothing in the
  generated file reads the widget handle, so the compiler called it unused — a warning in every generated
  project whose design has no events yet. The attribute is now emitted only in that case, so a design that
  *does* raise events still hears about a handle with genuinely nothing reading it.

### Changed

- The vendored crates gained the widget work behind all of the above: the checkbox's size, label side and
  colour, a way to draw text with a chosen font, and a **`rich-widgets`** feature gating the runtime-widget
  items a project does not use. A project picks the new crates up with **Update Crates**; nothing needs
  rewriting.
- Generated projects now carry the `#[allow(dead_code)]` above only where it is needed, so a fresh project
  builds with no warnings of the extension's making.

## [0.0.76] - 2026-10-09

### Added

- **"Disable it so it doesn't come back" -- a third button in the assistant's stop dialog.** A `llama-server` run
  as an *enabled* systemd user unit returns at every login by design, which is the point of enabling it and a
  surprise every time: the dialog said so ("the unit is enabled, so it comes back at your next login") and then
  stopped it anyway. Now it offers to end that: the button stops the server **and** takes the unit out of the
  login target (`systemctl --user disable`), so the assistant's switch becomes the only thing that starts it.
  Offered only where it can act -- a **user** unit that `systemctl` reports as **enabled**; a system unit needs
  root, and a unit whose state could not be read is not guessed at. The README and `AI_ASSIST.md` say the same,
  and the decision is pure data (`assistantSwitchPlan.disableOfferFor` / `disableUnitCommand`), so it is asserted
  rather than clicked.
- The dialog explains the button where it appears: disabling stops the server now and keeps it from starting by
  itself, while the assistant can still start it on demand.

## [0.0.75] - 2026-10-09

### Fixed

- **A rounded border is a ring, not a block in each corner.** The corner of a stroked rounded rectangle was
  scanned with an inset loop that tested every inset *below* the border's width -- which for a one-pixel border,
  the ordinary case, tested nothing at all, so every pixel inside the corner's arc came out in the border colour.
  At the crate's default radius of 2 that is a two-pixel square nobody notices; on a button or a busy wheel given
  `corner_radius=10` it is four visible blocks. The ring is now the outer rounded rectangle minus the one inset
  by the border's own width, with the radius shrinking with it -- which is also the first time a border thicker
  than one pixel has been the thickness it was asked for. Measured: the corner of a hairline border went from
  **98 painted pixels to 19** in the crate, and from **392 border-coloured corner pixels to 60** on the designer's
  canvas. Introduced in 0.0.67 with the appearance work, and invisible until a radius large enough to show it.
- The same arithmetic in the designer's canvas (`preview.ts`), which mirrors the crate stroke for stroke, so the
  preview and the board agree.

## [0.0.74] - 2026-10-09

### Fixed

- **A touch no longer re-reads the whole image from the card.** The engine renders every widget whose cell it
  walks and clips only the *painting* to the damaged rectangle -- free for a widget that fills rectangles, and
  ruinous for one that reads a file while drawing. So a touch anywhere on the glass re-opened the card file and
  streamed the picture again, several times a second: with an image on the screen every tap took about as long as
  the picture took to read. A custom widget can now ask the canvas what is left of its rectangle
  (`CustomCanvas::visible_rect`), and `BmpImage` asks before it opens anything -- nothing visible, nothing read.
- **A partly repainted image reads only the rows being repainted.** Rows outside the damaged band are jumped
  over along the FAT rather than transferred, and the first wanted row is reached by the same jump, so a repaint
  of a band costs what the band shows rather than what the file holds.

Both halves are in the vendored crates, so an existing project picks them up with **Update Crates** -- no
generated file changes and no project to recreate.

## [0.0.73] - 2026-10-09

### Fixed

- **Every setting in the property pane fits the pane, with no side-scrolling.** The geometry fields ran off it on
  every widget: two columns of X/Y/Width/Height, each as wide as the number input's own default width plus its
  label, came to 579 px inside a 260 px pane -- 319 px of it reachable only by dragging a horizontal scrollbar.
  Measured in a real browser rather than reasoned about: **128 of the 132 pane states** the Toolbox can produce
  overflowed before, and **0 of 132** do now, across four window widths. A path field (`Source`, `File`, a
  composite icon's part) was the same bug waiting to happen -- an input and its `...` button in one unstyled
  `div` is a single unbreakable line no pane can narrow.
- The pane's contents are capped at the pane's width, the two geometry columns may shrink to nothing, a row's
  label gives up width before its control does and shows an ellipsis where it did, and the middle pane can no
  longer push the property pane off the side of the panel. A checkbox is no longer stretched across its row.

### Added

- **`tests/tools/designer-layout.js`** -- opens the Designer in Chromium, walks every control the Toolbox offers
  at four window widths, and reports any pane whose content is wider than the pane. It is run by hand and needs a
  browser (the file header says how); `tests/layers/t1-logic/designer-panel-layout.test.js` guards the same
  rules as stylesheet invariants, so a regression is caught by the suite.

## [0.0.72] - 2026-10-09

### Changed

- **An image from the card draws in a fraction of the time.** Three things were making one photograph cost
  seconds, and each is measured and fixed:
  - **A read of the card is one 512-byte block transfer whatever is asked for.** `embedded-sdmmc` 0.8 moves a
    whole block per call and caches nothing between calls, so the reader's 128-byte requests fetched the same
    block four times over. Requests are now exactly one block, for **4× fewer transfers** on any file.
  - **Rows nobody will see were transferred anyway.** The card reader now *seeks*: the source rows between the
    ones a shrunken image samples are jumped over, and a jump walks the FAT — a handful of sectors — instead of
    the data. For a three-megabyte phone photo drawn into a 244 × 440 cell, the transfer falls from 3 146 154
    bytes to 987 426 — **12.7× fewer blocks** — with 2 158 728 bytes stepped over.
  - **Every run of colour was its own address window on the display.** The canvas gained `fill_row`, so a decoded
    row reaches the glass in one call: the same picture costs **440 display windows instead of 80 762**.
- **The card is read at 10 MHz once it has answered**, 25× the 400 kHz the handshake must use. With that clock,
  the measured reductions put a 160 × 200 image from the card at roughly **a tenth of a second** instead of
  something like six seconds, and a three-megabyte photo at roughly **a second** instead of minutes. (The
  traffic and window counts are measured; the seconds are that traffic at the two clock rates.)

### Note

- The seek and the clock live in the generated `src/sd.rs`, the reader in the vendored `rusty-gui-widgets`, and
  the row blit in the vendored runtime. A project made by an older version gets all of it by being recreated, or
  by *Update Crates* plus the new move in its `src/sd.rs` — the module still compiles without it, because a
  stream that cannot move is simply read past.

## [0.0.71] - 2026-10-09

### Fixed

- **A photo on the card draws, whatever its size.** The card reader refused any BMP wider than 480 pixels — the
  widest panel the platform drives — because it held one converted row of the whole source on the stack, and a
  refused file draws *nothing*: a 1122 × 1402 photo from a phone left the cell as it was, which looks exactly
  like a card that was never mounted. A source wider than the cell is now **reduced as its row is read**, in one
  forward pass, so any file size draws with the same 960 bytes of stack and only the colours the cell shows are
  kept. Proved against the real 3 MB file: every sampled colour matches an independent decode of the same BMP.
- **A BMP written by a modern editor is read.** A 124-byte `BITMAPV5HEADER` (the masks 54 bytes in, the pixels
  starting at 138) parses like the 40-byte one, and the offsets are pinned by a test that builds that header.
- **A corrupt header is refused instead of multiplied.** A width beyond a million pixels would wrap the stride
  arithmetic; it is now rejected.
- **`SD:` is the same card as `sd:`.** The prefix is matched without regard to case — in the generated parser and
  in every designer check (the short-name rule, the board-has-a-socket report, the missing-asset report) — so a
  name spelled the way a file manager shows it is not quietly treated as a file to embed in the flash, which is a
  different feature that fails a different way.

### Changed

- **The card is read at 10 MHz after it has answered, not 400 kHz.** The handshake stays at 400 kHz as the
  specification requires, and the bus is re-clocked through `SdCard::spi` afterwards: a 3 MB photo streamed at
  400 kHz is about a minute of a screen that does not answer, and a few seconds at 10 MHz. A refused re-clock is
  logged and leaves the card readable, just slowly. This lives in the **generated** `src/sd.rs`, so an existing
  project picks the reader fix up from *Update Crates* (the widget is vendored) but keeps its old, slower module
  until that module is regenerated.

## [0.0.70] - 2026-10-09

### Added

- **An On/Off switch for the AI Assistant**, at the top of the AI Assist panel and in the palette as
  `Rusty AI: Toggle On/Off` (so it can be bound to a key). **Off is the default**, and it means what it
  says: every model that can be named is unloaded (LM Studio's `lms unload --all`) and the `llama-server`
  serving the configured endpoint is stopped — including one this window did not start, after asking once per
  window. **On** starts what the settings say to start: a server already answering the endpoint is adopted, the
  configured `llama-server` unit is started, or the bundled runtime is started with the model the settings
  name. A completely unpinned setup opens the model picker rather than pretending to be on.
- **`Stop the local servers when a window starts with the assist off`** — a checkbox under the switch
  (`rustyPlatform.assistant.stopServersAtStartup`, on by default), because "off" should mean the models are
  unloaded and the server is stopped even at launch, but someone who runs their own `llama-server` for other
  work may not want an editor deciding that. The startup question offers "Stop asking at startup", which turns
  the option off for you.

### Changed

- `rustyPlatform.assistant.backend` no longer decides by itself whether the assistant answers: the new
  `rustyPlatform.assistant.enabled` switch is read first, so an assistant that is off does not answer however
  well the endpoint is configured. The panel's "pinned" line says the switch is off instead of looking ready.
- Stopping a server asks **once per window**, and the answer is remembered either way — including "leave it
  running", which is not asked again. A server this window started, and the models a runtime is holding, are
  never a question.

### Notes

- A systemd **system** unit is still refused rather than attempted (it needs root), and the report says which
  `sudo systemctl stop` to run; a port whose owner cannot be identified is named as such instead of being
  signalled on a guess.
- The suite is at 859, with nine new tests over the off-decision, the consent memory and the two settings'
  defaults.

## [0.0.69] - 2026-10-09

### Added

- **An Image can come from the microSD card instead of the flash.** A design names the file as
  `src="sd:PIC1.BMP"` and the board reads it while it draws, a row at a time, so a full-screen image costs a row
  of RAM rather than a copy of the file in the firmware. Uncompressed BMP is what the card holds — 24- and
  32-bit, or 16-bit with either colour layout — which any image editor writes and which the device can parse
  without a decoder.
- **The card is set up for you** on boards whose definition declares a socket (the ESP32-035, on its own SPI
  bus: CS 5, clock 18, out 23, in 19). A new Designer project on such a board gets a `src/sd.rs` that mounts
  the card and a call to it in `main`, and the extension reports what to add if a project was created before
  this version. Boards with no socket (the T-QT) are untouched, and a design that names a card image on such a
  board says so in the panel rather than failing to compile.
- The card is read with **short 8.3 file names from the root**, which the panel checks: a generated project has
  no allocator for long names, so `sd:holiday photo.bmp` is a file the firmware cannot open. The canvas names
  the file an SD image will read instead of drawing a picture it cannot see, which is also how a typo is caught
  before a build.

### Notes

- The drawing half is `rusty_gui_widgets::BmpImage`, which links no filesystem: the project hands it a
  `with_file` callback from its own `src/sd.rs`, so the same widget works against a card, a flash chip or a
  slice in a test. It reads each row once, in the order the file holds it, with a single cached row and one
  rectangle per run of colour; a pixel that straddles a read buffer is carried rather than lost.
- The shapes crate is at 27 tests (eight of them the image reader, from the row order to a truncated file), the
  codegen fork at 23, the vendored runtime at 232, and the hermetic suite at 850.
- The generated card module is proved by a real cross-compile rather than by the host suite: a Designer project
  for the ESP32-035 was generated and `cargo check`ed under the ESP toolchain for `xtensa-esp32-none-elf`, which
  is the only thing that can exercise esp-hal's SPI, CS and delay setup.

## [0.0.68] - 2026-10-09

### Added

- **Every tag the markup supports can be built now.** Ten tags were documented but refused — the Toolbox would
  not hand out a control whose generated code did not compile, and the validator explained why if a design
  already contained one. Six were generator bugs (a **Slider** whose float value arrived in the wrong order and
  the wrong type; a **Sweeping arc** that was not the widget the runtime has; a **Busy wheel** calling a builder
  that does not exist; a **Chart** and a **Plotter** sharing one tag with a mode neither has; a **Vector path**
  that generated code naming types that do not exist), and five were widgets the runtime shipped as drawings the
  engine could not reach (**Status bar**, **Time picker**, **Number picker**, **Content indicator**, **Crumbs**).
  All ten generate compiling code and are offered again; the `unavailable` list is empty.
- **A Vector path is a real shape now**, drawn by `rusty-gui-widgets` through `add_custom_widget`: SVG-style
  commands in pixels from the widget's corner, stroked in its own colour, with curves flattened into a fixed
  twelve segments each so the board and the canvas walk the same line.
- **A Toggle's switch can have an outline of its own** — `Track outline` and `Track outline width` — separate
  from the frame that `Border colour`/`Border width` draw.

### Changed

- **A Chart and a Plotter are two widgets, not one.** A chart is a filled graph of a series; a plotter is a
  scrolling trace with a head index where the newest value goes in. Each carries the series it starts with
  (`Values`, e.g. `2,5,3,8,6`), and each gained an `Accent` — the colour the crate draws the series in.
- **A Slider's value is a decimal**, not a whole number: the crate's slider is a float widget, and its whole
  numbers were a limit of the markup rather than of the widget.
- **A Sweeping arc's parameters are the widget's own**: `Progress`, `Clockwise`, `Arc radius`, `Frame inset`,
  `Corner radius` and its three colours, replacing the start/end angles the runtime never had. `Frame inset`
  now defaults to 14 rather than 4, because the frame is an opaque card painted over the sweep and the old
  default hid the arc completely in a freshly dropped widget.
- **The Number picker offers no colours**, because the crate's picker paints its own card and reads none: a
  colour field there would have changed nothing on the glass.
- The **Content indicator** is described as what it is — a chevron pointing up or down — rather than as a row of
  dots, which is the Crumbs widget.

### Fixed

- A latent panic in the crate's time picker: it floors its cell height at 24 pixels and then subtracted it from
  the bounds, so any time picker shorter than that underflowed. The default size was taller, which is why it had
  never been hit.

### Notes

- The hermetic suite is at 845, the vendored runtime's own tests at 232, the codegen fork's at 22 and the shapes
  crate's at 19. The host simulator now carries all eleven tags in its fixture: the generated calls compile
  against the vendored runtime and painting them changes 67854 pixels inside 27 measured regions and none
  outside them.

## [0.0.67] - 2026-10-09

### Added

- **The six controls that had no appearance settings now have them.** A **Toggle**, **Checkbox**, **Roller**,
  **Progress bar**, **Spinbox** and **Gauge** can each be given a background, a border colour and width, a
  corner radius and their own text/accent colours; a Gauge also gains its tick and needle colours, its tick
  counts, the start and end of its sweep and whether its labels and needle are drawn. Until now the generated
  code passed a *constant* style for all six — `Style::default()`, which is a plain label with no background and
  no border — so none of the colours the design named could reach the board at all.
- **A Gauge's value can be changed from firmware.** `ScaleWidget` implements `Value`/`Min`/`Max` accessors but
  the engine's node dispatch had no arm for a scale, so `set_widget_property(gauge, PropertyKey::Value, …)`
  answered `NotFound` for the one widget whose whole purpose is to show a number that moves.
- A **Spinbox's Digit and Decimal fields now reach the board.** The generated call fixed both at 4 and 0, so the
  panel's own fields did nothing: a design asking for six digits still rendered four.
- The **Spinbox** and the **Gauge** are now previewed on the canvas instead of as a placeholder outline: the
  spinbox's value, its focused-digit underline and its `-`/`+` buttons, and the gauge's ticks, labels and needle
  for all three of its modes.

### Changed

- The **Checkbox's box is no longer capped at eight pixels**. The crate computes it as `inner.h.min(8)`, which is
  why it looked lost in anything taller than a row; the design can now name a size (still capped to the row, so
  it can never draw outside its own cell).
- The **runtime is vendored alongside the codegen fork** (`codegen/embedded-gui`), because a few of the values
  above are read inside its renderers where no markup can reach them: a checkbox's box size, a toggle's
  off-track colour, a gauge's tick and needle colours, and the two colours inside a spinbox. An alternative —
  drawing these controls with `add_custom_widget`, as the shapes are — was rejected on evidence: the engine does
  not forward `get_property`/`set_property` to a custom widget, so such a checkbox could not be read or set and
  such a gauge could not be given a value.
- A colour in the panel is applied **on the style that tag already wore**, so naming one colour changes one
  thing: a border *colour* asks for a border (one pixel, unless a width is named), a width on its own thickens
  the border the widget already had, and a corner radius of `0` keeps the widget's own corners rather than
  squaring them. A background clears the base style's gradient, which would otherwise paint over it.

### Notes

- Every change in the vendored runtime is additive and defaults to upstream's own constants, so a project whose
  markup says nothing about appearance renders exactly as before — measured, not asserted: the host simulator's
  fixture was extended with a checkbox, a spinbox, a roller and a gauge carrying colours that appear nowhere
  else, and stripping those colours changes 61390 pixels inside those widgets and none of the 79900 outside them.

## [0.0.66] - 2026-10-09

### Added

- **A Triangle is any triangle.** Each of its three points has its own diamond handle on the canvas and can be
  dragged wherever on the glass you want it, not only to the three places an isosceles triangle reaches. The
  widget's box follows a point — it grows around the three of them — so a vertex can be dragged out past the box
  it started in, and the box's own eight handles still resize the whole shape. The points are also in the
  Properties panel under **Points** (six offsets of a thousandth of the box), for when you want them exact.
- The points travel to the board as the six markup attributes `p1x`..`p3y` that the vendored
  `embedded-gui-codegen` fork passes to `rusty_gui_widgets::Triangle`, which maps them into its cell with the
  same arithmetic the canvas uses. A design written before this keeps the isosceles triangle it always had —
  both the parser and the crate default the same six values — and the attributes are optional in the design
  file, so an older design is still valid rather than reported as incomplete.
- **The designer offers to refresh a project's vendored crates when they are not this extension's copy.** A
  Designer project builds against the `codegen/` copies of those two crates, made by whichever version created
  the project, so a project made before a change keeps the old markup vocabulary: an older fork reads the three
  triangle attributes it knows, ignores the six it does not, and paints a different shape without complaining.
  The copy now records which extension version made it, and the designer says so and offers **Update Crates**
  on opening such a project, once.

### Changed

- A triangle's base now sits on its box's last row instead of one row below it. The old shape left the box —
  `embedded-gui`'s `Rect::bottom()` is `y + h`, not the last row — and the engine's clip to the widget's cell
  is what made it look right; the new geometry never leaves the box, and an even-width triangle's apex is the
  middle column to within a pixel rather than necessarily the left of the two.

## [0.0.65] - 2026-10-09

### Fixed

- **A circle no longer has its top and bottom edges clipped.** The disc was measured from a centre of `x + w/2`
  with a radius of `min/2`, which on an even-sized box puts its extreme pixels one pixel *outside* the box —
  where the board's clip to the widget's cell, and the canvas's clip to the same rect, shaved them flat. The
  disc is now the one inscribed in the box, measured in half-pixels (a pixel's centre is `2i + 1`, the box's
  centre is `w`) because an even-sized box has no whole-pixel centre; the canvas draws the same circle and its
  outline as the annulus *inside* the radius, rather than a pen straddling the edge and being clipped there.
  The host measurement shows the disc regaining its clipped row and column: `708` of `1200` pixels in its cell
  became `716`, and nothing is painted outside any cell.
- The Geometry panel's Centre/Radius numbers are unchanged: they are whole pixels for editing, and the box a
  radius produces still has exactly that radius back.

## [0.0.64] - 2026-10-09

### Added

- **The canvas is WYSIWYG: it draws what the board draws.** Labels, buttons, panels, toggles, checkboxes,
  sliders, progress bars, dropdowns, rollers, tables, dialogs and carousels are no longer rounded rectangles with
  their type name in them. Each is drawn with the crate's own arithmetic and colours — `Block`'s background,
  gradient, border, corner radius, shadow and padding, then the widget's own content — using the style the code
  generator actually gives that tag, and clipped to the widget's own rect the way the engine clips it.
- **Text is drawn in the crate's own fonts.** `webview/designer/glyphs.ts` is generated from
  `embedded_gui::font::glyph_rows` (and, for the vector face, from `get_vector_glyph`'s polylines — `Vector(n)`
  is not a bitmap), so what the canvas measures is the font the board will use rather than one that looks like it.

### Changed

- The canvas draws shadows with the crate's ordered dither and gradients at the crate's per-row quantisation,
  instead of a canvas alpha shadow and a smooth `createLinearGradient`: the board's default compositor does not
  alpha-blend, so the smoother version would have been darker than the glass.
- `Progress`, `Slider`, `Toggle` and `Checkbox` are drawn with the style the emitter hard-codes for them
  (`Style::default()` — no background, no border). They previously looked like themed panels, which was prettier
  than the board and therefore a lie.

### Verified

- 807 hermetic tests pass (7 of them new, driving the real built bundle and asserting exact canvas
  geometry: a slider knob's x at min/mid/max, a progress fill's width at 0/.25/.5/1, a toggle's track colour
  against `checked`, a button's gradient stops and glyph pixels, and a table's header row before its body rows).
  `tsc` clean on both sides; all four host checks pass.

### Performance

- Shadow rings are painted the way the crate paints them — clipped to the band outside an inset core, which the
  crate's own test shows is pixel-identical (`block.rs:225-290`) — instead of filling each ring whole. The rings
  are ordered-dithered, so a whole-ring fill cost one canvas op per ~1.7 pixels of the ring's *area*: 24 543 ops
  for a 360x120 panel, on every repaint. With the band it is 1 315, and the cost now grows with the widget's
  perimeter rather than its area (120x40: 2 783 -> 435; 240x80: 10 963 -> 875; 360x120: 24 543 -> 1 315).

### Known approximations

- A declared **BDF font** on a Label/Carousel/Button draws with the crate's default glyphs, because the `.bdf`
  data is not shipped to the webview: the base style is honoured, the glyphs fall back to `Tiny3x5`.
- **Vector text** uses the crate's own polylines, but a canvas 1px stroke blends where the crate dithers it.
- The **dither phase** can differ under a 90/270 degree rotation, since the pattern is indexed by the board's
  framebuffer and the canvas works in design coordinates.
- **`image`/`icon`** previews still need the assets handed to the webview (the next slice); **`mesh`** has no
  renderer at all, so both keep the designer's placeholder.

## [0.0.64] - 2026-10-09

### Fixed

- **A Table's cells now reach the board.** The KDL parser has always collected a table's `headers` and `row`
  lines, and the code generator's table arm then passed `&[]` to `add_table` — so a table painted its
  panel-styled block and none of its contents, however carefully it was written in the designer. The vendored
  fork now emits the header and the body rows (the header first: the renderer has no separate header concept),
  with `{:?}` string literals so a quote in a cell cannot break the generated code.

### Verified

- The vendored fork's own test compiles a table and asserts the emitted `add_table` call carries every cell
  (19 fork tests pass), and the host simulator's fixture now contains a table, so the call is compiled by the
  real `include_gui!` against `embedded-gui` and measured: all four host checks pass with it in place.

## [0.0.63] - 2026-10-09

### Fixed

- **0.0.62 shipped two leftovers that should not have been in it**, and this removes them:
  - an `Open Designer` button inside the Designer panel's Toolbox (the two earlier placements of that button that
    the sidebar row replaced), together with the `openDesigner` action and host routing it needed; and
  - a test that fails from a clean checkout, because it asserted the panel button that is no longer there.

  The cause is worth recording: the changes were committed to `main` by the *session's automatic worktree
  commit* while the working branch was still based on an earlier commit, so reverting them in the working tree
  was not a change relative to that base — the merge kept `main`'s copy of everything the revert had removed.
  The fix is the removal made against the current base, and the merged tree is now checked rather than assumed:
  `grep` for the leftovers and the full suite, after the merge. See `NOTES.md` §105.

  The 0.0.62 feature itself is unaffected: `Open Designer` is the first row of the Controls section.

### Added

- **The designer canvas's glyph table, generated from the crate** (`webview/designer/glyphs.ts`, written by
  `node tests/tools/glyph-table.js` from `tests/sim/src/bin/glyphs.rs`). It reads
  `embedded_gui::font::glyph_rows` for every printable ASCII character, so the canvas can draw text in the font
  the board will actually use rather than one that looks like it. Groundwork for the WYSIWYG canvas: nothing
  draws from it yet. The generator dedupes identical tables (the fonts share one table except that `Medium4x7`
  spells `*` and `@` differently), it can `--check` the committed file against the crate, and three tests pin
  its contents.

## [0.0.62] - 2026-10-09

### Added

- **An `Open Designer` row at the top of the Controls section** in the Rusty Platform sidebar. It runs the
  `rustyPlatform.openDesigner` command — the same one the Command Palette and the Project view's title-bar icon
  use — so there is one implementation behind all three doors, including the question it asks when no project is
  open. The designer had no button in the sidebar at all: its only entry point in the interface was a title-bar
  icon on the Project view, which is not where anyone looks for a command.

### Verified

- 796 hermetic tests pass. A new one pins the row: it leads the Controls section, matches the command's own
  title, carries the icon, detail and tooltip its neighbours carry, and stays out of the status bar (which keeps
  its six rows). `tsc` clean on both sides.

## [0.0.61] - 2026-10-09

### Changed

- **Shapes draw in rows now, which is what the panel charges for.** A generated project writes to the display
  over SPI with no framebuffer, so a pixel costs an address window and a whole row costs about the same. The
  shape widgets filled pixel by pixel — a circle was about `pi·r²` individual pixel writes, a triangle's
  interior one per pixel, a line `thickness` per-pixel segments — and they now emit one `fill_rect` per row: a
  disc is `2r+1` calls (81 instead of about 5000 for r=40), a ring at most two runs a row, a triangle one run per
  scanline, and an axis-aligned line a single rectangle. A rounded rectangle's outline is four rectangles plus
  its corner arcs, where it was four per-pixel edges.
- The same pixels, exactly: the spans cover precisely what the distance test covered, and the host check that
  measures the real engine reports the identical counts as before (`708 of 1200` for the disc, `822 of 1600` for
  the triangle, `320 of 320` for the line, nothing outside any cell).

### Added

- **The full paint is now timed in the log**, so a change to rendering can be judged on the glass rather than by
  feel: `design: painted 480x320 in N ms (full frame)` on the touch path, `design drawn: WxH in N ms` on the
  touch-less one. (`Instant` is imported only where it is used, because an unused import is a warning in a
  generated project.)
- Three tests pin the *call counts* — a filled disc makes `2r+1` runs and no per-pixel calls at all, a ring at
  most two runs a row, a filled triangle one run per scanline — because a regression to per-pixel drawing would
  look identical and be an order of magnitude slower.

## [0.0.60] - 2026-10-09

### Added

- **Shapes are now real on the canvas *and* on the board.** Circle, Rectangle, Line and a new **Triangle** are
  drawn by the designer as themselves, and rendered on the glass by a vendored `rusty-gui-widgets` crate of
  `CustomWidget`s together with a forked `embedded-gui-codegen` that emits `add_custom_widget` calls instead of
  the `add_panel`/`add_spacer` stubs that made a circle a square. Every dimension comes from the cell rectangle
  the engine lays out, so the canvas and the glass cannot disagree about geometry. Designer projects vendor both
  crates under `codegen/`; nothing is fetched at build time.
- A **Geometry** form for a circle — centre and radius, derived from its bounding rectangle — so the shape is
  edited the way it is described.

### Fixed

- **Every non-Designer ESP template failed to resolve its dependencies.** The `[patch.crates-io]` that points at
  the vendored codegen was written into *all* of them while the crates were only copied for the Designer
  template, and cargo resolves a patch entry even when nothing uses it:
  `failed to load source for dependency embedded-gui-codegen … No such file or directory`. The patch is now
  written only where the crates are copied.
- **A pen width of 0 drew a 1 px outline on the board** while the canvas drew none, for both the circle and the
  rectangle. Zero now means no outline on both sides.
- **A rounded rectangle's outline was square on the board** (and rounded on the canvas): the fill and the outline
  are now the same shape, the outline's corners being integer mid-point arcs.
- **A circle with Fill off erased what was behind it on the canvas** (it painted the screen colour) where the
  board leaves the backdrop. An unfilled shape now paints nothing on both sides, and one that paints nothing at
  all gets the designer's dashed placeholder outline so it is still visible and selectable.
- Two `unused_must_use` warnings in the vendored widgets crate, one of which (`Line`) silently swallowed a
  drawing error that every other shape propagates.

### Changed — vendored code

- The vendored `embedded-gui-codegen` fork now carries its upstream **licence texts and attribution**
  (`LICENSE`, `LICENSE-MIT`, `LICENSE-APACHE`, a provenance `README.md`, and the `license`/`authors`/
  `repository` fields restored in its manifest). It was redistributing MIT/Apache-2.0 code in every generated
  project without them.

### Verified

- Shapes are now measured end-to-end on the host, not just compiled: the appearance check strips their ink in the
  comparison render and requires every pixel inside their cells to change and nothing outside to.
  `the appearances changed 33453 pixels inside their widgets (34, 78, 110, 2688, 20, 19073, 708, 4800, 4800, 822,
  320 of their respective areas) and none of the 108500 outside them` — `708 of 1200` for a 40×30 cell is π·15²,
  the disc to the pixel.
- The vendored crate's tests grew to 10 (a zero-width pen paints nothing; a rounded outline has no sharp corner),
  the host checks all pass, a generated Designer project builds for `xtensa-esp32-none-elf`, and a generated
  non-Designer project resolves its dependencies again.
- 795 hermetic tests pass; `tsc` clean on both sides.

## [0.0.59] - 2026-10-08

### Added

- **A Text colour property on Label and Carousel.** The crate paints text as
  `TextStyle::new(style.text).with_font(style.font)`, but the markup has no colour attribute for a label — so the
  colour travels in the widget's `style` expression, alongside the base look and the font, because there is only
  one `style` attribute to write. The `#rrggbb`-to-5/6/5 reduction is the crate's own, pinned by a test so the
  canvas swatch and the pixel cannot drift apart. A button keeps its real `text_color` attribute and is not
  affected.

### Fixed

- **A created project opens as a folder, not as a workspace.** The previous release made the new folder part of
  the window with `updateWorkspaceFolders`, which does not produce a plain window with a folder in it — adding a
  folder to a window that has none produces an *untitled workspace*, which VS Code then wants saved as a
  `.code-workspace` file. A generated project therefore arrived as a workspace and stayed one. It now opens with
  `vscode.openFolder`: one root, no workspace file, the same as every other template. The reload that costs is
  handled by the Designer request that survives it.

### Note

- The rest of the answer to "how do I set a control's font and colour" is that most controls cannot be given
  either: `embedded-gui-codegen` hard-codes the style it passes for every tag except Label, Button, Panel and
  Carousel. The full table is in `NOTES.md` §101; the README says the same in a paragraph.

### Verified

- The host appearance check now covers five routes in one run:
  `the appearances changed 2930 pixels inside their widgets (34 of 2700, 78 of 2700, 110 of 2700, 2688 of 2700,
  20 of 2700) and none of the 140100 outside them` — a declared BDF, a built-in font on a label, a built-in font
  on a button, a base style on a label, and a text colour on a label.
- 786 hermetic tests pass; `tsc` clean on both sides; all four host checks pass.

## [0.0.58] - 2026-10-08

### Fixed

- **A widget with children produced markup that could not be parsed at all.** A dropdown, roller, carousel,
  table or icon was written with its children on deeper lines and no braces — but KDL has no indentation-based
  nesting, so they were *siblings* of their widget, and the crate's codegen rejected them with
  `Unknown widget or container node: 'option'`. Children are now emitted in a proper `{ … }` block. Found by
  building a probe design that contains one widget of every tag in the Toolbox, which is what the host fixtures
  had never done.

### Changed

- **Ten tags are no longer offered in the Toolbox**, because `embedded-gui-codegen` 0.2.7 emits code that
  `embedded-gui` 0.2.7 cannot compile: `slider`, `arc`, `busy_wheel`, `chart`, `status_bar`, `time_picker`,
  `number_picker`, `content_indicator`, `crumbs` and `path` (see the table in `NOTES.md` §100 for the exact
  compiler error behind each). A design that already contains one is reported by name when it loads, with the
  reason, and can be selected and deleted — so a project never has to be debugged through a macro expansion.
  The toolbar, the catalogue and validation all agree on the set.

### Verified

- One widget of every tag in the Toolbox, built for `xtensa-esp32-none-elf` with the real toolchain: before the
  nesting fix the build stopped at a parse error on `option`; after it, every tag except the ten above compiles.
- 786 hermetic tests pass; `tsc` clean on both sides; all four host checks pass.

## [0.0.57] - 2026-10-08

### Added

- **A Style field on the controls whose appearance the crate takes from one** — Label, Button, Panel and
  Carousel. It offers the four base looks that actually differ (`plain`, `panel`, `progress`, `button`), which
  is how a control gets a background, border, shadow and corner radius its own properties cannot give it: a Label
  can wear a panel's card, a Panel a progress bar's thin horizontal fill. Which controls offer it follows the
  crate's emitter, and a Table is given none because its arm hard-codes `Style::panel()` and ignores the
  attribute. The list is closed rather than a text box on purpose: the crate passes a name it does not recognise
  through *verbatim as Rust*, so a typo would be compiled rather than ignored.
- A chosen style and a chosen built-in font are composed into a **single** `style` attribute, since a built-in
  font is itself a style expression and the markup cannot carry both.

### Changed

- The Designer's font and style handling now lives in `src/designer/appearance.ts`, which owns the one expression
  a widget needs from either route.

### Verified

- The host pixel check measures every widget the design gave an appearance to, by all three routes:
  `the appearances changed 2910 pixels inside their widgets (34 of 2700, 78 of 2700, 110 of 2700, 2688 of 2700)
  and none of the 142800 outside them` — a declared BDF, a built-in font on a label, a built-in font on a button,
  and a base style on a label.

## [0.0.56] - 2026-10-08

### Added

- **A font picker.** The Font field now lists the crate's own fonts — Tiny 3x5 (the default), Medium 4x7,
  Scaled 6x10 and two scales of the vector face — alongside the BDF fonts the screen declares, so a face can be
  chosen without a file. The `…` button stayed, and now declares a font from the file it opens *and* selects it on
  the widget, in one undoable step, instead of leaving the user to add a declaration elsewhere and come back.
- A Font field on **Button** too (built-ins only). Which widget offers one follows what the crate reads: a
  declared `font="name"` reaches Label and Carousel, a `style` expression reaches Label, Button and Carousel, and
  a Table is given none at all because its emitter arm hard-codes the style and would drop one in silence.

### Fixed

- **A project created with the Designer template is now loaded into the IDE.** Its notification offered only
  "Open Designer", which opened the canvas without ever making the folder part of the window: no Explorer entry,
  no Source Control, no terminal in it. Creating a project now loads the folder whatever the answer is —
  including "Later" and "Build Now", which used to leave it out too — by adding it to the current window, with a
  reload kept as the fallback for a host that will not take it. Because loading a folder can restart the
  extension host, a Designer that was asked for just before that restart is remembered and reopened on the other
  side of it.
- A built-in font name in the Font field used to be markup that did nothing at all: the crate's own fonts are not
  declarable, so `font="Scaled6x10"` was dropped without a word. They now travel as a `style` expression, which is
  the only route the crate has for them — and which for a button has to be a `WidgetStyle`, since the emitter
  chains its colour builders onto whatever the expression returns.
- Validation refuses a *declared* font on a widget the crate does not read one for, which would otherwise be the
  same silent drop one step further out.

### Verified

- The host pixel check measures every fonted widget in the fixture rather than one, across both routes:
  `the fonts changed 222 pixels inside their widgets (34 of 2700, 78 of 2700, 110 of 2700) and none of the 145500
  outside them` — the declared BDF, a built-in on a label, and a built-in on a button.

## [0.0.55] - 2026-10-08

### Added

- **Touch is a choice.** A Designer project is asked about it in the wizard, beside the rotation question, and
  the designer's toolbar can change it later — both write `TOUCH_ENABLED` in `.cargo/esp-config.toml`, which the
  firmware reads at compile time, so the choice survives `src/main.rs` being written once. Touch **off** means no
  XPT2046 driver, no calibration read and no calibration screen: the design is drawn and nothing responds.
- **Dropping a control turns touch on.** A widget is interactive exactly when its catalogue entry declares an
  event, so the rule is data-driven: drop a Button, Slider or Toggle and touch is enabled with a note saying a
  rebuild is what makes it real. Dropping a Label does nothing.
- **Switching touch off with controls in the design is reported, not enforced**: those controls will not respond,
  and the panel says so while still saving the design.

### Notes

- Only `"0"` turns touch off, and an **absent** key means on. That is deliberate: every project generated before
  this setting existed had a working touchscreen, and a default of "off" would have taken it away on the next
  build.
- The `touch` and `board` templates are unchanged — choosing one *is* asking for touch.

### Verified on hardware, both ways

| Build | What the board logged |
|---|---|
| touch **off** | `panel ready` … `design: built and painted 480x320`, and **no touch line at all** |
| touch **on** | the controller, the idle baseline, the calibration loaded from flash, the design painted — and a touch on the glass triggering the recalibration gesture, four corners measured, a fresh calibration stored |

The first version of the guard stopped only the sampling in the loop, and the board showed the startup still
identifying the controller and reading it: taking a baseline *is* talking to the chip, so the startup is guarded
too and with touch off the controller is never addressed.


## [0.0.54] - 2026-10-08

### Added

- **A file picker for every field that names a file**: a font's BDF, an image's or mesh's asset, each part of a
  composite icon. The dialog is the extension's (only it can open one, and only it knows the project folder);
  the edit stays the panel's, so the chosen path lands in the document and its undo history like any other
  change. The filters are the formats the build actually reads — BDF, OBJ/STL, and the raster set the `image`
  crate decodes.
- **A file from outside the project is copied into `assets/`** and referenced there, because a design's paths are
  relative to the project root and `../../somewhere/x.bdf` stops working the moment the folder moves. A name
  already taken gains a number rather than replacing a file the design may be using, and a cancelled dialog
  changes nothing.

### Verified

- 766 hermetic tests, including the import rules (inside the project, outside it, a name clash, no extension,
  Windows separators) and the panel round-trip: click, request, answer, edit, cancellation.
- A path comparison worth naming: `/home/me/project-two` is *not* inside `/home/me/project`, so the check
  compares path segments rather than string prefixes, and there is a test for it.


## [0.0.53] - 2026-10-08

### Added

- **A right-click menu on a placed control**: Duplicate, Bring forward, Send backward and Delete, with Delete in
  the error colour. Those actions were only reachable from the layer list before; the browser's own menu is
  suppressed even on empty canvas, and the menu closes on a click or Escape.
- **A check that a declared font actually reaches the pixels.** The harness renders a design twice — once as it
  stands, once with its font declarations removed — and asserts the images differ *inside* the widget that was
  given the font and are **identical everywhere else**. It is the difference from a clear render that makes it
  evidence: a build where nothing was painted would fail it. Measured: 34 of 2700 pixels differ inside that
  label, 0 of the 150 900 outside it.

### Fixed

- A duplicated control is named after the widget it copies (`title_2`) rather than after its kind (a copy of
  `title` used to arrive as `label`).


## [0.0.52] - 2026-10-08

### Fixed

- **A Designer project no longer paints the diagnostic readout over the design.** The touch template has two
  diagnostic surfaces — the screen it draws and a separate raw-numbers box — and the box sits after the branch
  that chooses between the design and the diagnostic screen, so it was still repainted on every touch. Reported
  from the board: "I can touch anywhere on the screen to update the touch readout." Now only the design responds.
- **The `touch test alive` heartbeat is not logged in a Designer project either** (it was nine lines in a
  28-second capture). The per-touch lines and the design's own event logs remain, which is what shows the touch
  driver and the handlers are working.
- A test asserts both guards in a generated Designer project, and that the touch template still has its readout —
  so neither can be lost by tidying the shared template.


## [0.0.51] - 2026-10-08

### Added

- **Fonts are real.** The `Font id` field was a text box that did nothing: a widget's `font` names a font the
  *screen declares*, and the code generator drops an unresolvable name without a word. A design now declares
  its fonts — name, BDF file, and optionally the characters to embed — under **Fonts** on the Screen panel, and
  a widget's `Font` is a dropdown of what is declared, with a way back to the default. The declarations are
  written into `src/ui.kdl` before the grid, validated (a plain identifier, no two names that collide once the
  crate has upper-cased them, a file that is actually a `.bdf`, and every reference resolving), and the file is
  checked while you design like any other asset.
- **A hover description on every property and every widget.** All 64 distinct properties and all 30 tags carry
  one line of help, shown as a native tooltip on the field and in the Toolbox. A test asserts the coverage, so a
  new property cannot arrive without an explanation.
- The design file went to **version 2**; version 1 documents are migrated rather than refused, since the change
  is additive.

### Fixed

- **Asset paths were resolved from the wrong directory.** `embedded-gui`'s macros resolve an asset relative to
  the *screen file's* directory — `src/` — unless a `project.kdl` exists above it. So `src="assets/logo.bmp"`
  meant `src/assets/logo.bmp` to the compiler while the designer's own check looked in `assets/`. A Designer
  project now writes a `project.kdl` at its root, which anchors the asset root where the validator expects it —
  and which makes the project a valid `include_project!` target as a bonus. Found by building the test harness
  with a font in it; the bug affected images and meshes too.

### Verified

- 758 hermetic tests, `tsc` clean for both the extension and the frontend.
- The harness carries a real BDF and a label that uses it, so the geometry, touch and dispatch checks all
  compile a design that declares a font, parses it at build time and renders with it.


## [0.0.50] - 2026-10-08

### Added

- **The designer's panel is now run by a test.** It is a browser bundle, and it was the one part of the feature
  nothing had exercised. A thin stub DOM (`tests/lib/dom.js`) loads the built bundle the way a webview does and
  drives a session through it: the init message, a press, a drag, Delete, Undo, a Toolbox click and a property
  edit — asserting on what the panel tells the extension, since that is what decides what is written. All of it
  passes.
- `node tests/runner.js` now builds the frontend bundle as well as the TypeScript, so a test that loads the
  bundle cannot pass against one older than the source.

### Fixed

- **A property edit can no longer be lost to a debounce.** Edits from the property panel, the Toolbox and the
  layer buttons were being batched on the 120 ms timer that exists for drags — right for a drag, wrong for a
  discrete edit, because a user who edits a property and closes the panel would lose it. They post at once now.
  Found by the panel test, which asserted the post and got nothing.


## [0.0.49] - 2026-10-08

### Fixed

- **The Designer firmware no longer dies on the board.** Flashed to the CYD it took a `DivideByZero` exception
  and went black. The cause is a grid whose tracks are *all* pixel tracks -- exactly what pixel-exact placement
  produces: `embedded-gui`'s track resolution divides by the number of fractional tracks, and with none it
  divides by zero. On the Xtensa core, which has no hardware divide, LLVM's out-of-line division runs
  speculatively and raises the exception before the source-level zero check can choose the safe branch; on
  x86_64, where the host simulator runs, it does not. Every emitted grid now ends each axis with a zero-width
  `1fr` filler, which is provably neutral: the pixel tracks total the canvas exactly, so the space left for a
  fractional track is zero and the filler resolves to 0 px. All three host checks pass unchanged with it.

### Verified on hardware

- **The designer runs on the CYD.** A generated Designer project, flashed at rotation 3, logs
  `design: built and painted 480x320` -- and then `design: on_go_clicked fired` when the button on the glass is
  touched. The whole chain works: design document, markup, build-time code generation, panel, the touch
  driver's mapping, the widget's hit test, the dispatch match, and the handler the user owns.

### Notes

- The host simulator could not have caught this: the same source is safe on x86_64 and fatal on Xtensa. The
  host proves the logic; the board proves the code.
- The symbolised backtrace pointed at a function containing no division, which cost a round. Three
  flash-and-read cycles settled what another hour of reading would not.


## [0.0.48] - 2026-10-08

### Added

- **A proof that a touch reaches the widget it looks like it should, without a board.** The host renderer now
  taps the designed centre of every widget the fixture gives an event to and checks that an event *for that
  widget* comes back, then taps empty canvas and checks that nothing claims it -- through the crate's own
  `handle_input(InputEvent::Pointer { .. })` / `pop_event()` path, at the coordinates the canvas drew. Both
  halves run under `--e2e`.
- **The generated firmware logs `design: built and painted WxH`** once, on the first calibrated frame. A design
  that fails to build panics and one that draws says nothing, so without this line a flash cannot tell the two
  apart from the serial port.

### Verified

- A tap at each designed widget centre reaches that widget; a tap on empty canvas is claimed by none.
- The pixel tracks still land exactly where the canvas placed them (the fixture grew two widgets for the event
  checks).
- 746 hermetic tests, and both host-renderer checks pass.

### Notes

- **Still not on glass.** The firmware compiles and links for both panel boards and the logic is proven on a
  host render, but no board has run it: that the panel shows the design at the right size and place, that the
  touch driver's mapped coordinates agree with the canvas, and that the rotation is right all still need a
  flash. No board was on USB when this was written.


## [0.0.47] - 2026-10-08

### Added

- **The Designer template, and the design reaching the board.** Choosing **WYSIWYG designer** in the wizard
  generates a project whose screen is a design rather than hand-written Rust: `src/ui.kdl` is compiled by the
  crate's `include_gui!` at build time, `src/ui.rs` drives it from the touch loop, and the events the design
  asks for arrive as stubs in `src/ui_handlers.rs`. The wizard then offers **Open Designer** and opens the
  canvas on the project it just wrote.
- **Three files, three lifetimes.** The markup and `src/ui.rs` are regenerated whenever the designer saves;
  `src/ui_handlers.rs` is only ever *appended* to, so a handler you have written, renamed or moved into a
  module survives every later save; and `src/main.rs` is never touched after the wizard writes it.
- **The rotation is chosen once and honoured everywhere**: the wizard asks for it, the markup is sized for the
  turned panel, and the designer's rotation control rewrites the project's own `LCD_ROTATION`.

### Measured

- A generated Designer project **compiles and links for xtensa-esp32-none-elf** on both panel boards -- the
  ESP32-035 with touch and the T-QT without -- with no warnings of our own.
- What the widget toolkit costs, against the same board's touch template: **about 105 KB of flash**
  (204 013 vs 96 457 bytes of text) and **no measurable static RAM** (`.bss` 187 608 vs 187 960, i.e. 352 bytes
  *smaller*). That answers the question the previous release left open.

### Notes

- The firmware compiles; **no board has run it yet**. Whether the design appears at the right size and place
  on glass, and whether a touch lands on the widget it looks like it should, still needs a flash -- and the
  rotation is the specific thing to check.
- A board with no touch controller gets the same generated API, marked `#[allow(dead_code)]` with the reason:
  a design can be moved between a touch board and a touchless one unchanged.


## [0.0.46] - 2026-10-08

### Added

- **The WYSIWYG designer, first slice.** **Open Designer** on the Project view's title bar opens a panel with a
  Toolbox of the thirty widget tags `embedded-gui`'s markup supports, a canvas showing the board's own panel at
  the rotation the project is built with, and a property panel for the selected widget. Widgets are dragged from
  the Toolbox onto the canvas, moved, resized from their handles, snapped to their neighbours' edges and to the
  canvas, and reordered; every edit can be undone, and one drag is **one** undo step rather than forty. The design
  is saved to `designer/panel.ui.json`, and the markup generated from it to `src/ui.kdl`, which the crate's
  `include_gui!` compiles at build time.
- **A canvas that draws what the board draws.** Which is not always what the document says: a `rect` or a
  `circle` becomes a theme-styled panel whatever colour was picked, a `line` and a `spacer` paint nothing, and a
  button's background is painted over by a gradient the markup cannot clear. Those are measured facts about
  `embedded-gui-codegen` 0.2.7, so properties the code generator ignores are marked as such rather than shown as
  controls that appear to work, and a tag the board does not paint is drawn as what it will be.
- **The rotation control** in the designer writes the project's own `LCD_ROTATION`, so a design and the build it
  belongs to cannot end up disagreeing about the orientation.
- **A host simulator for the canvas mapping** (`tests/sim`, run by `--e2e`): it compiles the emitted markup with
  the real `include_gui!` on the host, renders it, and asks the layout engine where every widget ended up. All
  eight fixture widgets, including odd coordinates, a label inside a band and widgets flush to the edges, come
  back at exactly the designed rectangles -- so "what you see is what the board draws" is now a claim with a
  render behind it rather than an assumption.

### Notes

- The designer generates and validates the markup but **does not yet wire it into a generated project**, so a
  project will not draw the design yet. The wizard's Designer template, `src/ui.rs` / `src/ui_handlers.rs` and
  the code-behind handlers are the next stages.
- `embedded-gui` 0.2.7 is now verified to build for `xtensa-esp32-none-elf` beside `esp-hal` and `mipidsi`. Its
  runtime cost on the board is **not** measured yet: unreferenced code is dropped by LTO, so the crate's flash
  and RAM figures need a build that actually drives it.
- The extension now builds its frontend with esbuild (`npm run compile`), because a drag-and-drop canvas is not
  something a webview's inline string can carry.


## [0.0.45] - 2026-10-07

### Documentation

- The rotation feature is recorded as **verified on hardware**: at 270° the interface and the drawing area both
  turn with every edge, corner and bar visible and nothing clipped; the `touch` and `board` screens are laid out
  for the landscaped area with touch landing where it is pressed; and the calibration can be redone by hand.
- The **recalibration gesture** is documented in the README and in `NOTES.md` §84, along with why it had to
  exist: without it a stored calibration could only ever be replaced, never discarded.


## [0.0.44] - 2026-10-07

### Fixed

- **A calibrated panel can be recalibrated again.** The generated touch firmware described a "touch within the
  first two seconds" gesture in a comment but did not implement it, so once a panel had been calibrated the
  stored record could only ever be *replaced* by completing a fresh calibration — never discarded. A panel
  calibrated for the wrong orientation, or with a mapping that had drifted, had no way back to the corner
  screen. A touch in the first ~2 s after a reset now discards the stored calibration, logs which rotation it
  belonged to, sounds the confirmation tone and returns to the corner screen. The triggering touch is consumed
  by the gesture rather than recorded as a corner, since the finger is wherever the user aimed at the middle of
  the screen.


## [0.0.43] - 2026-10-07

### Fixed

- **The `touch` and `board` templates lay out for the rotation as well.** Their screens were drawn from the
  panel's native width and height, so on a rotated panel they drew a portrait interface into a landscape area.
  They now derive their content size the way the display driver does, which carries the calibration targets, the
  raw-to-screen mapping, the readout box, the bars and the frame with it.

### Documentation

- Corrects what 0.0.42 said about landscape: **a landscape layout is delivered, not impossible.** The driver is
  handed the panel's *native* size and swaps the area it draws into for 90°/270° itself — which is also why
  passing the *rotated* size underflowed and gave 0.0.41's white screen. Verified on hardware at 270°: every
  edge, corner marker and bar visible, nothing clipped.


## [0.0.42] - 2026-10-07

### Fixed

- **A landscape rotation no longer gives a white screen.** 0.0.41 handed mipidsi the *rotated* display size to
  lay out a landscape interface, which makes its clipping offset underflow (`FRAMEBUFFER_SIZE - display_size`,
  i.e. 320 - 480). With the mirroring this panel needs, that produced a garbage address window for every draw
  and left the panel uninitialised white — reported from a real board at rotation 3. The drawing area is the
  panel's native size again at every rotation, which fits the glass exactly through MADCTL.

### Known limitation

- A **landscape layout** is not available yet, and the generated README says so rather than promising one. It
  needs the rotation applied as a coordinate transform in the drawing code, because the display driver cannot be
  told the rotated size. The landscape layout is still solved and kept for that work.


## [0.0.41] - 2026-10-07

### Fixed

- **Landscape rotation now lays the screen out for landscape.** At 90° and 270° the drawing area becomes the
  panel's dimensions the other way round, and the panel is told that is the shape it is addressing: rotating
  the controller exchanges its row and column addressing, so the previous build clipped and misplaced the
  drawing rather than turning it. The layout solver now runs for both orientations, the firmware picks the one
  the rotation produces, and the touch geometry — calibration targets, raw-to-screen mapping, readout box and
  the touch template's own screen — follows the rotated size.
- **A touch calibration is only used in the orientation it was measured in.** The record stores the rotation,
  and a mismatch asks for the calibration corners again with a log line saying so, instead of mapping every
  touch to a plausible, wrong place.

### Verified

- The `display`, `board` and `touch` templates compile and link with a rotation set (0 warnings each), and a
  test now walks both orientations of every panel in the catalog and asserts the layout fits.


## [0.0.40] - 2026-10-06

### Verified

- **The Bluetooth read agrees with the notify, confirmed on hardware.** A read of the battery-level
  characteristic now returns the counter the notifications carry, so the fix in 0.0.38 is verified
  behaviourally — not only by compiling, and not only by the ordering test. The Grumpy icon was also confirmed
  visible in the Extensions view.

### Documentation

- States what has **not** been observed: the panel rotation's *visual* effect. Its mechanism is verified — the
  value reaches the compiler, a nonsense value falls back to no rotation, a generated project compiles with
  one set — but no panel project has been flashed with a rotation, and the templates exercised on hardware
  drive no panel.


## [0.0.39] - 2026-10-06

### Added

- **The Grumpy icon.** The Extensions view and the gallery were showing a placeholder because the manifest had
  no `icon`. It is now the same 128x128 PNG the sibling Grumpy extension uses — copied in byte-identical, so
  the branding matches rather than being reinvented. A test pins its existence, type, PNG signature and
  minimum size, since a broken icon fails silently.

### Fixed

- The marketplace `description` still advertised RP2040/RP2350 only, which stopped being true when the ESP32
  and ESP32-S3 boards arrived.


## [0.0.38] - 2026-10-06

### Fixed

- **The Bluetooth template's battery-level characteristic now agrees with its notifications.** It notified the
  counter without ever storing it, so a central that *read* the characteristic got the value it was
  initialised with (`10`) while the notifications counted upwards. The counter is written into the
  characteristic before it is announced — storing afterwards would leave a window where the two disagree —
  and a failed write is logged rather than passed over.

### Verified

- The generated Bluetooth project compiles and links with the change (0 warnings), and a test pins the
  ordering so the store cannot drift back after the notify.
- The GATT **read** and **write** paths, and a second central against `CONNECTIONS_MAX = 1`, have been
  exercised on a phone and behaved as intended.


## [0.0.37] - 2026-10-06

### Verified

- **The Bluetooth template on hardware** (CYD/ESP32-035): advertising as `Rusty-Platform` — so the name really
  is in the advertisement payload, since a BLE scanner lists it — a completed connection, the GATT
  notification stream at ~2 s with plausible RSSI, a connection held for ~3.4 minutes, the disconnect reason
  reported in the stack's own words, and the return to advertising afterwards. Both ESP templates are now
  verified on hardware.

### Documentation

- Says plainly what was *not* tested: the GATT read and write event paths, and a second central
  (`CONNECTIONS_MAX = 1`). Flags a rough edge found while testing — a read of the battery-level characteristic
  returns its stored value while the notifications carry the counter — and records the observation trap that
  cost the most time: a phone's Bluetooth settings screen is not a BLE scanner, and the extension's Flash
  output is not the board's log.


## [0.0.36] - 2026-10-06

### Fixed

- **The Wi-Fi template's generated README no longer claims it cannot use an address.** It said the firmware
  could not log an address or be given a fixed one, which stopped being true when addressing moved to
  embassy-net; a generated project's README contradicted its own `src/main.rs`. The wizard's description of
  the template said less than the truth in the same way, and now names the logged address and
  `WIFI_STATIC_IP`.

### Verified

- The Wi-Fi template on hardware (CYD/ESP32-035): association, the DHCP lease and logged address, a fixed
  address, recovery across a reset and an access-point power cycle, and the extension's credential prompt
  storing and reusing the keyring entry. Bluetooth remains compile-and-link verified only.


## [0.0.35] - 2026-10-06

### Added

- **LCD rotation for panel projects.** The wizard asks how the panel is mounted — 0 = none, 1 = 90°, 2 =
  180°, 3 = 270° clockwise — when the template drives a display, and `rustyPlatform.lcdRotation` changes it
  afterwards. The value is written to the project's `.vscode/settings.json` and to `LCD_ROTATION` in its
  `.cargo/esp-config.toml`, which the firmware reads at compile time, so changing the rotation never means
  editing — or regenerating — `src/main.rs`. Every panel project also logs the rotation it was built with.

### Changed

- **New Project** asks one more question, and only for templates that drive a panel: board → template →
  rotation → name → folder.


## [0.0.34] - 2026-10-06

### Added

- **Wi-Fi and Bluetooth LE templates for the ESP32 boards.** The Wi-Fi template joins your access point
  and logs the address the network stack gives it; it reads the same four `WIFI_*` variables as the Pico
  template, so the existing credentials prompt (and its keyring entry) serves both, including a fixed
  address. The Bluetooth template advertises the board as a named peripheral and logs connections and
  disconnections, using esp-radio's controller with the `trouble-host` host stack.
- The board model records what the chip's radio actually provides (`radio: { wifi, bluetooth }`), and the
  template list follows that field rather than the family name — the ESP32-S2 has no Bluetooth at all.

### Fixed

- The generated ESP32 Bluetooth project links: the published `esp-rom-sys` 0.1.5 that esp-radio pins is
  missing three ROM symbols the classic-ESP32 Bluetooth blob refers to, so the generated
  `.cargo/config.toml` defines them (classic ESP32 only — the ESP32-S3 does not need them).


## [0.0.33] - 2026-10-06

### Added

- **The `New Project` icon on the Project section's title bar**, matching the Boards section, which has always
  had it. The Project section is the other place a user looks when nothing is open, and the Controls section
  carries the labelled row rather than a second icon.


## [0.0.32] - 2026-10-06

### Added

- **A `New Project` control in the Controls section**, leading it. The wizard was already there - it offers the
  whole board catalog in a quick pick with your default board first, then the template that board actually has,
  then the project name - but it was reachable only as an icon in the Boards view's title bar, which is not where
  the other actions live. Sidebar only: the status bar keeps its six for the actions used constantly.


## [0.0.31] - 2026-10-06

### Added

- **A TF card template**, built on `embedded-sdmmc` rather than a hand-rolled SD SPI sequence — the init
  handshake is easy to get subtly wrong, and even done right it leaves raw sectors rather than a filesystem.
  It brings up the socket's own SPI bus at 400 kHz (the clock a card is specified to initialise at), reports the
  capacity, opens volume 0, and **lists the root directory** with each entry's name and size.
  **Verified on the board with a 16 GB FAT32 card**: `card reports 15640559616 bytes (14916 MiB)` → `volume 0
  opened` → `root directory opened` → `SPARE (0 bytes)`, `SYSTEM~1 (0 bytes)`, `root directory listed`. Those two
  entries are the volume label and the SD association's folder, which is what a healthy FAT32 root holds with no
  user files in it.
- **The card is part of the `Board test (everything)` template**, sharing one mount function with the card
  template so the two cannot drift. The board template runs the card on **SPI3**: a HAL driver owns its
  peripheral once handed over, so the card cannot borrow the panel's bus in the same firmware.

### Notes

- Two crate facts were read rather than recalled, and both are commented where they are used: `Timestamp` is
  `year_since_1970`/`zero_indexed_month`/`zero_indexed_day`, and the directory callback returns unit in 0.8.
- Both generated projects compile with **zero warnings**.
- The **LDR is parked**: this board wires the divider resistor and the LDR's far ends both to ground, so the node
  cannot move with the light (the firmware reported a constant, exact 0 — see §67-§69), and a third resistor on
  the node is still to be traced. Pin, channel, attenuation and polarity are all confirmed correct.
- Still to write: **Wi-Fi/Bluetooth** for ESP boards.
- Test suite: **619 passed, 0 skipped**. `NOTES.md` §70-§71.


## [0.0.30] - 2026-10-06

### Added

- **The touch calibration is kept in flash**, so a calibrated panel boots straight into the graphics test screen
  instead of asking for the four corners again. The record lives in the last 4 KB sector of the application
  partition — ours, and pointedly not the NVS partition the bootloader reads — and is magic + axis + the four
  ranges + a checksum, so an erased sector (which reads as 0xFF) cannot be mistaken for a calibration. Written
  only after the fourth corner, never a partial set.
  **Verified on the board**: `calibration: stored in flash`, then after a reset
  `calibration: loaded from flash - axis0 1806..286 1884..213` — the same numbers.

### Fixed

- **The LDR read panicked the whole firmware.** `Adc::read_oneshot` is non-blocking and reports `WouldBlock`
  while a conversion is in flight — including the very first read after boot — and an `.expect()` there killed the
  app. The symptom was *"touch not responding"*, because the touch loop simply stopped when the CPU halted. Both
  templates now retry a bounded fifty times and warn if the ADC never becomes ready. This fixes 0.0.28 and 0.0.29,
  which both ship the panicking path.
- **The live touch readout drew over its own old values.** The numbers change length as a finger moves
  (`raw a=0 b=0` is shorter than `raw a=1806 b=286`), so each reading was drawn across the tail of the previous
  one. The box now fills its interior and *then* strokes its border — that order keeps the border whole, where
  the reverse would eat half its width — with no full-screen clear.
- **The speaker never beeped.** The beep lived only inside the corner-recording branch, and since the calibration
  persists in flash a calibrated board never records a corner again, so the amplifier was never asked to make a
  sound. (The click at reset and a faint hiss were the amplifier telling the truth: powered, enabled, nothing to
  amplify.) One shared definition of a beep — a macro, since it borrows the DAC and awaits — now answers **every
  touch** in 40 ms and confirms a recorded corner in 200 ms, which is what makes the speaker testable without a
  calibration run. Confirmed on the board.

### Notes

- The **light sensor reads 0 of 4095 constantly**, which a working divider cannot do in a lit room, so either
  GPIO34 is not its midpoint on this unit or the 5k/3.3V side is not connected. Under investigation; the same
  shape of question as the touch pins.
- Still to write: the **TF card** template (pins known), Wi-Fi/Bluetooth for ESP, and folding the card into the
  board template.
- Test suite: **618 passed, 0 skipped**. `NOTES.md` §64-§66.


## [0.0.29] - 2026-10-06

### Added

- **A `Board test (everything)` template for the ESP32-035** — the board as one project rather than one project
  per peripheral, which is how the user wants to select features:
  - the panel, with the graphics test screen once calibration is done;
  - **touch**, with the four-corner calibration screen;
  - the **RGB LED as a status light** — red while uncalibrated, green while a finger is down, blue when idle
    and calibrated, so it is a diagnostic rather than decoration;
  - the **light sensor** read once a second and logged with its polarity ("brighter light reads lower");
  - a **beep on the speaker** every time a calibration corner is recorded, which demonstrates the amplifier as
    part of the calibration rather than as a separate demo.

  It is the touch template plus the rest of the board's hardware — `espTouchBody` takes an `includeHardware`
  flag and emits the LED, ADC and DAC code from the board data — so there is no second copy of the touch half
  to keep in step. A test asserts the touch template stays touch-only.

  **Compiles for the board**: `cargo build --release`, no warnings.

### Notes

- The **TF card** is not in it yet: its template is still to write, and the board template will gain it then.
- Still open: Wi-Fi/Bluetooth for ESP, and moving the touch calibration from RAM to flash (an interrupt-safe
  `esp-storage` write, which needs its own bench round). `NOTES.md` §64.
- Test suite: **618 passed, 0 skipped**.


## [0.0.28] - 2026-10-06

### Added

- **A `Sensors + sound` template for the ESP32-035**: it reads the on-board LDR and plays a tone on the
  speaker connector, which between them demonstrate the whole analogue half of this board.
  - The LDR is on **GPIO34 (ADC1 channel 6)**, wired as the *lower* leg of a divider (3.3V - 5k - pin - LDR -
    GND). The template reads it at 11 dB attenuation and — the part worth having — **says the polarity in the
    log**, because a brighter room reads *lower* here and assuming it the other way round looks exactly like a
    dead sensor.
  - The speaker is on **GPIO26, which is DAC channel 2**, through a 4k7 coupling resistor into an LTK8002D
    bridge amplifier. A square wave written to the DAC *is* the sound: no PWM, no filter, no timer.
- **The board's analogue hardware as data**: `ldr` (pin, series resistor, which leg faces ground) and `audio`
  (pin, amplifier, coupling resistor), so a template cannot get the polarity or the pin wrong by guessing.
- **`unstable` is asked for automatically** by the template that needs it: esp-hal's ADC and DAC modules are
  cfg-gated behind that feature, which is confirmed in its source rather than assumed.

### Notes

- The template **compiles for the board** (`cargo build --release`, no warnings). Its behaviour on the glass —
  the light reading and an audible tone — has not been checked yet.
- Still to write: the **TF card** template (pins are known: CS 5, CLK 18, MOSI 23, MISO 19), Wi-Fi/Bluetooth
  for ESP, and the single selectable board template that folds display + touch + card + LED + sensors + sound
  together.
- The touch calibration still lives in RAM rather than flash: an interrupt-safe `esp-storage` write needs its
  own bench round. `NOTES.md` §62-§63.
- Test suite: **617 passed, 0 skipped**.


## [0.0.27] - 2026-10-06

### Added

- **A touch template, verified on real hardware.** Panel bring-up plus the XPT2046 on the same SPI bus, a
  **calibration screen** the user carries out on the glass (a red block in each corner with a crosshair in
  it, the requested corner lit and named, the live raw pair on screen), and then the **graphics test screen**
  back again with the live raw/mapped numbers and a touch marker. Measured on the board:
  `raw axis0 1794..238, axis1 1873..210 over 320x480`, and `a=1809 b=210 -> pixel (22, 456)`.
- **The board's RGB LED**, as a new `BoardLed` kind with three pins (red 4, green 17, blue 16). The blinky
  template cycles the channels and names each one in the log, so a swapped pin is the wrong colour rather
  than nothing at all.

### Changed

- **Controls: `Build for Debug` and `Build for Release` replace the single Build row, and the Debug row is
  gone.** `rustyPlatform.debug` stays a command - on an ESP board it flashes and follows the log in one
  terminal - and so does `rustyPlatform.build`, for the palette and for keybindings.

### Fixed

- **The touch controller read mid-scale and never moved for a touch**, at every clock from 2 MHz to 100 kHz:
  the command byte and the data bytes were clocked back to back, and the XPT2046 needs its conversion time
  between them. Each frame is now one transaction with an explicit delay between its two halves, and the
  axis reader consumes two frames before averaging so the average is not dragged towards zero.
- **The TF card pins were wrong.** CMD is the card's data *in* and DAT0 its data *out*, so MOSI is 23 and
  MISO is 19 - not 19 and the panel's shared 12 as the community definition had it.
- **The board is not a Sunton.** It is a clone sold as `ESP32-035` with TZT / 3.5 TFT / 60721 markings; it is
  now named **ESP32-035 LCD Panel**, vendor *unidentified*, with its wiring confirmed against the
  `littleCdev/ESP32-035` hardware notes - including that the touch controller's BUSY pin is not connected,
  which is why the driver waits a fixed conversion time.

### Notes

- The calibration lives in the firmware's state, not yet in flash: writing flash from a running embassy app
  needs `esp-storage`'s constructor confirmed and an interrupt-safe write, which deserves its own bench round.
- Still to come for this board: the TF card template, Wi-Fi/Bluetooth, and the LDR and speaker pins, which
  are not in the reference tables and have to be traced. `NOTES.md` §57-§61.
- Test suite: **616 passed, 0 skipped**.


## [0.0.26] - 2026-10-05

### Fixed

- **Three Controls rows described the wrong board.** On an ESP project, **Monitor** said *"defmt over RTT /
  `probe-rs attach`"* and **Debug** said *"build, flash, debug / a probe-rs debug session with RTT"* — where
  Monitor actually runs `espflash monitor` and Debug has no breakpoints at all. `visibleControls` now words
  the rows that describe a *route* (Flash, Debug, Monitor) for the open project's family. **Captions do not
  move** — `$(output) Monitor` is what the status bar shows and what you have learned to press — so only the
  grey line and the tooltip change. A project that cannot be identified keeps the wording every line was
  written for.

### Notes

- Test suite: **612 passed, 0 skipped**. `NOTES.md` §56.


## [0.0.25] - 2026-10-05

### Added

- **A switch option for the build profile, and two buttons to override it.** `rustyPlatform.flashProfile`
  is the standing answer — `auto` (default), `debug` or `release` — read at flash time, so a change
  applies to the next flash. `auto` is the only value that consults the board: **release for ESP** and
  **debug for RP**.
- **Flash (debug)** and **Flash (release)** in the Controls section: the same build-and-write as Flash
  with the profile chosen for that one flash. They deliberately do **not** change the setting — a control
  that quietly rewrites a configuration makes the next flash do something the user cannot see.
- A deliberate choice that costs something says so in the output channel: choosing the debug profile on
  an ESP board reports the measured cost (28 834 ms against 221 ms for the generated display screen), and
  a release build on a Pi board warns that breakpoints in a probe-rs session will be hollow. `auto` says
  nothing.

### Changed

- **All three flash entry points run one code path.** The routing (ESP serial, RP probe, RP USB/UF2) was
  written out inline at a single call site; the two new controls would have been two more copies of it.

### Notes

- `flashProfileFor(board, choice)` and `parseFlashProfileChoice` are the whole decision, so the t1 layer
  pins every board against every choice, plus `undefined` / `null` / `''` / `'Debug'` / `'RELEASE'` / `0` /
  `{}` all falling back to `auto`. `NOTES.md` §55.
- Test suite: **611 passed, 0 skipped**.


## [0.0.24] - 2026-10-05

### Fixed

- **Flashing an ESP board wrote a debug build, which made the panel crawl.** `FLASH_PROFILE` is `debug`
  so that a probe-rs debug session loads the image the chip is running — a rule that only has a subject
  on Raspberry Pi: an Xtensa chip is flashed over USB serial and has no session at all, and the
  no-flash debug entries that read the recorded profile do not exist for it. The cost was paid for
  nothing. Measured on a Sunton CYD with the same source, the generated display screen reports
  **28 834 ms** to paint as a debug build against **221 ms** as a release one, and the arrival times of
  the log lines on the serial port agree (29.43 s against 0.223 s). `flashProfileFor(board)` now decides
  the profile per board — `release` for ESP, `debug` otherwise — and every write-the-chip site goes
  through it. It also settles an inconsistency the extension had with itself: **"Publish .deb" has
  always built `cargo build --release`**, so the same project had two performance levels depending on
  which button was pressed.

### Added

- **The generated display template times its own drawing.** It brackets the screen with
  `embassy_time::Instant` (no new dependency — `embassy_time` was already imported for the 700 ms timer)
  and logs `diagnostics drawn in {} ms: …`. A slow panel now has a number to read rather than a feeling,
  and the number names the cause: thousands of milliseconds means a debug build, not a slow panel or a
  slow SPI clock.

### Notes

- What was slow was the **initial paint** — about 183 000 pixels for the clear, frame, corners, bars,
  cross and text. The blinking square was fine: 576 pixels, **+35 ms** on a 700 ms sleep, so the loop
  period only moved from 699.8 ms to 735.4 ms. `NOTES.md` §54 has both measurements.
- Test suite: **607 passed, 0 skipped**.


## [0.0.23] - 2026-10-05

### Fixed

- **The health check asked every project for a debug probe, and never asked an ESP project for its
  toolchain.** Pressing the `Rusty` control on a Sunton CYD raised *"Toolchain needs attention: No debug
  probe detected. Connect…"* — for a board with no SWD at all, whose entire flash route is USB serial —
  offered to install probe-rs and udev rules it cannot use, and said nothing about the missing `espup` /
  Xtensa toolchain / `espflash` that would actually stop the build. The verdict is now decided once, in
  `src/toolchain/health.ts`, from the same board detection the Build and Flash buttons use: a Raspberry Pi
  project is judged on the probe, an ESP project on its toolchain, cargo is shared, and with no project open
  the old, safe reading is kept.
- **Monitor on an ESP project no longer requires probe-rs.** `espflash monitor` reads the same serial port
  the flash wrote to; only the Raspberry Pi route uses probe-rs.
- **The verdict is re-detected when the open project changes**, instead of answering for whichever project
  was open when the window started.
- A probe that is simply not plugged in no longer offers an install button — there is nothing to install, and
  the button used to answer *"Nothing to install — the toolchain is complete"*.

### Notes

- Measured against the real project folder: `problems: []` and *"toolchain looks good"* where the modal used
  to appear, with the Controls row reading `Rusty: ready / cargo 1.99.0 · esp ready (0.18.0, 4.6.0)`; the same
  machine with a Pico project open still warns about the probe. `NOTES.md` §53.
- Test suite: **606 passed, 0 skipped**.


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
[Unreleased]: https://github.com/OomNiel/grumpy-rusty-platform/compare/v0.0.55...HEAD
[0.0.55]: https://github.com/OomNiel/grumpy-rusty-platform/compare/v0.0.54...v0.0.55
[0.0.54]: https://github.com/OomNiel/grumpy-rusty-platform/compare/v0.0.53...v0.0.54
[0.0.53]: https://github.com/OomNiel/grumpy-rusty-platform/compare/v0.0.52...v0.0.53
[0.0.52]: https://github.com/OomNiel/grumpy-rusty-platform/compare/v0.0.51...v0.0.52
[0.0.51]: https://github.com/OomNiel/grumpy-rusty-platform/compare/v0.0.50...v0.0.51
[0.0.50]: https://github.com/OomNiel/grumpy-rusty-platform/compare/v0.0.49...v0.0.50
[0.0.49]: https://github.com/OomNiel/grumpy-rusty-platform/compare/v0.0.48...v0.0.49
[0.0.48]: https://github.com/OomNiel/grumpy-rusty-platform/compare/v0.0.47...v0.0.48
[0.0.47]: https://github.com/OomNiel/grumpy-rusty-platform/compare/v0.0.46...v0.0.47
[0.0.46]: https://github.com/OomNiel/grumpy-rusty-platform/compare/v0.0.45...v0.0.46
[0.0.4]: https://github.com/OomNiel/grumpy-rusty-platform/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/OomNiel/grumpy-rusty-platform/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/OomNiel/grumpy-rusty-platform/releases/tag/v0.0.2
[0.0.1]: https://github.com/OomNiel/grumpy-rusty-platform/releases/tag/v0.0.1
