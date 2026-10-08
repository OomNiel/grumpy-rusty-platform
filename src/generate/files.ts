import { BoardProfile, RpBoardProfile, isEspBoard } from '../boards/types';
import { binaryNameFrom, crateNameFrom } from './naming';
import { defaultTemplateForEsp, generateEspProjectFiles, templatesForEsp } from './esp';

// Re-exported so every existing caller and test can keep importing these from here.
export { binaryNameFrom, crateNameFrom, isAcceptableProjectName } from './naming';

/**
 * Pure project generator.
 *
 * `generateProjectFiles` is the single source of truth for what a generated
 * Embassy workspace contains. It never touches the filesystem, so the golden-file
 * layer (tests/layers/t3-golden) can snapshot its output byte-for-byte.
 *
 * Wireless boards get an extra `firmware/` directory; the binary blobs themselves
 * are copied in by the wizard (see cyw43FirmwareRunner.ts) because the generator
 * cannot download anything.
 */

/** Pinned crate versions verified against the crates.io index (see NOTES.md). */
export const CRATE_VERSIONS = {
    embassyExecutor: '0.10.0',
    embassyTime: '0.5.1',
    embassyRp: '0.10.0',
    cyw43: '0.7.0',
    cyw43Pio: '0.10.0',
    embassyNet: '0.9.1',
    staticCell: '2.1',
    portableAtomic: '1.5',
    btHci: '0.10.1',
    troubleHost: '0.8.0',
    defmt: '1.1',
    defmtRtt: '1.3',
    panicProbe: '1.0.0',
    cortexM: '0.7',
    cortexMRt: '0.7',
    criticalSection: '1.2',
} as const;

// ------------------------------------------------------------------ templates

// 'wifi' means the family-appropriate implementation: CYW43 + embassy-net on the Pico W, esp-radio on an
// ESP32. Both read the same WIFI_* environment contract, which is what lets one credentials prompt serve
// both families (src/wifi/credentials.ts keys off option_env!("WIFI_SSID") in the generated main.rs).
// 'bluetooth' is ESP-only for now: a Pico W BLE template would be a different stack (BTstack over CYW43).
export type AppTemplate =
    | 'blinky'
    | 'wifi'
    | 'bluetooth'
    | 'wifi-bluetooth'
    | 'display'
    | 'touch'
    | 'peripherals'
    | 'board'
    | 'designer'
    | 'sdcard';

export interface AppTemplateInfo {
    id: AppTemplate;
    label: string;
    description: string;
}

/**
 * The application templates a board can generate. Wireless boards offer all three
 * (the wizard asks); wired boards only have a plain LED blinky.
 */
export function templatesFor(board: BoardProfile): AppTemplateInfo[] {
    if (isEspBoard(board)) {
        return templatesForEsp(board);
    }
    if (board.wireless === 'none') {
        return [
            {
                id: 'blinky',
                label: 'LED blinky',
                description: 'Blinks the on-board LED. The classic starting point.',
            },
        ];
    }
    return [
        {
            id: 'wifi',
            label: 'Wi-Fi connect + LED',
            description: 'Joins your Wi-Fi network, logs the IP address, then blinks the CYW43 LED.',
        },
        {
            id: 'blinky',
            label: 'LED blink only',
            description: 'Blinks the CYW43 LED with no networking code. Smallest wireless build.',
        },
        {
            id: 'wifi-bluetooth',
            label: 'Wi-Fi + Bluetooth skeleton',
            description:
                'Wi-Fi as above, plus the Bluetooth dependency and a commented starting point (no BLE demo yet).',
        },
    ];
}

export function isTemplateValidFor(board: BoardProfile, template: AppTemplate): boolean {
    return templatesFor(board).some((info) => info.id === template);
}

export function defaultTemplateFor(board: BoardProfile): AppTemplate {
    if (isEspBoard(board)) {
        return defaultTemplateForEsp(board);
    }
    return board.wireless === 'none' ? 'blinky' : 'wifi';
}

// ------------------------------------------------------------------- firmware

export interface FirmwareBlob {
    fileName: string;
    purpose: string;
    size: number;
}

/**
 * CYW43 blobs a project needs, in the order they are presented. Copied into
 * `firmware/` by the wizard; see cyw43Firmware.ts for the pinned hashes.
 */
export function requiredFirmware(board: RpBoardProfile, template: AppTemplate): FirmwareBlob[] {
    if (board.wireless !== 'cyw43') {
        return [];
    }
    const blobs: FirmwareBlob[] = [
        { fileName: '43439A0.bin', purpose: 'CYW43 Wi-Fi firmware', size: 231_077 },
        { fileName: '43439A0_clm.bin', purpose: 'regulatory (country) table', size: 984 },
        { fileName: 'nvram_rp2040.bin', purpose: 'NVRAM calibration parameters', size: 742 },
    ];
    if (template === 'wifi-bluetooth') {
        blobs.push({ fileName: '43439A0_btfw.bin', purpose: 'CYW43 Bluetooth patch', size: 6_164 });
    }
    return blobs;
}

