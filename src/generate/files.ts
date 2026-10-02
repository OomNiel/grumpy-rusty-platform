import { BoardProfile } from '../boards/types';

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

export type AppTemplate = 'blinky' | 'wifi' | 'wifi-bluetooth';

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
export function requiredFirmware(board: BoardProfile, template: AppTemplate): FirmwareBlob[] {
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
}

/** Cargo package name: lowercase, `-`-separated, `[a-z0-9_-]`, must start with a letter. */
export function crateNameFrom(projectName: string): string {
    const normalised = projectName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '');
    if (normalised === '') {
        return 'firmware';
    }
    return /^[a-z]/.test(normalised) ? normalised : `fw-${normalised}`;
}

/**
 * The on-disk binary name Cargo produces for the default bin target.
 *
 * Cargo uses the package name **verbatim**: hyphens are NOT converted to
 * underscores. Verified against cargo 1.99 by the t4-e2e layer, which asserts
 * this exact artefact name — do not "fix" it to the underscore form.
 */
export function binaryNameFrom(projectName: string): string {
    return crateNameFrom(projectName);
}

export function isAcceptableProjectName(projectName: string): true | string {
    const trimmed = projectName.trim();
    if (trimmed === '') {
        return 'Enter a project name.';
    }
    if (/[\\/:*?"<>|]/.test(trimmed)) {
        return 'Project name cannot contain \\ / : * ? " < > |';
    }
    if (trimmed === '.' || trimmed === '..') {
        return 'Invalid project name.';
    }
    return true;
}

export function generateProjectFiles(options: GenerateOptions): GeneratedFile[] {
    const { board, projectName } = options;
    const template = options.template ?? defaultTemplateFor(board);

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

function embassyDependencyLine(board: BoardProfile): string {
    const features = board.embassyFeatures.map((f) => `"${f}"`).join(', ');
    return `embassy-rp = { version = "${CRATE_VERSIONS.embassyRp}", features = [${features}] }`;
}

function cargoToml(board: BoardProfile, crateName: string, template: AppTemplate): string {
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

function cargoConfigToml(board: BoardProfile): string {
    return `# Generated by Grumpy's Rusty Platform for VS Code.
[target.'cfg(all(target_arch = "arm", target_os = "none"))']
runner = "probe-rs run --chip ${board.probeChip}"

[build]
target = "${board.target}"

[env]
DEFMT_LOG = "debug"
`;
}

function rustToolchainToml(board: BoardProfile): string {
    return `# Pins the toolchain channel and makes rustup fetch the embedded target on first build.
[toolchain]
channel = "stable"
targets = ["${board.target}"]
profile = "minimal"
`;
}

// --------------------------------------------------------------------- linker

function memoryX(board: BoardProfile): string {
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
        lines.push('_stext = ADDR(.start_block) + SIZEOF(.start_block);');
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

function buildRs(board: BoardProfile): string {
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

function mainHeader(board: BoardProfile, template: AppTemplate): string {
    return `// Generated by Grumpy's Rusty Platform for VS Code.
// Target: ${board.name} (${board.family}, ${board.target})
// Template: ${template}
`;
}

function mainRs(board: BoardProfile, template: AppTemplate): string {
    if (board.wireless === 'cyw43') {
        return template === 'blinky'
            ? mainRsCyw43Led(board)
            : mainRsWifi(board, template === 'wifi-bluetooth');
    }
    return mainRsWired(board);
}

function mainRsWired(board: BoardProfile): string {
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
function cyw43BringUp(board: BoardProfile): string {
    const wiring = board.cyw43;
    if (!wiring) {
        throw new Error(`${board.id} is marked wireless but has no CYW43 wiring`);
    }
    return `    let p = embassy_rp::init(Default::default());

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

function mainRsCyw43Led(board: BoardProfile): string {
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

function mainRsWifi(board: BoardProfile, withBluetooth: boolean): string {
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

// Credentials are read at *compile* time so they never end up in your source tree:
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
        embassy_net::Config::dhcpv4(Default::default()),
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

    info!("waiting for DHCP...");
    stack.wait_config_up().await;
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

function vscodeSettings(board: BoardProfile): string {
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

function launchJson(board: BoardProfile, binaryName: string): string {
    // Schema verified against probe-rs/vscode package.json:
    // `probe-rs-debug` requires `chip` and `coreConfigs`.
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
                    coreConfigs: [
                        {
                            coreIndex: 0,
                            programBinary: `target/${board.target}/debug/${binaryName}`,
                            rttEnabled: true,
                        },
                    ],
                },
            ],
        },
        null,
        2,
    )}\n`;
}

function gitignore(): string {
    return `/target
`;
}

function firmwareReadme(board: BoardProfile, template: AppTemplate): string {
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

function readme(board: BoardProfile, crateName: string, template: AppTemplate): string {
    const wireless = board.wireless === 'cyw43';
    const ledLine = wireless
        ? 'The on-board LED is connected to the CYW43 wireless chip, not to GPIO25.'
        : `The on-board LED is on \`${board.led.kind === 'gpio' ? board.led.pin : 'PIN_25'}\`.`;
    const wifiNote =
        template === 'wifi' || template === 'wifi-bluetooth'
            ? `
## Wi-Fi credentials

Credentials are read at compile time so they never end up in your source tree:

\`\`\`sh
WIFI_SSID="my-ssid" WIFI_PASSWORD="secret" cargo run --release
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
`;
}
