# NOTES.md — developer log

Durable working notes for **Grumpy's Rusty Platform for VS Code**. Read this before
changing the generator, the board matrix or the pinned versions.

---

## 1. Verified toolchain facts (2026-10-02)

Everything below was verified on this machine, not assumed.

| Thing | Value | How it was verified |
|---|---|---|
| Host | Zorin OS 18.1, x64 | `/etc/os-release` |
| rustup | 1.29.1 | installed via rustup-init |
| cargo / rustc | 1.99.0 | `cargo --version` |
| probe-rs | 0.32.0 | prebuilt release binary, SHA-256 checked |
| Node / npm | v22.23.2 / 10.9.8 | `node --version` |
| VS Code | 1.140.0 | `code --version` |
| Debug Probe | `2e8a:000c`, `probe-rs list` → `2e8a:000c-0:E6614103E74B072F` | `probe-rs list` |
| Firmware blocker | probe firmware < 2.2.0 → probe-rs refuses to open it | `probe-rs info` |

### Pinned crate versions

Verified against the crates.io sparse index **and** by really linking both boards
(t4-e2e):

```
embassy-rp       0.10.0
embassy-executor 0.10.0
embassy-time     0.5.1
defmt            1.1
defmt-rtt        1.3
panic-probe      1.0.0
cortex-m         0.7
cortex-m-rt      0.7
critical-section 1.2
```

---

## 2. Traps that cost real time

### 2.1 `embassy-executor` must NOT get `platform-cortex-m` (duplicate `__pender`)

**Symptom:** link failure

```
rust-lld: error: duplicate symbol: __pender
    defined at embassy-rp/src/executor.rs:15
    defined at embassy-executor/src/platform/cortex_m.rs:3
```

**Cause:** `embassy-rp` exposes its own `executor-thread` / `executor-interrupt`
features, and its `src/executor.rs` defines an `#[export_name = "__pender"]` symbol
(a multicore-capable pender). `embassy-executor`'s `platform/cortex_m.rs` defines a
`__pender` under the *same* `cfg(feature = "executor-thread"|"executor-interrupt")`.
Enabling those features on both crates yields two definitions.

**Correct wiring** (mirrors `embassy/examples/rp{,235x}/Cargo.toml`):

```toml
embassy-executor = { version = "0.10.0", features = ["defmt"] }          # defmt ONLY
embassy-rp       = { version = "0.10.0", features = [ /* ... */, "executor-thread", "executor-interrupt"] }
```

and user code must name the executor and entry point:

```rust
#[embassy_executor::main(executor = "embassy_rp::executor::Executor", entry = "cortex_m_rt::entry")]
async fn main(_spawner: Spawner) { ... }
```

`embassy-executor` compiles fine without any `platform-*` feature: `lib.rs` falls back
to `main_unspecified`, which is exactly what the `executor = ...` argument resolves.
Do **not** "fix" this by adding `platform-cortex-m`.

### 2.2 Cargo names the binary after the package name, hyphens intact

For package `e2e-pico`, `cargo build` writes `target/<triple>/debug/e2e-pico` — **not**
`e2e_pico`. The underscore form is only the Rust *identifier*. Our `launch.json`
`programBinary` must therefore use the crate name verbatim.

Caught by the t4-e2e layer, which asserts the artefact name. `binaryNameFrom()` returns
the crate name unchanged and carries a comment explaining why.

### 2.3 The crates.io index splits features across `features` and `features2`