// ------------------------------------------------------------------ generation

export interface GeneratedFile {
    /** Path relative to the project root, always using `/`. */
    path: string;
    content: string;
}

export interface GenerateOptions {
    board: BoardProfile;
    /** Raw name the user typed; normalised into a crate name. */
    projectName: string;
    /** Defaults to the board's natural template. */
    template?: AppTemplate;
    /** Wizard answers for the board's options (panel revisions). */
    choices?: Record<string, string>;
    /** How to turn the panel: 0 = none, 1 = 90, 2 = 180, 3 = 270 degrees clockwise. */
    rotation?: number;
}

// The naming helpers (crateNameFrom, binaryNameFrom, isAcceptableProjectName) now live in
// ./naming.ts so the ESP generator can use them without an import cycle. They are
// re-exported at the top of this file, so nothing that imports them from here changes.

export function generateProjectFiles(options: GenerateOptions): GeneratedFile[] {
    const { board, projectName } = options;
    const template = options.template ?? defaultTemplateFor(board);

    // Espressif projects share nothing with the RP layout below, so they are generated
    // by their own module -- see generate/esp.ts for why that split is worth having.
    if (isEspBoard(board)) {
        return generateEspProjectFiles({
            board,
            projectName,
            template,
            choices: options.choices,
            rotation: options.rotation,
        });
    }

    if (!isTemplateValidFor(board, template)) {
        throw new Error(
            `Template "${template}" is not available for ${board.name} (${board.id}). ` +
            `Valid templates: ${templatesFor(board)
                .map((info) => info.id)
                .join(', ')}.`,
        );
    }

    const crateName = crateNameFrom(projectName);
    const binaryName = binaryNameFrom(projectName);

    const files: GeneratedFile[] = [
        { path: 'Cargo.toml', content: cargoToml(board, crateName, template) },
        { path: '.cargo/config.toml', content: cargoConfigToml(board) },
        { path: 'rust-toolchain.toml', content: rustToolchainToml(board) },
        { path: 'memory.x', content: memoryX(board) },
        { path: 'build.rs', content: buildRs(board) },
        { path: 'src/main.rs', content: mainRs(board, template) },
        { path: '.vscode/settings.json', content: vscodeSettings(board) },
        { path: '.vscode/launch.json', content: launchJson(board, binaryName) },
        { path: '.gitignore', content: gitignore() },
        { path: 'README.md', content: readme(board, crateName, template) },
    ];

    if (board.wireless !== 'none') {
        files.push({ path: 'firmware/README.md', content: firmwareReadme(board, template) });
    }

    return files;
}

// ---------------------------------------------------------------------- Cargo

function embassyDependencyLine(board: RpBoardProfile): string {
    const features = board.embassyFeatures.map((f) => `"${f}"`).join(', ');
    return `embassy-rp = { version = "${CRATE_VERSIONS.embassyRp}", features = [${features}] }`;
}

function cargoToml(board: RpBoardProfile, crateName: string, template: AppTemplate): string {
    const wireless = board.wireless === 'cyw43';
    const bluetooth = template === 'wifi-bluetooth';

    const wirelessBlock = wireless
        ? `
# CYW43 Wi-Fi/Bluetooth chip, driven over PIO SPI. The firmware blobs live in
# ./firmware and are baked into the image with \`aligned_bytes!\`.
cyw43 = { version = "${CRATE_VERSIONS.cyw43}", features = [${bluetooth ? '"defmt", "bluetooth"' : '"defmt"'}] }
cyw43-pio = { version = "${CRATE_VERSIONS.cyw43Pio}", features = ["defmt"] }
embassy-net = { version = "${CRATE_VERSIONS.embassyNet}", features = ["defmt", "dhcpv4", "medium-ethernet", "proto-ipv4"] }
static_cell = "${CRATE_VERSIONS.staticCell}"
# static_cell performs an atomic compare-exchange. The Cortex-M0+ has no atomic CAS,
# so portable-atomic provides one via critical-section (as Embassy's examples do).
portable-atomic = { version = "${CRATE_VERSIONS.portableAtomic}", features = ["critical-section"] }
`
        : '';

    const bluetoothBlock = bluetooth
        ? `
# Bluetooth runs on the CYW43 as well. \`bt-hci\` is the controller interface, so
# the driver can talk to any host stack that consumes it. The host stack itself is
# deliberately not chosen for you: \`trouble-host\` is the usual companion, but it
# exposes ~95 features, and picking a set for you would be guesswork.
bt-hci = { version = "${CRATE_VERSIONS.btHci}", features = ["defmt"] }
# trouble-host = { version = "${CRATE_VERSIONS.troubleHost}", features = ["..."] }
`
        : '';

    return `# Generated by Grumpy's Rusty Platform for VS Code.
# Board: ${board.name} (${board.family})
# Template: ${template}
# Regenerating this file will overwrite local edits.

[package]
name = "${crateName}"
version = "0.1.0"
edition = "2024"
license = "MIT OR Apache-2.0"
publish = false

[dependencies]
# NOTE: embassy-rp supplies the architecture glue (and the single \`__pender\`) for
# RP chips, so embassy-executor must NOT be given \`platform-cortex-m\` /
# \`executor-thread\` here — that defines a second \`__pender\` and fails to link.
embassy-executor = { version = "${CRATE_VERSIONS.embassyExecutor}", features = ["defmt"] }
embassy-time = { version = "${CRATE_VERSIONS.embassyTime}", features = ["defmt"] }
${embassyDependencyLine(board)}
${wirelessBlock}${bluetoothBlock}
defmt = "${CRATE_VERSIONS.defmt}"
defmt-rtt = "${CRATE_VERSIONS.defmtRtt}"
panic-probe = { version = "${CRATE_VERSIONS.panicProbe}", features = ["print-defmt"] }
cortex-m = { version = "${CRATE_VERSIONS.cortexM}", features = ["inline-asm"] }
cortex-m-rt = "${CRATE_VERSIONS.cortexMRt}"
critical-section = "${CRATE_VERSIONS.criticalSection}"

[profile.release]
debug = true
lto = true
opt-level = "s"
`;
}

