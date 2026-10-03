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
| Project Wizard (board → working workspace) | ✅ 7 boards: RP2040, RP2350, ESP32, ESP32-S3 |
| Generated workspace: `Cargo.toml`, `.cargo/config.toml`, `memory.x`, `build.rs`, `rust-toolchain.toml`, `src/main.rs`, `.vscode/{settings,launch}.json` | ✅ RP; ESP gets `esp-config.toml` instead of `memory.x`/`launch.json` |
| Templates | ✅ RP: `blinky`, `wifi`, `wifi-bluetooth` (with a credentials prompt) · ESP: periodic task, panel test image |
| Toolchain detection (cargo, rustup, targets, probe-rs, probe health) | ✅ plus espup / Xtensa toolchain / espflash for ESP |
| One-click installer (rustup, targets, prebuilt probe-rs with SHA-256 check, udev rules) | ✅ plus espup + espflash, only for the chips in use |
| `Add Cargo to PATH…` for shells that never received `~/.cargo/bin` | ✅ |
| Status bar, and the same buttons in the side bar's **Controls** section | ✅ |
| Debug session (probe-rs-debug + RTT) | ✅ RP only, verified against `probe-rs.probe-rs-debugger` 0.32.0. An ESP32 has no SWD, so **Debug** flashes and monitors instead |
| Four debug configurations, all on the **debug** build | ✅ RP: flash & run · flash & halt · restart without flashing · attach |
| Chip check before a no-flash session (`probe-rs verify`) | ✅ RP only |
| Flash / monitor over USB serial (`espflash`) | ✅ ESP — one-shot write, and a monitor that holds the port on purpose |
| crates.io Library Manager | ✅ curated catalog + live sparse index |
| Layered test suite | ✅ 370 hermetic (t1 345 · t2 21 · t3 4) + 2 opt-in e2e + 1 hardware HIL |
| Phase 4 guard rails: validate a launch config against the installed debugger | ⬜ |
| Windows support | ⬜ later (installer URLs are already platform-aware) |

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
| New Project… | Wizard: board, template, name → a complete workspace |
| Build / Clean | `cargo build` / `cargo clean` in a terminal |
| Flash | Builds the debug image and writes it — through the probe (`probe-rs download` + `reset`) for RP, or with `espflash` over USB serial for ESP. One-shot in both cases: it releases the probe/port when it is done |
| Flash over USB (BOOTSEL)… | The UF2 route on purpose (recovery, or a board with no probe). On an ESP project it uses `espflash` instead |
| Debug / Stop Debugging | RP: build, flash and start a probe-rs session with RTT. ESP: says there are no breakpoints without JTAG, then flashes and monitors in one terminal |
| Monitor (defmt) | RP: `probe-rs attach` — RTT without reflashing. ESP: `espflash monitor` — the serial log. Both hold the device until their terminal is closed |
| Add Dependency… | crates.io search (bundled catalog + live index); edits `Cargo.toml` |
| Set / Clear Wi-Fi Credentials | See above |
| Check Toolchain / Install Missing Toolchain… | Detection, and the one-click installer |
| Install ESP Toolchain (espup + espflash)… | The Espressif side of the same idea: installs espup, the Xtensa toolchain (only the chips in use) and espflash |
| Add Cargo to PATH… | Writes `~/.cargo/bin` into the login profile when rustup was installed with `--no-modify-path` |
| Install USB Permissions (udev)… / Update Debug Probe Firmware… / Show Connected Probes | Probe housekeeping |

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

* **Flash and Debug agree on what is on the chip.** Flash writes the same debug build the debug
  configurations load, so Build → Flash → Debug just works: no prompt, no extra flashing, and
  breakpoints bind.
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
node tests/runner.js --e2e                 # + real `cargo build` of generated projects
node tests/runner.js --hil                 # + flash real hardware and read defmt over RTT
UPDATE_SNAPSHOTS=1 node tests/runner.js --layer t3-golden   # re-record golden files
```

| Layer | What it proves |
|---|---|
| `t1-logic` | Board matrix (both families), generator, crate/binary naming, parsers, install planner, ESP toolchain plan |
| `t2-cli` | Toolchain detection against fake `cargo`/`rustup`/`probe-rs`/`espup`/`espflash` shims (real processes) |
| `t3-golden` | Byte-for-byte snapshots of generated projects |
| `t4-e2e` | The generated firmware really compiles and links (opt-in, slow, needs network) |
| `t5-hil` | The firmware really flashes and logs over RTT (opt-in, needs a probe) |

## Supported boards

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
`memory.x`, no UF2 image and no CYW43. The touch controller and the SD socket are described in the
board data and listed in the generated README, but no template drives them yet, and there is no
Wi-Fi template for ESP either.

## Documentation

Developer notes, verified version pins and hard-won traps live in `NOTES.md` in the project
repository. It is deliberately not shipped inside the extension package.

User-visible changes are recorded in [`CHANGELOG.md`](CHANGELOG.md), which *is* shipped, so VS Code
shows it in the extension's **Changelog** tab.

## License

Dual **MIT OR Apache-2.0**, the Rust ecosystem norm — see [`LICENSE`](LICENSE) for the choice,
with the full texts in [`LICENSE-MIT`](LICENSE-MIT) and [`LICENSE-APACHE`](LICENSE-APACHE).