Querying the sparse index and reading only `.features` silently misses every modern
feature that uses `dep:` syntax — including `time-driver`, `defmt`, `executor-thread`,
`executor-interrupt` and `binary-info` on `embassy-rp 0.10.0`. Read **both** maps
(or inspect the published `.crate`'s `Cargo.toml`).

### 2.4 RP2350 specifics

* Chip id in probe-rs is **`RP235x`**, not `RP2350` (RISC-V variant: `RP235x_riscv`).
* `rp235xa` / `rp235xb` are separate features (30 vs 48 GPIO bank-0 pins).
* `binary-info` is **required** — it supplies the boot-ROM image definition
  (`.start_block` / `.boot_info`). This is why `memory.x` needs the `SECTIONS { ... }
  INSERT AFTER ...` blocks for RP2350 and why RP2040 must not have them.
* RP2350 has **no second-stage bootloader**: `build.rs` must not link `-Tlink-rp.x`
  and `memory.x` has no `BOOT2` region. RP2040 needs both.
* Pico 2 flash is 4 MB; Embassy's example deliberately uses 2 MB as a "safe default".
  We emit `4096K` for the Pico 2 profile.

### 2.5 Backticks inside TypeScript template literals

Generated Rust/TOML comments go through TS template literals. An unescaped backtick
in a comment (e.g. around `memory.x`) terminates the literal and produces a confusing
`TS1005: ';' expected`. Escape them: `` \`memory.x\` ``.

### 2.6 Multi-line edits can silently drop a line

Twice during this session a multi-line replacement landed with one line missing
(`probeRsPath?: string;`, `const probeRs = ...`), which is the same failure mode
recorded in `memory-tool-traps.md`. **Re-read the edited region after any multi-line
replacement**, and trust the compiler to surface it.

### 2.7 `PROVIDE` does not override a plain assignment

cortex-m-rt's `link.x` offers `_stext` through `PROVIDE(…)`, which only applies while the symbol is
undeclared — memory.x assigned it, so the alignment was thrown away and `rust-lld` warned on every
RP2350 link. Assignment wins; carry the `ALIGN(…, ALIGNOF(.text))` yourself. Full measurements in
§15.

### 2.8 One RTT terminal can show two firmwares

A log that mixes `bluetooth setup interrupt mask` (impossible without BT firmware) with
`using a static IP …` and `DHCP …` is not one run: the buttons and a terminal build produced
different images, and the RTT buffer replays the previous image's bytes after a reset. Details in
§19.

### 2.9 `/dev/ttyACM*` is enumeration order, not identity

The Debug Probe took `ttyACM0` during a probe-rs session and moved the Pico to `ttyACM1`, which
broke an app that had hard-coded the number — and its own error message blamed the `dialout` group
while the kernel error was `EBUSY`. Address serial devices by USB serial (or a udev alias); see §20.

---

## 3. Test suite

```
tests/
  runner.js                      # --layer / --file / --e2e / --hil / --no-compile
  lib/harness.js                 # zero-dependency harness, runtimeSkip()
  layers/t1-logic/               # pure functions
  layers/t2-cli/shims/           # fake cargo, rustup, probe-rs (POSIX sh)
  layers/t3-golden/__snapshots__ # committed golden files
  layers/t4-e2e/                 # real cargo build (opt-in)
  layers/t5-hil/                 # real flash + defmt capture (opt-in)
```

* The runner compiles (`tsc`) unless `--no-compile`, so tests never run against stale JS.
* t2 injects explicit shim paths (`cargoPath` / `rustupPath` / `probeRsPath`) rather than
  relying on PATH, because `findExecutable` looks in `~/.cargo/bin` first.
* Runtime skips use `runtimeSkip(reason)`, which throws a `SkipSignal`; collection-time
  skips use `skip(name, reason)`.

Tests that have already earned their keep:

* t1 caught the trailing-quote bug in the `--chip` regex (`STM32G431CBTx"`).
* t2 caught the rustup shim's `:-` default swallowing an intentionally-empty target list.
* t4 caught both the `__pender` duplicate and the Cargo hyphen/binary-name mistake.
* t1's lexer test in `wifi-template.test.js` caught a leftover explanation that had been left
  inside a template literal: the generated Rust stopped compiling, and only a state-tracking scan
  (strings and comments) saw it — counting quotes would not have.
* t1's manifest guard caught both new commands (`debugStop`, the credential pair) before they could
  ship undeclared in `package.json`.
* t1's generated-content guard keeps the word "undefined" out of every generated file, so a
  missing interpolation cannot reach a user's project.

---

## 4. Open items

1. **Debug Probe firmware.** Resolved on this bench: the probe reports fw 2.3.1, `probe-rs` 0.32
   opens it, and a real DAP session with RTT ran on 2026-10-03 (§17). The BOOTSEL/UF2 update flow
   (§7) still covers an older probe.
2. **udev rules — resolved 2026-10-03 (§21).** `/etc/udev/rules.d/99-picoprobe.rules` covers
   `2e8a:000c` (mode 0666) and the extension still offers the broader `69-probe-rs.rules`. The check
   used to look for *our* two file names only, so this bench was told "MISSING" while it had been
   flashing all day. The bench also gained a DataSafe alias on 2026-10-03 (§20) — unrelated to the
   probe, but it is why the port numbers moved.
3. **Phase 4 guard rails.** The emitted `probe-rs-debug` config was checked by hand against the
   installed `probe-rs.probe-rs-debugger` 0.32.0 (`launch` requires `chip` + `coreConfigs`,
   `coreConfigs.items` requires `programBinary`, `rttEnabled` exists) and a real session ran, so the
   config is correct *today*. The chip check (§23) now pre-flights what the chip holds before a
   no-flash session, which is half of this. Still missing: validate the emitted config against the
   installed debugger's declared schema, so a debugger upgrade that adds a required attribute is
   reported before the session starts.
4. **The generated wifi `warn!` carries an inert `/* superseded wording … */` tail.** Its bytes
   contain backslash runs no editor edit has matched, so removing it needs a one-off scripted edit
   (and the user's approval — no terminal file edits without it). It sits inside a block comment, so
   it compiles, and a t1 test pins that.
5. **Existing projects keep the old template text.** Only newly generated projects get the
   credential-prompt documentation (§18); `my-blinky-pico2w` still has the pre-2026-10-03 README and
   comments.
6. **`DEFMT_LOG` default.** The generated `.cargo/config.toml` sets `debug`, which prints every
   cyw43/smoltcp `debug!` line — helpful while diagnosing Wi-Fi, noisy afterwards. `info` was
   offered, not decided.
7. **Catalogue caveat:** `pio`/`pio-proc` 0.4 in the Library Manager would give a second copy of
   `pio` alongside embassy-rp's 0.3.
8. **Windows** — installer paths are platform-aware but untested; `probe-rs` needs WinUSB/libusb
   handling that differs from Linux.
9. **DHCP on the bench** — **resolved 2026-10-03**: a clean `probe-rs run` completes the exchange and
   the board holds `192.168.11.46` (§19). The failing lines were replayed/misdecoded console history,
   not a DHCP fault, and the router never needed attention.
10. **The optimised (release) image is no longer reachable from the UI.** Both flash routes and every
   debug configuration now use `debug` (§26), because a release image cannot carry bindable
   breakpoints. `cargo build --release` plus `probe-rs download` still writes one by hand; a separate
   "Flash release (optimised)…" command is the obvious thing to add if Grumpy wants it.
11. **The docs are current as of 2026-10-03, v0.0.2** (the release pass). `README.md`,
   `CHANGELOG.md` and this file all describe the ESP32 family now; the generated project `README.md`
   documents the four configurations and the breakpoint budget for RP, and the flash/monitor
   behaviour for ESP. A project generated before 2026-10-03 keeps the older text (see item 5).
12. **ESP32 open items** — see the list at the end of §33. In short: the generated ESP firmware has
   not been compiled yet (that is the next thing to do), there is no ESP `wifi` template, and the
   touch panel and microSD socket are described in the board data but unused by any template.

---

## 5. Licensing (decided 2026-10-02)

Dual **`MIT OR Apache-2.0`**, the Rust ecosystem norm:

* `LICENSE-MIT` and `LICENSE-APACHE` (canonical text from apache.org: 202 lines /
  11 358 bytes, sha256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`).
* `package.json` → `"license": "MIT OR Apache-2.0"`.
* Generated projects already declared the same in `Cargo.toml`, so the two now agree.
* `embassy-rp` and `probe-rs` are both `MIT OR Apache-2.0`. We ship no Rust code (child
  processes only), so dependency licensing does not attach to us — revisit if we ever
  bundle Rust or WASM.

---

## 6. Flash layout (decided 2026-10-02)

Every board reserves a "drive" region at the end of flash for a future filesystem. It is
declared in `memory.x` as `FS` and nothing links into it yet — it exists so the
application region cannot silently grow into the space we want later.

| Board | Chip | Application | Drive (`FS`) |
|---|---|---|---|
| Pico / Pico W | 2 MB | `1536K - 0x100` at `0x10000100` | 512 KB at `0x10180000` |
| Pico 2 / Pico 2 W | 4 MB | `3072K` at `0x10000000` | 1024 KB at `0x10300000` |

The RP2040 application half is 1.5 MB because wireless builds are fat — the CYW43 Wi-Fi
firmware alone is 231 077 bytes and `embassy-net` adds more. Verified: both generated
projects still link with the smaller application region (`--e2e`).

---

## 7. Debug Probe firmware support

probe-rs 0.32 refuses probes older than **2.2.0** with:

```
Error: Failed to open probe: Failed to open the debug probe.
Caused by: ... 2: The firmware on the probe is outdated, and not supported by probe-rs.
The minimum supported firmware version is 2.2.0.
```

`classifyProbeError()` turns that into a `firmware-outdated` diagnosis and
`minimumFirmwareFromProbeRs()` extracts the required version. The update flow:

1. `rustyPlatform.updateProbeFirmware` offers the three release images (Debug Probe,
   Pico-as-probe, Pico 2-as-probe); hashes and sizes are pinned in `debugProbe.ts`.
2. The `.uf2` is downloaded once into
   `~/.grumpy-rusty-platform/firmware/debugprobe-2.3.1/` and **SHA-256 verified against
   the pinned hash** before anything touches a device.
3. The command waits for a BOOTSEL volume, confirming it by the `INFO_UF2.TXT` the boot
   ROM writes, so an unrelated folder named `RPI-RP2` is not mistaken for a probe.
4. Copy, then wait for the volume to disappear (the probe reboots itself).

Pinned assets (hashes computed 2026-10-02; UF2 magic `0x0A324655` verified):

| Image | Bytes | SHA-256 |
|---|---|---|
| `debugprobe.uf2` | 106 496 | `aae9585f…2521a1b8` |
| `debugprobe_on_pico.uf2` | 105 984 | `6649ebba…4e3792d4` |
| `debugprobe_on_pico2.uf2` | 99 840 | `98cbb993…d7b704621` |

Only the user can press BOOTSEL, so that step is always marked `physical` in the plan and
the UI says so. If the copy fails, the message includes the cached image path so the file
can be dragged across by hand.

Possible improvement: read the probe's `bcdDevice` from sysfs to display the *current*
firmware version instead of only knowing "too old". Not implemented — the encoding of that
value is unverified.

---

## 8. Wireless (Pico W / Pico 2 W) — decided, implementation next

Requirement: **Wi-Fi and Bluetooth are non-negotiable and must exist before we go public.**
The user has W hardware available, so Wi-Fi can be HIL-verified for real.

Verified facts (re-check these if versions move):

| Thing | Value |
|---|---|
| Chip | CYW43439, driven over PIO SPI |
| Crates | `cyw43` 0.7.0, `cyw43-pio` 0.10.0, `embassy-net` 0.9.1, `bt-hci` 0.10.1, `trouble-host` 0.8.0 |
| Wi-Fi blobs | `43439A0.bin` 231 077 B, `43439A0_clm.bin` 984 B, nvram 742 B |
| BT blob | `43439A0_btfw.bin` 6 164 B |
| W LED | **not GPIO25** — `control.gpio_set(0, …)` through the CYW43 |
| Alignment | `cyw43::new` needs `&Aligned<A4, [u8]>`; `aligned_bytes!` only takes a *file path* |
| Upstream examples | feed the driver from a `firmware/` directory, not from a crate |
| `trouble` on crates.io | a **placeholder (0.0.0)** — the real host stack crate is `trouble-host` |

Decisions taken:

* **Blob strategy: mirror upstream.** Fetch the pinned blobs once (SHA-256 verified),
  cache them, and give each wireless project a `firmware/` directory consumed with
  `aligned_bytes!`, exactly as Embassy's examples do. This keeps us on the upstream,
  tested path and avoids redistributing the blobs inside the VSIX (they carry their own
  binary licence).
* **PIO wiring** from the official Pico 2 W example: `PIN_23` pwr, `PIN_24`/`PIN_29` SPI,
  `PIN_25` cs, `PIO0`, `DMA_CH0`/`DMA_CH1`, `RM2_CLOCK_DIVIDER`.
* **nvram**: upstream's Pico 2 W example uses `nvram_rp2040.bin`; follow upstream and
  revisit if Wi-Fi proves flaky on real hardware.
* **Bluetooth in this pass = dependencies plus a buildable skeleton**, clearly marked as
  not yet hardware-verified. There is **no upstream CYW43 Bluetooth example to copy**, so
  a working BLE demo would be original code with nothing to check it against.
* **The wizard offers a choice of application template** for wireless boards:
  1. Wi-Fi connect, log the IP, blink the CYW43 LED
  2. CYW43 LED blink only
  3. Wi-Fi plus a commented Bluetooth section

  Wired boards keep the plain GPIO blinky, and the generator must reject a wireless
  template on a non-wireless board.

---

## 9. Wireless implemented (2026-10-02)

### The big lesson: Embassy's `main` examples are AHEAD of the published crates

Copying `examples/rp*` from `main` produced code that does **not** compile against the
versions we pin — the examples track unreleased APIs. Verified differences that cost
real debugging time:

| Area | `main` example (do NOT copy) | published crate (what compiles) |
|---|---|---|
| `PioSpi::new` | 9 args, two DMA channels | **8 args, one** `dma::Channel` (`cyw43-pio` 0.10.0) |
| Network stack | `StackStorage` + `Stack::new` + `add_iface_borrowed` + `iface.set_dhcpv4` | `embassy_net::new(driver, Config::dhcpv4(..), &mut StackResources<N>, seed) -> (Stack, Runner)` (`embassy-net` 0.9.1) |
| `cyw43::Runner` | `Runner<'static, BUS, Cyw43439>` | **`Runner<'a, BUS>`** — two parameters (`cyw43` 0.7.0) |
| `net_task` | `Runner<'static>` | `Runner<'static, cyw43::NetDriver<'static>>`, and it takes `mut runner` |
| Atomics | — | **`portable-atomic` with `critical-section` is mandatory on `thumbv6m`**: `static_cell` needs an atomic compare-exchange and the Cortex-M0+ has none |

Rule going forward: **write templates against the published crate sources**, then let
`--e2e` prove it. Read `main` for intent, never for signatures.

### What is generated

The wizard now asks wireless boards what the application should do:

| Template | Generated behaviour |
|---|---|
| `wifi` | joins the network, DHCP, logs `Wi-Fi is up - IP a.b.c.d`, blinks the CYW43 LED |
| `blinky` | CYW43 LED only, no networking code (smallest wireless image) |
| `wifi-bluetooth` | the Wi-Fi template plus `cyw43/bluetooth` + `bt-hci` and a commented BT starting point |

Wired boards still get one `blinky` option and are not asked.

* **Credentials come from the build environment**: `option_env!("WIFI_SSID")` /
  `WIFI_PASSWORD`, with placeholders as the fallback. Secrets never enter the source
  tree, and the hardware layer can flash a working Wi-Fi build:
  `HIL_BOARD=picow HIL_TEMPLATE=wifi WIFI_SSID=… WIFI_PASSWORD=… node tests/runner.js --hil`
* **Bluetooth stays dependencies plus a skeleton**, as agreed — there is no upstream
  CYW43 BT example, so a BLE demo would have nothing to check against. The
  `trouble-host` line remains commented out: it exposes ~95 features and guessing a set
  is exactly the kind of thing this project should not do.
* **Blobs** are fetched from the pinned Embassy commit
  `b12a6d9efcd2711037abca1b63a661a9ef726444` into a shared cache
  (`~/.grumpy-rusty-platform/firmware/cyw43-b12a6d9e/`), SHA-256 verified, then copied
  into each project's `firmware/` together with the binary licence. The t4 layer fetches
  them through the same pinned metadata, so a wrong hash or URL fails the suite instead
  of a user's project.
* The **on-board LED on a W board is not GPIO25** — it is CYW43 GPIO0 via
  `control.gpio_set(0, …)`, while `PIN_25` is the chip select. The board model now carries
  `led: { kind: 'gpio' | 'cyw43' }`, so that cannot be got wrong by accident.

### Verification status

* 147 hermetic tests green. Golden snapshots now cover **every board × template**
  (86 files), so template drift is caught immediately.
* `--e2e` builds six projects (both wired boards, both W boards, all three wireless
  templates) and asserts the wireless image is larger than the wired one, proving the
  231 KB firmware really is linked in.
* **Runtime verified on a real Pico 2 W — see §10.** Still to do: the Wi-Fi templates,
  which need real credentials.

---

## 10. Hardware bring-up + the RTT capture trap (2026-10-02)

First true end-to-end run: wizard output → `cargo build --release` → `probe-rs` → real
RP2350 silicon → CYW43 init → LED blink → `defmt` over RTT. Board: Pico 2 W on a
Raspberry Pi Debug Probe.

### Bench notes

* The probe shipped with firmware **1.0.1** (`bcdDevice 0x0101`); probe-rs 0.32.0 refuses
  it (needs ≥ 2.2.0). Updated to **2.3.1** through our own update flow (BOOTSEL →
  `RPI-RP2` volume → `debugprobe.uf2`), confirmed by `bcdDevice 0x0231`.
* A dead SWD link turned out to be the **3-wire cable**, not software; the probe also
  needed a power cycle. The symptom (`No target responded to the debug port`) also
  appears with reversed wiring, so check the cable before suspecting the toolchain.
* probe-rs **cannot auto-detect RP235x** (`probe-rs info` fails with "The connected chip
  could not automatically be determined") while flashing works fine, because we always
  pass an explicit `--chip RP235x`. Hence the `chip-not-autodetected` diagnosis kind,
  which the Project view and the toolchain checker must treat as a pass, not a problem.

### The trap: a fixed RTT capture window races the flash

`t5-hil` flashed correctly but captured `""`. Two red herrings first: grepping the RAM
dump for `SEGGER RTT` failed only because the dump is **text hex, 16 bytes per line**, so
the signature was split across a line break; and searching RAM for our log *text* can
never work, because defmt puts a format-string **index** in the ring buffer, not the
string.

What settled it — read the RTT control block out of RAM and decode it (at `0x20000000`,
`defmt` magic + `SEGGER RTT` acID):

| field | value | meaning |
| --- | --- | --- |
| `up[0].pBuffer` | `0x20004a78` | ring buffer, 1024 B |
| `up[0].WrOff` | 691 | ≈ 8.9 KB written (wrapped ×8) |
| `up[0].RdOff` | 685 | the host had read all of it; 6 B pending |

The target side was perfect all along. The bug was in the harness: **`probe-rs run` needs
~10 s just to program the image** ("Finished in 9.57 s") and the test killed it after a
fixed 5 s — mid-flash. Fix: wait for the expected line, with a 120 s ceiling as a safety
net, extracted into `tests/lib/rtt.js` (`captureUntil`) so the timing rule is tested
instead of re-derived.

Lesson to keep: in HIL tests never time the capture from process start — wait for the
evidence, and read "no output" as "the process had not finished", not "the firmware is
silent".

### Verified end-to-end (Pico 2 W / blinky)

```
[INFO ] CYW43 is up on RP2350 (hil_pico2w_blinky src/main.rs:67)
[DEBUG] iovar set gpioout = [01, 00, 00, 00, 00, 00, 00, 00]   <- LED off
[DEBUG] iovar set gpioout = [01, 00, 00, 00, 01, 00, 00, 00]   <- LED on
```

* `probe-rs verify` reports the flashed image is byte-identical to our ELF.
* The generated default (`DEFMT_LOG = "debug"`) makes cyw43 very chatty (~9 KB in 2.4 s):
  fine over RTT, but HIL failure messages filter it out.

---

## 11. BOOTSEL volumes: both silicon revisions, and a confirmation gate (2026-10-02)

The probe firmware update flow accepted exactly one mount name (`RPI-RP2`) and wrote to
whatever volume it found, without ever reading `INFO_UF2.TXT`. Two problems:

1. **It only worked for RP2040.** The label belongs to the boot ROM's FAT image, so it
   identifies the silicon family: RP2040 → `RPI-RP2`, RP2350 → `RP2350`. A Pico 2 acting as
   a probe was invisible to us.
2. **It could overwrite the wrong board.** Any volume containing `INFO_UF2.TXT` was
   accepted, and the picker offers `debugprobe_on_pico*.uf2` — images whose whole purpose is
   to take over a *plain* Pico. A board sitting in BOOTSEL for its own flashing could be
   written to with no confirmation at all.

What we do now:

* `BOOTSEL_VOLUME_LABELS = ['RPI-RP2', 'RP2350']`, plus a fallback scan of the mount roots
  (`bootselMountParents`) so an unlabelled or renamed mount is still found. Nothing counts
  without `INFO_UF2.TXT` inside, so an ordinary USB stick is never mistaken for a board.
* The volume is identified from `INFO_UF2.TXT` (parsed generically) and cross-checked
  against the chosen image: RP2040 firmware aimed at an RP2350 volume is warned about
  *before* the copy, not after.
* **A human confirms before anything is written**: `host.confirmWrite` is a required part of
  the host interface and shows a modal with the volume path, `Model` and `Board-ID`.

### Facts worth keeping (from the boot ROM sources)

| | RP2040 | RP2350 |
| --- | --- | --- |
| repo | `pico-bootrom-rp2040` | `pico-bootrom-rp2350` |
| volume label | `RPI-RP2` | `RP2350` |
| `INFO_UF2.TXT` | `UF2 Bootloader v3.0` / `Model: Raspberry Pi RP2` / `Board-ID: RPI-RP2` | `UF2 Bootloader v1.1` / `Model: Raspberry Pi RP2350` / `Board-ID: RP2350` |

`INFO_UF2.TXT` contains **no serial number** — the RP2350 template inserts exactly two
strings (`Model`, `Board-ID`) and both can be white-labelled in OTP. A deny-list keyed on a
board's unique id is therefore *not* possible from the volume alone; only a person can say
which board is in BOOTSEL mode. `Board-ID` must never be matched against expected values,
only displayed — hence the tolerant classifier (`volumeSilicon` → `rp2040`/`rp2350`/`unknown`).

### Confirmed on hardware (2026-10-02, Pico 2 W in BOOTSEL)

The label was inferred from the boot ROM before; a real board settled it:

```
>>> BOOTSEL volume found: /media/niel/RP2350
        UF2 Bootloader v1.0
        Model: Raspberry Pi RP2350
        Board-ID: RP2350
```

So the mount really is `/media/<user>/RP2350`, and the `INFO_UF2.TXT` fields are exactly the
`Model`/`Board-ID` pair the parser expects. (Note the bootloader version differs between
the two silicon families — v3.0 on RP2040, v1.0 here on RP2350 — which is another reason
nothing may be matched on those strings.)

---

## 12. Flashing a project with no debug probe (2026-10-02)

A user without a probe needs the other road into flash: hold BOOTSEL, plug in USB, and drop
a `.uf2` onto the mass-storage volume. The extension had no way to produce one, so
`src/flash/uf2.ts` converts the built ELF itself.

### Why not use a tool

* `picotool` (Raspberry Pi's official tool) publishes **no prebuilt Linux binary** —
  release 2.3.1 ships `picotool-2.3.1.tar.gz` (source) only, so a user would need cmake and
  the SDK submodule.
* `elf2uf2-rs` works and accepts `--family`, but it is an extra install step for exactly the
  users who have the least tooling — and it is RP2040-only in its default configuration.
* `probe-rs` cannot emit UF2 at all: `download`/`run` consume images, they never produce one.

### The rule that matters when writing UF2

Blocks go at **`p_paddr`** (the load address), not `p_vaddr`. In our own images these differ:

```
PT_LOAD paddr=0x10045364 vaddr=0x20000000 filesz=0x38   <- .data: stored in flash, copied to RAM
PT_LOAD paddr=0x20000038 vaddr=0x20000038 filesz=0      <- .bss: nothing to write
```

Using the virtual address produces a file the boot ROM accepts and the CPU can never run —
which is why there is a dedicated test for it.

### Family IDs (from the boot ROMs, not from memory)

| id | name | used for |
| --- | --- | --- |
| `0xe48bff56` | `RP2040` | pico, pico W |
| `0xe48bff57` | `RP2XXX_ABSOLUTE` | unpartitioned absolute download; the fallback if `…59` were ever refused |
| `0xe48bff59` | `RP2350_ARM_S` | pico 2, pico 2 W |

`raspberrypi/pico-bootrom-rp2350` (`src/nsboot/usb_virtual_disk.c`) accepts
`ABSOLUTE_FAMILY_ID`..`RP2350_RISCV_FAMILY_ID` (`0x…57`–`0x…5a`) and prints
"RAM downloads only accept ARM_S and RISC-V, DATA, ABSOLUTE" — so the RP2040 family
(`0xe48bff56`), which is what `elf2uf2-rs` emits by default, is **not** valid on an RP2350.

### Verification

* Our output is **byte-for-byte identical** to `elf2uf2-rs` for the same ELF (1108 blocks,
  283 KB image, compared as memory rather than as files; `elf2uf2-rs` was installed only as a
  dev-time oracle).
* **Real silicon accepted the file**: a Pico 2 W in BOOTSEL took `rusty-pico2w-blinky.uf2`
  (family `0xe48bff59`) and rebooted — so the family ID is confirmed, not just plausible.

### Pieces shared with the probe-firmware flow

Finding the volume, reading `INFO_UF2.TXT`, describing the board and the silicon cross-check
now live in `src/flash/bootsel.ts` and are used by *both* flows. It takes a plain cancel
callback instead of a `CancellationToken` so none of it needs `vscode` and all of it is
covered by the t1 layer.

### How it is wired

* `Flash` picks a route from the probe diagnosis (`src/flash/route.ts`, pure and tested):
  `ok` and `chip-not-autodetected` go through the probe — the second one matters, because
  RP235x genuinely cannot be auto-detected and flashing works anyway — and everything else
  goes over USB. The status is **refreshed first**, since the whole decision rests on whether
  a probe is usable right now — with a progress notification, because spawning probe-rs takes
  long enough that a silent pause looks like a stall.
* **One dialog, not two.** There is no separate "the probe is unusable, go over USB?" step:
  the confirmation before the copy already names the board, and it now opens with the reason
  the probe was not used. Nothing happens silently, and nothing has to be clicked twice.
* Converted images land in `dist/` at the project root (`distUf2Path`), not next to the ELF:
  the file has to outlive a `cargo clean`. The generated `.gitignore` gained `/dist` so it is
  not committed either.
* `Flash over USB (BOOTSEL)…` is also a command of its own, so the USB road stays reachable
  with a probe attached — which is how it can be tested without unplugging anything.
* The ELF path is read from `cargo build --release --message-format=json`
  (`src/flash/cargoArtifacts.ts`) rather than assuming `target/<triple>/release/<name>`, so a
  custom `target-dir` or a workspace layout cannot break it.
* Writing is gated on the same confirmation as the probe flow: volume, `Model`, `Board-ID`,
  plus a silicon cross-check against the UF2 family.
* `rustyPlatform.defaultBoard` now lists all four boards. That enum had drifted (only
  `pico`/`pico2`), and `tests/layers/t1-logic/manifest.test.js` now guards both it and the
  command list against the code — an undeclared command is a command nobody can run.
* Trade-off stated to the user in the success message: **no probe means no RTT**, so a
  probe-less flash leaves you with the LED and no `defmt` or panic output.

---

## 13. Wi-Fi verified on hardware (2026-10-02)

The last outstanding runtime check: a generated **wifi** project on the Pico 2 W associates
with the access point and gets a DHCP lease, observed over RTT.

```
▸ t5-hil
  ✓ a generated Raspberry Pi Pico 2 W / wifi project flashes and logs
1 passed, 0 skipped (27837 ms)
```

`t5-hil` only passes when the captured defmt stream contains `Wi-Fi is up`, so this is the real
thing: `control.join(...)` succeeded and `stack.wait_config_up()` returned.

The blinking LED is independent confirmation, and it is worth knowing *why*: in that template the
blink loop sits **after** the DHCP wait, so a blinking CYW43 LED means the entire Wi-Fi path
completed — and that `control.gpio_set(0, …)` really does drive the on-board LED.

### How the credentials were supplied (and a terminal trap)

Credentials are compiled in with `option_env!`, so the HIL run needs them as environment
variables. Typing into an agent-launched terminal does not work here, so the run was started in
a real terminal window — where `x-terminal-emulator` is a trap on Zorin/GNOME 3.52:

* `x-terminal-emulator -e script` resolves to `/usr/bin/gnome-terminal.wrapper`, `-e` is the
  deprecated syntax, and it exits **130 without running the script at all** (so the window, if
  it appears, has nothing behind it). Use `gnome-terminal -- script`.
* Swallowing the launcher's stderr (`>/dev/null`) hid that for one round trip. Keep it.
* The prompt echoes the SSID and prints a character count for both fields, so a silent
  `read -s` cannot be mistaken for input that was rejected.

---

## 14. crates.io Library Manager (Phase 3) — done 2026-10-03

Two commands and one view:

* `rustyPlatform.addDependency` — a QuickPick over the bundled catalogue, live sparse-index search
  for anything else, a version pick, then an edit of `Cargo.toml`.
* `rustyPlatform.revealDependency` — jump to that line in `Cargo.toml`.
* A **Dependencies** group in the Project view, refreshed by a `Cargo.toml` watcher.

Layout: `src/library/{catalog,registry,cargoToml}.ts` (all `vscode`-free, so t1 tests them) plus a
thin `src/commands/libraryCommands.ts`. Dependencies are added by editing the manifest with our own
pure editor — never `cargo add` — and a version the project already pins is never changed.

Two facts the catalogue depends on, both of which cost time to learn:

* The sparse index publishes **features in two places**: `features` and `features2`. Reading only
  `.features` misses `time-driver`, `defmt`, `executor-*` and `binary-info`.
* Merging those is still not enough: every *optional dependency's* key is also a feature name, minus
  the ones suppressed by `dep:<name>` in some feature. `cargo metadata` is the cheap oracle for the
  result — it exits 101 on a feature name that does not exist.

Verified with a real `cargo check --release` (16.2 s, clean) and a negative control (a made-up
feature name is rejected by `cargo metadata`).

Catalogue caveat: `pio` / `pio-proc` 0.4 would give a second copy of `pio` next to embassy-rp's 0.3.

---

## 15. The RP2350 `_stext` alignment trap (2026-10-03)

`rust-lld` warned on every RP2350 link:

```
rust-lld: address (0x1000013c) of section .text is not a multiple of alignment (8)
```

Cause: cortex-m-rt's `link.x` writes

```
PROVIDE(_stext = ALIGN(ADDR(.vector_table) + SIZEOF(.vector_table), ALIGNOF(.text)));
```

but `PROVIDE` only supplies a value for a symbol that is *undeclared*. memory.x assigned `_stext`
itself, so the plain assignment won and threw the ALIGN away.

Measured on a real Pico 2 W project: `.vector_table` at 0x10000000 / 0x114 bytes, `.start_block` at
0x10000114 / 0x28 → `.text` landed on 0x1000013c with alignment 8.

Fix in the generator:
`_stext = ALIGN(ADDR(.start_block) + SIZEOF(.start_block), ALIGNOF(.text));`
→ `.text` is 0x10000140, `.start_block` is byte-identical (the boot header did not move) and the
warning is gone in dev and release. Embassy's own RP2350 example has the same unaligned line, so the
warning shows up there too.

---

## 16. `cargo: command not found`, and the probe-rs nag (2026-10-03)

Two environment problems that both look like extension bugs:

* **rustup installed with `--no-modify-path`** writes nothing into the login profile, so
  `~/.cargo/bin` is on *no* PATH — not the desktop session's and, because our terminals were created
  without an env, not theirs either. Fixed on both sides: every terminal and spawn goes through
  `augmentedEnv()` (`src/util/exec.ts`), and `rustyPlatform.fixShellPath` ("Add Cargo to PATH…")
  appends an idempotent guarded block to the login profile after taking a `.bak`. "Check Toolchain"
  now reports "cargo is not on this shell's PATH" with a button that fixes it.
* **`probe-rs.probe-rs-debugger` decides whether probe-rs is installed by scanning PATH** (a
  `Promise.any` over PATH × PATHEXT, no settings). Its "probe-rs doesn't seem to be installed, do you
  want to install it automatically now?" toast therefore appears even when our detection has already
  found the binary in `~/.cargo/bin`. Fix on this machine: symlinks in `~/.local/bin`, which *is* on
  the GUI PATH. Do not accept that toast's install offer.

---

## 17. Debug, Debug Stop, and the first real DAP session (2026-10-03)

`rustyPlatform.debug` finds the `probe-rs*` entry in `.vscode/launch.json`, offers to install
`probe-rs.probe-rs-debugger` when it is missing, runs `cargo build` as a real task (so the compiler
output is visible and the exit code can be awaited), then starts the session.
`src/project/launchConfig.ts` holds the jsonc-tolerant reader and the search;
`src/project/debugSessions.ts` holds the session bookkeeping.

The status bar gained **Debug Stop** next to Debug. It is hidden unless a probe-rs session is
running, and it never touches another debugger's session (a Python or C++ session is not ours).

Trap: **`vscode.debug.sessions` does not exist** — `@types/vscode` 1.140 has only
`activeDebugSession`. The running list is maintained from `onDidStartDebugSession` /
`onDidTerminateDebugSession`, while the *choice* (`pickProbeRsSession`) stays in the `vscode`-free
`launchConfig` module so t1 can test it.

First real session, Pico 2 W through the Debug Probe:

```
probe-rs-debug: Starting probe-rs as a DAP Protocol server
probe-rs-debug: Listening for requests on port 33799
Core is running
probe-rs-debug: Opened a new RTT Terminal window named: defmt
probe-rs-debug: RTT Window opened, and ready to receive RTT data on channel 0
```

RTT is switched on by `coreConfigs[0].rttEnabled`, which the installed 0.32.0 schema does declare
(alongside `rttChannelFormats`).

### Two things the first `launch.json` got wrong (2026-10-03)

* **`flashingConfig.flashingEnabled` defaults to `false`.** The generated config never set it, so a
  Debug session *attached* to whatever was on the chip — usually the release image left behind by
  the Flash button — while decoding RTT with the **debug** ELF. defmt then resolved the frames
  against the wrong string table, which is what produced `associated to Unwrap of a None option
  value` and DHCP lines that could not have come from the running build (§19). Every generated
  launch configuration now sets `flashingEnabled: true`.
* **Nothing asked the core to stop**, so "Core is running" was the entire story: probe-rs-debugger
  halts only for a breakpoint, `flashingConfig.haltAfterReset`, or a caught fault. Each project now
  ships **four** configurations, documented in its README - §24 has the measurements behind the last
  two:

  | Configuration | Flashes? | Resets? | Stops when |
  |---|---|---|---|
  | `Flash & Debug` | yes | yes | at your breakpoints |
  | `Flash & Halt at Reset` | yes | yes | on the reset vector, before any user code |
  | `Restart & Debug, no flashing` | **no** | yes | at your breakpoints, anywhere - a `launch` with `flashingEnabled: false` |
  | `Attach - keeps it running` | **no** | **no** | only in code that runs again (a loop, an interrupt) |

  **Every configuration uses the debug build — Grumpy's rule, 2026-10-03:** *"When clicking on the
  'Debug' button, the user expects the system to run a debug build so that break points can be set
  at will. There must be no options."* The flash-or-not choice stays (that was asked for separately),
  but a build choice does not: a release image is optimised, so lines are merged or removed and
  breakpoints there show up hollow. The release attach entry that existed for one afternoon is gone,
  and t1 now fails if any generated configuration names a release binary.

  Attaching is the risky route, so the Debug command remembers which build was last written
  (`context.workspaceState`, key `rustyPlatform.lastFlashedProfile` - both flash routes record
  `FLASH_PROFILE`, a flashing Debug session records `debug`), marks a no-flash entry "matches the
  last flash" when it does, says "the chip holds the release build" when it does not, and - since
  §23 - asks `probe-rs verify` what the chip actually holds rather than trusting that bookkeeping.
* **Breakpoint budget - measured 2026-10-03 (§27).** The RPi Debug Probe has no limit of its own; the
  ceiling is the target's FPB. On this bench that is **8** for the Pico 2 W (RP2350, confirmed both by
  the chip's `FP_CTRL` and by the debugger refusing a 9th with "No available hardware breakpoints"),
  and **4** for an RP2040 (documented, not measurable here). Grumpy's expectation of three is
  comfortably inside both. Beyond the limit the extra breakpoints stay hollow in VS Code.

  The attach configuration uses `request: "attach"`, which has no `flashingConfig` property at all
  — it never writes to the chip, so the ELF must be the one the firmware was built from.
* The **Debug button asks** when there is a choice: one configuration starts silently, several
  produce a QuickPick with the flashing one first, so Enter keeps the one-click behaviour and
  "no flashing" is a keystroke away. `debugConfigurationChoices()` (in `launchConfig.ts`) builds the
  entries and their one-line descriptions, and t1 asserts the four generated ones stay distinct and
  truthful - including that the attach entry never promises to bind a line that has already run.
* Refreshing a generated file into an existing project has to use that project's real name:
  `launch.json` embeds the binary name in `programBinary`, and a scratch name (`my-app`) slipped into
  Grumpy's project for a few minutes on 2026-10-03. `src/main.rs` is name-independent.

---

## 18. Wi-Fi credentials: ask the user instead of documenting an env var (2026-10-03)

Until today the only way to build a wireless template was to export `WIFI_SSID` / `WIFI_PASSWORD`
yourself. That is fine in a terminal and useless for the buttons: the VS Code build has no such
environment, so pressing Flash/Debug compiled the **placeholder** image — one that cannot join and
says nothing about why. (It is also what made one RTT log look like two firmwares; see §19.)

Now **Flash** and **Debug** ask, the first time only:

| Box | Notes |
|---|---|
| Network name (SSID) | `validateInput` refuses an empty name |
| Password | masked input; empty means an open network |
| Fixed IP address | optional, `192.168.1.50/24`; empty selects DHCP |
| Router address | asked only when a fixed address was given |

Design points worth keeping:

* Stored in **`context.secrets`** (the editor keyring) — not in settings, not in the project. The
  generated `.cargo/config.toml` deliberately carries no credentials.
* The values only ever become environment variables of the cargo process; nothing is written to disk
  by the prompt.
* Validation mirrors the firmware's own parser (`static_config()` in the generator): a missing
  prefix, `/33`, an octet above 255 or a leading zero such as `010.0.0.1` are all refused, because
  the firmware would otherwise fall back to DHCP silently.
* Terminals are keyed on the environment *version*, so a terminal created before the prompt is never
  reused for a build after it — and a no-op `setActiveWifiEnv({})` does not spawn a new one.
* A wired project is never asked and gets its environment cleared; the test is
  `option_env!("WIFI_SSID")` in `src/main.rs`.
* Cancelling is allowed: a warning offers "Enter credentials" or "Flash anyway".

Files: `src/wifi/credentials.ts` (pure) and `src/wifi/wifiPrompt.ts` (keyring + prompts), plus
`src/commands/wifiCommands.ts` for "Set Wi-Fi Credentials…" and "Clear Wi-Fi Credentials".

The templates were updated to match: the generated README and the `src/main.rs` comment now name the
prompt first and keep the terminal route as the alternative. t1 fails if the README stops mentioning
the prompt, the keyring or the fixed-address option, and it also asserts that **every** variable the
extension exports really is read by the template.

---

## 19. The DHCP verdict on the bench, and the two-firmware log trap (2026-10-03)

A wifi template on the Pico 2 W joined the access point and then never got a lease. The RTT lines,
attributed by reading the vendored sources:

| line | source | meaning |
|---|---|---|
| `JOIN failed: network not found` / `JOINED` | cyw43 `control.rs:435` / `:433` | one join attempt failed, the retry worked |
| `using default T1 and T2 values …` | smoltcp `dhcpv4.rs:542` | an ACK *was* parsed; its T1/T2 options were invalid |
| `DHCP ignoring OFFER because your_ip is not unicast` | smoltcp `dhcpv4.rs:370` | in `Discovering`, the OFFER's `yiaddr` was not a unicast address |
| `DHCP ignoring ACK because your_ip is not unicast` | smoltcp `dhcpv4.rs:466` | the same for the ACK in `Requesting` |
| `DHCP request retries exceeded, restarting discovery` | `dhcpv4.rs:646` | five REQUEST retries with backoff, exhausted |
| `DHCP lease expired` | `dhcpv4.rs:673` | an earlier lease ran out |
| `failed to transmit IP: device exhausted` | smoltcp `iface/interface/mod.rs:725` | the CYW43 had no free TX buffer; one packet dropped |
| `arp: unknown operation code` | smoltcp `iface/interface/ipv4.rs:278` | benign dropped traffic |
| `bluetooth setup interrupt mask` | cyw43 `runner.rs:308` | only reachable when BT firmware was handed in (`bt_fw.is_some()`) |

**Verdict, corrected 2026-10-03 after a packet capture: the router is not at fault.** With
`tcpdump -i eno1 -n -vvv 'udp port 67 or udp port 68'` running while the board retried, the client's
own frames told the story:

```
0.0.0.0.68 > 255.255.255.255.67  BOOTP/DHCP, Request … Flags [none] (0x0000)
  DHCP-Message (53): Discover
0.0.0.0.68 > 255.255.255.255.67  BOOTP/DHCP, Request … Flags [none] (0x0000)
  DHCP-Message (53): Request
  Server-ID (54): 192.168.11.1
  Requested-IP (50): 192.168.11.46
```

smoltcp can only name `Server-ID` and `Requested-IP` in a REQUEST if it read them from a **valid
OFFER with a unicast `yiaddr`** — so the router offered a proper address, and the
"ignoring OFFER because your_ip is not unicast" line was replay from the older image (§2.8), not this
network. Grumpy's own evidence pointed the same way: the same boards get leases on this router under
PlatformIO/lwIP.

The exchange dies *after* our REQUEST. The capture also shows that our DISCOVER/REQUEST carry
`Flags [none]` — smoltcp hardcodes `broadcast: false` (`smoltcp-0.13.1/src/socket/dhcpv4.rs:588`), so
it never asks for broadcast replies, and a unicast reply to a not-yet-configured address is invisible
on the wired segment.

**Resolved the same day.** Running the image ourselves instead of reading the editor's console
(`probe-rs run --chip RP235x <release elf>`) shows the whole exchange completing:

```
[INFO ] === my-blinky-pico2w 0.1.0 starting ===
[INFO ] joining Wi-Fi...
[DEBUG] JOIN failed: status=1        (the first attempt after a fresh scan)
[DEBUG] JOINED
[INFO ] associated to GK_4440
[INFO ] waiting for DHCP...
[DEBUG] DHCP send DISCOVER to 255.255.255.255 …
[DEBUG] DHCP recv Offer from 192.168.11.1: … your_ip: 192.168.11.46 …
[DEBUG] DHCP send request to 255.255.255.255: … requested_ip: Some(192.168.11.46) …
[DEBUG] DHCP recv Ack from 192.168.11.1: … your_ip: 192.168.11.46, lease_duration: Some(172800)
[INFO ] Wi-Fi is up - IP 192.168.11.46
```

So DHCP works on this network, the router offered a unicast address and the client accepted it. The
"failure" was never real: those lines came from the editor's console, which replays old frames and
decodes them against a newer ELF — the same mechanism that printed
`associated to Unwrap of a None option value`. **A stale frame decoded with the wrong string table
produces plausible-looking log text**, which is what made this look like a DHCP fault for an
afternoon.

Lesson, and the reason every generated firmware now logs a boot marker as its first line: read a
device log from a run you started, not from a console that persists between runs. `probe-rs run <elf>`
gives that; the editor's RTT terminal does not.

The template still gained a way past DHCP: the wait is bounded
(`with_timeout(30 s, wait_config_up())` in a retry loop), the association is logged, and
`WIFI_STATIC_IP` is the escape hatch — now a field in the credential prompt. The warning message
itself was made factual: it no longer blames the DHCP pool, a second server or the 2.4 GHz band.

**The trap that made the log unreadable: one terminal, two firmwares.** The panel showed
`bluetooth setup interrupt mask` although the Wi-Fi-only build cannot emit it; `DHCP …` lines next to
`using a static IP …` although a static build never constructs a DHCP socket; and our own `[INFO]`
lines in the reverse of the order they appear in `main.rs`. Two reasons:

1. The VS Code build had no `WIFI_*` (fixed in §18), so the buttons compiled a different image than
   the terminal command did — two binaries alternating on one board.
2. The RTT ring buffer and the RTT terminal are not cleared by a reset, so the previous image's bytes
   are replayed at the start of the next session.

Lesson: judge a run only from lines after a fresh boot marker, and never compare logs produced by two
different build environments.

---

## 20. Bench hygiene: serial numbers, not port numbers (2026-10-03)

Not extension code, but it explains the day's port confusion.

`/dev/ttyACM*` is assigned in enumeration order, so the Debug Probe took `ttyACM0` during a probe-rs
session and the Pico moved to `ttyACM1`. The DataSafe companion app then reported "Access to the port
'/dev/ttyACM1' is denied … add your user to the 'dialout' group" — a red herring twice over: the user
*is* in `dialout`, and the real error is `EBUSY` (a second instance of the app held the port), which
.NET surfaces as `UnauthorizedAccessException`. Verified with a throwaway .NET program: free port →
OPEN OK, held port → "Access … is denied".

Fixes made:

* `/etc/udev/rules.d/99-datasafe-pico.rules` creates `/dev/datasafe` for any `2e8a:000a`, with
  `ID_MM_DEVICE_IGNORE` because ModemManager is active on this machine. It deliberately has no
  `ACTION` test, so `udevadm trigger` applies it to a board that is already plugged in. The alias
  followed the board across a reboot while the ACM numbers changed around it.
* Our own test sessions use **RTT only** and never open a serial port, so neither the board nor the
  probe's UART can be disturbed by them.

---

## 21. "USB permissions: MISSING" was not true (2026-10-03)

Grumpy pasted a Check Toolchain run that ended in `udev rules: MISSING` — on a bench that had been
flashing all day. The probe was never permission-blocked; the **check** only looked for its own two
file names:

```ts
const UDEV_RULE_PATHS = ['/etc/udev/rules.d/69-probe-rs.rules', '/etc/udev/rules.d/99-probe-rs.rules'];
```

This bench is permissioned by Raspberry Pi's own installer instead:

```
/etc/udev/rules.d/99-picoprobe.rules
SUBSYSTEM=="usb", ATTRS{idVendor}=="2e8a", ATTRS{idProduct}=="000c", MODE="0666"
```

Two signals replace it, because a file name is the wrong question:

* **Scan the rules.** `readUdevRules()` reads every `*.rules` in `/etc/udev/rules.d`, and a line
  counts only when it names a probe vendor (`PROBE_USB_VENDORS` — kept in step with
  `UDEV_RULES_CONTENT` by a t1 test in both directions) *and* grants access (`MODE`/`GROUP`/`OWNER`/
  `TAG+=`). Skipped on the way: commented-out lines, and lines scoped to another subsystem — the
  DataSafe alias names `2e8a` with `MODE="0660"` but is `SUBSYSTEM=="tty"`, and no debugger opens the
  serial port.
* **Ask the probe.** `probePermissionsWork()`: `ok`, `chip-not-autodetected`, `firmware-outdated` and
  `no-target` are all reached only after the USB device was opened, so they *prove* permissions —
  whatever the files say. Only `permission-denied`, `none-connected` and `unknown` keep the warning.

Measured after the change: the real scan flags exactly `99-picoprobe.rules`, and the check prints
`usb permissions: ok` (the wording moved with the meaning — it was never about a file). The Project
view row says `probe access granted` / `no rule for a probe`, with a tooltip naming the source.

---

## 22. The same buttons in the side bar (2026-10-03)

The status bar controls were duplicated into a new **Controls** view (`rustyPlatform.controls`,
first in the activity-bar container) — but not as a copy: `src/ui/controls.ts` holds the list once
(`CONTROLS`, `statusBarText`, `visibleControls`, `healthSummary`) and both renderers use it, so they
cannot drift. `StatusBarView` keeps its priorities (100 → 94); the tree adds the icon, the one-line
detail and the tooltip. **Stop** is still the only entry that hides itself, and now it hides in both
places, from the same `activeProbeRsSession()` call.

The health row kept its live behaviour: `healthSummary(status)` returns the caption, the version
line and the tooltip markdown for all three states (detecting / ready / setup needed), and the tree
redraws on a toolchain change and on debug-session start/terminate.

---

## 23. "Is the chip running this build?" (2026-10-03)

`probe-rs verify` compares the chip's flash with the loadable parts of an ELF, so it is the honest
pre-flight for a session that will not write the chip. Three things worth keeping:

* **Its exit code is useless.** 0.32.0 exits `0` for both `Verification successful` and
  `Verification failed: contents do not match` (measured: `$?` = 0 either way), so the verdict is
  parsed from the **text** (`classifyVerifyOutput`). Trusting the code would have passed every stale
  chip.
* **The cost is lopsided.** A *failed* check stops at the first differing byte (~0.4 s here); a
  *successful* one reads the whole image (~10.5 s at the probe's default clock — `--speed 16000`
  takes 3.6 s, deliberately not used by default).
* **`unknown` is not a verdict.** Probe busy, probe absent, binary not built: none of that is
  evidence the chip is wrong, so those are reported (output channel + a non-modal warning) and the
  session proceeds.

A mismatch opens one modal naming the file compared, probe-rs's own words, and the two ways out
(`Flash & Debug instead`, `Debug anyway`). `src/project/chipCheck.ts` is `vscode`-free and t1-tested
against the two output strings copied verbatim from the bench.

---

## 24. Attach vs Restart: what a no-flash session can bind (2026-10-03)

> *"The attach debug option does not bind to breakpoints that was set in the IDE prior to starting
> the debug session."*

Half of that is wrong, and the measurement tells you which half. Driving `probe-rs dap-server`
directly (`initialize → attach → setBreakpoints → configurationDone`, in
`tests/tools/dap-session.js`) against Grumpy's own `launch.json`:

| Pre-set breakpoint | `verified` | Stops? |
|---|---|---|
| `main.rs:190` (blink loop, every 250 ms) | true | **yes, immediately** |
| `main.rs:92` (boot banner, runs once) | true | never |
| `main.rs:146` (Wi-Fi join, runs once) | true | never |

An attach session *does* program the breakpoint — it just cannot reach code that has already run,
and upstream `configuration.rs` **rejects** `flashing_enabled`, `halt_after_reset` and friends for an
`attach` request outright ("do not use … with attach"), so nothing can bring that code back. Worse,
the gutter draws those breakpoints solid, because `verified: true` only means the source line
resolved to an address — never that it will fire.

A `launch` with `flashingConfig.flashingEnabled: false` writes nothing and still **resets** the
target, which is exactly what lets a breakpoint in `main` or in startup code bind. Hence the fourth
generated entry, and the detail lines that now say which is which:

| Configuration | Flashes? | Resets? | Stops when |
|---|---|---|---|
| `Flash & Debug` | yes | yes | at your breakpoints |
| `Flash & Halt at Reset` | yes | yes | on the reset vector |
| `Restart & Debug, no flashing` | no | yes | at your breakpoints, anywhere |
| `Attach - keeps it running` | no | no | only in code that runs again |

The tool that produced those numbers is in the repo, so the next question of this kind is answered by
running something rather than by reasoning:

```sh
npm run dap-session -- --project <dir> [--config "<name>"] [--line 92 --line 190 …] [--as launch] [--flash]
```

Exit codes: `0` a breakpoint fired, `1` programmed but nothing fired, `2` the session could not run.
It never writes the chip unless `--flash` is given, and `--as attach --flash` is refused up front
with the same reason probe-rs gives. `--line` repeats, which is how §27 was measured.

---

## 25. A flash must let go of the probe (2026-10-03)

> *"The debug probe is not released after flashing. A subsequent debug session does not find the
> probe."*

Flash ran `cargo run --release`, whose runner is `probe-rs run`: it flashes and then **stays
attached** to stream defmt over RTT, so the USB device stayed claimed. Measured while one was
running:

```
$ fuser -v /dev/bus/usb/001/015
/dev/bus/usb/001/015:  niel  62486 F.... probe-rs        ← 2m24s into a "flash"
$ probe-rs list
[0]: Debug Probe (CMSIS-DAP) -- 2e8a:000c-0:E6614103E74B072F   ← found …
$ probe-rs info
    0: The debug probe could not be created.
    1: The selected USB device could not be opened.             ← … but not openable
```

That last message is what the next session hit, and it reads like a dead probe. The fix is a
one-shot write — `cargo build` → `probe-rs download --chip X <elf>` → `probe-rs reset --chip X` — so
`src/flash/probeFlash.ts` builds the command and t1 pins it to never contain `run` or `attach`.
Verified: nothing holds the device after a flash, and a debug session opens it immediately. Monitor
(`probe-rs attach`) still holds the probe **by design**, and now says so.

Two things came out of the same hole:

* `classifyProbeError` gained `probe-busy`, so "the device could not be opened" names the holders
  instead of being filed as `unknown`, and Flash offers **Stop it and flash** when a probe-rs session
  is running.
* `buildReleaseElf` had never received `activeWifiEnv()`, so the **USB/UF2 route built images with
  placeholder credentials**. Both routes now build with
  `augmentedEnv({ ...activeWifiEnv(), ...defmtEnv() })`.

---

## 26. One profile for both buttons — the mismatch circle (2026-10-03)

> *"I built my test project, then flashed it successfully. Then I click Debug with option
> Restart & Debug. Instead of starting the debug session I get the message that the chip is not
> running the build. This is not correct as I have just flashed the latest build. Dig deeper please,
> we are going around in circles."*

The check was telling the truth:

```
$ probe-rs verify …/release/my-blinky-pico2w      → Verification successful   ← what Flash wrote
$ probe-rs verify …/debug/my-blinky-pico2w        → Verification failed       ← what Debug loads
```

The design was the bug. Flash wrote `release`; every debug configuration loads `debug` (Grumpy's
rule, §17), so **every** Flash followed by a no-flash Debug session mismatched *by construction* —
permanent, not a fault. The tell-tale sign was in the bookkeeping: `LAST_FLASHED_KEY` was always
`release`, which made the picker's "matches the last flash" description **unreachable**. The code's
intent was always "Flash writes what Debug loads"; removing the release debug entries a few hours
earlier had broken that agreement.

Fix: `src/flash/profile.ts` → `FLASH_PROFILE = 'debug'`, used by the probe route, the USB route
(`UsbFlashOptions.profile`) and `LAST_FLASHED_KEY`. The Debug build task now builds with the same
environment, so the two cannot differ over a `DEFMT_LOG` either. Verified end to end: build → flash
→ `verify` = successful → `Restart & Debug` fired a startup breakpoint at `0x1001B7B4`.

t1 pins the invariant: every generated `programBinary` must contain `/${FLASH_PROFILE}/`, so this
cannot come back. The cost, stated plainly in §4 item 10: the optimised release image is no longer
reachable from the UI.

---

## 27. The breakpoint budget, measured (2026-10-03)

The Debug Probe has no breakpoint limit of its own — it is CMSIS-DAP transport, and every breakpoint
probe-rs sets is programmed into the **target's** FPB. So the same probe gives 8 on a Pico 2 W and 4
on a Pico. Two independent measurements for the Pico 2 W:

```
$ probe-rs read b32 0xE0002000 1 --chip RP235x
e0002000: 10000081          bit 28 = FPB version 1, NUM_CODE[7:4] = 8 comparators

$ npm run dap-session -- --config "Restart" --line 92 --line 128 … --line 190      # 12 of them
… 8 programmed …
NOT SET line 166 - No available hardware breakpoints
8 of 12 breakpoints programmed
```

`No available hardware breakpoints` is the string VS Code shows on a hollow breakpoint's hover, so
that is the user-visible face of the limit. Practical consequences: conditional breakpoints and
logpoints each cost one comparator; code in flash cannot use software breakpoints (probe-rs calls
`set_hw_breakpoint`); **stepping uses a temporary breakpoint** — the adapter's own source says *"our
implementation of stepping uses breakpoints and results in a 'BreakPoint' halt reason"* — so leave
one spare if you intend to step; watchpoints are a different unit (DWT) and do not count.

---

## 28. The ESP32 family: three boards, and where every pin came from (2026-10-03)

Grumpy's boards: **ESP32-DevKitC V4** (Espressif), **T-QT** (LilyGo, ESP32-S3) and a **320x480 CYD**
with an ESP32-WROOM-32U — the 3.5" `ESP32-3248S035` class, not the well-known 2.8" ILI9341 one.
Five questions were asked before any code was written (panel revision, CYD variant, Debug behaviour,
PSRAM, monitor format), because three of those change the bytes we generate.

Pins were taken from primary sources, never from memory — a wrong pin map compiles and shows a black
screen:

| Board | Source | What it settled |
|---|---|---|
| DevKitC V4 | Espressif user guide (`esp32-devkitc/user_guide.html`) | **no user LED exists** (only a 5 V power LED) → the template drives an *offered* GPIO4 and says so |
| T-QT | `Xinyuan-LilyGO/T-QT`: `board/esp32-s3-t-qt-pro.json`, `extras/Setup211_LilyGo_T_QT_Pro_S3.h` | MOSI 2 · SCLK 3 · CS 5 · DC 6 · RST 1 · BL 10 (**active low**) · 128x128 · 4 MB QD flash, no PSRAM |
| CYD | `rzeldent/platformio-espressif32-sunton` board JSON + the schematic PDF | ST7796: MOSI 13 · MISO 12 · SCLK 14 · CS 15 · DC 2 · **no reset pin** · BL 27; XPT2046 CS 33 / IRQ 36; **microSD CS 5 · CLK 18 · MOSI 19** |

Two things that only reading the sources revealed:

* The T-QT ships **two panel revisions under one name** (LilyGo's own README: copy
  `extras/old_panel/*` or `extras/new_panel/*` over the TFT driver). Both are GC9A01-family silicon
  with different init tables, and the only marking is a sticker. So "which panel" became a
  first-class `BoardOption`, the answer became a **cargo feature** (`panel-gc9107` / `panel-gc9a01`)
  — which is exactly what LilyGo's instructions do by hand — and the wizard asks, because Grumpy's
  tag was unreadable.
* The CYD schematic has only **three** TF nets (CS/CLK/MOSI): the card is meant to share the panel's
  MISO on GPIO12. `pdftotext` on the schematic PDF gave the net names; the community board
  definition agrees.
* mipidsi 0.10 turns out to ship `GC9107`, `GC9A01` **and** `ST7796`, so every panel here maps onto
  a stock model — no hand-written init sequences.

## 29. The toolchain decision: what actually builds Xtensa (2026-10-03)

The whole stack hinged on one question: which Rust version Espressif's fork provides, because
esp-hal 1.2 needs 1.95 while 1.0/1.1 need 1.88.

* The fork is **`esp-rs/rust-build`** (not `esp-rs/rust`, whose latest tag is an unrelated 2020
  artefact) and it is at **v1.99.0.0** — so the current esp-hal line is usable and there is no MSRV
  trap. Installed by espup under the rustup channel name **`esp`**.
* The canonical project shape is **`esp-rs/esp-generate` → `template/`**. Mirroring it is why the
  generated projects should compile: esp-hal `~1.2.2` (feature = chip name), **esp-rtos 0.4** for
  both Embassy *and* esp-radio, `esp-bootloader-esp-idf` (the `esp_app_desc!()` the bootloader
  demands), `esp-println` + `esp-backtrace`, `runner = "espflash flash --monitor --chip <chip>"`,
  `rustflags = ["-C", "link-arg=-nostartfiles"]`, `[unstable] build-std = ["core"]`, and
  `#[esp_rtos::main]` rather than `#[esp_hal::main]`.
* Version-specific API facts, read from the source rather than assumed: **`Output::new(pin, level,
  config)` takes three arguments**; `Spi::new(spi, config)?` returns a `Result` and then chains
  `.with_sck/.with_mosi/.with_miso/.with_cs`; `spi::master::Config::default()
  .with_frequency(Rate::from_mhz(n))`; `esp_hal::delay::Delay` is a **unit struct**.
* `espflash` was verified the same way: subcommands `flash` / `monitor`, shared args carrying
  `--chip`, `--port` (`-p`, env `ESPFLASH_PORT`) and `--non-interactive`.

## 30. One board model, two silicon families — and what the compiler caught (2026-10-03)

`McuFamily` went from `'RP2040' | 'RP2350'` to a four-value union and `BoardProfile` became a
**discriminated union** (`RpBoardProfile` | `EspBoardProfile`) with `isRpBoard` / `isEspBoard` /
`chipNameOf`. That produced **42 compile errors in 6 files**, which is the point: the compiler, not
a comment, enumerates every place a Pico assumption lived.

Three lessons from doing it:

* **The compiler found the loud ones, not the dangerous ones.** `uf2.ts` and `bootsel.ts` kept
  compiling while silently mapping *any* family to an RP2350 UF2 family — the ESP boards would have
  been handed a UF2 family id they can never use. Narrowing their parameters to `RpFamily` closed
  it. A union is only as good as the signatures hanging off it.
* **A shared "all targets" list is a trap.** `allTargets()` now contains the two Xtensa triples, and
  the rustup-based install plan promptly tried to `rustup target add` them — which is impossible;
  they only exist in Espressif's fork. Hence `rpTargets()` / `espTargets()`, and only the RP list
  reaches rustup.
* **The tests were the real specification.** 22 of them failed on the new boards because they
  iterated every board and asserted RP facts. They are now explicitly family-scoped
  (`tests/lib/boards.js`: `rpBoards()` / `espBoards()` / `panelBoards()`), and scoping them is what
  exposed that `package.json` never listed the new boards in `rustyPlatform.defaultBoard`.

## 31. Generated-code traps that only *reading* the output finds (2026-10-03)

Three defects shipped into the generator and were caught by printing the generated project, not by
trusting the template:

1. **`Output::new(peripherals.GPIO4, Level::Low)`** — two arguments. esp-hal 1.2 takes three
   (`pin, initial_level, config`), so the DevKitC blinky could not have compiled.
2. The panel template called `SPIInterface::new(...)` **without importing it** — every symbol a
   template uses must also be in its `use` list.
3. `Sunton ESP32-3248S035R (3.5" CYD)` is the board's *name*, and pasting it into `log::info!`
   produced Rust that cannot compile. Fixed with a `rustString()` escape, and pinned by a test that
   walks every generated `.rs` line and refuses an unescaped name outside a comment.

Also worth remembering: a *test* caught a design smell in `espToolchainSummary`, which trusted a
`ready` flag instead of deriving from the facts — it printed `missing: ` with nothing after it. The
summary now asks the same function that decides readiness.

## 32. Installing the Xtensa toolchain from the extension (2026-10-03)

Grumpy's requirement: *"I need the extension to install the toolchain etc when an esp32 project is
first created."* So the offer happens right after the project files are written, and it names what is
missing — four distinct states (`espup`, `toolchain`, `export-esp.sh`, `espflash`), because "espup is
missing" and "espup ran but the toolchain download never happened" need different advice.

* The plan is ordered and minimal: `cargo install espup --locked` → `espup install --targets
  esp32,esp32s3` (**only the chips the catalog's boards need**) → `cargo install espflash --locked`,
  run as one visible terminal line.
* **`export-esp.sh` is read, never sourced**: a terminal's `source` cannot reach the extension host,
  so `espEnv()` parses the file and merges its variables into every build, flash, monitor and
  terminal we start. Without that, installing the toolchain would still leave `cargo build` unable
  to find the Xtensa linker. A terminal's identity now includes whether that file exists, so a shell
  created before the install is not reused afterwards.
* `Check Toolchain` reports the ESP line but never as a *problem* — an RP-only setup does not need
  Xtensa and must not be nagged about it.
* The install path is covered by tests with fake `espup`/`espflash` shims, but **the real download
  has not been run on this machine**; `cargo install espup --locked` compiles espup rather than
  fetching Espressif's prebuilt binary, because we have no pinned SHA-256 for that asset.

## 33. Flash and Monitor over USB serial, and the port nobody may touch (2026-10-03)

An ESP has no SWD, so this is not the RP "no probe" fallback: the route is decided by the **board**
(`usesSerialFlash`) before any probe is diagnosed, and no probe scan is run at all.

* **Flash is one-shot** (`espflash flash --chip <chip> ["--port" <p>] <elf>`) — it exits, so the port
  comes back. **Monitor holds it on purpose** (`espflash monitor`), which is the ESP twin of the
  probe-busy trap: a flash now offers to close the `Rusty: monitor` terminal first, rather than
  letting the user meet "could not open port" and read it as a hardware fault.
* **Debug** on an ESP board explains there are no breakpoints (JTAG only) and runs flash + monitor
  chained in one terminal, so the log starts only after a successful write.
* **The port picker refuses Raspberry Pi boards.** `/dev/serial/by-id` names are matched on text
  *and* vendor id (303a Espressif, 10c4 Silicon Labs, **1a86** WCH/CH340, 0403 FTDI), and
  `2e8a`/`Raspberry_Pi_Pico` is excluded outright — the bench Pico on `/dev/ttyACM0` must never be
  written to. The CH340 case is why the vendor id matters: it appears as `usb-1a86_USB_Serial-…`,
  with "CH340" nowhere in the name. One candidate → passed explicitly (so espflash stays
  non-interactive); several → espflash asks.
* `buildElf` needed no change for Xtensa: it parses cargo's JSON messages, so the artefact path is
  found the same way for both families.
* New settings: `rustyPlatform.espflashPath`, `rustyPlatform.serialPort`.

### Still open after this session

* **The ESP firmware has never been compiled**, let alone flashed: everything is verified against
  the vendor scaffolding, the crates' published APIs and `espflash`'s source. The first real build
  is the next thing to do, and it is also what would close the last API uncertainties
  (`Delay` as a unit struct, `OutputConfig::default()`, `DrawTarget::clear` against mipidsi's
  `Rgb565`).
* No `wifi` template for ESP — the wizard offers only implemented templates.
* The touch controller and the microSD socket are described but unused by any template.
* Tagged **v0.0.2** (2026-10-03); `CHANGELOG.md` and `LICENSE` were still untracked before it, so
  this tag also publishes them for the first time.





## 34. The AI coding assist, ported from the Avalonia Designer (2026-10-03)

Asked, in one line: *"In this extension I have bundled an AI Assistant. I want to add that component to this
project as well. This will allow ai coding assistance to the projects that the Rusty Platform extension
creates."* The source is `~/Projekte/Avalonia/DesignerCS_Ext/avalonia-designer-extension`, whose AI subsystem
is ~11,450 lines across 20 TypeScript modules plus a 521-line .NET sidecar.

### What was decided up front (asked, not assumed)

Four answers shaped everything below:

1. **Full parity was wanted** — the client, the editor flows, model management, the bundled runtime, house
   rules and a chat panel — not just "a chat box".
2. **The sidecar is Rust**, not the designer's .NET `ModelHost` (`llama.cpp` named first, `candle` as the
   acceptable alternative).
3. **Every behaviour**: implement/fix one function with a diff and a `cargo build` check, explain build/flash
   errors, free-form chat, board/crate-grounded generation, and house-rule learning.
4. **A webview view in the Rusty Platform activity bar** for the chat and the model settings.

### What ports unchanged, and what had to be rewritten

The designer's AI subsystem is two halves, and only one of them is about C#:

* **Genuinely language-free, copied and adapted** (setting keys and imports renamed): the model client and
  token arithmetic (`assistant.ts`), the LM Studio / own-`llama-server` / systemd layers
  (`localModelCore.ts`, `llamaServer.ts`, `llamaService.ts`, `bigModel.ts`), the model table and HF download
  (`modelSpecs.ts`, `runtime.ts`), the hardware gate (`hostCheck.ts`), the ✎ prompt block (`prompt.ts`,
  which imports nothing at all) and the repair loop (`repair.ts`). The AI core uses `fetch()` and node
  builtins only, so **`dependencies` stays empty**.
* **Rewritten for Rust** — because the language *is* the point: the prompts, the member parser, the
  visibility rules and the XAML editing in `assistant.ts` became `rustCode.ts`; the C#/VB convention
  counters became Rust ones; `dotnet build` output parsing became `cargo --message-format=json` parsing.
  `assistantUi.ts` (C#-shaped) became `editor.ts`; the designer's settings section inside its giant webview
  became a standalone `ui/aiChatView.ts`.

The `controlEvents` table (a C# event catalogue) had no Rust equivalent to import, which is the one place the
port deleted a feature rather than translating it: there is no `<Control>_<Event>` handler to recognise.

### Three rules that survived the translation, and one that changed

The designer's rules were kept because they are about *small models*, not about C#:

1. **One function at a time.** A 3B model asked to "fix my file" rewrites half of it.
2. **Parse the answer defensively.** Last fenced block wins (models echo the input first), `{"code":…}` as a
   fallback, an unclosed fence salvaged rather than discarded.
3. **Nothing is written without a diff.** `showDiff: false` is an explicit opt-out; even then the write is a
   normal edit that `Ctrl+Z` undoes.

The rule that changed: the designer forced a new member `private` and decided `static` from the body. Rust's
equivalent risk is a **dropped attribute** — a model that rewrites `#[embassy_executor::main] async fn main`
as `fn main` produces a firmware that links nowhere, and the error points nowhere near the edit. So instead of
normalising visibility, `preserveSignature` restores the original attributes and `fn` signature and keeps the
model's body: the signature is not the model's to change.

### The sidecar: why `llama-cpp-2`, and what it costs

`llama-cpp-2` 0.1.158 (vendored llama.cpp, built by `cargo build --release` on the user's machine) plus
`axum` 0.8.9 for the three endpoints. The chat template comes from the GGUF itself, so Qwen/Llama/Gemma each
get their own control tokens without this code knowing any of them. `candle` was the fallback (pure Rust, no
`cmake`) and was **not** chosen: it is slower and means hand-writing the sampling and chat-template loops.

The honest cost, and it is in the runtime's error message: the first build needs `cargo`, `cmake`, a C++
compiler **and `libclang`** (bindgen). That is more than "just rustup". Verified on this machine by building
it: `LIBCLANG_PATH` had to point at LLVM 18's `libclang.so.1`, and bindgen needed
`BINDGEN_EXTRA_CLANG_ARGS="-I/usr/lib/gcc/x86_64-linux-gnu/13/include -I/usr/include -I/usr/include/x86_64-linux-gnu"`
because there is `libclang` here but no `clang` package. On a stock dev box with `clang`/`libclang-dev`
neither is needed; an external server remains the answer for anyone who does not want the toolchain.

`--backend` stays a *cargo feature* (`cpu` default, `vulkan`/`cuda`/`metal` opt-in), because a feature is
compile-time and a flag is not. `/health` therefore reports `cli::compiled_backend()` — what the binary was
built with — and the `--backend` the caller asked for is echoed beside it. The rule is the designer's: the
status line must never claim a GPU that llama.cpp quietly kept on the CPU.

The old `host/ModelHost/` build path became `sidecar/` + `cargo build --release`, with a `.backend` marker
beside the binary so switching backends rebuilds instead of reusing the other build's objects;
`RUSTFLAGS=-C target-cpu=native` because llama.cpp is markedly slower on the generic baseline.

### What is pinned by tests

New t1 files under `tests/layers/t1-logic/` cover the parts that are pure by construction: the Rust parser
and edits, the convention counters, the cargo JSON parser, the OpenAI/SSE client, the ✎ block, the repair
loop and the board facts. `cargoMessages.ts` was split out of `cargoBuild.ts` for exactly this reason —
`cargoBuild.ts` imports `vscode`, and the suite must not.

### What the tests found before the user could

Writing the t1 files first, against the behaviour the doc comments promise, caught six real defects that a
manual pass would have shipped:

1. `braceBlockEnd` rejected a bodyless declaration only on a line more than three below it, so a one-line
   trait method (`fn read(&self) -> u8;`) was reported as a block swallowing the `impl` under it. The rule
   is now "whichever comes first, `;` or `{`".
2. `itemOffsets` advanced one character per line, so `spliceItem` corrupted a CRLF file (stray `\r`, then a
   stray `}`). Offsets are now found by walking the real text.
3. `itemIndent` scanned from the container's own declaration line, so a new function inside an `impl` was
   indented at the container's level instead of one level in.
4. `addItemToFile` computed a zero-line header search when there was no enclosing span, so a new `use` was
   prepended **above** `#![no_std]` — not a legal place for it.
5. `normalizeAssistantConfig` defaulted `bundledBackend` to `vulkan`, so a missing setting quietly asked for
   the GPU build that this project does not install by default. It is `cpu` now.
6. `stripPromptBlock` rewrote every line ending of a CRLF file just because a prompt block was removed.

Two more came out of running the sidecar rather than reading it: `LlamaModel::load_from_file`'s missing-file
guard is a `debug_assert!` (a panic in a debug build), and a panic on the model thread left `/health` saying
`loading: true` for ever — the extension would have waited out its ten-minute timeout instead of reading a
sentence. The load now checks the file itself, and every panic is caught and turned into `/health`'s
`error`.

### Still open

* **The sidecar has not been run against a real GGUF on this machine.** It compiles in both debug and release (llama.cpp and all), its four CLI tests
  pass, and `/health`, `/v1/models`, the `503`-while-loading and the `400`/`429` paths
  were exercised against the real binary — but the first real generation, and the first `cargo check`
  repair loop against a generated project, are the next thing to do.
* No GPU build has been attempted here (no Vulkan SDK / CUDA toolkit installed).
* The chat panel's settings block writes backend/endpoint/model/showDiff; the per-model load options
  (context length, GPU offload, TTL) are reachable from the model picker but not yet surfaced in the panel.
* Windows: `libclang`/`cmake` discovery in `buildSidecar` is Unix-first, like the rest of the extension.

## 35. Making "My own llama-server" set itself up (2026-10-04)

**The report, verbatim.** *"Check the path for running my llama.cpp using the 27B model already downloaded.
When i select My own llama-server, the extension must start the llama.cpp server and load the weights
automatically. If the server or the 27 B model is not on the host machine the extention must offer to download
and install. Check my Grumpy Designer project for the 27 model used."*

**What the check found.** Three things, each verified rather than assumed, and none of them what the report
expected:

1. **The command did not exist.** `Rusty AI: Choose a Local Model… → My own llama-server` runs
   `vscode.commands.executeCommand('rustyPlatform.assistant.startLlamaServer')`, and *nothing anywhere*
   registered that id — the comment beside it even said "the command is registered by then", which was an
   assumption, not a fact. The two settings the path writes (`llamaServerPath`, `llamaServerArgs`) and four
   more the same feature touches (`llamaServerService`, `llamaServerStartTarget`, `loadContextLength`,
   `loadGpu`, plus `loadTtlSeconds` in the panel) were never declared in `package.json` either, so
   `WorkspaceConfiguration.update()` on them raised *"… is not a registered configuration"*. A whole feature
   sat in `src/` looking finished and could not be reached: TypeScript cannot see either mistake, because
   `executeCommand('anything')` and `update('anything')` both type-check.
2. **The 27B is the Designer's `qwen3.8-27b`** — `lmstudio-community/Qwen3.8-27B-GGUF`, file
   `Qwen3.8-27B-Q4_K_M.gguf`. The Designer never names a Hub repo (there the model is LM Studio's, and its
   only trace is the label in `parseLoadEstimate`'s doc block), so the identity was pinned from this machine's
   own LM Studio records — `model-data.json` (`uiIdentifier: "qwen3.8-27b"` → repo + file) and
   `single-downloads-info.json` (the download that fetched it) — and then confirmed **independently** against
   Hugging Face's API: **16 810 714 336 bytes, sha256 `e00082f7…43e520`**. Two independent records agreeing is
   what makes it safe to publish as a checksum.
3. **The weights are not on this machine.** The report said "already downloaded"; only LM Studio's *record* of
   the download survives. `~/.lmstudio/models/` holds four models, none of them the 27B, and the only
   27B-shaped file on any mounted filesystem is `Bonsai-27B-Q1_0.gguf` (a different model — prism-ml's, 1-bit,
   3.8 GB). So the download offer is not a hypothetical on this machine: it is the only route to the model the
   user asked for.

**What it does now.** The palette command, the panel's Load button and the panel's Start button all resolve
the same two questions the same way:

* **the binary** — the `llamaServerPath` setting, then PATH and the usual build folders (`~/llama.cpp/build/bin`,
  `/usr/local/bin`, …), and when there is none, an offer to **download llama.cpp's own prebuilt server**
  (~18 MB) or to point at a build you made yourself. The installed build goes into the extension's global
  storage, so an extension update does not re-fetch it, and the digest GitHub publishes is verified before
  anything is unpacked or executed.
* **the weights** — the `modelPath` setting, then a verified copy of the known 27B already in the extension's
  storage, and otherwise *one* question whose first entry is that 27B: downloading it if this machine has none,
  or adopting the copy that is already here (LM Studio's folder, `~/Downloads`, a mounted drive) if it is —
  `ensureModelFile` looks for it by name and size and proves it by hash before spending any bandwidth.

**A second pin, because the first one was the wrong question.** `modelPath` is the **built-in runtime's**
pin: the panel marks a built-in entry as loaded by comparing it with `modelPath`, and the model picker writes
it when the extension's own model is chosen. The own-server path had been borrowing it, and on this machine
that was not a small thing — `modelPath` held the Designer's copy of the shipped 4.4 GB 7B, so "the setting
wins" meant *My own llama-server* would have started the 7B silently, which is precisely not what the request
was about. The user's own server now has its own pin (`llamaServerModelPath`), and a file the bundled runtime
knows by name is **not** an answer to "which model does your llama-server run" — it falls through to the 27B
and then to the picker, which still lists it as a model to choose. Checked against this machine's real
settings, not a fixture: the old rule resolved to `qwen2.5-coder-7b-instruct-q4_k_m.gguf`, the new rule to
`{source: "none"}` — the picker, with the 27B download as its first entry.

The rule is **ask only what we do not already know**. Once a machine has answered both questions, the command
starts the server and loads the weights with nothing to click, which is what "automatically" means to the
person who asked for it. The one question that survives a second run is the "a llama-server is already
running" choice, and that one is deliberate: two models of this size do not fit in 28 GB, and it is the only
thing standing between a click and a machine that swaps for an hour.

**The installer was run for real, and the first run failed.** `/releases/latest` on `ggml-org/llama.cpp`
answers `v0.5.0`, whose single asset is `nightly-tag.txt` — the runnable builds are published under `bNNNNN`
tags that endpoint does not return. The first real execution of the installer died with *"llama.cpp publishes
no prebuilt server for this machine (linux/x64)"*, which was simply false. It now asks for the release *list*
and takes the newest entry that has both the asset this platform needs and a `sha256:` digest to check it
against, which also means a future release that is all metadata is passed over instead of reported as "no
build for you". After the fix, the same run: **4.4 s, `llama-b11384-bin-ubuntu-x64.tar.gz` (17 669 671 bytes),
digest verified, unpacked, and `llama-server --version` → `0.5.0-dev (build 11384, commit 0faee5004)`**.

**The start path was run for real too** — the extension's own `startOwnLlamaServer`, driven through a stubbed
`vscode` against the machine's own binary and the lightest model on disk
(`Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf`, 1 929 903 072 bytes), with the developer's 30B systemd unit still
answering on 8080:

```
llama-server --model …/Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf --host 127.0.0.1 --port 44979 \
             --ctx-size 4096 --threads 4 --n-gpu-layers 0 --alias Qwen2.5-Coder-3B-Instruct-Q4_K_M
→ /health {"status":"ok"} · /v1/models → the alias · chat → "OK"      (4.0 s to ready)
```

…and the answer said the thing the user needs to hear when it happens: *"your llama-server on port 8080 is
still running its own model, so both are in memory now."*

### What is pinned by tests

`tests/layers/t1-logic/ai-llama-install.test.js` pins the install decisions against the **real** release list of
2026-10-04 (real names, real sizes, real digests): which asset fits each platform/arch, that no CUDA/Vulkan/
ROCm/SYCL/Android/CUDA-runtime asset is ever chosen, that a digest which is not exactly one sha256 is refused,
the `tar` flags for `.tar.gz` vs `.zip`, how the binary is found in the archive listing, and the 27B's own
numbers.

`ai-wiring.test.js` is the new guard for the bug class that caused all of this: it reads `src/**` as text and
compares it with `package.json` in both directions — a command the source runs but the manifest does not
declare, a command the manifest declares but nothing registers, a setting the source reads or writes but the
manifest does not define, and a declared setting with no description. The `rustyPlatform.assistant.focus`
command is the one allowed exception, because VS Code generates `<viewId>.focus` for every contributed view.

`manifest.test.js` already had *"every command the code registers is declared in the manifest"*, and it could
not have caught this: it walks from **registered → declared**, so a command that nothing registered was
invisible to it in both directions, and the failure ("this feature cannot be reached at all") looked exactly
like success. Both halves of the relation are now checked, and the new test was verified to fail on purpose —
removing the `startLlamaServer` declaration from `package.json` makes three cases fail, and deleting the
`llamaServerPath` property makes two more.

Suite: **552 passed, 0 skipped** (was 530), and `tsc` is clean under the project's strict flags.

### Still open

* The 27B itself has not been downloaded here (15.7 GB) — the spec is Hub-verified and the download path is the
  one the 7B already exercised (checksum, resume, adopt-a-local-copy), but the first real 27B run on this
  machine will be the user's.
* GPU builds of llama.cpp are deliberately not offered by the installer: they are 150-600 MB and depend on a
  driver this extension cannot inspect. A developer who wants Vulkan/CUDA builds their own and points
  `llamaServerPath` at it.

## 36. The pin was right; the settings form wrote it back (2026-10-04)

**The report.** *"I select the 'My own llama-server' in the model picker, then i select Use the one already
running on port 8080 … Ready. Using the llama-server already running on port 8080 — it serves
qwen3-coder-30b-a3b-instruct-q4_k_s.gguf … I click ok. The endpoint and Model ID is not updated in the Model
and settings section and the response from a prompt is: … ⚠ No server answered."*

**The evidence, in the extension's own words.** VS Code dumps every output channel to
`~/.config/Code/logs/<session>/window<N>/exthost/output_logging_*/1-Grumpy's Rusty Platform.log`, which is
where this was solved — not by guessing from the two symptoms:

```
[09:33:27] llama-server: using /home/niel/llama.cpp/build/bin/llama-server (version 10365 (9afff1b74))
[09:33:35] llama-server: using the one already running on http://127.0.0.1:8080/v1 (qwen3-coder-local)
[09:33:43] Test request: ready, finish reason "stop".      ← the reuse really did work
[09:34:21] assistant: panel settings saved                 ← Save, from a form nothing had refreshed
[09:34:24] assistant: panel settings saved
[09:36:12] ERROR: No server answered — is the local model server running (and the endpoint correct)?
[09:37:57] llama-server: using /home/niel/llama.cpp/build/bin/llama-server …
[09:38:35] llama-server: using the one already running on http://127.0.0.1:8080/v1 (qwen3-coder-local)
[09:38:36] Test request: ready, finish reason "stop".
```

`journalctl --user-unit llama-server.service` agrees and narrows it down: the 30 B service logged requests at
09:33 (the reuse's `proveItWorks`) and **nothing at all at 09:36** — the failing prompt never reached port
8080. And the settings file afterwards holds `8080` again, because the user re-ran the flow at 09:37.

**The cause.** `useRunningLlamaServer` wrote the three settings correctly — the log and the file both prove
it. What it did **not** do was tell the view. The Model and settings section renders its **own copy** of
backend/endpoint/model from a `state` message, and nothing posted one after a palette-driven pin, so the form
went on showing LM Studio's `http://127.0.0.1:1234/v1` and an empty model field. Then the Save button — which
sent **all four fields**, changed or not — wrote that stale address back over the correct pin. Every prompt
afterwards went to the dead 1234, which is exactly `ECONNREFUSED` → *"No server answered"*. Two symptoms, one
missing `refreshPanels()` call and one form that spoke with more authority than it had.

**The three fixes.**

1. **Every write tells the view.** `useRunningLlamaServer` and `startOwnLlamaServer` now call
   `refreshAssistantView()` (a dynamic import of `editor.ts`, the same trick `refreshPanels` itself uses to
   avoid a load-time cycle), so the form shows what the settings say the moment they change.
2. **Save writes a diff, not a form.** The view remembers what it was last *told* and posts only the fields
   the user actually changed; an empty diff is not a write at all and says so. A form that has not caught up
   can no longer revert a decision it never saw — which is the same shape as the *shadowed scope* bug in
   `settings.ts` (a writer acting on a stale belief about what is true).
3. **The failure names the address.** `describeError` now takes the endpoint and prints it — *"No server
   answered at http://127.0.0.1:1234/v1"* instead of a sentence with no address in it — and the chat appends
   `endpointMismatchHint`'s sentence when a probe finds a llama-server answering **somewhere else**: *" A
   llama-server IS answering on port 8080 (qwen3-coder-30b-a3b-instruct-q4_k_s.gguf) — the settings point at
   http://127.0.0.1:1234/v1, so the endpoint above is the thing to change."* The diagnosis that took a log
   dig is now the error message.

**Verified against the machine's real service**, through the compiled modules with a stubbed `vscode`:
`useRunningLlamaServer(await findRunningLlamaServer('http://127.0.0.1:1234/v1'))` on this box finds the 30 B on
port 8080, writes `{backend: "external", endpoint: "http://127.0.0.1:8080/v1", model: "qwen3-coder-local"}`,
and posts `state` with those three values to the open view — the message that was missing. The save contract
was checked the same way: an empty diff writes **nothing** (and answers "Nothing changed — the settings
already say that."), and a one-key diff writes exactly that key.

**Still open.** The `.part` file in the extension's storage (`qwen2.5-coder-7b-instruct-q4_k_m.gguf.part`,
1.91 GB of 4.68 GB, untouched since 08:28) is an interrupted download of the built-in runtime's model; the
resume path will continue it, and nothing was deleted here because it is the user's bandwidth. This machine's
LM Studio is also dead (the `lms` daemon answers nothing, and every probe spends 20 s finding that out), which
is why the settings' old `1234` endpoint had no chance of working.

Suite: **557 passed, 0 skipped** (was 552).

## 37. The extension owns the llama.cpp it needs (2026-10-04)

**The rule, from the user.** *"This extension must not rely on the user to have a llama.cpp server installed.
If the server is installed on the host, just start it and use it. If not, offer installation to the user."*

**What was still missing.** The offer to install existed (0.0.5) and the palette flow could start a server —
but the two places where the need actually arises did not use either:

1. **A request that met a dead address only complained.** `implement`, `fix`, `repair` and the chat view ended
   at *"No server answered"*, however much llama.cpp was on the disk. The extension was still relying on the
   user to notice, go to the model picker, choose the entry and press the button.
2. **"Installed" meant "the `llamaServerPath` setting survives".** The lookup knew the setting, PATH and the
   usual build folders — *not* `<global storage>/llama.cpp/<tag>/…`, which is where this extension puts the
   release it fetches. Clear that setting, open a second window, or move the profile, and a verified build
   sitting in our own storage was invisible: the next start would have offered to download it again.

**What happens now.**

* **Every request path goes through `chatWithRescue`** (`editor.ts`), so the chat view, implement, fix and
  repair all behave the same. On failure, `rescueUnreachableEndpoint` (`llamaServer.ts`) decides from
  `endpointRescuePlan` and acts: a llama-server answering on another local port is **used** (and the step is
  announced: *"nothing is answering at http://127.0.0.1:1234/v1 — using the llama-server on port 8080
  instead"*); otherwise the binary we have is **started** with the model the settings already know; otherwise
  the **install is offered** (and accepted, the ~18 MB prebuilt is fetched, verified and unpacked); and only
  then is the original failure reported.
* **The rules that keep that from being reckless** are pure (`endpointRescuePlan`, pinned by tests): only
  `backend: external`; only a **local** address (a down remote endpoint must never make this machine start a
  process nobody asked for); only a "nothing answered" failure (not a 400, not a cancel, not a timeout); and
  `canInstall: false` suppresses the offer where llama.cpp publishes nothing for the platform.
* **Retrying is guarded**: nothing is retried once part of an answer has been streamed — a connection that
  dies mid-answer is also `fetch failed`, and a blind retry would print the beginning of it twice.
* **Our own installs are found without the setting.** `findInstalledLlamaServer` walks
  `<global storage>/llama.cpp/*`, newest tag first, and the layout decision (`installedLlamaServerCandidates`)
  accepts both archive shapes: flat (`<tag>/llama-server`) and nested (`<tag>/llama-b11384/llama-server`).
  It offers **every** entry as a possible folder rather than guessing from the name — a release whose listing
  begins with `llama-cli` would otherwise have stopped the search before the real subfolder, which is exactly
  the sort of thing that only shows up on one machine's release. The status line says which binary it is:
  *"…/llama.cpp/b11385/llama-b11385/llama-server (installed by this extension) — not running"*.

**Verified by running it, twice, against a machine with nothing installed.**

```
1. no llama.cpp anywhere → lookup: {}                      (HOME emptied, no PATH entry, no install of ours)
2. offered: ["Download llama.cpp","Point at my own build…","Cancel"]
3. installed → "/…/llama.cpp/b11385/llama-b11385/llama-server" in 4.1s
4. next lookup: {"path":"/…/llama-server","installed":true}
```

and — the reported failure itself, healed:

```
configured endpoint      : http://127.0.0.1:1234/v1 (nothing is listening there)
steps the user would see : ["nothing is answering at http://127.0.0.1:1234/v1 — using the llama-server on port 8080 instead"]
THE ANSWER               : "OK"
settings now             : {"backend":"external","endpoint":"http://127.0.0.1:8080/v1","model":"qwen3-coder-local"}
```

**One judgment call left in place.** The explicit command *"AI: Start My llama-server…"* still **asks** before
starting a second server when one is already running elsewhere, because two 17 GB models do not fit in 28 GB
and that question is the only thing standing between a click and a machine that swaps for an hour. The rescue
path does not ask — it reuses. If a user wants that question gone as well, it is one branch to remove.

Suite: **562 passed, 0 skipped** (was 557).

## 38. The chat writes to the project, through the same door as everything else (2026-10-04)

**The ask.** *"In the ai assist chat box, if the response contains refactored code, add the option to
implement that code in the project."*

**What that had to mean here.** The chat is where a *question* is answered — "why does this deadlock", "how
should this be structured" — and a good answer often ends with the code. Until now the user copied it out by
hand and found the file themselves. The button that appears under such an answer is that copy-paste, but it
follows the rules the rest of this extension already follows: the right file, the right place in it, the
file's own attributes respected, a **diff** to review, and one undoable edit. Nothing new was invented for the
write path — `showProposal` / `applyProposal` (the ✎ flow's diff) do it.

**The decisions, all pure and all tested.**

* **Which answers get a button.** `codeBlocks` (in `assistant.ts`) reports every fenced block with its
  language; `isRustCodeBlock` keeps `rust`/`rs`/no-language and drops `toml`, `bash`, `json` — a `Cargo.toml`
  snippet is not code to implement in a `.rs` file. It is *not* `extractCode`: that answers "what is **the**
  code here" for a flow that has already decided to apply one thing, while the chat has to answer "is there
  anything here, and how many" — a refactoring answer commonly carries two blocks (before and after), and each
  is offered separately. **Only closed fences count**: an unclosed one means the token budget cut the answer
  off, and offering a *button* that writes half a function into a file is a different promise from
  `extractCode`'s salvage, which is shown to a user who is about to read it anyway.
* **Which file.** The Rust file in front of the user, with no question — and the diff **names** it
  (`AI: fn main → main.rs`), so the quiet path is still a visible choice. The first version asked with a
  two-item picker every time, which the verification run showed immediately: a question that is answered the
  same way every time is noise. With no Rust file open (or the active editor being the proposal *preview*, a
  write to nowhere) it offers the project's `src/**/*.rs` plus "a new file…".
* **Where in the file.** `insertChatCode` (pure, in `rustCode.ts`): a **whole file** replaces the file; an
  **item** replaces the same-named function in place (keeping the file's attributes and signature via
  `preserveSignature`), or is added to the file when the name is new.
* **Is it a whole file?** `looksLikeWholeFile` — `#![…]` anywhere at the start of a line (an inner attribute is
  illegal anywhere else), **or** `fn main` **with** a `use` line beside it. The `fn main` case is not
  `fn main` alone, and the test that made the rule is the reason: a *refactor of `main`* comes back as
  `#[embassy_executor::main] async fn main(…) { … }` with no imports, and treating that as a whole file would
  replace `main.rs` with one function and silently delete every other item in it. Caught by writing the test
  first — the first rule was `#![…]` OR `fn main`, and the test failed.

**Verified against a real file**, through the compiled modules with a stubbed `vscode`: an answer containing a
refactored `main` applied to `.verify/project/src/main.rs` produced a diff titled `AI: fn main → main.rs`
whose proposed text has the new body (`Timer::after_millis(500)`), the old body gone, and untouched:
`#![no_std]`, `#![no_main]`, `use embassy_time::Timer;`, `#[embassy_executor::main]`, `fn other_helper` —
exactly one `main`, and **the file on disk unchanged until Apply**.

Suite: **571 passed, 0 skipped** (was 562).

## 39. The model list was written around one machine (2026-10-04)

**The complaint.** *"The weight size of the local models are restricted to the specs of this pc. However,
this extension is bound to be used by other users who might have much better hardware. This extension must
allow users with high spec hardware to select models that suit their environment."*

**What the check found — four ways the extension decided from the machine it was written on.**

1. **The only models anyone could choose were the two 4.4 GB entries in `MODEL_SPECS`** (plus the 27B for the
   own-server path). The designer's "add a model from Hugging Face" flow had been ported — `parseHubUrl`,
   `hubGgufFiles`, `hubFileSpec`, `addCustomModelSpec`, `customModelSpecs`, all tested — and **nothing called
   any of it**. The mechanism for "choose a model that suits your environment" existed and was unreachable.
2. **A model was vetoed by this machine's RAM**, and for a Hub model the requirement was **twice its own file
   size**: `hubFileSpec` derived `minRamGb = size × 2`, so the 16.8 GB 27B was "not offered here" on the 28 GB
   machine that loads it in 16.5 GiB. A user with a big machine was shown a refusal computed for a small one.
3. **The GPU was never asked about.** `HardwareFacts` had `cpuCount`, `totalRamGb`, `freeRamGb`, `hasAvx2` —
   no VRAM at all. The offload rule was `sizeGb > 8 → off`, written when the only GPU in the room was an
   integrated one: on a 24 GB card, a 27B was pinned to the CPU by a rule that could not tell the two apart.
   The thread count was capped at 8 (a 12-thread laptop's number) and the recommended context ceiling was
   16 384 for everyone.
4. Nothing else — the *own llama-server* path already takes any `.gguf` on disk, and the panel lists every
   spec via `allModelSpecs()`.

**What it does now.**

* **"Add a Model from Hugging Face…"** (command and a picker entry): type `owner/repo` or paste a Hub link, and
  the repo's files are listed **with their sizes, quantisation and fit for this machine**; pick one and it goes
  into `user-models.json` beside the weights and behaves exactly like a built-in entry from then on —
  picker, panel dropdown, checksum-verified download, hardware arithmetic. `mmproj-*.gguf` (vision projectors)
  are filtered out with `canImportFile`, the same rule the on-disk scan uses, so the two lists agree on what a
  chat model is. A companion command removes an added model from the list (the weights are left on disk).
* **No more veto.** Every model is offered; one that may not fit is marked `$(warning)` with the arithmetic
  (*"needs about 24.4 GB free (21.3 GB free now, 28 GB in total)"*) and asking for it confirms once. llama.cpp
  reports its own allocation failure if it really cannot.
* **`specFit`** replaces the ×2 guess: weights + a 2 GB context allowance, against the memory free *now*.
* **The card is asked**: `readGpuVramGb()` tries `nvidia-smi`, then the amdgpu sysfs file, and the
  `gpuVramGb` setting overrides both (Intel Arc, Apple silicon and older drivers answer "unknown"). Offload is
  then decided by whether **weights + context fit the card** — with a sentence saying why, either way.
* **Threads** to `min(cores − 1, 16)` and **context** by free RAM (64 k at 96 GB, 32 k at 48 GB, 16 k at 20 GB,
  unchanged below that), so a workstation is not handed a laptop's numbers.

**One trap found by testing on this machine.** The amdgpu sysfs figure for an **APU** is a slice of *system*
RAM, not a card: this machine's integrated Radeon reports **3.2 GB**, and its own measurements say offloading
the 4.7 GB 7B to it is *faster* (9.7 s against 13.0 s on the CPU). Trusting that number would have flipped
every recommendation here to CPU-only. So a figure under 8 GB is ignored (`isDedicatedAmdVram`) and the
conservative shared-memory rule stands — verified: `readGpuVramGb()` on this box answers `undefined`.

**Verified on the real machine and the real Hub** (compiled modules, stubbed `vscode`):

```
this machine : 28 GB RAM, 21.3 GB free, 12 threads, no dedicated card
the 27B      : was minRamGb 31 (2× the file) → refused here;  now needs about 18.8 GB, 21.3 GB free → offered
threads      : 11 (was capped at 8)          context: 16384        offload on a 24 GB card for the 27B: GPU
Hub, for real: lmstudio-community/Qwen3.8-27B-GGUF → 4 files listed with size + quantisation + fit
               Qwen3.8-27B-Q4_K_M.gguf added → stored in user-models.json → in allModelSpecs() → true
```

Suite: **575 passed, 0 skipped** (was 571).

## 40. Windows 11: audited, and three Linux-shaped decisions put right (2026-10-04)

**The question.** *"Will this extension also work in Windows 11?"* The honest answer needed an audit, not an
opinion — and the audit found the manifest restricts nothing (`"os": null`), the toolchain/flash layer already
carries real Windows branches (`rustup-init.exe`, `x86_64-pc-windows-msvc`, `.exe`/`.cmd` resolution,
`bootsel` via Windows), nothing anywhere spawns through a shell (so `C:\Program Files\…` cannot be mangled),
and the Rust sidecar has no Unix-only code. Three **AI-side** decisions, though, were quietly Linux-shaped.

1. **The start target defaulted to a systemd unit on every platform.** On Windows `systemctl` does not exist,
   so the unit route failed first and the built-in fallback started a process — working, but after a pointless
   failed attempt and a message about a service manager that is not there. `resolveStartTarget(configured,
   platform)` now decides the *default* (unit on Linux, process elsewhere) and an explicit setting is always
   honoured, read from the configuration **scopes** rather than the value: the setting's declared default is
   `unit`, so the value alone cannot say whether the user ever chose it.
2. **Model search walked `/media`, `/run/media`, `/mnt`, `/Volumes` and no drives.** On Windows those do not
   exist (skipped silently), and `D:`-`Z:` were never looked at — so a 16 GB `.gguf` on a second drive was
   invisible to every scan and reachable only through the file dialog. `windowsDriveRoots(exists)` offers each
   existing `D:`-`Z:` (never `C:`, whose interesting folders are the user's own, already roots), and
   `scanRoots(home, platform, extra)` splices them in on win32.
3. **"Who is holding this port?" answered `none` on Windows** — because `ss` and `/proc` do not exist there.
   That is a lie the panel then repeats while a server is answering requests at that very moment.
   `canInspectServerOwner(platform)` pins the fact, `detectServerOwner` returns a new
   `{ kind: 'unknown', why }`, `describeOwner` says *"running, but this platform cannot say who started it"*,
   and the stop flow tells the user where to end it instead of claiming it checked.

**Windows is better covered than the audit first suggested**, in one respect worth recording: `hostCheck.ts`
already probes the GPU on **Windows via PowerShell/WMI** (`Get-CimInstance Win32_VideoController`) and on macOS
via `system_profiler`, and classifies `discrete` versus `integrated` — so the VRAM-aware offload works there
too, and the `gpuVramGb` setting covers whatever the probe cannot see.

**Known follow-up, recorded rather than hidden.** There are now **two** VRAM readers: `hostCheck`'s
`probeGpu`/`classifyGpu` (async, classifies the card, covers all three platforms) and `sys.ts`'s
`readGpuVramGb` (sync, added in §39 so the synchronous `setupFacts()` could have a number). They agree in
practice — `sys.ts` refuses anything under 8 GB, which is exactly the APU case `classifyGpu` calls
`integrated` — but "agree in practice" is the arrangement this project keeps refusing to accept. The fix is to
give `setupFacts` the probe's verdict (a cached synchronous accessor, or making its callers tolerate a
promise); it is a small refactor across the picker's call sites and was deliberately not folded into a
Windows-fix release.

**What is still unverified on Windows**: a first-run sidecar build with MSVC, and the ESP toolchain install.
Both are code-audited, neither has been run on a Windows machine — the same standing caveat as the sidecar's
first real generation here.

Suite: **579 passed, 0 skipped** (was 575).

## 41. The chat in its own window, on the monitor it deserves (2026-10-05)

**The ask.** *"I would like the option to run the Chat window outside of the IDE on a 2nd monitor. Is it
possible to make it run in an editor pane which can be dragged outside of the IDE window?"*

**Yes — and only as an editor pane.** VS Code lets a **view** be moved between the primary and secondary
side bars and the panel, but it is always docked inside the window; there is no way to drag one onto another
monitor. An **editor** is different: `View: Move Editor into New Window` (or dragging the tab out of the window)
gives it a real OS window, which the window manager then puts wherever the user likes. So the chat gained a
second surface — a webview **panel** created with `createWebviewPanel`, opened beside the editor by
**Rusty AI: Open the Assistant in an Editor Tab**.

**What that required, and the one rule it must not break.** The transcript, the store, the busy flag and the
request path are module state, and they were written against a single `view`:
`post()` sent to `view?.webview`, `refreshAiChat()` returned early if there was no view. Two surfaces would
have meant copying that state, which is two conversations pretending to be one. Instead the single view became
a **set of surfaces**: `post()` broadcasts to all of them, `attach(provider, webview)` wires one up (shared
HTML, shared message handler, one `refreshAiChat(true)` so a surface that just opened — including one dragged
onto another monitor — draws the conversation immediately), and a panel removes itself from the set when it is
closed. The view still goes through the same `attach`, so the two cannot drift.

The panel is a singleton: asking twice **reveals** the one that exists rather than stacking copies, it carries
the extension's icon, and `retainContextWhenHidden` keeps the transcript alive while it is behind another tab
or collapsed. `AiChatViewProvider.handle` became public for exactly one reason — two surfaces, one handler.

Suite: **580 passed, 0 skipped** (was 579).

## 42. The tab that was there when you come back (2026-10-05)

**The follow-up.** *"Do that please: so the second-monitor window comes back exactly where you left it after a
reload."*

VS Code restores an editor **webview panel** only if the extension has registered a
`WebviewPanelSerializer` for that panel's view type. Without one the tab is simply gone on reload — which is
exactly what §41 shipped, and why the caveat was written down rather than left implied.

Three details made it more than a call to `registerWebviewPanelSerializer`:

* **The view type has to be the same string in both places.** It is now a named constant
  (`CHAT_PANEL_TYPE`), used by `createWebviewPanel` and by the serializer, because a typo there fails the way
  this project keeps meeting: the tab opens perfectly and never comes back, with nothing said.
* **A restored panel is as real as a new one** — it needs the icon, it has to join the surface set (or the
  transcript would never reach it), and it must clear the singleton when closed or the next "open the tab"
  would `reveal()` a dead one. So both paths call one `wireChatPanel(context, panel)`.
* **A panel dragged onto another monitor is restored by a different window**, with its own extension host: the
  transcript is not carried in the panel state at all. It comes from the chat store, and the webview's own
  `ready` handshake (`ensureActive` → `history`) fills it in — the same path that fills a freshly opened tab.
  The panel state carries only the title, so a tab the user renamed comes back with its name.

**What is restored is the *layout*, by VS Code** — the window it was moved into, its position among the
groups. Nothing about the monitor is stored by this extension, and nothing could be: the window manager places
the window, and a comment in the code says so rather than pretending the extension controls it.

Suite: **581 passed, 0 skipped** (was 580).

## 43. And a way to press it from where the chat already is (2026-10-05)

**The ask.** *"Add a command to move the panel to an editor pane in the Rusty Platform's side panel."* §41 gave
the move a command, but the command was only in the Command Palette — a user sitting in the AI Assist view,
looking at the thing they want to move, had to go to the palette and remember a name.

Two entry points now, running that **same** command rather than a second implementation: a footer button
**In Editor Tab…** beside *Status…/Unload*, and an action in the view's **title bar**
(`menus.view/title`, group `navigation`) for when the footer is scrolled out of sight. The wiring test asserts
both exist, that the button runs `rustyPlatform.assistant.openEditor`, and that the title action is declared
for `view == rustyPlatform.assistant` — so the two cannot drift from the command they mean.

Suite: **582 passed, 0 skipped** (was 581).

## 44. Publishing the firmware as a `.deb`, and what that even means (2026-10-05)

**The ask.** *"In the Controls section of the Rusty Platform side panel, add a control to publish the project to
a .deb file, and another to install the .deb on the host machine. The deb file must land in the project root."*

**The question that had to come first.** A Debian package cannot install anything onto a microcontroller. The
project the request was about (`my-blinky-pico2w`) is an Embassy `no_std` crate, so "publish to .deb" had three
possible meanings — the firmware artifacts, a native host binary the project does not have, or a package that
flashes the board. Rather than guess, the choice was put to the user with the actual constraint in it, and the
answer was the one that makes sense for firmware: **the artifacts plus a flash helper**.

**What the package is.** `Rusty: Publish .deb` builds `cargo build --release`, finds the newest artifact the
build produced (`target/<triple>/release/<crate>` plus any `.bin`/`.uf2`/`.elf` beside it) and packs:
`/usr/share/<package>/` with those files, and `/usr/bin/<package>-flash` — a `#!/bin/sh` wrapper that checks
`probe-rs` exists and then `exec probe-rs run "$@" "$ARTIFACT"`. So installing it on a host means that host can
flash the board with `<package>-flash`, with no project checked out. `Architecture:` is the **host's**
(`amd64` here), never the board's — declaring `arm64` because the microcontroller is an ARM Cortex-M would make
dpkg refuse to install it on the x86-64 laptop that built it, and a test says so.

**Where the code is, and why.** Every string inside the package — the control file, the file's own name, the
wrapper — is a pure function in `deb/package.ts`, pinned by nine tests. `dpkg-deb` rejects a malformed control
file with *"line 6: field name ..."*, which is a slow way to find a missing field; the multi-line description in
particular (first line, then indented continuations, and a blank one as a single space) is checked line by line.

**The two controls are in the section, not the status bar.** The first attempt added them to `CONTROLS`, which
also lays out the status bar — and the existing test for the status-bar order caught it immediately. They are
`PACKAGE_CONTROLS`, returned by `visibleControls` (the side panel) and deliberately absent from `CONTROLS`.

**Verified against the real `dpkg` on this machine**, on a project shaped like the user's:

```
dpkg-deb exit: 0
/…/my-blinky-pico2w_0.1.0_amd64.deb  (81 370 bytes, in the project root)
Package: my-blinky-pico2w · Version: 0.1.0 · Architecture: amd64 · Installed-Size: 79
Description: Firmware for Raspberry Pi Pico 2 W (my-blinky-pico2w)   ← 11 control lines, parsed
./usr/bin/my-blinky-pico2w-flash            -rwxr-xr-x  (0755, extracted from the .deb and read back)
./usr/share/my-blinky-pico2w/my_blinky_pico2w(.bin)
```

The first build also showed a blemish worth fixing: the staging folder's `mkdtemp` mode (`0700`) became the
archive's `./` entry, so `publishDeb` now chmods the stage to `0755`. Installing runs `sudo dpkg -i` in a **VS
Code terminal** rather than a spawned process — it needs the user's password, and a terminal also leaves the
command in the scrollback — after showing `dpkg-deb --info`. Off Linux both controls say why they cannot work
instead of failing at the shell.

Suite: **587 passed, 0 skipped** (was 582).

## 45. A dated copy next to the project, minus the compiler's leftovers (2026-10-05)

**The ask.** *"Add a control there to back up the project folder (project folder name plus date stamp) in its
parent folder."*

**One decision, made explicitly.** `target/` is not copied. It is what the compiler produced, routinely tens of
gigabytes for an embedded workspace, and the next build regenerates it; a backup that included it would be slow,
huge, and would bury the files that matter. `.git/` **is** copied — it is the project's history, and a backup
without it is not a backup. A *file* named `target` is the user's own work and is kept; only the directory is
skipped (`shouldCopyEntry(name, isDirectory)`). Nothing is overwritten: the name carries the time
(`<folder>-2026-10-05_1804` local), and a second backup in the same second gets `-2`.

**Verified for real**: a project-shaped tree with a 3 MB `target/release/junk/big.bin` produced
`proj-2026-10-05_180409` beside it with `Cargo.toml`, `src/main.rs` and `.git/HEAD` copied and `target/` absent
— 3 files, 33 bytes, in the parent folder next to the original. `fs.cpSync` with a filter does the copying; it
keeps symlinks as symlinks rather than walking into whatever they point at.

Suite: **592 passed, 0 skipped** (was 587).

## 46. The ESP projects the generator emitted could not compile (2026-10-05)

**How this was found.** *"I am busy testing a project created by the extension for the sunton board — my test
app `blinky-sunton-3248s035r`. Inspect please."* Inspecting it, then **building a freshly generated one** with
the real Xtensa toolchain, turned up four separate defects in the ESP generator. Two are fixed here; the
remaining three are written down with the compiler's own words, because the honest state of the display
template is *"still does not compile"* and shipping that as fixed would be worse than saying so.

**Fixed.**

1. **The panel's SPI interface was the two-argument one, called with three arguments.** The template emitted
   `use display_interface_spi::SPIInterface;` and then `SPIInterface::new(spi, dc, &mut buffer)`. From the two
   crates' own sources (`~/.cargo/registry`): `display-interface-spi-0.5` has
   `pub fn new(spi: SPI, dc: DC)` and `mipidsi-0.10` has `pub fn new(spi: SPI, dc: DC, buffer: &'a mut [u8])`.
   The generator now emits `use mipidsi::interface::SpiInterface as SPIInterface;` — the buffered type the call
   already assumed. Affected `sunton-3248s035r` and `lilygo-tqt`. The user's own project had been fixed **by
   hand**, with a comment saying exactly this, which is what led here.
2. **`build.rs` did not compile at all.** The panic message escaped backticks — `"Xtensa linker \`{linker}\`
   was not found"` — and Rust has no `\`` escape:

   ```
   error: unknown character escape: `  --> build.rs:37:39
   37 |   "Xtensa linker \`{linker}\` was not found on PATH.\n\n\
   ```

   Backticks need no escaping in a Rust string, so they are plain now. This one applies to **every ESP board and
   both ESP templates** (7 snapshots changed), which means their `build.rs` was broken before anything else
   could happen.

**Still broken, in the display template's own `main.rs`** — the dependency tree now compiles (esp-hal 1.2.2 and
all), and the crate fails with nine errors:

* `let mut delay = Delay;` → `error[E0423]: expected value, found struct Delay`. esp-hal 1.2.2 has
  `impl Delay { pub const fn new() -> Self }`, so it must be `Delay::new()`.
* `SPIInterface::new(spi, dc, &mut buffer)` → `error[E0277]: the trait bound
  esp_hal::spi::master::Spi<'_, Blocking>: embedded_hal::spi::SpiDevice is not satisfied`. esp-hal's `Spi` is a
  `SpiBus`; mipidsi's buffered interface wants a `SpiDevice` (bus + CS). The template's
  `.with_cs(peripherals.GPIO15)` does not make one — the device wrapper has to be constructed.
* `Rgb565::RED`/`WHITE`/… → `trait RgbColor which provides WHITE is implemented but not in scope`; the template
  needs `use embedded_graphics_core::pixelcolor::RgbColor;`.

**What this means for the user's project.** `blinky-sunton-3248s035r` carries two of the four defects as
generated (the import is the one thing that had been fixed by hand, and the `build.rs` escape is still there),
which is exactly why its `target/` shows an interrupted build: 37 host build scripts, two chip rlibs and
`dep-graph.part.bin` working files, and no `.elf`. It cannot have built, and no code of its own was at fault.

**Environment, verified while doing this**: Xtensa GCC 16.2.0 via `~/export-esp.sh`, `espflash`, the `esp`
toolchain — all present, and `cargo build` reaches the project's own code.

Suite: **592 passed, 0 skipped**.

## 47. Setup asked rustup for a target that only Espressif has (2026-10-05)

**The report.** *"i get this when building: `Setup did not finish: rustup exited with 1: error: toolchain
'stable-x86_64-unknown-linux-gnu' has no prebuilt artifacts available for target 'xtensa-esp32-none-elf'`"*

**The cause, and why it is embarrassing.** The catalog already knew: `rpTargets()` and `espTargets()` exist as
two functions precisely because *"the Xtensa triples are not rustup targets at all -- they only exist in
Espressif's fork of rustc, which espup installs -- so a plan that lumps them together asks rustup to do the
impossible."* That comment was written when the RP and ESP halves were split. The two **planners** were never
told: `planInstallation` and `planProjectSetup` both built `rustup target add <triple>` steps from
`options.targets`, which for an ESP project is that Xtensa triple. So an ESP32 project's setup ended in an error
that reads like a broken toolchain rather than a wrong plan, and the ESP toolchain — which is `espup`'s job,
with its own command — was never the thing being run.

**The fix.** `isRustupTarget(triple)` in `catalog.ts` (pure: everything except `xtensa-*`), and both planners
filter their target steps through it. Three tests: the predicate over both families, and a check that **both**
planners apply it — one site filtered and the other not is exactly how this survived the split in the first
place.

**What the user sees now.** Setup finishes instead of erroring. The ESP toolchain itself is still a separate
step — *Rusty: Install ESP Toolchain* (espup, a few hundred MB) — which is deliberate: that flow chooses targets
and sets up `~/export-esp.sh`, and the build path already names it when the linker is missing. Whether the setup
plan should *chain* into that command is a fair follow-up; what it must not do is ask rustup for a target rustup
cannot install, and now it does not.

**Still open from §46**: the ESP `display` template's own code does not compile (three defects), and the ESP
`blinky` template is the one to try first.

Suite: **593 passed, 0 skipped**.