function cargoConfigToml(board: RpBoardProfile): string {
    return `# Generated by Grumpy's Rusty Platform for VS Code.
[target.'cfg(all(target_arch = "arm", target_os = "none"))']
runner = "probe-rs run --chip ${board.probeChip}"

[build]
target = "${board.target}"

[env]
DEFMT_LOG = "debug"
`;
}

function rustToolchainToml(board: RpBoardProfile): string {
    return `# Pins the toolchain channel and makes rustup fetch the embedded target on first build.
[toolchain]
channel = "stable"
targets = ["${board.target}"]
profile = "minimal"
`;
}

// --------------------------------------------------------------------- linker

function memoryX(board: RpBoardProfile): string {
    const { memory } = board;
    const lines: string[] = [];
    lines.push(`/* Generated by Grumpy's Rusty Platform for VS Code. */`);
    lines.push('MEMORY {');
    if (memory.boot2) {
        lines.push('    /* RP2040 second-stage bootloader lives at the start of flash. */');
        lines.push(`    BOOT2 : ORIGIN = 0x10000000, LENGTH = 0x100`);
    }
    lines.push(`    FLASH : ORIGIN = ${memory.flash.origin}, LENGTH = ${memory.flash.length}`);
    lines.push(`    RAM   : ORIGIN = ${memory.ram.origin}, LENGTH = ${memory.ram.length}`);
    for (const extra of memory.extraRam) {
        lines.push(
            `    ${extra.name} : ORIGIN = ${extra.region.origin}, LENGTH = ${extra.region.length}`,
        );
    }
    if (memory.flashReserve) {
        const { name, region } = memory.flashReserve;
        lines.push('    /* Reserved "drive space" — not linked into by the application. */');
        lines.push(`    ${name} : ORIGIN = ${region.origin}, LENGTH = ${region.length}`);
    }
    lines.push('}');

    if (memory.bootInfoSections) {
        lines.push('');
        lines.push('SECTIONS {');
        lines.push('    /* Boot ROM image definition, kept inside the first 4K of flash');
        lines.push('       so the ROM (and picotool) can find it. */');
        lines.push('    .start_block : ALIGN(4) {');
        lines.push('        __start_block_addr = .;');
        lines.push('        KEEP(*(.start_block));');
        lines.push('        KEEP(*(.boot_info));');
        lines.push('    } > FLASH');
        lines.push('} INSERT AFTER .vector_table;');
        lines.push('');
        lines.push('/* Move .text to just after the boot info — and keep it aligned. cortex-m-rt');
        lines.push('   declares this symbol as PROVIDE(_stext = ALIGN(ADDR(.vector_table) +');
        lines.push('   SIZEOF(.vector_table), ALIGNOF(.text))), and PROVIDE only applies when the');
        lines.push('   symbol is still undeclared: a plain assignment here silently throws that');
        lines.push('   ALIGN() away, and rust-lld warns that .text is not a multiple of its');
        lines.push('   alignment (measured: 0x1000013c with align 8). Embassy\'s example has the');
        lines.push('   same unconditional line; this keeps the intent and the alignment. */');
        lines.push('_stext = ALIGN(ADDR(.start_block) + SIZEOF(.start_block), ALIGNOF(.text));');
        lines.push('');
        lines.push('SECTIONS {');
        lines.push('    /* Picotool `binary info` entries. */');
        lines.push('    .bi_entries : ALIGN(4) {');
        lines.push('        __bi_entries_start = .;');
        lines.push('        KEEP(*(.bi_entries));');
        lines.push('        . = ALIGN(4);');
        lines.push('        __bi_entries_end = .;');
        lines.push('    } > FLASH');
        lines.push('} INSERT AFTER .text;');
    }

    return `${lines.join('\n')}\n`;
}

