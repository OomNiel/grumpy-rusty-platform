# An Arduino (C++) backend beside the Rust one

Decided 2026-10-31. This is the plan the implementation follows; it is not user documentation.

## Status: agreed, not started

**Nothing has been implemented.** The six questions that shaped this plan were answered on 2026-10-31 and are
recorded under *Answers the user gave* below — the phases say what each answer will touch.

**How to abandon it.** Where the decision is written down, so it can be taken back out cleanly:

| where | what to remove |
|---|---|
| `plans/arduino-backend.md` | this file |
| `NOTES.md` §162 | the dev-log entry that records the decision and this recipe |
| `/memories/repo/arduino-backend.md` | the repository memory entry |
| `/memories/rusty-platform.md` | the note at the top of that file pointing at the above |
| `README.md`, `USER_MANUAL.md` | **nothing** — user-facing docs are only touched in the phase that makes the feature real (see *Documentation* below) |

After **phase 1** (the seams, no behaviour change) abandoning it is still cheap: the Rust code is behind an
interface, so `git revert` of the phase-1 commit restores the previous shape, and every later phase's code lives
in files that only it touches. After **phase 2** it is `git revert <phase-1>..<phase-n>` plus deleting the new
`src/generate/arduino*`, `src/designer/lvgl*` and `src/ai/cpp*` modules; a project record that carries
`language "rust"` needs no migration, because a record without the field is already Rust.

## What is being built

One extension, **two languages per project** — Rust (Embassy + probe-rs) as it stands, and Arduino-style
C++ (the `arduino-cli` toolchain, `setup()`/`loop()`, LVGL for the Designer's output) — chosen when the
project is created and recorded with the project, so that the main files, the Designer's generated UI, the
code-behind stubs, the build/flash route and the AI's prompts all follow it.

It is **not** a fork with a renamed language. The shell (commands, views, settings, chat, panes, packaging,
backup, Wi-Fi) is language-free and is shared; the language lives behind five narrow seams, and the code that
knows about Rust stays exactly where it is.

## The user's contract

1. **New Project asks for the language first.** It filters what follows, because C++ and Rust do not offer the
   same boards or the same templates.
2. **One language per project, for its life.** The language is written into the project record beside the board.
   There is no in-place conversion in v1; converting means a new project.
3. **The Designer works the same way in both.** The canvas, properties, views, fonts and images do not know what
   they are drawing for. Only the *emit* step differs: `src/ui.rs` for Rust, `src/ui.cpp`/`src/ui.h` (LVGL) for
   C++.
4. **Code behind is in the project's language.** The Designer only ever *appends* a stub for an event, as
   today — into `src/ui_handlers.rs` or `src/ui_handlers.cpp`.
5. **A C++ project vendors nothing.** `codegen/` and the `.rusty-platform-crates` marker exist because Rust
   needed a widget library; C++ uses the Arduino core plus LVGL, installed by `arduino-cli lib`. The
   "Update Crates" prompt must not appear for a C++ project.

## Shared and per-language

| | shared | Rust | C++ |
|---|---|---|---|
| shell: commands, views, settings, status bar | ✅ | | |
| chat, panes (Problems/Output/Debug Console), local models, sidecar | ✅ | | |
| Designer canvas, properties, views, hit-testing, fonts, images | ✅ | | |
| project record, backup, `.deb` packaging, Wi-Fi credentials | ✅ | | |
| main files | | `src/main.rs`, `src/MainHeader.rs`, `Cargo.toml`, `.cargo/config.toml` | `src/main.cpp`, `src/main.h`, `sketch.yaml` |
| build | | `cargo build` | `arduino-cli compile --fqbn …` |
| flash | | probe-rs, UF2 | `arduino-cli upload` (avrdude / esptool / UF2 per core) |
| design output | | KDL → `ui.rs` via `include_gui!` | KDL → `ui.cpp`/`ui.h` via LVGL |
| code behind | | `src/ui_handlers.rs` | `src/ui_handlers.cpp` |
| logging | | `defmt::info!` / RTT | `Serial.printf` |
| AI prompts + answer guards | chat pipeline, panes, settings | `rustCode.ts`, `cargoMessages.ts` | `cppCode.ts`, `arduinoMessages.ts` |

## Answers the user gave

Asked 2026-10-31, answered the same day:

1. **Cores: both.** `arduino-pico` (`rp2040:rp2040`) and `esp32` (`esp32:esp32`) from the first C++ release; AVR
   stays out until those two are finished end to end.
2. **LVGL: the most popular choice for this job — LVGL 9.x.** It is the de-facto MCU GUI library, packaged for
   both cores (`arduino-cli lib install lvgl`), and it already ships the widget set the design format needs.
   The exact 9.minor is pinned when the first sketch is built on the bench, recorded here and in the generated
   project, and **not** floated: the 8→9 renames (`lv_btn`→`lv_button`, `lv_img`→`lv_image`) are precisely the
   churn a generator cannot absorb twice.
3. **Keypad: LVGL's own `lv_keyboard` SHIFT already meets the rule** (checked by the user against the behaviour
   asked for on 2026-10-31: one tap capitalises one character, a double tap locks). So the C++ emitter uses
   `lv_keyboard` **as it is** — no custom three-state logic in C++. The Rust widget keeps its own
   `press_shift`/`consume_shift` state machine; the two must agree in observable behaviour, which the
   generated-firmware tests and the bench check.
