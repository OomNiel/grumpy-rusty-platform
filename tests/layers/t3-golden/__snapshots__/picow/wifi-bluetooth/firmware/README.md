# CYW43 firmware blobs

These are the Raspberry Pi CYW43 wireless firmware files for **Raspberry Pi Pico W**. They
are compiled into the image with `aligned_bytes!` (see `src/main.rs`), so they must
stay in this directory.

| File | Purpose | Size |
|---|---|---|
| `43439A0.bin` | CYW43 Wi-Fi firmware | 231077 B |
| `43439A0_clm.bin` | regulatory (country) table | 984 B |
| `nvram_rp2040.bin` | NVRAM calibration parameters | 742 B |
| `43439A0_btfw.bin` | CYW43 Bluetooth patch | 6164 B |

Placed by Grumpy's Rusty Platform for VS Code from the Embassy project
(`github.com/embassy-rs/embassy`, `cyw43-firmware/` at commit
`b12a6d9efcd2711037abca1b63a661a9ef726444`) and verified against pinned SHA-256
hashes before being written here.

These blobs are **not** covered by this project's licence. See
`LICENSE-permissive-binary-license-1.0.txt` in this directory.