function buildRs(board: RpBoardProfile): string {
    const linkArgs = board.linkArgs
        .map((arg) => `    println!("cargo:rustc-link-arg-bins=${arg}");`)
        .join('\n');
    return `// Generated by Grumpy's Rusty Platform for VS Code.
// Puts \`memory.x\` where the linker can find it and applies the link arguments
// this board needs.

use std::env;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;

fn main() {
    let out = &PathBuf::from(env::var_os("OUT_DIR").unwrap());
    File::create(out.join("memory.x"))
        .unwrap()
        .write_all(include_bytes!("memory.x"))
        .unwrap();
    println!("cargo:rustc-link-search={}", out.display());

    println!("cargo:rerun-if-changed=memory.x");

${linkArgs}
}
`;
}

// ----------------------------------------------------------------------- main

function mainHeader(board: RpBoardProfile, template: AppTemplate): string {
    return `// Generated by Grumpy's Rusty Platform for VS Code.
// Target: ${board.name} (${board.family}, ${board.target})
// Template: ${template}
`;
}

function mainRs(board: RpBoardProfile, template: AppTemplate): string {
    if (board.wireless === 'cyw43') {
        return template === 'blinky'
            ? mainRsCyw43Led(board)
            : mainRsWifi(board, template === 'wifi-bluetooth');
    }
    return mainRsWired(board);
}

function mainRsWired(board: RpBoardProfile): string {
    const pin = board.led.kind === 'gpio' ? board.led.pin : 'PIN_25';
    return `${mainHeader(board, 'blinky')}
#![no_std]
#![no_main]

use defmt::info;
use defmt_rtt as _;
use embassy_executor::Spawner;
use embassy_rp::gpio::{Level, Output};
use embassy_time::Timer;
use panic_probe as _;

// embassy-rp provides its own multicore-capable executor, so it must be named
// explicitly here (there is no \`platform-cortex-m\` feature on embassy-executor).
#[embassy_executor::main(executor = "embassy_rp::executor::Executor", entry = "cortex_m_rt::entry")]
async fn main(_spawner: Spawner) {
    // RTT keeps the previous image's bytes after a reset, and a stale frame can decode into
    // nonsense (defmt's own strings show up as log values). The current run begins at the last
    // line like this one.
    info!("=== {} {} starting ===", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"));

    let p = embassy_rp::init(Default::default());
    info!("Hello from Grumpy's Rusty Platform on ${board.family}!");

    let mut led = Output::new(p.${pin}, Level::Low);

    loop {
        led.set_high();
        Timer::after_millis(500).await;
        led.set_low();
        Timer::after_millis(500).await;
    }
}
`;
}

/** Shared CYW43 bring-up block, identical apart from the pin and divider names. */
function cyw43BringUp(board: RpBoardProfile): string {
    const wiring = board.cyw43;
    if (!wiring) {
        throw new Error(`${board.id} is marked wireless but has no CYW43 wiring`);
    }
    return `    // See the note in the API template: this marks where the current run starts.
    info!("=== {} {} starting ===", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"));

    let p = embassy_rp::init(Default::default());

    // The firmware blobs are in ./firmware and are verified by the project wizard.
    let fw = aligned_bytes!("../firmware/43439A0.bin");
    let clm = aligned_bytes!("../firmware/43439A0_clm.bin");
    let nvram = aligned_bytes!("../firmware/nvram_rp2040.bin");

    let pwr = Output::new(p.${wiring.pwrPin}, Level::Low);
    let cs = Output::new(p.${wiring.csPin}, Level::High);
    let mut pio = Pio::new(p.${wiring.pio}, Irqs);
    let spi = PioSpi::new(
        &mut pio.common,
        pio.sm0,
        ${wiring.clockDivider},
        pio.irq0,
        cs,
        p.${wiring.dioPin},
        p.${wiring.clkPin},
        dma::Channel::new(p.${wiring.dmaCh0}, Irqs),
    );

    static STATE: StaticCell<cyw43::State> = StaticCell::new();
    let state = STATE.init(cyw43::State::new());
`;
}

