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
import { EspBoardProfile, EspDisplay } from '../boards/types';

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
            label: 'Panel test image',
            description: 'Initialises the soldered panel and cycles colour bars over it.',
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
    const display = template === 'display' ? displayFor(board, choices) : undefined;
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
    if (template === 'display') {
        return [
            'use embassy_executor::Spawner;',
            'use embassy_time::{Duration, Timer};',
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
            'use mipidsi::options::ColorOrder;',
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
    const display = template === 'display' ? displayFor(board, choices) : undefined;
    const led = board.led;

    const body = display
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
 * Panel bring-up, then colour bars.
 *
 * The colour bars are the point: they make a wrong colour order or a dead backlight
 * obvious in one glance, which is exactly the failure a fresh board produces.
 */
function espDisplayBody(display: EspDisplay, board: EspBoardProfile): string {
    const miso =
        display.spi.miso === undefined ? '' : `\n        .with_miso(peripherals.GPIO${display.spi.miso})`;
    const reset =
        display.rst === undefined ? '' : `\n        .reset_pin(rst)`;
    const resetSetup =
        display.rst === undefined
            ? ''
            : `\n    let rst = Output::new(peripherals.GPIO${display.rst}, Level::High, OutputConfig::default());\n`;

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
        .display_size(${display.width}, ${display.height})${reset}
        .color_order(ColorOrder::${display.colorOrder === 'bgr' ? 'Bgr' : 'Rgb'})
        .init(&mut delay)
        .expect("panel initialisation");

    log::info!("panel ready: ${rustString(display.label)}");

    // A diagnostic screen rather than flat colour fills. Flat fills hide the three things that go wrong on a
    // new panel: a cropped or shifted active area, a swapped colour order, and a rotated image. Here the frame
    // shows cropping (a missing side means the panel is offset), the corners and named bars show a swap at a
    // glance, and the text says what should be on screen. Replace this with your own drawing once it is right.
    display.clear(Rgb565::BLACK).expect("panel write failed");

    // A full-size frame, two pixels wide: every side visible means the whole area is addressable.
    Rectangle::new(Point::new(1, 1), Size::new(${display.width} - 2, ${display.height} - 2))
        .into_styled(PrimitiveStyle::with_stroke(Rgb565::WHITE, 2))
        .draw(&mut display)
        .expect("panel write failed");

    // Corner markers, so a shift is measurable: red top-left, green top-right, blue bottom-left, white
    // bottom-right. A red square that is not in the corner, or one cut in half, is the answer.
    for (x, y, colour) in [
        (0, 0, Rgb565::RED),
        (${display.width} - 24, 0, Rgb565::GREEN),
        (0, ${display.height} - 24, Rgb565::BLUE),
        (${display.width} - 24, ${display.height} - 24, Rgb565::WHITE),
    ] {
        Rectangle::new(Point::new(x, y), Size::new(24, 24))
            .into_styled(PrimitiveStyle::with_fill(colour))
            .draw(&mut display)
            .expect("panel write failed");
    }

    // Five bars, left to right: red, green, blue, black, white. If red and blue trade places, the panel's
    // colour order is the other one — flip ColorOrder in the builder above and reflash.
    for (index, colour) in [Rgb565::RED, Rgb565::GREEN, Rgb565::BLUE, Rgb565::BLACK, Rgb565::WHITE]
        .iter()
        .enumerate()
    {
        Rectangle::new(Point::new(16 + (index as i32) * 58, 40), Size::new(56, 60))
            .into_styled(PrimitiveStyle::with_fill(*colour))
            .draw(&mut display)
            .expect("panel write failed");
    }

    // A centre cross: if it is not centred, the panel's active area does not start where the driver thinks.
    Line::new(Point::new(${display.width} / 2, 0), Point::new(${display.width} / 2, ${display.height}))
        .into_styled(PrimitiveStyle::with_stroke(Rgb565::YELLOW, 1))
        .draw(&mut display)
        .expect("panel write failed");
    Line::new(Point::new(0, ${display.height} / 2), Point::new(${display.width}, ${display.height} / 2))
        .into_styled(PrimitiveStyle::with_stroke(Rgb565::YELLOW, 1))
        .draw(&mut display)
        .expect("panel write failed");

    Text::new("Hello Grumpy!", Point::new(20, 130), MonoTextStyle::new(&FONT_10X20, Rgb565::YELLOW))
        .draw(&mut display)
        .expect("panel write failed");

    let small = MonoTextStyle::new(&FONT_6X10, Rgb565::WHITE);
    let mut line = 158;
    for text in [
        "${rustString(board.name)}",
        "${board.espChip} · ${display.width}x${display.height} · ${display.controller}",
        "frame complete? corners: red TL, green TR",
        "blue BL, white BR",
        "bars L to R: red green blue black white",
        "text upright? colours right? square blinking?",
    ] {
        Text::new(text, Point::new(6, line), small)
            .draw(&mut display)
            .expect("panel write failed");
        line += 14;
    }

    log::info!("diagnostics drawn: frame, corners, 5 bars, cross and text");
    let mut tick: u32 = 0;
    loop {
        // One small square, blinking: proof the loop is alive without covering any of the diagnostics.
        let colour = if tick % 2 == 0 { Rgb565::WHITE } else { Rgb565::BLACK };
        Rectangle::new(Point::new(8, 420), Size::new(24, 24))
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
    // Only the pins the generated firmware actually drives are listed: claiming the touch
    // controller or the SD socket here would be a lie until their templates exist. They are
    // named in the notes below instead.
    const display = template === 'display' ? displayFor(board, choices) : undefined;
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

Or use the extension: **Build**, **Flash** and **Monitor**. Flash writes the *debug*
build, so a debug session and the chip always agree.

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
