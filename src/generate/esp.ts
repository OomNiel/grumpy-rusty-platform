/**
 * Espressif project generator (esp-hal + esp-rtos, flashed with `espflash`).
 *
 * Separate from `files.ts` because almost nothing is shared with an RP project: an
 * ESP build has no `memory.x`, no boot2, no CYW43, no UF2 and no probe-rs. It is kept
 * pure like the RP generator so the golden layer can snapshot it byte-for-byte.
 *
 * Every API used here was checked against the vendor's own scaffolding
 * (`esp-rs/esp-generate`, `template/`) and against docs.rs for the pinned versions --
 * a generated project that does not compile is worse than no project, and this host
 * cannot build Xtensa code to find out.
 */

import type { AppTemplate, AppTemplateInfo, GeneratedFile } from './files';
import { crateNameFrom } from './naming';
import { BoardChoices, displayFor } from '../boards/esp';
import { EspBoardProfile, EspDisplay, EspTouch } from '../boards/types';

/** Pinned ESP crate versions. See NOTES.md for where each one comes from. */
export const ESP_CRATE_VERSIONS = {
    /** esp-hal 1.2.x is the line `esp-generate` currently emits (edition 2024, rust 1.95). */
    espHal: '~1.2.2',
    /** Since esp-hal 1.x the Embassy *and* Wi-Fi glue lives in esp-rtos. */
    espRtos: '0.4.0',
    espBootloader: '0.6.0',
    espPrintln: '0.18.0',
    espBacktrace: '0.20.0',
    espAlloc: '0.11.0',
    espRadio: '1.0.0-beta.1',
    embassyExecutor: '0.10.0',
    embassyTime: '0.5.0',
    embassyNet: '0.9.1',
    mipidsi: '0.10.0',
    /** The bus-to-device adapter mipidsi's SPI interface needs (`ExclusiveDevice`). */
    embeddedHalBus: '0.3.0',
    /** Named directly by the touch template: its read helper is generic over `SpiDevice`. */
    embeddedHal: '1.0.0',
    embeddedGraphics: '0.8',
} as const;

/** The Xtensa toolchain espup installs under this rustup channel name. */
export const ESP_TOOLCHAIN_CHANNEL = 'esp';

/** MSRV of esp-hal 1.2.x, written into the generated manifest. */
export const ESP_RUST_VERSION = '1.95';

export interface EspGenerateOptions {
    board: EspBoardProfile;
    /** Raw name the user typed; normalised into a crate name. */
    projectName: string;
    template: AppTemplate;
    /** Wizard answers for the board's `options` (panel revisions). */
    choices?: BoardChoices;
}

/**
 * Templates an ESP board can generate.
 *
 * Only what is really implemented is listed. A template that generates a project which
 * compiles but does nothing would be worse than its absence: the panel and Wi-Fi
 * templates are being written against the vendor's examples and are added here once
 * their code exists.
 */
export function templatesForEsp(board: EspBoardProfile): AppTemplateInfo[] {
    const led = board.led.kind === 'gpio' && !board.led.external;
    const templates: AppTemplateInfo[] = [
        {
            id: 'blinky',
            label: 'Periodic task',
            description: led
                ? 'Blinks the on-board LED from an Embassy task.'
                : 'Logs a heartbeat over USB serial. The classic starting point.',
        },
    ];
    if (board.displays.length > 0) {
        templates.push({
            id: 'display',
            label: 'Panel diagnostic screen',
            description:
                'Initialises the soldered panel and draws a screen to read: frame, corner markers, colour bars, '
                + 'a centred cross, a greeting and a blinking square — timed, and logging how long the paint took.',
        });
    }
    if (board.touch !== undefined) {
        templates.push({
            id: 'touch',
            label: 'Panel + touch test',
            description:
                'Panel bring-up, then a four-corner touch calibration on the ' + board.touch.controller
                + ' controller: touch each corner, then a crosshair follows your finger while the raw and '
                + 'mapped coordinates go to the log.',
        });
    }
    return templates;
}

export function defaultTemplateForEsp(board: EspBoardProfile): AppTemplate {
    // A board with a panel was bought for its panel, so that is the interesting default.
    return board.displays.length > 0 ? 'display' : 'blinky';
}

export function isTemplateValidForEsp(board: EspBoardProfile, template: AppTemplate): boolean {
    return templatesForEsp(board).some((info) => info.id === template);
}

export function generateEspProjectFiles(options: EspGenerateOptions): GeneratedFile[] {
    const { board, template } = options;
    const choices = options.choices ?? {};
    const crateName = crateNameFrom(options.projectName);

    if (!isTemplateValidForEsp(board, template)) {
        throw new Error(
            `Template "${template}" is not available for ${board.name} (${board.id}). ` +
            `Valid templates: ${templatesForEsp(board)
                .map((info) => info.id)
                .join(', ')}.`,
        );
    }

    return [
        { path: 'Cargo.toml', content: espCargoToml(board, crateName, template, choices) },
        { path: '.cargo/config.toml', content: espCargoConfigToml(board, template) },
        { path: '.cargo/esp-config.toml', content: espConfigToml() },
        { path: 'rust-toolchain.toml', content: espRustToolchainToml() },
        { path: 'build.rs', content: espBuildRs() },
        { path: 'src/main.rs', content: espMainRs(board, template, choices) },
        { path: '.vscode/settings.json', content: espVscodeSettings(board) },
        { path: '.gitignore', content: '/target\n/dist\n' },
        { path: 'README.md', content: espReadme(board, crateName, template, choices) },
    ];
}

// ---------------------------------------------------------------------- Cargo