function mainRsCyw43Led(board: RpBoardProfile): string {
    const dividerImport = board.cyw43?.clockDivider ?? 'DEFAULT_CLOCK_DIVIDER';
    const ledIndex = board.led.kind === 'cyw43' ? board.led.index : 0;
    return `${mainHeader(board, 'blinky')}
#![no_std]
#![no_main]

use cyw43::aligned_bytes;
use cyw43_pio::{${dividerImport}, PioSpi};
use defmt::*;
use defmt_rtt as _;
use embassy_executor::Spawner;
use embassy_rp::gpio::{Level, Output};
use embassy_rp::peripherals::{${board.cyw43?.dmaCh0}, ${board.cyw43?.pio}};
use embassy_rp::pio::{InterruptHandler, Pio};
use embassy_rp::{bind_interrupts, dma};
use embassy_time::{Duration, Timer};
use panic_probe as _;
use static_cell::StaticCell;

bind_interrupts!(struct Irqs {
    ${board.cyw43?.pio}_IRQ_0 => InterruptHandler<${board.cyw43?.pio}>;
    DMA_IRQ_0 => dma::InterruptHandler<${board.cyw43?.dmaCh0}>;
});

#[embassy_executor::task]
async fn cyw43_task(
    runner: cyw43::Runner<'static, cyw43::SpiBus<Output<'static>, PioSpi<'static, ${board.cyw43?.pio}, 0>>>,
) -> ! {
    runner.run().await
}

#[embassy_executor::main(executor = "embassy_rp::executor::Executor", entry = "cortex_m_rt::entry")]
async fn main(spawner: Spawner) {
${cyw43BringUp(board)}
    let (_net_device, mut control, runner) = cyw43::new(state, pwr, spi, fw, nvram).await;
    spawner.spawn(unwrap!(cyw43_task(runner)));

    control.init(clm).await;
    control
        .set_power_management(cyw43::PowerManagementMode::PowerSave)
        .await;

    info!("CYW43 is up on ${board.family}");

    let delay = Duration::from_millis(250);
    loop {
        control.gpio_set(${ledIndex}, true).await;
        Timer::after(delay).await;
        control.gpio_set(${ledIndex}, false).await;
        Timer::after(delay).await;
    }
}
`;
}