4. **SD images: yes, in scope.** File-backed `lv_image` from the card is a phase-4 requirement, not a later
   phase: it carries the filesystem driver (`SdFat`/`FS.h` on the ESP side, the core's SD support on
   arduino-pico) **and** the design's `sd:/NAME.BMP` picture. Fallback if it cannot be made to work on a board
   in phase 4: the canvas keeps drawing the dashed "pixels not here yet" frame, and the plan records why.
5. **`//~` worked examples: a C++ set as well.** The examples are data, not code, so the Rust Assist trigger
   gains C++ examples in phase 5 instead of being Rust-only.
6. **Wizard: offered plainly.** No experimental setting and no hidden command — the language is step one of
   New Project, beside the board and the template.

## The five seams

The shell must never branch on the language; these five places do, and each gets one interface.

**1. Board profile and the wizard.** `src/boards/types.ts` gains a `language` on the profile (or a separate
`SketchBackendId`), and `src/commands/newProject.ts` asks for the language before the board. `templatesFor` /
`templatesOfferedFor` / `defaultTemplateFor` (`src/generate/files.ts`) take the backend into account, so a C++
Pico offers `blinky`, `designer`, `display` and nothing Embassy-shaped.

**2. The generator.** `src/generate/` currently answers "what files does this board+template get". Behind the
backend interface:

```ts
export interface SketchBackend {
    id: 'rust' | 'arduino';
    label: string;
    /** The files a project of this template carries, and their contents. */
    files(request: SketchRequest): GeneratedFile[];
    /** The file the Designer appends event stubs to. */
    handlersPath(): string;
    /** The file the Designer rewrites when the wiring changes (panel.rs / panel.h). */
    panelPath(): string;
    /** What a valid project of this language looks like, for the "is it real?" checks. */
    verify(project: vscode.Uri): Promise<string[]>;
}
```

`rustBackend` is today's code moved behind it, with no behaviour change; `arduinoBackend` is new.

**3. The Designer emit step.** `src/designer/generate.ts` already holds a small map
(`DESIGNER_FILES = { markup, rust, handlers, document, manifest }`) and `src/designer/model.ts` holds
`DESIGNER_HANDLERS_PATH`. Both become backend-derived, and the emitter becomes a function on the backend:

- `emitUi(design, wiring): { ui.cpp, ui.h }` — LVGL object tree;
- `appendHandler(event, signature): void` — the stub, in the project's language;
- the *design document* (`designer/panel.ui.json`) is unchanged, so one design format serves both.

**4. Build, upload, monitor, diagnostics.** `src/toolchain/` (`detect.ts`, `installPlan.ts`,
`installRunner.ts`) and `src/flash/` (`route.ts`, `probeFlash.ts`, `espFlash.ts`, `uf2.ts`) get an
`arduino-cli` implementation of the same jobs. `src/flash/route.ts` is the one place that decides which
uploader a board uses — C++ adds `arduino-cli upload` and keeps UF2 for the RP2040 BOOTSEL route.

**5. AI prompts and answer guards.** `src/ai/rustCode.ts` (item names, elision markers, brace balance, line
fixes) has a C++ twin; `src/ai/cargoMessages.ts` has an `arduino-cli` twin. Everything else in `src/ai/` —
`panes.ts`, `debugConsole.ts`, the chat view, model management, the sidecar — is language-free and is reused
as it is.

## The C++ side in detail

### Files and entry shape

The generated sketch mirrors today's split, which is why the port is small:

```cpp
// src/main.cpp
#include "main.h"

void setup() {
    panel_init();          // generated src/panel.cpp, rewritten by the Designer
    ui_init();             // generated src/ui.cpp
}

void loop() {
    ui_tick();             // dispatch + render, generated
    // your code belongs in src/ui_handlers.cpp
    delay(20);
}
```

`setup()`/`loop()` is the Arduino contract, and the existing templates already separate one-time setup from the
loop, so the *shape* carries over even though nothing else does.

### The LVGL contract (the new work)