function espCargoToml(
    board: EspBoardProfile,
    crateName: string,
    template: AppTemplate,
    choices: BoardChoices,
): string {
    // The touch template drives the same panel, so everything the panel needs is needed there too.
    const display = template === 'display' || template === 'touch' ? displayFor(board, choices) : undefined;
    const panelChoice = display?.panelChoice;
    const features =
        panelChoice === undefined
            ? ''
            : `
[features]
# LilyGo shipped two panels under one name; this feature picks which init table the
# firmware uses. Flip it and rebuild to try the other revision.
default = ["panel-${panelChoice}"]
panel-gc9107 = []
panel-gc9a01 = []
`;
    const espRtosFeatures = ['embassy', board.espChip];

    const dependencies = [
        `esp-hal = { version = "${ESP_CRATE_VERSIONS.espHal}", features = ["${board.espChip}", "log-04"] }`,
        `esp-rtos = { version = "${ESP_CRATE_VERSIONS.espRtos}", features = [${espRtosFeatures.map((f) => `"${f}"`).join(', ')}] }`,
        `esp-bootloader-esp-idf = { version = "${ESP_CRATE_VERSIONS.espBootloader}", features = ["${board.espChip}", "log-04"] }`,
        `esp-println = { version = "${ESP_CRATE_VERSIONS.espPrintln}", features = ["${board.espChip}", "log-04"] }`,
        `esp-backtrace = { version = "${ESP_CRATE_VERSIONS.espBacktrace}", features = ["${board.espChip}", "panic-handler", "println"] }`,
        'log = "0.4.27"',
        `embassy-executor = { version = "${ESP_CRATE_VERSIONS.embassyExecutor}", features = ["log"] }`,
        `embassy-time = { version = "${ESP_CRATE_VERSIONS.embassyTime}", features = ["log"] }`,
    ];

    if (display) {
        // mipidsi drives the panel, embedded-graphics is where the colours, the geometry, the primitives and
        // the font come from, and embedded-hal-bus glues esp-hal's SPI bus to it. (`embedded-graphics` pulls
        // in `embedded-graphics-core` and re-exports it, so only the one is declared — two would be two names
        // for the same types, and the day they resolve to different versions is the day nothing compiles.)
        dependencies.push(
            `mipidsi = "${ESP_CRATE_VERSIONS.mipidsi}"`,
            `embedded-graphics = "${ESP_CRATE_VERSIONS.embeddedGraphics}"`,
            // esp-hal's `Spi` is a *bus*; mipidsi wants a `SpiDevice` (bus + its own CS), and this is the
            // crate that joins the two. Without it the generated display project cannot compile at all —
            // `Spi<'_>` does not implement `SpiDevice` (found by building a generated project, 2026-10-05).
            `embedded-hal-bus = "${ESP_CRATE_VERSIONS.embeddedHalBus}"`,
        );
    }
    if (template === 'touch') {
        // The touch template reads the controller through a function generic over `SpiDevice`, so the
        // trait has to be nameable: `embedded-hal-bus` brings the trait's *implementations* but not the
        // crate name itself. Same 1.0 line mipidsi and embedded-hal-bus already resolve to.
        dependencies.push(`embedded-hal = "${ESP_CRATE_VERSIONS.embeddedHal}"`);
    }

    return `# Generated by Grumpy's Rusty Platform for VS Code.
# Board: ${board.name} (${board.family}, ${board.flashSize} flash)
# Template: ${template}
# Regenerating this file will overwrite local edits.

[package]
name = "${crateName}"
version = "0.1.0"
edition = "2024"
# esp-hal ${ESP_CRATE_VERSIONS.espHal} requires this Rust version.
rust-version = "${ESP_RUST_VERSION}"
license = "MIT OR Apache-2.0"
publish = false
${features}
[dependencies]
${dependencies.join('\n')}

[profile.release]
opt-level = "s"
lto = true
debug = true
`;
}

function espCargoConfigToml(board: EspBoardProfile, template: AppTemplate): string {
    const needsAlloc = template === 'wifi';
    return `# Generated by Grumpy's Rusty Platform for VS Code.
#
# Compilation settings live here, runtime settings in esp-config.toml -- that split is
# what the vendor's own generator does, and \`include\` is what joins them back up.
include = ["esp-config.toml"]

[target.${board.target}]
# \`cargo run\` flashes over USB serial and then shows the log. No debug probe is involved:
# the ESP32 boot ROM speaks UART, not SWD.
runner = "espflash flash --monitor --chip ${board.espChip}"

[build]
target = "${board.target}"
rustflags = [
  # Xtensa images are linked without the C runtime startup files.
  "-C", "link-arg=-nostartfiles",
]

[unstable]
# The Xtensa targets are not in a released rustc, so core is rebuilt from source --
# which is why the espup toolchain ships rust-src.
build-std = [${needsAlloc ? '"alloc", ' : ''}"core"]
`;
}

function espConfigToml(): string {
    return `# Runtime configuration for the ESP logging stack.
[env]
# log level for esp-println, read by esp_println::logger::init_logger_from_env() in main;
# change to "debug" or "trace" when something is silent.
ESP_LOG = "info"
`;
}

function espRustToolchainToml(): string {
    return `# The Xtensa targets are only in Espressif's fork, installed by espup under this
# channel name. Install it with:
#
#   cargo install espup --locked
#   espup install --targets esp32,esp32s3
#   source $HOME/export-esp.sh
#
# Grumpy's Rusty Platform can do the first two steps for you: run the
# "Install ESP Toolchain" command from the palette.
[toolchain]
channel = "${ESP_TOOLCHAIN_CHANNEL}"
`;
}

function espBuildRs(): string {
    return `// Generated by Grumpy's Rusty Platform for VS Code.
//
// Two jobs: make sure the Xtensa linker really is on PATH, and add the linker script
// every esp-hal image needs.

fn main() {
    check_xtensa_linker();
    // Must be the last linker script, and the only one an esp-hal image needs: the
    // ESP-IDF bootloader owns the flash layout, so there is no memory.x here.
    println!("cargo:rustc-link-arg=-Tlinkall.x");
}

/// Xtensa cannot be linked by LLVM's own linker: it needs the GCC toolchain that comes
/// with espup, which only appears on PATH after \`source $HOME/export-esp.sh\`. Without
/// this check the build fails with a bare "linker not found", which says nothing about
/// what to do -- so the failure is turned into instructions instead.
fn check_xtensa_linker() {
    println!("cargo:rerun-if-env-changed=PATH");

    let target = std::env::var("TARGET").unwrap_or_default();
    let env_var = format!(
        "CARGO_TARGET_{}_LINKER",
        target.replace('-', "_").to_ascii_uppercase()
    );
    println!("cargo:rerun-if-env-changed={env_var}");

    let linker = std::env::var(&env_var).unwrap_or_else(|_| {
        target
            .strip_prefix("xtensa-")
            .and_then(|rest| rest.strip_suffix("-none-elf"))
            .map(|chip| format!("xtensa-{chip}-elf-gcc"))
            .unwrap_or_else(|| "xtensa-esp32-elf-gcc".to_string())
    });

    if std::process::Command::new(&linker).arg("--version").output().is_err() {
        panic!(
            "Xtensa linker \`{linker}\` was not found on PATH.\\n\\n\\
             Install the toolchain with \`espup install --targets esp32,esp32s3\` and then run\\n\\
             \`source $HOME/export-esp.sh\` in this shell before building."
        );
    }
}
`;
}

// ----------------------------------------------------------------------- main

function espMainHeader(board: EspBoardProfile, template: AppTemplate): string {
    return (
        [
            "// Generated by Grumpy's Rusty Platform for VS Code.",
            `// Target: ${board.name} (${board.family}, ${board.target})`,
            `// Template: ${template}`,
        ].join('\n') + '\n'
    );
}

/**
 * Escape text for a Rust string literal.
 *
 * Board names contain quotes -- "Sunton ESP32-3248S035R (3.5\" CYD)" is one -- and pasting
 * that straight into `log::info!` produces firmware that cannot compile. Found by reading
 * generated output rather than by trusting the template.
 */
