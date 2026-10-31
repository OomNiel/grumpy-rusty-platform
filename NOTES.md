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
11. **The docs are current as of 2026-10-21, v0.13.3** (this release pass). `README.md`,
   `CHANGELOG.md` and this file describe the ESP32 family, the Designer clock and the SMTP wizard; the
   generated project `README.md` documents the four configurations and the breakpoint budget for RP, and
   the flash/monitor behaviour for ESP. A project generated before this pass keeps the older text (see
   item 5).
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

## 102. Shapes on glass, reviewed: one dangling patch, two missing licences, three kinds of drift (2026-10-09)

The Designer's shapes were reworked — circle, rectangle, line and a new triangle became designer-native on the
canvas and real primitives on the board, through a vendored `rusty-gui-widgets` (a `CustomWidget` crate) and a
vendored fork of `embedded-gui-codegen` that emits `add_custom_widget` instead of the `add_panel`/`add_spacer`
stubs. This is the review of that work, and the fixes that came out of it.

### The one that would have shipped broken

`src/generate/esp.ts` wrote `[patch.crates-io] embedded-gui-codegen = { path = "codegen/embedded-gui-codegen" }`
into **every** ESP `Cargo.toml`, while the wizard copies `codegen/` only for the `designer` template. Cargo
resolves a patch entry even when nothing depends on the patched crate, so every other template — blinky, wifi,
bluetooth, display, touch, board, peripherals, sdcard — stopped before compiling:

    error: failed to load source for dependency `embedded-gui-codegen`
    Caused by: failed to read .../codegen/embedded-gui-codegen/Cargo.toml
    Caused by: No such file or directory (os error 2)

The golden snapshots had been regenerated for all of them, so 793 tests passed while recording the breakage —
a snapshot is a faithful record of what the generator emits, not of whether the result builds. The patch is now
written only where the crates are copied, and a generated `blinky` project resolves (`cargo metadata` exit 0).

### Two things a vendored crate owes

The fork redistributed MIT/Apache-2.0 code with **no licence text and no attribution** — the manifest had dropped
`license`, `authors` and `repository`, and no `LICENSE*` files were copied — and that ships in the `.vsix` and is
copied into every user's project. Both licences require the notice to travel with copies and substantial
portions. The vendored crate now carries `LICENSE`, `LICENSE-MIT`, `LICENSE-APACHE` (the upstream texts, fetched
from the upstream repository) and a `README.md` recording provenance, and its manifest declares what it is and
whose it is. `rust-version` was restored too, and the version note is now explicit: the fork **must** stay at
`0.2.7`, because a `[patch]` only applies to a matching requirement.

### Three kinds of drift between the canvas and the glass

The whole promise of the designer is that the canvas is the glass, so these matter more than their size.

1. **A pen of zero drew a 1px line on the board.** `Circle` and `Rectangle` clamped with `.max(1)`, while the
   canvas skips the outline when the thickness is 0 — and the catalogue offers `min: 0` for both. Zero now means
   no outline, on both sides.
2. **A rounded rectangle's outline was square on the board.** The fill used `fill_rounded_rect`, the outline used
   `draw_rect`: two different shapes. The outline is now the four straight runs plus one quadrant of a mid-point
   circle per corner, which is what the canvas strokes. (`CustomCanvas` has no rounded-outline primitive, so the
   arcs are integer pixels — no floats, no allocation.)
3. **A circle with `fill: false` erased on the canvas.** It painted `palette.screen` over whatever was behind it;
   the board passes `fill: None` and leaves the backdrop. An unfilled shape now paints nothing on both sides,
   and a shape that paints nothing at all gets the dashed placeholder outline the designer already uses for a
   spacer — so it can still be seen and selected.

Two `unused_must_use` warnings went with them: `Line::render` dropped the `Result` from `draw_thick_line` while
every other call site propagated with `?`, so a drawing failure was silently swallowed. Every shape now
propagates, and the vendored crates compile clean.

### What now proves it

The host appearance check gained the shapes as measured regions — their ink is stripped in the comparison render,
so a shape that painted nothing, or painted outside its cell, fails there. All eleven regions, one run:

    PASS: the appearances changed 33453 pixels inside their widgets
          (34 of 2700, 78 of 2700, 110 of 2700, 2688 of 2700, 20 of 2700,
           19073 of 19200, 708 of 1200, 4800 of 4800, 4800 of 4800, 822 of 1600, 320 of 320)
          and none of the 108500 outside them

Read the shape numbers and they are the geometry: `708 of 1200` for a 40×30 cell is π·15² — the disc, to the
pixel; `822 of 1600` is ½·40·40 plus its pen; `320 of 320` is a line the width of its cell; the two 240×20
footers fill completely. Nothing leaks, which is the assertion this harness exists to make.

The probe also had a bug of its own that the shapes exposed: regions were attributed by *first* match, and the
fixture puts a line across the footer, so the line's region was swallowed by the footer's and reported as
"changed nothing". A pixel now counts for every region that contains it, and only pixels in none of them count
as outside.

Ten tests in the vendored crate now include a zero-width pen (no ink at all, disc still filled) and a rounded
outline (the sharp corner is not ink, the arc points are), and a designer-side test pins the designer's property
names against the fork's vocabulary — `line_thickness` → `stroke_width`, a circle's `fill` being a bool where a
rectangle's is a colour — so the mapping cannot drift in silence.

### Left as it is, deliberately

Six builder arms in the fork are still upstream's (`slider`, `arc`, `chart`, `busy_wheel`, `status_bar`,
`time_picker`, `number_picker`, `content_indicator`, `crumbs`, `path`), and the catalogue still marks them
unavailable — the fork only changed the four shape arms. The shapes themselves over-draw by one pixel and rely
on the engine clipping a custom widget to its rect; the crate's own test asserts the over-draw (a 40-wide cell
draws to x=40), and an isolated probe confirmed the engine clips, so nothing bleeds today. Clamping in the
widget would make that independent of the engine, and is worth doing when the shapes next change.

## 103. Shapes that draw in rows: what the panel actually charges for (2026-10-09)

"How fast does the design paint?" has a different answer on a board than it does on the canvas, and the shape
code was written as though it did not.

### The cost is address windows, not pixels

A generated project draws straight to the panel through mipidsi -- **there is no framebuffer** (480x320x2 bytes
would not fit, and the panel is written over SPI). So the price of a drawing call is not the number of pixels in
it:

| call | what mipidsi does | cost |
|---|---|---|
| `draw_pixel` | `draw_iter` -> `set_pixel` per pixel | one address window **per pixel** (about 12 bytes of command and address, then 2 bytes of colour) |
| `fill_rect` (opaque, no radius) | the engine's fast path -> `fill_solid` | one address window **per row**, then the pixels stream |

`embedded-gui`'s own `fill_rect` takes that fast path only for a plain, opaque, untransformed rectangle, and its
rounded fill scans the corner boxes per pixel -- so "draw a disc as a rounded rectangle with radius = w/2" is
*not* the shortcut it looks like; it would cost about w² per-pixel calls, worse than the disc's 0.79w². The
engine does use per-row runs for text (`render/mod.rs` batches a glyph run with `fill_rect(.., len, 1)`), which
is where the pattern came from.

The shapes were the outlier: a circle was pi·r² `draw_pixel` calls, a triangle's interior one per pixel, a line
`thickness` per-pixel segments, and a rounded rectangle's outline four per-pixel edges.

### What changed

Every fill is now a **run per row** -- one `fill_rect` of one-pixel height:

