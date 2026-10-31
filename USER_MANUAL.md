# User Manual — Grumpy's Rusty Platform for VS Code

Version 0.17.13 · Extension ID `grumpy.grumpy-rusty-platform`

This manual covers every feature of the extension. For the AI assist in depth, see also `AI_ASSIST.md`.

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Installation](#2-installation)
3. [First Steps](#3-first-steps)
4. [Sidebar Views](#4-sidebar-views)
5. [Command Palette](#5-command-palette)
6. [Creating a Project](#6-creating-a-project)
7. [Building](#7-building)
8. [Flashing](#8-flashing)
9. [Debugging & Monitoring](#9-debugging--monitoring)
10. [WYSIWYG Designer](#10-wysiwyg-designer)
11. [Clock & Time Sync](#11-clock--time-sync)
13. [SD Card (CYD)](#13-sd-card-cyd)
14. [Wi-Fi Credentials](#14-wi-fi-credentials)
15. [Toolchain Management](#15-toolchain-management)
16. [Crates.io Library Manager](#16-cratesio-library-manager)
17. [AI Assist](#17-ai-assist)
18. [Packaging & Backup](#18-packaging--backup)
19. [Settings Reference](#19-settings-reference)
20. [Troubleshooting](#20-troubleshooting)

---

## 1. Introduction

Grumpy's Rusty Platform brings PlatformIO-style embedded development to VS Code for **Raspberry Pi Pico** (RP2040/RP2350) and **ESP32** (ESP32, ESP32-S3) boards in **Rust**, using **Embassy**, **esp-hal**, **probe-rs** and **espflash**.

Supported targets:
- RP2040 / RP2350 — Pico, Pico 2, Pico W, Pico 2 W
- ESP32 / ESP32-S3 — Sunton CYD, LilyGo T-QT, ESP32-DevKitC V4 (with display modules), ESP32-035

Key capabilities: project wizard, toolchain installer, build/flash/debug, serial monitor, WYSIWYG UI designer, clock/time sync, SD card, Wi-Fi credentials, crates.io library manager, local AI assist, `.deb` packaging, project backup.

---

## 2. Installation

Not yet on the Marketplace. Install from the `.vsix`:

```bash
npm install && npm run compile
code --install-extension grumpy-rusty-platform-0.13.30.vsix
```

Requirements: VS Code ≥ 1.90.0, Rust toolchain (installed via the extension if missing), Node.js for building.

---

## 3. First Steps

1. Open the **Rusty Platform** activity bar icon.
2. Run **Rusty Platform: New Project…** (or the `+` in the Boards/Project view).
3. Pick a board and template; the extension scaffolds a Rust project.
4. Run **Rusty Platform: Check Toolchain** to verify dependencies.
5. Build with **Rusty Platform: Build**, then **Flash**.

---

## 4. Sidebar Views

The activity bar container **Rusty Platform** holds four views:

### 4.1 Controls
Quick actions for the active project: build, flash, debug, monitor, clean, refresh.

### 4.2 Boards
Board catalog and project templates. Create new projects; refresh to re-scan.

### 4.3 Project
The active project's metadata: dependencies, features, designer entry. Add/reveal dependencies; open the designer when a designer project is detected.

### 4.4 AI Assist (webview)
The local AI assistant panel. Two modes: **Full Assist** (ask in your own words) and **Rust Assist** (watches the active `.rs` file for `//~ keyword` lines and posts worked examples). Conversations are kept per project. The prompt carries the **selected lines** (or the file you are looking at), the **Problems pane** and the **Debug Console**; **Console only** sends just the console. **Enter** sends, **Shift+Enter** starts a new line, **Abort** stops the answer, and the log follows the newest row until you scroll up. See §16 and `AI_ASSIST.md`.

---

## 5. Command Palette

All commands are under the **Rusty Platform** and **Rusty AI** categories. Highlights:

| Command | Purpose |
|---|---|
| New Project… | Scaffold a project |
| Build / Build for Debug / Build for Release | Compile |
| Flash / Flash with Debug Profile / Flash with Release Profile | Flash firmware |
| Flash over USB (BOOTSEL)… | UF2 over USB |
| Debug / Stop Debugging | SWD debug via probe-rs |
| Check Debug Configuration | Validate launch config |
| Set/Clear Wi-Fi Credentials | Manage Wi-Fi |
| Monitor (defmt) | RTT/serial monitor |
| Clean | cargo clean |
| Check/Install Toolchain | Manage Rust/targets/probe-rs |
| Install ESP Toolchain | espup + espflash |
| Install USB Permissions (udev) | udev rules |
| Add Cargo to PATH | Fix PATH |
| Update Debug Probe Firmware | Probe firmware |
| Open Designer | WYSIWYG designer |
| Import a Font… | Import fonts |
| Add/Show Dependency | crates.io manager |
| Show Connected Probes | List probes |
| Refresh | Refresh views |
| Publish/Install .deb | Packaging |
| Back Up Project | Zip backup |

**Rusty AI** commands — see §17 and `AI_ASSIST.md`.

Keyboard shortcuts (Rust files):
- `Ctrl+Alt+Enter` / `Cmd+Alt+Enter` — send the ✎ AI block
- `Ctrl+Alt+Escape` / `Cmd+Alt+Escape` — discard the ✎ AI block

---

## 6. Creating a Project

Run **New Project…**. Choose board family:
- **RP2040/RP2350**: Pico, Pico 2, Pico W, Pico 2 W. Templates: blinky, sensors, etc.
- **ESP32 family**: Sunton CYD, LilyGo T-QT, DevKitC V4 (ST7789 / ILI9341-with-touch / 4" ST7796-with-touch module), ESP32-035.

For boards supporting multiple display modules, you are asked which module is wired; the answer is recorded in `Cargo.toml`. The T-QT's GC9A01 panel revisions get special handling (inverted colors, BGR order, RAM offset). ESP32-035 is design-first (goes straight to designer). DevKitC V4 offers only designer and BLE peripheral.

Generated code uses `setup()` + `main()` loops, separating board config and headers.

---

## 7. Building

- **Build** — default profile.
- **Build for Debug** — debug profile.
- **Build for Release** — release profile.

Settings: `rustyPlatform.cargoPath`, `flashProfile` (`auto`/debug/release), `defmtLogLevel`.

Output goes to the terminal; problems reported to the Problems panel.

---

## 8. Flashing

- **Flash** — uses `flashProfile` (auto picks).
- **Flash with Debug Profile** / **Flash with Release Profile**.
- **Flash over USB (BOOTSEL)…** — UF2 drag-and-drop via bootsel.
- ESP boards flash via `espflash`; RP boards via `probe-rs`.

Settings: `rustyPlatform.espflashPath`, `serialPort`, `rustyPlatform.probeRsPath`.

---

## 9. Debugging & Monitoring

- **Debug** — SWD debugging via probe-rs (RP). Launch config auto-generated; **Check Debug Configuration** validates it.
- **Stop Debugging**.
- **Monitor (defmt)** — RTT/serial defmt log output.
- **Show Connected Probes** — list detected probes.

probe-rs firmware can be updated via **Update Debug Probe Firmware…**. USB permissions via **Install USB Permissions (udev)…**.

---

## 10. WYSIWYG Designer

Open via **Open Designer** (or project view when `designerProject` is set). Designs `designer/panel.ui.json` and generates markup for `include_gui!`.

### 10.1 Layout of the designer window

The designer has three panes plus a toolbar and a footer:

- **Toolbox** (left) — grouped catalog of every widget the crate can build. Each entry can be **dragged** onto the canvas, or **clicked**, which drops it in the middle of the canvas.
- **Stage** (centre) — the canvas showing the panel at its native size, with the **view tabs** above it.
- **Properties** (right) — the selected widget's properties, events, fonts, children.
- **Toolbar/Footer** — control bar: cargo feature switches (**SD**), **Brightness** slider, layer ordering, problem verdict.

The canvas size equals the designed area (panel size turned with the rotation).

### 10.2 Dropping widgets on the canvas

1. **From the Toolbox:** drag a widget tag onto the canvas and release, or click it to drop it in the centre. A newly dropped widget is placed centred and belongs to the **view currently being edited**.
2. **Interactive widgets turn on touch:** if the board has a touch controller and touch is off, dropping a widget that declares an event (buttons, sliders, keypads, …) automatically enables touch and tells you to rebuild.
3. **Selecting:** click a widget to select it; the Properties pane shows its fields. Drag to move; resize handles resize. Whole-pixel coordinates are kept.
4. **Layering:** widgets stack in document order; the Properties/toolbar buttons move a widget up/down in the stack.
5. **Context menu:** right-click a widget for cut/copy/paste, delete, grouping, etc. Right-click a view tab to rename, duplicate, delete, or mark it as the start view.
6. **Middle-click a widget** to jump to its **code behind** (see §10.4).

Pictures: widgets can show BMP/PNG/JPEG/GIF/WebP files from the project. The extension reads the file and the panel decodes it, so the canvas shows what the board gets. A widget whose pixels are not available yet draws a dashed frame carrying the file name. An `sd:/NAME.BMP` picture is the board's to fetch and is flagged on save while the card is off.

### 10.3 Views (tabs)

- A tab strip above the canvas holds one tab per view. Add with `+`.
- Right-click a tab to **rename**, **duplicate**, **delete**, or **make it the start view** (tab carries a dot; your order is preserved).
- **All views** draws the other views as dashed outlines, so a widget dropped on the wrong view can be found without switching tabs.
- Every widget is compiled into the same markup; the generated `ui.rs` hides views that are not on show, so switching costs a few flag writes rather than a rebuild.
- `navigate` switches view with no code: on a click (button), on a choice (dropdown), on Enter (keypad). `design.show_view(View::X)` drives it from app code (timer/sensor).
- Only the active view is driven: a clock on another view is not ticked.

### 10.4 Code behind — event handlers

A widget can declare **events** (clicked, pressed, valueChanged, submitted, scroll, textInput, opened, closed, etc.). In the Properties pane, tick the events you want a handler for. The designer then:

- Writes a handler stub into **`src/ui_handlers.rs`** (the one generated file it only ever appends to, never overwrites your edits) named `on_<widget>_<event>` (e.g. `on_go_clicked`).
- Adds a dispatch arm in the generated `ui.rs` that calls `crate::ui_handlers::on_…` when the widget raises that event.
- For `navigate`, no stub is created: the switch is written into `Designer::pump` so views change with no Rust code.

**Jumping to the code behind:**
- **Middle-click** a widget on the canvas. The panel sends a `revealHandler` action; the extension opens `src/ui_handlers.rs` and places the caret on `fn on_<widget>_<firstEvent>`.
- The first event in the widget's event list is the one used (the order stubs were appended).

**Handler signature:** depends on the event. Most carry the widget id; `submitted` hands you `&str` (the submitted line); `scroll` carries `delta: i32`; `textInput` carries `ch: char`. The dispatch arm is generated for you; implement the body.

**Rules:**
- Handlers are appended, not replaced — your edits survive regeneration. Removing an event removes the dispatch arm but leaves the (now unused) function; it is yours to delete.
- Attributes and signatures of your functions are never changed by the AI assist either (see §17).

### 10.5 Properties, fonts, styles

- Each widget exposes the attributes the crate's parser reads (typed fields: text, int, float, bool, color, enum, asset, font, style).
- **Fonts:** a design declares fonts (BDF files, relative to project root) with an id; widgets refer to them by id. Imported system fonts keep their face/size for re-rendering. Only declared or built-in fonts are offered.
- **Styles:** named styles plus per-widget overrides folded into one `style` expression (text/accent/background/border/corner_radius).
- **Children:** dropdown/roller/carousel (options), table (headers/rows), icon (parts) carry child grammar edited in the Properties pane.

### 10.6 Touch, SD, backlight

- **Touch:** enabling touch is required for interactive widgets; the designer flips it on when you drop an interactive widget (rebuild needed).
- **SD switch:** cargo feature; card filesystem pulled in only when on. `sd:/NAME.BMP` images flagged on save while off. On the ESP side this is the CYD's card; a Pico module's socket is its own four pins, separate from the panel bus.
- **Brightness slider:** sets `BACKLIGHT_BRIGHTNESS` in `.cargo/esp-config.toml` at compile time (0–100%). Only for panels with a BL pin; inverted for active-low. A project that omits it is fully on.

### 10.6a The Designer on a Raspberry Pi Pico

A Pico has no soldered panel, so there the panel is a **project** fact: which module, and which GPIOs it is wired to. Picking **Designer** on `pico`, `pico2`, `picow` or `pico2w` opens a panel of inputs for:

- **the module** — a 1.54" ST7789 (240×240), a 2.8" ILI9341 with XPT2046 touch (240×320) or a 4" ST7796 with XPT2046 touch (320×480);
- **the panel's pins** — SPI bus, SCK/MOSI/MISO, CS, DC, RST, BL, and the touch CS/IRQ when the module has a controller;
- **the card socket's pins** — its own four, separate from the panel's (sharing the bus stays allowed).

The same `validateWiring` rules decide what the Designer accepts and what the generator writes, so the two cannot disagree. The pins are written into a generated `src/panel.rs` that the Designer rewrites; `src/main.rs` is written once and never rewritten, so your own loop is safe. Templates are `designer`, `display` (a panel diagnostic) and `sdcard`.

No Pico has an RTC on the chip: `pico` and `pico2` start their clock from **the time they were flashed**, and `picow` / `pico2w` use **Wi-Fi SNTP** (with a setting reserved for a battery-backed module).

### 10.7 Clock designs

A design with a clock starts a serial time listener automatically (host PC time), closes it for Flash/Monitor, and restarts after flash. The hour-number distance inside the tick ring is *Number inset* (character widths, 0.1 steps).

Backlight: dimmable 0–100% via PWM on BL pin, compile-time `BACKLIGHT_BRIGHTNESS` in `.cargo/esp-config.toml`. Offered only for panels with a BL pin; inverted for active-low. Projects not mentioning it are fully on.

---

## 11. Clock & Time Sync

A design's clock follows the host PC's time, set/served over the serial port (board asks `TIME?` when RTC never set), kept in the chip's RTC. Boards without a PC fall back to Wi-Fi SNTP via generated `src/net.rs`.

Host writes dated line `TIME YYYY-MM-DD HH:MM:SS` then bare `TIME HH:MM:SS`, so the calendar day survives power cycles without network.

New ESP projects bake in the host's UTC offset. Hour-number distance inside the tick ring is a design property (*Number inset*, in character widths, stepped by 0.1).

---

## 12. SD Card (CYD)

Note: work in progress. Will add SD card file system feature to all target boards.
Designer shows **SD** switch in control bar for Sunton CYD (only board with a card). It's a cargo feature because enabling the card pulls the FAT filesystem (`embedded-sdmmc`) into the build. Dedicated `sdcard`/`board` templates always include it. Designs naming `sd:/NAME.BMP` images flagged on save while card is off.

---

## 13. Wi-Fi Credentials

- **Set Wi-Fi Credentials…** / **Clear Wi-Fi Credentials**.
- Used by generated net code. Stored appropriately.

---

## 14. Toolchain Management

- **Check Toolchain** — verifies rustup, targets, probe-rs, espup, espflash.
- **Install Missing Toolchain…** — one-click installer with SHA-256 checks for prebuilt probe-rs.
- **Install ESP Toolchain (espup + espflash)…**.
- **Add Cargo to PATH…** — if cargo not on PATH.
- **Install USB Permissions (udev)…** — Linux udev rules.

---

## 15. Crates.io Library Manager

Curated catalog + sparse index integration. Commands: **Add Dependency…**, **Show Dependency in Cargo.toml**. Manage project crates from the Project view.

---

## 16. AI Assist

Optional, fully local, privacy-first. See `AI_ASSIST.md` for full details.

Summary:
- Two backends: **A server I run** (external OpenAI-compatible) or **The extension's own runtime** (bundled, builds llama.cpp).
- Models: your own llama-server (extension offers to download prebuilt server + 27B model), any Hugging Face `.gguf`, or bundled runtime/LM Studio.
- Two modes in panel: Full Assist and Rust Assist (`//~ keyword`).
- The chat reads the **selection** (numbered, with a marked window), the **Problems pane** (errors first, deduplicated) and the **Debug Console** of a `probe-rs` session (output, `[stopped]`, `[exited]`). **Console only** sends just the console.
- **Enter** sends, **Shift+Enter** starts a new line, **Abort** stops the answer in flight; the log follows the newest row until you scroll up.
- Implement in Function: insert `✎ AI` block, type request as comments, `Ctrl+Alt+Enter` to send. Answer opens as diff; Apply/Discard.
- Chat code blocks get an **Implement …** button; a quoted or elided answer is refused, with the complete block, the line fix or a re-ask offered instead.
- Fix the Build…: runs cargo check, fixes first error, rebuilds, keeps fix if closer, undoes otherwise.
- Quick Fix menu on a squiggle: **Fix with the AI assist** (whole function) and **Fix this line with the AI assist** (one line, bracket-balanced, 200-token budget).
- Learn House Rules: measures project idioms, keeps chosen ones into `rustyPlatform.assistant.conventions`.
- Conversations per project; editor tab mode for second monitor.

Settings under `rustyPlatform.assistant.*` — see §19.

Nothing leaves your machine. No API keys.

---

## 17. Packaging & Backup

- **Publish .deb** / **Install .deb** — package firmware and helper scripts into `.deb` installers.
- **Back Up Project** — archive project.

---

## 18. Settings Reference

### General
| Setting | Default | Description |
|---|---|---|
| `rustyPlatform.cargoPath` | "" | Explicit cargo path; empty auto-detect |
| `rustyPlatform.probeRsPath` | "" | Explicit probe-rs path |
| `rustyPlatform.espflashPath` | "" | Explicit espflash path |
| `rustyPlatform.lcdRotation` | 0 | 0/1/2/3 (90° steps) |
| `rustyPlatform.flashProfile` | auto | auto/debug/release |
| `rustyPlatform.serialPort` | "" | Serial port |
| `rustyPlatform.defaultBoard` | pico | Default board |
| `rustyPlatform.defmtLogLevel` | debug | defmt log level |
| `rustyPlatform.revealTerminalOnRun` | true | Reveal terminal on run |
| `rustyPlatform.promptMissingRequirements` | true | Prompt for missing reqs |

### AI Assist (`rustyPlatform.assistant.*`)
| Setting | Default | Description |
|---|---|---|
| `enabled` | false | Master switch |
| `stopServersAtStartup` | true | Stop servers at startup |
| `backend` | off | off/external/bundled |
| `endpoint` | http://127.0.0.1:1234/v1 | OpenAI-compatible base URL |
| `model` | "" | Model id (external) |
| `modelPath` | "" | Bundled model path |
| `threads` | 0 | Threads |
| `contextSize` | 4096 | Context size |
| `gpuLayers` | 0 | GPU layers |
| `bundledBackend` | cpu | cpu/gpu backend |
| `loadContextLength` | 0 | Load context length |
| `loadGpu` | auto | auto/cpu/gpu |
| `loadTtlSeconds` | 0 | TTL |
| `gpuVramGb` | 0 | GPU VRAM (if undetected) |
| `llamaServerPath` | "" | llama-server binary |
| `llamaServerArgs` | "" | Extra args |
| `llamaServerModelPath` | "" | .gguf for your server |
| `llamaServerService` | "" | systemd unit name |
| `llamaServerStartTarget` | unit | unit/process |
| `timeoutSeconds` | 60 | Idle timeout |
| `maxTokens` | 4096 | Max answer tokens |
| `temperature` | 0.2 | Sampling temp |
| `showDiff` | true | Review diff before apply |
| `verifyAfterApply` | true | Offer cargo check after apply |
| `conventions` | [] | House rules |
| `ignoreHostCheck` | false | Run despite host check |

---

## 19. Troubleshooting

- **Cargo not found**: run **Add Cargo to PATH…** or set `rustyPlatform.cargoPath`.
- **Probe not detected**: install udev rules, update probe firmware, check USB cable.
- **ESP flash fails**: verify `espflashPath`, serial port, board in bootloader mode.
- **AI model won't load**: run **Status and Hardware Check**; check host RAM/VRAM; use *Use it anyway* if needed.
- **Designer pictures missing**: ensure files exist in project; SD images need card enabled.
- **Clock not syncing**: ensure serial monitor not occupying port; check UTC offset setting.

---

## License

MIT OR Apache-2.0. See `LICENSE`, `LICENSE-MIT`, `LICENSE-APACHE`.

Repository: https://github.com/OomNiel/grumpy-rusty-platform.git