function mainRsWifi(board: RpBoardProfile, withBluetooth: boolean): string {
    const template: AppTemplate = withBluetooth ? 'wifi-bluetooth' : 'wifi';
    const dividerImport = board.cyw43?.clockDivider ?? 'DEFAULT_CLOCK_DIVIDER';
    const ledIndex = board.led.kind === 'cyw43' ? board.led.index : 0;

    const bluetoothSection = withBluetooth
        ? `
// --- Bluetooth (skeleton) ---------------------------------------------------
// This build enables the \`cyw43\` \`bluetooth\` feature and pulls in \`bt-hci\`, the
// controller interface. There is deliberately no BLE demo here: Embassy ships no
// upstream CYW43 Bluetooth example, so there is nothing authoritative to copy, and
// inventing one would be guesswork.
//
// To continue: pick a host stack (\`trouble-host\` is the usual companion), add it
// to Cargo.toml with the features you need, and use the Bluetooth constructor:
//
//   let bluetooth_fw = aligned_bytes!("../firmware/43439A0_btfw.bin");
//   let (net_device, bt_driver, mut control, runner) =
//       cyw43::new_with_bluetooth(state, pwr, spi, fw, bluetooth_fw, nvram).await;
//
// then hand \`bt_driver\` to the host stack.
// ---------------------------------------------------------------------------
`
        : '';

    return `${mainHeader(board, template)}
#![no_std]
#![no_main]

use cyw43::{aligned_bytes, JoinOptions};
use cyw43_pio::{${dividerImport}, PioSpi};
use defmt::*;
use defmt_rtt as _;
use embassy_executor::Spawner;
use embassy_rp::clocks::RoscRng;
use embassy_rp::gpio::{Level, Output};
use embassy_rp::peripherals::{${board.cyw43?.dmaCh0}, ${board.cyw43?.pio}};
use embassy_rp::pio::{InterruptHandler, Pio};
use embassy_rp::{bind_interrupts, dma};
use embassy_time::{Duration, Timer};
use panic_probe as _;
use static_cell::StaticCell;

// Credentials are read at *compile* time so they never end up in your source tree.
//
// In VS Code, press Flash or Debug: the extension asks for the network name and password the
// first time and remembers them, so nothing has to be typed again. Building from a terminal
// instead, pass them on the command line:
//
//   WIFI_SSID="my-ssid" WIFI_PASSWORD="secret" cargo run --release
//
// The placeholders below are what you get if you forget.
const WIFI_SSID: &str = match option_env!("WIFI_SSID") {
    Some(value) => value,
    None => "YOUR_WIFI_SSID",
};
const WIFI_PASSWORD: &str = match option_env!("WIFI_PASSWORD") {
    Some(value) => value,
    None => "YOUR_WIFI_PASSWORD",
};

// Optional static addressing, for networks whose DHCP server never answers. Set both and DHCP is
// skipped entirely - the credential prompt has a field for it, or pass them when building from a
// terminal:
//
//   WIFI_STATIC_IP="192.168.1.50/24" WIFI_GATEWAY="192.168.1.1" cargo run --release
//
// Leave them unset to use DHCP, which is the default.
const STATIC_IP: Option<&str> = option_env!("WIFI_STATIC_IP");
const STATIC_GATEWAY: Option<&str> = option_env!("WIFI_GATEWAY");

/// Parse the static configuration, or nothing when DHCP should be used. Everything here is a
/// compile-time string, so a typo is caught by the log rather than by a panic.
fn static_config() -> Option<embassy_net::StaticConfigV4> {
    use core::str::FromStr;

    let (host, prefix) = STATIC_IP?.split_once('/')?;
    let prefix: u8 = prefix.parse().ok()?;
    if prefix > 32 {
        return None;
    }
    let address = embassy_net::Ipv4Cidr::new(embassy_net::Ipv4Address::from_str(host).ok()?, prefix);
    let gateway = match STATIC_GATEWAY {
        Some(text) => Some(embassy_net::Ipv4Address::from_str(text).ok()?),
        None => None,
    };
    Some(embassy_net::StaticConfigV4 {
        address,
        gateway,
        dns_servers: Default::default(),
    })
}

bind_interrupts!(struct Irqs {
    ${board.cyw43?.pio}_IRQ_0 => InterruptHandler<${board.cyw43?.pio}>;
    DMA_IRQ_0 => dma::InterruptHandler<${board.cyw43?.dmaCh0}>;
});

#[embassy_executor::task]
async fn cyw43_task(
    runner: cyw43::Runner<'static, cyw43::SpiBus<Output<'static>, PioSpi<'static, ${board.cyw43?.pio}, 0>>>,
) -> ! {
    runner.run().await
}

#[embassy_executor::task]
async fn net_task(mut runner: embassy_net::Runner<'static, cyw43::NetDriver<'static>>) -> ! {
    runner.run().await
}

#[embassy_executor::main(executor = "embassy_rp::executor::Executor", entry = "cortex_m_rt::entry")]
async fn main(spawner: Spawner) {
${cyw43BringUp(board)}
    let (net_device, mut control, runner) = cyw43::new(state, pwr, spi, fw, nvram).await;
    spawner.spawn(unwrap!(cyw43_task(runner)));

    control.init(clm).await;
    control
        .set_power_management(cyw43::PowerManagementMode::PowerSave)
        .await;

    // Seed the network stack from the on-chip random source.
    let mut rng = RoscRng;
    let seed = rng.next_u64();

    // embassy-net 0.9 takes the driver, its config and a static resource pool.
    static RESOURCES: StaticCell<embassy_net::StackResources<3>> = StaticCell::new();
    let (stack, runner) = embassy_net::new(
        net_device,
        match static_config() {
            Some(fixed) => {
                info!("using a static IP: WIFI_STATIC_IP is set, so DHCP is skipped");
                embassy_net::Config::ipv4_static(fixed)
            }
            None => embassy_net::Config::dhcpv4(Default::default()),
        },
        RESOURCES.init(embassy_net::StackResources::new()),
        seed,
    );
    spawner.spawn(unwrap!(net_task(runner)));

    info!("joining Wi-Fi...");
    while let Err(err) = control
        .join(WIFI_SSID, JoinOptions::new(WIFI_PASSWORD.as_bytes()))
        .await
    {
        info!("join failed: {:?}", err);
        Timer::after_secs(2).await;
    }
    info!("associated to {}", WIFI_SSID);

    // A bare wait_config_up() hides the only interesting failure here: smoltcp retries the DHCP
    // REQUEST/ACK exchange for roughly 50 s and then starts over, forever, logging only
    // "DHCP request retries exceeded, restarting discovery". Waiting with a timeout lets us say
    // what that means, once per attempt, and keep trying — a router that answers late still works.
    // Only one of the two paths was taken, and the log has to say which: "using a static IP"
    // followed by "waiting for DHCP" is how a reader stops trusting the output.
    let waiting_for_dhcp = STATIC_IP.is_none();
    if waiting_for_dhcp {
        info!("waiting for DHCP...");
    } else {
        info!("waiting for the network stack...");
    }
    loop {
        if let Ok(()) = embassy_time::with_timeout(Duration::from_secs(30), stack.wait_config_up()).await {
            break;
        }
        if waiting_for_dhcp {
            warn!(
                "no DHCP lease after 30 s - the exchange did not complete. Still retrying; set WIFI_STATIC_IP to skip DHCP." /* superseded wording follows: \\\\\n             server on the LAN (a repeater or an old router), and make sure the access point has a \\\\\n             2.4 GHz radio. Still retrying; set WIFI_STATIC_IP to skip DHCP entirely."
            */);
        } else {
            warn!("Wi-Fi is associated but the network stack never came up; check WIFI_STATIC_IP and WIFI_GATEWAY.");
        }
    }
    if let Some(config) = stack.config_v4() {
        let octets = config.address.address().octets();
        info!("Wi-Fi is up - IP {}.{}.{}.{}", octets[0], octets[1], octets[2], octets[3]);
    }
${bluetoothSection}
    let delay = Duration::from_millis(250);
    loop {
        control.gpio_set(${ledIndex}, true).await;
        Timer::after(delay).await;
        control.gpio_set(${ledIndex}, false).await;
        Timer::after(delay).await;
    }
}
`;
}

