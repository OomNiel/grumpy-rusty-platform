# Grumpy's Rusty Platform for VS Code

Embedded Rust development for **Raspberry Pi Pico** boards, with a PlatformIO-style
experience on top of [Embassy](https://embassy.dev) and [probe-rs](https://probe.rs).

> Status: **early scaffolding (v0.0.1)**. The project generator, toolchain detection,
> one-click installer and the Build/Flash/Monitor commands work. The crate Library UI
> and the deeper debug integration are not implemented yet.

## What works today

| Area | State |
|---|---|
| Project Wizard (board → working workspace) | ✅ RP2040 + RP2350 |
| Generated workspace: `Cargo.toml`, `.cargo/config.toml`, `memory.x`, `build.rs`, `rust-toolchain.toml`, `src/main.rs`, `.vscode/{settings,launch}.json` | ✅ |
| Toolchain detection (cargo, rustup, targets, probe-rs, probe health) | ✅ |
| One-click installer (rustup, targets, prebuilt probe-rs with SHA-256 check, udev rules) | ✅ |
| Status bar: Build / Flash / Monitor | ✅ |
| Boards + Project side views | ✅ |
| Layered test suite | ✅ 88 hermetic + 2 end-to-end |
| crates.io Library Manager | ⬜ Phase 3 |
| probe-rs debugger integration | ⬜ Phase 4 (schema already emitted in `launch.json`) |
| Windows support | ⬜ later (installer URLs are already platform-aware) |

## Quick start

```sh
npm install
npm run compile          # tsc -> out/
node tests/runner.js     # hermetic suite (t1 + t2 + t3)
```

To exercise the extension itself, open this folder in VS Code and press <kbd>F5</kbd>
(Run Extension Development Host).

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
| `t1-logic` | Board matrix, generator, crate/binary naming, parsers, install planner |
| `t2-cli` | Toolchain detection against fake `cargo`/`rustup`/`probe-rs` shims (real processes) |
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

## Documentation

Developer notes, verified version pins and hard-won traps live in [NOTES.md](NOTES.md).

## License

MIT — see [LICENSE](LICENSE).