One design becomes one LVGL object tree. The mapping to fix before any emitter code:

| widget | LVGL 9 object | notes |
|---|---|---|
| Panel | `lv_obj` | a screen container; a "view" is a child that is shown/hidden |
| Label | `lv_label` | wrap is `LV_LABEL_LONG_WRAP` |
| Button | `lv_button` + `lv_label` child | `lv_obj_add_event_cb(obj, cb, LV_EVENT_CLICKED, NULL)` |
| Slider | `lv_slider` | `LV_EVENT_VALUE_CHANGED` |
| Switch | `lv_switch` | same |
| Dropdown | `lv_dropdown` | `LV_EVENT_VALUE_CHANGED`, `navigate` on a choice |
| Keypad | `lv_keyboard` + `lv_textarea` | used as it comes: its SHIFT already does one-tap and double-tap (answer 3), so no custom state machine on the C++ side |
| Image | `lv_image` with an `lv_image_dsc_t` | file-backed images from the card are in scope (answer 4): `lv_image_set_src(img, "S:/NAME.BMP")` with the driver registered |
| Clock | drawn by us as today | an arc/circle + hands in an `lv_obj` draw event |
| Text panel | `lv_label` in a column + scroll | |

Things that must be decided here, because they are contracts and not code:

- **Pin LVGL 9.x.** The 8→9 renames (`lv_btn`→`lv_button`, `lv_img`→`lv_image`, `lv_obj_clear_flag`→
  `lv_obj_remove_flag`) are exactly the kind of churn a generator cannot paper over twice.
- **One `lv_conf.h` per board class**, generated into the project, so a user can change sizes without the
  extension rewriting `src/main.cpp`.
- **Views**: `lv_obj_add_flag(view, LV_OBJ_FLAG_HIDDEN)` for the ones not on show; `navigate` becomes a
  `show_view(View::X)` call in C++ as well.
- **Fonts**: the Designer's existing font import can emit an `lv_font_t` C file (`lv_font_conv`-compatible
  layout) — the one place where today's BDF/raster code has to be re-pointed rather than reused.

### Code behind, concretely

Same event, two stubs the Designer appends (append-only, as today):

```rust
// src/ui_handlers.rs
pub fn on_keypad_enter(line: &str) { /* your code here */ }
```

```cpp
// src/ui_handlers.cpp
extern "C" void on_keypad_enter(const char *line) { /* your code here */ }
```

The emitter registers `on_keypad_enter` with `lv_obj_add_event_cb`, in the same place Rust's generated `ui.rs`
calls `pump()`.

### Board matrix

arduino-cli addresses boards by FQBN, so the board matrix becomes a mapping, not a new model:

| board | core package | FQBN (verify against the installed core) |
|---|---|---|
| Pico, Pico W, Pico 2, Pico 2 W | `rp2040:rp2040` (arduino-pico) | `rp2040:rp2040:rpipico`, `…:rpipicow`, `…:rpipico2`, `…:rpipico2w` |
| ESP32 / ESP32-S3 | `esp32:esp32` | `esp32:esp32:esp32`, `esp32:esp32:esp32s3` |

Both cores are in the first C++ release (answer 1). The RP and ESP boards keep the panel/wiring facts that were
verified on glass — those are hardware, not language. AVR has no board here yet and is deliberately out of the
first release.

### Toolchain, build and upload

- **detect**: `arduino-cli version`, `arduino-cli core list`, `arduino-cli board list` — the same shape as
  `src/toolchain/detect.ts`, and the same "offer to install what is missing" behaviour as
  `installPlan.ts`/`installRunner.ts`.
- **build**: `arduino-cli compile --fqbn <fqbn> --format json --output-dir build`.
- **diagnostics**: consume the JSON `diagnostics` array if the installed version emits one; otherwise fall back
  to the GCC text parser, which is a small, testable module. Either way the result is the same
  `CompilerDiagnostic` the Problems pane, the repair loop and the AI already speak.
- **upload**: `arduino-cli upload -p <port> --fqbn <fqbn>`, with the RP2040 BOOTSEL/UF2 route kept.
- **monitor**: `arduino-cli monitor -p <port> --config baudrate=115200` for v1, or our own serial reader if the
  version's monitor is unreliable. No DAP in v1: `Serial` logging only, and the Debug Console stays empty for
  C++ projects (the pane says so rather than looking broken).

## The AI, per language

- **Reused as it is**: the chat view and its surfaces, the Problems/Console context, the model/endpoint
  management, the sidecar, the "one-line fix" *structure* (its rules move to a C++ parser), the answer
  refusal dialogs.
- **New per language**: the system prompt (Arduino APIs, `Serial`, LVGL, no `std::` assumptions), the item and
  elision rules for C++ translation units, and the build-message parser.