// --------------------------------------------------------------- small files

function vscodeSettings(board: RpBoardProfile): string {
    return `${JSON.stringify(
        {
            'rust-analyzer.cargo.target': board.target,
            'rust-analyzer.check.allTargets': false,
            'rust-analyzer.cargo.noDefaultFeatures': false,
            'rust-analyzer.linkedProjects': ['Cargo.toml'],
        },
        null,
        2,
    )}\n`;
}

function launchJson(board: RpBoardProfile, binaryName: string): string {
    // Schema verified against probe-rs/vscode package.json:
    // `probe-rs-debug` requires `chip` and `coreConfigs`, and `coreConfigs.items` requires
    // `programBinary`.
    //
    // `flashingConfig.flashingEnabled` defaults to *false*, which makes a debug session attach to
    // whatever is already on the chip and decode its RTT with **this** ELF — the two then disagree,
    // and defmt resolves frames against the wrong string table, printing lines that were never
    // logged. So a `launch` configuration flashes the build it debugs.
    //
    // Debugging always uses the debug build. A release build is optimised: the compiler merges or
    // removes lines, so the debugger has no address to bind some breakpoints to and VS Code leaves
    // them hollow. Every configuration below points at that one build.
    const debugConfigs = [
        {
            coreIndex: 0,
            programBinary: `target/${board.target}/debug/${binaryName}`,
            rttEnabled: true,
        },
    ];
    return `${JSON.stringify(
        {
            version: '0.2.0',
            configurations: [
                {
                    type: 'probe-rs-debug',
                    request: 'launch',
                    name: `Flash & Debug (${board.family})`,
                    cwd: '${workspaceFolder}',
                    chip: board.probeChip,
                    flashingConfig: { flashingEnabled: true },
                    coreConfigs: debugConfigs,
                },
                {
                    // The same thing, but stopped on the reset vector so the first instructions can
                    // be stepped through or a breakpoint placed before the code runs.
                    type: 'probe-rs-debug',
                    request: 'launch',
                    name: `Flash & Halt at Reset (${board.family})`,
                    cwd: '${workspaceFolder}',
                    chip: board.probeChip,
                    flashingConfig: { flashingEnabled: true, haltAfterReset: true },
                    coreConfigs: debugConfigs,
                },
                {
                    // Debugging a build that is already on the chip, without writing it. A `launch`
                    // only flashes when `flashingEnabled` is true, so the flash contents are left
                    // alone - but the target IS reset, which is what makes breakpoints in `main` and
                    // in startup code bind. Without this entry, the only no-flash choice was `attach`,
                    // and an attach session can never stop in code that has already run.
                    type: 'probe-rs-debug',
                    request: 'launch',
                    name: `Restart & Debug, no flashing (${board.family})`,
                    cwd: '${workspaceFolder}',
                    chip: board.probeChip,
                    flashingConfig: { flashingEnabled: false },
                    coreConfigs: debugConfigs,
                },
                {
                    // Attaching never flashes and never resets: probe-rs rejects `flashing_enabled`,
                    // `halt_after_reset` and the rest for an `attach` request outright. It is for
                    // looking at a program that is already running, so it can only stop in code that
                    // runs again (a loop, an interrupt) - never in `main` or startup code.
                    type: 'probe-rs-debug',
                    request: 'attach',
                    name: `Attach - keeps it running (${board.family})`,
                    cwd: '${workspaceFolder}',
                    chip: board.probeChip,
                    coreConfigs: debugConfigs,
                },
            ],
        },
        null,
        2,
    )}\n`;
}

function gitignore(): string {
    return `/target
/dist
`;
}

function firmwareReadme(board: RpBoardProfile, template: AppTemplate): string {
    const rows = requiredFirmware(board, template)
        .map((blob) => `| \`${blob.fileName}\` | ${blob.purpose} | ${blob.size} B |`)
        .join('\n');
    return `# CYW43 firmware blobs

These are the Raspberry Pi CYW43 wireless firmware files for **${board.name}**. They
are compiled into the image with \`aligned_bytes!\` (see \`src/main.rs\`), so they must
stay in this directory.

| File | Purpose | Size |
|---|---|---|
${rows}

Placed by Grumpy's Rusty Platform for VS Code from the Embassy project
(\`github.com/embassy-rs/embassy\`, \`cyw43-firmware/\` at commit
\`b12a6d9efcd2711037abca1b63a661a9ef726444\`) and verified against pinned SHA-256
hashes before being written here.

These blobs are **not** covered by this project's licence. See
\`LICENSE-permissive-binary-license-1.0.txt\` in this directory.
`;
}

