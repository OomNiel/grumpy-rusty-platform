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

1. **Debug Probe firmware < 2.2.0.** probe-rs refuses to open the probe.
   Fix: hold BOOTSEL on the Debug Probe while plugging it in, then copy
   `debugprobe.uf2` from `raspberrypi/debugprobe` release **v2.3.1** onto the
   `RPI-RP2` volume. Until then `t5-hil` and Flashing cannot be verified on hardware.
2. **udev rules.** `/etc/udev/rules.d/99-picoprobe.rules` exists but only covers
   `2e8a:000c` with mode 0666. The extension offers to install a broader
   `69-probe-rs.rules` (uaccess + common probe vendors).
3. **Phase 3** — crates.io Library Manager (bundled curated catalog + live search).
4. **Phase 4** — verify the emitted `probe-rs-debug` launch config against the installed
   `probe-rs.probe-rs-debugger` extension (schema already matches its `package.json`).
5. **Windows** — installer paths are platform-aware but untested; `probe-rs` needs
   WinUSB/libusb handling that differs from Linux.
6. Consider `debugprobe_on_pico.uf2` / `debugprobe_on_pico2.uf2` as a "turn a spare Pico
   into a probe" feature in a future Device Manager.
