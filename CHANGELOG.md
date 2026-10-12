# Changelog

All notable changes to **Grumpy's Rusty Platform for VS Code** are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version number matches
`package.json`; until the extension reaches the Marketplace it is installed from the packaged
`.vsix`.

## [Unreleased]

_Nothing yet._

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