function rustString(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** The common prologue: HAL init, the esp-rtos scheduler, and a boot marker. */
function espBootBlock(board: EspBoardProfile): string {
    return `    let config = esp_hal::Config::default().with_cpu_clock(CpuClock::max());
    let peripherals = esp_hal::init(config);

    let timg0 = TimerGroup::new(peripherals.TIMG0);
    esp_rtos::start(timg0.timer0, peripherals.FROM_CPU_INTR0);

    // log::info! needs a logger installed, and the log-04 feature does not install one by itself: without
    // this line every log::info! below is dropped, so a perfectly healthy app looks dead on the serial port.
    // Found by flashing a generated project to a real board on 2026-10-05 -- the bootloader reported
    // "Loaded app from partition at offset 0x10000" and then nothing at all, for as long as we listened.
    // esp-println's logger reads ESP_LOG, which .cargo/esp-config.toml sets.
    esp_println::logger::init_logger_from_env();

    // The USB serial buffer keeps whatever was printed before a reset, so the log starts
    // with a line that can only come from this run.
    log::info!("=== {} {} starting ===", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"));
    log::info!("board: ${rustString(board.name)} (${board.family}), ${board.flashSize} flash");
`;
}

function espImports(board: EspBoardProfile, template: AppTemplate): string {
    if (template === 'touch') {
        return [
            // The bus is shared by two chips, so it lives in a RefCell.
            'use core::cell::RefCell;',
            'use embassy_executor::Spawner;',
            'use embassy_time::{Duration, Timer};',
            'use embedded_graphics::mono_font::{ascii::FONT_6X10, MonoTextStyle};',
            'use embedded_graphics::pixelcolor::Rgb565;',
            'use embedded_graphics::prelude::*;',
            'use embedded_graphics::primitives::{Line, PrimitiveStyle, Rectangle};',
            'use embedded_graphics::text::Text;',
            // Named directly: the XPT2046 read helper is generic over `SpiDevice`.
            'use embedded_hal::spi::SpiDevice;',
            // Two devices on one bus: the adapter for that is `RefCellDevice`, not `ExclusiveDevice`.
            'use embedded_hal_bus::spi::RefCellDevice;',
            'use esp_hal::clock::CpuClock;',
            'use esp_hal::delay::Delay;',
            // `Input`/`Pull` are the touch controller's PENIRQ line: low means pressed.
            'use esp_hal::gpio::{Input, InputConfig, Level, Output, OutputConfig, Pull};',
            'use esp_hal::spi::master::{Config as SpiConfig, Spi};',
            'use esp_hal::time::Rate;',
            'use esp_hal::timer::timg::TimerGroup;',
            'use esp_println as _;',
            'use mipidsi::options::{ColorOrder, Orientation};',
            'use mipidsi::{models, Builder};',
            'use mipidsi::interface::SpiInterface as SPIInterface;',
        ].join('\n');
    }
    if (template === 'display') {
        return [
            'use embassy_executor::Spawner;',
            'use embassy_time::{Duration, Instant, Timer};',
            // The full embedded-graphics crate, not -core: the diagnostics below need Rectangle, Line, Text
            // and a font, and -core is only the traits and the colour types (which this one re-exports).
            'use embedded_graphics::mono_font::{ascii::{FONT_6X10, FONT_10X20}, MonoTextStyle};',
            'use embedded_graphics::pixelcolor::Rgb565;',
            'use embedded_graphics::prelude::*;',
            'use embedded_graphics::primitives::{Line, PrimitiveStyle, Rectangle};',
            'use embedded_graphics::text::Text;',
            'use embedded_hal_bus::spi::ExclusiveDevice;',
            'use esp_hal::clock::CpuClock;',
            'use esp_hal::delay::Delay;',
            'use esp_hal::gpio::{Level, Output, OutputConfig};',
            'use esp_hal::spi::master::{Config as SpiConfig, Spi};',
            'use esp_hal::time::Rate;',
            'use esp_hal::timer::timg::TimerGroup;',
            'use esp_println as _;',
            'use mipidsi::options::{ColorOrder, Orientation};',
            'use mipidsi::{models, Builder};',
            // The **buffered** interface, and it must be this one: the call below passes a batching buffer
            // (`SPIInterface::new(spi, dc, &mut buffer)`), which is mipidsi's own three-argument type.
            // `display_interface_spi::SPIInterface` takes two and has no buffer at all, so importing it here
            // produced a project that could not compile — found by inspecting a user's working Sunton project
            // on 2026-10-05, which carried exactly this fix by hand.
            'use mipidsi::interface::SpiInterface as SPIInterface;',
        ].join('\n');
    }
    const lines = [
        'use embassy_executor::Spawner;',
        'use embassy_time::{Duration, Timer};',
        'use esp_hal::clock::CpuClock;',
        'use esp_hal::timer::timg::TimerGroup;',
        'use esp_println as _;',
    ];
    if (board.led.kind === 'gpio') {
        lines.push('use esp_hal::gpio::{Level, Output, OutputConfig};');
    }
    return lines.join('\n');
}

function espMainRs(board: EspBoardProfile, template: AppTemplate, choices: BoardChoices): string {
    const usesPanel = template === 'display' || template === 'touch';
    const display = usesPanel ? displayFor(board, choices) : undefined;
    const touch = template === 'touch' ? board.touch : undefined;
    const led = board.led;

    const body = display !== undefined && touch !== undefined
        ? espTouchBody(display, touch)
        : display !== undefined
            ? espDisplayBody(display, board)
            : led.kind === 'gpio'
                ? espLedBody(led.pin, led.external === true)
                : espHeartbeatBody();

    return `${espMainHeader(board, template)}
#![no_std]
#![no_main]

${espImports(board, template)}
use esp_backtrace as _;

// The ESP-IDF bootloader expects an application descriptor in the image. Without it the
// bootloader refuses to start the image, so this line is not decoration.
esp_bootloader_esp_idf::esp_app_desc!();

#[esp_rtos::main]
async fn main(_spawner: Spawner) -> ! {
${espBootBlock(board)}
${body}
}
`;
}

/**
 * The panel's own scan direction, as the board data states it.
 *
 * `mirrorX` means the panel's X axis runs opposite to the controller's default, which is a property of how
 * the glass is wired, not of the drawing: mipidsi applies it through MADCTL, so the coordinates in this file
 * stay the readable ones. Omitted this, the whole image is a mirror -- text included -- which is exactly what
 * the diagnostic screen showed on the real Sunton board on 2026-10-05, and what the board definition had said
 * all along. Every panel emits the line, so a board that needs no mirror says so in the generated code.
 */
function orientation(display: EspDisplay): string {
    const flips = `${display.mirrorX ? '.flip_horizontal()' : ''}${display.mirrorY ? '.flip_vertical()' : ''}`;
    const note = flips
        ? `
        // ${display.label}: ${display.mirrorX ? 'X is mirrored' : 'Y is mirrored'} relative to the controller's default.`
        : '';
    return `${note}
        .orientation(Orientation::new()${flips})`;
}

/**
 * Panel bring-up plus the touch controller, and a four-corner calibration the user can carry out on the
 * glass.
 *
 * The XPT2046 is a resistive controller on the *same* SPI bus as the panel: its own chip select, its own
 * PENIRQ line, and a maximum clock of a couple of MHz — so the bus clock is switched down around each
 * burst (see `espPanelSetup` with `shared: true`).
 *
 * Two things about this controller are worth knowing before reading the code, and both were learned on
 * this board rather than assumed:
 *
 * 1. **It answers one command behind.** The 12 bits of a conversion are clocked out during the *next*
 *    command's clocks, high byte first with the low nibble in the top half of the second byte. Reading
 *    each channel as if the result came with its own command gives values eight times too small (the
 *    first corner read back as 14 counts instead of 2050).
 * 2. **PENIRQ is only enabled by the power-down bits.** Every command has two PD bits, and 00 is the only
 *    setting that leaves the interrupt enabled between conversions — which is why the reference driver
 *    ends its bursts with a `PD=00` command. The first firmware here used `PD=01` bytes throughout, so
 *    GPIO36 sat silent while a finger was held on the glass, and it looked like a dead controller.
 *
 * Detection therefore uses the interrupt when it is wired *and* a measured baseline of the two axes, and
 * the log says which one fired. Untouched, this panel's axes sit at mid-scale (2048 and 2055 here); a
 * finger pulls them hundreds of counts away, which is a wide margin against the tens of counts of noise.
 *
 * The calibration itself is measured, never assumed: the firmware asks for the four corners, works the
 * mapping out from what it read, and then draws a crosshair where it *thinks* the finger is. A crosshair
 * under the finger means the mapping is right; one that drifts or runs off the edge is what a wrong
 * calibration looks like, and the log carries the raw frames either way.
 *
 * `embedded-hal` is the only crate added for this, because the read helper is generic over `SpiDevice`.
 */
function espTouchBody(display: EspDisplay, touch: EspTouch): string {
    return `${espPanelSetup(display, true)}
    // The touch controller's own clock: the panel's is restored around every burst.
    let touch_clock = || SpiConfig::default().with_frequency(Rate::from_khz(${Math.round(touch.spiHz / 1000)}));

    // The same bus, a second chip select. PENIRQ is open drain, hence the pull-up: low means pressed.
    let touch_cs = Output::new(peripherals.GPIO${touch.cs}, Level::Low, OutputConfig::default());
    let mut touch = RefCellDevice::new(&bus, touch_cs, Delay::new()).expect("touch chip select");
    let touch_irq = Input::new(peripherals.GPIO${touch.irq}, InputConfig::default().with_pull(Pull::Up));

    // Control bytes from the XPT2046 datasheet: S=1 | channel | 12-bit | single-ended | power-down bits.
    // 0xD1 reads one panel axis, 0x91 the other, and 0xD0 is the same axis read with PD=00: powered down
    // between conversions, which is the only setting that re-enables PENIRQ.
    const TOUCH_AXIS_A: u8 = 0xD1;
    const TOUCH_AXIS_B: u8 = 0x91;
    const TOUCH_POWER_DOWN: u8 = 0xD0;
    // How far an axis has to move from its idle baseline to count as a touch, and how many samples a
    // calibration reading averages.
    const TOUCH_MOVE: i32 = 200;
    const TOUCH_SAMPLES: u32 = 3;

    // One command, and the two bytes that come back with it. The bytes are returned as they arrived
    // because which bit of which byte holds what is the one thing worth seeing on a first bring-up.
    fn touch_frame<D: SpiDevice>(device: &mut D, command: u8) -> u16 {
        let mut frame = [command, 0x00];
        if device.transfer_in_place(&mut frame).is_err() {
            return 0;
        }
        ((frame[0] as u16) << 8) | frame[1] as u16
    }

    // The 12 bits of the *previous* command's conversion: high byte, then the low nibble in the top half
    // of the second byte. Shifting right by three, as the common Arduino driver does, is eight times too
    // small for this panel.
    fn touch_value(frame: u16) -> u16 {
        ((((frame >> 8) & 0x00FF) << 4) | ((frame & 0x00FF) >> 4)) & 0x0FFF
    }

    // One axis, averaged over a few conversions. The first read is the value that arrived with a command
    // for the *previous* channel, so it is dropped.
    fn touch_axis<D: SpiDevice>(device: &mut D, command: u8) -> (u16, [u16; TOUCH_SAMPLES as usize]) {
        let _ = touch_frame(device, command);
        let mut frames = [0u16; TOUCH_SAMPLES as usize];
        for frame in frames.iter_mut() {
            *frame = touch_frame(device, command);
        }
        let total: u32 = frames.iter().map(|frame| u32::from(touch_value(*frame))).sum();
        ((total / TOUCH_SAMPLES) as u16, frames)
    }

    // Leave the controller powered down *with the interrupt enabled*, which is what makes PENIRQ usable
    // between bursts. Without it the line stays high whatever the glass does.
    fn touch_idle<D: SpiDevice>(device: &mut D) {
        let _ = touch_frame(device, TOUCH_POWER_DOWN);
    }

    log::info!(
        "touch: ${touch.controller} on GPIO${touch.cs} (cs), GPIO${touch.irq} (irq), pen level now {}",
        touch_irq.is_low()
    );

    // The idle baseline, taken before anything is drawn: this is what the axes read with nothing on the
    // glass, and a touch is judged by how far they move from it.
    bus.borrow_mut().apply_config(&touch_clock()).expect("touch clock");
    let (idle_a, _) = touch_axis(&mut touch, TOUCH_AXIS_A);
    let (idle_b, _) = touch_axis(&mut touch, TOUCH_AXIS_B);
    touch_idle(&mut touch);
    bus.borrow_mut().apply_config(&panel_clock()).expect("panel clock");
    let (idle_a, idle_b) = (i32::from(idle_a), i32::from(idle_b));
    log::info!("touch: idle baseline a={} b={}", idle_a, idle_b);

    // The four corners the screen asks for, in the order it asks.
    const MARGIN: i32 = 24;
    const WIDTH: i32 = ${display.width};
    const HEIGHT: i32 = ${display.height};
    let targets = [
        (MARGIN, MARGIN),
        (WIDTH - MARGIN, MARGIN),
        (WIDTH - MARGIN, HEIGHT - MARGIN),
        (MARGIN, HEIGHT - MARGIN),
    ];
    let corners = ["top-left", "top-right", "bottom-right", "bottom-left"];
    let mut measured = [[0u16; 2]; 4];
    let mut corner: usize = 0;
    let mut raw_x_axis: usize = 0;
    let mut x_from: i32 = 0;
    let mut x_to: i32 = 0;
    let mut y_from: i32 = 0;
    let mut y_to: i32 = 0;
    let mut point = (WIDTH / 2, HEIGHT / 2);
    let mut was_touched = false;
    let mut redraw = true;
    let mut ticks: u32 = 0;
    let mut last_a: u16 = 0;
    let mut last_b: u16 = 0;

    loop {
        if redraw {
            display.clear(Rgb565::BLACK).expect("panel write failed");
            let style = MonoTextStyle::new(&FONT_6X10, Rgb565::WHITE);
            if corner < 4 {
                Text::new("Touch the red square", Point::new(8, 10), style)
                    .draw(&mut display)
                    .expect("panel write failed");
                Text::new(corners[corner], Point::new(8, 24), style)
                    .draw(&mut display)
                    .expect("panel write failed");
            } else {
                Text::new("Touch anywhere: the crosshair follows", Point::new(8, 10), style)
                    .draw(&mut display)
                    .expect("panel write failed");
                Text::new("raw and mapped values go to the log", Point::new(8, 24), style)
                    .draw(&mut display)
                    .expect("panel write failed");
            }
            for (index, target) in targets.iter().enumerate() {
                let (x, y) = *target;
                // The corner being asked for is red; the other three stay dim as reference points.
                let colour = if index == corner { Rgb565::RED } else { Rgb565::new(2, 10, 2) };
                Rectangle::new(Point::new(x - 12, y - 12), Size::new(24, 24))
                    .into_styled(PrimitiveStyle::with_fill(colour))
                    .draw(&mut display)
                    .expect("panel write failed");
            }
            if corner >= 4 {
                // The crosshair sits where the firmware *thinks* the finger is. Under the finger means the
                // mapping is right; beside it, or off the edge, is what a wrong calibration looks like.
                Line::new(Point::new(point.0 - 16, point.1), Point::new(point.0 + 16, point.1))
                    .into_styled(PrimitiveStyle::with_stroke(Rgb565::YELLOW, 2))
                    .draw(&mut display)
                    .expect("panel write failed");
                Line::new(Point::new(point.0, point.1 - 16), Point::new(point.0, point.1 + 16))
                    .into_styled(PrimitiveStyle::with_stroke(Rgb565::YELLOW, 2))
                    .draw(&mut display)
                    .expect("panel write failed");
            }
            redraw = false;
        }

        // Every third tick is about 60 ms; a burst is a few bytes at 2 MHz, so the panel's clock is only
        // away for microseconds.
        ticks = ticks.wrapping_add(1);
        if ticks % 3 == 0 {
            bus.borrow_mut().apply_config(&touch_clock()).expect("touch clock");
            let (raw_a, frames_a) = touch_axis(&mut touch, TOUCH_AXIS_A);
            let (raw_b, frames_b) = touch_axis(&mut touch, TOUCH_AXIS_B);
            touch_idle(&mut touch);
            bus.borrow_mut().apply_config(&panel_clock()).expect("panel clock");
            last_a = raw_a;
            last_b = raw_b;

            // A touch is the axes *moving*, and deliberately not the interrupt line on its own.
            //
            // Measured on this panel: GPIO36 reads pen=true in heartbeats with nothing anywhere near the
            // glass, and every phantom "tap" arrived with both axes still sitting exactly on their idle
            // values (a=2048 b=2054, frame for frame). The line is not a usable touch signal here, so it is
            // logged rather than trusted -- an interrupt that fires on its own is worse than none, because
            // it walks the calibration through all four corners while nobody is touching anything.
            let irq = touch_irq.is_low();
            let moved = (i32::from(raw_a) - idle_a).abs() > TOUCH_MOVE
                || (i32::from(raw_b) - idle_b).abs() > TOUCH_MOVE;
            let touched = moved;

            if touched && !was_touched {
                log::info!(
                    "touch: {} a={} b={} frames a=[{:04X} {:04X} {:04X}] b=[{:04X} {:04X} {:04X}]",
                    if irq { "axes moved (irq also low)" } else { "axes moved" },
                    raw_a,
                    raw_b,
                    frames_a[0],
                    frames_a[1],
                    frames_a[2],
                    frames_b[0],
                    frames_b[1],
                    frames_b[2]
                );
                if corner < 4 {
                    measured[corner] = [raw_a, raw_b];
                    log::info!("touch: corner {} {} recorded", corner + 1, corners[corner]);
                    corner += 1;
                    if corner == 4 {
                        // Which raw axis follows the display's X is a property of how this panel is wired, so
                        // it is worked out from the two corners that differ only along the display's X.
                        let delta_a = (i32::from(measured[1][0]) - i32::from(measured[0][0])).abs();
                        let delta_b = (i32::from(measured[1][1]) - i32::from(measured[0][1])).abs();
                        raw_x_axis = if delta_a >= delta_b { 0 } else { 1 };
                        let raw_y_axis = 1 - raw_x_axis;
                        x_from = i32::from(measured[0][raw_x_axis]);
                        x_to = i32::from(measured[1][raw_x_axis]);
                        y_from = i32::from(measured[0][raw_y_axis]);
                        y_to = i32::from(measured[3][raw_y_axis]);
                        log::info!(
                            "calibration: raw axis{} {}..{} and axis{} {}..{} over {}x{}",
                            raw_x_axis, x_from, x_to, raw_y_axis, y_from, y_to, WIDTH, HEIGHT
                        );
                    }
                    redraw = true;
                } else {
                    let axis_x = if raw_x_axis == 0 { raw_a } else { raw_b };
                    let axis_y = if raw_x_axis == 0 { raw_b } else { raw_a };
                    let px = if x_to == x_from {
                        WIDTH / 2
                    } else {
                        MARGIN + (i32::from(axis_x) - x_from) * (WIDTH - 2 * MARGIN) / (x_to - x_from)
                    }
                    .clamp(0, WIDTH - 1);
                    let py = if y_to == y_from {
                        HEIGHT / 2
                    } else {
                        MARGIN + (i32::from(axis_y) - y_from) * (HEIGHT - 2 * MARGIN) / (y_to - y_from)
                    }
                    .clamp(0, HEIGHT - 1);
                    point = (px, py);
                    log::info!("touch: a={} b={} -> pixel ({}, {})", raw_a, raw_b, px, py);
                    redraw = true;
                }
            }
            was_touched = touched;
        }

        if ticks % 100 == 0 {
            // A heartbeat with the numbers that matter: the last readings, whether the interrupt line is
            // doing anything at all, and whether the axes are moving. "The log is quiet" then cannot be
            // mistaken for "the app is not running".
            log::info!(
                "touch test alive: a={} b={} idle a={} b={} pen={}",
                last_a,
                last_b,
                idle_a,
                idle_b,
                touch_irq.is_low()
            );
        }
        Timer::after(Duration::from_millis(20)).await;
    }`;
}

/**
 * Panel bring-up, shared by the display and touch templates.
 *
 * Both templates need the same things in the same order — backlight, SPI bus, chip select, batching
 * buffer, data/command pin, mipidsi's builder, the panel's own clock — and the only difference is whether
 * a second chip shares the bus. One function is what stops the two templates from drifting: a panel fix
 * (and every one of them has been found the hard way) lands in both at once.
 *
 * `shared` is the touch case: the XPT2046 sits on the same SPI bus, so the bus goes into a `RefCell` and
 * each chip gets its own `RefCellDevice` with its own CS pin.
 */
function espPanelSetup(display: EspDisplay, shared: boolean): string {
    const miso =
        display.spi.miso === undefined ? '' : `\n        .with_miso(peripherals.GPIO${display.spi.miso})`;
    const reset =
        display.rst === undefined ? '' : `\n        .reset_pin(rst)`;
    const resetSetup =
        display.rst === undefined
            ? ''
            : `\n    let rst = Output::new(peripherals.GPIO${display.rst}, Level::High, OutputConfig::default());\n`;

    if (shared) {
        return `
    // Backlight first, and note the level: ${display.backlightActiveLow ? 'this board switches the transistor on with a LOW level' : 'this board switches the transistor on with a HIGH level'}.
    let _backlight = Output::new(
        peripherals.GPIO${display.backlight},
        ${display.backlightActiveLow ? 'Level::Low' : 'Level::High'},
        OutputConfig::default(),
    );
${resetSetup}
    // The panel's clock is kept as a closure because the touch controller on the same bus needs a slower
    // one: the bus is re-configured around each touch read and put back afterwards.
    let panel_clock = || SpiConfig::default().with_frequency(Rate::from_khz(${Math.round(display.spiHz / 1000)}));
    let spi = Spi::new(peripherals.SPI2, panel_clock())
    .expect("SPI configuration")
        .with_sck(peripherals.GPIO${display.spi.sclk})
        .with_mosi(peripherals.GPIO${display.spi.mosi})${miso};

    // The touch controller shares this bus, so the bus goes into a RefCell and each chip gets its own
    // device with its own CS pin.
    let bus = RefCell::new(spi);
    let cs = Output::new(peripherals.GPIO${display.cs}, Level::Low, OutputConfig::default());
    // Shadows the bus with the panel's *device*, exactly as the exclusive branch does, so the rest of
    // the setup -- and mipidsi's interface below -- does not care which of the two it was handed.
    let spi = RefCellDevice::new(&bus, cs, Delay::new()).expect("panel chip select");

    // 512 bytes is mipidsi's own example buffer size: enough to batch pixels, small
    // enough to live on the stack, so this build needs no heap.
    let mut buffer = [0u8; 512];
    let dc = Output::new(peripherals.GPIO${display.dc}, Level::Low, OutputConfig::default());
    let di = SPIInterface::new(spi, dc, &mut buffer);

    // Delay is a unit struct in esp-hal 1.x, not a value: it is built with new().
    let mut delay = Delay::new();
    let mut display = Builder::new(models::${display.controller}, di)
        .display_size(${display.width}, ${display.height})${reset}${orientation(display)}
        .color_order(ColorOrder::${display.colorOrder === 'bgr' ? 'Bgr' : 'Rgb'})
        .init(&mut delay)
        .expect("panel initialisation");

    log::info!("panel ready: ${rustString(display.label)}");
`;
    }
    return `
    // Backlight first, and note the level: ${display.backlightActiveLow ? 'this board switches the transistor on with a LOW level' : 'this board switches the transistor on with a HIGH level'}.
    let _backlight = Output::new(
        peripherals.GPIO${display.backlight},
        ${display.backlightActiveLow ? 'Level::Low' : 'Level::High'},
        OutputConfig::default(),
    );
${resetSetup}
    let spi = Spi::new(
        peripherals.SPI2,
        // ${display.label}: ${display.spiHz} Hz. Lower this first if the image is unstable.
        SpiConfig::default().with_frequency(Rate::from_khz(${Math.round(display.spiHz / 1000)})),
    )
    .expect("SPI configuration")
        .with_sck(peripherals.GPIO${display.spi.sclk})
        .with_mosi(peripherals.GPIO${display.spi.mosi})${miso};

    // esp-hal's Spi is a *bus*; mipidsi wants a SpiDevice, which is that bus plus its own CS pin.
    // embedded-hal-bus is the crate that joins the two (the recipe esp-hal's own examples use).
    let cs = Output::new(peripherals.GPIO${display.cs}, Level::Low, OutputConfig::default());
    let spi = ExclusiveDevice::new(spi, cs, Delay::new()).expect("SPI device");

    // 512 bytes is mipidsi's own example buffer size: enough to batch pixels, small
    // enough to live on the stack, so this build needs no heap.
    let mut buffer = [0u8; 512];
    let dc = Output::new(peripherals.GPIO${display.dc}, Level::Low, OutputConfig::default());
    let di = SPIInterface::new(spi, dc, &mut buffer);

    // Delay is a unit struct in esp-hal 1.x, not a value: it is built with new().
    let mut delay = Delay::new();
    let mut display = Builder::new(models::${display.controller}, di)
        .display_size(${display.width}, ${display.height})${reset}${orientation(display)}
        .color_order(ColorOrder::${display.colorOrder === 'bgr' ? 'Bgr' : 'Rgb'})
        .init(&mut delay)
        .expect("panel initialisation");

    log::info!("panel ready: ${rustString(display.label)}");
`;
}

/**
 * Geometry for the diagnostic screen, solved from the panel size rather than hard-coded
 * for the 3.5" CYD: the same template is offered to a 128x128 T-QT, where the CYD's
 * numbers would put the greeting, the bars and the blinking square off the glass.
 */
export interface EspDiagnosticLayout {
    width: number;
    height: number;
    margin: number;
    cornerSize: number;
    barGap: number;
    barWidth: number;
    barHeight: number;
    barY: number;
    greetingFont: 'FONT_6X10' | 'FONT_10X20';
    greetingX: number;
    greetingY: number;
    statusX: number;
    statusY: number;
    statusStep: number;
    statusLines: string[];
    blinkSize: number;
    blinkX: number;
    blinkY: number;
}

/** FONT_6X10 is a 6 px advance and a 10 px box; FONT_10X20 is 10 and 20. */
const FONT_METRICS = {
    FONT_6X10: { advance: 6, height: 10 },
    FONT_10X20: { advance: 10, height: 20 },
} as const;

export function espDiagnosticLayout(display: EspDisplay, board: EspBoardProfile): EspDiagnosticLayout {
    const width = display.width;
    const height = display.height;
    const margin = Math.max(8, Math.round(width * 0.05));
    // Big enough to see at a glance, small enough to leave the drawing room: a 24 px marker is a fifth of a
    // 128 px panel, so small panels get smaller markers rather than no drawing area.
    const cornerSize = Math.min(24, Math.floor(Math.min(width, height) / 8));
    const barGap = Math.max(2, Math.round(width / 64));
    const barWidth = Math.max(4, Math.floor((width - 2 * margin - 4 * barGap) / 5));
    const barHeight = Math.max(10, Math.min(60, Math.round(height * 0.14)));
    // Everything is packed downwards in bands, and no band is allowed to cover an earlier one: bars start
    // below the corner markers, the greeting below the bars, the status text below the greeting, and the
    // blinking square is anchored to the bottom edge above the bottom corner markers.
    const barY = cornerSize + 6;

    // The greeting is the one line that must fit whatever the panel is: FONT_10X20 needs 130 px for it.
    const greetingFont: 'FONT_6X10' | 'FONT_10X20' = width >= 200 ? 'FONT_10X20' : 'FONT_6X10';
    const greeting = FONT_METRICS[greetingFont];
    const greetingX = Math.max(margin, Math.floor((width - 'Hello Grumpy!'.length * greeting.advance) / 2));
    const greetingY = barY + barHeight + 6;

    // The status text is FONT_6X10 and starts on its own line, below the greeting.
    const statusX = 6;
    const statusStep = 12;
    const statusFont = FONT_METRICS.FONT_6X10;
    const statusY = greetingY + greeting.height + 6;
    const maxChars = Math.max(6, Math.floor((width - 2 * statusX) / statusFont.advance));
    const candidates = width >= 240
        ? [
            board.name,
            `${board.espChip} · ${width}x${height} · ${display.controller}`,
            'frame complete? corners: red TL, green TR',
            'blue BL, white BR',
            'bars L to R: red green blue black white',
            'text upright? colours right? square blinking?',
        ]
        : [
            `${board.espChip} ${width}x${height}`,
            display.controller,
            'cors: R G B W',
            'bars: R G B K W',
            'text upright?',
            'square blinks?',
        ];
    // Anything wider than the glass is dropped rather than drawn off the edge: the status lines exist to be
    // read, and a half-drawn line is worse than a missing one.
    const fitting = candidates.filter((line) => line.length <= maxChars);

    const blinkSize = Math.min(24, Math.floor(Math.min(width, height) / 6));
    const blinkX = width - margin - blinkSize;
    const blinkY = height - (cornerSize + 6) - blinkSize;
    // As many lines as fit above the blinking square, and never one that would run into it.
    const room = blinkY - 2 - statusY - statusFont.height;
    const keep = room < 0 ? 0 : Math.floor(room / statusStep) + 1;
    const statusLines = (fitting.length > 0 ? fitting : [`${width}x${height}`]).slice(0, keep);

    return {
        width,
        height,
        margin,
        cornerSize,
        barGap,
        barWidth,
        barHeight,
        barY,
        greetingFont,
        greetingX,
        greetingY,
        statusX,
        statusY,
        statusStep,
        statusLines,
        blinkSize,
        blinkX,
        blinkY,
    };
}

/**
 * Panel bring-up, then a diagnostic screen.
 *
 * The screen is the point, and it is drawn to be *read*: a colour fill looks the same whether the active
 * area is cropped, the colour order is swapped or the image is rotated, while a frame, four coloured
 * corners, named bars and a line of text each answer one of those questions from a photograph.
 */
function espDisplayBody(display: EspDisplay, board: EspBoardProfile): string {
    const layout = espDiagnosticLayout(display, board);

    return `${espPanelSetup(display, false)}

    // A diagnostic screen rather than a flat fill, because a flat fill hides the three things that go wrong
    // on a new panel: a cropped or shifted active area, a swapped colour order, and a rotated image.
    //  - the frame: a missing side means the panel is cropped or offset;
    //  - the corners: red top-left, green top-right, blue bottom-left, white bottom-right, so a shift is
    //    measurable at a glance (a corner marker that is cut in half is the answer);
    //  - the bars: named left to right below, so red and blue trading places names the wrong colour order;
    //  - the cross: centred on the panel size, so an off-centre cross means the active area starts
    //    somewhere other than where the driver thinks;
    //  - the text and the blinking square: what this screen is meant to look like, and proof the loop runs.
    // Replace it with your own drawing once the panel is right.
    //
    // Timed on purpose: this screen takes tens of seconds to paint as a debug build and about a fifth
    // of a second as a release one, so "the panel is slow" has a number to look at instead of a
    // feeling. The Flash button builds release for an ESP board for exactly this reason.
    let drawn_at = Instant::now();
    display.clear(Rgb565::BLACK).expect("panel write failed");

    // A full-size frame, two pixels wide: every side visible means the whole area is addressable.
    Rectangle::new(Point::new(1, 1), Size::new(${layout.width} - 2, ${layout.height} - 2))
        .into_styled(PrimitiveStyle::with_stroke(Rgb565::WHITE, 2))
        .draw(&mut display)
        .expect("panel write failed");

    // The centre cross, drawn before the bars and the text so neither is covered by it.
    Line::new(Point::new(${layout.width} / 2, 0), Point::new(${layout.width} / 2, ${layout.height}))
        .into_styled(PrimitiveStyle::with_stroke(Rgb565::YELLOW, 1))
        .draw(&mut display)
        .expect("panel write failed");
    Line::new(Point::new(0, ${layout.height} / 2), Point::new(${layout.width}, ${layout.height} / 2))
        .into_styled(PrimitiveStyle::with_stroke(Rgb565::YELLOW, 1))
        .draw(&mut display)
        .expect("panel write failed");

    // Five bars, left to right: red, green, blue, black, white. If red and blue trade places, the panel's
    // colour order is the other one — flip ColorOrder in the builder above and reflash.
    for (index, colour) in [Rgb565::RED, Rgb565::GREEN, Rgb565::BLUE, Rgb565::BLACK, Rgb565::WHITE]
        .iter()
        .enumerate()
    {
        Rectangle::new(
            Point::new(${layout.margin} + (index as i32) * ${layout.barWidth + layout.barGap}, ${layout.barY}),
            Size::new(${layout.barWidth}, ${layout.barHeight}),
        )
            .into_styled(PrimitiveStyle::with_fill(*colour))
            .draw(&mut display)
            .expect("panel write failed");
    }

    // Corner markers, so a shift is measurable: red top-left, green top-right, blue bottom-left, white
    // bottom-right. A red square that is not in the corner, or one cut in half, is the answer.
    for (x, y, colour) in [
        (0, 0, Rgb565::RED),
        (${layout.width} - ${layout.cornerSize}, 0, Rgb565::GREEN),
        (0, ${layout.height} - ${layout.cornerSize}, Rgb565::BLUE),
        (${layout.width} - ${layout.cornerSize}, ${layout.height} - ${layout.cornerSize}, Rgb565::WHITE),
    ] {
        Rectangle::new(Point::new(x, y), Size::new(${layout.cornerSize}, ${layout.cornerSize}))
            .into_styled(PrimitiveStyle::with_fill(colour))
            .draw(&mut display)
            .expect("panel write failed");
    }

    Text::new("Hello Grumpy!", Point::new(${layout.greetingX}, ${layout.greetingY}), MonoTextStyle::new(&${layout.greetingFont}, Rgb565::YELLOW))
        .draw(&mut display)
        .expect("panel write failed");

${layout.statusLines.length === 0 ? '' : `    // What this screen is supposed to look like, in the panel's own words. Each line is only emitted if it
    // fits: a status line drawn off the edge is worse than no status line.
    let small = MonoTextStyle::new(&FONT_6X10, Rgb565::WHITE);
    let mut line = ${layout.statusY};
    for text in [
${layout.statusLines.map((line) => `        ${JSON.stringify(line)},`).join('\n')}
    ] {
        Text::new(text, Point::new(${layout.statusX}, line), small)
            .draw(&mut display)
            .expect("panel write failed");
        line += ${layout.statusStep};
    }
`}
    log::info!(
        "diagnostics drawn in {} ms: frame, corners, 5 bars, cross and text",
        drawn_at.elapsed().as_millis()
    );
    let mut tick: u32 = 0;
    loop {
        // One small square, blinking: proof the loop is alive, placed clear of every diagnostic so it cannot
        // be mistaken for one.
        let colour = if tick % 2 == 0 { Rgb565::WHITE } else { Rgb565::BLACK };
        Rectangle::new(Point::new(${layout.blinkX}, ${layout.blinkY}), Size::new(${layout.blinkSize}, ${layout.blinkSize}))
            .into_styled(PrimitiveStyle::with_fill(colour))
            .draw(&mut display)
            .expect("panel write failed");
        if tick % 10 == 0 {
            log::info!("alive (tick {})", tick);
        }
        tick = tick.wrapping_add(1);
        Timer::after(Duration::from_millis(700)).await;
    }`;
}

function espLedBody(pin: string, external: boolean): string {
    const note = external
        ? `
    // This board has no user LED (Espressif's own user guide lists a 5 V power LED and
    // nothing else), so GPIO${pin} is a suggestion rather than a fact: wire an LED and a
    // series resistor between GPIO${pin} and GND. Until you do, the board stays dark and
    // the only sign of life is the log.
`
        : '';
    return `${note}
    let mut led = Output::new(peripherals.GPIO${pin}, Level::Low, OutputConfig::default());

    loop {
        led.set_high();
        Timer::after_millis(500).await;
        led.set_low();
        Timer::after_millis(500).await;
    }`;
}

function espHeartbeatBody(): string {
    return `
    // No LED to blink on this board, so the heartbeat goes to the log instead. The panel
    // template is the interesting one here.
    let mut tick: u32 = 0;
    loop {
        tick += 1;
        log::info!("alive (tick {})", tick);
        Timer::after(Duration::from_secs(1)).await;
    }`;
}

// --------------------------------------------------------------- small files

function espVscodeSettings(board: EspBoardProfile): string {
    return `${JSON.stringify(
        {
            'rust-analyzer.cargo.target': board.target,
            'rust-analyzer.check.allTargets': false,
            'rust-analyzer.linkedProjects': ['Cargo.toml'],
        },
        null,
        2,
    )}\n`;
}

function espReadme(
    board: EspBoardProfile,
    crateName: string,
    template: AppTemplate,
    choices: BoardChoices,
): string {
    // Only the pins the generated firmware actually drives are listed: the SD socket is still
    // described in the notes rather than claimed, because no template touches it yet.
    const usesPanel = template === 'display' || template === 'touch';
    const display = usesPanel ? displayFor(board, choices) : undefined;
    const touch = template === 'touch' ? board.touch : undefined;
    const pinRows: string[] = [];
    if (display) {
        pinRows.push(`| ${display.cs} | panel chip select |`);
        pinRows.push(`| ${display.dc} | panel data/command |`);
        if (display.rst !== undefined) {
            pinRows.push(`| ${display.rst} | panel reset |`);
        }
        pinRows.push(`| ${display.backlight} | panel backlight (active ${display.backlightActiveLow ? 'low' : 'high'}) |`);
        pinRows.push(`| ${display.spi.sclk} | panel SPI clock |`);
        pinRows.push(`| ${display.spi.mosi} | panel SPI data out |`);
        if (display.spi.miso !== undefined) {
            pinRows.push(`| ${display.spi.miso} | panel SPI data in |`);
        }
    }
    if (touch) {
        pinRows.push(`| ${touch.cs} | ${touch.controller} touch chip select |`);
        pinRows.push(`| ${touch.irq} | ${touch.controller} touch interrupt (active low) |`);
    }

    const pinSection =
        pinRows.length === 0
            ? ''
            : `
## Pins this project uses

| GPIO | Use |
|---|---|
${pinRows.join('\n')}

These come from the board's own schematic or board definition rather than from a
guess; if you change one, change it in \`src/main.rs\` as well.
`;

    return `# ${crateName}

${board.family} firmware for **${board.name}**, generated by Grumpy's Rusty Platform
for VS Code.

- Target: \`${board.target}\`
- Chip: \`${board.espChip}\` (${board.flashSize} flash)
- Template: \`${template}\`
- Flashed with: \`espflash\` over USB serial — **no debug probe**

## First-time setup

The Xtensa targets are not in released Rust, so one extra toolchain is needed:

\`\`\`sh
cargo install espup --locked
espup install --targets esp32,esp32s3   # installs a toolchain called "esp"
source $HOME/export-esp.sh              # puts the Xtensa linker on PATH
\`\`\`

Add the \`source\` line to your shell profile if you build from a terminal. In VS Code,
Grumpy's Rusty Platform does it for you.

## Build / flash / monitor

\`\`\`sh
cargo build              # compile
cargo run --release      # flash and follow the log (runner in .cargo/config.toml)
\`\`\`

Or use the extension: **Build**, **Flash** and **Monitor**. Flash writes the *release*
build for this board — there is no probe-rs session on the USB-serial route, and a debug
build draws a panel roughly 130x slower. \`rustyPlatform.flashProfile\` overrides that,
and **Flash (debug)** / **Flash (release)** override it for one flash.

## Debugging

There are **no breakpoints** for this board in this setup. ESP32 has no SWD: it is
debugged through JTAG (OpenOCD + GDB), which needs a separate adapter. The **Debug**
button therefore offers **Flash & Monitor** instead of a debug session.

To add real debugging later you need an ESP-Prog, a USB-JTAG adapter or a board with
built-in JTAG pins, plus \`openocd\` and the Rust \`gdb\` support — a different workflow
from the Pico's.
${pinSection}
## Notes

${board.notes}
`;
}
