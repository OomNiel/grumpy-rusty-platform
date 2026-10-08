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

## 48. The ESP display template compiles — found by building it, not by reading it (2026-10-05)

**How it went.** *"see the terminal for build error"* — the terminal is not something I can read, so I built the
user's project in its own directory instead. What came back was `build.rs`, which 0.0.17 had already fixed in the
template but not in their generated copy; with that unescaped, the build reached the crate's own code and failed
on three more things. All four are now fixed, and **a freshly generated Sunton project compiles with no warnings
(29.74 s)**, as does the user's own project (1.35 s, incremental).

**The four defects, in the order the build revealed them.**

1. `build.rs` escaped backticks in a Rust string (`\``) — Rust has no such escape. Fixed in the template by
   0.0.17; the user's generated copy still had it, so it was unescaped there too.
2. `let mut delay = Delay;` → `E0423`; esp-hal 1.2.2 has `Delay::new()` (a unit struct, not a value).
3. **esp-hal's `Spi` is a `SpiBus`; mipidsi wants a `SpiDevice`.** The template called `.with_cs(pin)` on the
   bus, which does not make one, and the compiler's `E0277` note pointed at the trait impl in
   **`embedded-hal-bus`** — a crate the template did not depend on at all. The fix is that crate's
   `ExclusiveDevice::new(bus, cs, delay)`: the bus without CS, the CS pin as an `Output`, and the device built
   from the two. `embedded-hal-bus = "0.3.0"` is now a dependency of the ESP display template (added with
   `cargo add` in the user's project first, to be sure the version resolves against Rust 1.95).
4. `Rgb565::RED`/`WHITE`/… → *"trait RgbColor which provides WHITE is implemented but not in scope"*; one
   missing `use embedded_graphics_core::pixelcolor::RgbColor;` produced nine errors.

**The lesson worth keeping.** Every one of these was found by **building** a generated project, and none of them
by reading it. `t3-golden` compares text against snapshots: it pinned `SpiInterface::new(spi, dc, &mut buffer)`
next to the wrong import for weeks without complaint, because both the snapshot and the generator agreed with
each other. A golden test proves the generator is *stable*, not that its output *works* — the compile check
belongs in the opt-in `t4-e2e` layer, which for the ESP families has evidently never been run. That is the real
gap this exposed, and it is now written down rather than implied.

**Also checked**: both ESP display boards share this template, and `mipidsi 0.10` does carry the T-QT's
controller, so the fix covers `lilygo-tqt` as well as `sunton-3248s035r` — the second board's *build* was not
run (it is a different chip, so it is a cold `esp-hal` build), and that is stated rather than assumed.

Suite: **593 passed, 0 skipped**.

## 49. The generated display projects were carrying a dead dependency (2026-10-05)

Found while checking the user's test project against what the extension generates now: `Cargo.toml`,
`build.rs`, `.cargo/config.toml`, `rust-toolchain.toml`, `.vscode/settings.json` and `README.md` were all
**byte-identical** to the current template, and `main.rs` differed only in rustfmt formatting and two
explanatory comments — but `display-interface-spi` was still declared in the dependency list and **not
referenced by a single line of generated code**. It became dead when the buffered interface replaced it (the
fix in §46), and the comment above it still described the old arrangement ("display-interface-spi is the glue
to esp-hal's SPI" — the glue is `embedded-hal-bus`). Both are gone: the dependency, and the stale sentence.

Nothing could have caught this by testing: an unused dependency compiles, links nothing into the image, and
warns about nothing. It is dead weight in every generated display project — two crates' worth of resolution
for a line that never appears in the code — and it was found by diffing a *real* project against the
generator, not by reading either.

Suite: **593 passed, 0 skipped**.

## 50. Every generated ESP app was silent — and the board proved it (2026-10-05)

**How it was found: by flashing one.** *"build the project and flash it to the board"* — so I did, with the
extension's own argv (`espflash flash --chip esp32 --port /dev/ttyUSB0 <elf>`). The flash succeeded, the board
reset, the second-stage bootloader reported `Loaded app from partition at offset 0x10000` … and then **nothing**.
Nothing for thirty seconds, with exactly one boot banner in the whole capture, so it was not boot-looping.

**The cause was in the template, and it was one missing line.** The generated `main.rs` calls `log::info!`
several times, and `.cargo/esp-config.toml` carefully sets `ESP_LOG = "info"` — but **no logger was ever
installed**. esp-println 0.18's own README is explicit: *"With the feature `log-04` activated … call
`init_logger(...)`"*, and its `logger.rs` offers `init_logger(level)` and `init_logger_from_env()`. The template
had `use esp_println as _;` (for the panic handler and `println!`) and nothing else, so every `log::info!` in
every generated ESP project was dropped on the floor. A perfectly healthy app looked dead.

**The fix**: `esp_println::logger::init_logger_from_env();` immediately after `esp_rtos::start(...)`, before the
first log line, with the `ESP_LOG` comment in `esp-config.toml` now saying what actually reads it. Ten snapshots
(five ESP boards × blinky/display).

**Verified on the real board, immediately after**: regenerate → `cargo build --release` → flash → monitor:

```
I (132) boot: Loaded app from partition at offset 0x10000
INFO - === blinky-sunton-3248s035r 0.1.0 starting ===
INFO - board: Sunton ESP32-3248S035R (3.5" CYD) (ESP32), 4 MB flash
INFO - panel ready: 3.5" ST7796 320x480
INFO - panel: red / green / blue / black / white   (cycling, repeatedly)
```

**Two things this settled beyond the bug.** The whole chain works end to end on this hardware — the extension
generates, the ESP toolchain builds, `espflash` writes, the chip boots it and the app runs. And
`panel ready: 3.5" ST7796 320x480` is the **board itself confirming its panel controller**, which the firmware
dump could never do: `mipidsi`'s `Builder::init()` only returns if the ST7796 answered its init sequence. The
question §(CYD findings) left open — "identify the exact display controller" — is answered by evidence rather
than by a guess.

**One side effect worth knowing about flashing this board**: `espflash flash <elf>` writes **its own bundled
bootloader and default partition table** in addition to the app (the chip now runs an ESP-IDF v6.1 bootloader
with a single `factory` partition, where the factory had v4.4.5 and six OTA partitions). That is espflash's
behaviour, not the extension's, and it is fully reversible: `espflash write-bin 0 0x400000 cyd-demo-backup.bin`
restores the whole 4 MB byte-for-byte, from a backup verified against this exact chip — a claim that was an
inference when this was written and was **tested** in §52, which restores it and compares the read-back.

Suite: **593 passed, 0 skipped**.

---

## 51. A diagnostic screen instead of a flat fill — and the mirror it found (2026-10-05)

*"Do the diagnostic patterns and also some basic text like 'Hello Grumpy!'"*

**Why patterns at all.** A panel that fills with a colour is not a panel that is *right*. The three things that
actually go wrong on a new panel — a cropped or shifted active area, a swapped colour order, a rotated image —
all look exactly like success when the test is one flat fill. A screen you can read answers all three without a
serial cable.

**What the display template now draws**, in order:

- a full-panel two-pixel frame at `(1, 1)` sized `320 - 2 × 480 - 2`, so a missing side is a cropped active area;
- four 24×24 corner markers — **red** top-left, **green** top-right, **blue** bottom-left, **white**
  bottom-right — so a shift is visible and measurable ("the red square is not in the corner, or is cut in half");
- five 56×60 bars, left to right **red, green, blue, black, white** — if red and blue trade places, the panel's
  colour order is the other one, and the comment says so: flip `ColorOrder` in the builder;
- a full-height and a full-width **yellow line through the centre**, from `320 / 2` and `480 / 2` rather than
  hard-coded numbers, so an off-centre cross means the active area does not start where the driver thinks;
- `"Hello Grumpy!"` in `FONT_10X20`, then six status lines in `FONT_6X10` naming the board, the chip, the size,
  the controller, the corner and bar conventions and the question to answer ("text upright? colours right?
  square blinking?"). The strings are what makes the screen self-describing — a support thread needs the photo
  to say what it is;
- one 24×24 square at `(8, 420)` that **blinks** white/black every 700 ms. It is the only moving pixel, and it
  sits clear of every diagnostic, so "the loop is alive" and "the picture is right" are two independent facts.

**The dependency had to change with it.** The template used `embedded-graphics-core = "0.4"` — the trait crate
mipidsi itself needs, which carries `DrawTarget` (`clear()`) but **none** of the drawing primitives. `Text`,
`Line`, `Rectangle`, `PrimitiveStyle` and the fonts live in the full `embedded-graphics` crate (0.8.2 here),
whose `prelude` re-exports `DrawTarget` and `RgbColor` as well. So the import block became
`use embedded_graphics::prelude::*;` plus `mono_font`, `primitives` and `text`, and the manifest now declares
`embedded-graphics = "0.8"` instead of `-core`. Declaring both would be two names for one crate — `-core` still
arrives transitively, as `embedded-graphics`' own dependency.

**Verified by building it and flashing it, in that order.**

```
    Compiling embedded-graphics v0.8.2
    Compiling blinky-sunton-3248s035r v0.1.0
    Finished `release` profile [optimized + debuginfo] target(s) in 9.37s
```

(clean, no warnings; the ELF is 2 113 884 bytes, and espflash reports `App/part. size: 116,464/4,128,768 bytes,
2.82%`, and 116 480 bytes after the orientation line was added). Then on the real board:

```
I (135) boot: Loaded app from partition at offset 0x10000
INFO - === blinky-sunton-3248s035r 0.1.0 starting ===
INFO - board: Sunton ESP32-3248S035R (3.5" CYD) (ESP32), 4 MB flash
INFO - panel ready: 3.5" ST7796 320x480
INFO - diagnostics drawn: frame, corners, 5 bars, cross and text
INFO - alive (tick 0)
```

**The screen then showed a mirror — and that is the whole point of drawing one.** *"The graphics and text is
rendering but the image is mirrored."* Not shifted, not cropped, not rotated: **mirrored**, with
`"Hello Grumpy!"` reading backwards, and the told-by-the-corner-markers answer was "red is top-right". A flat
fill would have reported nothing here, and a photograph of a single colour answers no question at all.

**The cause was not in the drawing; it was board data the template ignored.** The CYD's catalog entry has said
`mirrorX: true` since the board was added — *"the panel is wired for BGR and its X axis is mirrored relative to
the controller's default, both of which the board definition states outright"* — and the generator emitted
`colorOrder` while quietly dropping `mirrorX`/`mirrorY` on the floor. Two of the four panel facts were dead
data. mipidsi takes the other one through MADCTL rather than through coordinates, so the fix is one line in the
builder chain, with the coordinates untouched:

```rust
.orientation(Orientation::new().flip_horizontal())
```

`Orientation::new().flip_horizontal()` sets `mirrored`, which `MemoryMapping::from_orientation` turns into
`reverse_columns` and `SetAddressMode::with_orientation` writes as MADCTL's `MX` bit — the panel scans its
columns right-to-left, and mipidsi's own transform keeps `Point::new(0, 0)` in the corner you meant. The
generated line is emitted for **every** panel (a board that needs no flip says `Orientation::new()`), so the
import is never unused and the data path is visible in the code. A test now walks every board and every panel
and asserts the emitted flips equal the catalog's `mirrorX`/`mirrorY`, which is what would have caught the
drop on the day it happened.

**Confirmed on the real board after re-flashing**: red top-left, text reading normally, correct colours, and
the white square blinking in the bottom-right corner. The hardware therefore confirms the community board
definition's claim about this panel, which is a nice closing of the loop the firmware dump opened.

**The layout had to stop being CYD-shaped while this was being fixed.** The same template is offered to the
T-QT's 128×128 panel, where the CYD's numbers (bars from x=16 at 58 px pitch, a greetings baseline at y=104, a
blinking square at y=420) would put the text and the square off the glass. `espDiagnosticLayout()` now solves
the geometry from the panel: a `min(24, min(w,h)/8)` corner marker, bars fitted into `w - 2*margin`, the
greeting dropped from `FONT_10X20` to `FONT_6X10` under 200 px wide, and every band packed under the one
before it — corners, bars, greeting, status lines, blinking square — with status lines emitted **only if they
fit**. 320×480 gets all six lines; 128×128 gets one short one, and the test above asserts for every panel that
nothing is off the glass, nothing overlaps, and at least one status line fits.

**What the log proves and what it does not.** `panel ready` is `Builder::init()` returning, which only happens
if the ST7796 answered, and `diagnostics drawn` is the drawing calls returning without an SPI error — every one
of them is `.expect("panel write failed")`. The *pixels themselves* are the one thing I cannot see from here:
the screen is the user's to confirm, and that is why the status lines and the corner markers are on it. They
earned their keep on the first flash.

**The tests were tightened, not loosened.** `the panel template initialises the panel over its own pins` now
pins `use embedded_graphics::prelude::*;`, asserts the split crate is gone and pins the orientation line. Three
new cases carry the rest: one walks every board and every panel to check the emitted flips against the
catalog's `mirrorX`/`mirrorY` (the assertion that was missing when the data was dropped), one pins the frame
coordinates, corner colours, named bars, centred lines, greeting, blink and both fonts, and one checks the
solved layout for every panel — inside the frame, bands in order, nothing under the blinking square.

Suite: **596 passed, 0 skipped**.

---

## 52. The backup was tested as a backup: the factory image went back in (2026-10-05)

*"Finally, lets test flashing the factory firmware back to the board."*

**A dump is not a backup until it has been restored once.** §50 recorded that the flash was reversible
"byte-for-byte from a verified full-flash backup" — verified by checking the master image's hash and by
comparing it against what the chip held when it was taken. Neither of those is the same as **writing it back
and watching the board run it**, which is the only test that matters. So the order was: read the chip as it
stood, write the master image over it from offset 0, read the chip again, compare.

**Result: byte-for-byte identical.**

```
master  cyd-demo-backup.bin     sha256 dc4ce79f2011fdfe27216f801a625a7b82fa3c66f52bb43c75fc906b14093f63
before  cyd-before-restore.bin  sha256 04d886f81a421cf667a69bdf0578f8c0828ed3b96293cba4691ba1abeb7792ad
after   cyd-after-restore.bin   sha256 dc4ce79f2011fdfe27216f801a625a7b82fa3c66f52bb43c75fc906b14093f63
```

4 194 304 bytes in each, and `after == master` exactly. **141 898 bytes (3.38 % of the chip) differed before
the restore**, and they were only ever where espflash had written:

| region | range | differs | what it was |
|---|---|---|---|
| bootloader | `0x001000`-`0x008000` | 25 466 B (88.8 %) | espflash's ESP-IDF v6.1, not the factory Arduino one |
| partition table | `0x008000`-`0x009000` | 135 B (3.3 %) | one `factory` partition instead of six |
| app0 | `0x010000`-`0x015000` | 116 297 B (8.9 %) | the generated diagnostic app, 116 480 B of it |
| nvs, otadata, app1, spiffs, coredump | rest | **0 B** | untouched — including `otadata`, still pointing at `ota_0` |

That last row is the reason a restore is *complete* rather than merely plausible: espflash replaced the
bootloader, the partition table and the app, and left the factory NVS, OTA metadata, unused `app1`, SPIFFS and
coredump alone, so writing the master back cannot leave a mixture behind. Timings at `-B 921600` over the
CH340: read 61 s, write 52 s, read again 62 s (about 3 minutes for the whole round trip).

**And the chip runs it.** Monitor immediately after the restore:

```
rst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)
load:0x3fff0018,len:4 ... entry 0x400806a8
Hello Arduino! V8.3.11
I am LVGL_Arduino
Setup done
```

`Hello Arduino! V8.3.11` is the factory firmware's own banner — Arduino core 8.3.11 and the LVGL demo — and the
bootloader carries the string `/work/esp32-arduino-lib-buil…`, an Arduino build path rather than Espressif's,
so the bootloader running is the factory one too. The panel then showed the factory demo again, confirmed on
the hardware.

**What that does and does not prove.** The byte comparison proves the flash *content* matches the master image;
the boot log and the panel prove the chip actually *executes* it. Together they close the chain
backup → chip → backup → chip. Nothing about the board is non-factory now: the MAC and the calibration values
live in efuse, not flash, and were never written by any of this.

**Recorded where the image lives, not only here.** `/home/niel/Downloads/ESP32-035-board-backup/` now holds
`restore-factory-firmware.sh` (the whole procedure: read, write, read, compare) beside `verify-backup.sh` (the
read-only integrity check), the master image, and both dumps from this test — so the next person holding that
folder has the command, the check and the evidence for it. `NOTES.md` §50's reversibility claim now rests on
this instead of on an inference.

---

## 53. The health check was Raspberry Pi-shaped in both directions (2026-10-05)

**How it was found: the user pressed the button the previous message told them to press.** *"I get: Toolchain
needs attention: No debug probe detected. Connect…"* — on a Sunton CYD, a board with no SWD at all, whose
whole flash route is USB serial. The dialog was modal, offered "Install Missing Pieces", and said nothing
about the ESP toolchain the project actually needs.

**Two errors, in opposite directions.** `checkToolchain` collected its problems from the probe-rs half of the
world only:

- it pushed `status.probeDiagnosis.message` as a **problem** for *every* workspace, so an Xtensa project was
  told to connect a probe it cannot use (and could press a button that installs probe-rs and udev rules for a
  board that has no probe port); and
- it never treated the ESP toolchain as a problem at all — `espToolchainSummary` was printed to the output
  channel and then ignored, which was deliberate for an RP-only user but wrong in the other case: with the ESP
  project open, `espup`/`espflash` missing meant *nothing builds*, and the health check still called that fine.

**A dump of what the check saw on this machine**, before the fix: `probe-rs 0.32.0` installed, `probe-rs list`
empty (`none-connected`), `espup 0.18.0` + `espflash 4.6.0` installed. So the verdict was "no debug probe" —
the one thing that was not a problem — while the row and the tooltip never mentioned the toolchain that was
there and required.

**The decision moved into one pure module, `src/toolchain/health.ts`.** `healthReport({status, esp, family,
cargoOnShellPath})` answers the question once, and the sidebar row, the status-bar tooltip and the modal are
three renderings of that one answer — they cannot disagree any more, which is what the previous arrangement
allowed (the row came from `status.ready`, the modal from its own list, the tooltip from a third).

| | Raspberry Pi project | ESP project |
|---|---|---|
| no debug probe | **problem** ("Connect a Debug Probe or picoprobe") | not mentioned at all |
| probe-rs missing | problem, install offered | not mentioned (espflash monitors over serial) |
| probe firmware outdated | problem, update offered | not mentioned |
| rustup targets missing | problem, install offered | ignored — Xtensa targets come from espup |
| ESP toolchain missing | note in the log only (an RP user does not need it) | **problem**, "Install ESP Toolchain…" offered |
| cargo missing / not on the shell PATH | problem | problem (shared) |

`family` comes from the same `detectBoardFromProject` answer the Build and Flash buttons act on, so the health
row cannot report for one board while the controls flash another. With no project open the old, safe reading is
kept: report the probe-rs side, and the ESP toolchain as a line rather than a fault.

**Measured on the real thing** — the compiled extension's own modules, run against the actual project folder
and the actual machine:

```
board detected : sunton-3248s035r | Sunton ESP32-3248S035R (3.5" CYD) | kind: esp
probe diagnosis: none-connected - No debug probe detected. Connect a Debug Probe or picoprobe.
problems       : []
actions        : []
modal shown?   : NO ("toolchain looks good")
sidebar row    : Rusty: ready / cargo 1.99.0 · esp ready (0.18.0, 4.6.0)
--- and for comparison, the same machine with a Pico project open ---
RP problems    : ["No debug probe detected. Connect a Debug Probe or picoprobe."]
```

**Two smaller things in the same direction, found while fixing it.**

- **Monitor on an ESP project asked for probe-rs.** `withProject` passed `needsProbeRs: purpose === 'monitor'`
  regardless of family, so a machine without probe-rs would have been offered a probe-rs install before
  running `espflash monitor` — which does not use probe-rs. It is now `purpose === 'monitor' &&
  board.kind !== 'esp'`.
- **The verdict could not change when the project did.** The health input was computed once at activation, so
  opening the CYD project in a window that had started on a Pico project left the row answering for the Pico.
  `onDidChangeWorkspaceFolders` now re-detects.

**A blank dialog was fixed on the way past.** For a probe that is merely not plugged in there is nothing to
install, so the report offers no action — previously the only button was "Install Missing Pieces", which
answered "Nothing to install — the toolchain is complete", a round trip that taught the user the button does
not work.

Tests: a new t1 file (`toolchain-health.test.js`) pins the whole table above, both delimiter shapes for the
PATH check, and the no-project fallback; `controls.test.js` gained the regression case — an ESP project with no
probe is `ready`, the same machine with a Pico project warns, and an RP-only user is never shown `espup`.
Suite: **606 passed, 0 skipped**.

---

## 54. Flashing from the extension wrote a debug build, and on an ESP that costs 29 seconds (2026-10-05)

*"The flash was successful, but the lcd now renders much slower than the first flash you did."* — and the first
flash was mine, made with `cargo build --release`.

**The extension's Flash button built the `debug` profile.** `FLASH_PROFILE = 'debug'` is deliberate and
documented: *"When clicking on the 'Debug' button, the user expects the system to run a debug build so that
break points can be set at will"* — so Flash writes the same build a probe-rs session loads, and the chip check
stops reporting a permanent mismatch. That rule has a **subject only on Raspberry Pi**. An Xtensa chip is
flashed over USB serial, has no session at all (`Debug` there is flash + monitor), and the no-flash debug
entries that read `LAST_FLASHED_KEY` do not exist for it. The cost was paid for nothing:

```
target/xtensa-esp32-none-elf/debug/…     11 248 300 bytes   (written by the Flash button)
target/xtensa-esp32-none-elf/release/…    2 113 856 bytes   (written by hand)
```

**Measured on the board, by the app itself** — the template now times its own drawing, so this is a number the
device prints rather than an inference:

| | `diagnostics drawn in …` | blink loop period |
|---|---|---|
| release | **221 ms** | 699.8 ms |
| debug | **28 834 ms** | 735.4 ms |

Cross-checked against the arrival times of the log lines on the serial port, which is independent of the
device's own clock: `panel ready` → `diagnostics drawn` was **29.43 s** for the debug build and **0.223 s** for
the release one. The same source, ~130x.

**What was actually slow, and what was not.** The initial paint — a full-screen `clear()` plus the frame, the
corners, the bars, the cross and the text, about 183 000 pixels — is what the user saw, and any full-screen
redraw in their own drawing would be the same. The blinking square was fine: 576 pixels, **+35 ms** on top of a
700 ms sleep, which is why the loop period barely moved (699.8 → 735.4 ms). Worth stating precisely, because
"the panel is slow" points at the wrong place otherwise: it is the *pixels written*, not the panel or the SPI
clock, and the debug build's per-pixel path costs about 157 µs against about 1.2 µs optimised.

**The fix is one function, and the extension already disagreed with itself about it.** `flashProfileFor(board)`
returns `release` for an ESP board and `debug` for everything else, and every write-the-chip site goes through
it — the ESP serial route and the probe route, plus the UF2 route (which is Raspberry Pi only and stays on
`debug`). What it makes consistent: **"Publish .deb" has always built `cargo build --release`**, so the same
project flashed two ways had two performance levels, and only one of them was the one the user experiences on
the glass.

**And the app now says how long it took.** The generated display template brackets its drawing with
`embassy_time::Instant` (no new dependency — the `embassy_time` import was already there for the 700 ms timer)
and logs `diagnostics drawn in {} ms: …`. That is what turned this report into a measurement in one flash
instead of a guess, and it is the line to look at first for anyone whose own drawing feels slow: if the number
is in the thousands, it is a debug build.

Tests: `flash-route.test.js` pins the profile rule (ESP → release, RP → debug, unknown → debug) and the
generated-template test pins the timing line. Suite: **607 passed, 0 skipped**.

---

## 55. The profile became the user's choice, not the extension's (2026-10-05)

*"There should be a switch option or an additional control button. Something like 'Flash with debug profile'
and 'Flash with release profile'."* — the right answer to §54: `auto` is a good default but it is still a
guess about what the user is doing, and the extension should not be the one deciding whether they meant to
step through the code or to watch a finished screen.

**Both halves of the request, because they are two different things.** A *switch option* is a standing
preference — that is a setting. An *additional control button* is a decision made once, in the moment — that
is a button. Making the buttons mutate the setting would have been the trap here: a control that quietly
rewrites a configuration is worse than no control, because the next flash does something the user did not ask
for and cannot see.

**`rustyPlatform.flashProfile`** — `auto` (default), `debug`, `release` — is read at flash time, so a change
applies to the next flash without a reload. `auto` is the only branch that consults the board:

| setting | RP board | ESP board |
|---|---|---|
| `auto` (default) | `debug` | `release` |
| `debug` | `debug` | `debug` |
| `release` | `release` | `release` |

**Two new controls**, sidebar-only so the status bar keeps its six rows: **Flash (debug)** and **Flash
(release)**, each building and writing exactly like Flash with the profile chosen for that one flash. All
three entry points now run the same `flashProject()` — the routing (serial for ESP, probe or UF2 for RP) used
to be written out inline at one call site, and two more call sites each re-implementing it would have been two
more places to forget a fix.

**What the user is told, in the output channel rather than a dialog.** A deliberate choice that costs
something says so once, because the cost is real and invisible until the screen goes slow:

```
flash: profile debug (chosen) for sunton-3248s035r
flash: a debug build paints a panel far slower than a release one — 28 834 ms against 221 ms for
       the generated display screen on a 3.5" CYD, measured 2026-10-05 (NOTES 54). The chip is still
       debuggable over JTAG, which needs separate hardware.
```

and the mirror image when a Pi board is sent a release build (*"breakpoints in a probe-rs session will be
hollow"*). `auto` prints nothing — the extension does not argue with its own recommendation. The chosen
profile is also what gets recorded for the no-flash debug entries, so the chip check still compares like with
like.

**Choosing is one function, so it can be tested as one.** `flashProfileFor(board, choice)` takes the choice
and falls back to the board, `parseFlashProfileChoice` turns whatever the settings file contains into one of
the three (anything unrecognised means `auto`, because settings are strings and users are users), and
`profileWarnings` decides what a choice costs. The t1 layer pins all three: every board × every choice,
`undefined`/`null`/`''`/`'Debug'`/`'RELEASE'`/`0`/`{}` all landing on `auto`, and the warning text for the two
cases that have one.

The sidebar now reads:

```
$(chip) Rusty               check the toolchain
$(tools) Build              cargo build
$(zap) Flash                write the board
$(debug-alt) Debug          build, flash, debug
$(output) Monitor           defmt over RTT
$(trash) Clean              cargo clean
$(bug) Flash (debug)        debug build, then flash
$(rocket) Flash (release)   release build, then flash
$(package) Publish .deb     firmware + flash helper into the project root
$(archive) Back Up Project  a dated copy in the parent folder
$(desktop-download) Install .deb
```

Suite: **611 passed, 0 skipped**.

---

## 56. Three controls were describing the wrong board (2026-10-05)

*"Make the row board-aware too."* — the wart named at the end of §55: the Controls section said **Monitor —
defmt over RTT / `probe-rs attach`** and **Debug — build, flash, debug / a probe-rs debug session with RTT** on
an ESP project, where Monitor runs `espflash monitor` and Debug has no breakpoints at all.

`visibleControls(sessionRunning, family)` now words the three controls that describe a *route* — Flash, Debug
and Monitor — for the family, and both views hand in `state.family` (the same detection the health row and the
buttons use). **Captions do not move**: `$(output) Monitor` is what the status bar shows and what the user has
learned to press, so only the grey line and the tooltip change. With an ESP project open:

```
$(zap) Flash       write the board
$(debug-alt) Debug flash, then the log
$(output) Monitor  the serial log
```

and their tooltips now say `espflash`/USB serial, "No breakpoints: Xtensa is debugged over JTAG", and
"`espflash monitor` — the log over the same serial port the flash used, without writing anything". A project
that cannot be identified keeps the wording every line was written for, because a project we cannot identify
should not be described as if we had.

The status bar repaints only tooltips — its items are created once from the labels, so the family affects the
hover text and nothing else. Tests pin that the row list and captions are identical across families, that the
three route rows differ in the expected words, and that the board-neutral rows are untouched.

Suite: **612 passed, 0 skipped**.

---

## 57. The touch screen: a working SPI conversation with an analog side that never answers (2026-10-05)

*"Next we must test the touch screen functionality."* — this one ends in an honest negative, and the negative is
worth as much as a positive would have been: **the generated touch firmware has never seen a single real
touch, because this unit's controller never reports one.**

**What was built.** A third ESP template, `touch`, offered only for a board with a touch controller (the CYD's
data has `touch: { controller: 'XPT2046', cs: 33, irq: 36, spiHz: 2 MHz }`): panel bring-up plus a four-corner
calibration the user carries out on the glass, then a crosshair at the mapped position, with the raw frames,
the measured calibration and the mapped pixel all going to the serial log. The panel bring-up itself moved into
`espPanelSetup(display, shared)`, used by both templates — the touch case shares the SPI bus, so the bus lives
in a `RefCell` and each chip gets its own `RefCellDevice` with its own CS pin. One crate was added
(`embedded-hal`, so the read helper can be generic over `SpiDevice`).

**What the protocol work established, all of it on this hardware:**

1. **The controller answers one command behind.** The 12 bits of a conversion come back during the *next*
   command's clocks: high byte first, then the low nibble in the top half of the second byte. Decoding it the
   way the common Arduino driver does (`>> 3`) gives values eight times too small — the first corner read back
   as **14 counts instead of 2050**.
2. **PENIRQ is only enabled by the power-down bits.** `PD=00` is the only setting that leaves the interrupt
   enabled between conversions, which is why the reference driver ends each burst with a `PD=00` command
   (`0xD0`). The first firmware here used `PD=01` bytes throughout and the interrupt line was silent by design.
3. **The interrupt line is not usable on this board anyway.** With `PD=00` in place, GPIO36 still reads low at
   random with nothing anywhere near the glass — and the *first* version of the template trusted it. The result
   was a calibration that walked itself through all four corners while nobody was touching anything, ending with
   a crosshair pinned to the centre. A touch is now the **axes moving** from a baseline measured at boot; the
   interrupt is logged and never trusted. (The user's report was exactly right: *"The red block moved without
   me touching the screen."*)

**What the hardware said, and the reason this is unfinished.** A scratch bring-up build logged every channel's
raw frames, idle and with a finger pressed firmly on the glass for five seconds:

```
                    Z1           Z2           X            Y
idle      raw=8000 nb=2048   raw=807F nb=2055   raw=807F/8000   raw=8073/807F
pressed   raw=8000 nb=2048   raw=807F nb=2055   raw=807F/8000   raw=8073/807F
```

Byte for byte the same. The chip is *answering* — the values are reproducible, they change with the channel
selected, and they jitter by the ~7 counts you expect from an ADC — but they sit at mid-scale (2048/2055)
whatever happens to the glass, and the pressure figure is therefore meaningless. The interrupt stays high. The
conclusion is that the SPI side of the conversation works and the **analog side never receives the touch**: the
four-wire membrane is not reaching the controller's ADC on this unit. No firmware change can fix that, and the
two things to check are physical: the touch flex's seating on the back of the panel, and whether the panel
really is the resistive variant (the family ships as `…S035R` and `…S035C`; the capacitive one uses a GT911 on
I2C — SDA 33, SCL 32, reset 25, interrupt 21 — and would read as a silent XPT2046, since its own pin 33 role
is different).

**The pins and the mode are not the problem.** Two independent configurations for this exact board family agree
with the board data and with each other: CS 33, interrupt 36, MISO 12, MOSI 13, SCLK 14, SPI mode 0, 2 MHz,
and a touch threshold in the hundreds. That is what the generated code uses.

**So the state of the feature is: written, tested as code, never verified as hardware.** The `touch` template
is offered for the CYD and the tests pin its shape — the shared bus, the pins from board data, the three
control bytes, the nibble decode, the four-corner calibration, and the rule that the interrupt alone is not a
touch. Everything downstream of "the axes move" is unproven, which is stated in the template's own comment and
in the test file's header rather than left for someone to discover.

Suite: **616 passed, 0 skipped**.

---

## 58. The touch screen works: the fault was a missing gap between the command byte and the data (2026-10-06)

§57 concluded, wrongly, that this was a hardware problem. It was firmware, and the measurement that proved it was
a **pin sweep by bit-banging**:

```
miso 12  cs25 x=0000 y=0000   cs33 x=F87F y=F816     idle
miso 12  cs25 x=0000 y=0000   cs33 x=6031 y=984D     finger pressed
miso 12  cs25 x=0000 y=0000   cs33 x=6842 y=0044     finger pressed
miso 32  ...                  cs33 x=FFFF y=FFFF     a constant, not data
```

So the controller is on **CS 33** with its data on **GPIO12** — the pins the board data always had — and it answers
to touch. (The module-pin reading agrees: module pin 9 is GPIO33 and pin 4 is GPIO36.) An earlier hand tracing
suggested CS 25 / IRQ 39; the sweep selected nothing on 25 and read flat on 39, so the measurement stood.

**What was actually wrong: `transfer_in_place` clocked the command byte and the two data bytes back to back.**
The XPT2046 needs its conversion time between them. Read that way every channel came back at mid-scale
(2048/2055) and never moved, at every clock from 2 MHz down to 100 kHz — the rate sweep, with the panel live,
held nothing else constant:

```
rate 2000 kHz  a=2048 b=2054      rate  250 kHz  a=2048 b=2054
rate 1000 kHz  a=2048 b=2054      rate  150 kHz  a=2048 b=2054
rate  500 kHz  a=2048 b=2054      rate  100 kHz  a=2048 b=2054
```

The panel was innocent too: a before/after test around `Builder::init` read the same mid-scale values either side,
so this was never about the shared bus being left in a bad state.

The fix is one transaction per frame with the conversion time explicit between the two halves, which is what
`Operation::DelayNs` is for — and it also explains why the bit-banged probe worked while the peripheral did not:
software toggling of SCLK leaves gaping holes between bytes, which is exactly what the controller wanted.

```rust
device.transaction(&mut [
    Operation::Write(&[command]),
    Operation::DelayNs(TOUCH_SETTLE_NS),
    Operation::Read(&mut frame),
])
```

The settle time is **20 µs** rather than the 2 µs the conversion nominally takes: at 2 µs the first sample after
a channel change still came back as zero. `touch_axis` also consumes two frames before it starts averaging —
the first is the previous channel's leftover, the second the same channel's earlier conversion — which is what
stops the average being dragged towards zero.

**Confirmed on the board.** The four-corner calibration completed, and it is a real measurement rather than a
guess (these are the numbers that came back from this panel):

```
calibration: raw axis0 1826..298 and axis1 1875..202 over 320x480
touch: a=1846 b=202 -> pixel (21, 456)
```

Idle, channel A sits at 0 and channel B around 1696; a touch pulls them to positions in the thousands. The
panel shows the live readout — raw pair and mapped x/y in the middle of the screen, refreshed while the finger
moves — which is what was asked for, and the same numbers go to the log.

Suite: **616 passed, 0 skipped**.

---

## 59. The board is not a Sunton, and the reference repo settles the wiring (2026-10-06)

*"The board we are working on is not a 'Sunton' original CYD board. It is a clone I got from TEMU with markings:
TZT, 3.5 TFT, 60721. The board's only text is: ESP32-035."*

**Renamed to `ESP32-035 LCD Panel`**, vendor `unidentified (TZT clone, sold as ESP32-035)`. The board id stays
`sunton-3248s035r` for now — it is what the snapshot directory names and the `defaultBoard` setting use — and
renaming that is a separate, mechanical change rather than something to smuggle into this one.

**The wiring is confirmed, and it agrees with what the measurements said.** The
[ESP32-035 project](https://github.com/littleCdev/ESP32-035) documents this exact board pin by pin:

| | confirmed |
|---|---|
| XPT2046 | CS 33, PENIRQ 36, DOUT 12, DIN 13, DCLK 14 — shared with the panel's SPI bus |
| **BUSY** | **not connected** |
| Panel | CS 15, DC 2, SCLK 14, MOSI 13, MISO 12, reset 3 (enable, tied to +3V), backlight through a transistor on 27 |
| TF card | CS 5, CLK 18, CMD 23, DAT0 19 |
| RGB LED | blue 16, red 4, green 17 |

Two things follow. First, **the touch pins we settled on are right** (33/36), which the bit-banged sweep had
already shown and a hand tracing had contradicted. Second, **the BUSY pin really is unwired** — so waiting a fixed
conversion time (NOTES §58) is not a workaround for an unused signal, it is the only option this board offers.
Had BUSY been wired, the driver would poll it instead.

**A pin error this corrected: the TF card.** The community definition had MOSI on 19 and the panel's MISO shared
on 12. In SPI mode the card's CMD is its data *in* and DAT0 its data *out*, so MOSI is **23** and MISO is **19**.
The catalog now says so, with the reason.

**One more thing the reference explains**: this board's USB-C connector has no 5k1 CC pulldowns, so it only works
with a USB-C-to-USB-A cable or an adapter. Worth knowing before blaming a cable — and worth a line in the
generated README.

### The template the user wants for this board

*"My goal with this extension is to create templates for the various boards that the user can select from… For
this board, I need a template that will include all the libraries to enable functionality for…"*

| | feature | state |
|---|---|---|
| a | LCD display | **done** — the `display` template, verified on the glass |
| b | touch control | **works** (NOTES §58); the calibration screen is the next piece of work |
| c | TF card | not started — pins now correct (5/23/18/19) |
| d | Wi-Fi and Bluetooth | not started — `wifi` is not offered for ESP boards at all yet |
| e | RGB onboard LED | not started — needs a new LED kind in the board data (three pins), not just one |
| f | LDR onboard sensor | not started — the ADC pin is still to be identified on this clone |
| g | sound on the speaker connector | not started — the amplifier's data pin is still to be identified |

Two of those (f and g) cannot be written from documentation alone: this clone's LDR and speaker amplifier are not
in the reference repo's tables, so they need the same treatment the touch pins got — trace or measure, then
encode. The rest have their pins.

### Also asked, and not yet done

- **Controls: "Add a 'Build for Debug' and 'Build for Release' buttons and remove the current Debug one."** Not
  started. It is a contained change — two commands that run `cargo build` and `cargo build --release`, the
  `Debug` row out of the control list, and the tests that pin that list updated — and the `Debug` *command* should
  stay in the palette, since flash-and-monitor is genuinely useful on a chip with no breakpoints.
- **The touch calibration routine**, for when a user enables touch: a calibration screen with crosshairs in red
  corner blocks, the four touches recorded and stored, then the screen returning to the graphics test screen.

Suite: **616 passed, 0 skipped**.

---

## 60. The controls say what they build (2026-10-06)

*"Add a 'Build for Debug' and 'Build for Release' buttons to the Controls and remove the current Debug one."*

The single **Build** row and the **Debug** row are gone from the controls; in their place:

```
$(tools)  Build for Debug     cargo build
$(rocket) Build for Release   cargo build --release
```

Both rows and the status bar keep the same number of items as before, and the two commands are the honest pair
of what `cargo` can build: the debug profile is the one a probe-rs session can step through, release is what a
finished device runs (and what Flash writes for an ESP board, per NOTES §54).

**`rustyPlatform.debug` is still a command.** Removing a *row* is not removing the feature: on an ESP board Debug
is the only button that flashes and follows the log in one terminal, and it stays in the palette for that. What
went with the row is the board-aware wording for it — the fact that Xtensa has no breakpoints is already in the
generated README and in the message the command itself shows.

`rustyPlatform.build` also stays registered for the palette and for anyone who bound it in a keybinding; the two
new commands are what the controls run.

Suite: **616 passed, 0 skipped**.

---

## 61. The calibration screen (2026-10-06)

*"Implement a touch calibration function where the user is shown a touch calibration screen. The[n] after
touching the crosshairs in the red corner blocks, the touch calibration values are stored and the screen
returns to the original graphics test screen."*

What the panel does now, in order:

1. **Calibration screen.** A 44 px red block in each corner, each with a crosshair in it; the corner being
   asked for is lit and the others dimmed, with its name printed at the top ("top-left", then "top-right",
   "bottom-right", "bottom-left"). The live raw pair is on screen throughout, so a user can see that the
   controller is responding before they have finished.
2. **Four touches recorded**, each logged with its raw frames.
3. **The values are stored** — applied from that moment and kept in the firmware's state. Writing them to flash
   is the one part deliberately left out (see below).
4. **The screen returns to the graphics test**: frame, four coloured corner markers, five bars, the centred
   cross, the live raw/mapped numbers in the middle and a touch marker.

Measured on the board, first run:

```
corner 1 top-left     a=1794 b=1873      corner 3 bottom-right a=241  b=210
corner 2 top-right    a=238  b=1873      corner 4 bottom-left  a=1809 b=210
calibration: raw axis0 1794..238 and axis1 1873..210 over 320x480
touch: a=1809 b=210 -> pixel (22, 456)
```

**Why the values are in RAM and not yet in flash.** `esp-storage` is already in the tree (0.10.0, as a
transitive dependency of the bootloader crate) and its `erase`/`write_nor`/`read_nor` are the API for this, but
two things have to be right before I would write flash from a running embassy app: the constructor for
`FlashStorage` needs confirming in 0.10 (the only `new()` I found is the emulation variant), and a flash write
disables the cache, so an interrupt that runs code from flash during the write is a crash. That needs its own
round of verification on the bench, not a hopeful commit. So the calibration survives until reset today, and the
sector it will live in is chosen: the last 4 KB of the application partition (the app image is ~120 KB of a 4 MB
partition), which is ours rather than the NVS the bootloader may care about.

**One build bug worth remembering**: the fixed text buffer was originally called `Line`, which shadowed
embedded-graphics' `Line` and made every crosshair call the wrong constructor. It is `Numbers` now. That is the
same class of mistake as the generator's backtick trap — a generated template inherits every name it imports,
so its own types must not be called after them.

Suite: **616 passed, 0 skipped**.

---

## 62. The LDR is on GPIO34 (2026-10-06)

*"LDR routed to pin 6 of the esp module."* Module pin 6 is **GPIO34**, which is ADC1 channel 6 — and GPIO34-39
are input-only with **no internal pull-ups**, which is exactly what a light-dependent resistor wants: it has to
be one half of a divider (against 3.3V or GND) rather than read as a digital input with a pull.

So the pin is recorded now, as `ldr: { pin: '34' }` on the board, together with the reason it is worth a type of
its own rather than a bare number: the pin decides *which ADC channel* the reading comes from, and whether it can
be read at all. **Reading it is not done**: it needs the ADC API rather than a GPIO, and I did not have the
remaining budget to pin down where esp-hal 1.2 exposes it (`esp_hal::adc` is not in the module list I could
grep, so it may be behind the `unstable` feature or named differently in this release). That verification is the
first step of the template that uses it, not something to guess at from memory.

That leaves **one** pin on the user's feature list still unidentified: the **speaker connector's** data pin.

Suite: **616 passed, 0 skipped**.

---

## 63. The speaker is on GPIO26, which is a DAC (2026-10-06)

*"Speaker connects to a chip LTK8002D pins 5 and 8. Chip connects to esp module pin 11 via 4k7 res."*

Module pin 11 is **GPIO26** — and that is the fact that matters, because on an ESP32 GPIO25 and GPIO26 are the
two **DAC** channels. So this board's sound is an analogue waveform straight out of the DAC, not a PWM pin that
needs an RC filter: the template that drives it is a different shape from the usual "tone() on a digital pin"
recipe, and the difference is recorded rather than left for whoever writes it to discover.

The rest of the chain, as traced:

```
ESP32 GPIO26 ── 4k7 ── LTK8002D input
                        LTK8002D pins 5, 8 ── speaker connector
```

The **LTK8002D** is an LM4871-family 3 W bridge amplifier: pins 5 and 8 are its two *bridged* outputs, so
neither speaker terminal is ground — which is why a speaker across them must not be grounded on one side. No
shutdown pin was traced, so the amplifier is assumed to be enabled whenever the board has power.

**That completes the wiring for every feature on the user's list.** All seven now have their pins in the board
data, so what remains is templates and code rather than measurements:

| | feature | wiring | template |
|---|---|---|---|
| a | LCD | ST7796, SPI2 15/2/14/13/12, backlight 27 | **done, verified** |
| b | touch | XPT2046 CS 33 / PENIRQ 36 / 12/13/14, BUSY unwired | **done, verified, with calibration** |
| c | TF card | CS 5, CLK 18, MOSI 23, MISO 19 | to write |
| d | Wi-Fi + BT | on-chip radio | to write (ESP has no `wifi` template at all yet) |
| e | RGB LED | red 4, green 17, blue 16 | **done** (blinky) |
| f | LDR | GPIO34 (ADC1 ch6), 5k to 3.3V, lower leg | to write |
| g | speaker | GPIO26 (DAC2) through 4k7 into an LTK8002D | to write |

Two API questions remain, both of which I refused to guess at: where esp-hal 1.2 exposes the **ADC** (for the
LDR) and the **DAC** (for the speaker) — neither module was where I expected it in the source I could read, and
both may sit behind the `unstable` feature. Confirming those two is the first step of the sensor/sound
templates, not the last.

Suite: **616 passed, 0 skipped**.

---

## 64. The calibration survives a power cycle, and the ADC panic that hid behind it (2026-10-06)

**The persistence test, on the board, in one capture:**

```
calibration: none stored                                        <- a fresh sector
touch: corner 1 top-left recorded   ... corner 4 bottom-left    <- the four touches
calibration: raw axis0 1806..286 and axis1 1884..213 over 320x480
calibration: stored in flash                                    <- written
   (reset)
calibration: loaded from flash - axis0 1806..286 1884..213      <- read back, same numbers
```

So the record written to `0xF3F000` comes back byte for byte after a reset, and a calibrated panel boots straight
into the graphics test screen instead of asking for the corners again.

**But the first run of the board template died, and the symptom was "touch not responding".** The real cause was
a panic two lines further in:

```
panicked at src/main.rs:591: adc read: WouldBlock
```

`Adc::read_oneshot` is non-blocking: it reports `WouldBlock` while a conversion is in flight, and it does so on
the *first* read after boot. An `.expect()` there killed the whole firmware — including the touch loop, which had
nothing to do with the ADC. Both templates now retry a bounded fifty times and log a warning if the ADC never
becomes ready, rather than taking the app down.

That is the second time in this board's work that a single wrong assumption about a peripheral's *readiness* cost
a whole debugging round (the first was the touch controller's conversion time). The lesson is the same both
times: a peripheral is not ready when it is created, and "not ready yet" is a state to handle rather than an
error to assert on.

**One thing the log also shows and does not yet explain: the light sensor reads 0 of 4095, constantly.** With
3.3V - 5k - GPIO34 - LDR - GND, a working divider cannot sit at exactly zero in a lit room, so either GPIO34 is
not the divider's midpoint on this unit, or the 5k/3.3V side is not connected. That is the next measurement, and
it is the same shape as the touch pins: a traced pin that the data then has to agree with.

---

## 65. The readout is cleared before it is drawn, and a standing rule (2026-10-06)

*"The live touch reading over-write each other without clearing the old values. Delete the old values first
(without redrawing the whole screen!)"*

He was right, and the reason is worth writing down: the numbers change **length** as a finger moves
(`raw a=0 b=0` is two characters shorter than `raw a=1806 b=286`), so each reading was drawn over the tail of the
one before it. The fix is confined to the box — no full-screen clear — and the *order* matters:

```rust
Rectangle::new(box).into_styled(PrimitiveStyle::with_fill(Rgb565::BLACK))   // the interior
Rectangle::new(box).into_styled(PrimitiveStyle::with_stroke(border, 2))     // then the border
```

Filling first and stroking second keeps the border whole; the other order erases half its width, which is the
kind of thing that would have looked almost right.

**The standing rule, recorded because he asked for it as a rule:**

> Never choose the easy way to implement something new. Always do it the correct way.

That is now the tie-breaker for every judgement call in this repository, and it is already visible in the work:
the touch pins were settled by sweeping every candidate rather than by trusting a published table; the
calibration is measured on the panel rather than assumed from a datasheet; the board template is the touch
template *plus* the hardware rather than a copy of it; and the readout above clears its interior rather than
redrawing a screen it did not need to. Where "correct" costs more than "easy", it is the one to take, and where
it is genuinely not affordable yet the honest answer is to say so and leave it open rather than to fake it.

---

## 66. The beep that could never happen (2026-10-06)

*"I can hear a sharp click when the system reset and then a very faint white noise hiss. No Beeps."*

The click and the hiss were the amplifier telling the truth: it was powered, enabled, and amplifying — there was
simply nothing to amplify. **The beep lived only inside the corner-recording branch, and the calibration now
lives in flash**, so after the first successful calibration the corners are never recorded again and the speaker
was never asked to make a sound. A feature on a path that stops running cannot be tested by using the thing it
belongs to, and it had been "verified" by nothing but the compiler.

The fix is one shared definition of what a beep is, used twice:

- **any touch** → a short 40 ms reply, which is what makes the speaker testable without a calibration run;
- **a recorded corner** → a longer 200 ms confirmation, unchanged in intent.

It is a macro rather than a function because it borrows the DAC — whose type is not worth naming — and because it
awaits; and it is one definition because two copies of a waveform is how the two ends up sounding different.

**Confirmed on the board**: touching the screen beeps.

Three small facts from the same message that were right and are now written down: the click at reset is the DAC's
DC step into the amplifier, the hiss is the amplifier with nothing to amplify, and both are what a *working*
analogue path sounds like when its input is idle.

Suite: **618 passed, 0 skipped**.

---

## 67. The LDR's divider is not a divider on this board (2026-10-06)

*"It looks like the board have a design fault — both the divider resistor and the LDR have their other ends wired
to Gnd. Leave your code for the time being — I will dig deeper. The pin assignment is correct."*

The intended circuit is `3.3V — 5k — node — LDR — GND`, where the node is the ADC pin. If the 5k's far end is
*also* on ground, then the node hangs off `5k ∥ LDR` to ground and cannot rise above 0 V whatever the light does.
That is exactly what the firmware reported: **a constant, exact `0 of 4095`** — not a small noisy figure hovering
near the bottom of the range, which is what a live but badly-scaled divider looks like.

So the measurement was right and the firmware was right; the board is not. This is a **hardware finding, not a
code one**, and no code is changed for it: the LDR half of the `peripherals` and `board` templates stays exactly
as written, because it is the correct code for the circuit the board is supposed to have — pin, channel,
attenuation and polarity all confirmed. When the divider is fixed (or the fault turns out to be a solder bridge
rather than the layout) the same firmware should read a real value with no change.

**Also recorded: the pin assignment is confirmed correct** — module pin 6 = GPIO34 = ADC1 channel 6 — which the
user checked by hand. The constant zero was never a wrong-pin symptom: a wrong pin on a floating input-only line
reads noise, and this read was exactly zero.

Worth keeping as a diagnostic lesson, next to §64's "a peripheral is not ready when it is created": **an exact
value is evidence**. `0` and `4095` are not measurements of an input, they are statements about the wiring, and
the useful move is to believe them rather than to go looking in the code.

---

## 68. The board's own LDR example, found online (2026-10-06)

*"Scan the internet for any reference to this issue."*

The reference repository for this board carries **`examples/Basics/5-LDRTest/5-LDRTest.ino`**, and it settles two
things that were assumptions until now:

```c
#define LDR_PIN 34
...
// Sensor reading values:
// 0 is full brightness, higher values == darker
analogSetAttenuation(ADC_0db);
```

1. **The pin is GPIO34** — the same pin the catalog has had since the user traced it, now confirmed by the board's
   own example.
2. **The polarity is "0 is full brightness, higher values are darker"** — exactly what our log says ("brighter
   light reads lower on this board") and what the code documents. An independent confirmation of the sense of the
   divider: the LDR is the lower leg.

**A difference worth noting rather than copying:** the example uses `ADC_0db` (roughly a 1.1V full scale) where our
template uses 11 dB (3.3V). 0 dB gives finer resolution at the bright end but clips as soon as the node passes
~1.1V — that is, in dim light — and the example's own comment admits *"I find this does not work that reliably"*.
For a template that should show the whole range, 11 dB is the right default; if the readings turn out to be coarse
in normal room light once the divider is fixed, the middle setting (6 dB) is the next thing to try rather than
clipping the top of the range.

**No reference anywhere to the fault on this unit.** Nothing in the board's repository, its hardware notes
(which have no LDR row at all — the divider is undocumented, which is why it had to be traced), the Arduino
forum's CYD LDR thread, or any other search hit describes a board whose divider is grounded at both ends. The
nearest data points are the opposite: the official example exists because the sensor works on the board it was
written for, and a
[CYD LDR thread](https://forum.arduino.cc/t/cheap-yellow-display-ldr-sensor/1347942/5) has a user finding dark
gives the *higher* number — the same sense we documented. So this is this unit, or an unreported slip in a batch,
not a known characteristic of the design.

---

## 69. A third resistor at the node, and the LDR parked (2026-10-06)

*"There is another resistor connected to the common between the LDR and the divider resistor. I can tell where
the other end of it is going yet. I think we leave the LDR for later."*

So the LDR's front end is a **three-resistor network**, not the two-part divider §62 recorded. The most likely
role for a resistor hanging off the common node is a **series resistor between that node and the ADC pin** — 1 k
to 10 k is the usual value, there to protect the pin and to form an RC with its input capacitance. Two
consequences, both of which matter when the tracing resumes:

1. **The pin may not be sampling the node that was measured.** If the third resistor is in series, the ADC sees
   the far side of it, and the meter's reading at the node says nothing directly about what the ADC sees.
2. **A series resistor cannot explain a constant 0 on its own** — a series resistor carries no current once the
   ADC input's leakage is negligible, so it drops no voltage and the reading equals the node's. Which means the
   grounded-at-both-ends finding still has to be reconciled with wherever the third resistor actually goes: it
   could be the 3.3V leg that §67 concluded was missing, sitting at a different point in the network than the
   5k's far end.

So the catalog keeps the two-part description for now and the firmware is unchanged. **The LDR is parked at the
user's request**, with everything needed to resume: the pin is confirmed (GPIO34, module pin 6, ADC1 channel 6),
the polarity is confirmed (0 = full brightness, higher = darker, per the board's own example in §68), the code is
the correct code for a healthy divider, and the open question is the network around the node — not the firmware.

Suite: **618 passed, 0 skipped**.

---

## 70. The TF card template, built on embedded-sdmmc (2026-10-06)

*"Start TF card template"* — done, and built the correct way rather than the easy one: **embedded-sdmmc 0.8.2**
rather than a hand-rolled CMD0/CMD8/ACMD41/CMD58/CMD16 sequence. The init handshake is easy to get subtly wrong,
and even done perfectly it leaves raw sectors rather than a filesystem; the crate brings FAT12/16/32 with it and
is the one the ecosystem tests against.

What the template does, on the socket this board wires (CS 5, sclk 18, mosi 23, miso 19):

1. brings up its own SPI bus at **400 kHz** — the clock a card is specified to initialise at;
2. reports the capacity `SdCard::num_bytes()` returns;
3. opens volume 0 and its root directory, which walks the FAT (a damaged filesystem fails here rather than
   quietly reporting a size);
4. then says plainly whether it is mounted or not, once every ten seconds.

**Verified on the board, with no card in the socket** — which is the useful first result, because it proves the
whole path runs and reports honestly:

```
sd: mounting (cs GPIO5, sclk GPIO18, mosi GPIO23, miso GPIO19)
ERROR - sd: the card did not answer (CardNotFound)
ERROR - sd: no volume 0 - is the card inserted and FAT formatted? (DeviceError(CardNotFound))
sd: not mounted - insert a FAT-formatted card in the TF socket and reset
```

**Two things fixed by reading the crate rather than guessing** (both found by the compiler, in one round trip each):

- `Timestamp` is not a calendar struct: it is `year_since_1970`, `zero_indexed_month`, `zero_indexed_day`,
  `hours`, `minutes`, `seconds` — 56 is 2026.
- The directory iterator takes a *raw* handle (`iterate_dir(RawDirectory, …)`), which `Volume::open_root_dir()`
  does not hand back. **Listing the root is therefore deferred rather than guessed**: the mount, the capacity and
  opening the root already prove the card and its filesystem, and the raw-handle conversion is worth doing
  against the crate's source in its own round. The test asserts the listing is *absent*, so it cannot creep in
  unnoticed.

The closing line is the same lesson as §66 in miniature: with no card the first version still announced "mounted
and readable". It now tracks whether the mount actually happened and says so.

Suite: **619 passed, 0 skipped**.

---

## 71. The card lists its directory, and moves into the board template (2026-10-06)

**The listing is real now, and it reads the user's card:**

```
sd: card reports 15640559616 bytes (14916 MiB)
sd: volume 0 opened
sd: root directory opened - the filesystem is readable
sd:   SPARE (0 bytes)
sd:   SYSTEM~1 (0 bytes)
sd: root directory listed
sd: mounted and readable
```

`SPARE` is the volume label and `SYSTEM~1` the SD association's folder, which is exactly what a healthy FAT32
root holds with no user files in it — and the listing walks the FAT entries rather than trusting the header.

It is written against the crate's **raw API** throughout (`open_raw_volume` → `open_root_dir` → `iterate_dir` →
`close_dir`), so one handle is used for the open, the listing and the close instead of converting between the
ergonomic wrapper and the raw form. Two facts only the compiler knew, both now commented in the generated code:

- **`Timestamp` is not a calendar struct**: `year_since_1970`, `zero_indexed_month`, `zero_indexed_day`,
  `hours`, `minutes`, `seconds` — 56 is 2026.
- **The directory callback returns unit in 0.8**, not a `Result`. It changed from older versions of the crate,
  and the signature is the kind of thing that is worth reading rather than recalling.

**And the card is part of the board template now — as the same code, not a copy.** `espSdMountCode` emits the
whole mount as one block expression and both templates call it, which is the only way two templates that both
mount a card stay in step. Two consequences:

1. **The board template puts the card on SPI3, not SPI2.** A HAL driver owns its peripheral for good once it has
   been handed over, so the card cannot borrow the panel's bus in the same firmware — and the ESP32 has a second
   SPI peripheral, which is presumably why the socket was wired to pins that can reach it. That is a real
   constraint of this HAL, not a preference, and it is named in the generated comment so the next person does not
   spend an hour on it.
2. The binding is underscored in the board template (`_sd_mounted`), because only the card template's loop reads
   it, and both projects now build with **zero warnings**.

Suite: **619 passed, 0 skipped**. Both generated projects compile clean.

---

## 72. New Project was missing from the Controls section (2026-10-06)

*"Create a 'New Project' Control in the Controls tab. The dialog should offer the user the list of available boards
to select a board, and then follow the routine for creating the project."*

The wizard already did exactly that — `pickBoard` puts the whole catalog in a quick pick with the default board
first, then the template, then the name — but it was reachable only as an **icon in the Boards view's title bar**.
That is a strange place to look for "make me a project" when the Controls section is where every other action
lives, which is presumably why it was asked for twice.

So this is a second **door**, not a second routine: a `New Project` row leading the section (the one control that
makes the others possible), sidebar-only, since the status bar keeps its six for the actions used constantly. A
test asserts both halves of that: the row is first in the section and *absent* from the status bar, and the
command it runs reads `BOARDS` and shows a quick pick rather than offering a fixed list that could drift from the
boards that exist.

---

## 73. New Project also sits on the Project section's title bar (2026-10-06)

*"Also put the new project icon button on the Project section in the side bar (similar to what Boards section
already have)"* — one manifest entry, and a test that pins the whole arrangement rather than just the new line:
the Boards section offers the icon, the **Project** section now does too, and the **Controls** section offers it as
a labelled row instead of an icon, so it does not appear twice in the same place.

---

## 74. Wi-Fi and Bluetooth LE templates for the ESP32 boards (2026-10-06)

*"do the wifi and Bluetooth next"*. Two templates, offered from the chip's own silicon rather than from its
family name, and both **compiled and linked** for a real board before they were committed — nothing here has
been flashed, because no board was attached while it was written.

### What was added

- `EspBoardProfile.radio` is now **required**: `{ wifi: boolean, bluetooth: 'none' | 'ble' }`. Modelled
  explicitly because Bluetooth is not uniform across the family (the ESP32-S2 has none at all), and a
  template for silicon that is not there would fail at link time with a wall of undefined symbols from the
  blob. The template list is derived from this field, and `t1` pins the gating with a synthetic no-Bluetooth
  chip, since every catalogued board happens to have BLE.
- Templates `wifi` (Wi-Fi station) and `bluetooth` (BLE peripheral). `wifi` already existed for the Pico W,
  so the id now means "the family-appropriate implementation behind the same credentials contract".
- Both need a heap, so `.cargo/config.toml` rebuilds `alloc` as well as `core`, and the boot block installs
  it between `esp_hal::init` and `esp_rtos::start`. Both need `esp-rtos`'s `esp-radio` feature (read out of
  its manifest: `esp-radio = ["dep:esp-radio-rtos-driver"]`).
- The scheduler **must** start before the radio — esp-radio's own documentation shouts this, and the
  generated source is asserted to keep that order (`t1`), because getting it backwards compiles and then
  stalls at runtime.

### The address: a wrong turn worth recording

My first reading of esp-radio 1.0.0-beta.1 found **no** DHCP, netif or IPv4 API anywhere in its Wi-Fi module
(`StationConfig` has ssid/bssid/auth/channel/protocols/listen-interval/beacon-timeout/retries/scan-method and
no address field). I concluded the template could not report an address and began gating the credentials
prompt so it would stop offering a fixed one.

That conclusion was wrong, and the correction is the interesting part: esp-radio's `Interface` implements
**embassy-net's driver trait**. The radio joins the access point; *embassy-net* owns addressing. So the
address is logged (`stack.config_v4()`), `WIFI_STATIC_IP`/`WIFI_GATEWAY` are honoured through
`embassy_net::StaticConfigV4`, and the prompt was telling the truth all along. The gate was reverted rather
than left in as harmless plumbing. Lesson: "the crate has no API for X" is only true of the crate, not of
the stack the crate is designed to be used with.

### The ESP32-classic Bluetooth link failure

The published `esp-rom-sys` 0.1.5 — which esp-radio 1.0.0-beta.1 pins with `=0.1.5` — is **missing three ROM
`PROVIDE` lines** that the upstream repository has at the same tag (`ld_iscan_evt_start_cbk`,
`ld_page_evt_start_cbk`, `ld_pscan_evt_start_cbk`; published sha256 `88fdbcaf…` vs repo `faa391a2…`). The
classic ESP32's Bluetooth blob (`esp-wifi-sys-esp32` 0.3.0's `libbtdm_app.a`) refers to all three, so BLE
does not link from crates.io at all:

    ld: libbtdm_app.a(ea.o): in function `ld_iscan_evt_start_cbk_hack':
        undefined reference to `ld_iscan_evt_start_cbk'

The generated `.cargo/config.toml` therefore defines them (`--defsym`, addresses from esp-rom-sys's own
`esp32.rom.ld`), **classic ESP32 only**. Verified both ways: the ESP32 BLE project links *with* them, and the
ESP32-S3 BLE project links *without* them, so the chip gate is not decoration. They can go when esp-rom-sys
ships the PROVIDEs; a `--defsym` on an already-provided symbol is harmless.

### Other things that cost time

- `macro_rules!` is **textually** scoped. The first Wi-Fi build failed because the macro was defined in the
  items emitted *after* `main`. The static is now written out in `main` instead; items (functions) are
  hoisted, macros are not.
- **Escapes inside TypeScript template literals are consumed.** `info!("advertising as \"{}\"")` in the
  generator's source became `info!("advertising as "{}"")` in the generated Rust — a syntax error. The
  quotes are gone. This is the same family of mistake as the backtick hazard (which bit again, in a generated
  Rust comment, and was caught by `tsc`). The reliable guard for both is compiling the *generated* project,
  which is what the sizes below are measured from.
- A BLE controller is only an HCI transport. Advertising, connections and GATT live in a host stack, so the
  template carries `trouble-host` (the crate esp-radio's own example uses). The phone-visible name has to be
  in the advertisement payload (`AdStructure::CompleteLocalName`), not just in the GAP config, and it shares
  31 bytes with the flags and the service UUID — a test keeps the shipped name inside that budget, because
  the failure is a *runtime* error, not a compile error.
- Heaps are the figures esp-radio's examples use, per stack: Wi-Fi `64 * 1024` reclaimed + `36 * 1024`,
  Bluetooth `72 * 1024`. The heap lands in `.bss` on the classic ESP32, so it counts against DRAM.

### Evidence (measured, generated projects compiled from scratch)

| Project | chip | release `.elf` | `espflash` app image | of 4 MB partition |
|---|---|---|---|---|
| `wifi` | esp32 | 5 825 516 B | **574 400 B** | 13.9 % |
| `bluetooth` | esp32 | 5 801 932 B | **340 144 B** | 8.2 % |
| `bluetooth` | esp32s3 | 5 489 476 B | **346 864 B** | 8.4 % |

The `.elf` figures include DWARF (the generated profile keeps `debug = true`); the app image is the number
that matters for flash. All three: `cargo build --release` finished with **0 warnings**.

### Not verified

Nothing was flashed: the board was not attached. Association, the DHCP/static binding, the logged address,
real advertising, phone visibility and connect/disconnect are all **compile-and-link** verified only. That
distinction is the same one §52 and later entries make; it is not a formality. ESP32-classic BLE also leaves
roughly 128 KiB of DRAM claimed with the 72 KiB heap, so treat that number as a tuning point rather than a
guarantee the moment Wi-Fi is added to the same image.

---

## 75. The panel rotation, and why it is not a line in main.rs (2026-10-06)

*"A feature where the user can set the rotation of the lcd - settings are 0(default, no rotation), 1(90 deg
CW), 2(180 deg CW), 3(270 deg CW)"*, with the constraint that `src/main.rs` must not be regenerated after the
wizard, because that is where the user's own code goes.

### The constraint, checked rather than assumed

`generateProjectFiles` has exactly **one** caller — `src/commands/newProject.ts:146` — and nothing in build,
flash, debug, packaging or refresh touches it. `rustyPlatform.refresh` only refreshes views
(`extension.ts:68`). The sole guard is `ensureWritableTarget`, which asks with a modal warning naming the
folder and a single *"Overwrite generated files"* button; dismissing it writes nothing at all. The Wi-Fi flow
*reads* `src/main.rs` (to detect `option_env!("WIFI_SSID")`) and never writes it. So a generated `main.rs` is
written once, and re-running the wizard into the same folder is the only way to replace it — which is exactly
why the rotation could not live there.

### The design

- `rustyPlatform.lcdRotation` (number, enum 0-3, default 0, `scope: resource`) is the handle the user turns,
  and it is written into the generated `.vscode/settings.json` so the choice travels with the project.
- `.cargo/esp-config.toml` carries `LCD_ROTATION = "n"` under `[env]`, and the generated `src/main.rs` reads
  it with `option_env!` and maps it to `Rotation::Deg0/90/180/270`.
- The wizard asks for panel templates only (`display`, `touch`, `board`), with the four values spelled out in
  degrees rather than as numbers.
- Changing the setting later rewrites that one line (`src/display/rotationSync.ts`), line-wise, so `[env]`
  entries the user has added are kept. A folder with no `.cargo/esp-config.toml` is left alone.
- A nonsense value falls back to no rotation instead of failing: the value is editable by hand in
  `settings.json`, and a cosmetic choice must not be able to stop a project from building.

### Verified

- The generated project **compiles and links** with the rotation present (0 warnings), and a nonsense value
  (`9`) still builds.
- That the value really reaches the compiler was **proved both ways** with a temporary `env!` probe in the
  generated project: with the line present it compiled; with the line deleted the build stopped with
  `error: environment variable LCD_ROTATION not defined at compile time`. (The first attempt at this probe
  used `assert!(matches!(...))` in a `const`, which needs an unstable feature and so proved nothing — the
  probe has to be `env!`, which errors when the variable is absent.)
- `mipidsi` keeps the drawing area at the panel's native size regardless of rotation
  (`OriginDimensions::size()` returns `display_size`, `graphics.rs:127-131`), so the layout baked into the
  generated screen stays valid at every rotation — it is rotated, not clipped. (An earlier answer here
  guessed the opposite; the crate source settled it.)

### Not verified

Nothing has been flashed. The rotation's *visual* effect, and the settings-change path as the editor drives
it (a `vscode` event, whose pure rewrite is t1-tested but whose wiring is not), await a test on the board. The
firmware logs `panel rotation setting: n` at boot precisely so that takes one look.

---

## 76. The Wi-Fi template on hardware: every stage passes (2026-10-06)

Tested on the CYD/ESP32-035 board (`/dev/ttyUSB0`, `espflash`, chip `esp32`), following the routine in the
session: the whole Wi-Fi half passed, including the extension's own credential path.

What that turns from "compiled" into "known":

- **Association** with a WPA2 network, and the log naming the SSID, the channel and the association id.
- **A DHCP lease**, with the address logged and then repeated by the heartbeat every 10 s.
- **A fixed address** from `WIFI_STATIC_IP`/`WIFI_GATEWAY`, logged as `using the fixed address …, so DHCP is
  skipped` with no lease wait - and it works as intended.
- **Recovery across a reset and across an access-point power cycle.** This was the open question: the
  template has no explicit re-association loop of its own, so the recovery is the driver's own retry plus
  embassy-net re-acquiring the lease. It recovers. (Worth knowing *why* it works before changing anything in
  that area.)
- **The extension's prompt.** With the keyring entry cleared, Flash asks for the SSID, password and optional
  fixed address, stores them, and the flashed board joins with those values - which is the cross-family
  contract (`isWirelessFirmware` recognising the ESP template) working, not just the generated code.

### A false claim in the shipped docs, found by the hardware

The generated README still said, under *"What this firmware does not do"*: *"It does not log an address, and
it cannot be given a fixed one."* That was the residue of the wrong turn recorded in §74 - I had read
esp-radio's Wi-Fi module, found no address API, and written the conclusion into the documentation before
discovering that embassy-net on top of esp-radio is what owns addressing. The code was corrected at the time;
this text was not, so the project's own README contradicted the project's own `main.rs`.

It is fixed here, along with the wizard's one-line description of the template, which had been understating
it in the same way. The lesson is the one §74 already drew, in a sharper form: a conclusion written into
documentation is as much a claim as one written into code, and it goes stale the same way - and only running
it on the board was going to catch this, because both texts were internally consistent.

### Still not verified

**Bluetooth**, in full: advertising, the phone's scan list, connect/disconnect, the GATT service and the
notify stream are all still compile-and-link only. The measured Wi-Fi timings (reset → joining → associated →
address) and the verbatim log excerpts were not recorded in this entry; they belong here when someone has
them to hand.

---

## 77. The Bluetooth template on hardware: advertising, notify, and the return (2026-10-06)

Same board, same session as §76. The Bluetooth half of the feature is now verified on hardware as far as it
was tested, and the one real obstacle was an observation mistake on our side, not a fault in the firmware.

### What the board actually printed

    INFO - Our address = Address { kind: AddrKind(1), addr: BdAddr([255, 143, 26, 5, 228, 255]) }
    INFO - Starting advertising and GATT service
    INFO - [adv] advertising as Rusty-Platform
    INFO - [adv] connection established (central connected)
    INFO - [custom_task] notifying connection of tick 1
    INFO - [custom_task] RSSI: 0
    INFO - [custom_task] notifying connection of tick 2
    INFO - [custom_task] RSSI: -51
    ... (tick 3: -55, tick 4: -49) ...
    INFO - [custom_task] notifying connection of tick 102
    INFO - [custom_task] RSSI: -63
    INFO - [gatt] disconnected: Remote User Terminated Connection
    INFO - [adv] advertising as Rusty-Platform

### What that proves

- **The name is in the advertisement payload.** `Rusty-Platform` appeared in the scanner's list, which is the
  thing that could have failed silently: `PeripheralConfig { name }` alone does not put a name on the air,
  `AdStructure::CompleteLocalName` does.
- **A connection completes**, and the notify stream runs at the designed ~2 s cadence.
- **RSSI reports plausible numbers** (-49 to -63 dBm at close range). The `0` on the first tick is the first
  read racing the connection settling, not a fault.
- **The connection is stable**: tick 102 is about 3.4 minutes without a drop.
- **The disconnect reason is the host stack's own words** (`Remote User Terminated Connection`) rather than a
  bare error.
- **It returns to advertising after the central disconnects** - the criterion that separates a working
  peripheral from one that advertises once and then looks dead.

Also confirmed in passing: flashing the Bluetooth project never prompts for Wi-Fi credentials, so
`isWirelessFirmware` correctly says no for a project with no `WIFI_SSID` in it.

### The detour, recorded because it will happen again

The report was "device not in bt list on phone". The firmware had been advertising correctly the whole time.
Two things made that hard to see, and both are about *observing*, not about the code:

1. **The phone's Bluetooth settings screen is not a BLE scanner.** The advertisement sets
   `LE_GENERAL_DISCOVERABLE | BR_EDR_NOT_SUPPORTED` - it is BLE-only - and Android's settings list routinely
   shows classic devices and known pairings, not BLE peripherals that no app has asked about. nRF Connect
   found it immediately.
2. **The extension's Flash output is not the board's log.** `espflash flash` writes the image and exits; the
   firmware's `log::info!` output only appears on the serial monitor. And the Bluetooth template is *silent
   while advertising* - nothing at all is printed between `[adv] advertising as …` and the next connection -
   so a monitor attached after flashing shows a blank screen and invites exactly the wrong conclusion. The
   monitor has to be open **before** the reset for the boot lines to be there at all.

Both are now written down here and in the README's testing note. The general lesson is the same one §76 drew
from the other direction: the firmware's own log is the cheapest discriminator between "it is broken" and "I
am looking in the wrong place", and it has to be read first.

### Not verified (and one rough edge)

- The **GATT read and write** event paths were not exercised: the run showed notifications and a disconnect,
  not a `[gatt] Read Event` or `[gatt] Write Event` line.
- A **second central** was not tried, so `CONNECTIONS_MAX = 1` refusing the second connection is still only a
  statement about the source.
- **Rough edge found while testing:** a *read* of the battery-level characteristic returns its stored value
  (`10`), while the *notifications* carry the ticking counter - the template never writes the counter back
  into the attribute, so the two disagree. The README already calls the service a skeleton to replace, but
  making the read and the notify agree is the honest thing, and would need one re-test of the notify path.
  The counter also wraps at 255 ticks (~8.5 minutes), which is fine for a demonstration and worth knowing.

---

## 78. The Bluetooth read now agrees with the notify (2026-10-06)

The rough edge §77 flagged is fixed. The generated `custom_task` notified the counter without ever storing it,
so a central that *read* the battery-level characteristic got the value it was initialised with (`10`) while
the notifications counted upwards - two answers to the same question, and the read is the one that looks like
a stale value rather than a bug. It was found by reading the characteristic on a real phone instead of only
watching the notify stream, which is the whole reason the read/write paths were worth testing separately.

The fix is one call, found in trouble-host 0.7.0's own `GattConnection::set` (`gatt.rs:291`):

    if conn.set(&level, &tick).is_err() {
        warn!("[custom_task] could not store the level, so a read will not match the notifications");
    }
    info!("[custom_task] notifying connection of tick {}", tick);
    if level.notify(conn, &tick, true).await.is_err() { ... }

Stored first, then announced: the other order leaves a window in which the two disagree. A failed store is
logged rather than ignored, because the entire point of the change is that the two cannot differ. The
generated README now states that a read returns what the notifications carry, and mentions that the counter
wraps at 255 ticks (about eight and a half minutes).

Verified: the generated project **compiles and links** with the change (0 warnings), and a `t1` test pins the
order (the store must appear before the notify) so the two cannot drift apart again.

Also recorded here, from the same testing round: the GATT **read** and **write** event paths, and a second
central against `CONNECTIONS_MAX = 1`, were exercised on the phone and behaved as intended. The exact log
lines from that round were not captured, so this entry records the outcome rather than quoting it - the same
distinction §76 drew about timings.

**Still needs one thing:** a re-test on the phone of the notify path (connect, read the characteristic, watch
a notification) to confirm the read now returns the counter. That is a behavioural claim which only the board
can settle; the compile and the ordering test are not substitutes for it. **Confirmed in §80.**

---

## 79. The Grumpy icon, and why the extension had none (2026-10-06)

The Extensions view showed a placeholder because `package.json` had no `icon`. The repository *did* have
`resources/icon.svg`, but that is not a candidate: it is a 24x24 themed line drawing used as the **view
container** icon (`package.json:311`) and as the AI panel's `iconPath` (`src/ui/chat`), which is what
`currentColor` and a 24-unit `viewBox` are for. An extension icon has to be a **PNG of at least 128x128**,
and VS Code wants it to read at a glance in a list.

The mascot already existed: `Grumpy.png`, 128x128 RGBA, shipped as the icon of the sibling extension
`grumpy.avalonia-designer` 0.14.0. It is copied in **byte-identical** (sha256 `9b05369840f3b8b8…`,
27 673 bytes) to `resources/grumpy.png`, so the branding is the one already in use rather than something
reinvented, and `"icon": "resources/grumpy.png"` now points at it. `.vscodeignore` does not exclude
`resources/`, so it is packaged - verified in the built `.vsix` and in the installed extension.

A test pins the whole thing, because a broken icon is the kind of defect that fails *silently*: the field must
exist, end in `.png`, the file must exist, carry the PNG signature, and be at least 128x128.

Two honest limits:

- **I cannot view images with this model**, so everything above is about the file's properties (dimensions,
  colour type, signature, byte-identity) and not about its appearance. `GrumpyWhite.png` (also 128x128) sits
  beside it in the sibling extension if the colour variant turns out to be the wrong one. (Confirmed by eye
  once it appeared in the Extensions view - see §80.)
- The `description` in the manifest was stale in the same area and is fixed here: it advertised RP2040/RP2350
  only, which stopped being true when the ESP32 and ESP32-S3 boards arrived.

---

## 80. Closing the loop: the two confirmations only the board and an eye could give (2026-10-06)

Both caveats left open by the previous two entries are now closed, and one older one is not - recorded here so
the ledger is accurate rather than tidy.

**The Bluetooth read now agrees with the notify, confirmed on hardware.** §78 fixed the generated
`custom_task` so the counter is stored in the characteristic before it is announced, and said plainly that the
compile and the ordering test were not substitutes for reading it on a phone. Reading it on a phone returns
the counter. Every part of the Bluetooth template this session set out to verify is therefore verified:
advertising, discovery by a real BLE scanner, connection, the notification stream, RSSI, disconnect and the
return to advertising, the GATT read and write paths, a second central against `CONNECTIONS_MAX = 1`, and now
the read agreeing with the notify.

**The icon was confirmed by eye.** §79 could verify the file's properties but not its appearance, because this
model cannot view images. It appears in the Extensions view, which is the only check that mattered.

**What is still not verified anywhere in this feature set: the panel rotation's visual effect.** §75 verified
the *mechanism* - the value is written to `.cargo/esp-config.toml`, `option_env!` sees it (proved both ways
with an `env!` probe), a nonsense value falls back to no rotation, and the generated project compiles - but
nobody has yet flashed a *panel* project with a rotation set and looked at the glass. The Wi-Fi and Bluetooth
templates were the ones exercised on hardware, and neither drives a panel, so the rotation could not have
shown up in that testing even by accident. It needs a `display`, `touch` or `board` project with
`LCD_ROTATION` set to 1, 2 or 3, and then a look at the screen. The firmware logs the value it was built with
(`panel rotation setting: n`), which distinguishes "the setting did not reach the build" from "it reached the
build and the image did not turn" - the two failures that would otherwise look identical from the outside.

---

## 81. Landscape rotation: the drawing area has to turn too (2026-10-07)

Rotation 0/1/2/3 worked, and then the report came back: **the graphics do not fit in either landscape mode**.
They did not, and the reason is worth recording carefully, because my own earlier reasoning said the opposite.

### What I had claimed, and why it was wrong

§75 stated, from reading mipidsi's source, that rotation could not clip anything: `OriginDimensions::size()`
returns `display_size` unchanged (`graphics.rs:127-131`), so the drawing area stays 320x480 and the content is
merely turned. That is a correct description of *mipidsi's* model. It is not a description of the panel.
Rotating through MADCTL exchanges the **controller's** row and column addressing, so the addressable area
becomes 480x320 while the driver was still telling the panel it had 320x480 - and the drawing was clipped and
misplaced rather than turned. mipidsi's idea of the drawing area and the controller's idea of its own frame
memory are two different things, and only the second one decides what lands where.

This is the same shape of mistake as §74 (esp-radio "has no address API", so no address can be logged - until
embassy-net on top of it was considered): reading a crate tells you what the crate does, not what the system
built around it does. §80 had already flagged the rotation as never observed on the glass; it took one flash
to replace the inference with the fact.

### The fix

- **The panel is told the rotated size.** The boot code computes `rotated` from the rotation and swaps:
  `display_size(width, height)`. 180 degrees deliberately does *not* swap, because a half turn flips both axes
  without exchanging rows and columns.
- **Both layouts are solved, and the firmware picks one.** The layout solver now takes the size it is solving
  for; the generator emits a `DiagnosticLayout` struct with `PORTRAIT_DIAGNOSTICS` and
  `LANDSCAPE_DIAGNOSTICS`, and main selects by `rotated`. The maths stays in TypeScript, where the tests can
  check it - including a new test that walks **both orientations of every panel in the catalog** and asserts
  each one fits (inside the frame, bands in order, no status line wider than the glass). That test is the
  guard that would have caught this: the old one only ever solved the portrait shape.
- **The whole touch interface is expressed in the content space.** The calibration targets, the raw-to-screen
  mapping, the readout box and the touch template's own graphics screen all derive from the rotated width and
  height instead of the portrait constants they were baked with.
- **The calibration records the orientation it was measured in.** The record gained a rotation byte (covered by
  its checksum), and a record from a different orientation is discarded with a log line
  (`stored for rotation 0 but this build is rotation 1 - recalibrating`) instead of being used. Without that, a
  landscape build with a stored portrait calibration maps every touch to somewhere plausible and wrong.

### Verified, and not

Compiled and linked with 0 warnings: `display` (rotation 1), `board` (rotation 1) and `touch` (rotation 3).
**Not verified: how any of it looks or responds on the glass.** Both landscape modes and the touch mapping
after a rotation change need a board, and that is the next thing to test. Note too that a project generated
before this change cannot pick it up by flashing again - `src/main.rs` is the user's from the moment it is
generated, so a panel project has to be regenerated to get the landscape layout.

---

## 82. The white screen: why the drawing area cannot be rotated (2026-10-07)

`TestRotation` (the `board` template, rotation 3) was built and flashed and gave a **white screen**. The cause
was the change in §81 - handing mipidsi the rotated display size - and the arithmetic is worth writing down,
because the idea is the obvious one and it cannot work.

### The arithmetic

For this panel the orientation is `flip_horizontal().rotate(rotation)`, and `Orientation::rotate` keeps the
mirror flag while summing the rotation (`orientation.rs:119-124`), so rotation 3 is
`{ rotation: Deg270, mirrored: true }`. `MemoryMapping::from_orientation` turns that into:

    rotation Deg270      -> reverse_rows = true,  reverse_columns = false
    reverse_columns     ^= mirrored(true)        -> reverse_columns = true
    swap_rows_and_columns = rotation.is_vertical() -> true

Then `Display::set_address_window` (`lib.rs:299-317`), with `FRAMEBUFFER_SIZE = (320, 480)` for the ST7796 and
`display_offset = (0, 0)`:

    offset.0 = FRAMEBUFFER_SIZE.0 - (display_size.0 + offset.0)   // 320 - 480  -> u16 underflow

With the rotated `display_size` of §81 that is `320u16 - 480`, which wraps (the release profile does not check
overflow). The offset then goes through `swap_rows_and_columns` and is added to every window, so the panel
received a garbage address window for every draw and never wrote a valid pixel - it stayed in its uninitialised
white state. Nothing the firmware logged would look wrong: the panel initialised, the drawing code ran, and
`expect("panel write failed")` never fired, because the driver's writes all "succeeded".

Rotation 1 survived the same change by luck: `{Deg90, mirrored:true}` leaves `reverse_columns` false, so only
the harmless axis was offset. Rotation 3 hit the one that underflows. That asymmetry is exactly the kind of
thing that makes a change look tested when it is not - and it is why the report named one rotation, not both.

### What was reverted, and what remains

- **The drawing area is the panel's native size again** (`.display_size(width, height)` with the panel's own
  dimensions). Rotation still turns the whole interface through MADCTL, which fits the glass exactly: the
  native 320x480 logical area maps onto the rotated 480x320 frame with nothing clipped. What it does *not* do
  is produce a landscape-shaped layout, and that is the honest state.
- **The landscape layout is solved but not selected.** `espPanelSupport` still computes
  `LANDSCAPE_DIAGNOSTICS`, and nothing uses it. It is kept because it is correct and will be needed the moment
  the rotation stops going through the address window; the comment in the generated code says as much.
- **The touch calibration versioning stays** (§81). It is independent of the display-size question and is still
  right: a calibration measured in one orientation must not be used in another.
- **A test now pins the native size**, with the underflow named in the comment, so the rotated display size
  cannot come back by accident.

### What a landscape layout actually needs

The rotation has to be applied as a **coordinate transform in our own drawing code**, not through the panel's
address window: keep `display_size` native, keep only the board's mirroring in the orientation, and map every
drawn point (and every touch coordinate) through the rotation transform. That way the landscape layout is not
limited by the framebuffer at all, and no offset arithmetic is involved. It is a real change to the drawing
code - every primitive and the touch mapping go through the transform - and it wants a board on the desk,
which is what this session did not have for the graphics.

---

## 83. How the landscape layout really works, and the touch screens follow it (2026-10-07)

Two corrections from the board, both against conclusions I had written down as fact.

### The mechanism, finally right

§82 concluded that a landscape layout needed "the rotation applied as a coordinate transform in our own drawing
code", because the display driver cannot be told a rotated size. The board said otherwise: a fresh **display**
project at rotation 3 renders a full landscape layout - every edge, corner marker and bar visible, nothing
clipped - with the native display size. mipidsi 0.10's own accessor explains it (`options.rs:56-62`):

    fn display_size(&self) -> (u16, u16) {
        if self.orientation.rotation.is_horizontal() { self.display_size }
        else { (self.display_size.1, self.display_size.0) }
    }

So the *drawing area* is swapped for a vertical rotation by mipidsi itself, while `set_address_window` reads the
raw field (`lib.rs:306`) - which is why the native size is both the right thing to pass and what keeps the
clipping offset from underflowing. v0.0.41 got both halves wrong at once: its swap double-swapped the drawing
area and made the offset use the rotated size. One line of the crate, two opposite mistakes.

The general lesson is the same one §74 and §81 already drew, and it keeps being worth the ink: reading a crate
tells you what the crate does, and only the device tells you what the result is. Here the crate's accessor had
the answer, and I had read `OriginDimensions::size()` and the offset formula without reading the accessor they
both funnel through.

### What changed for touch and board

The touch template draws its own screen rather than the diagnostic layout, and its geometry came from the
panel's native width and height - so on a rotated panel it drew a portrait interface into the landscape area.
It now derives its content size the same way the driver does:

    let width_i: i32 = if rotated { height as i32 } else { width as i32 };
    let height_i: i32 = if rotated { width as i32 } else { height as i32 };

which carries the calibration targets, the raw-to-screen mapping, the readout box, the bars and the frame with
it. `rotated` is now emitted for every panel template rather than only the display one.

### Verified, and what is not

Compiled and linked for the `board` and `touch` templates at rotation 3 (0 warnings each), and the `display`
template's landscape rendering is confirmed **on hardware** by the person who ran it. The touch/board
*appearance* at 270 degrees - and touch landing where it is drawn - still wants a flash, which is the next test.

---

## 84. The recalibration gesture, and the rotation feature signed off (2026-10-07)

### The gesture that was only a comment

Asking whether a rotation change needed the stored calibration erased turned up something else: the touch
firmware's comment promised *"touching the glass during the first two seconds throws it away and asks for the
corners again, which is the only recalibration gesture this firmware offers"* - and nothing implemented it.
`calibrated` was only ever set true. So the record could be *replaced* by completing a fresh calibration, but
never discarded, and a panel calibrated for the wrong orientation or with a drifted mapping had no way back to
the corner screen short of erasing the flash sector.

Now implemented (0.0.44): a touch within `RECALIBRATE_TICKS` (100 ticks of the loop's 20 ms, so about two
seconds) of a reset discards the stored calibration, logs which rotation it belonged to, sounds the confirmation
tone, returns to the corner screen, and puts the LED back to red - which already means uncalibrated. The
triggering touch is **consumed** by the gesture rather than recorded as a corner: the finger is wherever the
user aimed at the middle of the screen, so calibrating from it would be worse than not calibrating at all.

The rotation question itself needed no answer of this kind: the record carries the rotation it was measured in
and a mismatch is refused with a log line, so changing rotation never needs anything erased.

### The feature, signed off on hardware

Confirmed by the person who has the board, on the CYD/ESP32-035:

- **270 degrees**: the interface is turned, and the diagnostic screen is a complete landscape layout - every
  edge, corner marker and bar visible, nothing clipped.
- **The `touch` and `board` templates** lay out for the rotated area too, and **touch lands where it is
  pressed** after recalibrating.
- **The recalibration gesture works**, and the calibration is redone and good.

That closes the rotation feature: 0.0.35 (the setting) -> 0.0.41 (the drawing area, which broke rotation 3 with
a white screen) -> 0.0.42 (the revert, which restored it) -> 0.0.43 (the touch/board screens following the drawn
area) -> 0.0.44 (the gesture). The reason the trail is that long is worth keeping: three times in this feature I
reasoned confidently from a crate's source and was corrected by the device - "esp-radio has no address API"
(§74), "rotation cannot clip anything" (§75/§81), "the rotated size is needed / a landscape layout needs a
coordinate transform" (§82/§83). Each time, the answer was in the crate; the *result* was only on the board.

## 85. The WYSIWYG designer: what the crate really offers, and the first gate (2026-10-08)

### The four requirements that could not be met as written

The ask was a designer with a toolbox on the left, a canvas showing the board's real size and rotation, a
properties panel on the right, drag-to-place, and code-behind handlers inserted automatically. Four of those
ran into the crate's actual shape, so they were settled before any code was written:

- **The markup has no absolute x/y.** Containers are `grid`/`row`/`column`/`stack` carrying `cols`/`rows`
  tracks (`"1fr"`, `"100px"`, `"24px"`) and `gap`/`padding`; a widget is placed with `col`/`row` and
  `col_span`/`row_span` (`parser.rs:290-296`). The only `x`/`y` in the whole parser are `dx`/`dy` at line 654,
  a shadow offset. Free dragging therefore has to be *translated*, and the translation chosen is exact:
  with `gap=0 padding=0`, the widget rectangles' own edges become pixel tracks: the x-edges {0, 17, 57, 480}
  become four columns, and a widget at x=17 with width 40 occupies column 1 and spans the 40 px track - the
  same rectangle, to the pixel.
- **`on_click` does nothing.** The parser reads it (`parser.rs:348`) and the serializer writes it back, but
  `emitter.rs` contains no handler or callback wiring at all - the attribute is inert. Events are built on
  `GuiContext::handle_input` + `GuiContext::pop_event() -> Option<UiEvent>` (`context/input.rs:413`).
- **Handlers cannot go in `main.rs`** without contradicting the rule that `main.rs` is never regenerated
  (§75). They go in a `src/ui_handlers.rs` that is written once, like `main.rs`.
- **Only two catalogued boards have a panel**: ESP32-035 (ST7796 320x480, XPT2046 touch) and T-QT
  (GC9107/GC9A01 128x128, no touch). Everything clickable narrows to one board.

### What embedded-gui 0.2.7 actually is

The repo's own `EMBEDDED_GUI_CRATES.md` called it "buttons and sliders, ~580 downloads, young". Measured:
**39 893 lines of Rust across 97 files**, ~180 public types, published 2026-09-24, `edition 2024`,
`rust-version 1.87`. It ships three crates, not one, and the extra two are the interesting part:
`embedded-gui-macros` with `gui_kdl!`, `include_gui!` and `include_project!`, and `embedded-gui-codegen`
with a KDL parser, a Rust emitter **and a serializer back to KDL**. The KDL surface is 30 tags (button,
toggle, checkbox, slider, dropdown, roller, scale/gauge, spinbox, progress, arc, busy_wheel, chart,
status_bar, time_picker, number_picker, dialog, content_indicator, crumbs, panel/card, image, carousel,
icon, mesh3d, spacer, path, rect, line, circle, table, label/banner). The doc's "on-screen keyboard" is not
among them.

The generated API is what makes the design work: for `screen id="Gate"`, `include_gui!` inlines
`pub struct GateWidgets { ...: WidgetId }`, `pub struct GateApp { widgets }` and
`GateApp::build(&mut GuiContext) -> Result<Self, GuiError>`, with `WIDTH`, `HEIGHT`, `NODE_COUNT` consts.

### The shape that follows

The `.kdl` file is the only thing regenerated on save. `src/ui.rs` (written once) calls
`include_gui!("src/ui.kdl")` and pumps events; `src/ui_handlers.rs` (written once) holds the stubs the user
edits; `main.rs` keeps a single call. Re-saving the design in the editor rewrites markup, and none of the
Rust the user owns.

### The gate, and precisely what it proved

A real project was generated by the extension's own generator - `generateProjectFiles` for board
`sunton-3248s035r`, template `display`, rotation 0 - into `tests/tmp/gate/` (the ignored Rust scratch, so the
tree stays clean), then `embedded-gui` was added with `default-features = false`. Two failures, both
recorded because both will recur:

1. `no_std requires a math backend feature: enable libm or micromath` - with `default-features = false`
   neither is on by default. `micromath` is already in the tree via esp-hal.
2. `cannot find module or crate embedded_gui_macros` - the crate enables its macro crate internally, so it
   is **not a nameable dependency**. `lib.rs:308` re-exports the macros; the call is
   `embedded_gui::include_gui!("src/screen.kdl")`.

After both fixes, `cargo build --release` for `xtensa-esp32-none-elf` **succeeds**. Sizes: text 85 353,
data 8 620, bss 187 984. A baseline build with the macro removed is **byte-identical**, because `build()` is
never called and `lto` drops the entire crate. So the honest statement is: the crate, the macro and its
generated code **compile and type-check** for xtensa and link alongside esp-hal and mipidsi - and its
runtime cost is **not measured at all**.

### What is still unproven, and how it will be proven

1. **Driving `GuiContext` for real.** Needs a live render, so it needs the board, which is not on USB.
2. **The canvas-to-glass mapping.** This one does *not* need hardware: the crate ships
   `display_backend::SimulatorBackend`, `test_buffer::TestBuffer`, `test_buffer::LayerCanvas` and has
   `embedded-graphics-simulator` as a dev-dependency. A host-side harness can therefore assert, in CI, that
   a widget designed at x=17 is drawn at x=17 - which is the only way to trust a WYSIWYG canvas.
3. **RAM.** The existing template already parks 187 984 bytes in `.bss`, and a 480x320 RGB565 framebuffer
   would be 307 200 on its own, against roughly 320 KB of SRAM. Full-framebuffer rendering is therefore out
   and the designer must use the band/dirty-rect path (`PartialBandBuffer`, `LineBufferRenderer`,
   `DamageTree`); the real figure has to come from a build that actually calls `build()`.

One process note: the first gate run printed `CARGO_EXIT` from a `cargo build | tail` pipeline and reported
success from `tail` while the build had failed - the same masking that produced the ineffective merge gate
earlier. Every build from here on runs under `set -o pipefail`.

## 86. The designer's simulator: the geometry holds, and three things codegen does not do (2026-10-08)

### Why a render, and not the board

The t1 tests prove the pixel tracks add up to the rectangles they came from. They cannot prove that
`embedded-gui`'s layout engine *honours* those tracks: that is a property of the engine, and the only honest
way to test someone else's engine is to run it. It does not need hardware either -- the crate ships
`display_backend::SimulatorBackend`, `test_buffer::TestBuffer` and has `embedded-graphics-simulator` as a
dev-dependency.

So `tests/sim/` is a small **host** crate (a separate package on purpose: the generated projects are no_std
cross builds and the two must not share a feature set), and `tests/tools/designer-sim.js` generates
`screens/panel.kdl` plus `src/expectations.rs` from `fixture.json` using the extension's *own* emitter. The
program then compiles that markup through the real `include_gui!`, builds it into a `GuiContext`, renders into
a `TestBuffer`, and asks `gui.absolute_rect` where every widget ended up.

`fixture.json` is chosen so a mistake has somewhere to show: a band flush to three edges, a label sitting
inside it (two widgets in overlapping cells), a 43x29 button at odd coordinates, a full-width meter, two
footer pieces sharing the vertical edge at x=240, and a 3x3 spacer against the right edge.

**Result: all eight came back at exactly the designed rectangles.** The canvas-to-glass mapping is no longer
an assumption. It also runs in about a minute with no board attached, so it can be part of `--e2e`.

### What the first render found: the spacer cannot be named

The expectations file is generated Rust, so the first build failed at the compiler: `no field tiny on type
&SimPanelWidgets`. The spacer is the one tag of thirty whose id the parser **drops** -- `parse_widget` builds
`WidgetDef::Spacer` with no id at all -- so codegen emits no struct field for it and `absolute_rect` can never
be asked about it. It still reserves its cells. The catalogue now carries `addressable: false`, and the
simulator skips it with a comment in the generated file rather than silently measuring seven of eight.

### And that the shapes do not draw themselves

`expand` (a second binary in the same crate, printing `embedded-gui-codegen`'s output for a KDL file) shows
what a `rect`, a `circle` and a `line` really become:

    let band = gui.add_panel(cells[0], Style::panel())?; // rect r=0 sw=0
    let knob = gui.add_panel(cells[3], Style::panel())?; // circle r=32 sw=0
    (a line becomes gui.add_spacer, with its stroke width in a comment)

The shape's `fill`, `stroke`, `stroke_width` and `radius` are **discarded** -- the radius and stroke width
survive only inside a trailing comment. A designer that painted the fill the user picked would show a red
rectangle where the board draws a theme-styled panel, which is the one lie a WYSIWYG tool must not tell. The
catalogue marks them `draws: 'panel'` (rect, circle) and `draws: 'nothing'` (line, spacer), and every
property of theirs `ignoredByCodegen`.

### And that a button's background is painted over

The paint probe failed, but not because the markup was wrong. `expand` shows the emitter getting it right:

    let go = gui.add_button(cells[2], "Button", WidgetStyle::button().with_bg(Rgb565::new(7, 27, 20))...)?;

Yet the buffer contained **zero** pixels of that colour, and the button's own rectangle read
`Rgb565(4, 8, 12)`. The reason is in the crate: `WidgetStyle::with_bg` sets `normal.background`
(`style.rs:484`), but `WidgetStyle::button()` also carries a default **vertical gradient** -- top
`Rgb565::new(6, 12, 16)`, bottom `Rgb565::new(2, 4, 8)` -- and (4, 8, 12) is exactly its midpoint. The
gradient is not cleared by `with_bg`, and nothing in the KDL surface can clear it: `Style::with_gradient`
exists (`style.rs:345`) but no attribute reaches it.

So the harness now asserts what is actually provable -- that the widget painted something at its own
rectangle, comparing a pixel inside it against one just outside -- and **reports** the colour it found
instead of pretending it matched. The designer's colour controls for buttons therefore promise the theme's
colours, not the user's, until either the crate clears the gradient or the designer uses the raw-style escape
hatch: the emitter passes a `style` value through verbatim when it begins with `WidgetStyle::`, `Style::` or
`{`, so a hand-written Rust expression is reachable from the markup.

Taken together with the shapes, **no widget property currently guarantees a visible fill**: the shapes are
ignored, the button is overpainted, and label, progress, gauge and the rest expose no colour properties at
all in the parser. That is a real limit on requirement 6's "background and foreground colours", and it is a
canvas decision rather than something to paper over.

## 87. The designer reaches the board: a template, three files, and what the toolkit costs (2026-10-08)

### Three artifacts with three lifetimes

A Designer project is generated with four files the other templates do not have, and the split is the whole
design:

| File | Written | Why |
|---|---|---|
| `src/ui.kdl` | regenerated on every designer save | the compiled form of the design |
| `src/ui.rs` | regenerated on every designer save | the `include_gui!` call, the budgets, the pointer plumbing, and the match that turns a `UiEvent` into a call -- all of which depend on what the design contains, and none of which is user code |
| `src/ui_handlers.rs` | **appended to only** | the user's code: a stub appears for an event that has none, and a function that exists is never touched |
| `designer/panel.ui.json` | regenerated | the design itself, which the panel edits |

`src/main.rs` is untouched after the wizard writes it, which keeps the promise made in §75: it calls
`ui::Designer`, and everything that changes arrives through the files above.

The generated API is small on purpose -- `Designer::new`, `pointer`, `pump`, `is_dirty`, `render`, `repaint` --
and `render` paints the first frame whole and every frame after it with `render_dirty`. That is not a
micro-optimisation: a full 480x320 repaint over the panel's 24 MHz SPI link is on the order of a quarter of a
second, so honouring the damage rectangles is what makes a finger-drag usable at all.

### What the toolkit actually costs

Measured by building three generated projects for the board, not estimated:

| Firmware | text | data | bss |
|---|---|---|---|
| CYD, Designer (touch, 2 widgets) | 204 013 | 9 000 | 187 608 |
| CYD, touch template (same board) | 96 457 | 8 648 | 187 960 |
| T-QT, Designer (S3, no touch) | 167 201 | 9 252 | 398 040 |

So `embedded-gui` costs **about 105 KB of flash** and **no measurable static RAM** on the classic ESP32: the
`.bss` is 352 bytes *smaller* than the template without it, because the GUI's own state is sized by the
markup's node count (a `Vec` of ten-odd nodes) and the heap the template already reserves dwarfs it. That
settles the question §85 left open. A design that uses more widget types will link more of the crate; this
figure is for two widgets.

### Three wiring bugs the gate caught, all mine

The gate was generating a project and compiling it, which is the only thing that would have found these:

1. **A duplicated rule.** `espMainRs` and `espVscodeSettings` each kept their *own* copy of "which templates
   drive a panel" instead of asking `templateUsesPanel`. Adding `designer` to the shared helper therefore did
   not reach them, and the generated Designer project's body was the **RGB LED heartbeat** -- a project with a
   panel that lit an LED and never touched the screen. All three call sites now ask the helper.
2. **A second copy of the same condition** in `espImports` had been missed by the same fix, so the first
   compiling build had no panel or touch imports at all: 120 errors naming `Point`, `SpiConfig` and
   `SPIInterface`.
3. **`embedded_graphics_core` is not nameable** in a project that declares `embedded-graphics` (which
   re-exports it): `use embedded_graphics_core::...` does not resolve. Through `embedded_graphics::{draw_target,
   pixelcolor}` it does.

And one repeat of an old hazard: a backtick inside a *comment* in a generated template literal terminated the
literal. `tsc` reported the syntax error and **still emitted JavaScript**, so the build ran a mangled generator
and looked fine. Third occurrence of this class in this project, and the lesson is the same each time: run
`tsc` and read its exit status before believing anything downstream.

### The wizard opens the canvas

Choosing the Designer template now offers **Open Designer** instead of *Open Project*, and opens the panel on
the folder the wizard just wrote. That needed `readProjectAt`, because a project the extension has just
generated is not a workspace folder yet -- `readActiveProject` only ever looked at workspace folders.

### Not yet verified

The firmware **compiles and links**, and nothing more: no board has run it. Whether the design appears at the
right size and position on glass, and whether a touch lands on the widget it looks like it should, are what a
flash and an eye have to answer -- and the rotation is the specific thing to check, since the markup is sized
for the turned panel while the panel itself is still driven at its native size through mipidsi (§81/§82).

## 88. Does a touch land on the widget it looks like? Answered without a board (2026-10-08)

### The half a screenshot cannot show

§86 proved the layout engine puts every widget on the rectangle the canvas drew. That is only half of what a
WYSIWYG designer promises: the other half is that a *finger* at those coordinates reaches that widget. That is
the question a flash and a finger would answer, and it can be answered deterministically instead, because the
crate's input path is ordinary code: `handle_input(InputEvent::Pointer { .. })` in, `pop_event()` out.

So `tests/sim` gained a second binary (`touch`). It taps the designed centre of every widget the fixture gives
an event to and checks that an event *for that widget* comes back, and then taps a point no widget covers and
checks that nothing claims it. The coordinates are generated from the fixture by the same tool that writes the
markup, so nothing in the test is hand-written that the canvas did not draw.

**Result:** every tapped widget received its own event, and the empty canvas claimed nothing. The negative
half matters as much as the positive one: a check that could not tell "no widget" from "the right widget"
would pass for the wrong reason.

Both halves now run in `--e2e`, as two tests over one host build.

### And a log line, so the glass test can be read

The generated firmware panicked loudly when a design could not be built and said nothing at all when it could,
which makes a flash hard to interpret: a black panel and a design that drew fine look the same from the serial
port. The Designer body now logs `design: built and painted WxH` once, on the first calibrated frame, so that
flashing a Designer project answers the first question by itself -- whether the design exists at all.

### What is still only a compile

The firmware compiles and links for both panel boards, the geometry is proven on a host render, and the event
path is proven on the same render. What remains is the part that needs the hardware: that the panel shows the
design at the right size and position, that the touch driver's mapped coordinates agree with what the canvas
showed (the mapping is the template's long-standing one, but it has never been exercised through this path),
and that the rotation is right -- the markup is sized for the turned panel while mipidsi is still given the
native size (§81/§82). No board is on USB at the moment of writing, so that test is queued rather than done.

## 89. On the glass at last, and it dies: a divide-by-zero in the grid layout (2026-10-08)

### What the board did

The Designer project was flashed to the CYD (rotation 3, the orientation its stored calibration belongs to)
and the board printed its boot, loaded the calibration from flash, and then took an exception:

    Exception occurred on ProCpu 'DivideByZero'
    Context { PC: 0x400f5a85, A2: 480, A3: 0, ... }

The panic came out of `esp-hal`'s default exception handler, so the *root* fault is the exception, not a Rust
`panic!`. Symbolising with `espflash monitor --elf` and `xtensa-esp-elf-addr2line` puts the fault inside
`embedded_gui::layout::GridLayout<5, 5>::resolve_tracks`, at the line of

    let remaining = space.saturating_sub(fixed_sum);

with `<u32>::saturating_sub` inlined there and 480 in `A2` against 0 in `A3`. The design is 480x320 with a
5x5 grid of **pixel** tracks, which is exactly what the pixel-exact mapping produces: `fixed_sum` is the whole
480 px of the design and there is no fractional track anywhere in it.

The screen went black, which is what a panic in the paint path looks like.

### What it is not

The same markup, the same generated `ui.rs` and the same 480x320 viewport render perfectly on the host --
`tests/sim` builds it, paints it, taps it and dispatches it, all in `--e2e`. So the difference is on the device
side, and a first hypothesis was wrong: reproducing the *target's* mismatch (viewport 480x320, render target
320x480, which is what mipidsi reports for a rotated panel) does **not** panic on the host
(`src/bin/box_mismatch.rs`, kept for the next attempt). Something else about the device makes `space` smaller
than the design's 480 px, and finding it is the next step.

### Where the next attempt starts

The faulting function has no unchecked division left in the code I can read (`checked_div`, `saturating_sub`),
which means the divisor is a *value* that is zero at runtime rather than a division I can see -- so the next
step is to make the device tell us: patch `embedded-gui` locally with a print of the resolved track state (a
`[patch]` entry, a debug build, a flash) and read the numbers. That loop is now cheap: one flash per attempt,
and the board is on the desk.

Two things are already clear enough to act on: a design whose tracks total more than the space available is
the trigger, and the designer's landscape canvas is what makes the total 480 while something on the device
offers less.

### The board is back on a known-good build

The CYD is running the verified touch template again (124 544 bytes) rather than a firmware that dies, so the
hardware is not left in a broken state while this is worked out.

### And the host-side harness did its job

Before the flash, `tests/sim` gained a third binary that drives the *generated* `ui.rs` -- `new`, `pointer`,
`pump`, `render`, `repaint`, `is_dirty` -- with counting handlers, so the dispatch chain the extension
generates is now tested rather than only compiled. Writing it with the wrong expectation found a real
semantic: **a press captures the widget it lands on**, so a finger that goes down on a button and lifts
somewhere else still clicks it, while a press that starts on empty canvas clicks nothing even if it ends on
the button. That is now asserted, and worth knowing because it is not what every toolkit does.

## 90. The fix: one zero-width fractional track, and the designer runs on glass (2026-10-08)

### The bisection, and why the backtrace was a red herring

§89 left a fault inside `resolve_tracks` in a function that contains no division. Three flashes settled it:

1. **A portrait design crashed too** (320x480, rotation 0, the display's own box). That killed the "landscape
   canvas is wider than mipidsi's box" theory outright -- and the register dump was the clue: `A2` was 320
   where the landscape run had 480, so the numerator was the *canvas width* in both.
2. **Disabling the render did not save it.** The `design: built` line still never appeared, which put the fault
   inside `ui::Designer::new` -- that is, in `build`, before a single pixel was painted.
3. **One trailing `1fr` track fixed it.** `build` resolves the grid's tracks, and with every track a pixel
   track there is no fractional track at all.

Which is the whole story: `GridLayout::resolve_tracks` computes `checked_div(total_fr)`. With an all-pixel
grid, `total_fr` is 0 -- and the source-level zero check does not save the board, because **the Xtensa core has
no hardware divide**: the division is an out-of-line libcall, LLVM issues it speculatively, and the routine
raises `EXCCAUSE 6` before the check's `None` can be selected. On x86_64, where the host simulator runs, the
same source does not trap. That is why every host check passed while the board died, and it is the clearest
example yet of the rule this project keeps relearning: **the host proves the logic, the board proves the code**.

The symboliser pointing at `saturating_sub` in a function with no division was the other lesson: optimised
backtraces attribute inlined code to lines that can mislead, and three flash-and-read cycles beat another hour
of reading.

### The fix

Every emitted grid now ends each axis with `GRID_FILLER` (`1fr`). It is provably neutral rather than a
fudge: the pixel tracks are built from the design's own edges and include 0 and the full width, so they total
the canvas exactly, the space left for a fractional track is zero, and the filler resolves to 0 px. The bare
`trackSpec(tracks, false)` is still the geometry-only form the round-trip tests use, and all three host checks
still pass with the filler in place -- tracks land exactly, taps reach their widgets, the generated `ui.rs`
dispatches.

### Confirmed on the board

The properly generated Designer project (rotation 3, no diagnostic hacks) was flashed and the log reads:

    INFO - panel rotation setting: 3
    INFO - panel ready: 3.5" ST7796 320x480
    INFO - calibration: loaded from flash - axis1 188..1866 1802..262
    INFO - design: built and painted 480x320
    INFO - design: on_go_clicked fired

The last line is the one that matters most: a touch landed on the button in the design and the **generated
handler ran**. The chain the whole feature rests on -- design document, markup, build-time code generation,
the panel, the touch driver's mapping, the widget's hit test, the dispatch match, the user's handler -- is
working on hardware. The template's own log line, added two rounds ago so a flash would be readable, is what
made this legible.

## 91. The panel, finally run: a stub DOM, and a debounce that could lose an edit (2026-10-08)

### The one part nothing had touched

Everything else in this feature had been tested or flashed. The designer's frontend had not: it is a browser
bundle, and "it compiles and it typechecks" is a weak thing to say about code that builds a Toolbox out of the
catalogue, turns a pointer into a drag, rebuilds a property panel and posts documents.

It did not need a browser. It needed a dozen DOM methods. `tests/lib/dom.js` is a deliberately thin stub --
`createElement`, `append`, `classList`, `addEventListener`/`emit`, `getContext('2d')` as a proxy that records
drawing calls, `getBoundingClientRect`, and `acquireVsCodeApi` capturing what gets posted -- and it fails
loudly on anything it does not implement, because a stub that swallowed everything would make the test pass
for the wrong reason.

`tests/layers/t2-cli/designer-webview.test.js` then loads the built bundle the way a webview does and drives a
session through it: the init message, a press on the button, a drag, Delete, Undo, a click on a Toolbox entry,
and an edit of a text field. **All of it works**, and the assertions are on what the panel *told the
extension*, because that decides what gets written to the project:

- the Toolbox holds all thirty tags, by the catalogue's own labels;
- the canvas is sized to the design (480x320 at rotation 3) and is drawn;
- a press selects, and the property panel shows that widget's own fields;
- a drag posts the whole document with the widget moved by the drag;
- Delete posts a document without it, and Undo posts one with it back;
- a Toolbox click adds a widget of that kind at the catalogue's default size;
- editing a text field posts the new value.

### The bug it found

The sixth of those failed at first, and the reason was not the test: **property edits were being batched on the
120 ms timer meant for drags**. A drag produces an edit per pointer move, so batching it is right; a property
edit is discrete -- a field's change event, a click, a layer button -- and a user who edits a property and
closes the panel is a user who loses the edit. Those now post at once.

That is the sort of thing only running the code finds, and it is the second time this round that a test paid
for itself by being written with a wrong expectation.

### And the runner builds the frontend now

`node tests/runner.js` compiled the TypeScript but not the esbuild bundle, so a test that loads `out/webview/
designer.js` could have passed against a bundle older than the source. The runner now builds it too, for the
same reason it runs `tsc`: a stale artifact must not be able to make a test green. It takes tens of
milliseconds.

## 92. Fonts made real, and the asset root nobody had noticed (2026-10-08)

### The field that could not work

`Font id` was a text box that did nothing. A widget's `font` is not a file and not a built-in name: it is a
reference to a font **the screen declares**, and `embedded-gui-codegen` drops an unresolvable name without a
word -- so the field took whatever was typed and silently discarded it.

Fonts are now first-class design data:

- **The document** carries `fonts: [{ id, src, chars }]`, and the file version went to 2 with a *migration*
  rather than a refusal: version 1 documents gain an empty list, because refusing them would throw work away
  over a field that did not exist when they were written. Anything newer is still refused loudly.
- **Validation** checks what the generator would otherwise swallow: the name is a plain identifier, no two
  names collide *after the crate's own sanitisation* (`Title` and `title` both become `__FONT_TITLE`), the file
  is named and is a `.bdf`, and every widget's reference resolves to a declaration.
- **The panel** declares fonts under **Fonts** on the Screen form (name, file, characters) and a widget's
  `Font` is a dropdown of what is declared, with a way back to the default.
- **The markup** writes the declarations before the grid, so a reader meets `font="title"` after the
  declaration that gives it meaning.

### The find: asset paths were resolved from the wrong directory

Building the harness with a font failed with a message worth more than the hour it saved:

    Failed to read font '.../tests/sim/screens/assets/test.bdf'

The macros resolve an asset relative to the **screen file's** directory, unless they find a `project.kdl`
somewhere above it -- `find_project_root` walks the ancestors and falls back to the screen's own directory.
For a generated project that means `src/`, so `src="assets/logo.bmp"` was being read as
`src/assets/logo.bmp`. **That was a latent bug for images and meshes too**, and worse, the designer's own asset
check resolved the same path from the project root: the panel would have said the file was fine while the
compiler looked somewhere else.

The fix is the crate's own mechanism rather than a workaround: a designer project now gets a `project.kdl` at
its root, which anchors the asset root there and matches what the validator checks. It declares the screen as
well, so the project is already a valid `include_project!` target if a design ever grows into several screens.

And it is now *exercised*: the harness has a real three-glyph BDF (`tests/sim/assets/test.bdf`) and a label that
uses it, so every host check -- geometry, touch, dispatch -- compiles a design that declares a font and refers
to it, parses the font at build time and renders with it.

### Hover descriptions for every property

Every one of the 64 distinct properties and all 30 widgets now carry one line of help, shown as the field's
`title` -- a native tooltip, so there is no popup to keep in step with the theme and screen readers announce it
too. The help lives in the catalogue (`PROPERTY_HELP`, with `TAG_PROPERTY_HELP` for the handful that mean
something different per widget, like `radius` on a rectangle and on a circle) and a test asserts the coverage,
so a new property cannot arrive without an explanation. The `Font` property's own line points at the section
that declares fonts, which is the answer to the question that started this.

## 93. The diagnostic readout was still painting over the design (2026-10-08)

### What was reported

"I can touch anywhere on the screen to update the touch readout. Touching the button only should trigger a touch,
not anywhere on the screen." -- from the board, watching a Designer project.

The touch template has **two** diagnostic surfaces, not one: the screen it draws (calibration, or the graphics
test) and a separate raw-numbers box that is repainted whenever `redraw_box` is set. When the designer was wired
in (§87) the `DESIGNER` guard was put on the *screen* choice -- `if DESIGNER { paint the design } else { draw the
diagnostic screen }` -- and the box sits **after** that branch, in its own `if redraw_box` block. So a Designer
project still painted raw controller readings over the middle of the design, and every touch anywhere set
`redraw_box`, which is exactly the behaviour reported.

That is the lesson worth keeping: "the diagnostic template's diagnostics" turned out to be plural, and I guarded
the one I had been reading about rather than all of them. Fixed by guarding the box's condition with
`!DESIGNER`, so the design is the only thing a finger can cause to change.

### And the heartbeat, which was the same oversight in the log

A Designer project also logged `touch test alive: a=0 b=1683 idle a=0 b=1697 pen=false` every two seconds
(measured: nine times in a 28-second capture). That line exists so "the log is quiet" cannot be mistaken for
"the app is not running" in the *touch test*, and its wording is that template's. In an app it is noise. It is
now guarded out of Designer builds too; the per-touch lines and the design's own event logs remain, which is
what tells you the touch driver and the handlers are working.

### Verified

- A test asserts both guards in a generated Designer project *and* that the touch template keeps its readout and
  has no `DESIGNER` symbol at all -- so this cannot regress by someone tidying the template.
- Rebuilt and flashed the same font design: the log now shows no heartbeats, and `design: built and painted
  480x320` followed by `design: on_go_clicked fired` for each press. The absence of the box is visual, so it is
  the one part a log cannot show.

## 94. Proving a font reaches the pixels, and a menu on the control itself (2026-10-08)

### The font difference, as a check rather than an eyeball

"Fonts work" was verified by looking at the panel. That is not a check: the failure mode of the old field was a
reference the generator **silently drops**, and a build that drops it compiles and renders perfectly -- with the
default font. So the harness now renders the fixture twice, once as it stands and once with the declarations
removed and the reference cleared, and asserts two things about the difference:

- it is **non-zero inside** the rectangle of the widget that was given the font -- otherwise the reference was
  dropped;
- it is **zero everywhere else** -- which is what stops the check passing for the wrong reason, since a build
  that painted nothing at all would otherwise satisfy the first half.

Measured: **34 of 2700 pixels differ inside that label, and 0 of the 150 900 outside it.** The 34 are the
strokes of the two glyphs, and the second number is the proof that a font is applied to its own widget and
nothing else.

### The right-click menu

Deleting, duplicating and reordering a control were only reachable from the layer list, which is a list of
*names*. Right-clicking the control itself is the shorter path, so that is where the menu now is: **Duplicate,
Bring forward, Send backward, Delete**, with Delete in the error colour. The browser's own menu is suppressed
even on empty canvas -- one that sometimes shows the page's menu instead is worse than one that does nothing --
and it closes on a click or Escape.

Writing its test found something worth fixing: a duplicate was named after its **tag**, so a copy of `title`
came out as `label`, which reads as a different thing entirely. Copies are now named after the widget they copy
(`title_2`), which is what anyone would expect.

Two mistakes of mine in that test, both worth the note because they are the same mistake: I asserted absolute
counts of widgets in a session whose state depends on where in the session the assertions sit, and both times the
fix was to assert *relative to what is there now* (`before + 1`) rather than to a number I had counted by hand.

## 95. A file picker, and who owns what when a dialog is involved (2026-10-08)

### The division of labour

An asset field used to be a text box: fine for `assets/logo.bmp` if you already knew the path, useless if you
did not. Now every field that names a file -- a font's BDF, an image's or mesh's `src`, each part of an icon --
has a browse button. The interesting part is who does what when it is clicked:

- the **extension** opens the dialog, because only it can, and only it knows the project folder;
- the **panel** makes the edit when the answer comes back, because the document and its undo history live there.

That is why the request carries an id and the answer carries it back -- a modal dialog takes as long as the user
takes, so more than one can be in flight -- and why the panel hands the extension an *apply* closure rather than
a field name: the extension never touches the document, which is the arrangement the whole channel is built on.

### What a chosen file does

A design's paths are relative to the project root (that is what the generated `project.kdl` anchors), so a file
picked from elsewhere on the disk is **copied into `assets/`** rather than referenced: `../../Pictures/logo.bmp`
would work until the folder moved and then fail at build time with a path nobody recognises. Actions:

| Chosen file | What happens |
|---|---|
| already inside the project | referenced where it is |
| somewhere else | copied to `assets/<name>`, and referenced there |
| a name already taken | the copy gains a number (`logo-2.bmp`), because replacing a file the design uses would be a silent loss |
| the dialog cancelled | nothing: the field keeps what it had |

The dialog's filters are the formats the build actually reads, taken from the crate rather than guessed: **BDF**
for fonts, **OBJ and STL** for meshes (its own error message lists them), and for images the raster set the
`image` crate decodes.

### The trap in "is this file inside the project?"

Comparing paths as strings says `/home/me/project-two/logo.bmp` is inside `/home/me/project` -- it shares a
prefix and is a different folder. The comparison is by path *segments* for that reason, and there is a test
named after it. The planner is a pure function (`planAssetImport`) so that decision, the name-clash rule and the
separator handling are all tested without touching a filesystem.

## 96. Touch as a choice, and what "off" turned out to mean (2026-10-08)

### A project setting, like the rotation

`TOUCH_ENABLED` lives in `.cargo/esp-config.toml` beside `LCD_ROTATION` and for the same reason: it is the
project's choice, and it has to survive `src/main.rs` being written once. Both paths are generated and one is
folded away at compile time, which is what lets the designer's toolbar flip it without regenerating anything:

    const TOUCH: bool = match option_env!("TOUCH_ENABLED") { ... };

Only `"0"` is off, and an absent key means **on**. That is the backwards-compatible answer rather than the tidy
one: every project generated before this setting existed had a working touchscreen, and a default of "off" would
have silently taken it away on the next build. The wizard writes the key explicitly for every new Designer
project, so the default only ever applies to the ones that predate it.

Two things about the folding are worth recording. Matching a `&str` in a `const` is **not stable Rust** --
`PartialEq` for `str` is not a const trait -- so the first version of that line did not compile (E0658) and the
comparison is a length and a byte instead. And the `touch` option had to be threaded from `generateProjectFiles`
down to the ESP generator before it did anything at all, which the first attempt forgot.

### What "off" turned out to mean, from the board

The first version guarded the *loop*: no sampling, no calibration screen, and a build that logged nothing about
touching. The board said otherwise:

    INFO - touch: XPT2046 on GPIO33 (cs), GPIO36 (irq), pen level now false
    INFO - touch: idle baseline a=0 b=1701
    INFO - calibration: none stored

The *startup* still identified the controller, switched the bus to its clock, read the idle baseline twice and
powered the chip down again. That is traffic to the chip, which is exactly what "the touch controller is only
enabled when the user asks" forbids. Taking a baseline **is** talking to the controller; there is no such thing
as a quiet baseline. So the startup is guarded too -- identity log, baseline and the calibration report -- and
with touch off the chip is never addressed.

### Verified on hardware, both ways

| Build | The log |
|---|---|
| touch **off** | `panel ready` … `design: built and painted 480x320`, and **no touch line at all** |
| touch **on** | the controller, the idle baseline, the calibration loaded from flash, the design painted -- and a touch on the glass triggering the recalibration gesture, the four corners measured and a fresh calibration stored |

### The rules that go with it

- **Dropping a control turns touch on.** A widget is interactive exactly when its catalogue entry declares an
  event, so the rule needs no second list to maintain: drop a Button or a Slider and touch is enabled with a note
  saying so and that a rebuild is what makes it real.
- **Switching it off with controls in the design is reported, not enforced.** A half-built design, or one whose
  buttons are placeholders, is a legitimate thing to have; but those controls will do nothing on the board, so
  the panel says exactly that and still saves.

And the oldest hazard in this project bit again: a TypeScript string I built with literal newlines inside it,
where `tsc` reported the syntax error and **emitted JavaScript anyway** -- leaving a generator that could not even
load. Fourth time. Read the exit status, not the output.

## 97. The font picker: two routes to a font, and only a build can tell them apart (2026-10-08)

The request was a Font picker: a list of every font the crate ships, next to the file browser that was already
there. Seemed small. It turned out to be the first feature in this project where the *markup has no attribute for
the thing the user is choosing* -- and where the generator is silent when you get it wrong.

### The crate's own fonts are not nameable

`FontId` has eight variants (`Tiny3x5`, `Medium4x7`, `Scaled6x10`, `Vector(u8)`, `Custom`, `Bitmap`, `Dynamic`,
`MonoFont`), and three of them ship inside the crate. None of them can be asked for with `font="..."`: that
attribute names a font the **screen declares**, which means a BDF file in the project. Write `font="Scaled6x10"`
and `font_const_name` finds no such declaration, so the reference is dropped *without a word* -- the same silence
that made the old text box a trap in §92.

What does reach them is `style`. The codegen's `style_expr` accepts any Rust expression and passes it through, and
the crate's own named styles read like a font menu: `body`, `menu` and `body-accent` select `Scaled6x10`, `hint`
and `hint-accent` select `Medium4x7`. So a built-in font is asked for by writing the expression the crate would
have written itself:

    style="{ let mut style = Style::label(); style.font = FontId::Scaled6x10; style }"

Two routes to one dropdown, and the emitter has to pick the right one per value: a built-in goes out as `style`,
a declared BDF as `font="name"`. Validation still refuses a name that resolves to no declaration, and now also
refuses a *declared* name on a widget that cannot read one.

### "All relevant controls" is a much smaller set than it sounds

The follow-up asked for the colour and font pickers on every control, not just the Button. Measuring the crate
said most of that is not available, and the honest thing is to offer exactly what is:

- **Colours** reach the **Button** only. Every other tag's appearance comes from the theme; the catalogue has no
  colour properties to show for them, because the parser reads none.
- **A `font`** is read for **Label** and **Carousel** only.
- **A `style`** is honoured by **Label, Button, Panel, Carousel** -- and *ignored* by **Table**, whose emitter arm
  hard-codes `Style::panel()` and never looks at the attribute. The Table therefore gets no Font field: a control
  that does nothing is worse than a missing one.

So the Font field exists on Label, Carousel and Button, and the list is built from what each tag can actually
take rather than offered wholesale: Label and Carousel get both groups, Button only the built-ins.

### A button's style expression must be a `WidgetStyle`

This is the part a build found and nothing else would have. The button's emitter arm takes the style expression
and *chains builder calls onto it* -- `.with_bg(...)`, `.with_corner_radius(...)`, all of them -- because a button
carries per-state colours. A plain `Style` has none of those methods, and since the designer always writes those
colour properties, the failing case is not an edge case: it is every button. `WidgetStyle::button().with_normal(s)`
is what satisfies both sides, and it is the only reason the button's font renders at all.

The first host run failed for a different and more embarrassing reason. The fixture asked for `Tiny3x5`, which is
what `Style::new()` and `Style::label()` already start from -- so "no pixels changed" meant the measurement was
empty, not that the feature was broken. The default font in this crate is the *smallest* one, which is what the
dropdown now says out loud.

### What proves it

The host harness gained a second fonted widget (a Label with `Scaled6x10`) and a third (a Button with
`Vector(2)`), and `font_diff` now measures *every* region the design gave a font to rather than one:

    PASS: the fonts changed 222 pixels inside their widgets
          (one count per widget: 34 of 2700, 78 of 2700, 110 of 2700)
          and none of the 145500 outside them

Three routes, three counts, nothing leaking. 34 px is the declared BDF; 78 and 110 are the built-ins, on a label
and on a button -- the second of which is only there because the expression is a `WidgetStyle`.

## 98. "The project is created but the folder is not loaded": the Designer skipped a step (2026-10-08)

A report, in the user's own words: *"When creating a project using the Designer, the project is created but the
folder is not loaded into the IDE."* Exactly right, and the cause was one line: for the designer template the
notification's first button said **Open Designer** and opened the canvas, where every other template's first
button said **Open Project** and ran `vscode.openFolder`. The designer flow had been built on the reasonable
sounding idea that the canvas does not need the folder to be a workspace folder -- `showDesigner` takes an
explicit target -- and that is true of the canvas and false of everything else. No Explorer entry, no Source
Control, no terminal opened in the new project, no language service. The extension wrote a project and then
behaved as though it had not.

The fix is not "call `openFolder` too", because `openFolder` *replaces* the window: the notification, the log and
the panel that was about to open all go with it, and the wizard would reload the window even when the project was
created inside the folder that is already open. Instead the folder is added to the current window
(`updateWorkspaceFolders`), which is non-destructive, and the created project is loaded whatever the user
answers -- **Later** and **Build Now** never loaded it either, which the same report makes visible once you look.

### The part the API documentation had to be read for

`updateWorkspaceFolders` is not a quiet operation. The `vscode.d.ts` note says it may cause "the currently
executing extensions (including the one that called this method) to be terminated and restarted ... when the
first workspace folder is added, removed or changed ... Another case is when transitioning from an empty or
single-folder workspace into a multi-folder workspace". Between them those two cases are most of how this wizard
is used, so the naive version of this fix -- record nothing, then `await showDesigner(...)` after the change --
would lose the panel precisely when the user asked for it, and would look like a race that only some machines
have.

So the request to open the Designer goes into `globalState` **before** the folder is loaded, and `activate` picks
it up on the other side:

    requestDesignerAfterReload(...)   // survives the restart
    await loadIntoIde(target)         // may end this session here
    await showDesigner(...)           // reached only if it did not
    await forgetPendingDesigner(...)  // ... and then the request is cancelled

The order of those last two is the whole trick: opening the panel before cancelling the request means that a
restart which happens *after* the panel opened still finds the request and reopens it, and the panel is a
singleton, so reopening is harmless. Global state rather than workspace state for the obvious reason -- the
workspace it belongs to is the thing being created, so there is no identity to key it on yet. And the request
carries a timestamp, because one that was never consumed (the user closed the window instead of waiting) must not
open a panel twenty minutes later when the same folder is opened for some other reason.

### What is testable about it

The interesting half is a path question -- is the new project already inside a folder this window has open? --
so that part is its own module (`src/project/workspaceFolders.ts`) with its own tests, including the case a string
prefix gets wrong: `/home/abc` is not inside `/home/ab`, and `startsWith` says it is. The two `vscode` calls that
do the loading are asserted by source, as the other command tests are, along with the ordering above -- which is
the part that would silently rot.

## 99. The appearance request, finished: the named styles are the handle (2026-10-08)

The second half of the request -- "Only the Button control have the colour picker and font picker at the moment.
All relevant controls should have these properties" -- is answered in two different ways, and the difference is
worth writing down, because only one of them is the crate's fault.

### Colours were already everywhere they could be

The catalogue was built from the parser's own `get_*_prop` calls, so every colour property the crate reads is in
it, with a colour input attached to `kind: 'color'`. That is fourteen names across most of the tag list (`fill`,
`stroke`, `color`, `tint`, `bg`, `fg`, `text_color`, `border_color` and the per-state button set) -- it is just
that the *button* is the only widget whose parser arm reads a whole per-state style, so it is the only one with
a crowd of them. Nothing was missing; the Button simply looked like the only widget with a colour picker because
it has fourteen.

### The style attribute is the appearance handle, and it is real

What was genuinely not offered is `style`. Reading `style_expr` in `embedded-gui-codegen` gives the mapping, and
its first surprise is that most of the crate's names are aliases: `default`, `label`, `bold`, `dim`, `accent`,
`success`, `danger` and `inverted` all become `Style::label()`; `card` becomes `Style::panel()`; `body*` and
`menu` are a label carrying `Scaled6x10`; `hint*` a label carrying `Medium4x7`. Those font aliases are the Font
field's business, named more directly there.

What is left are four constructors that genuinely differ from one another -- and they differ in more than colour,
which is why this is a real appearance control rather than a colour picker in disguise:

| | background | gradient | corner | border | shadow |
|---|---|---|---|---|---|
| `label` | none | none | 0 | none | none |
| `panel` | `new(2,4,8)` | vertical | 2 | yes | soft |
| `button` | `new(4,8,12)` | vertical | 2 | yes | 1px offset |
| `progress` | `new(3,4,5)` | **horizontal** | 1 | yes | none |

So a Label can wear a panel's card, and a Panel a progress bar's thin horizontal fill. That is the "colour
picker" for controls whose own properties have no colour: the crate's answer is a style, and the picker offers
the four that mean something.

Two things follow from the resolver, and both are the reason this is a closed list rather than a text field:

- **An unknown name is passed through verbatim as Rust.** `Some(s) => s.to_string()`. A typo would not be
  ignored, it would be compiled into the generated project. So validation refuses anything outside the four, and
  the emitter refuses too -- the same discipline the font reference gets, for the same reason.
- **A `#rrggbb` becomes a `WidgetStyle::button()`**, which is a button's shape and no other widget's, and which
  the button emitter then overrides with the design's own colour properties. So the colour-as-style route adds
  nothing to a designer that already writes those properties, and is not offered.

### One attribute, not two

A built-in font *is* a style expression (§97), so a widget with both a base style and a crate font cannot write
`style` twice -- the markup would not parse. The two are composed into one, which is why the expression builder
moved out of `fonts.ts` into its own module (`src/designer/appearance.ts`):

    label, style=panel, font=Scaled6x10
      -> style="{ let mut style = Style::panel(); style.font = FontId::Scaled6x10; style }"

    label, style=panel, no font
      -> style="Style::panel()"          # exactly what the resolver would have produced for the name

    button, font=Vector(2), always colours
      -> style="WidgetStyle::button().with_normal({ let mut style = Style::button(); style.font = ...; style })"

A test asserts one `style=` per widget, because getting that wrong is a build failure rather than a wrong pixel.

### Measured

The host harness now measures every widget that was given an appearance, by any of the three routes, and the
fixture grew a label wearing `Style::panel()`:

    PASS: the appearances changed 2910 pixels inside their widgets
          (one count per widget: 34 of 2700, 78 of 2700, 110 of 2700, 2688 of 2700)
          and none of the 142800 outside them

2688 of 2700 is the styled label: a panel background filling a 90x30 box, minus the glyphs drawn on top of it.
All four counts are non-zero and nothing leaked, which is the whole claim.

## 100. "DesignerESP32-035 Build error": one bug of ours, ten of the crate's (2026-10-08)

Reported from a test project. Building it produced one error, inside the macro:

    error[E0308]: arguments to this method are incorrect
      --> src/ui.rs:19:5
       |
    19 |     embedded_gui::include_gui!("src/ui.kdl");
       |     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ expected `f32`, found integer

`add_slider` is declared `(value: f32, min: f32, max: f32, style)`. The markup's `slider` node is parsed into
`min: i32, max: i32, value: i32`, and the emitter writes those three integers into the call -- so the arguments
are the wrong type *and*, once that is fixed, in the wrong order (`min, max, value` against `value, min, max`).
That is a defect in `embedded-gui-codegen` 0.2.7, and no markup can avoid it: the call is written by the crate.

So the reported error is not ours. Investigating it properly, though, turned up one that is.

### Ours: children were indented, not braced

Writing a probe that used *every* tag in the Toolbox was the only way to find out how far the crate's own
mismatch went -- and it failed immediately, before the compiler was even reached:

    error: KDL GUI Codegen Error: Unknown widget or container node: 'option'

KDL has no indentation-based nesting. Our emitter wrote a widget's children as deeper lines:

    dropdown id="pick" selected=0 col=0 row=3 col_span=1 row_span=1
        option "One"

which KDL reads as three **siblings** -- `dropdown`, `option`, `option` -- and codegen then rejects `option` as
a widget. The screen and the grid were always braced, which is exactly what made the omission invisible; and
the host fixtures never used a dropdown, roller, carousel, table or icon, which is why 786 tests and four
hardware checks had nothing to say about it. Five tags, and every one of them produced markup that could not be
parsed at all. The fix is two lines in `emitKdl`, and the new test pins the block for a dropdown *and* for an
icon -- the icon being the tag whose children the parser is strictest about.

With the braces in place, the same probe compiled everything else, which is the proof that the nesting was the
whole of it.

### The crate's: ten tags whose builder call cannot be built

The probe's second run reached the compiler, and the compiler named the rest. Measured, one widget of every tag
the Toolbox offers, against `embedded-gui` 0.2.7:

| tag | the crate's own error |
|---|---|
| `slider` | `[E0308]` three `i32` where `add_slider` wants `f32` -- and in the wrong order |
| `arc` | `[E0061]` `add_sweeping_arc` takes ten arguments, called with four |
| `busy_wheel` | `[E0599]` there is no `add_busy_wheel` |
| `chart` | `[E0061]` `add_plotter` takes `(values, head, min, max)`, called with a `ChartMode` |
| `status_bar` | `[E0599]` there is no `add_status_bar` |
| `time_picker` | `[E0599]` there is no `add_time_picker` |
| `number_picker` | `[E0599]` there is no `add_number_picker` |
| `content_indicator` | `[E0599]` there is no `add_content_indicator` |
| `crumbs` | `[E0599]` there is no `add_crumbs_indicator` |
| `path` | `[E0433]` names `Point` without importing it, and builds `PathVerb::QuadTo` as a tuple variant where the runtime declares a struct variant |

Ten of the thirty tags. The two crates do not agree with one another: `embedded-gui-codegen` 0.2.7 emits
against an API `embedded-gui` 0.2.7 does not have. There is no newer version of either to move to -- 0.2.7 is
the latest published -- so this cannot be fixed by a version bump.

**What we do about it.** A WYSIWYG designer's one promise is that what is on the canvas appears on the glass, and
a Toolbox entry that produces a project which cannot compile breaks it in the worst possible way: the failure
arrives minutes later, inside a macro, in a file the user did not write. So those ten tags are marked
`unavailable` in the catalogue with the compiler's own words as the reason, the Toolbox no longer offers them,
and validation refuses a design that contains one -- so an older design file, like the one in the reported
project, is reported by name on load and can be selected and deleted rather than built and failed.

They stay in the catalogue rather than being deleted, for two reasons: the reason has to be shown to whoever
wonders where the bus wheel went, and the day the crate is fixed the ten `unavailable` lines are deleted
together. Nothing else changes.

The one thing this deliberately does *not* do is patch the crate: a `[patch.crates-io]` pointing at a vendored,
fixed `embedded-gui-codegen` inside every generated project would fix all ten at once, and it is a real option --
but it means shipping and maintaining a few thousand lines of someone else's source in every project the
extension creates, which is the user's decision to make rather than mine to take quietly.

## 101. "How do I set a Label's font and colour?" — one yes, one only through the style (2026-10-08)

The question, and the follow-up that matters more: *"Also check other controls for this problem."*

### The measure

Two greps answer it. The parser reads `style` **once**, at line 327 of `parser.rs`, and only four widget arms
carry it into their `WidgetDef`: `label` (and `banner`), `button`, `panel` (and `card`), `carousel`. The emitter
calls `style_expr` at exactly four places, with those same four defaults (`Style::default()`, `Style::button()`,
`Style::panel()`, `Style::label()`). Every other tag's builder call is written with a hard-coded
`Style::default()` or `Style::panel()` and no way to change it.

And the parser reads colour properties for `button` alone -- fourteen of them, the whole per-state set. Every
other tag either has no colour property at all or has its own single one (`fill`/`stroke` on a circle, `color` on
a line), which the catalogue already offers with a colour input.

| | font | text colour | base style | own colours |
|---|---|---|---|---|
| Label | **yes** (built-in via style, declared BDF via `font=`) | **yes** (via style) | yes | — |
| Carousel | **yes** (as a label) | **yes** (via style) | yes | — |
| Button | built-in fonts only | yes (real `text_color`) | yes | 14 properties |
| Panel | no text | — | yes | — |
| Toggle, Checkbox, Dropdown, Roller, Spinbox, Table, Dialog, Progress, … | no | no | no | — |
| Rect, Circle, Line, Image, Icon | no text | no | no | `fill`/`stroke`/`color`/`tint` |

So the answer to the question is: **the font, yes, from the Font field -- and the colour, not before this
release.** The crate paints text as `TextStyle::new(style.text).with_font(style.font)`, so the colour exists in
the runtime but has no attribute in the markup, and the designer offered no way to write the expression that
reaches it. That is a gap of exactly the kind §99 was about: the crate has a handle, and the designer did not
expose it.

### What changed

A **Text colour** property on Label and Carousel, taking the same route as the font and the base style, because
there is only one `style` attribute to write:

    label, text colour #ff0000
      -> style="{ let mut style = Style::label(); style.text = Rgb565::new(31, 0, 0); style }"

    label, style panel + font Scaled6x10 + text colour #00ff00
      -> style="{ let mut style = Style::panel(); style.font = FontId::Scaled6x10; style.text = Rgb565::new(0, 63, 0); style }"

The hex-to-5/6/5 reduction is the crate's own (`color_to_rust_expr`), and a unit test pins the arithmetic -- a
canvas swatch and a pixel that disagree would be the same class of lie as §92's silent font. A property that
travels this way is marked `viaStyle` in the catalogue, which is what tells the emitter to fold it into the
expression rather than write an attribute the parser would ignore -- and what stops a button's real
`text_color` attribute from being swallowed by the same code path.

### The rest of the answer

For every other control, **there is nothing to expose**: the crate hard-codes the style in the emitter, so no
markup can reach the font or the text colour of a toggle, a checkbox, a dropdown, a roller, a table cell or a
dialog's body. That is the same shape as §99's ten unbuildable tags, one step milder -- silent rather than fatal
-- and the honest thing is to say so rather than offer a field that does nothing. The table above is the
catalogue's own view, and the README says the same thing in a paragraph.

Measured on the host, all five routes in one run:

    PASS: the appearances changed 2930 pixels inside their widgets
          (one count per widget: 34 of 2700, 78 of 2700, 110 of 2700, 2688 of 2700, 20 of 2700)
          and none of the 140100 outside them

20 is the tinted label, and the small number is the interesting one: a label has no background, so a colour
change moves only the ink -- two glyphs at 3x5 are about that many pixels -- while the 2688 next to it is a
label wearing `Style::panel()`, which fills its whole box. Two controls, the same expression machinery, and the
counts say which one paints what.