* disc: `2r+1` runs, where it was about `pi·r²` pixels. For r=40 that is 81 calls instead of 5027.
* ring: two short runs per row (the annulus's left and right arcs), or the whole span where the row is all ring.
* disc + ring: the ring's two runs and the inner span, still at most three runs a row.
* triangle interior: one run per scanline.
* line: the line follows an axis by construction, so it is **one** rectangle rather than `thickness` stamped
  per-pixel segments.
* rounded rectangle outline: the four straight runs are rectangles now; only the corner arcs are still per pixel
  (a few points each), because the canvas has no rounded-outline primitive and the arcs are the part that is
  small.

The spans cover **exactly** the pixels the distance test covered -- for integer `dx`, `dx*dx + dy*dy <= r*r`
holds iff `|dx| <= floor(sqrt(r*r - dy*dy))` -- and both half-widths shrink monotonically as the row moves from
the centre, so they are walked down rather than computed with `sqrt`, a float a no_std crate does not have.

### Proving it is the same picture, and fewer calls

Two different questions, and the tests answer them separately.

*The same picture*: `circle_fills_its_disc` and `circle_strokes_only_the_annulus` compare the drawn pixels
against the distance test **pixel for pixel**, exactly as before -- they just read the runs (`covered()`) instead
of a pixel list. And the host appearance check, which measures the real engine's output through `include_gui!`,
reports byte-for-byte the same numbers as before the rewrite:

    708 of 1200 (the disc), 822 of 1600 (the triangle), 320 of 320 (the line), 4800 of 4800 (the footers),
    none of the 108500 outside them

*Fewer calls*: three new tests pin the call counts, because a regression back to per-pixel drawing would look
identical and be an order of magnitude slower -- `a_filled_disc_is_one_run_per_row` (2r+1 runs, no per-pixel
calls at all, and the runs cover exactly the disc), `a_ring_costs_at_most_two_runs_a_row`, and
`a_filled_triangle_is_one_run_per_row`. The crate is at 13 tests.

### Telling the truth about the timing

The designer's generated `main.rs` now logs the *full* paint duration rather than claiming "built and painted"
before it painted anything:

    design: painted 480x320 in N ms (full frame)      # the touch path, once per full repaint

and the touch-less board logs `design drawn: WxH in N ms`. `Instant` is imported only for the Designer template,
because an unused import is a warning in a generated project.

It is worth being precise about which paint that number is. A touch does **not** repaint the frame: the loop
calls `pointer`/`pump` and then, only if the design is dirty, `render`, which paints the damaged rectangles. The
full paint happens on a calibration frame and after the recalibration gesture. So the number to watch after
touching a widget is the size of the dirty rectangles it causes -- and that is exactly where the runs pay off,
because a shape overlapping a damaged rectangle is re-rendered through the same path.

## 104. "Open Designer" gets a door where the commands live (2026-10-09)

The request: *"The new command button must go in the Rusty Platform sidebar on top of the Controls section."*

Worth writing down because two attempts missed it. The first put the button in the Designer panel's toolbar, the
second in the panel's Toolbox -- both inside the *webview*, and both shipped a small amount of plumbing
(`openDesigner` in the panel's action protocol, a branch in `DesignerPanel.act` routing it back to the command)
to reach a command that the panel was already sitting next to. The sidebar was the answer, and it needed no new
plumbing at all.

### What the sidebar needed

`src/ui/controls.ts` is already a list of command rows -- `command`, `icon`, `detail`, `tooltip` -- rendered by
`controlsView.ts` as `TreeItem`s with a `ThemeIcon`. The designer's command was simply not in that list. It is
now `OPEN_DESIGNER_CONTROL`, first in `visibleControls()`, above New Project:

    0  rustyPlatform.openDesigner    Open Designer   the canvas, Toolbox and properties
    1  rustyPlatform.newProject      New Project     pick a board, then a template
    2  rustyPlatform.checkToolchain  Rusty           check the toolchain

### Two details that were not guesswork

*The row leads, and New Project is second.* New Project was the first row, with a comment explaining why ("it is
the one control that makes the others possible"). The user asked for the designer on top, so it leads and the
comment now covers both -- and the test that asserted `shown[0] === 'rustyPlatform.newProject'` moved to row 1
rather than being deleted, which is the honest way to record a deliberate reordering.

*The icon.* `paintcan` was checked against the codicon list in the installed editor before use, rather than
guessed: a name VS Code does not know renders as nothing, which would look like a rendering bug rather than a
typo, and the repository has no local codicon package to check against.

The row runs the command, so nothing else changed: the sidebar, the Command Palette and the Project view's
title-bar icon are one entry point with three doors.

## 105. A revert the merge could not see: the session auto-commit (2026-10-09)

v0.0.62 shipped two things it should not have: an `Open Designer` button inside the Designer panel's Toolbox,
and a test that fails from a clean checkout. Both were the remains of the two *earlier* placements of that button
— the toolbar, then the Toolbox — which I had reverted before implementing the version the user actually asked
for (a row in the sidebar's Controls section).

The revert was real in the working tree and was verified: `git diff --stat` was empty afterwards, and the source
files were grepped for the `openDesigner` action and came back clean. Then it vanished anyway, and the reason is
the one thing worth carrying forward.

### What happened

This session's harness **auto-commits worktree changes to `main`** at turn boundaries, under the author
`DSH Session Merge <dsh-session@localhost>`:

    5dd75f8  Session dsh-musjkdlz-gq2l3e worktree changes   <- the toolbar/Toolbox attempt, as it stood
    2e137d7  Session dsh-musjkdlz-gq2l3e worktree changes   <- the Controls row, on top of it
    edd0413  Merge shapes that draw in rows                 <- the branch I kept working on

So `main` had the first attempt, while my branch was still based on `edd0413` and contained the revert. Merging
the branch into `main` compared both sides against `edd0413`:

* `main` **added** the plumbing and the tests (a change),
* my branch had them removed, which — relative to `edd0413`, where they had never existed — was **not a change
  at all**.

A merge cannot see a deletion that is not a difference. So `main`'s copy of everything I had removed was kept,
silently, and the failing test came with it. My own verification was sound and incomplete in the same breath: I
checked the working tree after reverting, not the tree that the *merge* produced.

### The rules this leaves

- **Verify after the merge, not before it.** When the harness has committed to `main` behind my back, the
  working-tree check proves nothing about the merge result. Grep the merged tree for what should be gone, and run
  the suite there. (Done here: `grep` for `openDesigner` across the panel sources and the tests, then the full
  suite, both after merging.)
- **A revert that must survive is a commit.** Removing something that the base never had has to be an explicit
  change against the *current* base; otherwise it is invisible.
- **The tests are what would have caught it** — one of the two failures *was* the stale test, which is a poor
  witness because it asserted the leftover. The other (the glyph-table checks in this same release) was green, so
  the suite was red on exactly the thing that had gone wrong, and no more. That is luck, not a system: the
  defence is checking the merged tree against what was asked for.

## 106. WYSIWYG at last: the canvas draws what the board draws (2026-10-09)

The canvas has drawn every control as a rounded rectangle with its type name in it -- "Button", "Slider" -- since
the designer was built, with only the four shapes painting themselves. That was a deliberate first step (a
control you can *place* and measure), and it was never the promise. This is the promise.

### What made it possible

Two things had to be true before the canvas could be honest rather than *nearly* right, and neither was:

1. **The fonts.** The board draws text with `embedded-gui`'s bitmap fonts; the canvas would have drawn it with a
   browser font of a similar size. Every measurement taken off the canvas -- does this label fit, does the button
   text overflow -- would have been a measurement of the wrong font. The crate exposes
   `embedded_gui::font::glyph_rows`, so the glyphs are read out of the crate itself and committed as a table
   (`webview/designer/glyphs.ts`), generated by `node tests/tools/glyph-table.js` from a host binary. The vector
   face needed its own data: `Vector(n)` is not a bitmap at all, it is a polyline through `get_vector_glyph`'s
   points with a `(255, 255)` pen-up marker, so that is dumped too. Text is now the crate's text.
2. **The arithmetic.** "What the board draws" is not a matter of taste: `Block::styled(style)` (background,
   gradient, border, corner radius, shadow, padding) plus each widget's own content, with the *style the code
   generator hands that tag*. That was reverse-engineered from the crate into `tests/tmp/preview-spec.md` -- every
   claim cited to `file.rs:line` -- and `webview/designer/preview.ts` follows it.

### The rules the replica follows

- **The codegen's style, not a nicer one.** The emitter hard-codes a style per tag, and the canvas now uses that:
  `Progress`, `Slider`, `Toggle` and `Checkbox` all get `Style::default()`, which has *no background and no
  border* -- so a progress bar on the glass is a bare white fill on the backdrop, a slider a 1px white track with
  a 3x5 accent knob, a toggle text plus a knob rectangle. The old canvas drew all four as themed panels, which
  was prettier and wrong.
- **Clipped to the widget's own rect**, because the engine does that: a panel with a soft shadow paints **0**
  non-white pixels within 4 px outside its own cell on a white backdrop (measured, after getting it wrong twice
  by counting a neighbour's pixels).
- **The crate's dither, not canvas alpha.** The default compositor does not alpha-blend: a pixel is drawn iff
  `opacity > BAYER[(y&3)*4 + (x&3)]*16 + 8`. A translucent `globalAlpha` shadow would be smoother and darker than
  the glass, so the Bayer test is implemented.
- **Gradients per row**, at the crate's quantisation (`t = (y - rect.y).clamp(0, denom) * 255 / denom`), rather
  than handed to `createLinearGradient` which interpolates continuously.
- **A table's cells now exist**, because they now reach the board (§ the codegen fix): the header is the first
  row, since the renderer has no separate header concept.

### What the canvas still cannot show, and says so

The designer's fallback stays for tags the crate gives no renderer: `mesh` emits a spacer (nothing to draw),
`image` and `icon` need their asset files (the next slice: the panel has to hand the webview a URI per asset),
and the ten tags the codegen cannot build are not offered at all.

### Three things the board taught the replica while it was being written

**A pen's zero is not a width.** Already true of the shapes (§103); here it showed up as `stroke_width` 0 meaning
no outline on both sides.

**The clip is the widget's cell, and that is measurable.** The spec's own notes said the clip was the "inherited"
one, which would have let a panel's soft shadow darken its neighbours and a carousel's `mask_top` bar paint above
its cell. Both were measured instead: a panel with `Shadow::soft()` (offset (1,2), spread 2) on a white backdrop
paints **0** non-white pixels within 4 px of its cell, and a carousel with `mask_top=6`/`mask_bottom=6` paints
**0** above or below its own. So the engine clips each widget to its rect, the masks only shade *inside* the cell
(which is why the crate's fade loop, not its mask bars, is what a carousel actually shows), and the replica clips
the same way. It took two wrong attempts to measure this cleanly -- the first two probes counted a neighbouring
widget's pixels as spill, because the fixture's widgets sit next to each other and a black backdrop hides a
dithered black shadow. A one-widget screen on a white backdrop is what settled it.

**Faithful is not the same as cheap.** Mirroring the crate's shadow arithmetic exactly meant filling each
dithered ring whole, which costs one canvas op per ~1.7 pixels of the ring's area -- 24 543 ops for a 360x120
panel, on every repaint, in an editor where the canvas redraws while you drag. The crate avoids that with an
occlusion rule whose own test asserts it is pixel-identical, so the replica now uses it too: the same pixels,
1 315 ops, and the cost grows with the perimeter instead of the area. That is the kind of thing that would have
shipped as "the canvas feels sluggish with a few panels on it", with no obvious cause.

### What is still approximate, and why

The declared **BDF fonts** cannot be drawn by the webview (the `.bdf` is the project's file, not the crate's
data), so those fall back to the crate's default glyphs; the base style around them is right. **Vector strokes**
blend on the canvas where the crate dithers. The **dither phase** is indexed by the board's framebuffer, so it
can shift under a 90/270 degree rotation. `image`/`icon` previews need the panel to hand the webview a URI per
asset -- the next slice -- and `mesh` has no renderer at all, because its codegen arm emits a spacer.

Every one of those is a comment in `preview.ts` beside the code that does it, and a line in the changelog, rather
than a gap a user has to discover.


## 107. A circle with flat edges: measuring a disc in whole pixels (2026-10-09)

Reported: *"the circle shape clips some pixels at its top and bottom edges."*

It did, on both sides, and for the same reason. The disc was defined as "centre `x + w/2`, radius `min(w,h)/2`,
pixel in iff `dx² + dy² <= r²`". On an **even**-sized box that centre is a whole pixel *offset by half a pixel
from the box's centre*, so the disc's extremes land on `x + w` and `y + h` -- one pixel past the last row and
column -- and both the board's clip to the widget's cell and the canvas's clip to the same rect shaved them flat.

### The fix is the measurement, not the clip

The disc wanted is the one *inscribed in the box*, and an even-sized box has no whole-pixel centre to measure
from. So the arithmetic moved to half-pixels: pixel `i`'s centre is `2i + 1`, the box's centre is `w`, and a
pixel belongs to the disc when `(2i + 1 - w)² + (2j + 1 - h)² <= min(w,h)²`. The same disc the canvas draws with
`arc(x + w/2, y + h/2, min/2)` -- for both parities, and nothing outside the box.

Two details worth keeping:

* **The extreme pixels come out right.** A 64px box gets a disc 64 pixels wide, its outermost columns included,
  because the test is satisfied at `2i + 1 - w = ±w`. The whole-pixel version reached the same extremes but
  *outside* the cell, which is why the clip ate them.
* **The row loop is no longer monotone.** The old walk shrank the span from the centre outwards; with
  half-pixels the row's `|dy|` sequence is `h-1, h-3, …, 1, 1, 3, …, h-1`, so the spans are computed per row with
  an integer `isqrt` (a bit at a time -- the platform's `sqrt` is a float and the crate is `no_std`) instead of a
  walk that would have needed re-starting at both ends.

The canvas needed its own half of this: its *outline* was a 1px stroke centred on the circle's path, which hangs
half outside the box and was clipped there. It is now the annulus *inside* the radius -- which is what the
board's ring is (`inner < d <= r`) -- drawn as two arcs with an even-odd fill.

### What the tests pin now

The crate's disc tests compare the drawn pixels against the inscribed-disc rule written independently (half-pixel
test and all) and assert that **nothing is drawn outside the box** -- the regression this bug was. The canvas
keeps the Geometry panel's whole-pixel numbers, which are a different thing: they round-trip exactly
(`circleRect(31)` gives a 62px box whose `circleRadius` is 31), and the renderer, not the panel, is what inscribes
the disc.

Measured on the host: the fixture's circle regains the row and column the clip had taken, `708` of its `1200`
pixels becoming `716`, with nothing painted outside any cell. The bug had been in every circle the designer ever
drew, and the earlier "the engine clips each widget to its cell" note (§106) is what made it visible rather than
mysterious: the clip is real, so a shape that reaches outside its box *will* be cut.

## 108. A triangle that is not only isosceles (2026-10-09)

The shape had been the crate's since it was written: `Triangle::render` derived its three vertices from the cell
rect -- apex at the top centre, base along the bottom -- so *the triangle* was one shape at every size and there
was nothing in the markup to say otherwise. The request was to put a handle on each of the three points and let
them be dragged anywhere on the glass.

### Six numbers, six layers

The interesting part was never the handle; it was where the geometry goes. A point could have been stored in
absolute pixels, in which case the board would have needed the design's canvas size and the grid's rounding, and
the two would have disagreed the first time a track resolved one pixel off. Instead the vertices travel as
**per-mille offsets into the box** (`p1x`..`p3y`, `0..=1000`), which is the one rectangle the designer and the
engine already share: the grid hands the widget its cell, and `cell.x + p * cell.w / 1000` puts a vertex in the
same place on both sides with no side knowing the other's arithmetic. It also makes a triangle *scale* with its
box rather than owning one size -- resize the box and the shape grows with it, deliberately.

So one idea had to be threaded through six places, and each one could have dropped it silently:

1. **The crate** (`rusty-gui-widgets`) -- `Triangle { points: [i16; 6] }`, `vertices()` mapping per-mille to
   pixels with the crate's own truncating division, and `DEFAULT_TRIANGLE_POINTS` as the old isosceles shape.
2. **The fork's parser** -- `point("p1x", 500)` and friends, each clamped to `0..=1000`.
3. **The fork's AST, emitter and serializer** -- the field on the node, `points: [..]` in the generated static,
   and the six attributes written back out.
4. **The catalogue** -- six properties in one group, and `optional: true` on each.
5. **The emitter** -- no code at all, which was the point: they are ordinary attributes, so the generic property
   loop already writes them and the KDL grammar needed nothing new.
6. **The canvas** -- the same mapping for painting, hit testing and the handle.

### The one number that is not obvious

`triangleFromVertices` -- the inverse, run on every mouse move of a vertex drag -- has to choose a per-mille
value for a pixel, and the obvious `round` is wrong. The crate measures *forward* with a truncating division, so
the 55th pixel of a 56-pixel box is `982.1` per-mille, and `982` per-mille of 56 pixels is `54.9` -- the 54th.
Round **up** instead: `983` per-mille is `55.0`, the 55th, where the user let go. The t1 test sweeps every pixel
of seven box shapes, including a 1x1 and a 479x3, and asserts the round trip is exact; the first version of it
failed on exactly this, one pixel short at the far edge.

The other subtlety is sizing the box: it is `span + 1` pixels wide because the box's last pixel is a real pixel,
so a vertex on the far edge comes back as `1000` rather than `999`. And a dragged vertex is not clamped *into the
box* -- it moves the box with it, or a point could never reach the glass's edge. The box stays the bounding
rectangle of the three points, the two points that are not being dragged stay on their own pixels (from a
snapshot taken when the drag started, so no rounding accumulates over forty mouse-moves), and the eight box
handles stay where they were for scaling the whole shape.

### What the tests pin now

`cargo test` in the crate is **14** tests, including a skewed triangle, and the per-mille mapping in three box
sizes. The fork is **20**: a new one compiles a design with `p1x=1000 …` and asserts the generated Rust contains
`rusty_gui_widgets::Triangle { …, points: [1000, 0, 0, 1000, 1000, 1000] }`, that a design without the six keeps
the parser's default, and that out-of-range values are clamped. The t1 layer (now **781** tests, of the suite's
**817**) round-trips the
geometry, drags a point out of its box, checks the vertex handle wins over the box handle underneath it, and
checks an older design still validates -- which is what the new `optional` flag is for: six new required
properties would have invalidated every design made before them.

Two tests were changed rather than added, and both were pinning the *old* shape: the crate's own triangle tests
expected the base one row *below* the box (`Rect::bottom()` in `embedded-gui` is `y + h`), which is why the old
isosceles triangle painted 31 rows of a 30-row cell and its apex was, for an even width, on the right of the two
middle columns. The base is now the cell's last row, so nothing leaves the box.

The engine, end to end: a new `--shape-points` mode in the designer simulator builds the fixture twice through a
real `include_gui!` -- once as drawn, once with the points reset to the crate's default -- and reports

    PASS: the design's right triangle and the default isosceles one differ in 611 of the 1600 pixels of
    their cell -- each fills its own point at (334, 272) and (320, 272) and not the other's -- and agree on
    every pixel outside it

A pixel count alone would have proved nothing here, which is worth recording: both triangles fill *half* their
cell, so the two renders have almost the same ink. What says which shape was drawn is *where* the fill colour
is, which is why the check probes one point deep inside each and not the totals. The fixture's triangle is a
right one now for the same reason, and the existing `--font` run measures `822` of its `1600` pixels changing
when its colours are stripped -- about the half-cell a triangle should be. Both were run against the real engine
along with the other three modes (`default`, `--touch`, `--dispatch`): all five PASS.

Not done, and deliberately: the six fields in the Properties panel are six numbers under one **Points** heading
rather than a little triangle widget of their own, and a vertex snaps to whole pixels rather than to the 4-pixel
grid the box moves on -- a *point* is the fine placement tool, and grid-snapping it would fight the user who is
trying to aim it.

## 109. Six controls that could not be coloured (2026-10-09)

The report was short and specific: *"Spinbox - Still only draws an outline / Toggle - Does not draw the toggle
borders, No settings for border width or any colour settings / Checkbox - check box renders way to small and no
way to change its size or colours / Roler - No colour settings / Progress bar - No border or colour settings /
Gauge - Still only draws an outline - no colour settings. If these issues are not fixable we will have to create
those widgits/controls in our own crate."*

### The verdict, read off the crate rather than guessed

Four root causes, and only one of them was the canvas:

1. **No colour could reach the board at all.** The codegen fork emitted a *constant* style per tag --
   `Style::panel()` for roller, spinbox and scale, `Style::default()` for toggle, checkbox and progress -- and
   nothing in the design could change it. `Style::default()` is `Style::new()`, which is a label: no background,
   border width zero, no padding. That is why a Toggle had "no borders" and a Progress bar had no track: the
   fork had never given them one, whatever the canvas drew.
2. **Four values were literals inside the runtime's renderers**, where no markup and no style could reach:
   the checkbox's box is `inner.h.min(8)` (`widgets/mod.rs:1458`), the toggle's track while off is
   `Rgb565::new(7, 10, 10)` (`:1426`), the spinbox's focused-digit underline is `CSS_CYAN` and its chevron
   outlines `CSS_GRAY` (`widgets/spinbox.rs:167,179-180`), and `add_scale` bakes in `CSS_GRAY` ticks, a `CSS_RED`
   needle, the tick counts, the 135°/45° sweep and the label/needle switches.
3. **A gauge's value could not be changed after it was built.** `ScaleWidget` implements
   `Widget::get_property`/`set_property` for `Value`/`Min`/`Max` (`widgets/scale.rs:339-363`), but the node
   dispatch in `widgets/mod.rs` had no arm for `WidgetKind::Scale`, so `set_widget_property(.., Value, ..)`
   answered `NotFound` for the one widget whose whole purpose is to display a changing number.
4. **The canvas painted two of them as nothing.** `previewWidget` had no arm for `spinbox` or `scale`, so both
   fell through to the "type name in a rounded rectangle" placeholder -- "still only draws an outline".

### Why the runtime is vendored, and not our own widgets

The fallback in the report was to write the controls ourselves in `rusty-gui-widgets`, as the shapes already
are. That was rejected after reading the engine: `WidgetKind::Custom` forwards `focusable()` to the widget
(`widgets/mod.rs:588`) but **not** `get_property`/`set_property` -- there is no `Custom` arm in either match. A
custom checkbox could therefore never be read with `checked_value` or set with `set_checked`, and a custom gauge
could never be given a value at all. Interactivity is the entire point of those two controls, so the *runtime*
is patched instead: a third vendored crate, `crates/embedded-gui`, redirected by `[patch.crates-io]` exactly
like the codegen fork.

Every change there is additive, and the defaults reproduce upstream's literals to the bit, so a project that
patches to this fork but writes plain upstream markup renders identically. `crates/embedded-gui/README.md` lists
the four builder additions (`add_checkbox_sized`, `add_toggle_colored`, `add_spinbox_styled`,
`add_scale_styled`) and the one defect fixed (the missing `Scale` property arms). Four new tests in that crate
render through the real `GuiContext` and read pixels back: **227 unit tests pass**, upstream's 223 included.

### How a colour travels now

`src/designer/appearance.ts` gained the notion of a *style field*: a catalogue property marked
`viaStyle: 'accent'` (rather than this module's old `viaStyle: true`) is folded into the same `style`
expression that already carried the base style and the font. The expression is built **on the style that tag
wears when the design says nothing** -- `ownStyleOf`, mirroring the fork's per-tag fallback -- because a design
that names only an accent must not also lose the roller's panel surface.

Three rules make a half-filled form do the obvious thing, and they live in `resolveStyleValues` so that the
canvas and the emitter cannot disagree about them:

* a colour that is set is applied, and one that is not leaves the base style alone (every colour defaults to
  the empty string, not black);
* **a border colour asks for a border**, one pixel wide unless a width is named -- the plain base style has a
  width of zero, so a design that picked only a colour would otherwise see nothing;
* a border *width* on its own thickens the border the base has, and a corner radius of `0` means "keep the
  base's corners" -- a number whose default has to mean "unset". A square corner is asked for with the Plain
  base style, which is what that style is.

Setting a background also clears the gradient, because `Block::render` paints the gradient *instead of* the
background (`block.rs:177-186`): without that, a flat colour chosen on a panel-based widget would never be seen.

### What the tests pin now

* **Runtime** (`cargo test -p embedded-gui`): 228, including five new ones that assert a 16-pixel box draws more
  outline than the default 8-pixel one, that a box taller than its row is capped to the row, that an off switch
  paints its design's track colour and an on one the style accent, that the spinbox's underline and chevrons are
  the named colours, that a six-digit spinbox paints more text than a one-digit one, and that a gauge's value
  can be read, set and clamped after it is built.
* **Codegen fork** (`cargo test -p embedded-gui-codegen`): 21, including one that compiles a design setting every
  new attribute -- the spinbox's `digits` and `decimals` among them, which the old builder fixed at 4 and 0 --
  and asserts the exact builder calls, and that a design naming none still emits upstream's defaults.
* **Hermetic suite**: 834, including the appearance rules above, the base style of each tag, and seven canvas
  tests that paint all six controls and assert the colours and the box size the design named.
* **The engine**, end to end: the simulator's fixture grew a checkbox, a spinbox, a roller and a gauge, each
  with colours that appear nowhere else, and the `--font` mode strips every via-style colour and measures the
  difference. **17 regions, 61390 pixels changed inside their own widgets, none of the 79900 outside them** --
  which is the assertion that the colours travel designer -> KDL -> fork -> runtime -> glass. All five simulator
  modes pass.

### Not done, deliberately

* A toggle's *track* still has no outline of its own: its `border_color`/`border_width` frame the widget, which
  is what "border" means for every other control. Outlining the switch itself would be a new field with no
  upstream equivalent.
* The gauge's value is set from firmware with `gui.set_widget_property(gauge, PropertyKey::Value,
  PropertyValue::Float(..))`, which works now but is the crate's generic spelling rather than a `set_scale_value`
  helper; adding one would be a runtime convenience, not a fix.
* A Spinbox's `step` is parsed by the fork and not offered in the panel: the crate's renderer steps by the
  focused *digit* (`10^focused_digit`), so `step` is a field nothing reads. `digits` and `decimals` were offered
  in the panel all along and were being dropped by the builder, which this release also fixed -- a six-digit
  spinbox now formats six digits on the glass, and the canvas draws the same number.

## 110. The ten tags that were refused, and why each one was (2026-10-09)

The designer documented ten markup tags and refused to hand them out, with a reason quoted from a failed build:
"add_slider ... is called with three i32 fields in the order (min, max, value)", "add_sweeping_arc takes ten
arguments and is called with four", "there is no add_busy_wheel", and so on. Two of those turned out to be one
kind of problem and five of them quite another.

### Six that were bugs in the generator

Read against the runtime's real builders, these were never missing widgets -- the generated call was wrong:

* **slider** -- `add_slider(rect, value, min, max, style)` wants floats in the order *value, min, max*; the
  emitter passed three `i32`s in the order min, max, value. It compiled nowhere, and would have set the wrong
  value if it had.
* **arc** -- `add_sweeping_arc` takes ten arguments, and its design is not angles at all: it is a *pie sweep*
  around an opaque card, with `progress`, `clockwise`, `arc_radius`, `frame_inset`, `corner_radius` and three
  colours. The old tag offered `start_angle`/`end_angle`, which the runtime has never had. The tag's properties
  were replaced with the widget's.
* **busy_wheel** -- there is no `add_busy_wheel`; the widget is `add_spinner(rect, phase, style)`. `phase` is a
  number, not the `active` boolean the tag offered, because the application turns the wheel rather than the
  widget animating itself.
* **chart** and **plotter** -- one tag with a `mode`, two different widgets: `add_chart(rect, values, min, max,
  style)` draws a filled graph, `add_plotter(rect, values, head, min, max, style)` a scrolling trace with a head
  index. They are two tags now, each carrying a starting series (`values="2,5,3,8,6"`), and a plotter's head.
* **path** -- `VectorPath` is a *shape*, not a widget kind: the generated code named a `Point` that was never
  imported and built `PathVerb::QuadTo` as a tuple variant where the runtime declares a struct variant. It is
  now a real widget in `rusty-gui-widgets`, emitted through `add_custom_widget` like Circle and Triangle, with
  its own verb enum (struct variants, so the two can never disagree again), the curves flattened into a fixed
  twelve segments each, and every segment stroked through the canvas's own `draw_line` so the board and the
  replica walk the same line. `Close` strokes back to the subpath's start; a zero-width pen floors at one pixel,
  because a path has no fill to fall back on and an invisible path is never what a design means.

### Five the runtime shipped as drawings the engine could not reach

`StatusBarWidget`, `TimePickerWidget`, `NumberPickerWidget`, `ContentIndicatorWidget` and
`CrumbsIndicatorWidget` all exist in `embedded-gui` 0.2.7 with a `new(..)` and a `render(..)` -- and none of
them has a `WidgetKind` variant, a builder or a render arm, so the engine could neither create nor draw one.
This is why the runtime is vendored: they now have all three, plus property access where the type has any (a
status bar's text, a number picker's value/min/max, an indicator's selected item). One latent panic came out of
it: `TimePickerWidget::render` underflowed on a rect shorter than 24 pixels, because it floors its cell height
at 24 and then subtracts it from the bounds.

### What reading them properly changed

* **The number picker offers no colours at all.** Its renderer paints its own rounded card and reads nothing
  from the style, so every colour field the panel offered it with was a lie. The properties are gone and the
  Toolbox description says why. (The chart, plotter and time picker, by contrast, *do* draw with the style's
  accent -- so each of them gained an `accent` property rather than keeping a colour nobody could set.)
* **The content indicator is a chevron, not dots.** The crate draws one arrow, up or down, and picks the
  direction from whether the active item is the last of the count; `Crumbs` is the widget that draws dots. The
  description said "dots showing where you are in a set", which was simply wrong.
* **The arc's frame hid the arc.** `render_sweeping_arc` fills the sector and *then* paints an opaque rounded
  card inset by `frame_inset`, so at the old default of four pixels in a 96-pixel widget the card covered the
  sweep entirely: a freshly dropped arc showed nothing happening. The default is fourteen now, in the catalogue
  and in the parser, which leaves a visible ring at the default radius.
* **The toggle's track can have an outline.** `border_color`/`border_width` frame the widget; the switch inside
  it had no outline and no way to get one. The runtime gained `track_border`/`track_border_width` for it.

### Tests that came out of it

`rusty-gui-widgets` is **19**: five for the path (segment counts, the cell origin, the pen's stamping, the fixed
flattening, the hairline floor). The runtime is **232**, four more for the new widgets and the track outline.
The fork is **22**. The hermetic suite is **845**, including eleven canvas cases that paint every one of these
tags and assert a number that a wrong implementation would get wrong -- the arc's progress, the wheel's phase,
the plotter's head, the chart's series, the path's segment count, the toggle's three outline states.

The simulator's fixture grew all eleven, which is the only end-to-end statement available: the generated call
compiles inside a real `include_gui!` build against the vendored runtime, and painting it changes **67854 pixels
across 27 measured regions and none of the 68312 outside them**. `--touch` still passes, and the eleven are in
the same design as everything else.

The `unavailable` channel in the catalogue is now empty: the Toolbox offers the whole catalogue.

## 111. An image from the card instead of from the flash (2026-10-09)

"*The Image widget currently gets it's content from the assets folder so it gets embedded in the flash memory. I
also need it to be able to load content from the on-board SD card.*"

Embedding is a build-time decision that cannot be revisited on the device: the macro reads the file on the
machine that compiles the project, decodes it there, and writes the pixels into the firmware as a static array.
A card file does not exist on that machine at all. So the two are not the same widget with a different path --
one is a table in flash, the other is a file read while the glass is being painted.

### The three answers that shaped it

Asked before building: **BMP** on the card (every editor writes one, and the device can parse it without a
decoder), the **driver generated** for boards whose catalog entry declares a card (the CYD, on its own SPI bus:
CS 5, sclk 18, mosi 23, miso 19), and **streaming rows** rather than a whole-image buffer (a full-screen
320x480 image would want 300 KB of RAM, which the ESP32 does not have to spare).

### The widget

`rusty_gui_widgets::BmpImage`, in the crate that already draws the shapes, reads the file as it draws:

* **Uncompressed BMP**: 24- and 32-bit `BI_RGB`, and 16-bit with either the 5-5-5 layout `BI_RGB` means or the
  5-6-5 one a bitfield header declares. Both row orders, because a BMP's height is signed and the sign is what
  says which end the first row is.
* **One pass, one row of memory.** Rows are visited in the order the *file* holds them, which is the only order
  a stream can be read in, so the source row a destination row needs is always the same as the last one or
  later; a single cached row is enough for the enlarged case where one source row feeds several destination
  rows. There is no seeking backwards and no whole-image buffer.
* **Runs, not pixels.** A destination row is painted as one `fill_rect` per run of the same colour, so a
  photograph costs a few address windows per row rather than one per pixel.
* **A pixel can straddle a read.** A row is longer than the read buffer for any real image, and the first
  version of this lost the bytes that fell on a boundary: a 64-pixel row came out right for 42 pixels and
  shifted after that. The carry is what fixes it, and the test that caught it is still there.

### How it reaches a card without this crate knowing what a card is

The crate links no filesystem and no driver. It has a `ByteSource` trait and one injected function:

```rust
pub type WithFile = fn(&str, &mut dyn FnMut(&mut dyn ByteSource) -> Result<(), ()>) -> Result<(), ()>;
```

A **callback** rather than open/read/close because the reader in a generated project borrows the mounted volume
for as long as the file is open, and a borrowed file cannot be stored between calls; the widget runs its whole
read inside that one call, which is what makes the borrow legal with no global state in this crate. The project
supplies `crate::sd::with_file` from its own generated `src/sd.rs`, which owns the bus, the mount and the file
handle -- and which exists only for boards with a card socket. `embedded-sdmmc` 0.8's **raw handles** are what
make that possible: they are plain values, not borrows of the volume, so the mount can live in a static.

### The generated module, and what esp-hal forced

`src/sd.rs` is generated for Designer projects on boards with a socket (the CYD: its own SPI bus on CS 5,
sclk 18, mosi 23, miso 19, which main.rs passes to `sd::init` before the panel comes up). It holds the mounted
volume in a `critical_section::Mutex<RefCell<Option<(VolumeManager<..>, RawVolume)>>>` and hands the widget a
`CardFile` that reads through the raw handle.

Three things were found by **compiling a generated project**, not by reading documentation:

* `Output::new` needs an `OutputPin`, not a `PeripheralOutput`: the chip select is a plain output pin while the
  three bus lines are the interconnect traits, and the two live in different modules of `esp-hal`.
* `Delay::new()` takes no argument, and the device and the card each want one, so `init` builds them.
* The card gets **SPI3**, because `Spi` owns its peripheral and the panel owns SPI2.

The proof for this half is a real cross-compile, because nothing on the host can exercise it: a Designer project
generated for the CYD, with the three vendored crates copied in, `cargo check` under the ESP toolchain for
`xtensa-esp32-none-elf` -- `Finished dev profile`, exit 0, artifacts under `tests/out/sd-project/`. The T-QT
snapshots are byte-identical before and after: no module, no dependency, no `init` call.

### What the designer says about it

A design names a card file with a prefix: `src="sd:PIC1.BMP"`. The path is checked against what the card can
actually be read with -- a **short 8.3 name in the root**, because a generated project has no allocator for long
names and opens no subdirectories -- and two things the design cannot state are reported in the panel: a board
with no socket, and a project with no `src/sd.rs` (which would fail to compile, since the generated markup names
it). The canvas **names the file** rather than drawing a picture it cannot read, which is also how a typo is
noticed before a build.

Two consequences of the build-time pipeline being upstream's code, worth recording because they are not
obvious: an `sd:` source had to become its **own AST variant**, since the `include_gui!` macro reads every
`Image`'s file off the build machine and refuses paths outside the project -- the macro's matches have catch-alls,
so a new variant is simply skipped; and the project's **asset check** had to learn that a card path is not a
missing file, or every card image would have been reported as absent. `embedded-sdmmc` 0.8 turned out to have no
`alloc` feature at all and to be short-name-only, which is what the designer's 8.3 check is mirroring; its
ergonomic `File`/`Directory` types borrow the volume manager and could not be kept in a static, which is why the
**raw handles** are what makes a mount that survives between draws possible at all.

## 112. The AI assistant gets a switch (2026-10-09)

"*Add a On/Off switch to the extension AI Assistant. When Off (default) all models are to be unloaded and the
llama-server is to be stopped. When the user turns it on, those services must start.*"

The pieces existed -- `assistant.backend` could already be `off`, `lms unload --all` had a command, and
`stopLlamaServerConfirmed` could stop a unit, a plain process or this window's own child -- but nothing tied
them together, and "off" meant only *this window will not start anything*. A running `llama-server` and loaded
models stayed exactly where they were, which on this machine was 17 GiB of cgroup charge.

### What the switch is

`rustyPlatform.assistant.enabled` is a setting of its own rather than a reuse of `backend`, because "which
backend" and "on or off" are two questions: turning the switch off has to remember what to turn back on.
`assistantEnabled` now reads the switch first, so an assistant that is off does not answer whatever is
configured. It defaults to **off**, which is what the request asked for and also what the README had always
claimed.

The panel's `enabled` snapshot and its "pinned" line were derived from `backend !== 'off'`, so they had to
learn the same thing: with the switch down the panel says so instead of looking ready to answer.

### The decision is data, not a chain of ifs

`ai/assistantSwitchPlan.ts` has no `vscode` import: it turns "what should off do?" into a list of steps from
the facts — which models are held, whether this window has a server of its own, and who answers the endpoint.
The three rules it encodes:

* **models are unloaded and this window's own server is stopped, always** -- there is nobody else to ask;
* **a server this window did not start is stopped only after the user says so, once per window.** The answer is
  remembered either way: consent to stop a pid is about the process running now, and asking again after a
  "leave it running" is a nag rather than a safeguard;
* **what cannot be stopped honestly is named, never guessed at** -- a system unit needs root, so the step says
  which `sudo systemctl stop` to run; an inspector that cannot see who owns a port says that instead of
  signalling a process it cannot identify.

The dialog offers a third button, "Stop asking at startup", which writes the option below off -- the setting is
in the panel, and the dialog points at the feature rather than hiding it in JSON.

### The two settings

* `rustyPlatform.assistant.enabled` (off) -- the switch.
* `rustyPlatform.assistant.stopServersAtStartup` (on) -- whether a window that opens with the switch off
  enforces that. Asked for explicitly: "*this should be an option for the user to select*", placed next to the
  switch in the AI Assist panel, because someone who runs their own `llama-server` for other work does not want
  an editor stopping it at every launch.

Only an explicit `true` switches on (junk must never look like consent to start a server), and only an
explicit `false` turns the startup enforcement off (a missing value keeps the meaning the switch implies) --
the same asymmetry `showDiff` already uses.

### What turning it on does, and what it refuses to do

On: a server already answering the endpoint is adopted; a pinned model is started on the bundled runtime; the
configured `llama-server` unit is started for an external backend -- but **only if one actually exists**.
Without that gate the switch would spawn a llama-server nobody asked for when the endpoint is, say, LM Studio's
and LM Studio is closed. A completely unpinned setup opens the model picker, because starting nothing and
calling that "on" would be a lie.

### Tests

Nine in the t1 layer (`ai-assistant-switch.test.js`) over the plan, the consent memory, the refusal reasons and
the two settings' defaults and tolerance; two existing `assistantEnabled` tests were updated to the new
semantics (the switch is the first gate). The suite is at 859.

---

## 113. Why the photo on the card did not draw (2026-10-09)

"*I placed a 16 bit bmp image in the root of the SD card and entered its name (SD:Malee_24.bmp) in the box. It is
not rendering. This file is also in this machine's Pictures folder. Nothin renders. My test app testV69.*"

The file was on the machine, so the whole question could be settled by measuring it rather than by asking for
another flash. `/home/niel/Pictures/Malee_24.bmp`:

| Field | Value |
|---|---|
| size | 3 146 226 bytes, and the pixels account for all of it: `138 + 2244 × 1402` |
| info header | **124 bytes** -- a `BITMAPV5HEADER`, not the 40-byte one |
| geometry | **1122 × 1402**, height positive, so the rows are stored bottom-up |
| pixels | 16 bpp, compression 3 (`BI_BITFIELDS`), masks `0xF800`/`0x07E0`/`0x001F` -- 5-6-5 |
| pixels start | 138 |

`testV69` was correct at every step before the widget: `designer/panel.ui.json` holds `"src": "sd:Malee_24.bmp"`,
`src/ui.kdl` line 4 carries it, `src/main.rs:81` calls `sd::init(SPI3, GPIO5, 18, 23, 19)`, its generated
`src/sd.rs` mounts volume 0 and opens the file by short name, and its vendored `codegen/` has the `SdImage`
variant. Nothing was wrong with the design, the mount or the wiring.

### The cause: `width > MAX_ROW_PIXELS` returned `Err`, and `Err` draws nothing

`BmpHeader::parse` refused any source wider than **480** -- the widest panel the platform drives -- because
`read_row` filled a `[Rgb565; MAX_ROW_PIXELS]` with one converted row of the *source*. A 1122-pixel row does not
fit, so the file was refused before a single byte of its pixels was read, and `BmpImage::render` turns any error
into "leave the cell alone". On the glass that is indistinguishable from a card that never mounted. The control
the user ran settles it: **the same image as a PNG from flash rendered** -- so the panel, the cell and the draw
path were fine, and the difference was the file.

The fix keeps the same 960 bytes of stack and drops the limit: the row cache now holds one colour per
*destination* column, and the source row is decimated as it is read. Sample `i` is source column
`i × width / samples` (nearest neighbour, the same rule the painter already used the other way round), the
columns the samples name only ever move forward, so a single forward pass picks them out and the bytes in
between are converted and dropped. `width > 1_000_000` is still refused -- not as a drawing limit but because
`bits × width` would wrap a `u32` -- and a header that absurd is a corrupt file, not a large one.

### Proved on the real file, not just on headers built by a test

A temporary probe read the actual 3 MB BMP through the widget into a 244 × 440 cell and compared it with an
independent Python decode of the same file at the same nearest-neighbour coordinates. Seven of seven matched,
including both ends of the diagonal:

| destination | source | file pixel | colour drawn |
|---|---|---|---|
| (0, 0) | (0, 0) | `0x6B2B` | (13, 25, 11) |
| (243, 439) | (1117, 1398) | `0x0021` | (0, 1, 1) |
| (122, 220) | (561, 701) | `0x9A68` | (19, 19, 8) |

That single run also measured what drawing costs: **80 762 runs** (`fill_rect` calls, so a photograph is grouped
into runs as designed) and **25 173 reads** -- which is the whole file, 3 146 226 / 128 = 24 580, and the extra is
the header. Nothing is skipped, because `embedded-sdmmc` 0.8 has no `seek`: reaching row 1000 means reading the
962 rows before it. The probe was removed before the commit; the two header shapes it complements (a 16-bit 565
file and the 124-byte V5 header, both *wider than their cell*) are permanent tests in `tests/sd_image.rs`.

### The second half: 400 kHz is fine for a handshake and wrong for a photo

25 173 reads are 6 145 SD blocks, and a 512-byte block at 400 kHz is about 11 ms: **roughly seventy seconds** of a
frozen screen for this one image, once per draw. The generated module's own comment had claimed a clock hook
existed in `AcquireOpts` and that nothing needed it; both halves were wrong. `embedded-sdmmc` 0.8's
`SdCard::spi` is the hook -- *"Useful if you need to re-clock the SPI"* -- so `init` now raises the bus to
**10 MHz** once `num_bytes()` has answered, through `ExclusiveDevice::bus_mut()` and esp-hal's
`apply_config`. A refusal is logged and leaves the card at 400 kHz and readable. 10 MHz is deliberately under
the 25 MHz SPI mode allows: a marginal read fails as "nothing to draw" rather than as an error anyone sees, so
the margin is worth more than the last few megabytes a second. Same 3 MB photo: about **4 seconds**.

That is in the generated `src/sd.rs`, which is written **once**, when the project is made -- so `testV69` gets the
widget from *Update Crates* (the crates are vendored, and the prompt already offers) but keeps its 400 kHz
module until the module is regenerated. Verified the way §111 was: the new `src/sd.rs` and the new widget, with
all three crates refreshed, `cargo check` for `xtensa-esp32-none-elf` -- `Finished dev profile in 1.95s`, exit 0.

### `SD:` was a trap worth closing

The user wrote `SD:Malee_24.bmp`; the design that reached disk says `sd:`. Nothing normalises it, so the lower
case was retyped or the panel was edited -- but a prefix check that is case-sensitive turns `SD:x` into "a file to
embed in the flash", a different feature that fails a different way (the asset check reports a missing file, and
the macro refuses the path). `embedded-sdmmc`'s `ShortFileName::create_from_str` already upper-cases the *name*,
so no case of the file name ever mattered; only the prefix did. It is now matched without regard to case in the
generated parser (`strip_card_prefix`) and in one designer helper (`cardSourcePath`) that the three checks share,
so the panel, the asset check and the codegen cannot drift apart on it.

Suite: **859 passed, 0 skipped**; the vendored widget crate is at **29** tests (14 circle, 5 path, 10 card image,
two of them new), the codegen fork at 23.

---

## 114. Making an image from the card fast (2026-10-09)

"*I scaled the image down to 160x200 and then it rendered, but very slowly. We need to implement some method to
speed rendering up dramatically. Use a ram buffer, or are there some other tricks we can try?*"

A 64 KB file should not be slow, which is what made this answerable by measurement rather than by guessing: the
cost was not the size of the picture but the *number of times* the card was asked for anything. Reading the crate
found three multiplied costs, and the generator's own engine had already solved the fourth for its own images.

### 1. Every read was a block transfer, whatever was asked for

`embedded_sdmmc` 0.8.2's `VolumeManager::read` (`volume_mgr.rs:624`) reads **one 512-byte block per call** and
keeps no cache between calls -- `let mut blocks = [Block::new()]; self.block_device.read(&mut blocks, block_idx,
"read")`. So a 128-byte request costs exactly what a 512-byte request costs, on the wire and in card time. The
widget asked for 128 bytes at a time (`READ_CHUNK`), which fetched the same block **four times**. It now asks for
`Block::LEN` (512), which is the one number that matters: one call, one transfer, no redundancy.

The FAT walk per call is *not* the problem it looks like: `find_data_on_disk` advances from the file's current
cluster (the manager keeps `current_cluster` as an offset-and-cluster pair), so it is amortised over the clusters
rather than restarting at the file's first cluster.

### 2. Rows nobody sees were transferred anyway

A photograph is usually larger than the cell it is drawn into, and the reader visits source rows in file order,
so a destination row that samples every third source row still had to *consume* the two in between -- there is no
`seek` in `VolumeManager`... except that there is: `file_seek_from_start` / `file_seek_from_current` /
`file_seek_from_end` (`volume_mgr.rs:849`-`870`), and `find_data_on_disk` walks the FAT forward for a jump, one
`BlockCache` for the whole walk. A jump over 2 MB is a few FAT sectors; reading it is 2 MB. So the widget's
`skip` is now offered to the source instead of done by reading:

```rust
pub trait ByteSource {
    fn read(&mut self, buf: &mut [u8]) -> Result<usize, ()>;
    // Reads and discards by default: a stream that cannot move still works.
    fn skip(&mut self, count: u32) -> Result<(), ()> { ... }
}
```

and the generated card reader overrides it with `file_seek_from_current` (`seek_from_current` validates before it
mutates, so a failed move leaves the position alone -- which is why a file that is shorter than its header claims
stops the draw rather than shifting it).

### 3. Every run of colour was an address window

`CustomCanvas` could only be drawn on rectangle by rectangle, and a photograph is ~180 runs of colour per row:
the engine's fast path is `fill_solid` per rect, which on the ST7796 is one CASET/RASET/RAMWR window per call. A
244×440 draw was **80 762** `fill_rect` calls. The engine's own image path (`draw_image_region`,
`render/mod.rs:1531`) already knew the answer -- its fast blit is one `fill_contiguous` **per row** -- so the
canvas gained the same thing as an opt-in:

```rust
// CustomCanvas, with the run loop as the default so every existing canvas still works
fn fill_row(&mut self, rect: Rect, pixels: &[Rgb565]) -> Result<(), GuiError>;
```

`RenderCtx::fill_row` emits one window for the row where the clip, the transform and the layer allow it, and
falls back to the per-pixel path otherwise (the same honesty the non-solid fill path already had). The widget
handed over its row without changing what it computes: the row buffer already holds *one colour per destination
column*, so `samples == area.w` is the whole row, stretched, ready to blit. **440 windows now, not 80 762.**

The widget crate's own manifest gained a `[patch.crates-io] embedded-gui = { path = "../embedded-gui" }`, because
`fill_row` is a fork method: in a project the root manifest's patch does the same thing, and standalone the crate
now builds and tests against the same runtime a project builds against. `cargo check` for the generated project
reports no warning about the non-root patch -- it is ignored there, which is what it is for.

### The measurements

Two files, both 16-bit 565 with a 124-byte V5 header, drawn into a 244×440 cell: the reconstructed full-size
photo, and the 160×200 one the user made. Counted with a source that records requests, and a canvas that counts
calls.

| Source | Bytes | Reads asked | Bytes asked | 512-B blocks | Bytes skipped | Canvas calls |
|---|---|---|---|---|---|---|
| 1122×1402 | 3 146 154 | 2 218 | 987 426 | **1 929** | 2 158 728 | **440** |
| 160×200 | 64 066 | 218 | 64 066 | **126** | 0 | 440 |

Against what the same draw asked for before: the full-size photo passed **3 146 154 bytes in 128-byte requests,
which is 24 580 block transfers** (12.7× more), and the 160×200 file passed 64 066 bytes in 501 of them (4×
more). The display side is 80 762 calls against 440 (184×). At 512 bytes on the wire, one block is ~10.2 ms at
400 kHz and ~0.5 ms at 10 MHz (§113's re-clock), so a 64 KB image goes from roughly six seconds in the card path
to roughly sixty milliseconds, plus the display work that is no longer per run.

### Why not a RAM buffer

The user's instinct was a good one and the answer is that the row *is* buffered -- that is what makes the
one-window blit possible -- but a bigger buffer is not where this time was going. Two reasons to leave a decoded
cache out:

* **It does not fit.** A 244×440 cell in RGB565 is 214 KB, and the ESP32 has about 300 KB of DRAM in total, with
  the panel, the touch driver, the GUI and the WiFi stack already in it. A cache that only exists for small
  images is a cache that helps nobody who complained.
* **It would rarely be used.** The engine repaints by damage: `DamageTracker` keeps a quadtree of dirty regions
  and a widget is only re-rendered where its bounds intersect one, so the image is decoded when it is shown and
  when a screen change covers it -- not on every touch. A cache would buy those handful of redraws at the price
  of the largest allocation in the firmware.

If a specific case wants instant redraws, the honest shape is a **bounded** cache (a thumbnail budget in bytes,
decoded once and scaled on the way out), and it should be added when there is a screen that needs it.

Suite: **859 passed, 0 skipped**; the vendored widget crate is at **31** tests (12 card image), the runtime fork
at **236** (four for `fill_row`: its pixels, its clip offset, a right-clipped row and a short slice), the codegen
fork at 23. The generated project was re-checked under the ESP toolchain for `xtensa-esp32-none-elf`: `Finished
dev profile`, exit 0.

---

## 115. A setting that ran off the side of the property pane (2026-10-09)

"*Please look at the Properties pane in the Designer. Some settings are drawn off screen and needs a horizontal
scroll to become visible. Place all settings so that it fits the panel, without having to scroll
horozontally.*"

### What it turned out to be

The geometry form. `X`, `Y`, `Width` and `Height` are laid out as a two-column grid (`.field-grid`), and a grid
track written `1fr` is really `minmax(auto, 1fr)`: the `auto` minimum is the *item's* min-content size, and the
item is a `.field` row holding a label and a number input. Whatever the input's own `min-width: 0` says about
the input, the row's min-content still came out as the input's default width (**142 px**) plus the label, so each
column was **279 px** and the grid **579 px** inside a 260 px pane. The pane scrolls, and the second column --
`Y` and `Height`, or a circle's `Centre Y` and `Radius` -- is off the side.

Reading the stylesheet said otherwise, twice, in both directions: first that nothing could overflow (every
relevant control already had `min-width: 0`), then that `.asset-field` was the culprit. Both were guesses about a
layout engine nobody was running. So the measurement was built instead.

### Measuring it: a real browser, because nothing here has widths

`tests/tools/designer-layout.js` starts Chromium through puppeteer, builds the panel the way the extension does
(the compiled `out/webview/designer.js` bundle, a stub `acquireVsCodeApi`, the same `init` message), clicks
**every control in the Toolbox** in turn, and reports for each state and window width whether
`pane.scrollWidth > pane.clientWidth` -- which is exactly the scrollbar the user had to drag -- along with the
elements that stick out past the pane's right edge. It can measure any compiled sheet, which is how the same run
was pointed at the *installed* 0.0.72 extension:

```
128 of 132 states overflowed a pane        # the sheet before this change, 319px each
  0 of 132 states overflowed a pane        # after
   label.field "X" 1028..1307 (279px), input.field-input 1166..1307 (142px), label.field "Y" 1315..1599
```

Two things about launching Chromium were worth writing down, because both look like something else: it refuses
to start at all when `$TMPDIR` is deeper than about a hundred characters (`Socket path too long` in
`process_singleton_posix.cc`, after a crashpad complaint that reads like a missing database), which any path
inside a worktree this deep is, so the tool uses `/tmp/dsh-designer-layout`; and a profile has to be given, or
it tries to write into a read-only home. The browser (Chrome 155, ~300 MB) and its npm packages live under
`tests/tmp/`, which is not tracked.

A side measurement caught the other half of the job: a fix that makes everything fit by making everything
unusable. Control widths after the change, at 1280 px wide: geometry number inputs 68-100 px, a path field's
input 202 px, selects 201-220 px, colour fields 165-212 px, static values 214 px. Nothing is squeezed to a
sliver and nothing is cut off.

### The change, and why these four rules

```css
.body { grid-template-columns: 180px minmax(0, 1fr) 260px; }   /* the stage cannot push the pane */
.toolbox *, .properties * { max-width: 100%; }                   /* nothing may be wider than its pane */
.field-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.field > :not(.field-label) { flex: 1 1 0; min-width: 0; }
.field-label { flex: 0 1 auto; }                                 /* the label yields first, with an ellipsis */
.asset-field { display: flex; min-width: 0; }                    /* input and `...` share a row that can narrow */
.field > input[type="checkbox"] { flex: 0 0 auto; }              /* a checkbox is a box, not a field */
```

The `max-width` cap is belt and braces beside the zero minimums: a *minimum* is what pushes a setting off the
side, and a maximum stops anything that cannot shrink any other way from doing the same. `.asset-field` had no
rule at all until now, so its input and its browse button sat on one unbreakable line (there is no whitespace
between them, so no wrap opportunity), which is the same bug one control over. And the checkbox was being
stretched across half the row by `flex: 1`; it keeps its own size now and sits at the right edge.

### Guarded without a browser

The suite has no layout engine, so a browser cannot be part of it. What the suite can hold is the *declaration*
that keeps a row shrinkable: `tests/layers/t1-logic/designer-panel-layout.test.js` reads `designerStyles()` and
asserts each rule above, by property rather than by text, and says in its header why (a new field with a fixed
width looks right on a wide window and runs off a narrow one). Six tests; the suite is at **865 passed**.

Suite: **865 passed, 0 skipped**. The manual measurement: **0 of 132 states** overflow, at 640, 820, 1000 and
1280 px wide.

---

## 116. A touch that re-read the whole picture (2026-10-09)

"*The change to the image rendering affects the performance of the other widgets on the glass. e.g. all touch
events very laggy and slow to the point where it is unacceptable.*"

A regression from §114, and the mechanism is in the engine's render walk rather than in anything the image does
differently. Two readings first, because both rule something out:

* The card is **not** on the bus the touch controller shares. `testV69`'s `main.rs` says it plainly --
  "the touch controller shares this bus" (the panel's, re-clocked to 1 MHz around every touch burst) -- while
  `sd::init` is handed `peripherals.SPI3`, a bus of its own. The 10 MHz re-clock of §113 cannot reach the touch.
* The application does **not** repaint the whole screen per touch: its loop calls `is_dirty()` and then
  `render`, which is `GuiContext::render_dirty` once the first frame has been painted.

### What it was

`GuiContext::render_into` walks every widget and skips one only when its rectangle misses its **clip**
(`render/mod.rs:413`). The damaged region is applied *inside* the render context, where `visible_rect` intersects
it, so it clips the painting -- the `fill_rect` calls, the blits -- and nothing else. The widget's `render` is
still called, and a widget that only fills rectangles pays nothing for that. `BmpImage` is not that widget: its
`render` opens the card file and streams it. So every dirty frame walked over the image and read it again in
full, painting none of it. A touch that runs at ten samples a second therefore re-read the file ten times a
second, and the whole application waited for the card.

That also explains the shape of the report -- "the other widgets" -- because the cost lands on whatever is being
touched, not on the image: the image is not what the finger is on, and it is what makes the finger slow.

### The fix: ask the canvas what is left of the rectangle

The engine cannot know which custom widgets are expensive, so it now says what is left and lets the widget
decide:

```rust
pub trait CustomCanvas {
    /// The part of `rect` that can still reach the display, after the clip and the damaged region.
    /// The default is `rect` itself, which is what a canvas without damage tracking can honestly say.
    fn visible_rect(&self, rect: Rect) -> Rect { rect }
}
```

`RenderCtxCanvas` answers with `RenderCtx::visible_rect` -- the same function its own fills are clipped by, so
the two can never disagree. `BmpImage::render` asks *before* opening anything:

```rust
let visible = canvas.visible_rect(rect);
if visible.is_empty() {
    return Ok(());
}
```

and `BmpImage::draw` takes that band and paints (and reads) only the destination rows inside it. The rows
outside are stepped over by the `skip` of §113, and because the file rows wanted are a contiguous range that is
later in the file, the first one is reached by the same jump: a repaint of a band now costs what the band shows.
The row cache, the ordering and the seek all keep working untouched -- the loop simply `continue`s over rows
nothing will see, and the first row that is read is reached by the `ahead` arithmetic that was already there.

### The tests

Two levels, because either half alone could pass while the pair was broken:

* **The engine**: `test_a_widget_off_to_the_side_is_told_nothing_when_another_is_repainted` builds a
  `GuiContext` with a recording custom widget and a button, renders a whole frame (the widget is told its whole
  rectangle), then presses the button and renders dirty -- and asserts the recording widget is still walked and
  is told **nothing** is visible. Plus `test_visible_rect_is_what_the_clip_and_the_damage_leave` for the
  arithmetic: outside, overlapping and inside.
* **The widget**: `an_image_the_repaint_does_not_touch_is_never_read` asserts `read_count() == 0` for an empty
  visible rectangle -- the file is never opened -- and `only_the_rows_being_repainted_are_read` asserts a band
  read jumps over the rows above it (16 bytes for two 8-byte rows) and paints only the band's rows.

The recording uses `Cell`, not `Vec`: the runtime is `no_std` and its tests have no allocator, which is also why
the widget was declared before the context that borrows it.

### What is left

A **full** repaint still reads the image: the first frame, a screen switch, a calibration return. That is
correct -- the pixel really is being repainted -- and it is now the only time the card is touched. It is about
20 ms for an 80x100 BMP, about 70 ms for a 160x200 one, and about a second for the three-megabyte photo of
§113, once. The decoded-pixel cache §114 left out is the next step if that second ever matters; the measured
reason it was left out (214 KB for a 244x440 cell against ~300 KB of DRAM, redraws limited to whole-frame
repaints) has not changed.

Suite: **865 passed, 0 skipped**; the vendored widget crate is at **33** tests, the runtime fork at **238**, the
codegen fork at 23. The generated project still cross-checks under the ESP toolchain for
`xtensa-esp32-none-elf` (exit 0), with no change to `src/sd.rs` -- this fix is entirely inside the vendored
crates, so an existing project gets it from *Update Crates* alone.

---

## 117. Four blocks in the corners of a rounded border (2026-10-09)

"*When applying rounded corners to widgits like Buttons and Busy wheels, 4 square blocks are drawn in each corner
in the border colour.*"

Introduced in 0.0.67 with the appearance work (`3a9406f`, the commit that gave six controls colours and wrote
`stroke_rounded_rect_alpha`), and invisible until a radius big enough to show it: the crate's default radius is
**2**, where the "block" is a 2x2 square that reads as a corner pixel. A button with `corner_radius=10`, or a
busy wheel with the same, makes it four blocks.

### The loop that ran zero times

The straight edges of a rounded border were always right: `b`-thick strips along the four sides. The corners were
scanned per pixel, and a pixel was skipped if it was inside an *inner* rounded rectangle:

```rust
let mut i = 1u8;
while i < border.width {          // for a one-pixel border: 1 < 1 is false, so this never runs
    let inner_radius = radius.saturating_sub(i);
    if in_rounded_rect(x, y, inner, inner_radius) { inner_hit = true; break; }
    i += 1;
}
if !inner_hit { self.pixel(x, y, border.color, opacity)?; }
```

With `border.width == 1` the loop body never executes, `inner_hit` stays false, and **every pixel inside the
corner's arc** is painted: the whole corner, not the ring. Two bugs in one line, in fact -- for `width > 1` the
loop also breaks at the *smallest* inset that contains the pixel, which leaves a one-pixel ring where two or
three were asked for, so no border had ever been its stated thickness in a corner.

The ring is simply the outer rounded rectangle minus the one inset by the border's width (radius shrinking with
it), so the loop is not needed at all:

```rust
let inset = b as i32;                                     // the clamped border width
let inner = Rect::new(rect.x + inset, rect.y + inset, rect.w.saturating_sub(b * 2), rect.h.saturating_sub(b * 2));
if !inner.is_empty() && in_rounded_rect(x, y, inner, radius.saturating_sub(b as u8)) { continue; }
self.pixel(x, y, border.color, opacity)?;
```

### Reproducing it without hardware, and the numbers

The designer's canvas draws the same pixels as the crate -- `preview.ts`'s `strokeRounded` is a line-for-line
mirror -- so the bug could be *counted* rather than reasoned about. `tests/tmp/corner-probe.js` (scratch, ignored)
boots the real webview bundle against the stub DOM and counts the `fillRect` calls in a widget's corner boxes,
with the colours: the stub records method calls but not property assignments, so `getContext` is wrapped once
(the trick `t2-cli/designer-preview-controls.test.js` already uses) to record `fillStyle = ...` too.

| | before | after |
|---|---|---|
| crate, 12x12 corner of a hairline border | **98** painted pixels | **19** |
| preview, all four corners of a `corner_radius=12` button | **392** border pixels, 2052 canvas calls | **60**, 1388 |
| busy wheel (`corner_radius=12`, its own 2-pixel border) | -- | 42, a thicker arc |

The two implementations agreeing on 98 pixels per corner was itself the confirmation that the mirror is faithful.

### The tests

* **The crate**: `test_a_rounded_border_is_a_ring_and_not_a_block_in_the_corners` -- a hairline border on radius
  12 keeps the corner box under 40 pixels, the corner itself and the inside of the arc are untouched while the
  straight edge stays one pixel thick, and a two-pixel border is thicker but still not a block.
* **The preview**: `a rounded border is drawn as a ring, not as a block in each corner`,
  `t2-cli/designer-preview-controls.test.js`, the same measurement on the recorded calls -- the first test of the
  *shape* of a stroke rather than of a colour reaching the canvas.

Suite: **866 passed, 0 skipped**; the runtime fork is at **239** tests, the vendored widget crate at 33, the
codegen fork at 23. The generated project still cross-checks for `xtensa-esp32-none-elf` (exit 0). Both halves
live in the vendored crates, so an existing project picks this up from *Update Crates* -- no generated file
changes.

---

## 118. The second core, noted rather than used (2026-10-09)

"*Are we using more than one core for the boards that have dual core processors?*" -- and then, on the answer,
"*Note the option to move touch to core1. We will get to it later.*"

**No, one core**, on every board this platform generates for, all of which are dual core. The evidence, so it
does not have to be re-derived:

* **ESP32 / ESP32-S3**: `espBootBlock` emits `#[esp_rtos::main]` and `esp_rtos::start(timg0.timer0,
  peripherals.FROM_CPU_INTR0)`. esp-rtos 0.4.0 pins that context to the first core, traces "Starting scheduler
  for the first core" and asserts `Cpu::current() == Cpu::ProCpu` (`src/lib.rs:375-405`); the second core runs
  only after an explicit `esp_rtos::start_second_core(CPU_CTRL, FROM_CPU_INTR1, STACK.take(), …)`
  (`src/lib.rs:452`), which nothing calls.
* **RP2040 / RP2350**: `#[embassy_executor::main(executor = "embassy_rp::executor::Executor", entry =
  "cortex_m_rt::entry")]` is core 0; core 1 needs `embassy_rp::multicore::spawn_core1`, which nothing calls --
  the only mention of "multicore" in the repository is the comment explaining why the RP executor type is named
  explicitly.

So core 1 (`AppCpu`) is parked in the boot ROM while core 0 runs the panel, the touch, the GUI, the card reader
and the radio glue.

**Worth knowing before it is used:** a second core does *not* make a draw faster. The measured cost is
single-bus I/O (§113's card reads on SPI3, the panel's pixels on SPI2) and one SPI bus cannot be split. What it
buys is responsiveness during a long draw -- the touch sampling and the radio glue share the drawing task's
core, so a full-frame repaint stalls them, which is the "everything freezes while the picture is read" case that
0.0.74 reduced to a full repaint only.

**Deferred**: the plan, with the API, the stack size, the bus-sharing constraint (`RefCellDevice` must become a
`CriticalSectionDevice` because the panel/touch bus is shared), the calibration wrinkle and the hardware test, is
`plans/touch-on-core1.md`. Nothing about the generated firmware changed for this note.

---

## 119. A stop dialog that can end the question (2026-10-09)

"*make the assistant's stop dialog offer that as a third button -- 'Disable it so it doesn't come back'. ...
The server eats about 1.7 Gb of ram even when doing nothing which is totally unacceptable on systems with
limited ram.*"

The dialog already knew the situation and did nothing about it: `consequenceOf` appends *"the unit is enabled,
so it comes back at your next login"* (§118's finding), and then the only options were stop-this-run, leave it,
or stop asking. A server that returns at every login and holds gigabytes while idle needs a fourth answer.

### The decision is data, as everywhere else on this switch

`assistantSwitchPlan.ts` gained two pure functions, so the button's existence, its wording and the command it
runs are all asserted without a window:

```ts
export function disableOfferFor(step: OffStep): { unit: string; label: string } | undefined
export function disableUnitCommand(unit: string): { command: string; args: readonly string[] }
```

`disableOfferFor` is offered for exactly one case: a **user** unit that is **enabled**. Not a system unit (root,
and `offPlan` already refuses those with the `sudo` line), not a unit that is not enabled (nothing to undo), and
crucially not one whose state is `undefined` — `detectServerOwner` only sets `enabled` when `systemctl show`
said `UnitFileState`, and "we could not tell" must not become an offer to change something unverified. The label
lives in the plan module rather than in the dialog for the same reason the rest of the file exists: the wording
of the action and the decision to show it are one thing.

`disableUnitCommand` exists so the one part of the doing worth pinning -- the verb and the scope -- is testable
from a `no-vscode` module. It is consumed by `disableLlamaUnit` in `llamaService.ts`, which mirrors the stop
that always precedes it:

```
systemctl --user stop    llama-server.service      (stopLlamaServerConfirmed, unchanged)
systemctl --user disable llama-server.service      (disableLlamaUnit, new)
```

### The flow

`askToStopForeign` now builds its buttons from the offer (`Stop it`, `Leave it running`, the offer's label when
there is one, `Stop asking at startup`) and returns `'stop' | 'leave' | 'disable'`. "Disable" is recorded as
consent to stop as well -- the button says it stops it now -- so the caller runs the ordinary stop and then the
disable, and reports both:

> Done: llama-server.service has been stopped -- 1.7 GB freed; disabled llama-server.service, so it will not
> start at your next login.

A failed stop does not skip the disable: taking the unit out of the login target is the part that survives this
window, and it is reported on its own line whether the stop worked or not. The dialog explains the button in the
same breath, including that the switch can still start it on demand -- `systemctl --user start` works on a
disabled unit, which is what makes "disable" safe to offer rather than a way to break the user's setup.

### Why it matters: what the idle server is holding

Measured on this machine, from systemd's own accounting rather than a guess:

```
llama-server.service: Consumed 2.457s CPU time, 1.6G memory peak, 0B memory swap peak.
```

That is the unit of §118: `-c 16384` on a 30 B Qwen3-Coder MoE, loaded with `-ngl 0` (CPU only). The model file
is 17 GB and is **mmap'd**, so it lives in page cache and is reclaimable — which is why an earlier investigation
found 14.5 GiB charged to `user@1000.service` after the server exited. What is *resident* is the KV cache, and
it is pre-allocated at load:

| | |
|---|---|
| Qwen3-30B-A3B | 48 layers, 4 KV heads, head_dim 128 |
| per token | 48 x 4 x 128 x 2 (K and V) x 2 B (f16) = 98 304 B |
| x 16 384 tokens (`-c 16384`) | **1.50 GiB** |

1.5 GiB of cache + buffers + the touched part of the mapping is the 1.6-1.7 GB the user sees, with no request
in flight. The levers are all in the unit's own `ExecStart`, not in this extension: `-c 4096` cuts it to about
0.38 GiB, and a quantised cache (`--cache-type-k q8_0 --cache-type-v q8_0`) halves or quarters it again -- at
the cost of context the assistant's prompts have to fit in. Disabling the unit is the other answer, and the one
this button makes one click.

### Tests

Two in `t1-logic/ai-assistant-switch.test.js`, on the pure functions: the offer appears for an enabled user unit
with the requested wording and for nothing else (disabled, unknown state, plain process, a `stopOwn` step, and a
system unit that `offPlan` turns into a refusal before any dialog), and the command is
`systemctl --user disable <unit>` in that order. Suite: **868 passed, 0 skipped**.

## 120. A Tick Box that can be sized, labelled, and styled (2026-10-12)

Asked in one sentence, with a clarification a moment later: *"We must design a new Tick Box widget. The new Tick
box must be identical to the existing one but the box size (the tick mark must scale accordingly) must be
settable to any width/height the user selects, the label must be placeable to the left, right, top or bottom of
the tick box and the label Font and colour must be selectable. Remove the old tick box from the list."* — and
then simply *"Tick box, also known as Checkbox."*

Three decisions came out of that, none of them spelled out in the request:

1. **The old entry is gone, not deprecated beside the new one.** "Remove the old tick box from the list" means
   the toolbox shows one Checkbox. A second entry that does the same thing except for the parts it cannot do is
   how a toolbox becomes a quiz.
2. **The old designs must keep working.** `box_size` was the single number the old widget took, and a design
   written with it stores it in its `.ui.kdl`. Deleting the property from the catalogue would have validated
   those designs as "unknown property" and silently given them a box of a size nobody chose. So the catalogue
   keeps it as `{ legacy: true }`: **hidden from the property form, still accepted by the validator, still read
   by the codegen** as the fallback for both sides (`parser.rs`: *"box_size is the older, single number: a design
   written before the box had two sides names it"*). The property form skips anything marked `legacy`
   (`panels.ts`), which is the one place that flag is read.
3. **The label is centred on its side, not left where it lands.** Asked for separately as *"The Checkbox label
   must be justified to the centre of the selected side of the box"* — it is a visible difference and the reason
   `CheckboxLabelPosition` is a type rather than a flag.

What moved: the catalogue (`box_width`, `box_height`, `label_position`, `font`, `box_color`), the crate
(`CheckboxWidget`, `add_checkbox_sized`, `CheckboxLabelPosition`, and a tick that scales with the box), the
codegen (parser, serializer, emitter), and the designer's own canvas — `preview.ts` draws the control for the
canvas and had to be taught the same four label sides and the scaling tick, or the preview would have been a
second, wrong opinion about what the board will show.

## 121. A font for the widgets that actually read one (2026-10-12)

The same request, one clause on: *"Add a Font selector for all Widgets that can display text (labels etc.)"*.

The trap is in "that can display text". `RenderCtx::draw_text` hard-codes the built-in `Tiny3x5` face — so a
widget that accepts a `font` attribute and calls `draw_text` **ignores it**, and a font selector there would be a
control that does nothing. Two consequences:

- the crate needed a way to draw with a chosen face at all (`draw_text_with_font`), which is why it appears in
  `widgets/mod.rs`, `picker.rs`, `status_bar.rs` and `render/mod.rs` and not in one place;
- the catalogue needed to say *where a font is real*, which is what `fontSupport` is for: `'both'` where the
  widget passes the style on itself, `'style'` where it reads `style.font` (or `resolved.font`) inside its own
  text call. The validator uses the same flag, so a design cannot set a font that the renderer will drop.

The third piece was duller and nearly missed: the codegen had to **carry `style` through** the builders for the
dropdown, the dialog and the table. Without that the property validated, the emitter emitted it, and the
firmware drew the small face anyway.

## 122. The middle button, a menu that was black on black, and a diff that could be implemented later (2026-10-12)

Three separate complaints in one request, all in the designer's own UI:

- **"A middle button click on a widget with code behind must shift focus to the handler code."** `auxclick`
  with `button === 1` in `canvas.ts` → `onRevealHandler` → the extension opens `src/ui_handlers.rs` at the item.
  The primary button still selects, and `pointerDown` now requires `button === 0`, because a canvas that moves
  to another file on a left click is not a canvas anybody can drag in.
- **"The right-click context menu (for dropped widgets) always renders some rows in Black."** `.context-item`
  had no `color` of its own. A `<button>` does not inherit the menu's foreground — only `.danger` and `:hover`
  set one — so every other row was drawn in the platform default, which on a dark menu is black on black. The
  fix is a `color: var(--vscode-menu-foreground, var(--vscode-foreground))` on the class, and the *test* asserts
  the rule rather than a colour, because jsdom has no layout and no theme and could never have caught the
  original.
- **"When using the AI Assist feature the prompt to accept and implement a diff is only shown for a brief period
  and then disappears. Thereafter there is no way to implement the diff. Add an Implement Diff button in the
  task bar."** Correct as reported: Apply/Discard lived on a notification and a code lens, and a dismissed
  notification left a proposal that could not be applied at all. Now there is a `$(diff) Implement Diff` status
  bar item while *any* proposal exists (`anyProposal()`), alongside `closeProposal()` and `describeProposal()` so
  a proposal opened from the chat, the fix flow or a repair pass all behave identically.

## 123. The assistant that erased a main.rs (2026-10-12)

The most expensive bug in this log so far, and the one that produced §125.

A test project's `src/main.rs` was 41,542 bytes — **~10,386 tokens** of Rust — and the assistant's window was
8192 with 4096 reserved for the answer, leaving **~4,032 for the prompt**. The model was asked for a change and
answered with a *whole file*: it could not fit the file it was editing into its own window, so it invented the
parts it could not see, and every item it did not reproduce was deleted. The request was not badly worded. It was
arithmetically impossible, and nothing in the extension said so (§125 is that sentence).

What was fixed here, before the gate existed:

- **An elided answer is refused, not spliced.** `elisionMarker()` spots `...`, `// ...` and friends;
  `keepsEveryItem()` counts the items in the file against the items in the answer. The second hole was found by
  the suite, not by a user: an elided answer spliced as *one item* still wiped the function it was vague about,
  so `insertChatCode` now returns the text unchanged for **any** elided answer.
- **A whole-file-shaped answer is confirmed in a modal** that names the file (`looksLikeWholeFile`: an inner
  attribute, or `fn main` beside a `use`), instead of being applied because it parsed.
- **The prompt asks for the changed item only** (`chatSystem` in `aiChatView.ts`): leave every other item out
  entirely, never write a placeholder for code you did not write, never reproduce a file "to keep it unchanged".
- **The window and the answer budget are one decision.** The window is shared and the answer gets what the
  prompt left (`answerBudget`), `contextForBudget` — which existed and was never called — is now what the
  runtime is started with, `DEFAULT_CONTEXT_SIZE` went 4096 → 8192, and `squeezedAnswerNotice` says so with the
  numbers when the answer is cut short. "Only accepts 180 tokens" (the user's words) was never a cap: it was
  4096 minus whatever the prompt took, minus the slack.

## 124. "Fix the Build" did nothing, for three unrelated reasons (2026-10-12)

Reported as *"The AI generated code with some errors, Fix the build does not work."* All three causes were real,
none of them was the model:

1. **The build ran without the ESP environment.** An ESP32 project cannot link without the Xtensa linker that
   `source ~/export-esp.sh` puts on the PATH, and the extension host has never sourced it — so cargo died in
   `build.rs` (`Xtensa linker ... not found on PATH`) with **no diagnostics**, and the repair loop had nothing to
   fix. Both in-process build paths now read and parse that file (`espEnv()`), the same one the terminal commands
   use. The failure was also unreadable in the report, which is what `environmentFailure()` in `cargoMessages.ts`
   is for.
2. **The designer wrote `src/ui.kdl` but never regenerated `src/ui.rs`.** A save that removed a widget left the
   generated module still calling `on_go_clicked()` for a widget that no longer existed — `E0425`, a build error
   no AI can fix, because the file it would have to fix is generated. The module is now rewritten on every
   designer save (`syncModule()`), with the markup it belongs to.
3. **Every error sat inside an 852-line `main`**, over `MAX_METHOD_LINES = 120`, so each one was skipped in
   silence and the report read "nothing-fixable" when the truth was duller. `fixOne` now pushes the reason into
   `skipped[]` and the summary prints it.

Fixing the third one surfaced a generator gap of the extension's own making: with no event arms in a design,
nothing in the generated file reads the `widgets` handle, so a fresh project built with
`warning: field 'widgets' is never read`. `emitUiRs` now emits `#[allow(dead_code)]` **only when there are no
arms**, so a design that does raise an event still hears about a handle with genuinely nothing reading it.

The one-line fix in the test project's `src/ui.rs` (the stale arm) is what `syncModule` prevents from coming
back. After it: `cargo check` clean, no warnings of the extension's making.

## 125. Ask before the model cannot answer, and hand the job to the pool agent (2026-10-12)

The instruction, in the user's words: *"The extension must inspect each ask prompt to verify that it is within the
scope of the ai model capabilities. If not, warn the user and abort."* — plus one question: *"Also, can we hand
off the prompt (after warning the user) to a listening cloud api agent?"*

### What counts as beyond scope, and how far to trust it

Six checks in `ai/scope.ts`, worst-first, and they are deliberately **two different kinds of thing**:

| Kind | Checks | Trust |
|---|---|---|
| Arithmetic | `prompt-overflow`, `file-too-big`, `item-too-long`, `answer-starved` | measured against the window the model was really started with — the numbers in the message are the evidence |
| Intent (heuristic) | `whole-file-intent`, `beyond-model` | reads the developer's sentence, quotes what it read (*"read as: ..."*), and can be wrong both ways |

The three answers the user chose, when asked: hand off to a cloud agent (answered with *pool*, below), **ask
every time showing what will be sent**, and *"size arithmetic + intent phrases, with an override"*. The override
is why every refusal offers **Send it anyway**: a heuristic that cannot be overridden is wrong eventually and
infuriating when it is.

Two traps found while writing it. A named file in a sentence is **not** an intent match — "rewrite src/main.rs"
belongs to the arithmetic, which measures the file, or a 20-line `ui_handlers.rs` would be refused for its verb.
And the chat measures the file **only for a change request** (`looksLikeChangeRequest`): a clipped view of a file
is enough to *explain* something, so refusing "why does this deadlock?" would be the wrong kind of strict, while
"add a timeout to this loop" genuinely needs the whole file to be changed safely.

### The hand-off, measured rather than assumed

The user has **Poolside's `pool` CLI** (1.0.16) on this machine, already authenticated, which is a much better
answer than an HTTP API: it is an agent with tools and a far larger model. Every part of the contract was
verified against the real binary before a line was written:

| Fact | Value |
|---|---|
| Run non-interactively | `pool exec -o json -d <project> -p -` (prompt on **stdin**, never argv) |
| Stdout | NDJSON: `assistantMessage` = the answer, `toolCall` = work, `exit`(`args.success`) = its own verdict |
| Exit codes | **0** done · **4** "I ran and could not" · anything else an error |
| Continue | `--continue <Run ID>`; the ID is the UUID in `~/.local/state/poolside/trajectories/trajectory-*_<uuid>.ndjson` |
| Non-interactive acting | `--unsafe-auto-allow`, or a run that needs to edit a file stops and asks nobody |
| **Model** | **not selectable**: `-m` is obsolete on `exec` and errors pointing at `--agent-name`, so the platform owns the model choice — the settings name an **agent** |

Three bugs the suite caught, all of which would have shipped as "the hand-off is broken":

1. **The closing paragraph was thrown away.** pool sends its `exit` tool call *after* the agent's summary, and
   the parser treated any tool call as the end of the preamble — so `final` was `''` on every successful run.
   Only a non-`exit` call resets it now.
2. **A run could be reported for the wrong run id.** Two trajectory files written in the same millisecond made
   the choice depend on `readdir` order, and it picked a file written *before* the run. Ties are broken by the
   id, which is a UUIDv7 and therefore time-ordered by construction.
3. **A 1.5 s timeout took 30 s.** `pool` is a wrapper, so the process the handle names is not the only one
   holding the pipes — a `sleep` or a compiler underneath inherits them, and killing the wrapper left the promise
   waiting for the grandchild. The run is now spawned `detached` and stopped as a **process group**, and a run
   that was stopped finishes on `exit` rather than `close`. Measured after: ~1.5 s.

### Where the code lives, and why there

`ai/scope.ts` (pure, no `vscode`) decides; `ai/pool.ts` (pure + one spawn) knows the CLI; `ai/handoff.ts` talks to
the user — consent, progress, report, workspace state. Two placement decisions were forced by the test suite:

- the **hand-off settings normaliser lives in `pool.ts`**, not `handoff.ts`, because `handoff.ts` imports `vscode`
  and a module that imports `vscode` cannot be loaded by the suite at all — and "what does this setting mean" is
  exactly what deserves an assertion;
- `pool.ts` loads `ai/log.ts` with a **local `log()` that `require`s it lazily**: a top-level import made the
  module unloadable in the t2 layer (`Cannot find module 'vscode'`), and a log line is not worth making a module
  untestable for.

The t2 layer drives a **fake `pool`** (`tests/layers/t2-cli/shims/pool`) as a real child process — it reports the
byte count of the prompt it read from stdin, so "the prompt never goes through argv" is asserted rather than
assumed — with modes for success, task-failure, error, junk output and a run that will not finish.

### Not sent quietly

A hand-off sends the developer's code to Poolside's service (`inference.poolside.ai`, the API in their own pool
configuration) and lets an agent change files without asking. Both are disclosed in the consent dialog on every
run — there is no "remember my answer" path — and `handoff: "off"` removes the offer while keeping the checks.
Auto-allow defaults to on because a non-interactive run cannot answer an approval prompt, which makes the
alternative "stops and does nothing".

Suite after all of this: **t1 838, t2 74, t3 4 — 916 checks, 0 skipped, 0 failed** (run per layer while the work
was in progress, then the whole suite in one go at the end, with the same numbers); `npm run compile`
and the PROBLEMS pane clean. One verification worth keeping: the panel's script is a line inside a TypeScript
template literal, so `tsc` cannot see a syntax error in it — it is parsed separately (242 lines) before a release.

## 126. A switch that read like a list, and the settings that were never written (2026-10-13)

Reported, in two parts that turned out to be one bug and one misunderstanding:

> *"'When a request is beyond the local model' only have the Pool agent in the list. Where is the agnes option.
> Also the prompt in the response box reads: Hand to the Pool agent."*

The **wording** was a real defect: the control being read as an agent list is the on/off switch, and its option
text still said "Hand it to the pool agent" from when pool was the only answer. It now reads *Warn me and stop* /
*Hand it to an agent* (the stored values are unchanged, so a configuration keeps meaning what it meant), and every
hand-off action — the chat's refusal button, the editor's modal, the repair loop's offer, the report header, the
progress line — is labelled from `handoffButtonLabel(chooseAgent(...))`, i.e. from the agent that will *really*
run. The Agnes entry was in the **other** control all along (*Which agent a hand-off uses*), which is why the
switch misleading the eye mattered.

The **vanishing setting** was the bug underneath: *"This is the endpoint for Agnes … It is not in the hand-off
agent list."* The endpoint had been typed in and saved, and the field reverted. `save()` listed the keys it would
write **by hand** — five of them — while the form sent twelve, so `contextSize`, `maxTokens`, the whole hand-off
group including the cloud endpoint were sent by the webview, compared against what the panel had been told, and
then dropped. No error: the form refreshed from settings that had never been written.
`ai/panelSettings.ts` (`planWrites`) now decides against the manifest's own `contributes.configuration.properties`,
so the manifest is the only list; a key it does not declare, or a value of the wrong type, is refused **and said
out loud**; and `t1-logic/ai-panel-settings.test.js` reads the real form source and the real manifest and fails on
drift, with an assertion that the save method contains no `cfg.update('<name>'` chain — the shape that grew the
list in the first place.

Two smaller lies in the same area went with it. Storing a cloud API key reported success without checking, so a
key that had not been saved looked exactly like one that had; `setHandoffKey` now reads it back and says so when it
fails. And "Open the AI settings" revealed the view while leaving the settings `<details>` collapsed, so pressing
it with the view already on screen did nothing a person could see: it now expands the section and lands the caret
on the field the key flow needs, with the editor-tab chat as a logged fallback.

## 127. An answer nobody could implement, rules that reached no prompt, and a cap nobody asked for (2026-10-13)

> *"Can we equip it with the ability to generate diffs and on permission implement it?"*
> *"Maximise the cloud agents must receive the full responses, do not cap it."*
> *"Also, how to set up the rules for the cloud agents?"*

Three questions, and each one found something that was half-built.

**The diff existed; the answer never reached it.** A hand-off from the chat did store its answer as a turn — but
the live `post({type:'turn'})` carried no code blocks, while the *restored history* computed them
(`turnsForView`), so the `Implement …` buttons appeared only after a panel reload, and a hand-off from the repair
loop never entered the conversation at all. One label rule now serves both (`codeLabels`), the view registers
`onHandoffReport(addHandoffTurn)`, and `handOff` is a thin wrapper over `performHandOff` that announces its report
to listeners — so all three hand-off starting points end in one conversation entry, with the code implementable
through the same diff-then-apply path a local answer uses (`applyChatCode`). The notification for an answered
hand-off offers **Review and implement…** directly, with a picker labelled the way the chat labels its buttons
when the answer carries several blocks.

**The cap was the local one.** `max_tokens: cfg.maxTokens` went on every request, cloud included, so a cloud
agent — handed exactly the jobs the local model could not fit — was cut off at the *local* answer budget.
`ChatOptions.omitMaxTokens` makes the request leave the field out entirely rather than invent a number, since the
provider's own maximum is the only true one. Asserted behaviourally in `ai-assistant.test.js` (the injected
`fetch` captures the body: no `max_tokens` key with the option, the configured number without it).

**The rules were promised in every prompt and delivered to two of them.** The one rules mechanism is
`rustyPlatform.assistant.conventions`, whose own description says "They are put in every prompt" — true of the
editor's implement/fix flows and the repair hand-off, false of the chat, which is the prompt *every* hand-off
carries and the only place a cloud agent could ever be given rules, since it never sees the project. The rules are
now part of the facts block the chat builds (`houseRules()`), so the local chat and every hand-off get them. How
to set them: **Rusty AI: Learn the House Rules from My Code…** measures patterns from your own Rust and keeps what
you accept; the setting is also editable directly, and hand-written rules sit alongside the measured ones.
Nothing in the extension reads `AGENTS.md` — worth knowing before assuming a rules file is being sent.

## 128. The Agnes Code CLI, driven the way the pool agent is (2026-10-13)

> *"the Agnes model has a dedicated CLI agent called **Agnes Code CLI** … Why don't we implement this agent in a
> similar fashion than the Pool agent was implemented?"*

Because only pool's invocation had ever been *measured*, and `drivable: true` is a claim about a measured
contract. So the first thing was not code: it was asking the CLI. `jcode --version` → **v0.75.0**; `run --help`
showed `run <MESSAGE>` (the message is **argv**, the opposite of pool's `-p -`/stdin), `--ndjson`, `--json`,
`-C/--cwd`, `--resume [<ID>]`, `-p/-m`, `--tools`/`--tool-profile`; `provider list` showed the
`openai-compatible` provider this machine reaches Agnes through; and the saved sessions under
`~/.jcode/sessions/session_<animal>_<ms>_<hex>.json` record `working_dir`, so "this project's last conversation"
is a precise question rather than a guess at the newest file (which is all pool's trajectory directory allows).

One live probe was approved and spent — a single prompt in a scratch directory, whose output is kept as
`tests/layers/t2-cli/fixtures/jcode-run.ndjson`. It settled everything the help text could not: the event shapes
(`start` carries the session id, `done` carries the whole answer and the usage), the fact that **a `tool_input`
carries no id** and a long argument arrives in several deltas that must be reassembled onto the most recent
`tool_start`, that **tools run with no approval prompt at all** (a `write` created the file unattended, and there
is no flag to brake it — so the consent dialog says exactly that instead of promising a switch that does not
exist), that no daemon is needed, and that exit 0 means finished with no second code to read.

`src/ai/jcode.ts` is the driver, shaped like `pool.ts`: arguments, the NDJSON record, a tool line, the outcome and
the session naming are pure and asserted; only the spawn and the directory scan touch the world. The spawn is
`detached` and killed **as a process group** for the same measured reason as pool's (a launcher is not the only
process holding the pipes). `AgentKind` gained `jcode`, `CLI_PRESETS` lists it as the second drivable CLI, and
`handoff.ts` dispatches on `agent.kind` instead of assuming "not an endpoint, therefore pool". Its settings are
`jcodeCommand`, `jcodeProvider`, `jcodeModel` — provider and model default to **empty**, i.e. jcode's own
configuration, because which provider a CLI agent should use is the developer's choice; the consent dialog names
whatever will be used so the choice is never invisible.

Tests: `ai-jcode.test.js` in t1 (pure, against the recorded run) and in t2 against `shims/jcode`, a fake that is
literal about the contract — including `stdin 0 bytes` in its answer, which is how "the message arrives as an
argument" is proven end to end rather than only in a pure assertion. The shim's modes cover a failed tool, an
unfinished run, an unknown event shape, a non-zero exit, the timeout and the Cancel button, and a missing command.
Two things it taught the hard way: a `printf` format string split across several calls consumes its own
placeholders with **no arguments** (the shim reported empty byte counts, and the test then blamed the driver,
which was right), and a shim that reads stdin blocks when run by hand in a terminal — the driver passes
`stdio: ['ignore', …]`, which is why it is instant there.

Suite after all of this: **t1 878, t2 92, t3 4 — 974 checks, 0 skipped, 0 failed** (per layer while working, and
the whole hermetic suite at the end); `npm run compile` and the PROBLEMS pane clean. The panel's script is parsed
separately before a release, as always — and this time that check earned its keep by catching a TypeScript type
annotation written into the webview's plain JavaScript (`function willRun(): string`), which `tsc` cannot see
because the whole script is one string. Two more wounds of the usual kind are recorded in the repo memory: a
`pool`-only test that encoded "exactly one preset is drivable" had to be *rewritten* rather than deleted when a
second one arrived, and the template-literal backtick trap caught a comment for the sixth time.

---

## 129. The hand-off comes out — the assistant is local-only (2026-10-14)

**Asked for, verbatim:** *"Please strip all Ai Assist hand-off functionality from the extension. Only the
locally run ai model(s) features must remain. The chat panel in the Ai Assist section of the extension's side
bar must remain, but must be limited for use by local ai functionality and must not be able to edit code in the
code editor panels. The 'Implement in function' feature can only be used for local ai code generation."*

Three of the four questions asked back changed the shape of the job, so they are worth recording:

- **The chat's "Implement `fn …` in the project…" buttons stay** (answered: *"No — keep them (they already use
  the local model); only the hand-off goes"*). They write through `applyChatCode`, i.e. a diff the user applies
  — the same review step as the editor's `✎ AI` flows — so "must not be able to edit code" is read as being
  about the **hand-off agents** (which edit files on disk without a review) and not about a reviewed local diff.
- **The whole scope-check system goes** (*"Remove the whole scope-check system"*), not just its hand-off offer.
  `ai/scope.ts`, its four arithmetic plus two heuristic checks, `guardScope` in `editor.ts` and the refusal block
  in the chat are all gone. The "you asked for a whole file" heuristics had already been duplicated as hard
  guards where they matter (`chatCodeProblem`, `looksLikeWholeFile`, `methodTooLong`), which is why the
  remainder was removable without losing the protection it was there for.
- **Dead code that only the hand-off used goes with it.** `ChatOptions.apiKey` (bearer token) and
  `ChatOptions.omitMaxTokens` (the uncapped cloud answer) had no other caller, so both were dropped from
  `assistant.ts` along with their test; the request now always states `max_tokens: cfg.maxTokens`.

**What was deleted:** `src/ai/pool.ts`, `jcode.ts`, `handoff.ts`, `agents.ts`, `scope.ts`; the three commands
(`assistant.forgetPoolRun`, `assistant.chooseAgent`, `assistant.setHandoffKey`) and their `package.json`
entries; the twelve settings (`handoff`, `handoffAgent`, `cloudEndpoint`, `cloudModel`, `poolCommand`,
`poolAgent`, `poolAutoAllow`, `poolTimeoutSeconds`, `poolResume`, `jcodeCommand`, `jcodeProvider`,
`jcodeModel`); the chat panel's agent/cloud/pool/jcode markup + script (`setAgents`, `refreshAgentSettings`,
`showScope`, the `agents`/`scope`/`handoff` messages); `showHandoff`, `implementHandoffCode`, `handoffAction`,
`factsText`, `handOffForRepair` and the repair loop's last-offer block in `editor.ts`; and the tests
`ai-agents`, `ai-scope`, `ai-cloud`, `ai-handoff-chat`, `ai-jcode` (t1), `ai-agents-scan`, `ai-jcode` and
`ai-pool` (t2) with `shims/pool`, `shims/jcode` and `fixtures/jcode-run.ndjson`.

**Two traps, both already in the repo memory and both hit again anyway:**

1. **`tsc` does not clean `out/`.** After deleting five sources the matching `out/ai/*.js` and `*.js.map` were
   still there and would have shipped in the VSIX (`vsce` packages what is on disk, not what `tsc` last
   touched). They were removed by hand — worth doing as a step of its own whenever a `src/` module is deleted.
2. **A deletion done as a *replacement* can leave a fragment.** The `omitMaxTokens` test was removed and
   re-titled in one edit, which left the new `test('…', async () => {` line with no body and — worse — an
   apostrophe inside a single-quoted string. The suite would have failed to parse; it was caught by reading the
   region back (the rule is already in the memory: re-read around any multi-line replacement).

**Kept, deliberately:** the switch (`assistantSwitch*`), the bundled sidecar runtime, the external
OpenAI-compatible server, the whole `llama-server` flow, Hugging Face model add/remove, the model pickers, the
host check, unload/status, the house rules, the `✎ AI` block with its diff review, "Fix the Build" and cargo
check, the chat panel (side-bar view **and** editor tab) with its "Implement …" buttons, and
`panelSettings.ts`'s manifest-driven save — which now simply has fewer fields to know about.

**Docs updated in the same pass** (the user asked for that explicitly, unlike the standing "leave the docs
alone" rule): `AI_ASSIST.md` §7 and the hand-off rows in its Commands/Settings tables are gone and "What leaves
your machine" is now one sentence — nothing does; `README.md`'s AI section lost its three hand-off bullets;
`CHANGELOG.md` records the removal under `[Unreleased]` (no version bump was asked for).

**Verified:** `npx tsc -p ./` clean; `node tests/runner.js --file ai-` green while working; the whole hermetic
suite at the end, once and with the user's permission: **t1 + t2 + t3, 889 checks, 0 skipped, 0 failed**
(780 ms). The count is lower than §128's 974 because eight hand-off test files and their shims/fixture went with
the feature; nothing was skipped or disabled.

## 130. The Roller turns under a finger (2026-10-14)

**Asked for, verbatim:** *"I want the Roller widgit to rotate the roller when dragging on it using the touch
panel."* Up to this point the only widget a drag could move was the one that scrolls: `handle_pointer_moved`
knew about ScrollView and nothing else.

**What a drag now is.** `GuiContext::drag_step_selection(&mut self, pressed: &mut PressTracker, dy: i32)` turns
the widget the *press* focused, so the gesture is the same one the finger already makes: press on the roller,
slide up or down, watch the selection follow. One item per drawn row of travel — the step is
`max(rect.h / drag_rows(kind), MIN_DRAG_STEP_PX = 12)` — accumulated in the new `PressTracker::drag_accum_y`,
with `MAX_DRAG_STEPS_PER_SAMPLE = 8` items per pointer sample so a fast flick cannot run the list away. Index
selectors (Menu, RichMenu, Dropdown, Roller, Carousel, Keyboard, List, CircularList, FeedTimeline) go through
`adjust_focused_selection`; the value selectors get `drag_value_step` — Spinbox by its own `step`, NumberPicker
by ±1, TimePicker by the hour, with `step_time_of_day` doing the 12-hour AM/PM roll from a 24-hour value.
`handle_pointer_moved` sets `scroll_target = None` when the drag was consumed, so a selector inside a ScrollView
does not also scroll the view. `ROLLER_ROWS = 3` in `widgets/mod.rs` is now the single source for the roller's
row count, shared by `render_roller` and `drag_rows` so the two cannot drift.

**Two widgets stay out of the drag set, deliberately.** ScrollView scrolls rather than selects. AutoComplete is
not there because a press *confirms and collapses* it and never focuses it, so a drag can never reach it. A
Dropdown is in the set, but its press toggles it closed (`select_opens_dropdown`), so a drag only reaches an open
one — which is what the widget's own contract says, not something the drag gets to overrule.

**Three traps, all of which cost a run:**

1. **`bump_index_with_wrap` reads only the *sign* of its delta.** My first version passed the accumulated number
   of items in one call and watched the roller move exactly one item. Selectors now step one item at a time, in
   a loop.
2. **The test context ran out of events.** `EventsFull` came back from a press plus a drag because the test's
   `GuiContext<'static, 32, 64, 16>` has sixteen event slots; a press, a move and the events they raise do not
   fit in it. The test context is sized for the gesture, not for a tap.
3. **Two of my own expectations were wrong**, and the tests said so before the board did: an hour back from
   11 PM is 10 PM (not 11 PM, which is what I had written), and a wrap-disabled selector stops at the first item
   rather than wrapping to the last.

`focusable()` also gained Spinbox, NumberPicker, TimePicker and Carousel: `pointer_hit` only considers focusable
widgets, so before this a finger could not land on them at all — not even for a tap. The catalogue lost the dead
`scroll` event from roller, carousel and table (a roller raises `valueChanged`), and the carousel gained it.

**Suite:** 256 crate tests, `node tests/tools/designer-sim.js` PASS, 202 designer tests.

## 131. The design gets a way to be driven from the app's own code (2026-10-14)

**The report that started it:** *"compile error in my test app 'testV69'."* `E0599: no method named
`set_scale_value`` — and the method was not missing, it had been **erased**: a previous session had hand-added it
to the app's generated `src/ui.rs`, and the next Designer save regenerated that file from the design. The backup
folder beside the app (`testV69_2026-10-14_13:13:05/`) still had it, which is what proved where it went.

**The fix is in the generator, not in the app.** The generated `Designer` had no way to reach its own widgets —
`gui` was private and only `pointer`, `pump`, `is_dirty`, `repaint` and `render` were public — so a screen could
be touched and painted but never *told* anything, which is exactly what an app animating a needle needs. It now
exposes `gui()` and `gui_mut()`, both `#[allow(dead_code)]` for the same reason the `widgets` field carries it:
whether an app drives a widget itself is the app's business, and the warning would otherwise appear in every
project that does not.

**The route to a value**, which is worth writing down because it is not obvious:
`let id = screen.widgets.my_scale; screen.gui_mut().set_widget_property(id, PropertyKey::Value,
PropertyValue::Float(v))`. `PropertyKey` and `PropertyValue` are exported at the crate root but are **not in the
prelude**, so app code has to name them. `Scale` is the one value widget with no named setter (Gauge, Dial,
Meter, Slider and ValueLabel all have one), which is why the generic path matters; it dirties only the needle's
spoke rather than the whole widget.

**Template caution (the same trap as §108):** the Rust this generator emits lives inside a JavaScript template
literal, and a backtick in a doc comment ends the literal. The first attempt at the accessors' documentation did
exactly that and `tsc` reported an error nowhere near the edit.

**Verified:** the app's `cargo check` finished with 0 warnings and 0 errors, the sim regenerated and passed, and
`npx tsc -p ./` was clean.

## 132. A widget no longer recolours itself when it is touched (2026-10-14)

**Asked for, verbatim:** *"There is an issue with all widgits: When i touch a widget that can get focus its
colour changes and that makes its contents difficult to see. e.g. a checkbox checksate cant be seen. Also the
Roller selection is not vissible. The widgits colours should not change when it has focus. When the widits
action was performed (e.g. a checkbox sate was toggled), that widgit should automatically lose focus."*

**One line caused all of it.** `WidgetStyle::new` built its focused and pressed states out of
`normal.selected(true)`, and `Style::selected(true)` means `background = accent; border = white`. So touching
*any* widget filled its block with the accent colour, painted **over** whatever the widget draws for itself: a
checkbox's tick is drawn in the accent, so it became an accent square on an accent block, and a roller's selected
row *is* the accent, so that row disappeared into the panel behind it. The designer's own canvas never showed
this — it paints the normal style — which is why it was only ever visible on the glass.

**What replaced it.** `Style::with_highlighted_outline(color)` brightens the border **colour** and changes
nothing else, and that is now what focused and pressed are. The outline's *width* is deliberately never touched:
`Block::inner` subtracts it, so a wider border on focus would move every widget's contents by a pixel and could
re-wrap its text. A style with no border therefore shows no hint at all rather than a jumping one — a deliberate
choice, not an oversight. The ProgressBar's fill also stopped switching from `foreground` to `accent` on focus.

**Giving the focus back.** `activate_focused` already computed whether the activation *changed* the widget; it
now returns that, and `dispatch_activation` calls `set_focus(None)` when the activation came from a pointer and
something changed — a Checkbox or Toggle thrown, a Dropdown opened, a Keyboard key typed. A tap that changed
nothing keeps the focus, which is what a roller needs (and what the drag above reads to know which selector to
turn), and a TextArea keeps it so its caret stays on screen. The 1px accent carets in `render_spinbox` and
`render_textarea` were left alone for the same reason.

**One timing detail worth recording**, because it made my first test fail: this engine activates on the
**press**, so a checkbox is focused and handed back inside a single event. The test now asserts the
`Focused`/`Defocused` pair on the event stream rather than sampling `focus()` between the press and the release.

**Verified:** `cargo test --lib` 260 passed (five new focus tests), the sim PASS, `tsc` clean, and 0.0.92 built
and installed.

## 133. An old design that froze the board, and never said so (2026-10-14)

**Asked for, verbatim:** *"Check my test app, testV69. Why is the checkbox widget not rendered as it is defined
in the Designer?"*

**The chain, once traced.** `designer/panel.ui.json` is the source of truth and `src/ui.kdl` is generated from
it by `DesignerPanel.save()` — the only writer of an existing project's markup. `renderDesign` always returns
the document but returns **no markup** when `validateDocument` complains, and `save()` writes the document either
way. So an invalid design is written, drawn on the canvas, edited freely — and silently stops reaching the
board, which goes on compiling the last `ui.kdl` that worked.

**The live case.** The checkbox carried a leftover `"style": "panel"` property. No revision of the catalogue has
ever offered a checkbox a named style (I checked all fourteen commits of `catalog.ts`; only `label`, `button`,
`panel` and `carousel` declare one), so every save since had reported
`"gaugeRun": "style" is not a property of a checkbox` and never rewritten the markup. The panel drew the old
`label="RUN"` checkbox from `ui.kdl` (17:37) while the canvas showed a 50×50 box labelled `Swing it!` (18:09).

**The one command that diagnoses it**, without VS Code:

```
node -e "console.log(require('./out/designer/store.js').renderDesign(JSON.parse(require('fs').readFileSync('<app>/designer/panel.ui.json','utf8'))))"
```

**Hand-editing the JSON is not a fix** — and finding that out was the useful part. I removed the key from the
file; the canvas is sent the whole document and posts the whole document back on every change, so the next
edit to that widget wrote the key straight back in (18:24, a box-size change). Only the load path can clean it.

**The fix.** `unknownProps(widget)` in `model.ts` is now the single answer the validator *and* the cleanup read,
so a property cannot be reported by one and tolerated by the other; `dropUnknownProps` runs inside
`migrateDocument`, so a version 1 document is migrated and pruned in the same pass; `LoadResult.notes` carries
one sentence per property dropped; and `show()` writes the cleaned document **and** its freshly generated markup
the moment the project is opened, seeding `lastWritten` so the first edit is a change and not a rewrite. Only
unknown *keys* are dropped — a value the catalogue disagrees with is a mistake to be shown, not junk to clear
away — and an unknown *tag* is left alone, because a whole widget is somebody's work and the validator explains
it instead.

**Verified:** six new tests in `designer-store.test.js` (including "dropping that property is what lets the
markup be written at all", which asserts the old file emits nothing and the loaded one emits again) plus a
wiring guard that reads the sources end to end; the live document put through the new load path reports the
drop, validates, and regenerates; the app's `cargo check` clean with the checkbox landing at exactly the canvas
rect.

## 134. The verdict arrives when the panel opens (2026-10-14)

**Asked for, verbatim:** *"Do the Still open issue, then update docs and git, lets close out cleanly for
today."* The still-open issue was the other half of §133: a property the catalogue no longer has is now dropped
on the way in, but a property whose **value** this version disagrees with (a box wider than its maximum, a
colour that is not a colour) cannot be dropped — it is the user's mistake to correct. It still made the design
invalid, so it still stopped the markup being written, and the panel said nothing until the first edit.

**The verdict is now taken at open.** `show()` renders the design once before the panel is created, writes the
whole verdict to the output channel, and sends it to the panel, which lists it under the properties as it opens:
what the load had to tidy up, then everything that is wrong with the design. A user who is told nothing has no
reason to touch the canvas and discover that their board is compiling an older design than their screen.

**The footer is one clipped line**, which is what moved the load notes out of it: `.footer` is
`white-space: nowrap; overflow: hidden; text-overflow: ellipsis`, so a note appended to it can vanish exactly
when it matters — and the load that dropped a property is the one whose board was out of step. Those notes now
have their own list (`.load-notes`) above the problems, drawn once when the panel opens and deliberately *not*
cleared by the next save, because "this file was cleaned up when you opened it" is not news an edit can replace.

**And a problem that has been fixed no longer stays on screen.** The old `report()` only *added* the list, so the
first problem of a session stayed there for the rest of it. `showVerdict` rebuilds both lists on every verdict,
which is possible now that they are drawn in one place.

**Verified:** a new test drives the real bundle with a stub DOM through `init` (a dropped property *and* a
problem) and then a clean `report`, asserting the footer, both lists, that the problem list goes when the
problems do, and that the load's note stays. **Suite:** t1-logic 838, t2-cli 55, t3-golden 4 — **897 checks, 0
failed**, all three layers run again over the final tree.

## 135. Closing the day out: what running the other layers would have caught earlier (2026-10-14)

The day's work was five versions (0.0.89 → 0.0.94) and, for most of it, I had been verifying with the layer that
was nearest to hand: `--layer t1-logic`, `--file designer`, the crate's own tests. Closing out meant running
t2 and t3 as well, and both had something to say.

**t2-cli caught a regression I had shipped.** 0.0.93's panel read `message.loadNotes.length` directly, and the
webview tests build their `init` messages by hand — thirty-two of them failed with *"Cannot read properties of
undefined"*. The installed 0.0.93 was not broken in practice, because the extension always sends the field, but
the panel is the side that has to survive its absence: the two new fields are extras on top of the document,
like `loadError`, and are now typed and read as optional.

**t3-golden caught drift from 0.0.91.** The generated `ui.rs` gained `gui()`/`gui_mut()` and the two recorded
snapshots (`lilygo-tqt`, `sunton-3248s035r`) were never re-recorded, so the golden layer had been failing since
that change. Regenerated with `UPDATE_SNAPSHOTS=1 node tests/runner.js --layer t3-golden`, which changed exactly
the two lines of documentation the accessors added.

**The lesson is the cheap one:** a targeted run is the right tool while working, but a close-out has to touch
every layer, because some layers only ever see the seams (t2 sees the bundle's real behaviour, t3 sees generated
files) and neither is exercised by a `--file designer` run.

**Released as v0.0.94** — 0.0.89 through 0.0.94 went out together, since 0.0.90, 0.0.91, 0.0.92 and 0.0.93 were
development numbers that were never published on their own. Packaged with `vsce`, installed, and the four
shipped build files verified byte-identical to the local build (`cmp`), which is the check that catches a stale
`out/` — the trap from §129.

## 136. The sketch layout: a generated project is two files (2026-10-16)

Two requests, and the second one reshaped every generated project.

**The sidebar's Open Designer row appears only in a Designer project.** Asked for in as many words: *"the
'OpenDesigner' row in the Rusty Platform side bar should only appear when a WYSIWYG template project."* The
marker is the designer's own document, `designer/panel.ui.json`: the wizard writes it for the `designer` template
and for nothing else, and it is the file the canvas reads back. So `readProjectAt` reports `designer`
(`src/project/activeProject.ts`, using `DESIGNER_DOCUMENT_PATH` from `designer/model.ts` rather than repeating
the string), `RustyState` exposes it, and `visibleControls(sessionRunning, family, designerProject)` includes
`OPEN_DESIGNER_CONTROL` only when it is true. The command stays in the Command Palette, which matters: a designer
can be started in a project that has no design yet. The **Project view's title-bar icon was gated too** (the user
said yes when asked) — through `rustyPlatform.designerProject`, published with `setContext` from
`state.onDidChange`, because a `view/title` entry can only read a context key.

**The Arduino shape.** The request: *"The main.rs file should consist of only the Setup() and Main() functions
with all the 'use' (include) imports in a sepperate file named 'MainHeader.rs'. The Setup() function should
initiate all peripheral hardware and instantiate all classes and the Main() function should be where all
implementation code resides."* With the user's own hand-reformatted project as the model (`InspectAllTemplate`,
the CYD `board` template), which is why the generated `State`, the `HalSpi`/`HalBus`/`PanelDevice` aliases, the
`StaticCell`s and the header's helper functions look the way they do.

What came out of it, in `src/generate/sketch.ts` — the whole mechanism, so that each template body could stay
readable as one piece of Rust:

- `sketchFiles(parts)` assembles both files: banner, crate attributes, side-effect imports,
  `#[path = "MainHeader.rs"] mod main_header; use main_header::*;`, modules, statics, `State`, `setup()`,
  `main()`. It is the single place that decides LF, one trailing newline and no runs of blank lines — the golden
  layer is byte-for-byte, so that tidying is part of the contract rather than cosmetics.
- **`#[path]` is what keeps the capitalised file name.** `mod MainHeader;` would warn about the module name;
  `#[path = "MainHeader.rs"] mod main_header;` does not, and the file keeps the name the sketch reads as.
- A body marks its own material with `//@header` … `//@header-end`; `hoistHeader` lifts those regions into the
  header, dedents them by the four spaces they had inside a function, and makes every item public. That last part
  is not decoration: **the header is a child module, so `use main_header::*;` cannot see anything private** —
  struct *fields* included (the display template's `DiagnosticLayout` was the one that proved it), and a
  `macro_rules!` needs a `pub(crate) use` before a `use` can reach it at all. An inherent `impl`'s methods get
  theirs; a *trait* impl's must not (E0449).
- A body marks where its `loop {` was with `//@loop` and where that loop's brace was with `//@end`;
  `splitAtLoop` hands back `setup()`'s half and the loop's half.
- `againstState(text, fields)` rewrites the loop's bare locals to `state.<field>`. It is a small tokenizer, not a
  regex: comments, string literals and character literals are copied through untouched (a log message that says
  "corner" is text), a name already reached through something else (`info.ssid`, `layout.width`) is left alone,
  and so is a `let` binding that shadows a field on purpose. **The neighbour check is per LINE** — reading the
  whole preceding text made `ticks = …` after a comment ending in a full stop look like `info.ssid`, which left
  exactly two statements unprefixed and was caught by `cargo check`, not by reading.
- `immutableLocals` strips the `mut` from a field's local unless the field says `mutableInSetup`: `setup()` builds
  a local and moves it into the struct, so `let mut` on it is an `unused_mut` warning in a project the user has
  just created — and a generated project that warns on its first build reads as broken. The exceptions are
  declared, not guessed: a `RefCellDevice` read for the idle baseline, a `FlashStorage` the calibration is loaded
  from, a Wi-Fi controller told to connect.

Three traps cost real time and are worth naming:

1. **No backticks in a Rust template literal.** One comment in `espTouchBody` — "the controller's own clock is
   `touch_clock()` in MainHeader.rs" — terminated the string, and the symptom was a syntax error hundreds of
   lines away (the same trap as §63's chat view, this time in a *Rust* body).
2. **The buffer and the shared bus have to be `static`.** A panel's `Display` is borrowed by the interface, and
   the interface is part of the `State` that `setup()` hands back — a local `[u8; 512]` cannot outlive it. So
   panel projects got `BUFFER_CELL`/`BUS_CELL` (`StaticCell`) and, with them, `static_cell` as a dependency;
   `panel_clock()`/`touch_clock()` became header *functions* at the same time, because a closure's type cannot be
   written into a struct field. `ExclusiveDevice` takes no lifetime parameter while `RefCellDevice<'a, …>` does —
   that one showed up as `struct takes 0 lifetime arguments`.
3. **The Wi-Fi credentials moved, and the prompt had to follow.** `isWirelessFirmware` keyed off `main.rs` alone;
   the four `WIFI_*` constants are in the header now, so reading one file would have decided that every wireless
   project is a wired one and quietly stopped offering the credentials prompt. `wifiPrompt.ts` reads the whole
   sketch (`readFirmwareSource`) and tolerates a project with no header, which is what an older generated project
   looks like.

**Verified by compiling, not by reading.** Every ESP template on three boards with the Xtensa toolchain
(`cargo check`, the two `designer` variants with the vendored crates copied into `codegen/` the way the wizard
does it) and every Pico template with `cargo build` — **no errors and no warnings from generated code**, which is
what the `unused_mut`/`let _state`/`#[allow(dead_code)]` details above are for. The hermetic suite was run as its
three layers (t1 839, t2 55, t3 4, all green) and the golden snapshots re-recorded: 25 new `MainHeader.rs` files
and 31 refreshed `main.rs`.

**Then the question came straight back** — *"where do I add my own functions, in main.rs after the main()
function, or in the mainheader.rs file?"* — and the answer went into **both generated files** rather than only
into the reply, because it is the one thing the two-file shape makes a reader wonder about. `main.rs` now ends
with a `// --- Your own code goes below this line ---` block: your functions belong below `main()` (Rust does not
mind about the order of items, so the top of the file keeps the shape of the sketch), a function that needs the
hardware takes `state` or one of its fields, anything that does *not* touch it reads better in `MainHeader.rs`,
and a driver that outgrows a couple of functions belongs in `src/my_driver.rs` with a `mod` line. The header ends
with the matching note — including the visibility rule that bites first: `main.rs` reaches the header through a
glob import, and a glob import only brings in items visible to *it*, so a helper written there without `pub`
cannot be called from `main.rs` at all.

Both blocks carry a **commented-out example**, and the example is chosen from `State` itself: `led` first, then a
`led_*` channel, then the channels of a tri-colour LED, then any output — with the Pico W's LED (a GPIO on the
wireless chip rather than an `Output`) getting the `gpio_set` form, and a board with nothing to blink (a panel
project, the heartbeat ones) getting one that names no peripheral at all. The keep-alive exclusion is not
theoretical: the first version offered `state.backlight` to a CYD panel project as the thing to blink, which is
exactly the sort of example that teaches the wrong lesson in the first file someone reads. The guard is a `t1`
test that walks every board × template (`project-files.test.js`): the example must take `state`, the header's
must be `pub`, and no example may ever name a keep-alive pin. Suite after it: **t1 839 → 840, full hermetic run
899 checks, `--e2e` 910, all green.**

## 137. The extension asks when it loads (2026-10-16)

Asked for in as many words: *"The extension must prompt for any missing requirements when it loads."* Until now it
waited to be asked. The health check was all there — a status-bar row, a sidebar row, `Check Toolchain` — but a
window could open with no `cargo`, no `probe-rs`, or an ESP project and no Xtensa toolchain, and the extension
said nothing at all: the row sat there reading "setup needed", which only helps someone who already knows to look.

The decision of *what* to ask is pure (`src/toolchain/requirements.ts`), for the same reason `healthReport` is: the
`t1` layer can pin what is asked, what is deliberately not asked, and what a dismissal remembers. Three rules,
each one a way the prompt could have been annoying:

1. **The prompt *is* the health report** — not a second list of requirements. So it inherits the family rules
   learned the hard way on 2026-10-05: an ESP project is never nagged about a probe it can never use, and a Pico
   project is never nagged about Xtensa. Nothing about a probe is actionable anyway (it is hardware) and the
   report offers no action for it, so that case stays quiet — the health row still says it, and the log does.
2. **Nothing is asked before detection has finished.** "The toolchain has not been detected yet" is a transient
   state, not a missing requirement; a modal about it would be a modal on every single load.
3. **"Don't show again" remembers a *set* of problems, not the act of prompting.** The signature is the sorted
   problem list, so dismissing "no cargo" does not silence "ESP toolchain missing" tomorrow, while the same
   unchanged set never comes back — in this window or any later one (`globalState`). Inside a window there is also
   a per-signature "already announced" guard: a folder change re-derives the same answer, and saying it twice in
   one session is how a helpful prompt becomes a nag.

It hangs off `RustyState.onDidChange` rather than running once at activation, and that is the point: a window can
open with no project at all, and the family that decides the requirements only becomes known when one is opened.
Opening the CYD project in a window that had been sitting on a Pico one is exactly when "the Xtensa toolchain is
missing" becomes true — and exactly when the user should hear it, rather than at the next reload.
`rustyPlatform.promptMissingRequirements` (on by default) turns the whole thing off.

**One list for the fixes, because there are now two doors onto them.** The `Check Toolchain` modal used to spell
the label→command mapping out itself; that moved to `HEALTH_ACTION_LABELS`/`HEALTH_ACTION_COMMANDS` in
`health.ts`, so both doors run the same command for the same button. One `t1` test holds every command against
`package.json` — a fix whose command is not declared is a button that does nothing — and another reads the sources
to assert no second copy of the labels has reappeared.

Suite: **908 hermetic checks, green** (nine of them new, in `tests/layers/t1-logic/requirements.test.js`). The
Arduino family inherits the rule: `HealthFamily` gains `'arduino'`, and "PlatformIO Core is not installed" /
"the `espressif32` platform is not installed" become problems with install actions in the same report — no new
mechanism, see `plans/arduino-cpp-family.md`.

## 138. The Arduino C++ family, phase 1: setup() and loop() on the same boards (2026-10-16)

Asked as a question first — *"Is it possible to make an Arduino C++ version of this extension?"* — and then
decided in four answers: a **third family inside this extension**, phase 1 being **wizard + build + flash +
monitor** on the PlatformIO core, **both board families from the start**, and uploads/debug sessions on a Pico
through **the RP Debug Probe** while the ESP32 boards keep USB. Then: *"I don't see the Arduino option"* — true,
because until today there was a plan and nothing else. This is what landed, and what the machine taught on the
way.

### The shape: the same boards, a second builder

`src/boards/arduino.ts` is the whole idea in one file. An Arduino board **holds** the Rust catalogue's profile
(`rust: RpBoardProfile | EspBoardProfile`) and adds only what PlatformIO needs to know: which core compiles it
(`earlephilhower` or Espressif's), PlatformIO's own board id and platform, and how the image reaches the chip.
Nothing about pins, panels, SD sockets or LEDs is restated, so there is no second place for a pin number to be
wrong — and `arduinoBoardById('pico2w').rust` *is* the same object the Rust generator is reading. A `t1` test
asserts that by identity, because a copy that happens to match today is exactly the drift the design exists to
prevent.

`src/generate/arduino.ts` is then small: `platformio.ini`, `include/board_config.h`, `src/main.cpp`,
`.vscode/settings.json`, `.gitignore`, `README.md`. The sketch is `setup()` and `loop()` and nothing else, and it
ends with the same **"your own code goes below this line"** block the Rust sketches end with — the question *"where
do I put my function"* is the same question in either language, so it gets the same answer, with a commented
example.

`include/board_config.h` is deliberately the `MainHeader.rs` of this route: the board's own facts in one place,
included by the sketch and by anything of the user's that needs a pin, with the same guidance about where
constants, helpers and drivers belong.

### Two things a real build found, that reading the code would not have

The first generated sketch did not compile, twice, in ways worth writing down.

1. **`#define BOARD_NAME` collides with the Arduino core.** arduino-pico defines `BOARD_NAME` itself for the board
   variant, so the generated header produced `warning: "BOARD_NAME" redefined`. Not fatal — but it is the kind of
   warning that appears in every build of every project and trains the user to ignore warnings.
2. **`#define BOARD_LED PIN_25` is not a pin.** The Raspberry Pi profiles spell pins the way **embassy** does:
   `PIN_25` is a Rust type alias, not a constant a C++ core has ever heard of. The build said so in as many
   words — `error: 'PIN_25' was not declared in this scope`.

So the board facts are `constexpr` constants inside a **`namespace board`**, and the pins are GPIO numbers with
the Rust spelling kept in a comment (`embassy's PIN_25`). A namespace member cannot collide with a core macro,
which closes the whole class of problem rather than the two cases found so far; a test now asserts that no
generated header contains a `#define BOARD_` at all. The example in the sketch reads `pinMode(board::LED, OUTPUT)`
and works unchanged on a Pico and a Pico W, because the core's own `LED_BUILTIN` is what the constant holds.

**Verified by actually building, not by reading**: `pio run` succeeds for **all four Raspberry Pi boards × both
templates** with the real PlatformIO 6.2.0 and the `earlephilhower` core, with **no warnings**, at 2.8 % flash
(Pico, blinky) to 7.5 % (Pico 2 W). The ESP32 half is generated but **not built** — the `espressif32` platform is
not installed here and pulling it is a few hundred megabytes, so its board ids (`esp32dev`,
`esp32-s3-devkitc-1`) are the documented ones and the RP ids (`rpipico`, `rpipico2`, `rpipicow`, `rpipico2w`) are
the verified ones (`pio boards raspberrypi`, and the same four the platform's own `boards/*.json` carry).

### PlatformIO is where the probe-rs trap was

Core 6.2.0 exists on this machine **only** at `~/.platformio/penv/bin/pio` — inside the PlatformIO IDE
extension's own virtualenv, and on no `PATH` anywhere. This is the probe-rs lesson again (2026-10-03, `~/.cargo/bin`
and the extension that would not see it), so `pioExecutableCandidates` puts that venv path *first* and PATH after
it, and `rustyPlatform.pioPath` overrides both. Measured: `platforms/` holds a plain `raspberrypi/` directory with
the version inside its `platform.json`; older Core named them `name@version`, so `parsePlatformDirs` accepts both
and the version is read from the JSON when the name does not carry it.

A missing platform is not an error — PlatformIO downloads what a project asks for on the first build — but it *is*
the difference between a build that starts and one that waits for a few hundred megabytes, so it is reported as a
problem with a **Download Platform…** button rather than silently endured.

### One report, one prompt, two families

`HealthFamily` gained `'arduino'`, and the Arduino branch of `healthReport` is deliberately **first**, before the
cargo checks: an Arduino project is built by PlatformIO and must never be told that cargo, rustup, the Xtensa
toolchain or probe-rs are missing. What it *is* told about is PlatformIO itself and the platform it asks for —
and about the debug probe **on a board that uploads through it**, because on a Pico the probe *is* the upload
route (PlatformIO drives its own OpenOCD over CMSIS-DAP), while an ESP32 has no SWD and no probe on its path. That
gate is `arduino.usesProbe`, set from the board profile's `uploadProtocol`, so the health rules never have to know
about chips.

The load-time prompt (0.0.99) needed **no new mechanism** for any of this: it reads the health report, so
*Install PlatformIO…* and *Download Platform…* appeared as buttons the moment the verdict named them. One `t1`
test pins that every action the prompt can offer is a declared command with a label — the count in that test went
from four to six, deliberately.

### The controls: words are not enough for this family

For ESP the wording changes and the command stays. For Arduino the **commands** change, because nothing here is
built by cargo: `rustyPlatform.arduinoBuild` / `arduinoUpload` / `arduinoMonitor` / `arduinoClean`, each one `pio`
line in a visible terminal. A command id is documented in `package.json` and shown in the palette with its own
tooltip, so a `rustyPlatform.buildDebug` that quietly ran PlatformIO would make the palette say something untrue
about itself. Four small commands are cheaper than one clever one.

The rows that are statements about cargo — the two build profiles, the profile-override flashes, the `.deb`
packaging pair, the probe-rs session stop — are **dropped** for this family rather than re-worded, because their
only possible outcome would be a warning. `Back Up Project` stays: it copies any folder. `rustyPlatform.debug`
says what is true instead of starting a probe-rs session against a project with no `Cargo.toml`: PlatformIO drives
the probe on this route, and the ini is already configured for it (`debug_tool = cmsis-dap`).

**A launch configuration over the probe — breakpoints from inside this extension — is phase 1b**, together with
the panel drivers for the CYD and the T-QT (TFT_eSPI configuration is a real project of its own) and the AI assist
for C++. `plans/arduino-cpp-family.md` is where that is written down.

### The suite

**950 hermetic checks, green** (t1 889 · t2 55 · t3 6), up from 908. New: `t1-logic/arduino.test.js` (40 checks —
the board table by identity, the upload route per family, both templates, the `platformio.ini` parse, the
generated file set, the no-`undefined`-leak sweep across every board × template, one panel per board where the
vendor sold two, the serial-log template on a board with no LED, the whole `pio` module including a detection run
against a fake PlatformIO home, the Arduino verdict with and without a probe, and the wording/filtering rules),
plus **84 new golden snapshots** under `__snapshots__/arduino/<board>/<template>/`, so a change to a generated
Arduino project shows up as a diff. The wiring guards read the sources: the wizard asks the language **before**
the board, the six commands are registered, and `withProject` skips the cargo/rustup/probe-rs install plan for an
Arduino project.

Version **0.1.0** rather than another `0.0.x`: this is the second language the extension can generate, not another
template in the first one.

## 139. Debugging an Arduino project without writing a launch.json (0.1.1, 2026-10-16)

The user's requirement when this family was decided was one sentence with two halves: *"I want to use the RP Debug
Probe for uploading and debugging (OpenOCD) for the pico boards."* Uploading is ours — `pio run -t upload` with
`upload_protocol = cmsis-dap` in the generated ini — and 0.1.0 shipped it. Debugging was left as "say what to do
by hand", and this is the step that closed it.

**The obvious implementation is a `.vscode/launch.json` of our own, and it is the wrong one.** PlatformIO's
debugger is contributed by the PlatformIO IDE extension as the debug type `platformio-debug`, whose `launch`
configuration has two **required** properties: `executable` (the firmware) and `toolchainBinDir`. Both are
machine-specific, and neither can be known when the project is written: the toolchain package is *downloaded by
the first build*, so on a fresh machine `~/.platformio/packages/toolchain-rp2040-earlephilhower/` does not exist
yet. A generated `launch.json` would therefore be a broken file that looks authoritative — and the second half of
the problem is that PlatformIO fills both values in from the project's environment **each time its Debug action
runs**, which is to say it already solves this properly and we would be duplicating it badly.

So the button is handed over: `rustyPlatform.debug` on an Arduino project runs the PlatformIO IDE's own
`platformio-ide.startDebugging` command. That is the real OpenOCD + GDB session over the probe, with breakpoints,
using the `debug_tool = cmsis-dap` the ini already carries. Verified where it can be: the installed
`platformio.platformio-ide` 3.3.4 manifest declares exactly that command (and the `platformio-debug` debugger
type), and a `t1` test reads that manifest and asserts both. On a machine without the extension the test *skips*
rather than passing-vacuously, and the command says what to do instead (`pio debug` in a terminal).

Two prerequisites are checked before anything is started, because both are knowable and both are kinder said out
loud than discovered inside a debugger: **no PlatformIO IDE** (the message names it and gives the CLI route) and
**nothing built yet** — PlatformIO's debugger loads the firmware it is about to debug, so
`.pio/build/<env>/firmware.elf` has to exist first. The wording and the reason live in `toolchain/pioDebug.ts`,
pure, so `t1` can hold the sentences; the host side (is the extension installed, run the command) stays in
`commands/arduinoCommands.ts`. A third sentence covers the case where PlatformIO is present and simply did not
start — telling that user to install the extension they already have would be worse than saying nothing.

**Two test layers arrived with it, and the first one immediately paid for itself.**

- `t2-cli/pio-detect.test.js` drives detection with a fake `pio` inside a fake `~/.platformio`, with real child
  processes — the hermetic way to pin the ordering rule that makes Core visible at all (the IDE's venv first,
  `PATH` after; the `probe-rs` trap of 2026-10-03). Its first run **found a real bug**: `platforms/` was read as a
  list of names, so a stray `README.md` somebody dropped there was counted as an installed platform — and
  "installed" is what suppresses the download prompt, so the first build would have failed with PlatformIO's own
  message instead of ours. The directory is now read for *directories*.
- `t4-e2e/arduino-build.test.js` (`--e2e`) really runs `pio run` on six generated projects — four Pico boards,
  both templates — and checks two things a bare exit code hides: the **UF2 exists** (the artefact the probe
  writes; a build without one is not flashable) and **nothing warned about `src/main.cpp` or
  `include/board_config.h`**, which is the check that would have caught the first, broken header. A board whose
  platform is not installed is *skipped with the reason*, never downloaded: an `espressif32` fetch is a few
  hundred megabytes, and a suite that quietly spends them is one people stop running. A last case fails when a
  board has an installed platform but no entry in the build matrix — so when `espressif32` does arrive, the
  omission is visible rather than silent.

Suite: **962 hermetic checks, green** (t1 892 · t2 64 · t3 6), plus the 6 opt-in PlatformIO builds in ~19 s.

## 140. Installing what the projects ask for, and the three bugs that fell out (0.1.2, 2026-10-16)

The request was one line — *"install everything required. I want to test the full product"* — and the useful part
turned out not to be the installing. Everything this family had verified up to here was verified against **what
this machine already had**: an RP2040 platform installed by hand from git, and no `espressif32` at all. Installing
the platforms *the generated projects name*, and then building against them, found three bugs in shipped code.

**1. `platform = raspberrypi@1.20.0` is the wrong platform for a Pico, and it is what 0.1.0 and 0.1.1 generated.**
The registry's `raspberrypi` platform is the **mbed** one: installing 1.20.0 into an empty core directory gives a
platform whose only RP2040 board is `pico` (framework = ArduinoCore-mbed) and whose `boards/` holds two files. It
has no `rpipico2`, no `rpipicow`, no `rpipico2w`. Reproduced exactly, in a project the extension generated:

```
Processing pico2w (platform: raspberrypi@1.20.0; board: rpipico2w; framework: arduino)
UnknownBoard: Unknown board ID 'rpipico2w'
```

It worked *here* for one reason: this machine already had maxgerhardt's **platform-raspberrypi** — the
arduino-pico platform — installed from git under the same name, and a git platform satisfies the version
requirement `1.20.0` because that is the upstream number the fork tracks. So the generated file was correct only
on the machine that generated it, which is the worst kind of correct. The fix is the URL the arduino-pico
documentation itself uses:

```ini
platform = https://github.com/maxgerhardt/platform-raspberrypi.git
```

with the verified commit (`aa70b802be8851668053d4f09734e4089fe41932`, a shallow `develop` clone) in a comment and a
one-line note on how to pin it — because a git platform *cannot* be pinned by version (the fork's own tags are
`v1.4.0-gcc14-arduinopico460` and friends, nothing to do with 1.20.0), and a pin nobody can move is a pin nobody
can keep current. Verified in a clean core: the URL resolves, PlatformIO installs it as
`platforms/raspberrypi@src-ff76a391…` beside the registry one rather than over it, and all four Pico board JSONs
are there. `PIO_PLATFORM_VERSIONS` now holds only `espressif32`, and a `t1` test asserts that **no** generated ini
ever says `platform = raspberrypi`.

**2. An ESP32 board's flash size was being inherited from the wrong module.** `pio boards espressif32` says
`esp32-s3-devkitc-1` is an **8 MB** board. LilyGo's T-QT is 4 MB. The generated ini had no opinion, so the
partition table would be sized for flash that is not there — the kind of fault that shows up as a board that
uploads happily and then does not run. The ini now states the module's size from the same board data the Rust
generator reads:

```ini
board_build.flash_size = 4MB
```

only for the ESP boards: the RP platform's board JSONs already match their chips, and a second, contradictory
answer is worse than no override.

**3. Two of our boards cannot be told apart from a `platformio.ini`.** PlatformIO board ids are shared — the CYD
and the ESP32-DevKitC are **both** `esp32dev` — so `arduinoBoardForPioBoard('esp32dev')` can only ever be a
first match (it returns the DevKitC). A test caught this by demanding a round trip; the honest fix was not to
loosen the test but to make the file say what it means:

```ini
custom_rusty_board = sunton-3248s035r
```

`custom_*` keys are PlatformIO's own idiom for user data and are ignored by its build; the extension reads this
one first and falls back to the board id for a project somebody else wrote. Without it, opening a CYD Arduino
project made the health row report a DevKitC.

**The ESP32 half builds now, which it never had.** `espressif32@6.9.0` is installed (Xtensa toolchain for the
classic ESP32, esptool) and the e2e matrix grew from six projects to **ten**: the four Pico boards (both
templates) plus the DevKitC (both templates), the T-QT and the CYD — about 30 s once the cores are cached, every
one checked for its artefact and for warnings in the generated sources. Two small facts came out of that too:

- **A UF2 is not universal.** The RP2040 core emits `firmware.uf2` (what a Pico in BOOTSEL mode takes, and what
  picotool converts for the probe); an ESP32 build emits `firmware.bin` and no UF2 at all. The check asserted a
  UF2 for every board and reported four passes as failures — the artefact is now chosen by the platform, and both
  are checked for the ELF a debugger loads.
- The T-QT's build pulled `toolchain-xtensa-esp32s3` on its first run, and the CYD's flashed nothing, which is the
  point: **nothing here programs a board**. Flashing stays the user's step.

**One mishap worth recording**, because it is a tool trap rather than a product one: `export
PLATFORMIO_CORE_DIR=/tmp/pio-clean` (used to test the mbed platform in isolation) **persisted in the shell**, so
the next `pio pkg install -g --platform espressif32@6.9.0` — the big download — landed in the scratch core
instead of `~/.platformio`. Recovered by moving `platforms/espressif32`, `packages/toolchain-xtensa-esp32` and
`packages/tool-esptoolpy` into the real core (`pio pkg list -g` confirms `espressif32 @ 6.9.0`), and the scratch
core was deleted. **Unset an exported `PLATFORMIO_CORE_DIR` in the same command that sets it.**

Suite: **965 hermetic checks, green** (t1 895 · t2 64 · t3 6), plus the 10 opt-in real PlatformIO builds.

## 141. The Arduino "everything" test, and the panel support it needed (0.1.3, 2026-10-16)

Asked for in one line: *"create a template for Arduino and esp32-035 equivalent to the Board Test Everything
option for Rust"*. The Rust family has had `board` — *Board test (everything)* — since the CYD arrived: the panel
with its diagnostic screen, touch with calibration, the RGB LED as a status light, the light sensor in the log,
a beep per recorded corner, and the card socket. The Arduino family had `blinky` and `serial-log`, which is to
say no panel support at all: 1b had been left as "the glass", and this is that half of it — minus the part that
only hardware can prove.

**Equivalent means the same screen, because the screen is the test.** The Rust template draws a frame, four
coloured corners, five named bars, `Hello Grumpy!`, a status line, a blinking square and a crosshair under the
finger — each answering a question a build cannot: is the drawing area the whole panel, is the image mirrored or
rotated, is the colour order right, is a channel dead, does touch map to the glass. The Arduino template draws
the same things, and takes the geometry from **the same solver**: `espDiagnosticLayout` is now imported by
`generate/arduino.ts`, so one implementation decides where everything fits on a given panel — a 3.5" CYD and a
0.85" T-QT lay out correctly, and a future panel board needs no new maths. The one translation is the font:
mipidsi's `FONT_6X10`/`FONT_10X20` become LovyanGFX text size 1/2.

**LovyanGFX rather than TFT_eSPI**, and the reason is the house rule about library code. TFT_eSPI — the usual
pick for a CYD, with a whole ecosystem of `User_Setup.h` files — is configured by **editing a file inside the
library**; the next `pio pkg update` replaces it, and "never change library code without asking" is rule two
here. Its supported alternative is twenty `-D` flags in `build_flags`. LovyanGFX is configured by subclassing a
device in a header **of the project's own**, which is what the generated `include/panel.h` is, and it drives the
panel *and* the XPT2046 in one object rather than needing a second library for the touch.

**Three files, three jobs**, matching the shape the Rust projects already have: `include/board_config.h` is what
the board *is* (pins, the panel's geometry and clock, the touch pins, `PANEL_BACKLIGHT_ACTIVE_LOW`),
`include/panel.h` is how to *talk* to it (one `BoardDisplay : lgfx::LGFX_Device` with the bus, the panel, the
touch and a PWM backlight), and `src/main.cpp` is what to *do* with it. `lib_deps` gains the library for this
template only: `blinky` and `serial-log` still pull in nothing but the core, which is the difference between a
hello-world project and a megabyte of fonts.

**The two facts a datasheet cannot settle are marked, not guessed.** Whether the panel wants its colours swapped
and whether the image is mirrored are properties of the module in the user's hand, so `panel.h` says which line
to change and why (`cfg.rgb_order`, set from the catalogue's `colorOrder: 'bgr'`; the panel reset, `-1` where it
is tied to the board reset). The Rust template carries the same two knobs in the catalogue for the same reason.
Everything else in the file comes from the board's data — including `cfg.spi_host`, which is HSPI because the
CYD's panel *is* wired to 12/13/14/15, the second peripheral's native pins, leaving the first free for the card
socket that sits on 18/19/23.

**Two compile errors found the scaffolding**, both from writing C++ in a TypeScript string: `spi_host_device_t`
is an enum, not an `int` (so `constexpr int kPanelHost` did not convert), and the RGB status-light block emitted
`digitalWrite(board::LED);` — one argument — for the touch case. Both were caught by building the generated
project, which is the whole argument for the e2e layer; the second build was `SUCCESS` in 4.9 s.

**What is verified and what is not.** Verified: the project builds warning-free for real (it is the eleventh
entry in the e2e matrix, `pio run`, 308 KB of text, and the generated README's claims are all in the emitted
code — the test asserts each one). **Not** verified: what the glass shows. Colour order, mirroring and touch
mapping are for the user's eyes, which is exactly why the screen is drawn the way it is — a frame, four
asymmetric corners and named bars turn "something is off" into "the image is mirrored", which is a one-line fix
in a file the project owns.

Suite: **970 hermetic checks, green** (t1 900 · t2 64 · t3 6, with 91 Arduino snapshots), plus the 11 opt-in real
PlatformIO builds in ~39 s.

## 142. The LCD rotation, on the Arduino side (0.1.4, 2026-10-16)

Asked for as *"add the LCD rotation options, which is now not available in Arduino for the ESP32-025 board"* (their
name for the CYD, `sunton-3248s035r` here). The Rust family has had the rotation since 0.0.8x; the Arduino half was
generated without it, so a project built in portrait stayed portrait however the panel was mounted.

**The question the Rust flow answers is the same one, and it is answered the same way.** The wizard asks *how is the
panel mounted?* with the four values spelled out ("No rotation (default)", "90° clockwise", …) rather than 0–3,
because the number is what the firmware reads and not what a person thinks in. It is asked only where the answer
could end up in the project: the board has a panel LovyanGFX can drive **and** the chosen template drives it —
`arduinoHasPanel(board) && templateUsesPanel(template)`, the same pair the generator gates on, so the prompt and the
emitted file cannot disagree about whether the question is relevant.

**Where it lives is the interesting part, and it is not the sketch.** `src/main.cpp` is generated once and then
belongs to the user, so a rotation written there could never change without losing their code to a regeneration —
exactly the argument that put the Rust value into `.cargo/esp-config.toml` instead of `src/main.rs`. An Arduino
project has no `.cargo`, so the carrier is the file PlatformIO already reads: `platformio.ini` gains
`-DRUSTY_LCD_ROTATION=<n>` in `build_flags`, `include/board_config.h` turns it into
`constexpr int LCD_ROTATION = RUSTY_LCD_ROTATION;` inside a `#ifndef` that falls back to 0, and the sketch calls
`display.setRotation(board::LCD_ROTATION)`. A build started from a plain terminal behaves exactly like one started
here, which is the whole point of putting it in the build rather than in the extension.

**The header holds the fallback, never the choice.** Writing `#define RUSTY_LCD_ROTATION 1` into `board_config.h`
would compile the choice in, and then turning `rustyPlatform.lcdRotation` and rebuilding would do nothing at all —
with the panel as the only evidence, and none of it saying why. The guard is there for the one case it is for: a
project whose author deleted the flag line still builds, and builds the way a panel does when it is not told.

**One gate decides three places.** The ini flag, the header constant and the `rustyPlatform.lcdRotation` entry in
`.vscode/settings.json` all appear together or not at all — the board has a panel *and* the template drives it. A
CYD project running `blinky` draws nothing and so carries none of the three; a Pico carries none either, for the
board's own reason. The opposite arrangement (a handle to a panel the project never drives) is what the Rust
generator avoided first, and a project that draws nothing must not gain a line nothing reads.

**The screen is drawn for the panel as it is turned.** `espDiagnosticLayout` — the solver the Rust templates already
use — takes the size the project will actually address, and a quarter turn swaps the panel's sides: the CYD's glass
is 320x480, so a project at 90° or 270° lays out 480x320, and one at 180° lays out exactly what 0° does, because
half a turn changes which way up the picture is and not its shape. That last case is in the tests deliberately: a
test that only asserted "the numbers moved" would pass while the layout was solved for the wrong size.

**The setting is the handle afterwards, and now it reaches both families.** `registerLcdRotationSync` writes
`.cargo/esp-config.toml` for a Rust project and `platformio.ini` for an Arduino one, and says *rebuild to apply it*.
Whether a PlatformIO project is one of ours is decided by asking whether its ini carries the flag **at all**
(`iniCarriesRotation`) rather than by looking the board up again: the flag's presence is precisely the mark of a
project the generator made to draw something, so the listener's rule and the generator's rule are the same rule. A
project made by hand in PlatformIO is not touched.

**What a build can and cannot prove.** A successful `pio run` proves the sketch compiles against `board::LCD_ROTATION`
— an undefined identifier is the failure mode there, and it is caught. It does **not** prove the flag reached the
compiler: a `build_flags` line PlatformIO does not understand is ignored in silence, the guard would hand the sketch
its 0 and the build would still say SUCCESS with a panel that never turned. So the e2e layer now asks PlatformIO
itself, with `pio run -t idedata` on the two entries that care: the turned CYD project must show
`RUSTY_LCD_ROTATION=1` in `defines`, and the CYD `blinky` project must show no rotation define at all. Twelve real
`pio run` builds now, ~56 s, still all SUCCESS.

One more sighting of an old trap while writing this: a **backtick inside a template literal** that emits C++
comments (`` `platformio.ini` `` in a generated comment) ended the literal and produced `TS1005` on a completely
unrelated line. Single-quoted `lines.push(...)` strings are safe — only template literals care.

Suite: **975 hermetic checks, green** (t1 905 · t2 64 · t3 6). The t3 refresh also re-recorded the **Rust** sketches,
and that was not this change: `src/generate/sketch.ts` (the two-file layout, §136) is uncommitted work whose
snapshots had never been re-recorded, so the Rust golden test was already red before the rotation was touched.

## 143. The WYSIWYG designer, on the Arduino side (0.1.5, 2026-10-16)

Asked for as *"Next please prepare the WYSIWYG template for the Arduino option"*, and answered in the shape the user
had already chosen for phase 1 when the canvas was discussed: **label and button only, done properly**. The Rust
designer has two things the Arduino family did not: a markup file a macro compiles, and a widget runtime on the
other end of it. Neither exists for C++, so both had to be written before there was anything to put on the canvas.

**A design is C++ now, in three files with two lifetimes.** `include/ui.h` and `src/ui.cpp` are generated on every
save; `src/ui_handlers.cpp` is the user's and is only ever appended to, exactly as `src/ui_handlers.rs` is on the
Rust side. `src/main.cpp` calls `ui::setup(display)` once and `ui::loop(display)` forever, which is the whole
contract between the sketch and the design. The two lifetimes are the point: a generated file can be rewritten
because nobody's work is in it, and the handler file can hold work because nothing rewrites it.

**The id is the first argument of every widget.** `rusty_gui::Button w_go("go", rusty_gui::Rect{90, 218, 140, 44},
"Press me")` — because `self.id()` in a handler is what makes a generated log line name the widget the *design*
called it. An id a user renames on the canvas then still reaches the handler, instead of a C++ variable name the
emitter invented and nobody can see.

**Three C++ facts the compiler had to teach, all of them found by the new e2e entry** (a generated designer project
built with the real PlatformIO — the same argument as §141, and it paid for itself three times in one afternoon):

1. **`Rect` was not an aggregate.** It has default member initialisers, which under **C++11** stops a struct being an
   aggregate — and the ESP32 core compiles sketches as `gnu++11`, so `rusty_gui::Rect{16, 8, 288, 26}` was "no
   matching function for call to `Rect::Rect`" there while it compiled happily under the RP core's C++17. The
   struct now has a `constexpr` four-argument constructor and a comment saying why it must not be "simplified" away.
2. **A chained call is a statement, not an initialiser.** `rusty_gui::Label w_title(…).textSize(1);` at file scope
   is not C++. The widgets are now declared plain and their looks are applied in `setup()`, which is also where a
   reader expects to find them.
3. **A stub appended to the end of a file cannot be inside a namespace that closed above it.** The handlers were
   first declared inside `namespace ui` and defined at global scope — `undefined reference to ui::on_go_clicked`,
   naming a function the user is looking at. They are free functions at global scope now: declared outside the
   namespace in `ui.h`, defined in `ui_handlers.cpp`, and called unqualified from `ui::setup`, which finds them.
   The header comment says all of that, because "why is this one not namespaced like the others" is a question
   somebody will ask.

**Two bugs the tests found, both of which would have been invisible on a first look.** A widget whose *only* event
was one the runtime does not raise (`longPressed`) was still wired to a handler the emitter never generated — a link
error waiting for the first design that had one. And `isUntouchedStub` counted the stub's own "replace this" comment
as a statement, so no stub was ever recognised as untouched and **pruning never removed anything**: a deleted
widget's handler would have stayed for ever, which is exactly the mess the pruning exists to prevent. Both are in
`tests/layers/t1-logic/designer-cpp.test.js` now.

**A button's colours are attributes, not style fields** — `bg`, `fg`, `pressed_bg`, `border_color`,
`corner_radius` — and the Rust side's shared resolver ignores them because the crate reads them as KDL attributes.
Reading only the `style` route drew every button in the runtime's default blue whatever the canvas showed, which is
the sort of thing the user would have found on the glass. `appearanceOf` reads both routes now, the design's own
attribute winning, and the pressed colour is the design's `pressed_bg` where it has one.

**What the runtime cannot draw is reported rather than substituted.** Phase 1 is a screen, a label and a button;
a design containing a gauge gets a line in the panel's problem list naming the widget and the reason, and the
emitter leaves it out of the file with a comment saying so. Emitting a gauge as a label would have been worse than
omitting it: the omission is what the canvas has already told the user, while a wrong picture is a new lie. The same
rule covers a declared font (the runtime has LovyanGFX's three text sizes and no BDF loader), a border width, and an
event the runtime does not raise.

**The family seam is `src/designer/family.ts`**, the same shape `display/rotationSync.ts` uses: one dispatcher that
reads the project and picks a side. It answers the two questions that are language-shaped — which files a design
becomes, and what a handler definition looks like in the code-behind — and it is also where the *board* gate lives,
per family: a Rust ESP project through its display list, an Arduino one through whether LovyanGFX has a driver class
for the panel. The T-QT is the board that separates them (it has a panel; `Panel_GC9107` is not in the library), and
`designerRefusal` says so in each family's own words. Two things had to change outside the designer for the Arduino
side to be real at all: `state.ts` hard-coded `designer: false` for PlatformIO projects, so the sidebar's Designer
row could never appear, and `activeProject.ts` did the same for the marker itself.

**Verified:** 13 real `pio run` builds in the e2e matrix, including a generated designer project with the vendored
runtime — SUCCESS, warning-free in our own sources (the warning check now watches `ui.cpp`, `ui.h` and
`ui_handlers.cpp` too, because those are files the extension wrote). Hermetic: **990 checks, green** (t1 920 · t2 64
· t3 6, with 102 Arduino snapshots).

**Not done, and known:** the Toolbox still offers every widget in the catalogue for an Arduino project, so the way
to learn that a gauge is not drawn is to drop one and read the problem list. The family is already in the panel's
init message (`family: 'arduino'`), so what is missing is the filter itself in `webview/designer/panels.ts` — it is
the next thing to do here. There is nothing else outstanding: labels and buttons place, move, size, colour, take
events, generate, flash and run.

## 144. The Arduino C++ family removed (0.2.0, 2026-10-17)

Asked for as *"I feel we are trying to re-invent the wheel. PlatformIO already has all the functionality for c++
development for our target boards (except for the designer feature). Please strip all platformio related (c++)
features from this extension. Keep the Arduino c++ main file structure we implemented for the Rust language."*
That is the whole reason, and it is right: 0.1.0–0.1.5 rebuilt project generation, build, upload, monitor and debug
for a toolchain that already has all four, better and for every board anyone makes. The one thing it had that
PlatformIO does not is the designer, and a designer whose output only one of the two routes could draw was becoming
two products in one extension.

**What went** (§138–§143 describe it, and those sections stay: a dev log records what happened, not only what
survived): `src/boards/arduino.ts` (the PlatformIO board table, `PIO_BOARDS`, `readPlatformioIni`),
`src/generate/arduino.ts` (the ini / `board_config.h` / `panel.h` / `main.cpp` emitters and the everything-test
sketch), `src/toolchain/pio.ts` + `pioDebug.ts`, `src/commands/arduinoCommands.ts` (the four `pio` commands, the two
installers, the PlatformIO IDE debug hand-off), `src/display/pioRotation.ts` and the Arduino branch of
`rotationSync.ts`, `src/designer/cpp.ts` + `family.ts` (the C++ emitter and the seam), `resources/rusty-gui` (the
`lib/rusty_gui` widget runtime), the six manifest commands and three `rustyPlatform.pio*` settings, and the tests:
`arduino.test.js`, `designer-cpp.test.js`, `pio-detect.test.js` + its shim, `arduino-build.test.js` (the e2e layer),
and the 102 Arduino golden snapshots. `plans/arduino-cpp-family.md` went too — the plan for a thing that is not
coming back.

**What stayed, deliberately.** The **sketch shape**: `src/main.rs` is `setup()` plus `main()` with the loop inside it,
and `src/MainHeader.rs` holds the imports, aliases, constants and helpers. Everywhere that shape is *described* the
word "Arduino" survives on purpose (`generate/sketch.ts`, `generate/files.ts`, `generate/esp.ts`, and the README
chapter) — it is the best description of the layout, and the user asked for it to be kept. The designer stayed
Rust-only, and the seam I added in §143 is gone with it: `DesignerPanel` names `src/ui.kdl`, `src/ui.rs` and
`src/ui_handlers.rs` directly again. A single-family abstraction is a cost, not a courtesy.

**How it was done, so the next removal is quick.** Delete the modules, then let `tsc` name every broken import and
work through them (nine files: `activeProject`, `state`, `health`, `controls`, `extension`, `debugProject`,
`projectCommands`, `withProject`, `newProject`), then the manifest (`package.json` — six commands, three settings,
the description), then the tests, then the docs. Two things needed care rather than deletion: `ActiveProject.kind`
and its `arduino` facet were read by four modules and are now gone entirely (a `Cargo.toml` is the only thing that
makes a folder a project), and `HealthFamily` lost a member, which the health summary in `ui/controls.ts` keyed off.

**Verified:** `tsc` clean; **920 checks green** — the 908 hermetic ones (t1 849 · t2 55 · t3 4) plus the whole
`--e2e` layer (2026-10-17, 55 s): six real `cargo build`s of generated projects and the designer simulator's pixel,
tap-dispatch, font and triangle checks. That is 82 fewer hermetic checks and 102 fewer snapshots than 0.1.5, which is
the Arduino family's footprint leaving rather than anything being dropped from the Rust side. The `out/` folder was
cleaned of the deleted modules by hand as well as by `tsc` (it does not remove stale output, and `vsce` packages what
is on disk).

## 145. An idea to come back to: a WYSIWYG designer for PlatformIO (2026-10-17)

Asked, right after the C++ family was removed: *"Does the PlatformIO IDE extension allow 3rd party plugins? I am
thinking of doing a plugin that provides a WYSIWYG Designer, using any tools and widgets that are already available
from 3rd party libraries."* Researched against the current docs rather than memory; **this is a plan, nothing is
built**.

**There is no plugin API inside PlatformIO IDE** — you cannot add a page, panel or menu to it, and PIO Home (the
`pio home` web server on 45000–45999) has no public page-plugin interface. What is documented and supported:

| Hook | What it gives |
|---|---|
| `platformio-ide.toolbar` (setting) | Add buttons to the PIO status-bar toolbar bound to **any** command — the docs say "There is no limitation to command scope… commands from your 3rd party favorite extensions" |
| `platformio-ide.runPIOCoreCommand` | Run any `pio …` line from a button |
| VS Code tasks of `type: "PlatformIO"` + `$platformio` problem matcher | Build/Upload/Clean as tasks with their own panel and error parsing |
| `platformio.ini` | `lib_deps`, `build_flags`, `extra_scripts` (SCons hooks), custom targets |
| Custom platforms / boards / frameworks | JSON manifests, publishable to the PIO Registry |
| `platformio-debug` launch config | Their debugger type (our old C++ route drove `platformio-ide.startDebugging`) |

So the model is *your extension owns the UI, PIO owns the toolchain*, meeting over the CLI, the project files and one
toolbar button. That is exactly how §138–§143's route worked, and it worked.

**The shape that follows, and it is deliberately small.** Its own VS Code extension (not an add-in): a webview canvas
(reuse `webview/designer/`), a document in `designer/panel.ui.json`, and an emitter that writes **LVGL C** — because
LVGL is the widget toolkit these boards already have (MIT, in the PIO registry) and code generation is its normal
integration path. One generated file per save, one user-owned event file, `lvgl/lvgl` added to `lib_deps`, and a
single `platformio-ide.toolbar` button. **No build, no flash, no monitor, no debug code of our own** — that was the
expensive half last time and it is the half PlatformIO already does better.

**Existing tools, so the wheel is not reinvented twice.** SquareLine Studio (LVGL's own, exports C, free tier) and
EEZ Studio (open source — check its licence before depending on it) already emit LVGL C from a canvas. The honest
question is therefore not "can this be built" but **what would this do that they do not**. The four candidate answers,
in the order they are worth anything:
1. **Canvas↔glass parity** — render the canvas with the *same* widget code that runs on the board, instead of a
   lookalike HTML preview. This is the only real moat, and it is what our Rust designer's simulator already does.
2. VS Code-native: design, code and build in one window, no separate app and no copy-paste round trip.
3. Regenerable output: generated files rewritten on save, the handler file never touched (the two-lifetime split).
4. Hardware-aware canvas from the board's real panel and pins — **but** `pio boards --json-output` has no display
   data, so this means owning a per-board display table, which is precisely the thing that drifts (it drifted here,
   §141).

**Two risks worth sizing before any canvas work:**
- **LVGL v8 vs v9.** The display-driver API and the object API both changed (`lv_disp_drv_t` /
  `lv_disp_drv_register()` against `lv_display_t` / `lv_display_create()`). An emitter must pin one major, or emit
  two dialects. This is the biggest correctness trap in the whole idea.
- **Licence and lock-in of the ready-made designer.** If the document format comes from SquareLine/EEZ, so does their
  export format and their upgrade path. Owning our own document JSON and using LVGL only as the *render target* keeps
  the option open.

**The first slice to prove it, if it is ever picked up:** `platformio.ini` → board and panel detection → one label and
one button emitted as **LVGL v9** C → `pio run` on the CYD. That validates the emitter, the version pin and the panel
knowledge before a single canvas gesture is written. Nothing in this repository depends on it.

## §146 — Phase 4 guard rails, and Windows (0.3.0, 2026-10-17)

Asked for as *"Do the launch-config guard rails and the Windows thing next."* These were the last two
`⬜` rows in the README.

### The guard rail, and why it reads the *installed* extension

The four configurations in `.vscode/launch.json` are generated against probe-rs-debugger's schema as
it was on the day they were written. Nothing warns when that schema moves: VS Code accepts an unknown
key, the debugger ignores it, and the session then does something other than what the file plainly
says. (`flashingConfig.flashingEnabled` defaulting to false is the canonical example — it is the
reason the template sets it explicitly rather than relying on the default.)

**The check therefore reads `contributes.debuggers[].configurationAttributes` out of the installed
extension's own `package.json`** — `debuggerSchemaOf()` in `src/project/launchConfig.ts`. There is no
version table in this repository to rot, and updating the debugger cannot make the check stale. If
the extension is absent, or publishes no schema, the answer is "nothing could be checked", never
"fine".

Ground truth on this bench, `probe-rs.probe-rs-debugger-0.32.0`:

| request | required | has `flashingConfig`? |
| --- | --- | --- |
| `launch` | `chip`, `coreConfigs` | yes |
| `attach` | `chip`, `coreConfigs` | **no** |

and `coreConfigs.items` requires `programBinary`, with `coreIndex`, `svdFile`, `rttEnabled`,
`rttChannelFormats`, `catchReset`, `catchHardfault` known. That is exactly why the attach entry in the
template carries no `flashingConfig` — probe-rs rejects it for `attach` — and the validator can now
say so instead of leaving it to a runtime error.

**Validation recurses** (max 3 levels) into properties that declare `properties` or `items`: a rename
inside `coreConfigs` changes what a session does just as much as a top-level one, and the "did you
mean" for `rttEnabledx` → `rttEnabled` is exactly the diagnosis a user needs. Suggestions come from
a tiny Levenshtein (`limit = max(2, len/3)`) or a shared prefix of 4.

**Repairing is separate from reporting.** `onlyGeneratedConfigurations()` is true only when every
entry is `probe-rs-debug` *and* named like one of ours; then the file is replaced from the same
`launchJson()` the wizard uses (now `export`ed — one definition, no drift) with the old file kept as
`.vscode/launch.json.old`. One hand-written configuration, or one of another debugger type, and the
command reports and leaves the file alone: overwriting a file the user edited is data loss, not a
fix. `Debug` runs the same check first and returns with the offer instead of starting a session that
would quietly do the wrong thing.

Command: **Rusty Platform: Check Debug Configuration** (`rustyPlatform.checkLaunchConfig`).

### Windows

Already platform-aware before this: installer URLs and `rustup-init.exe`, `chmod` skipping, zip
extraction through `Expand-Archive`, udev gated to Linux, UF2 drive letters `D:`–`Z:`, `PATHEXT` in
`exec.ts`, `$env:DEFMT_LOG` in the terminal prefix, `.deb` packaging refused off Linux. Three real
gaps were closed:

1. **Serial ports.** `/dev/serial/by-id` does not exist on Windows. `serialPortEntriesForPlatform()`
   now asks PowerShell (`Get-CimInstance Win32_PnPEntity` filtered to `(COM<n>)`, `ConvertTo-Json
   -Compress`) — `Win32_PnPEntity` rather than `Win32_SerialPort` because the latter misses a port
   whose driver is still loading, which is exactly the moment someone presses Flash.
   `parseWindowsSerialPorts()` folds the friendly name **and the PNP device id** into the entry's
   `name`, so the existing `isEspProgrammerName()` filter keeps working unchanged. That matters:
   a test now asserts a `VID_2E8A` port is **not** a candidate, so the bench rule survives the port
   to Windows. A query that cannot run (no PowerShell, restricted execution policy) is "no
   candidates" and espflash asks its own question.
2. **Shell chaining.** `espFlashAndMonitorCommand()` took `A && B`; PowerShell 5.1 rejects `&&`
   outright. On `win32` it now emits `A; if ($LASTEXITCODE -eq 0) { B }`.
3. **`export-esp.ps1`.** `espEnv()` only read `export-esp.sh`, so an ESP project on Windows would
   build without the Xtensa linker on PATH. `parseExportEspPowerShell()` reads `$env:NAME = "…"` and
   the `"dir;dir;" + $env:PATH` prepend idiom, and `parseExportEspFile()` picks the parser from the
   file name, so no caller branches on the platform. `espDetect` and the terminal's identity key
   accept either name.

macOS is deliberately left to `espflash`'s own picker: `/dev/cu.*` has no stable descriptive name, so
there is nothing to filter a vendor out of.

### Still unverified, on purpose

- **No Windows machine on this bench.** Everything above is unit-tested *for* `win32` (the pure
  functions take the platform as an argument) but has not been run on Windows. README says so with
  🟡 rather than ✅.
- **`export-esp.ps1`'s exact shape** comes from espup's documented output, not from a real Windows
  install. The parser is tolerant — an unrecognised line costs one variable, never the file — and
  the sample is pinned in `esp-toolchain.test.js` so a change in expectation is a visible diff.

### Tests

23 new hermetic checks, all in t1: 13 for the launch schema (extraction, the four generated
configurations validating clean against a fixture copied from 0.32.0, an unknown key with its
suggestion, a renamed nested key, a missing `required`, `flashingConfig` on `attach`, an unknown
request, jsonc tolerance, the regeneration guard, `closestSchemaKey`, and that the command is declared
*and* called from Debug), 6 for the Windows port/chain, 4 for the PowerShell export file
(two of them reusing the existing POSIX cases' expectations for parity).

**931 hermetic green** (t1 872 · t2 55 · t3 4) and **943 with `--e2e`** (6 real `cargo build`s plus
the designer simulator, 100 s).

## §147 — A clock that keeps the time, a keypad, and a font that has the characters (0.6.1–0.8.0, 2026-10-17)

A day of small requests, each one a defect on the glass rather than a plan. They turned out to share two
causes at the bottom: **what a widget repaints**, and **what the built-in face can draw**.

The first half of the day (0.3.1–0.5.1: fourteen widgets made to honour their Font setting, the Clock widget
itself, and its numerals centred on their ticks) is recorded in `CHANGELOG.md` only — this section picks up from
the clock that would not run.

### The clock, from "not running" to "only the hand that moved"

1. **The clock did not run** because the design poll sat inside the touch branch of the generated loop: with no
   finger on the glass there was nothing to poll it. Moved to every pass, and the no-touch body now polls every
   100 ms.
2. **The old hands stayed behind** — a partial repaint has no background. `paint_damage()` clears the damaged
   region to the generated `SCREEN_BACKGROUND` first, and a test holds a cleared partial repaint to the same
   pixels as a whole one.
3. **The whole widget repainted every second.** A face of sixty ticks and twelve numerals is most of the work of
   drawing it and none of it changes when a second passes, so `ClockWidget::hands_rect()` measures the hands and
   the damage is their union.
4. **Then the hands themselves.** *"The minute hand must only redraw when sufficient time has passed so that the
   hand have passed more than half of the time between minute ticks … The hour hand can update every minute."*
   The minute hand now takes half a minute tick at a time and the hour hand whole minutes, and — the part that
   actually saves the panel — `hand_damage_rect()` unions **only the hands whose angle changed**, so a tick
   normally damages the second hand alone. The old union repainted the long minute hand sixty times a minute for
   the fifty-eight seconds it was not moving.

The angles live in one `hand_spec()`, used by the renderer *and* the damage: a hand drawn from one set of angles
and measured from another would leave a smear of its old positions.

### The keypad

Asked for as one brief with eight numbered requirements, and built as **one widget**: the line being typed, the
mode, caps lock and the last submitted line all live in `KeypadWidget`, so a design gets one `submitted` event
rather than thirty buttons to wire. It pins itself to the bottom strip (a third of the panel in portrait, half in
landscape) and re-solves that box when the rotation changes.

What the requests added, in order: `CLR`/`ENT`/`SHIFT` instead of `C`/`E`/`^`; a row of digits above `qwerty`
and the symbol set `~!@#$%^&*()-=_+[]\{}|;':",./<>?`, which retired the digits-only page — the mode key now goes
letters ⇄ symbols and reads `%%…` / `ABC`; the typed line left-justified and centred between the box's edges
(0.7.7 read that request the wrong way and centred it across the whole box, which makes a line jump sideways as
it grows); and the caret an underscore sitting on the baseline.

### The RTC, and the crash that was not a crash

An ESP32's RTC has no battery, so a board that has been powered off has no idea of the time. The flash now hands
it over: `TIME HH:MM:SS` is written to the console by the same terminal that flashed, the generated firmware
parses it and calls `set_wall_clock`, and the movement follows the wall clock from then on (falling back to
stepping when it has been given no time).

*"The screen draws complete but then crash."* It was not a crash. The log ended on `painted 480x320 in 691 ms`
— the *first* frame — and `esp-hal`'s `Uart::read` **waits** for a byte when the FIFO is empty, so the first
pass after painting stopped dead until one arrived, which on an idle console is never. `read_ready()` answers at
once and costs one register read, so a quiet console costs one test a pass. The two lessons: a `.expect()` on the
UART was never the fault (the log had passed it), and a firmware that paints once and goes quiet is a loop that
stopped, not a panic.

**Update Time** (0.7.9) is the same line on its own, from the clock's Properties pane: the rules live in
`src/flash/clockSync.ts` with the shell runner injected, so a test asserts the exact command that would reach the
port without a device on the bench. Refusals — no clock in the design, no board on a port, a port a Monitor
terminal holds — are one sentence each, in the panel and in a notification, and nothing throws.

### The face: lower case and the missing half of the punctuation

Two reports in one breath — *"The shift key is not toggling uppercase/lowercase. Also, it seems that the the
fonts does not support symbols"* — and both were the built-in 3x5 table in `build.rs`:

- it matched on `ch.to_ascii_uppercase()`, so `q` and `Q` were **the same five rows**. The keypad had grown a
  private `UPPER_3X5` table in 0.7.1 to work around it; since it held the same shapes, all it changed was the
  centring by a pixel. The face now carries a real lower case and the workaround is deleted.
- only nine punctuation marks existed. Everything else fell through to the fallback — so the new symbol page
  drew rows of identical boxes. All of printable ASCII 32–126 is drawn now, and the fallback is a **solid
  block** rather than a hollow one, because the hollow one was `0`'s own shape: an unsupported character read as
  a nought.

The canvas table is generated from the crate (`node tests/tools/glyph-table.js`), so the preview moved with it
and the two cannot drift. `Medium4x7`'s four overrides now spell their glyphs exactly as the base face does, so
the generator ships one table instead of two.

The visible cost, said plainly: lower-case text in every existing design now renders as lower case (a button
labelled "Press me" used to draw as "PRESS ME"). That is the honest fix, but it is a change to any older design.

### Tests

- crate (`cargo test --features rich-widgets`): **306**, up from 297 — clock stepping and per-hand damage, the
  keypad's pages and its entry box, every printable character having a glyph of its own, and lower case differing
  from upper.
- extension: **971** hermetic (t1 · t2 65 · t3 4), up from 961 — the clock-sync rules and the panel test that
  drops a clock and presses the button.
- goldens re-recorded twice (the generated `main.rs` gained the console reader and the wall clock).
- every release was built for the CYD, packaged, installed and `cmp`-verified against the source, with the
  previous version's folder removed; `retest/codegen` was re-vendored and rebuilt each time.

## §148 — Two real faces, and why the 5x7 is not here (0.9.0, 2026-10-18)

Asked for as *"Those fonts are really terrible ... add 5×7 + 8×16; face: DejaVu Sans Mono"*.

### What was actually wrong

Every built-in was a 3x5 bitmap. `Medium4x7` was the same 3x5 drawing in a 5x8 cell — the name says the cell,
not the ink — and `Scaled6x10` was the same table in 2x2 blocks. Nothing in the crate had a curve, so nothing
could look good above about eight pixels.

### The measurement that changed the plan

DejaVu Sans Mono, rasterised at each size and measured over printable ASCII:

| em | ascent | descent | widest glyph | verdict |
| --- | --- | --- | --- | --- |
| 6-7 px | 5-6 | 1-2 | 5 | mush: `a`, `e`, `s` are the same blob |
| 9 px | 8 | 2 | 6 | legible |
| 12 px | 10 | 3 | 8 | very legible |
| 13 px | 11 | 3 | 9 | legible, but a 9-wide glyph will not fit an 8-wide cell |

**FreeType's monochrome rasteriser is the whole difference.** The anti-aliased render at 6-7 px collapsed the
letterforms; `getmask2(..., mode='1')` grid-fits stems to whole pixels and gave a readable 6x10 at a 9 px em.
Everything small was first rendered the anti-aliased way and thrown away.

So the faces shipped are **6x10** (advance 7, line 12) and **8x16** (advance 9, line 19), not 5x7. A 5x7 works
when the glyphs are *drawn* at 5x7 — the classic LCD fonts — and not when an outline face is squeezed to it.

### How a face is built

`assets/fonts/from_truetype.py` rasterises the TTF into `key:rows` text, committed beside the 3x5 overrides and
read by the same build script. `BitmapFont` wants one byte per row with the leftmost column in bit 7, so
`build.rs` emits flat `[u8; 95 * height]` tables; the 3x5 faces keep their `[[u8; 5]; 95]` packing.

Three seams had to be opened, and each was a latent 3x5 assumption:

1. **`build.rs` never rebuilt on a font edit.** It printed only `rerun-if-env-changed`, and once any `rerun-if-*`
   is printed cargo stops scanning the package: a corrected glyph would not have reached the board. Fixed for the
   whole font folder.
2. **The clock's numerals.** `label_ink_box` hard-coded three columns by five rows and `draw_scaled_text` drew
   from the packed table, so a big face would have drawn 3x5 digits in a box measured for the big one.
   `font::glyph_ink_box` and `font::for_each_glyph_pixel` now answer for any face.
3. **The canvas.** `glyphs.ts` carried `GLYPH_ROWS = 5` and `GLYPH_COLUMNS = 3` as module constants. The
   generator now emits each font's own `width`/`height`, the tables are per distinct *face* (three of them), and
   the two draw sites read the shape instead of assuming it.

The dumper (`tests/sim/src/bin/glyphs.rs`) also learned to read a `BitmapFont`: its `glyph_bytes` rows are shifted
down to `width` bits so the canvas indexes every face the same way.

### Two traps met on the way

- **`key:rows` cannot be parsed with `split_once(':')`.** The `:` character's own row is `::010,010,...`, so its
  key came back empty and the colon silently vanished from every face. `rsplit_once` — in the build script and in
  the Python that checks it.
- **`glyph-table.js` used a scratch `CARGO_HOME`** under `tests/tmp`, which the clean-out deleted; offline builds
  then failed with "no matching package named `embedded-graphics`". It now uses the ambient cargo home: it is a
  maintenance command, not a test.

### Cost

About **2.5 KB of flash** for both faces, linked once because the renderer names them. `Tiny3x5` stays the
default, so no existing design changes appearance.

### Tests

crate **308** (up from 306): each rasterised face has its own shape, every printable character draws ink inside
its cell, lower case differs from upper, and the renderer draws them taller than 3x5. Extension **971** — the
generated-table checks moved to per-font width/height and three tables. The CYD demo and `retest` both build with
`FontId::Mono8x16` in a design.

## §149 — The 5x7 that was asked for, and a declared font the canvas can draw (0.10.0, 2026-10-18)

The two font issues left over from §148.

### The 5x7, drawn by hand

§148 stopped at "rasterising an outline face below a nine-pixel em loses the letters". The answer is not a
better rasteriser, it is *drawing* the glyphs -- which is what every small bitmap face has always been. So
`assets/fonts/ascii_5x7.txt` is ninety-five glyphs of five columns by seven rows, hand-made in the classic LCD
style: capitals on all seven rows, lower case from row two with the tails of `g j p q y` shared into the last
row, and every printable character present.

It reaches the board as a `BitmapFont` (`FontId::Medium5x7`, advance 6, line height 9) rather than a
`PackedFont`, because `PackedFont` is fixed at five rows by its own type. That meant nothing new in the
renderer: it is another name for the `Bitmap` arm, exactly like the two rasterised faces.

### A declared BDF is drawn, not approximated

The canvas used to paint a design's declared font as the packed 3x5 default — the preview was a lie for any
widget with a real face. The fix is a pipeline, not a drawing hack:

1. **`src/designer/bitmapFont.ts`** parses a BDF into the canvas's shape. It is a port of the crate's own
   `parse_bdf` (`embedded-gui-codegen/src/assets.rs`), and deliberately so: the cell is cropped to the glyphs
   being embedded rather than to `FONTBOUNDINGBOX`, each glyph is composited by its own offset from the
   baseline, and a row is `width` bits with the leftmost column high. Two of the crate's own test fixtures are
   asserted to the same numbers in t1, which is what keeps the two from drifting.
2. **The editor** parses every declared font when the panel opens and sends the pixels with the document
   (`DesignerInit.fonts`). They are resent only when the declarations change -- a report follows every edit, and
   a hundred glyph bitmaps per keystroke would be work for nothing.
3. **`glyphs.ts`** grew a registry (`registerDesignFont`) that `glyphMetrics`, `glyphRows`, `glyphColumns` and
   `glyphRowCount` consult *before* the built-in table. Everything downstream -- text measurement, the char
   drawer, the clock's numerals -- then works unchanged.
4. **`preview.ts`** stops replacing the name with the default: a label whose `font=` resolves to a declared face
   keeps that name, and the glyph table draws it.

A row is read by division (`Math.floor(bits / 2 ** (columns - 1 - col)) % 2`) rather than a shift, because a
declared BDF can be wider than 32 columns, where `1 << n` wraps without a word.

### Tests

- t1 `designer-bitmap-font.test.js`: the crate's two BDF fixtures asserted to its own numbers
  (`(width, height, advance, first_char)` and every glyph row), a subset that matches nothing being an error
  rather than an empty font, and the repository's own `tests/sim/assets/test.bdf` checked for a self-consistent
  shape.
- t2 `designer-declared-font.test.js`: the real bundle, a design whose label names a declared font, and an
  assertion that the painted ink spans **seven** rows -- the 3x5 fallback cannot, so the test only passes if
  the face's own pixels reached the canvas.
- Both t2 bundle tests now clear the `require` cache first: a second file in the same process was reusing a
  module evaluated against the *first* test's DOM, which showed up as "there is a canvas" failing in a full run
  and passing on its own.

crate **309**, extension **976**. A CYD project using `Medium5x7` for a label and `Mono8x16` for a button
builds.

### Still open

A **TTF/OTF importer** ("adapt a system font"): the honest shape is the panel rasterising the face it already
has a renderer for -- the webview can `fillText` a `@font-face` from a data URL -- and the extension writing
the result out as a BDF, which the pipeline above then draws and the crate already consumes. Not built.

## §150 — A system font in the project, and the two places a font has to reach (0.11.0–0.12.2, 2026-10-19)

§149 ended on "a TTF/OTF importer: not built". It is built, and the three bugs it took to make it *visible*
are the interesting part.

### Import a Font: draw it in the panel, write it in the extension

The split is the whole design, and it is there because the extension has no renderer while the webview has a
good one:

1. **The extension** opens the file dialog (`.ttf`, `.otf`, `.ttc`, or a `.bdf` which skips the work), asks how
   many pixels tall to draw the face, copies the face into `assets/`, and posts its bytes to the panel as
   base64 (`DesignerRasteriseFont`).
2. **The panel** builds a `FontFace` from the bytes, `fillText`s all 95 printable characters onto a canvas,
   thresholds the alpha at 128, and posts the cell back (`DesignerFontRasterised`).
3. **The extension** writes `assets/<name>-<size>.bdf` and tells the panel to declare it (`DesignerDeclareFont`).
4. **The panel** declares it and points the selected widget at it, in one undo step.

The arithmetic lives in `src/designer/fontRaster.ts` behind a `CellCanvasFactory`, so it is held to a
measurement table in t1 (`designer-font-import.test.js`) instead of to whatever a browser happened to do --
the cell is the union of every glyph's ink on one shared pen origin and baseline, which is what keeps a
proportional face in proportion. The BDF writer (`fontImport.ts`) is round-tripped through `parseBdfFont`:
what the canvas drew is what the file says, and what the crate will draw.

The browser renderer was checked once, for real: a scratch page over the integrated browser, DejaVu Sans Mono
at 24 px, gave a **21x26 cell** with a 6-row descent. Worth doing -- it is the sort of thing that looks fine in
a stub and is off by a factor in Chromium.

### Three bugs, one theme: a font has two routes and more than one reader

The imported font kept "not showing up". Each report was true, and each had a different cause:

- **"The picker only lists BDF."** The Font field's filter was `{ 'BDF fonts': ['bdf'] }`. One `FONT_FILTERS`
  now feeds both dialogs, and `isBitmapFontFile()` is the single rule for "copy it in" versus "draw it into a
  BDF first".
- **"The font is not in the list and the box is empty / it defaults to Default."** The clock -- and a button, a
  toggle, a spinbox -- is `fontSupport: 'style'`, so the list was built from the *built-ins only*: a declared
  font was invisible there, and a value that matches no option draws a `<select>` blank. The crate reaches
  those widgets through `style.font`, so the designer now writes
  `style.font = FontId::Bitmap(&__FONT_<ID>)` -- the same bitmap static the codegen writes when a label's
  `font=` attribute resolves. `fontConstName` moved to `fonts.ts` (a leaf) so the style emitter can use it
  without importing the document model, and the validator no longer refuses a declared font on a style-only
  widget. Verified through the crate's own generator, not by eye:
  `cargo run --bin expand -- /tmp/clock.kdl` prints
  `add_clock_styled(..., { let mut style = Style::label(); style.font = FontId::Bitmap(&__FONT_DEJAVU_24); style })?`;
- **"It shows the selection but renders the default."** The *canvas* had its own copy of the routing rule, in
  `preview.ts`'s `designStyle`, and only ever put a *built-in* font into the style. The markup named the
  imported face; the canvas went on painting the default. **The lesson: a change to how a font reaches a style
  has to touch both places.** The regression test paints one clock three ways -- a heavy face, a one-row face
  and no face -- and demands more ink than the default for the first and less for the second. With the fix
  stashed, all three painted exactly 195 501 pixels.

### The size box, and its removal

0.12.0 added a size box beside the Font list that redrew the kept face at a new size (`resizeFont` /
`fontResized` / `state.setFontSize`). 0.12.2 removed it at the user's request -- the import's size prompt is
the way in -- and the whole path went with it rather than being left unreachable. What stays is the
bookkeeping: the declaration keeps `source` (the face, copied into `assets/`) and `size`, because they are
what the UI names a font with -- `DejaVu_24 (24 px)` in the list, `Drawn from assets/… at 24 px` in the Fonts
section.

### Deleting a font

Right-click a Font list: `fontMenu` offers `Delete the font "<id>"` for a *declared* font only, marked as
destructive. It routes through `removeFont`, which has always cleared the reference from every widget that
named it -- a widget pointing at a name that no longer exists is a validation error to hunt for. It removes
the declaration, not the files: those are the user's, and the Fonts list's own Remove button has always
behaved the same way.

### Tests

- t1 `designer-font-import.test.js` (12): the writer's text, a 9-column cell that straddles two bytes, the
  round trip through `parseBdfFont`, the rasteriser against a measurement table (including a space that must
  not widen the cell, and alpha 127 versus 128), and `fontIdFromFile`'s Rust-identifier rules.
- t2 `designer-font-menu.test.js`: a declared font listed for a clock and named with its size; the right-click
  menu; deleting it clears the widget's reference and leaves an unused font alone; no menu for `(default)` or
  a built-in.
- t2 `designer-font-style.test.js`: the canvas uses the face for a style-only widget (see above).
- t2 `designer-webview.test.js` and t1 policy tests updated: a declared font is now offered *everywhere*, by
  whichever route the tag reads.

crate **309**, extension **995** (t1 920 · t2 71 · t3 4).

---

## 146. SD card toggle in the Designer (2026-10-21, unreleased)

The SD card, unlike touch or rotation, cannot be a `.cargo/esp-config.toml` key: an env var (or a config
`const`) can gate *whether the firmware talks to the card*, but it cannot add or drop the `embedded-sdmmc`
dependency from the build, which is the literal requirement ("enabling adds a file system"). SD is therefore a
cargo `feature`.

- The only board with an SD slot is the Sunton `sunton-3248s035r` (CS=GPIO5, SPI3 = SCLK 18 / MOSI 23 / MISO 19
  per `src/boards/catalog.ts`). RP boards expose no slot, so there is nothing to toggle for them.
- Generation (`src/generate/esp.ts`): `designerSd = template === 'designer' && board.sd !== undefined`. The
  deps become `optional = true`; `espFeaturesSection` emits
  `[features]\ndefault = [..., "sd"]\nsd = ["dep:embedded-sdmmc", "dep:critical-section"]`; `espModules` writes
  `#[cfg(feature = "sd")]\nmod sd;` and `espDesignerSdInit` writes `#[cfg(feature = "sd")]` before `sd::init`.
  The Sunton Designer's `default = ["sd"]` keeps the default-on path byte-identical to the pre-toggle output, so
  behaviour does not change until the user flips it off.
- The `sdcard`/`board` templates keep `embedded-sdmmc = "0.8.2"` (non-optional) and never emit the `#[cfg]`, so
  the toggle's gating never reaches them.
- The Designer toolbar toggle (`webview/designer/main.ts` `setSd`, `src/designer/editor.ts` `setSd`,
  `src/designer/sdFeature.ts`) rewrites only the `default = [...]` line of `[features]` and posts a rebuild note;
  `Editor.save()` flags `sd:` images when the feature is off. The round trip is t1-pins in
  `tests/layers/t1-logic/sd-feature.test.js` (helper) and `designer-sd.test.js` (gating); the Sunton Designer
  bytes are locked by the regenerated t3-golden snapshots.
- Rust correctness is by construction + golden snapshots only: the host has `rustc 1.99.0` and no
  `xtensa-esp32*` / `espup` toolchain, so the generated SD code is not cross-compiled here.

---

## §151 — SMTP that compiles, one radio owner, two switches, a cursor, and a settable inset (0.13.3–0.13.9, 2026-10-21)

The session that started as "verify the SMTP feature and the SD button" turned into six changes, because
each one exposed the next. In order:

**The SMTP client the wizard wrote did not compile.** Three defects, each found by compiling rather than
by reading:

- `Spawner::spawn` returns `()` in embassy-executor **0.10** (0.9 returned `Result<(), SpawnError>`), and the
  emitted wiring called `.unwrap()` on it. Every other generated spawn already ignored the value; the SMTP
  one did not. `retest/src/main.rs` had been hand-fixed, which is the evidence that the emitted text never
  built.
- `smtp_expect` tested `buf[3]` — the **first** line's separator — so a multi-line `EHLO` reply
  (`250-PIPELINING`, `250-AUTH`, …) never finished: the loop kept re-reading the first line's `-`. It now
  tracks the current line's first four bytes and resets per LF.
- `Subject: ` went out as a line of its own, so the subject text became a malformed header. Headers are now
  written whole (`smtp_send_parts`), `From:`/`To:` are included, and a body starting with `.` is dot-stuffed.
- Also: the setup lives in the extension host's memory. After a reload, Flash baked an empty `SMTP_HOST`
  with no warning; `ensureSmtpEnv` re-injects it on Build, both Flash routes and Debug, beside
  `ensureWifiEnv`.

**One radio owner.** `peripherals.WIFI` can be moved once per boot, so the old shape (SMTP in the `else` of
the clock's spawn) meant a clocked design never sent a post on a cold boot — its RTC is never set, so the
clock task always won. `smtp_task(wifi, wants_time)` now owns the radio and performs net.rs's SNTP query
itself when asked, publishing `crate::net::SYNCED_TIME` (main's loop still gates the RTC write on
`needs_time`, so "no resync" survives). `main.rs` emits two `#[cfg(...)]`-gated **statements** — cfg on
statements is stable, and both branches may move the peripheral because only one exists per build. With the
feature on, net.rs's `time_task` is compiled but unspawned, which is six dead-code warnings; the module
carries `#![allow(dead_code)]` and the reason, and `ensureNetAllowDeadCode` adds it to older projects.
`wireSmtpSpawn` migrates a 0.13.3 `else`-pair into the merged shape.

**Two real switches.** SD became a switch (was a select), and SMTP got one. Both are cargo features, so
`src/designer/features.ts` holds the shared line editor (`isFeatureInDefault`, `setFeatureInDefault`,
`ensureFeatureDefinition`); `sdFeature.ts` is now a thin wrapper. The control is a checkbox drawn as a
track/thumb (`.tool-toggle`), and `.tool-toggle-label` names its own theme colour — a webview element does
not inherit one (the `.context-item` lesson again). The preview's keypad needed **sentinels** for the cursor
keys, because the symbol page types its own `<` and `>`.

**The ESP32-035 board option.** Asked: "remove all templates except the WYSIWYG template." Two notions are
now separate on purpose: `templatesFor` (what a board can generate — unchanged, so the panel diagnostic and
the board/golden tests still build it) and `templatesOfferedFor` (what the wizard's board option presents,
narrowed by `OFFERED_TEMPLATES`). One offered template means the wizard does not ask. `defaultTemplateFor`
follows the same list.

**Keypad cursor keys.** `KeypadKey::Left`/`Right`, a **byte** cursor on `KeypadWidget`, and `push()` that
overwrites the character under it (shifting the tail by the UTF-8 length difference). Backspace deletes
*before* the cursor. The caret is painted as a 2-px underline rather than appended as a `_` glyph — a glyph
would push the tail a cell to the right and cannot sit *under* a character. Labels `<->` are two characters
so they cannot be confused with the symbol page's single `<`/`>`; Backspace became `BKSP` for the same
reason. Bottom row of every page: `CLR | <- | -> | ENT`.

**Clock number inset.** The hour numbers' distance is a design property now, in character widths stepped by
0.1 (`label_inset`, default 0.5). This is the full checklist for a widget property, and it is worth keeping:
crate field + default (`ClockWidget` derives **PartialEq only** — `f32` is not `Eq`, like `ScaleWidget`) →
`embedded-gui-codegen` AST/parser (`get_f64_prop`, default 0.5, clamp 0..=2)/emitter (`{:.1}`, so `1.0` is a
valid Rust float literal)/serializer → catalogue (`kind: 'float'`; the panel already steps floats by 0.1) +
`PROPERTY_HELP` → canvas. **Sign trap:** "inwards" at twelve o'clock means a *larger* y; my first assertion
had it backwards and the measured diff was `-8` instead of `+8`.

**Verification as it stands.** Suite **1050** (t1 973 · t2 73 · t3 4); `embedded-gui` **317** and
`embedded-gui-codegen` **30** crate tests; `cargo check --no-default-features --features
"rich-widgets,embedded-graphics,macros,micromath"` (a project's feature set) warning-free; a freshly
generated CYD Designer project cross-checked on the ESP toolchain in all four `smtp`/`sd` combinations, and
the `smtp` feature proved to gate the module by corrupting `smtp.rs` with the feature off (ignored) and on
(compiled). Version 0.13.9 is what `package.json` says; the crate changes mean an existing project needs
**Update now** for its vendored copy.

---

## §152 — DevKitC display modules, a PWM backlight, and the panel a project is really for (0.13.11–0.13.12, 2026-10-22)

Asked: *"I have implemented the WYSIWYG designer for the ESP32-DEVKITC board … check for errors/weakness. Then
implement a 'Brightness' setting … 0% to 100% brightness by using PWM on the BL pin … only available when using
a LCD panel with a BL pin wired."* The review found four real defects around the new board support, and the
brightness feature could not be built properly until "which panel is this project for" had one answer.

### The panel is a property of the project (and of the module)

- The catalog now has two DevKitC modules: **ST7789 240×240** (no touch) and **ILI9341Rgb565 240×320 with an
  XPT2046** (MISO 19 on the shared bus), both at GPIO18/23, BL on GPIO21. Both mipidsi models were verified in
  the **0.10.0 source** (`src/models/st7789.rs`, `src/models/ili9341.rs`), not from memory.
- `EspDisplay.touch` is new: a controller can belong to the *module* (a DevKitC panel) or to the *board* (the
  CYD). `touchFor(board, display) = display?.touch ?? board.touch` is the one rule, used by the generator, the
  wizard and the Designer.
- The manifest is the durable record: `panel-<id>` in `[features] default`
  (`panelChoiceFromCargo`/`displayForProject` in `src/boards/esp.ts`). `src/main.rs` cannot be read back for
  it, and the two DevKitC modules differ in size *and* in whether they bring touch.
- **The defect this fixed:** the Designer used `board.displays[0]` and `board.touch` (the old comment "every
  display it ships has the same size" stopped being true with the DevKitC). An ILI9341 project therefore
  opened a 240×240 canvas and generated touchless firmware. Now resolved in `espSketch`, `espImports`,
  `espCargoToml`, `generateEspProjectFiles` (`touchSetting`, starter `ui.rs`/handlers), `espModules`
  (`DESIGNER`/`TOUCH`) and the README.
- The wizard asks **panel first, then touch**: the panel answer decides whether there is a touchscreen to ask
  about. `pickTouch(board, template, choices)` uses `touchFor(board, displayFor(board, choices))`.
- Kept as a limitation: the DevKitC does not *offer* the standalone `touch`/`board` templates, because
  `templatesFor` is computed before a module is chosen. The Designer covers touch on that board.

### Two pre-existing template bugs, found by compiling

- **`touch` and `board` did not compile at all.** Both carried a Designer-only clock hand-over block that
  refers to `screen` (`E0425`) — a leftover from the RTC/host-time feature (0.13.0). The committed t3
  snapshots contain the broken text, so it predates this session. The block now exists only in the Designer
  loop, `wall_clock`/`wall_clock_applied` are declared only where a design can be told the time, and the
  non-Designer console reader keeps parsing/logging the `TIME` line.
- `use esp_hal::ram;` was imported for `touch`/`board` (only the Designer heap uses `#[ram(reclaimed)]`) ⇒ an
  unused-import warning in every such project. Now Designer-only.

### The brightness setting

- **Storage:** `BACKLIGHT_BRIGHTNESS = "0".."100"` in `.cargo/esp-config.toml`, beside `LCD_ROTATION` and
  `TOUCH_ENABLED`. Read at compile time, so `src/main.rs` is never edited by the setting. Written only for a
  template that drives a panel *and* a module with a BL pin (`usesPanel && hasBacklight(panel)`) — the first
  cut wrote it for `blinky`/`wifi` too, which the golden diff showed immediately.
- **Absent or unreadable ⇒ 100.** The Rust side is a `const fn percent_from_env` (while loop over bytes,
  early `return 100` on a non-digit or an empty value, clamp above 100); the extension mirrors it in
  `src/display/backlight.ts` (`brightnessFromConfig`, `clampBrightness`, `setBrightnessInConfig`). A typo must
  never switch the panel off — that looks exactly like a dead board.
- **Firmware:** LEDC, low-speed timer 0 / channel 0, `Duty10Bit`, 5 kHz, `duty_pct`. esp-hal **1.2.2** facts
  that shaped it (read from the registry source):
  - `channel::config::Config` takes **`duty_pct: u8`** (0–100) and a `drive_mode`; there is **no
    `output_invert`**, so an active-low panel gets `100 - BACKLIGHT_PERCENT` in `BACKLIGHT_DUTY_PCT` instead.
  - `configure` takes `&mut self`, and the config stores `&'a dyn TimerIFace`, where `'a` is the *channel's*
    lifetime. The channel lives in `State`, so the timer may not be a local: `LEDC_CELL` and
    `BACKLIGHT_TIMER_CELL` are `StaticCell`s. `Ledc::set_global_slow_clock(LSGlobalClkSource::APBClk)` is
    required before a low-speed timer will run.
  - The `State` field is `Backlight = Channel<'static, LowSpeed>` with `mutableInSetup: true` — otherwise
    `sketch.ts`'s `immutableLocals` strips the `mut` that `configure` needs.
  - The constants must be **`pub`**: a child module's private items are not reachable through
    `use main_header::*`, and this was the one compile error the first generated project produced
    (`BACKLIGHT_DUTY_PCT` "exists but is inaccessible").
- **Availability:** `hasBacklight(display)` gates the key, the PWM code, the `Backlight` field and the toolbar
  control. No catalogued module lacks a BL pin today, so the *negative* path is covered by the helper's tests
  rather than a golden.
- **Old projects:** `src/main.rs` is written once. The Designer reads it, and when it does not contain
  `BACKLIGHT_DUTY_PCT` the slider is **disabled with the reason** in its tooltip rather than writing a line
  nothing reads. `testnew` was patched by regeneration (its hand-added
  `.invert_colors(ColorInversion::Inverted)` re-applied), and the bench config now says `30` — written by the
  slider.
- **UI:** `.tool-slider` (range 0–100 step 5). The percentage follows on `input`; the message is posted on
  `change`, because a drag would otherwise rewrite the project's config on every pixel. `init` fields are
  optional (`backlight?`, `backlightPwm?`, `brightness?`), the same defensive rule the load fields follow, and
  the colour-rule test in `designer-panel-layout.test.js` grew `.tool-slider`/`.tool-slider-value`.

### No-touch Designer projects

`touchEnabled` came from the config alone, and an absent key means "on": a DevKitC/T-QT Designer project
generated `pointer`/`pump`/`down` without `#[allow(dead_code)]` (two warnings in the user's own project) and
`touchNeededBy` told the user to switch touch on where no controller exists. Now
`touchEnabled = controller === undefined ? false : touchFromConfig(config)`, `emitUiRs`/`syncHandlerStubs`
receive that, and the advisory is raised only when there is a controller. `testnew`'s `ui.rs` was regenerated
with `emitUiRs(doc, false)` and checks warning-free.

### Verification recipe

Generated into `/tmp`, `rsync crates/<c> → codegen/` (minus `target/`), marker written, then
`set -a; . ~/export-esp.sh; set +a; cargo check` — clean and warning-free for **seven** configurations:
DevKitC designer (ST7789), DevKitC designer (ILI9341 + touch), DevKitC-mirror of `testnew`, T-QT designer
(active-low), T-QT display, CYD designer, CYD `board`, CYD `touch`. Suite **1063** hermetic
(t1 985 · t2 74 · t3 4), `tsc` clean, t3 re-recorded (47 files; the DevKitC snapshot folders are new).

## §153 — A 4" ST7796 module, a dated clock, and terminals that release themselves (0.13.13–0.13.15, 2026-10-23)

### The DevKitC's third module

- Asked for: a `4-Inch-SPI-TFT-ST7796-320x480-Touch-XPT2046` option on the ESP32-DevKitC V4. One `EspDisplay`
  entry with `panelChoice: 'st7796'` in `boards/catalog.ts` is the whole model change: the cargo feature
  (`panel-st7796`), the `models::ST7796` driver, the 320×480 canvas, the touch controller and the backlight all
  fall out of the existing rules (`espFeaturesSection`, `displayForProject`, `touchFor`, `hasBacklight`).
  24 MHz because the CYD runs the same controller at that rate; BGR + mirrored X for the same reason.
- The 2.8" ILI9341 row was corrected at the same time (**bgr**, `mirrorX: true`) — confirmed by the user against
  the module. Colour order and mirroring are the two facts no compiler can check, so
  `t1-logic/esp-boards.test.js` now pins every DevKitC module's pins, size, order, rate and touch.
- The DevKitC's option offers **designer + Bluetooth LE only** (`OFFERED_TEMPLATES`). `templatesFor` still lists
  everything, so the panel diagnostic and the golden/board layers keep building it;
  `defaultTemplateForEsp` takes the first *offered* template, which is why the wizard preselects the designer.

### The clock keeps the date

- An SNTP answer used to be a time of day, so an RTC set from the network counted from the 2000 base and lost the
  date at the next power cycle. `SYNCED_TIME` is now `(year, month, day, hour, minute, second)`; `espClockLoop`
  writes it with `set_rtc_datetime`, and `net.rs`/`smtp.rs` both build it with the same `civil_from_days`.
- **Hinnant's civil-from-days, not a table**: `civil_from_days`/`days_from_civil` live in the generated
  `MainHeader.rs`, so both modules reach them as `crate::main_header::…`; `div_euclid` keeps a date before 1970
  correct, and `DAYS_1970_TO_2000` is derived from `CLOCK_RTC_BASE_SECONDS / 86_400` rather than written twice.
- **`set_rtc_time_of_day` reads the RTC first** and keeps the day it finds: a flash's `TIME HH:MM:SS` hand-over
  carries no date, and the old code rewrote the counter to the 2000 base — which would have dragged a
  network-set date back to the base. `Rtc::current_time_us() -> u64` in esp-hal 1.2.2 (read from the registry
  source) is what makes that possible; `days.max(0)` keeps a pre-2000 date from wrapping the unsigned counter.
- **Known limitation (cross-version):** `src/main.rs` and `src/net.rs` are written once. A 0.13.12 project keeps
  its 3-tuple `SYNCED_TIME`, and running the SMTP wizard on 0.13.15 rewrites `src/smtp.rs` with the 6-tuple, so
  the two then disagree. Only a regenerated project (or a hand-patched pair) is consistent; the recipe in the
  section above is how an older project is brought forward.

### Terminals that release themselves

- Asked for: release the terminal a Build or Flash session created instead of leaving it behind. The first cut
  matched the **command line** (`line.includes('cargo')`), which has two traps: the probe flash is
  `probe-rs download … && probe-rs reset …`, containing neither "flash" nor "espflash", so that listener could
  never fire; and a `cargo` command typed in *any* terminal (the user's own `cargo test`) would fire it early.
  `whenTerminalCommandEnds` now takes the `vscode.Terminal` that `runInTerminal` returned, compares
  `event.terminal === terminal`, and disposes both listeners when the command ends **or** the terminal closes —
  so nothing is left holding a dead terminal where shell integration is unavailable.
- **Close on success only** (the user's decision): a failed build or flash keeps its terminal, because that
  terminal holds the error text. The test is `exitCode === 0`; an exit code the shell cannot report counts as
  unknown, which also leaves the terminal alone.
- The clock listener is re-armed on **any** end, not only a successful one — a flash that failed is exactly when
  a board is likely to ask for the time again.

### Verification

- `cargo check` (esp toolchain, repo crates rsynced into `codegen/`) clean and warning-free for DevKitC Designer
  on the ST7796 module (touch, `Output<'static>` reset) and DevKitC `display` on the same module.
- Suite **1065** hermetic (t1 987 · t2 74 · t3 4), `tsc` clean; t3 re-recorded (11 files: `panel-st7796` in the
  two DevKitC manifests, the dated clock in every Designer snapshot).

## §154 — The hand-over learns the date (0.13.16, 2026-10-24)

- Asked after a bench session on the 4" DevKitC (`~/Projekte/TestExtApps/test4InchESP32-DevKitC`): the device
  list showed a name and an RSSI but no date. Two causes were **in that project**; one gap was ours.
- **Ours:** the console hand-over sent `TIME HH:MM:SS` — the hands only — so a board with no network could not
  learn the calendar day: `set_rtc_time_of_day` keeps whatever day the RTC holds, and on a cold board that is
  the 2000 base. 0.13.15's dated clock therefore only worked over Wi-Fi. The generated `main.rs` now also
  parses `TIME YYYY-MM-DD HH:MM:SS` (`parse_clock_datetime`, tried before `parse_clock_time`), and both
  writers — the flash hand-over and the **Answer Time Requests** listener — send the dated line *and then* the
  bare one.
  - **The order is the compatibility mechanism.** A project generated before today wants `HH:MM:SS` as the
    second word, so it ignores the dated line and acts on the bare one exactly as before; a new project takes
    the date first, and the bare line that follows only rewrites the time of day — `set_rtc_time_of_day`
    preserves the day, which is the rule 0.13.15 introduced for a host that has no date to give.
  - One text for both consoles: `espClockLineHandler(indent)` in `generate/esp.ts` emits the line handler for
    the S3 and the CYD readers, which differ in how a byte arrives and in nothing else — two copies is how the
    two drift.
- **The bench project's own bugs** (do not re-derive): its `net.rs` *added* the epoch offset
  (`days_since_unix + 10957`) where 1970→2000 is a subtraction, so the date came out 2 × 10957 days late —
  2086-10-23 for 2026-10-24, which reads as "month right, day one short"; and its `upsert` stamps a row only
  when a device is first seen, so a device picked up during the seconds before SNTP answered stayed dateless
  for as long as it was in range. The generator cannot have the first bug: it derives the date with
  `civil_from_days(days since 1970)` and has no epoch constant whose sign could be wrong.
- Also from that session: at a readable face a list row does not fit on one line — `Mono8x16` gives 35
  characters across a 320 px panel and `name + date + rssi` is 39, so the second line is not decoration, it is
  what keeps the RSSI from being clipped.
- Verification: `cargo check` (esp toolchain, vendored crates copied in) clean and warning-free for a DevKitC
  Designer project (classic UART0 console) and a T-QT one (USB-Serial-JTAG console); suite **1065**, goldens 6
  files (`main.rs` + `MainHeader.rs` on all three Designer boards).

## §155 — The T-QT's newer panel draws inverted (0.13.17, 2026-10-24)

- Reported: *"For the LilyGo device option — with the new version option — the display colours seem to be
  inverted (white is Black)"*. The T-QT asks which panel revision it has; the **GC9A01** (newer, 40 MHz) glass
  needs `ColorInversion::Inverted`, the **GC9107** (older, 27 MHz) does not, and both were emitted with the
  controller's default. That is a negative of the whole image, not a channel swap — which is how it was told
  apart from a `ColorOrder` mistake: a wrong order turns white into a colour, an inverted panel turns it black.
- **The flag is per panel, not per board** (`EspDisplay.invertColors`), because the same board has both glasses
  and only one of them is wired that way. The emission is `inversion(display)` in `generate/esp.ts`, beside
  `orientation(display)` and used at both builder sites (the diagnostic/designer one and the `display` one), and
  `mipidsiOptionImports(display)` adds `ColorInversion` to the options import **only** for a panel that uses it
  — an unused import would be a warning in every other generated project.
- Nothing can prove this from the outside: no compile, no datasheet. It stays catalogue data with a comment
  saying where it was observed, the same class as the CYD's X mirror and the missing touch controller.
- Verification: T-QT `display` and T-QT `designer` on the GC9A01 revision, `cargo check` with the esp toolchain
  (vendored crates for the designer), both clean and warning-free. Suite **1066** (new test: the flag, the
  builder line, and the import only where it is used); goldens did **not** move, because the t3 layer generates
  each board's *default* revision and that is the GC9107.

## §156 — The same glass also wanted BGR (0.13.18, 2026-10-24)

- Follow-up to §155, minutes later: *"colour inversion correct, but Red is Blue and vice versa. Green correct."*
  Green is the axis an RGB/BGR swap leaves alone, which is what identifies it — a swap moves red onto blue and
  back, and the 565 bit layout keeps the six green bits where they are.
- So the GC9A01 revision carries **two** facts: `invertColors: true` (INVERTON) *and* `colorOrder: 'bgr'`. They
  are not one setting seen twice: polarity turns white black, order turns white into a colour. Fixing only the
  polarity is what made the second one visible — the first report ("white is black") hid it, because with a
  fully inverted palette the swapped channels are also inverted.
- The test that pins both is `the T-QT newer panel is the one whose glass draws inverted, in BGR`: the flag,
  the emitted `.invert_colors(...)`, the emitted `.color_order(ColorOrder::Bgr)`, and the import only where it is
  used. The shared-wiring test no longer claims both revisions are RGB — that assertion is what would have hidden
  this class of bug.
- Bench project `~/Projekte/TestExtApps/lilygo-test2` patched by hand (its `main.rs` is written once) and
  `cargo check`ed; everything else is generator-side, so a new project gets it.




## §157 — Views: more than one screenful in one design (0.13.19, 2026-10-24)

- Asked for after the T-QT work: *"For when the user want to create more than 1 view in a WYSIWYG project, we
  need to implement a way for the user to design those additional screen views."* Proposal first (§ "Suggested
  first step"), then Phase 1 — model, emitter, canvas tabs, the `navigate` event.
- **The proposal's premise was wrong, and checking the crate is what found it.** I wrote that "the parser
  already reads `visible` per widget; `kdl.ts` just starts emitting it". It does not: the only `visible` in the
  grammar is an icon *part*'s flag. So views became a runtime fact instead — every widget is emitted as it
  always was, and `ui.rs` hides the ones whose view is not on show with `gui.set_visible` (→ `set_hidden`). That
  turned out to be the better answer anyway: **the markup is byte-identical for every design**, which is why the
  t3 goldens for `ui.kdl`/`ui.rs` did not move and why a single-view project is provably unaffected.
- What the runtime already had, verified before designing anything: `WidgetNode::hidden()`, `render` returning
  early for it, `pointer_hit` gating on `effective_visible` (so a hidden ancestor hides its children from a
  finger too), and `set_flag` calling `mark_subtree_dirty` **twice** — a view switch repaints without any help
  from the design's code. `interop/three_d.rs`'s cinematic carousel already used `set_hidden` this way.
- Document: `version: 3`, `views: [{id, label}]`, `widget.view` (absent = the first view). Additive, so a
  version 2 file loads and stays a one-view design — nothing is invented on load. Ids must be Rust identifiers
  and must not *become* the same variant (`view_1` and `view1` both become `View1`), which the validator says
  before `rustc` would.
- `ui.rs` for a multi-view design: `pub enum View`, a `view` field, start-up hiding of the views the design does
  not start on, `show_view(&mut self, View)` and `active_view()`. A one-view design emits none of it.
- `navigate`: the crate has no navigation event, so it rides on `Clicked` and the *extension* answers it —
  `EVENT_SPECS.navigate.action` names the property carrying the destination, `requiredHandlers` skips it (no stub
  is written), and `armsFor` folds it into one arm: `self.show_view(View::X)` and, if the widget's own `clicked`
  handler is also ticked, that call after it. Two arms matching `Clicked` would have meant the second never ran.
- **Bug found by compiling, not by testing:** the `View` enum was emitted at the anchor `pub struct Designer`,
  which put it *between* the struct's doc comment and its `#[allow(dead_code)]`. A no-touch board therefore lost
  that attribute and built with two dead-code warnings (`down` never read, `pointer`/`pump` never used) that a
  no-view project of the same board does not have. The enum now goes above the doc comment, and the test asserts
  `#[allow(dead_code)]\npub struct Designer {` as a literal.
- Panels: the tab strip lives in the stage (`.view-tabs` above the canvas); right-click renames or deletes, and
  the destination picker is a row in **Events**, not in Properties — a designer-only property that is also an
  event's destination would otherwise appear twice.
- Verified: two generated projects (ESP32-035 and DevKitC + ST7796), two views each plus a navigate button,
  `cargo check` clean and warning-free. Suite **1079** (t1 1000 · t2 75 · t3 4).


### §157a — the Phase 1 leftovers (0.13.20, 2026-10-24)

- **Start view is a flag, not a reordering.** `DesignerView.start` and `startViewId()` finds the marked one,
  falling back to the first. Reordering the array would have moved a tab under the cursor; the flag leaves the
  strip alone. `setStartView` clears the others in the same edit, and the validator reports a hand-edited file
  with two of them — `new()` could only follow one.
- **Duplicate view** copies a view and its widgets in place (no 8-pixel offset — a variant is the same layout).
  The widget names come from the *root* name (`title` → `title_2` → `title_3`), not from the whole id, or a copy
  of a copy would read `title_2_2`. The deep copy moved into `copyWidgetContents()` so `duplicateWidget` and
  `duplicateView` cannot drift apart on a new child kind. The copy never inherits `start`.
- **Overlay** draws other views' widgets as dashed outlines in `CanvasView.drawOtherViews`. Nothing else
  changes: hit testing and snapping still filter by the active view, so the ghosts cannot be clicked, and the
  t2 preview shape counts stay put because it is off by default.
- **`navigate` beyond clicks.** `EVENT_SPECS.navigate.action.triggers` lists the events a switch may ride on
  (`clicked`, `valueChanged`, `submitted`, in that order of preference), and `navigateTriggerFor(tag)` answers
  which one a given widget uses. `widgetRaises(tag, 'navigate')` follows it, so the panel offers the row on a
  dropdown or a keypad too; the emitter takes the *pattern* from that trigger's own spec, which is why a
  dropdown emits `UiEvent::ValueChanged(id)` and a keypad `UiEvent::Submitted(id)`.
  **Trap:** computing the trigger unconditionally dropped every ordinary arm — a button's own `clicked` arm was
  skipped because it was mistaken for the borrowed one. The suite caught it as three failures plus a stray
  `#[allow(dead_code)] pub widgets`; the trigger is only looked for when the widget actually navigates.

### §157b — the T-QT's unwritten edge (0.13.20, 2026-10-24)

- Reported after the colours were fixed: *"a blank row of pixels down the right edge and the bottom edge of the
  panel"* — the LilyGo T-QT, newer panel. The Designer canvas was fine, so it was the glass.
- **The experiment that settled it**: `display.clear(Rgb565::RED)` before the design, in the bench app. It
  cleared the whole 128×128 the driver thinks it owns, and **the band stayed noisy** — so those pixels are not
  merely unpainted by the design: nothing writes them at all. The band is random GRAM outside the window.
- So the glass is bonded **into the controller's RAM off the origin**: `display_size(128, 128)` at offset (0, 0)
  writes RAM 0..127 while the panel shows something further in. `Builder::display_offset(x, y)` moves the address
  window (not the logical coordinates, so no design moves).
- **(1, 1) was half right**, which is its own evidence: the bottom went clean and the right kept its band. A 1px
  frame drawn on the design's own edges (plain `embedded-graphics`, so neither crate nor design is involved) then
  measured the rest — frame present top/right/bottom, **missing on the left**, with the band sitting one pixel
  outside the frame's right side. That reads exactly as glass = **RAM 2..129 across, 1..128 down**: the frame's
  left side (RAM 1) falls outside, its right side (RAM 128) lands one column inside the band, and RAM 129 is the
  band. So the pair is `{ x: 2, y: 1 }`.
- mipidsi's `set_address_window` **swaps the offset pair itself** when the orientation swaps rows and columns (and
  mirrors it when columns or rows are reversed), so one answer holds for every rotation — no per-rotation table.
- Recorded as a panel fact, like `invertColors`/`colorOrder`: `EspDisplay.displayOffset`, emitted by
  `offset(display)` in both `main.rs` builder sites. Only the GC9A01 revision declares one; the GC9107, the CYD
  and the DevKitC modules are at the origin. Symmetric on purpose — a vertical rotation swaps the drawing area,
  and an unequal offset would need a per-rotation answer.
- **Why this was worth writing down**: mipidsi's GC9A01 model declares `FRAMEBUFFER_SIZE = (240, 240)`, so the
  driver's clamp is against 240×240 and never against our 128×128. A write one pixel outside the window is
  accepted silently, which is what makes an "unwritten edge" impossible to reason about from the code alone —
  the red fill answered in one flash what no amount of reading could.
- Verified: the emitted `.display_offset(2, 1)` compiles in a generated T-QT Designer project (`cargo check`,
  esp toolchain), and the bench app `lilygo-test2` builds with it.

### §157c — every terminal is closed before a build or a flash (0.13.21, 2026-10-24)

- Asked for in the user's own words — *"Kill all terminals open in the IDE before executing build or flashing.
  The open listener is blocking the port"* — after a flash died with "could not open the device", which reads as
  a hardware fault.
- A terminal **is** the port holder, and there are three kinds: the Designer's clock listener (kept for the life
  of the panel), Monitor and `probe-rs attach` (the port or the probe), and a shell where the user typed
  `espflash monitor` by hand (no record of ours at all). Only `vscode.window.terminals` covers the last one, so
  the sweep is over that list rather than over terminals we started.
- `killAllTerminals()` in `src/commands/terminal.ts`, called first in build, build-and-debug, build release,
  clean, flash and flash-from-BOOTSEL (`clearTerminals(what)`), with a log line naming what was closed and why.
  The flash no longer asks whether a Monitor terminal may be closed — it is already gone.
- The clock listener comes back when the flash ends (as before) or when the panel is reopened; a plain build does
  not restart it, because a build holds no port.

### §158 — pictures on the canvas, a `ui.rs` that waited for its markup, and a clock that must not tick off-view (0.13.22–0.13.24, 2026-10-24)

- **0.13.22 — the pair that must be written together.** `ui.kdl` is only written for a design that validates, but
  `src/ui.rs` was regenerated from the document regardless, and it names the widgets the markup builds. A save
  taken while the design was momentarily incomplete therefore left the project with an image widget in the Rust
  and none in the markup — `E0609: no field image on type RustyPanelWidgets`, met on a real project whose image
  asset had not been picked yet. `syncModule` now runs inside `if (rendered.kdl !== undefined)`, so the last good
  pair survives; the design *document* is still written either way, because it is the user's work.
- **0.13.23 — the canvas draws the project's pictures.** The webview cannot read files, so every image (and every
  part of a composite icon) was painted as a plain widget face: an empty box, and a view holding only a picture
  looked blank — reported as "the image does not load in the designer. Also, the view2 screen is not rendered at
  all", which was two separate faults with one symptom.
  - The extension reads what the design names and hands each file to the panel as a **data URL**;
    `imageSourcesOf()` covers image widgets *and* icon parts and skips `sd:` (the board fetches those), and a file
    over `MAX_CANVAS_IMAGE_BYTES` (1.5 MB) is not shipped through a message.
  - The **browser** decodes (`new Image()` → `decode()`), so BMP/PNG/JPEG/GIF/WebP arrive through one door and
    this codebase holds no image parser to get wrong. `webview/designer/bitmaps.ts` keeps the decoded bitmaps by
    source, `theme.ts` draws them with `fit` honoured (`stretch` fills the cell, `center` uses the file's size),
    and a source with no pixels yet draws a dashed frame in the selection colour **plus the file's own name**.
  - Measured in a real browser (the bundle, a stub of the VS Code API, the bench design): the canvas went from
    4 distinct colours on that view to 8 257 — the photograph, not a face. jsdom would not have caught either.
- **0.13.24 — a view that is not showing must not be driven.** Reported as *"black blocks are drawn at intervals
  of 1 second — could be the clock arm positions updating"*, which is exactly what it was.
  - `tick_clocks()` advanced **every** clock, visible or not. A hidden clock still moves, and its move marks the
    widget's subtree dirty; `paint_damage` then clears that damage to `SCREEN_BACKGROUND` and does not repaint a
    hidden widget — so a black rectangle appeared on the view that *is* on the glass, once a second, at the
    clock's own bounding box.
  - Each clock's second tick and each hand-over of the wall clock are now emitted behind
    `if self.view == View::<its own view>`, and only when `designViews(document).length > 1`, so a single-view
    design emits no test at all and the golden `.rs` fixtures stay byte-identical. The guard inside the
    `for _ in 0..elapsed` loop is placed *in* the loop, not around it — a long gap must still replay every tick.
  - Verified: two t1 tests pin the pair (guarded for a two-view design, absent for one view), suite **1094**
    (t1 1013 · t2 77 · t3 4), and the bench app `lilygo-test2` was regenerated from its design and `cargo check`s
    clean.
- **Trap, twice in one session:** a multi-line `replace_string_in_file` silently dropped a line of TypeScript
  (the `widgetViewId` import, and earlier a field declaration). The edit reports success. Run
  `npx tsc -p ./` immediately after any multi-line replacement — the missing name shows up as `TS2304` at once.

### §159 — Rust Assist, a chat that wraps, and a radio button that keeps its name (0.13.25–0.13.30, 2026-10-25)

- **Rust Assist is a second way to *ask*, not a second assistant.** A radio pair above the log posts
  `setMode`, and `enableRustAssist()` installs one `onDidChangeTextDocument` listener. On every change it looks
  at the lines the edit touched, in the **active** editor only, in a `.rs` file only, for
  `/^\s*\/\/~\s*(\w+)\s*$/`; a match turns into an ordinary assistant turn — `remember()`, `postChats()`,
  `post({ type: 'turn', … })` — so the conversation, the chat file, the restored history and the
  *Implement … in the project…* button under the answer all work because nothing about the turn is special.
  - The trigger is **a comment you type at the caret**: no panel focus, no keybinding, and `//~` is inert to
    `rustc`. `rustAssistExamples(keyword)` is a plain function returning markdown with one fenced block, so the
    examples are data, not generated text — `let` spells out every data type, `loop` puts the four loop shapes
    side by side.
  - Rust Assist refuses to arm while AI Assist is off and says why in `#status`; a mode that silently does
    nothing reads as a broken editor. **Known gap:** the chosen mode is not part of the settings snapshot, so a
    reloaded window comes back on Full Assist.
- **The terminal sweep was too wide (0.13.21 → 0.13.29).** Closing *every* terminal before a build also killed
  the user's own shells and the AI chat terminals. Only the port-holders matter, and they name themselves:
  build/flash now close the Build and Flash terminals (and still Monitor and `probe-rs attach`), and a hand-run
  `espflash monitor` shell is the user's to close.
- **The chat wraps because `pre` was the last thing that did not.** Measured in a browser with the real CSS and
  DOM: prose, long URLs and unbroken tokens already ended at `scrollWidth === clientWidth`, but a fenced block
  kept `white-space: pre` plus `overflow-x: auto`, so one long Rust line scrolled the whole conversation
  sideways. `.turn pre` is now `pre-wrap` + `overflow-wrap: anywhere` (wrapped lines keep their indentation),
  `.error` and `#status` carry `anywhere` as well, and every turn, every block and the log itself meet
  `scrollWidth === clientWidth` at 709 px **and** at 320 px.
- **The mode radios were a width rule away from being right.** `textarea, input, select { width: 100% }` gave
  each radio the whole row, so the button sat alone on its own line and its name started at the far left.
  `#assistMode input { width: auto }` plus a column-flex label (`align-items: center`) puts the name centred
  directly beneath its own button — measured: centre offset 0 px (rounded), 2 px gap, row height unchanged.
- **Trap: the `<style>` block is inside a TypeScript template literal.** A backtick inside a CSS comment ends
  the literal; `tsc` then reports `TS1005: ';' expected` and a second error on the same line, which reads like a
  CSS syntax error in a file that has none. Write CSS comments without backticks, and quote selectors in plain
  words instead.

## §160 — The AI Assist sees what the editor sees, and a stray character teaches it to stop (0.17.x, 2026-10-31)

One session, driven by what the bench actually did. Everything below is in `src/ai/**` and `src/ui/aiChatView.ts`
unless it says otherwise; the release that carries it is **0.17.13** (see CHANGELOG).

**What was built, in the order it was asked for.** The chat now follows the newest row, reads the *selection*,
reads the **Problems pane** and the **Debug Console**, has a **Console only** switch, sends on **Enter**
(Shift+Enter newlines), shows `Model loaded and active` once a model has answered, and has an **Abort** button. A
`Fix this line` quick fix asks for **one line** instead of a whole function.

**The traps, in the order they bit.**

- **The 200-token budget was only meant for one request, and the rescue quietly removed it.** `chatWithRescue`
  retries after starting a `llama-server` by calling `configWithEndpoint(assistantConfig())` — fresh settings, so
  the caller's `maxTokens`/`temperature` were replaced by the panel's 5120. The retry now takes the *address* from
  the fresh settings and keeps the *request's* answer shape. Anything that caps a request must be re-applied at
  the retry, or it is not a cap.
- **A prompt's *voice* beats its user message.** The first `buildLineFixPrompt` reused the whole-item
  `systemMessage()` — "you return complete, compilable Rust … you keep the function's attributes, signature and
  indentation" — and asked for one line in the user message. The model answered with the function. A line fix
  needs `lineSystemMessage()`, and that message must not contain the words *signature* or *attributes* at all.
  The same lever, on the other side: the chat's own prompt *demands* the item whole, which is why the chat will
  never produce a minimal diff, and should not (a partial item cannot be applied safely).
- **`max_tokens` is part of the instruction.** With 4096 available a model may rewrite a function; with 200 it
  cannot. `temperature: 0` on that request as well — no sampling noise, no wandering.
- **The failure that started it: a model answering with the *quote* of a line.** Asked about a stray `9`, it
  replied `async fn main(spawner: Spawner) {9` and then the "fixed" function with
  `// ... rest of the function remains unchanged`. `chatCodeProblem` missed both (no placeholder it recognised,
  not a whole file), so the quote replaced the real 102-line `main` with one line. `unbalancedAnswer()` is the
  missing rule: balance `{}`, `()` and `[]` through `stripTrivia`, refuse what does not close, and label such a
  block `(excerpt)` on its button. Verified on the user's own `src/main.rs` (246 lines): the quote → refused,
  the complete block → 246 lines, byte-identical.
- **A refusal with one button is a dead end.** Three ways out, in the order a user wants them: *Apply the
  complete block* (found by `completeAlternative` in the same answer), *Fix just that line* (the compiler's own
  first error), *Ask for it in full* (`retryQuestion` — names the item, forbids placeholders, says what leaving
  code out costs).
- **`addItemToFile` with an empty item inserted three blank lines** (`insertItem` adds a blank either side of
  nothing). A `use`-only answer now skips the item insertion entirely.
- **"Loaded" is not only what LM Studio says.** `Discovery.loaded` knows nothing about a `llama-server` or any
  other OpenAI-compatible endpoint, so the status line said `not in memory yet` after a whole conversation.
  `noteModelAnswered`/`answeredHere` record the answer itself, and `ask()` redraws the status line when a reply
  arrives — the line had only ever been drawn on open and on save.
- **Reading a pane.** Problems is `vscode.languages.getDiagnostics()` (a read, not a scrape). The Debug Console
  is a `DebugAdapterTracker` (`event: output|stopped|exited`), registered at activation because a tracker sees
  nothing that happened before it attached, and filtered to `probe-rs*` sessions. Output is only readable when
  the extension owns it (`log()` buffers what it wrote). The **Terminal** has no API at all; the honest route is
  a captured process (`buildProject`), and shell integration needs `engines.vscode` 1.93.
- **`#log` was `flex: 1 1 auto`**, so the log sized itself from the transcript and the *page* grew instead —
  the newest row could sit below the visible area while `scrollTop` was at its maximum. `flex: 1 1 0` makes the
  log the element that scrolls. The follow rule is "a decrease in `scrollTop` is the reader moving up", never
  "is it at the bottom now" — content growing leaves `scrollTop` alone, so the second rule reads an answer
  arriving as a scroll away and stops following exactly when it matters.
- **The model's own answers are the best test corpus.** Every guard here was checked against the transcripts in
  `globalStorage/grumpy.grumpy-rusty-platform/ai-chats.json` and the user's real `main.rs`, not against invented
  answers — which is how the quote-vs-function distinction became a rule instead of a guess.

**Known gaps left deliberately:** Rust Assist's radio state is not in the settings snapshot (a reloaded window
comes back on Full Assist), `#status` is redrawn per answer rather than per token, and the line fix refuses a
multi-line answer instead of trimming it — that is a different request, and the function-level fix is the one
that can carry it.

**Traps that bit twice in this session, both mine.** A backtick inside a CSS/JS comment inside the
`html()` template literal ends the literal (TS1005 on a line with no CSS in it) — this is now the second NOTES
entry about it, so quote selectors in plain words. And `replace_string_in_file` whose `oldString` ends with a
newline and whose `newString` does not will **glue the next line onto the previous one**; always re-read the
edit, and let `tsc` catch the ones that break syntax.

## §161 — The keypad's Shift: one letter, then a lock (0.17.14, 2026-10-31)

Asked for in two sentences: *"Toggling to upper case must only persist for one typed character, then revert back
to lower case"* and *"Double tapping the SHIFT key must act like a 'Shift-Lock' key."*

**The widget had one bit and needed two.** `shift: bool` was a plain toggle (= caps lock). It now has three
states — off, one shot, locked — with `shift` as "capitals now" and a private `shift_locked` beside it:
`press_shift()` is off → once → locked → off, and `consume_shift()` turns a **one-shot** off after a character
is typed while leaving a lock alone. `toggle_shift()` stays as the old name, so a design's own code compiles.

**No clock is needed, and that is the design, not a shortcut.** A `no_std` widget has no time source, so "double
tap" is defined as the second tap arriving **while the one-shot is still unspent** — which is exactly what a
double tap is when nothing was typed in between. If a pause should cancel it, the context already has the
plumbing (`pointer_double_window_ms` in `tick_input`), but that would mean a per-widget tick for a case nobody
has asked for.

**Where the state is spent: the context, not the widget.** `KeypadKey::Char(_)` and `Space` call
`pad.consume_shift()` in `context/input.rs` **after** pushing the character, because typing is the event — the
crate's widget never sees a key release on its own. `key_lit(Shift)` is true in both shifted states: the face
colour is the only room there is for a state, and the letters already say which case they will type.

**A design's `shift` property is a lock.** `with_shift(true)`/`set_keypad_shift(true)` now set the lock, not the
one-shot: the property means "letters start in upper case", and a start state is not one letter. `set_shift_locked`
is the one setter for both fields, so the two cannot disagree.

**Tests moved with the behaviour.** The old `caps_lock_stays_on_and_the_letters_say_so` pinned "typing does not
consume it" — the opposite of what was asked for — so it became `one_shift_tap_capitalises_exactly_one_letter`
and `a_second_shift_tap_locks_capitals_until_it_is_tapped_again`, and the touch-path test in `input.rs` now
walks both states through real taps. `cargo test` on the crate: 324 tests (334 with `--all-features`), all green.

**How a project gets it.** The crate is vendored into `codegen/embedded-gui` and carries a
`.rusty-platform-crates` marker with the extension version; the Designer offers **Update Crates** when the
marker is not the running extension's, so installing this version and opening the Designer is the whole upgrade.

## §162 — Decided: an Arduino (C++) backend beside the Rust one (plan only, 2026-10-31)

**Status: agreed, not started.** No code exists for it. The plan is `plans/arduino-backend.md`, and the six
questions that shaped it were answered the same day:

1. **Both cores** — `rp2040:rp2040` (arduino-pico) and `esp32:esp32` from the first C++ release; AVR later.
2. **LVGL 9.x**, the most popular choice for this job; the exact minor is pinned on the bench, not floated.
3. **`lv_keyboard`'s SHIFT already meets the rule** we built into the Rust keypad in §161 (one tap = one
   character, double tap = lock), so the C++ side uses the widget as it comes and keeps **no** custom state
   machine. Rust keeps its own three-state logic; the two must agree only in behaviour.
4. **SD images are in scope** (phase 4): a filesystem driver *and* file-backed `lv_image`.
5. **A C++ set of `//~` examples** as well as the Rust ones.
6. **Plainly in the wizard** — language is step one of New Project; no experimental setting.

**Why it is a backend and not a fork:** the shell (commands, views, settings, chat, panes, packaging, backup,
Wi-Fi) is language-free, the Designer canvas is language-free, and only five seams know the language — the
board profile and the wizard, the generator, the Designer's emit step, toolchain/flash, and the AI's prompts and
guards. The 45 k lines of `embedded-gui` are replaced, not ported, because C++ has LVGL.

**How to abandon it, which is the point of writing this down:**

| where | what to remove |
|---|---|
| `plans/arduino-backend.md` | the plan (its *Status* section carries this same recipe) |
| `NOTES.md` §162 | this entry |
| `/memories/repo/arduino-backend.md` | the repository memory entry |
| `/memories/rusty-platform.md` | the note at the top of that file, which points at the plan |
| `README.md`, `USER_MANUAL.md`, `AI_ASSIST.md` | untouched until the phase that makes the feature real, so there is nothing to unpick |

Nothing is committed per phase yet. When phases start, each one is its own commit, and abandoning it is
`git revert <phase-1>..<phase-n>`: phase 1 puts the Rust code behind the `SketchBackend` interface **with no
behaviour change**, so reverting it restores the previous shape, and later phases only add files
(`src/generate/arduino*`, `src/designer/lvgl*`, `src/ai/cpp*`). A project record that ends up carrying
`language "rust"` needs no migration — a record without the field is already Rust.

## §163 — Phase 1 of the C++ backend: the language seam, with nothing visible (2026-10-31)

Plan: `plans/arduino-backend.md`. This is the phase that proves the promise "no behaviour change": the whole
t1 layer (**1116** checks, ten of them new) and the 4 goldens pass, and every generated file is byte-identical
to what the shipped generator writes.

**What was added**

- `src/project/language.ts` — `SketchLanguage`, the marker file's name, and `readProjectLanguage`.
  **A project with no marker is Rust.** Missing, empty, malformed or unrecognised text reads as Rust: a marker
  nobody can parse must not make a working project invisible, and Rust is what every such project is.
- `src/generate/backends.ts` — `SketchBackend` (`id`, `label`, `detail`, `markerFile`, `templatesOfferedFor`,
  `defaultTemplateFor`, `files`, `handlersPath`, `panelPath`), `rustBackend` (every member a delegation, not a
  copy), `BACKENDS`, `availableBackends`, `backendFor` (throws for an unregistered language — a call-site bug),
  `backendOrDefault` (cannot throw; reads a project), and `projectFiles` (a backend's files **plus** the marker
  for a non-default language).
- `ActiveProject.language`, and project-ness is now "the backend's marker file is there" instead of a
  hard-coded `Cargo.toml`. `cargoToml` stays the board's source; it is empty for a language whose marker is
  another file, which is a project with no board rather than a crash.
- The wizard asks the language **first**, then passes it to `pickTemplate` and `projectFiles`.

**Decisions taken while doing it, and why**

1. **The marker is `rusty.project.json`, not `project.kdl`.** `project.kdl` is the *designer's screen manifest*
   (it anchors asset paths) and exists only in designer projects, so it cannot be the thing that says what a
   blinky project is written in. JSON because the reader is then `JSON.parse` and no KDL parser, no new file
   format and no dependency on the designer's own syntax.
2. **The marker is only written for a language that is not the default.** Rust needs no file to say it is Rust;
   writing one into every generated project would change every file list, every golden and every existing
   project's tree for no gain. What "no marker" means is decided in exactly one place.
3. **The language step appears only when more than one backend is registered.** A question with one possible
   answer is a step nobody can get wrong and nobody should pay for, and phase 1 must not add a click to the
   wizard. Phase 2 registers `arduinoBackend` and the step shows up by itself.
4. **`handlersPath`/`panelPath` are pinned by a test, not yet used by the Designer.** The emitter is phase 4;
   having the accessors on the interface now means phase 4 changes where they are read, not what exists.

**Abandoning phase 1** is `git revert` of its commit: it added two modules and one test file, added one field,
and the wizard's three call sites. Nothing in the generated files, the goldens or on disk moved.

## §164 — Phase 2 of the C++ backend: the generator, compiled on both cores (2026-10-31)

Plan: `plans/arduino-backend.md` §"The C++ side in detail". Phase 1 was the seam (§163); this is the first
phase that writes C++.

**What is there now**

- `src/generate/arduino.ts` — the whole C++ side: `CPP_FQBN` (board id → FQBN), `fqbnFor`,
  `templatesForArduino`/`defaultTemplateForArduino` (blinky, display, designer), `sketchNameFrom`, and
  `generateArduinoProjectFiles`.
- `arduinoBackend` registered in `src/generate/backends.ts`, which is what makes the wizard's **language
  question appear** and what writes `rusty.project.json` (`{"language": "arduino"}`) into a C++ project.
- The wizard uses `backend.folderName(...)` (a sketch's folder and `.ino` must share one identifier, so
  `blinky-pico` becomes `blinky_pico`) and no longer offers the Rust-only extras to a C++ project
  (CYW43 blobs, `ensureEspToolchain`, vendored crates, "Build Now").
- `src/commands/withProject.ts` refuses build/monitor/edit for a non-Rust project with one clear message
  instead of letting cargo fail on a missing `Cargo.toml`. That is the whole of phase-2's command surface.

**A generated C++ project** (root = the sketch folder): `sketch.yaml` (the FQBN, so no command needs
`--fqbn`), `<name>.ino` (three lines; Arduino requires it and it only includes `src/main.h`),
`src/main.h`, `src/main.cpp` (`setup()`/`loop()`), `src/panel.{h,cpp}` for the two panel templates,
`src/ui.{h,cpp}` + `src/ui_handlers.{h,cpp}` for the designer, `README.md`, `.gitignore`, and the marker.
**No libraries at all**: phase 2 draws with the panel driver directly, so a freshly installed core builds
every template. LVGL is phase 4 and replaces `ui.cpp`'s body, not the file's shape.

**Verified for real, not just by snapshot** — `arduino-cli` 1.5.1 with `rp2040:rp2040@6.3.1` (arduino-pico)
and `esp32:esp32@3.3.12`, every board in the catalogue compiling at least one template:

| board | FQBN | what compiled |
|---|---|---|
| Pico | `rp2040:rp2040:rpipico` | blinky, display, designer |
| Pico W | `…:rpipicow` | display |
| Pico 2 | `…:rpipico2` | designer |
| Pico 2 W | `…:rpipico2w` | blinky |
| ESP32-DevKitC | `esp32:esp32:esp32` | blinky, display, designer |
| LilyGo T-QT | `esp32:esp32:esp32s3` | designer (GC9107 panel) |
| ESP32-035 | `esp32:esp32:esp32` | display (ST7796) |

Test layers: t1 **1137** (20 of them new in `arduino-generate.test.js`), t2 87, t3 **7** (182 new C++
snapshots in `tests/layers/t3-golden/__snapshots-cpp__`, a tree of its own so neither language's orphan check
can see the other's).

**Two traps the real compiles caught, both invisible to the tests**

1. **`SPI.setSDA` does not exist on arduino-pico.** Its `SPIClassRP2040` names the pins after I2C —
   `setTX` is data out, `setRX` is data in, `setSCK` the clock — while the ESP32 core takes all four in
   `begin(sck, miso, mosi, ss)`. A stub-header `g++ -fsyntax-only` pass cannot see this; only the installed
   core can. The generated file now names the bus once (`auto &panelSpi = SPI | SPI1`, chosen by the wiring's
   own `bus` field) and configures it per family.
2. **A backtick inside a template literal silently truncates the generated file.** Writing `` `auto` `` in a
   generated *comment* ended the TS template early; `tsc` still succeeded and the emitted `panel.cpp` stopped
   mid-file (line 41 of 254). Same trap as `aiChatView.ts` in §160. The rule stands: **no backticks inside a
   template literal, not even in prose**, and a generated file's *length* is worth checking, not just its
   contents.

**Not done, deliberately:** no arduino-cli detection/install/build/upload/monitor (phase 3), no LVGL or
Designer emitter (phase 4), no C++ AI prompts (phase 5), no version bump and no packaging — the installed
extension is still 0.17.14 and knows nothing about C++ until the next release.

## §165 — 0.18.1: the editor could not read a sketch, and the C++ template promised a canvas (2026-10-31)

Both reports from the first bench run of 0.18.0 (`Cpp_pico2w_test1`, `Cpp_pico2w_wysiwyg_test1`).

**"Include errors."** A sketch's headers are not anywhere the C/C++ extension looks: `Arduino.h` lives in
`~/.arduino15/packages/<pkg>/hardware/<arch>/<ver>/cores/...`, `SPI.h` in that core's own `libraries/SPI/src`,
and the flags that go with them (`-DUSBD_PID=...`, `-march=armv8-m.main+fp+dsp`, `-iprefix`) come from
Arduino's build recipes. Nothing a hand-written `includePath` can keep up with. The one description that is
exactly right is the compiler's command line, and arduino-cli writes it in about a second:

    arduino-cli compile --fqbn <fqbn> --only-compilation-database --build-path .arduino/build

- `src/generate/arduinoIntelliSense.ts` (pure) — `fqbnFromSketchYaml`, `intelliSenseConfig`, and the two paths.
- `src/toolchain/arduinoIntelliSense.ts` — finds `arduino-cli` (PATH, then `~/.local/bin`, `~/bin`,
  `~/.arduino15/bin`, the macOS/Windows install spots), runs that command with a 120 s ceiling, writes
  `.vscode/c_cpp_properties.json` pointing `compileCommands` at the database. Never throws: `written`,
  `no-cli`, `no-fqbn` or `failed`, each with one line in the log.
- The wizard runs it after writing a C++ project's files; **`Arduino: Refresh C++ IntelliSense`**
  (`rustyPlatform.arduino.refreshIntelliSense`) is the button for later, and what a project made by 0.18.0
  needs once.
- `.arduino/` is in the generated `.gitignore`: the database is ~200 entries of absolute paths, rebuilt on
  demand, and must not be committed.

Verified on the user's own two projects: `compile_commands.json` has 196 entries and `src/ui.cpp` is compiled
with `-I …/cores/rp2040`, `-I …/variants/rpipico2w`, `-I …/libraries/SPI/src` — which is what makes both
`Arduino.h` and `SPI.h` resolve.

**"I don't see the WYSIWYG designer."** They were right, and the fault was my label: the C++ `designer`
template was called **"WYSIWYG designer (skeleton)"** while the canvas is Rust-only until phase 4. It is now
**"Designer screen (no canvas yet)"**, with a description that says the editor, the events and LVGL are not
wired for C++ yet. `state.ts` also stops offering the Designer (sidebar row and command) for a project whose
language is not Rust — a button that cannot work is worse than no button.

t1 **1143** (6 new for the config and the FQBN parse), t2 87, t3 7 (C++ snapshots refreshed for the template
text and the `.gitignore`). 0.18.1 packaged (1,551,681 B, sha256 `a95fb5a4…`) and installed.

## §166 — Phase 3 (arduino-cli build/upload/monitor) and the LVGL foundation for the C++ designer (2026-10-31)

**Phase 3 is in.** `src/toolchain/arduinoCli.ts` finds `arduino-cli` (PATH, then `~/.local/bin`, `~/bin`,
`~/.arduino15/bin`, the macOS/Windows spots), reads its version, its installed *cores* (an index entry with no
version is not an install) and the ports. `src/toolchain/arduinoBuild.ts` owns the exact command lines and the
diagnostics; `src/commands/arduinoCommands.ts` runs them and Build/Upload/Monitor/Clean route there when
`project.language === 'arduino'`.

Things worth not rediscovering:

- **`--build-path .arduino/build` matters for diagnostics.** arduino-cli compiles a *copy* of the sketch; in a
  temp folder every error names `/tmp/…/sketch/src/ui.cpp`, which the Problems pane cannot open and which the
  next build overwrites. Pointing the build path inside the project puts the copy at
  `.arduino/build/sketch/…`, and `projectPathOf()` maps that back to the real file.
- **Two diagnostic formats.** `--format json` has structured `builder_result.diagnostics` (severities,
  locations); the linker, picotool and a core's own tools only print `file:line:col: error: …`. Both are
  collected and de-duplicated on file+line+severity+message.
- **Upload uses `--input-dir build`**, so it uploads exactly what Build produced instead of rebuilding into a
  fresh directory.
- The build offers `arduino-cli core install <core>` (and `lib install lvgl` for a designer project) in a
  terminal rather than doing it silently: both are large downloads.

**Phase 4's foundation is in; the canvas itself is not.** A designer project now carries:

- `lv_conf.h` at the project root — RGB565, 64 KB heap, no OS, montserrat 14/16 — because LVGL 9 looks for its
  config two levels above its own header unless `LV_CONF_INCLUDE_SIMPLE` is defined, and *then* looks for it on
  the include path. That flag plus `-I<project>` is what our build passes (`compiler.c.extra_flags` **and**
  `compiler.cpp.extra_flags` — the library's own C files need it too, which is the part that cost an hour), and
  the generated README shows the same command for a terminal build.
- `src/lvgl_display.{h,cpp}` — `lv_init()`, one display, a 320x20 band buffer, a flush callback that hands
  pixels to the new `panel_blit()` (raw RGB565 straight to the panel, no conversion), and `lv_tick_set_cb(millis)`.
- `src/ui.cpp` as an LVGL object tree (title bar + button + event) instead of the hand-drawn screen; the button
  calls `on_screen_tapped()` in `src/ui_handlers.cpp`, which is the append-only file a person owns.

Verified: the generated designer project compiles for **rp2040:rp2040:rpipico2w** against **LVGL 9.6.0**
(551,196 B flash / 151,160 B RAM). `LV_COLOR_DEPTH` is deprecated in 9.6 — `LV_COLOR_FORMAT_DEFAULT
LV_COLOR_FORMAT_RGB565` is the setting that matters, the depth macro is only there for older 9.x.

**What is still missing for "a WYSIWYG C++ project", in order:** the Designer does not yet open a C++ project
(`src/designer/editor.ts` is Rust-shaped: it writes `ui.kdl` + `ui.rs`, syncs handlers as Rust, edits
`Cargo.toml` for rotation and the SD feature, and copies the vendored crates). That needs a per-language save
path — `emitUiCpp(document)`/`emitHandlersCpp` in `src/designer/lvgl.ts`, `DESIGNER_FILES` per backend, the
panel rewritten from `designer/panel.hardware.json`, fonts as `lv_font_t` C arrays, and images as
`lv_image_dsc_t`. Then phase 5 (C++ AI prompts/guards) and phase 6 (clock, packaging, docs).

## §167 — The C++ Designer: it opens, saves and builds (0.18.2, 2026-10-31)

**What changed**

- `src/designer/lvgl.ts` — the design document as LVGL C++: one container per view (the ones not on show hidden),
  one LVGL object per widget, callbacks named `on_<widget>_<event>` (the *Rust* names, from `EVENT_SPECS`), and
  `navigate` becomes `ui_show_view("...")` with no handler at all. `syncHandlerStubsCpp` appends a stub per new
  event and prunes one only while its body is still exactly the stub this wrote (the marker is the
  `Serial.println("<name>");` line), so deleting a widget never deletes somebody's code.
- `editor.ts` — the save path branches on `sketch.yaml`: a sketch writes `src/ui.cpp`, `src/ui.h`,
  `src/ui_handlers.{h,cpp}` and no `ui.kdl`; a crate is untouched. `syncRotation` is skipped for C++ (its
  rotation lives in `panel.cpp`'s MADCTL bits, written at creation).
- `generate/arduino.ts` — a designer project is born with `designer/panel.ui.json` (the *Rust* format, which
  is what makes one canvas serve both) and, on a Pico, `designer/panel.hardware.json`. `ui.h` now comes from
  `emitUiCppHeader()` so the wizard and the Designer cannot disagree about it.
- `state.ts` — the Designer is offered for both languages again.

**Proven on the bench, not just by test:** the starter design (a label and a button) emitted through
`emitUiCpp` compiles for **rp2040:rp2040:rpipico2w** against LVGL 9.6 (551,612 B), and a hand-built
multi-view design with a button, a slider, a toggle, a dropdown and a `navigate` compiles too (553,284 B).

**Known gaps, in the order they matter for a real design:** fonts and images are not emitted as LVGL assets
(`lv_font_t` / `lv_image_dsc_t`); `clock` and the extension's own drawing widgets (chart, plotter, mesh, path,
status_bar, ...) are *reported* rather than drawn; the Designer does not yet rewrite `src/panel.cpp` from
`designer/panel.hardware.json`, so moving a pin in the Hardware panel does not move it in the sketch; and the
canvas's own load path has not been exercised on a C++ project on the bench yet (the save path has).

t1 **1164** (10 new in `designer-lvgl.test.js`), t2 87, t3 7.

## §168 — The C++ panel follows the Hardware panel (0.18.3, 2026-10-31)

`emitArduinoPanel(wiring, rotation)` in `generate/arduino.ts` is the C++ twin of the Designer's `emitPanelRs`, and
`syncPanelRs()` now writes `src/panel.{h,cpp}` for a sketch from `designer/panel.hardware.json`. **One source of
pins for both languages**: the Hardware panel edits the wiring file, and whatever it says is what the sketch
compiles. Before this, a pin moved in the canvas stayed at its old GPIO in `panel.cpp` — the exact class of bug
the Rust side hit on 2026-10-24 (NOTES §158) and now cannot happen on either.

t1 1164, t3 7. 0.18.3 packaged and installed.

**Still open for C++ parity, in the order they block a real design:** fonts as `lv_font_t` and images as
`lv_image_dsc_t` (today a design's custom font falls back to Montserrat and an image is *reported*); the `clock`
widget and the extension's own drawing widgets (chart, plotter, mesh, path, icon, status_bar, content_indicator,
crumbs, carousel, dialog, table, busy_wheel, scale, spinbox, number_picker, time_picker) which are reported
rather than drawn; then phase 5 (C++ AI prompts and answer guards, the `//~` example set) and phase 6 (clock
parity, `.deb`, the user docs).

### 169. The first sketch that never built: two write paths, one design

The C++ report after 0.18.10 was a real compiler error, which was progress: `'on_screen_tapped' was not
declared in this scope` in `src/ui.cpp` of a project the wizard had just made. Two separate faults, both of
them the same shape -- *a file written from one idea while the file beside it was written from another*.

1. **The generator's own skeleton vs. the Designer's emitters.** `generate/arduino.ts` carried a hand-written
   `uiSource()`, `handlersHeader()` and `handlersSource()` that called `on_screen_tapped()`. The Designer's save
   rewrote `ui_handlers.h` from the *design* (`emitHandlersCppHeader`), which declares `on_go_clicked()` and
   nothing else. So the header lost the hook the screen still called. The three hand-written emitters are gone;
   the four Designer files now come out of `emitUiCpp`, `emitUiCppHeader`, `emitHandlersCppHeader` and
   `emitHandlerStubsCpp` **of the starter design written a few lines above**, so a project is born consistent
   and can never disagree with its own `panel.ui.json`.
2. **`syncModule` was gated on markup.** `save()` ran `await this.syncHandlers(document)` unconditionally and
   `await this.syncModule(document)` only `if (rendered.kdl !== undefined)`. A C++ project has no `ui.kdl` --
   the comment right above says so -- so `src/ui.cpp` was *never* rewritten on a save while the handlers were
   rewritten every time. The gate is now `rendered.problems.length === 0`, which is the same predicate for
   Rust (`kdl` exists iff no problems) and the correct one for a sketch.

**Tests.** t1 gained "every handler ui.cpp calls is declared, so a fresh project compiles": for every board it
emits a designer project and checks both directions (called-but-not-declared, declared-but-never-called). The
t3 C++ snapshots were regenerated. 1171 / 87 / 7.

**Lesson to keep:** when two files are generated, generate both from the same input in the same place. A
hand-written starter next to a generated file is a mismatch waiting for its first save; and a guard that reads
one language's artefact (`kdl`) silently disables the feature for the other.