function readme(board: RpBoardProfile, crateName: string, template: AppTemplate): string {
    const wireless = board.wireless === 'cyw43';
    const ledLine = wireless
        ? 'The on-board LED is connected to the CYW43 wireless chip, not to GPIO25.'
        : `The on-board LED is on \`${board.led.kind === 'gpio' ? board.led.pin : 'PIN_25'}\`.`;
    const wifiNote =
        template === 'wifi' || template === 'wifi-bluetooth'
            ? `
## Wi-Fi credentials

Credentials are read at *compile* time, so they never end up in your source tree.

The easy way: press **Flash** or **Debug** - Grumpy's Rusty Platform asks for the network name
and password the first time and remembers them (in VS Code's keyring, not in this project).

From a plain terminal, pass them yourself:

\`\`\`sh
WIFI_SSID="my-ssid" WIFI_PASSWORD="secret" cargo run --release
\`\`\`

If your router's DHCP never answers, add a fixed address - the prompt has a field for it too:

\`\`\`sh
WIFI_STATIC_IP="192.168.1.50/24" WIFI_GATEWAY="192.168.1.1" cargo run --release
\`\`\`

The first flash always runs the full image; use \`--release\` for anything real.
`
            : '';

    return `# ${crateName}

Embassy firmware for **${board.name}** (\`${board.family}\`), generated by
Grumpy's Rusty Platform for VS Code.

- Target: \`${board.target}\`
- debug probe chip id: \`${board.probeChip}\`
- template: \`${template}\`

${ledLine}
${wifiNote}
## Build / flash

\`\`\`sh
cargo build          # compile
cargo run --release  # flash and attach defmt logs (uses the cargo runner in .cargo/config.toml)
\`\`\`

## Debugging

The **Debug** button (or F5) builds the debug profile, flashes it and starts a session with defmt
over RTT. Nothing stops on its own - the firmware runs, and the debugger halts it when something you
asked for happens. Four configurations ship with the project, all of them in the Run and Debug
dropdown:

| Configuration | Flashes? | Resets? | Stops when |
|---|---|---|---|
| \`Flash & Debug\` | yes | yes | at your breakpoints |
| \`Flash & Halt at Reset\` | yes | yes | on the reset vector, before any of your code runs |
| \`Restart & Debug, no flashing\` | **no** | yes | at your breakpoints - anywhere, including \`main\` |
| \`Attach - keeps it running\` | **no** | **no** | at your breakpoints, but only in code that runs again |

Every configuration uses the **debug** build: a release build is optimised, so the compiler merges or
removes lines and breakpoints there show up hollow. \`Flash & Debug\` therefore always flashes the
debug build before starting.

* **A breakpoint in \`main\` needs a reset.** \`Attach - keeps it running\` joins a program that is
already executing, and probe-rs does not allow an attach session to reset the chip, so code that has
already run - \`main\`, the boot banner, the Wi-Fi setup - can never be reached again. Its
breakpoints look solid in the gutter and simply never fire. Use it for behaviour that repeats (a
loop, an interrupt, a timer), and \`Restart & Debug, no flashing\` when you want to stop in startup
code without writing the chip.
* **Breakpoints need the debug build.** A release build is optimised: the compiler merges or removes
lines, so the debugger has no address to bind them to and VS Code leaves those breakpoints hollow
(unverified). \`Flash & Debug\` always gives you the debug build.
* **Set a breakpoint** in the editor gutter (or F9) on a line you care about - for example the line
after \`embassy_rp::init(Default::default())\` - then start the session. Locals, the call stack and
stepping work from there. Adding a breakpoint to a *running* session is handled by the debugger; on
an embedded target the reliable order is pause (halt), set the breakpoint, continue.
* **To debug without reflashing**, pick either entry that does not flash. Both expect the debug
build - the one **Flash** writes - because the code that runs must match the symbols: the picker
marks the entry that matches the last flash, and the Debug command checks the chip against the build
with \`probe-rs verify\` before starting (a 10 s read of the flash) and offers to flash instead when
they disagree.
* **Breakpoints are limited by the chip, not the probe:** ${board.family === 'RP2350' ? '8' : '4'} hardware
breakpoints on this board. Conditional breakpoints and logpoints each take one, stepping needs one
free (it is implemented with a temporary breakpoint), and past the limit the extra ones stay hollow
with "No available hardware breakpoints".
* **Halting stops the Wi-Fi and the timers**, and defmt output stops with them - that is expected,
not a fault. \`Continue\` resumes both.
* Stepping through \`async\` code can jump around: the compiler rewrites an \`async fn\` into a state
machine, so one source line may be resumed from a different place than it was suspended.
`;
}