- **`//~ keyword`** keeps its trigger and gains a **C++ example set** (answer 5): the examples are data
  (`src/ai/rustCode.ts`'s example table), so a C++ project gets C++ examples from the same command.

## Data model and compatibility

- The project record gains `language` (in `project.kdl`, beside `screen`; or a sibling `rusty.kdl`). It is read
  once per project by `src/project/activeProject.ts` and passed to the backend in the same shape the board is.
- A project without the field is **Rust** — the existing default — so every project on disk keeps working,
  including the test apps.
- `src/designer/vendored.ts` is consulted only for Rust projects.

## Tests

The layers are already there and carry over:

- **t1 (pure, ~1100 checks today)**: C++ emitters, FQBN mapping, `arduinoMessages` fed captured
  `arduino-cli` output, the C++ answer guards, the handler-stub appender, backend selection. The C++ emitters
  are pure functions of (design, wiring) → text, so they are pinned exactly like `src/generate/rp-designer.ts`.
- **t2 (CLI shims)**: a fake `arduino-cli` script beside the existing fake `cargo`/`rustup`/`probe-rs`, for
  detect, core install, compile and upload.
- **t3 (goldens)**: a C++ set beside the Rust one —
  `tests/layers/t3-golden/__snapshots__/pico/designer-cpp/` — so a template change shows up as a diff.
- **t4 (opt-in, e2e)**: a real `arduino-cli compile` of a generated project, the way `cargo build` is run now.
- **t5 (opt-in, hardware)**: one upload per board family on the bench.

## Phases, with what each one proves

| phase | what it delivers | proof | tokens |
|---|---|---|---|
| 0 | this file, and the six answers (recorded above) | — | — |
| 1 | `language` on the project, wizard step one, `SketchBackend`, Rust moved behind it | t1: no behaviour change; the whole suite green | 0.1–0.2 M |
| 2 | C++ generator for **both cores**: `blinky`, `display`, `designer` skeleton, `panel.cpp`, `main.cpp`, FQBN map for `rp2040:rp2040` and `esp32:esp32` | t3 C++ goldens per board; a hand-built sketch compiles with `arduino-cli` for one RP and one ESP board | 0.35–0.55 M |
| 3 | toolchain: detect, core install, compile → Problems, upload, monitor | t2 shims + one real board of each family on the bench | 0.25–0.4 M |
| 4 | Designer → LVGL 9.x: emitter, views, events, handler stubs, fonts, **`lv_keyboard` as it comes**, **SD images with a filesystem driver** | t1 emitter cases + t3 goldens + one design on glass with a card in the slot | 0.5–0.85 M |
| 5 | AI for C++: prompt pack, guards, `arduinoMessages`, status line, **the C++ `//~` example set** | t1 guard/parser/example cases; the stray-character drill in C++ | 0.2–0.35 M |
| 6 | clock parity, `.deb` packaging, docs | bench | 0.15–0.3 M |
|  |  | **total** | **1.55–2.65 M** |

## Documentation, per phase

The user-facing docs say nothing until a phase makes the feature real, so a revert never has to unpick a manual:

- **phase 1** — `NOTES.md` only (the seam exists, nothing changes for a user).
- **phase 2** — README gains the C++ bullet; `USER_MANUAL.md` gains *Creating a C++ project*.
- **phase 3** — the manual's build/flash/monitor sections gain their `arduino-cli` route.
- **phase 4** — the Designer section gains the LVGL facts (keypad SHIFT, views, images from the card).
- **phase 5** — `AI_ASSIST.md` gains the C++ prompt/guard differences and the C++ `//~` examples.
- **CHANGELOG** — one entry the first time the wizard really offers C++, listing everything that landed.

## Non-goals (deliberately)

- **No language mixing** inside a project, and no in-place conversion.
- **No debugger for C++ in v1** — no DAP, no `probe-rs` equivalent; `Serial` only.
- **No AVR** until one RP and one ESP board are done end to end.
- **No second Designer format**: `designer/panel.ui.json` and `ui.kdl` stay the source of truth for both
  languages, which is what keeps one canvas honest.
- **No Marketplace work** for the C++ mode until the benches agree.

## Open questions (none block phase 1)

The six questions that shaped this plan were answered on 2026-10-31 — see *Answers the user gave*. What is left
is discovered on the bench, not decided here:

- The exact **LVGL 9.minor** the cores install today (record it when the first sketch is built).
- The real **FQBNs** of the installed cores (`arduino-cli board listall`), which is a lookup, not a choice.
- Whether a card's `lv_image` can be driven on **both** RP and ESP cores in phase 4, or only one before the other.
