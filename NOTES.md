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




