# Changelog

All notable changes to **Grumpy's Rusty Platform for VS Code** are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version number matches
`package.json`; until the extension reaches the Marketplace it is installed from the packaged
`.vsix`.

## [Unreleased]

_Nothing yet._

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
[Unreleased]: https://github.com/OomNiel/grumpy-rusty-platform/compare/v0.0.52...HEAD
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
