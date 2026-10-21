# Grumpy's Rusty Platform

Embedded development for **Raspberry Pi Pico** and **ESP32** boards in **Rust** using [Embassy](https://embassy.dev) and [probe-rs](https://probe.rs).

## Features

- **Project Wizard**: Support for RP2040, RP2350 (Pico, Pico 2, Pico W, Pico 2 W) and ESP32 family chips.
- **Embedded Rust & Embassy**: Generates clean structures with `setup()` and `main()` loops, separating board configs and headers.
- **Toolchain Manager**: One-click installer for `rustup`, targets, prebuilt `probe-rs` (with SHA-256 checks), `espup`, and `espflash`.
- **Debugging & Monitoring**: Full SWD debugging with `probe-rs` and RTT for RP boards, plus serial flashing/monitoring via `espflash` for ESP chips.
- **WYSIWYG Designer**: Design panels visually, writing `designer/panel.ui.json` and generating markup for `include_gui!`.
- **Clock & Time Sync**: A design's clock follows the host PC's time, set or served over the serial port (the board asks `TIME?` when its RTC has never been set) and kept in the chip's RTC; a board with no PC on the cable falls back to Wi-Fi SNTP via the generated `src/net.rs`. The Designer starts a listener automatically for an open clock design, closes it for Flash/Monitor, and restarts it when the flash ends; new ESP projects bake in the host's UTC offset.
- **SMTP over Wi-Fi**: An ESP board sends keep-alive email posts. A wizard (Designer button and palette command) collects the relay/credentials and post text, keeps the password in the editor keyring only, and generates a self-contained `smtp_task` that joins the network and posts on a timer.
- **SD card toggle**: The Designer shows an *SD: on/off* switch in the control bar for the Sunton CYD (the only board with a card). It is a cargo feature, because enabling the card is what pulls the FAT filesystem (`embedded-sdmmc`) into the build; the dedicated `sdcard`/`board` templates always include it. Designs naming `sd:/NAME.BMP` images are flagged on save while the card is off.
- **Crates.io Library Manager**: Curated catalog and sparse index integration.
- **Local AI Assist**: Optional, fully local, privacy-first AI coding assistance (supports external endpoints or local bundled runtimes like `llama-server`) that helps implement functions, fix build errors, and inspect board hardware constraints.
- **Packaging Tools**: Package firmware and helper scripts directly into `.deb` installers.

## Installation

Package and install locally (the extension is not yet published to the Marketplace):
```bash
npm install && npm run compile
code --install-extension grumpy-rusty-platform.vsix
```
