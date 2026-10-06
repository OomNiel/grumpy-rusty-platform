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
    /** NOR-flash access, for keeping the touch calibration across a power cycle. */
    espStorage: '0.10.0',
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
    if (board.displays.length > 0 && board.touch !== undefined) {
        // The board template: everything this board has, in one project. It is the touch template plus the
        // rest of the hardware, because that is literally what it is (see espTouchBody's `includeHardware`).
        templates.push({
            id: 'board',
            label: 'Board test (everything)',
            description:
                'Everything this board carries in one firmware: the panel with the graphics test screen, touch '
                + 'with its calibration, the RGB LED as a status light, the light sensor in the log, and a beep '
                + 'on the speaker each time a corner is recorded.',
        });
    }
    if (board.ldr !== undefined || board.audio !== undefined) {
        templates.push({
            id: 'peripherals',
            label: 'Sensors + sound',
            description:
                'Reads the on-board light sensor and plays a tone on the speaker connector: '
                + (board.ldr === undefined ? '' : `LDR on GPIO${board.ldr.pin} (ADC), `)
                + (board.audio === undefined ? '' : `speaker on GPIO${board.audio.pin} (DAC2 through a ${board.audio.seriesOhms ?? '?'} ohm resistor into an ${board.audio.amplifier})`)
                + '. Both values go to the log.',
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
    const display = template === 'display' || template === 'touch' || template === 'board'
        ? displayFor(board, choices)
        : undefined;
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

    // The ADC and DAC live behind esp-hal's `unstable` feature (confirmed in its source: the analog modules
    // are cfg-gated), so a project that reads the LDR or drives the speaker has to ask for it.
    const espHalFeatures = [`"${board.espChip}"`, '"log-04"'];
    if (template === 'peripherals' || template === 'board') {
        espHalFeatures.push('"unstable"');
    }
    const dependencies = [
        `esp-hal = { version = "${ESP_CRATE_VERSIONS.espHal}", features = [${espHalFeatures.join(', ')}] }`,
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
    if (template === 'touch' || template === 'board') {
        // The calibration is kept in flash, so the project needs the NOR-flash crate. Its chip feature is
        // what selects the flash driver, and it pulls the ROM glue that is already in the tree.
        dependencies.push(`esp-storage = { version = "${ESP_CRATE_VERSIONS.espStorage}", features = ["${board.espChip}"] }`);
    }
    if (template === 'touch' || template === 'board') {
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
    if (template === 'peripherals') {
        return [
            'use embassy_executor::Spawner;',
            'use embassy_time::{Duration, Timer};',
            // The analog peripherals live in esp_hal::analog and need the chip's `unstable` feature, which
            // this template asks for in Cargo.toml.
            'use esp_hal::analog::adc::{Adc, AdcConfig, Attenuation};',
            'use esp_hal::analog::dac::Dac;',
            'use esp_hal::clock::CpuClock;',
            'use esp_hal::timer::timg::TimerGroup;',
            'use esp_println as _;',
        ].join('\n');
    }
    if (template === 'touch' || template === 'board') {
        // Only the board template drives the LDR and the speaker, and an unused import is a warning, so the
        // analog imports are added where the hardware actually is.
        const hardwareImports = template === 'board'
            ? [
                'use esp_hal::analog::adc::{Adc, AdcConfig, Attenuation};',
                'use esp_hal::analog::dac::Dac;',
            ]
            : [];
        return [
            // The bus is shared by two chips, so it lives in a RefCell.
            'use core::cell::RefCell;',
            // `write!` into the fixed buffer that turns numbers into panel text.
            'use core::fmt::Write as _;',
            'use embassy_executor::Spawner;',
            'use embassy_time::{Duration, Timer};',
            'use embedded_graphics::mono_font::{ascii::{FONT_6X10, FONT_10X20}, MonoTextStyle};',
            'use embedded_graphics::pixelcolor::Rgb565;',
            'use embedded_graphics::prelude::*;',
            'use embedded_graphics::primitives::{Line, PrimitiveStyle, Rectangle};',
            'use embedded_graphics::text::Text;',
            // Named directly: the XPT2046 read helper is generic over `SpiDevice`.
            'use embedded_hal::spi::{Operation, SpiDevice};',
            // Two devices on one bus: the adapter for that is `RefCellDevice`, not `ExclusiveDevice`.
            'use embedded_hal_bus::spi::RefCellDevice;',
            'use esp_hal::clock::CpuClock;',
            'use esp_hal::delay::Delay;',
            // `Input`/`Pull` are the touch controller's PENIRQ line: low means pressed.
            'use esp_hal::gpio::{Input, InputConfig, Level, Output, OutputConfig, Pull};',
            // Flash access, for keeping the calibration across a power cycle.
            'use esp_storage::FlashStorage;',
            ...hardwareImports,
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
    if (board.led.kind === 'gpio' || board.led.kind === 'rgb') {
        lines.push('use esp_hal::gpio::{Level, Output, OutputConfig};');
    }
    return lines.join('\n');
}

function espMainRs(board: EspBoardProfile, template: AppTemplate, choices: BoardChoices): string {
    const usesPanel = template === 'display' || template === 'touch' || template === 'board';
    const display = usesPanel ? displayFor(board, choices) : undefined;
    const touch = template === 'touch' || template === 'board' ? board.touch : undefined;
    const led = board.led;

    const body = template === 'peripherals'
        ? espPeripheralsBody(board)
        : display !== undefined && touch !== undefined
        ? espTouchBody(display, board, touch, template === 'board')
        : display !== undefined
            ? espDisplayBody(display, board)
            : led.kind === 'gpio'
                ? espLedBody(led.pin, led.external === true)
                : led.kind === 'rgb'
                    ? espRgbLedBody(led.red, led.green, led.blue)
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
 * The RGB LED on a board that has one: three pins, cycled through red, green and blue.
 *
 * Kept as its own body rather than a branch inside the single-LED one because it is a different thing to
 * demonstrate: a three-pin LED shows that three GPIOs work *and* that the pins are the ones the board data
 * claims, which a single blink cannot.
 */
function espRgbLedBody(red: string, green: string, blue: string): string {
    return `
    // Blue, red and green, in that order, are what this board's own hardware notes give. The three pins are
    // driven one at a time so a swapped channel is visible as the wrong colour rather than as nothing.
    let mut red = Output::new(peripherals.GPIO${red}, Level::Low, OutputConfig::default());
    let mut green = Output::new(peripherals.GPIO${green}, Level::Low, OutputConfig::default());
    let mut blue = Output::new(peripherals.GPIO${blue}, Level::Low, OutputConfig::default());

    log::info!("RGB LED on GPIO${red} (red), GPIO${green} (green), GPIO${blue} (blue)");

    loop {
        for (name, colour) in [("red", 0usize), ("green", 1), ("blue", 2)] {
            log::info!("led: {}", name);
            red.set_level(Level::from(colour == 0));
            green.set_level(Level::from(colour == 1));
            blue.set_level(Level::from(colour == 2));
            Timer::after(Duration::from_millis(400)).await;
        }
        red.set_low();
        green.set_low();
        blue.set_low();
        Timer::after(Duration::from_millis(400)).await;
    }`;
}

/**
 * The board's sensors and its speaker: an LDR into an ADC channel, and a tone out of a DAC.
 *
 * Both halves are here because both are the *point of the wiring* rather than a generic demo. The LDR is the
 * lower leg of a divider (3.3V - 5k - pin - LDR - GND), so the number falls as the light rises -- the template
 * says so in the log instead of leaving the user to work out whether their sensor is upside down. The speaker
 * hangs off a DAC channel through a coupling resistor into a bridge amplifier, so a square wave written to the
 * DAC *is* the sound: there is no PWM, no filter and no timer to configure.
 */
function espPeripheralsBody(board: EspBoardProfile): string {
    const ldr = board.ldr;
    const audio = board.audio;
    const ldrSetup = ldr === undefined
        ? ''
        : `
    // The light sensor: 3.3V through a resistor into this pin, with the LDR to ground. 11 dB attenuation so
    // the full swing is readable rather than clipping at the top.
    let mut adc_config = AdcConfig::new();
    let mut light = adc_config.enable_pin(peripherals.GPIO${ldr.pin}, Attenuation::_11dB);
    let mut adc = Adc::new(peripherals.ADC1, adc_config);
`;
    const audioSetup = audio === undefined
        ? ''
        : `
    // The speaker: this pin is DAC channel 2, so what it outputs is the waveform itself.
    let mut speaker = Dac::new(peripherals.DAC2, peripherals.GPIO${audio.pin});
`;
    const ldrLoop = ldr === undefined
        ? ''
        : `
        // Non-blocking: retry rather than expect, because the first read after boot reports WouldBlock.
        let mut light_raw: Option<u16> = None;
        for _ in 0..50 {
            if let Ok(value) = adc.read_oneshot(&mut light) {
                light_raw = Some(value);
                break;
            }
            Timer::after(Duration::from_micros(200)).await;
        }
        let light_raw = light_raw.unwrap_or(4095);
        // The polarity is a property of the wiring, not of the ADC: the LDR faces ground, so a *brighter*
        // room reads *lower*. Print both so nobody has to guess which way round it is.
        log::info!(
            "ldr: {} of 4095 ({} - brighter light reads lower on this board)",
            light_raw,
            if light_raw > 3000 {
                "dark"
            } else if light_raw > 1500 {
                "dim"
            } else if light_raw > 500 {
                "lit"
            } else {
                "bright"
            }
        );
`;
    const audioLoop = audio === undefined
        ? ''
        : `
        // A square wave, which a small speaker reproduces loudest: half a millisecond each way is about a
        // kilohertz. Written straight to the DAC, so the loop *is* the sample clock.
        for _ in 0..200 {
            speaker.write(200);
            Timer::after(Duration::from_micros(500)).await;
            speaker.write(56);
            Timer::after(Duration::from_micros(500)).await;
        }
        // Back to the middle, so the amplifier is not left against a rail between tones.
        speaker.write(128);
`;
    const peripherals = [
        ldr === undefined ? undefined : `LDR on GPIO${ldr.pin} (ADC1)`,
        audio === undefined ? undefined : `speaker on GPIO${audio.pin} (DAC2 into an ${audio.amplifier})`,
    ].filter((line): line is string => line !== undefined).join(', ');

    return `
    log::info!("peripherals: ${peripherals}");
${ldrSetup}${audioSetup}
    loop {
${ldrLoop}${audioLoop}
        Timer::after(Duration::from_millis(1000)).await;
    }`;
}

/**
 * Panel bring-up plus the touch controller, a four-corner calibration, and a live readout of the numbers.
 *
 * The XPT2046 shares the panel's SPI bus: its own chip select and PENIRQ line, and a maximum clock of a
 * couple of MHz, so the bus clock is switched down around each burst (see `espPanelSetup` with
 * `shared: true`).
 *
 * Three things about this controller were learned on the board rather than assumed:
 *
 * 1. **It answers one command behind.** The 12 bits of a conversion are clocked out during the *next*
 *    command's clocks, high byte first with the low nibble in the top half of the second byte. Reading
 *    each channel as if the result came with its own command, and shifting right by three as the common
 *    Arduino driver does, gives values eight times too small.
 * 2. **PENIRQ is only enabled by the power-down bits.** Every command carries two PD bits, and 00 is the
 *    only setting that leaves the interrupt enabled between conversions, which is why the reference
 *    driver ends its bursts with a `PD=00` command.
 * 3. **The interrupt line is logged, not trusted.** A touch is the axes moving away from a baseline
 *    measured at boot. That is what stops an interrupt line that floats from walking the calibration
 *    through all four corners on its own, which is exactly what an earlier version did.
 *
 * The calibration is measured, never assumed: the screen asks for the four corners, the firmware works the
 * mapping out from what it read, and the mapped position is shown as numbers in the middle of the panel —
 * live, refreshed as the finger moves, without repainting the whole screen each time.
 */
function espTouchBody(
    display: EspDisplay,
    board: EspBoardProfile,
    touch: EspTouch,
    includeHardware: boolean,
): string {
    // The board template is this template plus whatever else the board carries: the RGB LED as a status
    // light, the light sensor in the log, and a beep on the speaker when a corner is recorded. One function
    // rather than two templates' worth of copied code, because the touch half is the long half and a second
    // copy of it is a second place for the next fix to be forgotten.
    const led = includeHardware && board.led.kind === 'rgb' ? board.led : undefined;
    const ldr = includeHardware ? board.ldr : undefined;
    const audio = includeHardware ? board.audio : undefined;

    const hardwareSetup = [
        led === undefined
            ? ''
            : `
    // The RGB LED as a status light: red while uncalibrated, green while a finger is down, blue when idle
    // and calibrated. Wiring it to the state makes it a diagnostic rather than decoration.
    let mut led_red = Output::new(peripherals.GPIO${led.red}, Level::Low, OutputConfig::default());
    let mut led_green = Output::new(peripherals.GPIO${led.green}, Level::Low, OutputConfig::default());
    let mut led_blue = Output::new(peripherals.GPIO${led.blue}, Level::Low, OutputConfig::default());`,
        ldr === undefined
            ? ''
            : `
    // The light sensor: the lower leg of a divider, so a brighter room reads lower.
    let mut adc_config = AdcConfig::new();
    let mut light = adc_config.enable_pin(peripherals.GPIO${ldr.pin}, Attenuation::_11dB);
    let mut adc = Adc::new(peripherals.ADC1, adc_config);`,
        audio === undefined
            ? ''
            : `
    // The speaker hangs off a DAC channel: what is written is the waveform.
    let mut speaker = Dac::new(peripherals.DAC2, peripherals.GPIO${audio.pin});`,
    ].join('');

    const hardwareLoop = [
        led === undefined
            ? ''
            : `
        led_red.set_level(Level::from(!calibrated));
        led_green.set_level(Level::from(calibrated && pressed));
        led_blue.set_level(Level::from(calibrated && !pressed));`,
        ldr === undefined
            ? ''
            : `
        if ticks % 50 == 0 {
            // The oneshot read is non-blocking: it reports WouldBlock while a conversion is in flight, and
            // it does so on the first read after boot. Expecting it to be ready panicked the whole firmware
            // the first time this ran (2026-10-06), which looked exactly like dead touch.
            let mut light_raw: Option<u16> = None;
            for _ in 0..50 {
                if let Ok(value) = adc.read_oneshot(&mut light) {
                    light_raw = Some(value);
                    break;
                }
                Timer::after(Duration::from_micros(200)).await;
            }
            match light_raw {
                Some(value) => log::info!(
                    "ldr: {} of 4095 (brighter light reads lower on this board)",
                    value
                ),
                None => log::warn!("ldr: the ADC never became ready"),
            }
        }`,
    ].join('');

    const beep = audio === undefined
        ? ''
        : `
                        // A short beep, so the speaker is demonstrated by the calibration itself.
                        for _ in 0..60 {
                            speaker.write(200);
                            Timer::after(Duration::from_micros(400)).await;
                            speaker.write(56);
                            Timer::after(Duration::from_micros(400)).await;
                        }
                        speaker.write(128);`;

    const hardwareLog = [
        led === undefined ? undefined : 'RGB LED',
        ldr === undefined ? undefined : `LDR on GPIO${ldr.pin}`,
        audio === undefined ? undefined : `speaker on GPIO${audio.pin}`,
    ].filter((line): line is string => line !== undefined);

    // The live readout box: middle of the panel, big enough for three lines and wide enough for the
    // longest line ("raw a=4095 b=4095").
    const boxWidth = Math.min(display.width - 20, 280);
    const boxHeight = 104;
    const boxX = Math.floor((display.width - boxWidth) / 2);
    const boxY = Math.floor(display.height / 2) - Math.floor(boxHeight / 2);

    return `${espPanelSetup(display, true)}
    // The touch controller's own clock: the panel's is restored around every burst.
    let touch_clock = || SpiConfig::default().with_frequency(Rate::from_khz(${Math.round(touch.spiHz / 1000)}));

    // The same bus, a second chip select. PENIRQ is open drain: low means pressed, and the line is only
    // logged because it is not reliable here -- GPIO34-39 have no internal pull-ups either, so what the
    // pin reads with nothing touching it says more about the board than about the glass.
    let touch_cs = Output::new(peripherals.GPIO${touch.cs}, Level::Low, OutputConfig::default());
    let mut touch = RefCellDevice::new(&bus, touch_cs, Delay::new()).expect("touch chip select");
    let touch_irq = Input::new(peripherals.GPIO${touch.irq}, InputConfig::default().with_pull(Pull::Up));

    // Control bytes from the XPT2046 datasheet: S=1 | channel | 12-bit | single-ended | power-down bits.
    // 0xD1 reads one panel axis, 0x91 the other, and 0xD0 is an axis read with PD=00: powered down
    // between conversions, which is the only setting that re-enables PENIRQ.
    const TOUCH_AXIS_A: u8 = 0xD1;
    const TOUCH_AXIS_B: u8 = 0x91;
    const TOUCH_POWER_DOWN: u8 = 0xD0;
    // How far an axis has to move from its idle baseline to count as a touch, how many samples a reading
    // averages, and how far the numbers have to move before the readout is repainted.
    const TOUCH_MOVE: i32 = 200;
    const TOUCH_SAMPLES: u32 = 3;
    // The controller's conversion time, and then some: too short and the first sample after a channel
    // change comes back as zero, which is what a 2 us delay still did on this board.
    const TOUCH_SETTLE_NS: u32 = 20_000;
    const TOUCH_REPAINT: i32 = 4;

    // Numbers have to become text for the panel, and there is no allocator here: a fixed buffer that
    // implements core::fmt::Write is the usual no_std answer. It is deliberately not named after the
    // graphics Line type, which would shadow it -- and the crosshairs are drawn with that.
    struct Numbers {
        bytes: [u8; 32],
        len: usize,
    }

    impl Numbers {
        fn new() -> Self {
            Self { bytes: [0; 32], len: 0 }
        }

        fn as_str(&self) -> &str {
            core::str::from_utf8(&self.bytes[..self.len]).unwrap_or("?")
        }
    }

    impl core::fmt::Write for Numbers {
        fn write_str(&mut self, text: &str) -> core::fmt::Result {
            if text.len() > self.bytes.len() - self.len {
                return Err(core::fmt::Error);
            }
            self.bytes[self.len..self.len + text.len()].copy_from_slice(text.as_bytes());
            self.len += text.len();
            Ok(())
        }
    }

    // One command, and the two bytes that come back with it.
    //
    // The command byte and the data bytes are separated by the controller's conversion time instead of
    // being clocked back to back. A plain two-byte transfer reads mid-scale and never
    // moves for a touch on this board; the same pins, read with gaps between the bytes, answer with real
    // values (0xF87F idle, 0x6031 under a finger). An Operation::DelayNs keeps CS asserted across the
    // gap, which is what the conversion needs.
    fn touch_frame<D: SpiDevice>(device: &mut D, command: u8) -> u16 {
        let mut frame = [0u8; 2];
        if device
            .transaction(&mut [
                Operation::Write(&[command]),
                Operation::DelayNs(TOUCH_SETTLE_NS),
                Operation::Read(&mut frame),
            ])
            .is_err()
        {
            return 0;
        }
        ((frame[0] as u16) << 8) | frame[1] as u16
    }

    // The 12 bits of the *previous* command's conversion: high byte, then the low nibble in the top half
    // of the second byte.
    fn touch_value(frame: u16) -> u16 {
        ((((frame >> 8) & 0x00FF) << 4) | ((frame & 0x00FF) >> 4)) & 0x0FFF
    }

    // One axis, averaged over a few conversions. The first read is the value that arrived with a command
    // for the *previous* channel, so it is dropped.
    fn touch_axis<D: SpiDevice>(device: &mut D, command: u8) -> (u16, [u16; TOUCH_SAMPLES as usize]) {
        // Two frames are consumed before the samples are taken: the first is whatever the previous
        // channel left behind, and the second is the same channel's previous conversion. Averaging from
        // the third on gives settled values -- without this the average is dragged towards zero.
        let _ = touch_frame(device, command);
        let _ = touch_frame(device, command);
        let mut frames = [0u16; TOUCH_SAMPLES as usize];
        for frame in frames.iter_mut() {
            *frame = touch_frame(device, command);
        }
        let total: u32 = frames.iter().map(|frame| u32::from(touch_value(*frame))).sum();
        ((total / TOUCH_SAMPLES) as u16, frames)
    }

    // Leave the controller powered down *with the interrupt enabled*, which is what makes PENIRQ usable
    // between bursts.
    fn touch_idle<D: SpiDevice>(device: &mut D) {
        let _ = touch_frame(device, TOUCH_POWER_DOWN);
    }

    log::info!(
        "touch: ${touch.controller} on GPIO${touch.cs} (cs), GPIO${touch.irq} (irq), pen level now {}",
        touch_irq.is_low()
    );
${hardwareSetup}
${hardwareLog.length > 0 ? `    log::info!("board hardware: ${hardwareLog.join(', ')}");` : ''}

    // The calibration lives in the last 4 KB sector of the application partition. The app image is roughly
    // 120 KB of a 4 MB partition, so that sector is ours -- and it is not the NVS partition the bootloader
    // may read. esp-storage wraps every flash operation in a critical section (its default feature), which
    // is what makes this safe with interrupts running.
    const CALIBRATION_OFFSET: u32 = 0x3F_F000;
    const CALIBRATION_MAGIC: u32 = 0x5443_5831;

    fn calibration_bytes(
        axis: usize,
        x_from: i32,
        x_to: i32,
        y_from: i32,
        y_to: i32,
    ) -> [u8; 24] {
        let mut bytes = [0u8; 24];
        bytes[0..4].copy_from_slice(&CALIBRATION_MAGIC.to_le_bytes());
        bytes[4] = axis as u8;
        bytes[5..9].copy_from_slice(&x_from.to_le_bytes());
        bytes[9..13].copy_from_slice(&x_to.to_le_bytes());
        bytes[13..17].copy_from_slice(&y_from.to_le_bytes());
        bytes[17..21].copy_from_slice(&y_to.to_le_bytes());
        // A plain sum, so a half-written or erased sector is not mistaken for a calibration.
        let mut sum = 0u8;
        for byte in &bytes[0..21] {
            sum = sum.wrapping_add(*byte);
        }
        bytes[21] = sum;
        bytes
    }

    // Returns the stored calibration, or nothing when the sector has never been written (an erased sector
    // reads as 0xFF, which fails both the magic and the checksum).
    fn calibration_load(flash: &mut FlashStorage<'_>) -> Option<(usize, i32, i32, i32, i32)> {
        let mut bytes = [0u8; 24];
        flash.read(CALIBRATION_OFFSET, &mut bytes).ok()?;
        if u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) != CALIBRATION_MAGIC {
            return None;
        }
        let mut sum = 0u8;
        for byte in &bytes[0..21] {
            sum = sum.wrapping_add(*byte);
        }
        if sum != bytes[21] {
            return None;
        }
        let word = |at: usize| -> i32 {
            i32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
        };
        Some((usize::from(bytes[4]), word(5), word(9), word(13), word(17)))
    }

    // esp_storage's Flash is the FLASH peripheral itself, so it is handed over rather than constructed.
    let mut flash = FlashStorage::new(peripherals.FLASH);

    // The idle baseline, taken before anything is drawn: this is what the axes read with nothing on the
    // glass, and a touch is judged by how far they move from it.
    bus.borrow_mut().apply_config(&touch_clock()).expect("touch clock");
    let (idle_a, _) = touch_axis(&mut touch, TOUCH_AXIS_A);
    let (idle_b, _) = touch_axis(&mut touch, TOUCH_AXIS_B);
    touch_idle(&mut touch);
    bus.borrow_mut().apply_config(&panel_clock()).expect("panel clock");
    let (idle_a, idle_b) = (i32::from(idle_a), i32::from(idle_b));
    log::info!("touch: idle baseline a={} b={}", idle_a, idle_b);

    // A stored calibration is used straight away; touching the glass during the first two seconds throws it
    // away and asks for the corners again, which is the only recalibration gesture this firmware offers.
    let stored = calibration_load(&mut flash);
    // Two arms rather than a format_args! inside one: the numbers are printed so they can be read back
    // without a debugger, and the temporary the one-argument form would need does not outlive the log call.
    match stored {
        Some((axis, x_from, x_to, y_from, y_to)) => log::info!(
            "calibration: loaded from flash - axis{} {}..{} {}..{}",
            axis,
            x_from,
            x_to,
            y_from,
            y_to
        ),
        None => log::info!("calibration: none stored"),
    }

    // The four corners the screen asks for, in the order it asks.
    const MARGIN: i32 = 24;
    const WIDTH: i32 = ${display.width};
    const HEIGHT: i32 = ${display.height};
    const BOX_X: i32 = ${boxX};
    const BOX_Y: i32 = ${boxY};
    const BOX_W: i32 = ${boxWidth};
    const BOX_H: i32 = ${boxHeight};
    let targets = [
        (MARGIN, MARGIN),
        (WIDTH - MARGIN, MARGIN),
        (WIDTH - MARGIN, HEIGHT - MARGIN),
        (MARGIN, HEIGHT - MARGIN),
    ];
    let corners = ["top-left", "top-right", "bottom-right", "bottom-left"];
    let mut measured = [[0u16; 2]; 4];
    let mut corner: usize = 0;
    // Initialised from the stored calibration when there is one, so a calibrated panel boots straight into
    // the graphics test screen and never shows the calibration screen again.
    let mut raw_x_axis: usize = stored.map(|(axis, _, _, _, _)| axis).unwrap_or(0);
    let mut x_from: i32 = stored.map(|(_, x_from, _, _, _)| x_from).unwrap_or(0);
    let mut x_to: i32 = stored.map(|(_, _, x_to, _, _)| x_to).unwrap_or(0);
    let mut y_from: i32 = stored.map(|(_, _, _, y_from, _)| y_from).unwrap_or(0);
    let mut y_to: i32 = stored.map(|(_, _, _, _, y_to)| y_to).unwrap_or(0);
    let mut point = (WIDTH / 2, HEIGHT / 2);
    let mut raw_a: i32 = idle_a;
    let mut raw_b: i32 = idle_b;
    let mut shown_a: i32 = idle_a - TOUCH_REPAINT - 1;
    let mut shown_b: i32 = idle_b - TOUCH_REPAINT - 1;
    let mut pressed = false;
    let mut was_touched = false;
    let mut redraw_screen = true;
    let mut redraw_box = true;
    let mut ticks: u32 = 0;
    // Whether the four corners have been measured -- by this run or by a previous one, which is what the
    // flash sector is for. Until they have, the panel shows the calibration screen.
    let mut calibrated = stored.is_some();

    loop {
        if redraw_screen {
            display.clear(Rgb565::BLACK).expect("panel write failed");
            let style = MonoTextStyle::new(&FONT_6X10, Rgb565::WHITE);

            if !calibrated {
                // The calibration screen: one red block per corner, each with a crosshair in it, and the one
                // being asked for lit up. Touching the crosshair records that corner's raw values.
                Text::new("Touch the crosshair in the bright block", Point::new(8, 10), style)
                    .draw(&mut display)
                    .expect("panel write failed");
                Text::new(corners[corner], Point::new(8, 24), style)
                    .draw(&mut display)
                    .expect("panel write failed");
                for (index, target) in targets.iter().enumerate() {
                    let (x, y) = *target;
                    let current = index == corner;
                    // 44 px blocks: big enough to aim at with a finger, small enough to leave the middle free.
                    Rectangle::new(Point::new(x - 22, y - 22), Size::new(44, 44))
                        .into_styled(PrimitiveStyle::with_fill(if current {
                            Rgb565::RED
                        } else {
                            Rgb565::new(4, 6, 4)
                        }))
                        .draw(&mut display)
                        .expect("panel write failed");
                    // The crosshair: where the user should aim, and the point the calibration is taken from.
                    let ink = if current { Rgb565::WHITE } else { Rgb565::new(14, 30, 14) };
                    Line::new(Point::new(x - 16, y), Point::new(x + 16, y))
                        .into_styled(PrimitiveStyle::with_stroke(ink, 2))
                        .draw(&mut display)
                        .expect("panel write failed");
                    Line::new(Point::new(x, y - 16), Point::new(x, y + 16))
                        .into_styled(PrimitiveStyle::with_stroke(ink, 2))
                        .draw(&mut display)
                        .expect("panel write failed");
                }
            } else {
                // The graphics test screen, back again once the calibration is done: a frame around the
                // whole panel, four coloured corner markers, five bars and a cross through the centre.
                Text::new("Touch: numbers below, and the log", Point::new(8, 10), style)
                    .draw(&mut display)
                    .expect("panel write failed");
                Rectangle::new(Point::new(1, 1), Size::new(WIDTH as u32 - 2, HEIGHT as u32 - 2))
                    .into_styled(PrimitiveStyle::with_stroke(Rgb565::WHITE, 2))
                    .draw(&mut display)
                    .expect("panel write failed");
                for (index, target) in targets.iter().enumerate() {
                    let (x, y) = *target;
                    let colour = match index {
                        0 => Rgb565::RED,
                        1 => Rgb565::GREEN,
                        2 => Rgb565::WHITE,
                        _ => Rgb565::BLUE,
                    };
                    Rectangle::new(Point::new(x - 12, y - 12), Size::new(24, 24))
                        .into_styled(PrimitiveStyle::with_fill(colour))
                        .draw(&mut display)
                        .expect("panel write failed");
                }
                for (index, colour) in [Rgb565::RED, Rgb565::GREEN, Rgb565::BLUE, Rgb565::BLACK, Rgb565::WHITE]
                    .iter()
                    .enumerate()
                {
                    Rectangle::new(
                        Point::new(16 + (index as i32) * 58, 40),
                        Size::new(53, 40),
                    )
                        .into_styled(PrimitiveStyle::with_fill(*colour))
                        .draw(&mut display)
                        .expect("panel write failed");
                }
                Line::new(Point::new(WIDTH / 2, 96), Point::new(WIDTH / 2, HEIGHT - 96))
                    .into_styled(PrimitiveStyle::with_stroke(Rgb565::new(16, 40, 16), 1))
                    .draw(&mut display)
                    .expect("panel write failed");
                Line::new(Point::new(8, HEIGHT / 2), Point::new(WIDTH - 8, HEIGHT / 2))
                    .into_styled(PrimitiveStyle::with_stroke(Rgb565::new(16, 40, 16), 1))
                    .draw(&mut display)
                    .expect("panel write failed");
            }
            redraw_screen = false;
            redraw_box = true;
        }

        // Only the readout box is repainted while a finger is down: a full clear costs about 200 ms of
        // SPI, and the numbers are supposed to keep up with the finger.
        if redraw_box {
            // The interior first, then the border on top of its edges. The numbers change length as a finger
            // moves -- "raw a=0 b=0" is shorter than "raw a=1806 b=286" -- so without clearing, each reading
            // is drawn over the tail of the one before it. Filling and then stroking is what keeps the border
            // whole: the other order erases half its width.
            Rectangle::new(Point::new(BOX_X, BOX_Y), Size::new(BOX_W as u32, BOX_H as u32))
                .into_styled(PrimitiveStyle::with_fill(Rgb565::BLACK))
                .draw(&mut display)
                .expect("panel write failed");
            Rectangle::new(Point::new(BOX_X, BOX_Y), Size::new(BOX_W as u32, BOX_H as u32))
                .into_styled(PrimitiveStyle::with_stroke(Rgb565::new(8, 24, 8), 2))
                .draw(&mut display)
                .expect("panel write failed");
            let small = MonoTextStyle::new(&FONT_6X10, Rgb565::WHITE);
            let big = MonoTextStyle::new(&FONT_10X20, Rgb565::YELLOW);

            let mut line = Numbers::new();
            if !calibrated {
                let _ = write!(&mut line, "corner {} of 4 - {}", corner + 1, corners[corner]);
            } else if pressed {
                let _ = write!(&mut line, "TOUCH");
            } else {
                let _ = write!(&mut line, "idle");
            }
            Text::new(line.as_str(), Point::new(BOX_X + 8, BOX_Y + 8), small)
                .draw(&mut display)
                .expect("panel write failed");

            let mut line = Numbers::new();
            let _ = write!(&mut line, "raw a={} b={}", raw_a, raw_b);
            Text::new(line.as_str(), Point::new(BOX_X + 8, BOX_Y + 26), small)
                .draw(&mut display)
                .expect("panel write failed");

            let mut line = Numbers::new();
            if calibrated {
                let _ = write!(&mut line, "x={} y={}", point.0, point.1);
            } else {
                let _ = write!(&mut line, "x=? y=?");
            }
            Text::new(line.as_str(), Point::new(BOX_X + 8, BOX_Y + 44), big)
                .draw(&mut display)
                .expect("panel write failed");

            let mut line = Numbers::new();
            let _ = write!(&mut line, "pen={} idle a={} b={}", touch_irq.is_low(), idle_a, idle_b);
            Text::new(line.as_str(), Point::new(BOX_X + 8, BOX_Y + 78), small)
                .draw(&mut display)
                .expect("panel write failed");

            shown_a = raw_a;
            shown_b = raw_b;
            redraw_box = false;
        }

        // Every third tick is about 60 ms; a burst is a few bytes at 2 MHz, so the panel's clock is only
        // away for microseconds.
        ticks = ticks.wrapping_add(1);
        if ticks % 3 == 0 {
            bus.borrow_mut().apply_config(&touch_clock()).expect("touch clock");
            let (a, frames_a) = touch_axis(&mut touch, TOUCH_AXIS_A);
            let (b, frames_b) = touch_axis(&mut touch, TOUCH_AXIS_B);
            touch_idle(&mut touch);
            bus.borrow_mut().apply_config(&panel_clock()).expect("panel clock");
            raw_a = i32::from(a);
            raw_b = i32::from(b);

            // A touch is the axes *moving*, never the interrupt line on its own: an interrupt that fires
            // by itself walks the calibration through all four corners while nobody touches anything.
            let irq = touch_irq.is_low();
            pressed = (raw_a - idle_a).abs() > TOUCH_MOVE || (raw_b - idle_b).abs() > TOUCH_MOVE;

            if pressed && !was_touched {
                log::info!(
                    "touch: a={} b={} pen={} frames a=[{:04X} {:04X} {:04X}] b=[{:04X} {:04X} {:04X}]",
                    raw_a,
                    raw_b,
                    irq,
                    frames_a[0],
                    frames_a[1],
                    frames_a[2],
                    frames_b[0],
                    frames_b[1],
                    frames_b[2]
                );
                if !calibrated {
                    measured[corner] = [a, b];${beep}
                    log::info!("touch: corner {} {} recorded", corner + 1, corners[corner]);
                    corner += 1;
                    if corner == 4 {
                        calibrated = true;
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
                        // Written once, and only after a whole set of corners: a half-set is not a
                        // calibration, so nothing is stored until the fourth one lands.
                        let bytes = calibration_bytes(raw_x_axis, x_from, x_to, y_from, y_to);
                        log::info!(
                            "calibration: {}",
                            match flash.write(CALIBRATION_OFFSET, &bytes) {
                                Ok(()) => "stored in flash",
                                Err(_) => "NOT stored (flash write failed)",
                            }
                        );
                    }
                    redraw_screen = true;
                }
            }

            // The mapped position follows the finger for as long as it is down, and the readout is
            // repainted when it has moved enough to be worth the pixels.
            if calibrated && (pressed || was_touched) {
                let axis_x = if raw_x_axis == 0 { a } else { b };
                let axis_y = if raw_x_axis == 0 { b } else { a };
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
                if pressed && !was_touched {
                    log::info!("touch: a={} b={} -> pixel ({}, {})", raw_a, raw_b, px, py);
                }
                if (raw_a - shown_a).abs() > TOUCH_REPAINT || (raw_b - shown_b).abs() > TOUCH_REPAINT {
                    redraw_box = true;
                }
            }
            if !pressed && was_touched && calibrated {
                log::info!("touch: released");
                redraw_box = true;
            }
            was_touched = pressed;
        }

        if ticks % 100 == 0 {
            // A heartbeat with the numbers that matter, so "the log is quiet" cannot be mistaken for
            // "the app is not running".
            log::info!("touch test alive: a={} b={} idle a={} b={} pen={}", raw_a, raw_b, idle_a, idle_b, touch_irq.is_low());
        }
${hardwareLoop}
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
    const usesPanel = template === 'display' || template === 'touch' || template === 'board';
    const display = usesPanel ? displayFor(board, choices) : undefined;
    const touch = template === 'touch' || template === 'board' ? board.touch : undefined;
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
