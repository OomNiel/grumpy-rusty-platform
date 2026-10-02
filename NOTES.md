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

---

## 4. Open items

1. **Debug Probe firmware.** Support landed (see §7). The probe on the desk still needs
   the physical button press, so `t5-hil` stays unverified until that happens.
2. **udev rules.** `/etc/udev/rules.d/99-picoprobe.rules` exists but only covers
   `2e8a:000c` with mode 0666. The extension offers to install a broader
   `69-probe-rs.rules` (uaccess + common probe vendors).
3. **Wireless (Pico W / Pico 2 W)** — decisions locked, implementation is the next task.
   See §8.
4. **Phase 3** — crates.io Library Manager (bundled curated catalog + live search).
   Explicitly *after* Debug Probe support, per the user's ordering.
5. **Phase 4** — verify the emitted `probe-rs-debug` launch config against the installed
   `probe-rs.probe-rs-debugger` extension (schema already matches its `package.json`).
6. **Windows** — installer paths are platform-aware but untested; `probe-rs` needs
   WinUSB/libusb handling that differs from Linux.

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
  a probe is usable right now.
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


