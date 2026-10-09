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
import { LCD_ROTATION_LABELS, LcdRotation, asLcdRotation, templateUsesPanel } from '../display/rotation';
import {
    DESIGNER_FILES,
    emitHandlersRs,
    emitProjectKdl,
    emitStarterKdl,
    emitUiRs,
    starterDocument,
} from '../designer/generate';

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
    /** SD cards over SPI, with a FAT filesystem on top. */
    embeddedSdmmc: '0.8.2',
    embeddedGraphics: '0.8',
    /** The Bluetooth host stack on top of esp-radio's HCI controller (advertising + GATT). */
    troubleHost: '0.7.0',
    staticCell: '2.1.1',
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
    /**
     * How the panel should be rotated. Baked into `.cargo/esp-config.toml` as an environment variable
     * rather than into `src/main.rs`, so it stays changeable after the project has been generated.
     */
    rotation?: number;
    /**
     * Whether the project should drive its touch controller, for the templates that can be either.
     *
     * Also an environment variable rather than a line in `src/main.rs`, and for the same reason: the choice has
     * to survive that file being written once. Omitted means yes, which is what a project generated before the
     * setting existed had.
     */
    touch?: boolean;
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
            id: 'designer',
            label: 'WYSIWYG designer',
            description:
                'A project whose screen is a design rather than Rust: the extension opens the designer for this '
                + 'board, the design is written to src/ui.kdl, and the widgets\' events land in src/ui_handlers.rs '
                + 'for you to fill in.',
        });
        templates.push({
            id: 'display',
            label: 'Panel diagnostic screen',
            description:
                'Initialises the soldered panel and draws a screen to read: frame, corner markers, colour bars, '
                + 'a centred cross, a greeting and a blinking square — timed, and logging how long the paint took.',
        });
    }
    if (board.sd !== undefined) {
        templates.push({
            id: 'sdcard',
            label: 'TF card',
            description:
                'Mounts the card in the TF socket through embedded-sdmmc at the SPI clock the card can be '
                + 'trusted with, then reports its capacity and opens the root directory of volume 0.',
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
    // Wireless last: it is what people reach for after the panel works, and it is the only pair of templates
    // that depends on the chip's silicon rather than on wiring a board carries.
    if (board.radio.wifi) {
        templates.push({
            id: 'wifi',
            label: 'Wi-Fi station',
            description:
                'Joins your access point as a station and logs the address the network stack gives it (or '
                + 'the fixed one from WIFI_STATIC_IP), then reports a heartbeat. Set WIFI_SSID and '
                + 'WIFI_PASSWORD in the environment when you build; without them the firmware substitutes '
                + 'placeholders and says so in the log.',
        });
    }
    if (board.radio.bluetooth === 'ble') {
        templates.push({
            id: 'bluetooth',
            label: 'Bluetooth LE peripheral',
            description:
                'Starts the chip\'s Bluetooth controller and advertises as a named peripheral, logging when a '
                + 'central connects and disconnects. Nothing to pair with yet -- it exists to prove the radio '
                + 'and the firmware stack come up on this board.',
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
    // Anything unexpected (a hand-edited setting, a caller that does not care) is no rotation.
    const rotation: LcdRotation = asLcdRotation(options.rotation);
    const usesPanel = templateUsesPanel(template);
    // The panel this project was generated for: the board's own, or the revision its options chose.
    const panel = displayFor(board, choices);

    if (!isTemplateValidForEsp(board, template)) {
        throw new Error(
            `Template "${template}" is not available for ${board.name} (${board.id}). ` +
            `Valid templates: ${templatesForEsp(board)
                .map((info) => info.id)
                .join(', ')}.`,
        );
    }

    // A designer project on a board with a touch controller carries the setting; a board without one has no
    // touch code to switch, and the firmware reads an absent key as "on".
    const touchSetting =
        template === 'designer' && board.touch !== undefined ? (options.touch ?? true) : undefined;

    const files: GeneratedFile[] = [
        { path: 'Cargo.toml', content: espCargoToml(board, crateName, template, choices) },
        { path: '.cargo/config.toml', content: espCargoConfigToml(board, template) },
        { path: '.cargo/esp-config.toml', content: espConfigToml(rotation, usesPanel, touchSetting) },
        { path: 'rust-toolchain.toml', content: espRustToolchainToml() },
        { path: 'build.rs', content: espBuildRs() },
        { path: 'src/main.rs', content: espMainRs(board, template, choices) },
        { path: '.vscode/settings.json', content: espVscodeSettings(board, rotation, usesPanel) },
        { path: '.gitignore', content: '/target\n/dist\n' },
        { path: 'README.md', content: espReadme(board, crateName, template, choices, rotation) },
    ];

    if (template === 'designer' && panel !== undefined) {
        // The three files a Designer project is born with, plus the design document they describe. The markup
        // and the Rust are regenerated whenever the designer saves; the handlers file is only ever appended
        // to, so the code behind an event survives every later save (see designer/generate.ts).
        const starter = starterDocument({
            boardId: board.id,
            panelWidth: panel.width,
            panelHeight: panel.height,
            rotation,
        });
        files.push(
            { path: DESIGNER_FILES.markup, content: emitStarterKdl(starter) },
            { path: DESIGNER_FILES.rust, content: emitUiRs(starter, board.touch !== undefined) },
            { path: DESIGNER_FILES.handlers, content: emitHandlersRs(starter, board.touch !== undefined) },
            { path: DESIGNER_FILES.document, content: `${JSON.stringify(starter, null, 2)}\n` },
            // The manifest that anchors asset paths to the project root -- without it the crate resolves
            // them from src/, which is where the screen file lives.
            { path: DESIGNER_FILES.manifest, content: emitProjectKdl(starter) },
        );
    }
    return files;
}

// ---------------------------------------------------------------------- Cargo

function espCargoToml(
    board: EspBoardProfile,
    crateName: string,
    template: AppTemplate,
    choices: BoardChoices,
): string {
    // The touch template drives the same panel, so everything the panel needs is needed there too.
    const display = templateUsesPanel(template) ? displayFor(board, choices) : undefined;
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

    // The radio templates: Wi-Fi on `wifi`, the Bluetooth LE controller on `bluetooth`.
    const radio = template === 'wifi' || template === 'bluetooth';

    // The ADC and DAC live behind esp-hal's `unstable` feature (confirmed in its source: the analog modules
    // are cfg-gated), so a project that reads the LDR or drives the speaker has to ask for it. The radio API
    // is in the same position -- esp-radio marks it unstable, and esp-radio's own documentation states that
    // turning its `unstable` feature on obliges the final binary to turn esp-hal's on too.
    const espHalFeatures = [`"${board.espChip}"`, '"log-04"'];
    if (template === 'peripherals' || template === 'board' || radio) {
        espHalFeatures.push('"unstable"');
    }

    if (radio) {
        // The radio's own glue for the scheduler is a separate esp-rtos feature. Read out of esp-rtos
        // 0.4.0's manifest: `esp-radio = ["dep:esp-radio-rtos-driver"]`. Without it the driver has no
        // scheduler to run on and the first call into the radio stalls instead of failing.
        espRtosFeatures.push('esp-radio');
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
    if (template === 'sdcard') {
        // The board template already declares this for its panel; declaring it twice is a duplicate key.
        dependencies.push(`embedded-hal-bus = "${ESP_CRATE_VERSIONS.embeddedHalBus}"`);
    }
    if (template === 'sdcard' || template === 'board') {
        // The correct way to talk to a card: the ecosystem's own SD/SPI plus FAT implementation rather than
        // a hand-rolled CMD0/CMD8/ACMD41 sequence. It is the maintained crate that filesystems are tested
        // against, and getting the SD init handshake subtly wrong is a classic way to lose a day.
        dependencies.push(`embedded-sdmmc = "${ESP_CRATE_VERSIONS.embeddedSdmmc}"`);
    }
    if (template === 'touch' || template === 'board' || (template === 'designer' && board.touch !== undefined)) {
        // The calibration is kept in flash, so the project needs the NOR-flash crate. Its chip feature is
        // what selects the flash driver, and it pulls the ROM glue that is already in the tree.
        dependencies.push(`esp-storage = { version = "${ESP_CRATE_VERSIONS.espStorage}", features = ["${board.espChip}"] }`);
    }
    if (template === 'designer') {
        // The widget toolkit the design is compiled into. Three things about this line were found by building
        // a generated project rather than by reading documentation (2026-10-08):
        //  - `default-features = false` is required, because the default set includes `std`;
        //  - `micromath` is then required too, or the crate refuses to build for want of a maths backend;
        //  - `macros` is what compiles the markup in `src/ui.kdl` at build time.
        dependencies.push(
            `embedded-gui = { version = "0.2.7", default-features = false, features = ["rich-widgets", "embedded-graphics", "macros", "micromath"] }`,
        );
        // A shapes widget crate renders Circle/Line/Vector-Path on the board; the codegen that emits its
        // `add_custom_widget` calls lives in the fork next to it, so both are referenced by path and the
        // codegen patch redirects the one crates.io pulls in. Both are copied into `codegen/` by the project
        // wizard when it creates a Designer project.
        dependencies.push(`rusty-gui-widgets = { path = "codegen/rusty-gui-widgets", default-features = false }`);
    }
    if (template === 'touch' || template === 'board' || (template === 'designer' && board.touch !== undefined)) {
        // The touch template reads the controller through a function generic over `SpiDevice`, so the
        // trait has to be nameable: `embedded-hal-bus` brings the trait's *implementations* but not the
        // crate name itself. Same 1.0 line mipidsi and embedded-hal-bus already resolve to.
        dependencies.push(`embedded-hal = "${ESP_CRATE_VERSIONS.embeddedHal}"`);
    }
    if (radio) {
        // esp-radio pulls in the vendor binary blobs and, for a real connection, a host stack. It needs a
        // heap at runtime, so esp-alloc comes with it; esp-radio reaches its own allocations through that
        // crate by default, which is why the dependency is left on its default features.
        const radioFeatures = [
            `"${board.espChip}"`,
            template === 'wifi' ? '"wifi"' : '"ble"',
            '"log-04"',
            '"unstable"',
        ];
        dependencies.push(
            `esp-radio = { version = "${ESP_CRATE_VERSIONS.espRadio}", features = [${radioFeatures.join(', ')}] }`,
            `esp-alloc = { version = "${ESP_CRATE_VERSIONS.espAlloc}", features = ["${board.espChip}"] }`,
        );
        if (template === 'wifi') {
            // The addressing lives here, not in the radio driver: DHCP, a fixed address, and the stack that
            // makes the interface usable at all.
            dependencies.push(
                `embassy-net = { version = "${ESP_CRATE_VERSIONS.embassyNet}", features = ["dhcpv4", "medium-ethernet", "tcp", "dns"] }`,
                `static_cell = "${ESP_CRATE_VERSIONS.staticCell}"`,
            );
        }
        if (template === 'bluetooth') {
            // A Bluetooth controller is only an HCI transport: advertising, connections and the GATT
            // server live in a *host* stack on top of it. This is the host esp-radio's own BLE example
            // uses, so the generated project follows the vendor's shape rather than a hand-rolled one.
            dependencies.push(
                `trouble-host = { version = "${ESP_CRATE_VERSIONS.troubleHost}", features = ["default-packet-pool-mtu-255", "derive"] }`,
                'embassy-sync = "0.8"',
                'embassy-futures = "0.1"',
                `static_cell = "${ESP_CRATE_VERSIONS.staticCell}"`,
            );
        }
    }

    // The vendored crates are copied into `codegen/` by the project wizard, and *only* for the Designer
    // template -- so the patch pointing at them is written only there. A `[patch.crates-io]` entry is resolved
    // even when nothing depends on the patched crate, so a dangling one stops every other template dead:
    // `failed to load source for dependency embedded-gui-codegen ... No such file or directory`.
    const vendored =
        template === 'designer'
            ? `
# Vendored alongside every Designer project (see crates/ in this extension): the shapes widget crate, and
# the codegen fork that emits add_custom_widget calls for shapes instead of add_panel/add_spacer stubs.
[patch.crates-io]
embedded-gui-codegen = { path = "codegen/embedded-gui-codegen" }
`
            : '';

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
${vendored}
[profile.release]
opt-level = "s"
lto = true
debug = true
`;
}

function espCargoConfigToml(board: EspBoardProfile, template: AppTemplate): string {
    // Both radio templates allocate: the Wi-Fi and Bluetooth stacks are not static-buffer-only, so the
    // generated manifest rebuilds core *and* alloc from source (the espup toolchain ships rust-src for this).
    const needsAlloc = template === 'wifi' || template === 'bluetooth';
    // Bluetooth on the classic ESP32 cannot link against the published crates as they stand, and the
    // three symbols below are the whole of the problem. crates.io's esp-rom-sys 0.1.5 -- which esp-radio
    // 1.0.0-beta.1 pins with `=0.1.5` -- is missing three ROM `PROVIDE` lines that the upstream repository
    // has at the same tag, and esp-wifi-sys-esp32 0.3.0's libbtdm_app.a (the BLE controller blob) refers to
    // all three. The result is a link error, not a warning:
    //     undefined reference to `ld_iscan_evt_start_cbk'
    // It was found by building a generated project for a real board, which is the only way it shows up.
    // The addresses are the stable ESP32 ROM addresses from esp-rom-sys's own esp32.rom.ld at that tag.
    // They are defined only for the classic ESP32: the S3 has a different blob and different addresses, and
    // defining ESP32 addresses there would be meaningless. Remove these three lines once esp-rom-sys ships
    // the PROVIDEs; `--defsym` on an already-provided symbol is harmless, so leaving them is safe.
    const bleRomSymbols = template === 'bluetooth' && board.espChip === 'esp32'
        ? `
  # Workaround for esp-rom-sys 0.1.5 (the version esp-radio pins): see the comment in this file's source.
  "-C", "link-arg=-Wl,--defsym=ld_iscan_evt_start_cbk=0x4003b58c",
  "-C", "link-arg=-Wl,--defsym=ld_page_evt_start_cbk=0x4003cf40",
  "-C", "link-arg=-Wl,--defsym=ld_pscan_evt_start_cbk=0x4003e924",`
        : '';
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
  "-C", "link-arg=-nostartfiles",${bleRomSymbols}
]

[unstable]
# The Xtensa targets are not in a released rustc, so core is rebuilt from source --
# which is why the espup toolchain ships rust-src.
build-std = [${needsAlloc ? '"alloc", ' : ''}"core"]
`;
}

function espConfigToml(rotation: LcdRotation, usesPanel: boolean, touch?: boolean): string {
    // An environment table is what makes the rotation reachable at compile time: cargo applies `[env]` to
    // the rustc invocations, so `option_env!` in main.rs sees it without the extension having to inject
    // anything at build time -- which is also why `cargo run` in a plain terminal honours it.
    const rotationEntry = usesPanel
        ? `
# Panel rotation, read at compile time by src/main.rs. 0 = none, 1 = 90, 2 = 180, 3 = 270 degrees
# clockwise. The rustyPlatform.lcdRotation setting writes this line; editing it here works just as well
# (the compiler reads this file), and neither ever touches src/main.rs.
LCD_ROTATION = "${rotation}"
`
        : '';
    // Whether the firmware drives the touch controller. Written for every Designer project rather than left
    // to a default, because it is a choice the wizard asks about; the firmware's default only exists for
    // projects generated before the setting did, which had a working touchscreen and must keep it.
    const touchEntry =
        touch === undefined
            ? ''
            : `
# Whether the firmware drives the touch controller, read at compile time by src/main.rs. Only "0" turns it
# off. The designer's toolbar writes this line; flip it and rebuild for the change to take effect.
TOUCH_ENABLED = "${touch ? '1' : '0'}"
`;
    return `# Runtime configuration for the ESP logging stack.
[env]
# log level for esp-println, read by esp_println::logger::init_logger_from_env() in main;
# change to "debug" or "trace" when something is silent.
ESP_LOG = "info"
${rotationEntry}${touchEntry}`;
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
function espBootBlock(board: EspBoardProfile, template: AppTemplate): string {
    // The radio stacks allocate at runtime, and esp-radio's own quick start installs the heap between
    // `esp_hal::init` and the scheduler start. The order is not cosmetic: the first block is memory the
    // bootloader has finished with (`reclaimed`), so it can only be taken once the HAL has initialised,
    // and the radio cannot be created until both are in place.
    // The sizes are the ones esp-radio's own examples use, per stack rather than one number for both:
    // Wi-Fi takes two blocks (the first is memory the second-stage bootloader is finished with, the second
    // is reserved from SRAM), Bluetooth takes one. On the classic ESP32 the heap lands in .bss, so it is
    // counted against the 128 KiB the DRAM linker segment allows -- the two figures are not interchangeable.
    const heap = template === 'wifi'
        ? `
    // Wi-Fi is not static-buffer-only, so it needs a heap. The first block is memory the second-stage
    // bootloader used and is done with by now; the second is reserved from SRAM.
    esp_alloc::heap_allocator!(#[ram(reclaimed)] size: 64 * 1024);
    esp_alloc::heap_allocator!(size: 36 * 1024);
`
        : template === 'bluetooth'
        ? `
    // The Bluetooth controller and the host stack both allocate. 72 KiB is what esp-radio's own BLE
    // example asks for; raising it is a tuning decision, and it comes out of the same DRAM as the stack.
    esp_alloc::heap_allocator!(size: 72 * 1024);
`
        : '';
    return `    let config = esp_hal::Config::default().with_cpu_clock(CpuClock::max());
    let peripherals = esp_hal::init(config);
${heap}
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
    if (template === 'wifi') {
        return [
            'use core::net::Ipv4Addr;',
            'use core::str::FromStr;',
            'use embassy_executor::Spawner;',
            // embassy-net does the addressing on top of the radio driver: the radio moves frames, the stack
            // owns DHCP, a fixed address, and everything above it.
            'use embassy_net::{Config as NetConfig, Ipv4Cidr, Runner, StackResources, StaticConfigV4};',
            'use embassy_time::{Duration, Timer};',
            'use esp_hal::clock::CpuClock;',
            // The heap's reclaimed region is declared with this attribute macro, and an attribute macro has
            // to be in scope to be named: #[ram(reclaimed)] alone is an unresolved attribute.
            'use esp_hal::ram;',
            'use esp_hal::rng::Rng;',
            'use esp_hal::timer::timg::TimerGroup;',
            'use esp_println as _;',
            // The station's configuration is which network and how it is authenticated; the address is the
            // stack's business, not the radio's.
            'use esp_radio::wifi::sta::StationConfig;',
            'use esp_radio::wifi::{AuthenticationMethodConfig, Config as WifiConfig, ControllerConfig, Interface, WifiController};',
        ].join('\n');
    }
    if (template === 'bluetooth') {
        return [
            'use embassy_executor::Spawner;',
            // The advertising loop races the host-stack runner, which is what these two express.
            'use embassy_futures::{join::join, select::select};',
            'use embassy_time::{Duration, Timer};',
            'use esp_hal::clock::CpuClock;',
            'use esp_hal::timer::timg::TimerGroup;',
            'use esp_println as _;',
            // The controller is only an HCI transport; the host stack above it owns advertising and GATT.
            'use esp_radio::ble::controller::BleConnector;',
            'use log::{info, warn};',
            'use trouble_host::prelude::*;',
        ].join('\n');
    }
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
    if (template === 'sdcard') {
        return [
            'use embassy_executor::Spawner;',
            'use embassy_time::{Duration, Timer};',
            'use embedded_hal_bus::spi::ExclusiveDevice;',
            'use embedded_sdmmc::{SdCard, TimeSource, Timestamp, VolumeIdx, VolumeManager};',
            'use esp_hal::clock::CpuClock;',
            'use esp_hal::delay::Delay;',
            'use esp_hal::gpio::{Level, Output, OutputConfig};',
            'use esp_hal::spi::master::{Config as SpiConfig, Spi};',
            'use esp_hal::time::Rate;',
            'use esp_hal::timer::timg::TimerGroup;',
            'use esp_println as _;',
        ].join('\n');
    }
    if (template === 'touch' || template === 'board' || (template === 'designer' && board.touch !== undefined)) {
        // Only the board template drives the LDR and the speaker, and an unused import is a warning, so the
        // analog imports are added where the hardware actually is.
        const hardwareImports = template === 'board'
            ? [
                'use esp_hal::analog::adc::{Adc, AdcConfig, Attenuation};',
                'use esp_hal::analog::dac::Dac;',
                // The board template mounts the card as well, so it needs the crate, the raw API, and the
                // bus-to-device adapter (its panel uses the RefCell one, not this).
                'use embedded_hal_bus::spi::ExclusiveDevice;',
                'use embedded_sdmmc::{SdCard, TimeSource, Timestamp, VolumeIdx, VolumeManager};',
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
            'use mipidsi::options::{ColorOrder, Orientation, Rotation};',
            'use mipidsi::{models, Builder};',
            'use mipidsi::interface::SpiInterface as SPIInterface;',
        ].join('\n');
    }
    if (template === 'designer' && board.touch === undefined) {
        // The panel bring-up imports without the diagnostic screen's drawing primitives and fonts. This
        // template paints a design through the GUI, so keeping them produced eight unused-import warnings in
        // every Designer project on a board with no touch controller (the T-QT).
        return [
            'use embassy_executor::Spawner;',
            'use embassy_time::{Duration, Timer};',
            'use embedded_graphics::pixelcolor::Rgb565;',
            // A glob, so it costs nothing when unused: `display.clear` comes from this prelude.
            'use embedded_graphics::prelude::*;',
            'use embedded_hal_bus::spi::ExclusiveDevice;',
            'use esp_hal::clock::CpuClock;',
            'use esp_hal::delay::Delay;',
            'use esp_hal::gpio::{Level, Output, OutputConfig};',
            'use esp_hal::spi::master::{Config as SpiConfig, Spi};',
            'use esp_hal::time::Rate;',
            'use esp_hal::timer::timg::TimerGroup;',
            'use esp_println as _;',
            'use mipidsi::options::{ColorOrder, Orientation, Rotation};',
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
            'use mipidsi::options::{ColorOrder, Orientation, Rotation};',
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
    // Asked rather than re-listed. This was a second copy of the rule, and the designer was added to the
    // shared helper without reaching here -- which generated a Designer project whose body was the RGB LED
    // heartbeat. Found by generating one, 2026-10-08.
    const usesPanel = templateUsesPanel(template);
    const display = usesPanel ? displayFor(board, choices) : undefined;
    // A Designer project drives touch where the board has a controller and is a static screen where it does
    // not: the T-QT has a panel and no touch controller.
    const touch =
        template === 'touch' || template === 'board' || template === 'designer' ? board.touch : undefined;
    const led = board.led;

    const body = template === 'wifi'
        ? espWifiBody()
        : template === 'bluetooth'
        ? espBluetoothBody()
        : template === 'sdcard'
        ? espSdcardBody(board)
        : template === 'peripherals'
        ? espPeripheralsBody(board)
        : template === 'designer' && display !== undefined && touch !== undefined
        ? espTouchBody(display, board, touch, false, true)
        : template === 'designer' && display !== undefined
        ? espDesignerDisplayBody(display)
        : display !== undefined && touch !== undefined
        ? espTouchBody(display, board, touch, template === 'board')
        : display !== undefined
            ? espDisplayBody(display)
            : led.kind === 'gpio'
                ? espLedBody(led.pin, led.external === true)
                : led.kind === 'rgb'
                    ? espRgbLedBody(led.red, led.green, led.blue)
                    : espHeartbeatBody();

    return `${espMainHeader(board, template)}
#![no_std]
#![no_main]

${espImports(board, template)}
use esp_backtrace as _;${template === 'designer' ? "\n\n// The design's own module, and the code-behind it calls.\nmod ui;\nmod ui_handlers;\n" + (board.touch === undefined ? '' : "\n/// This project draws the design, so the diagnostic screen the touch template can paint is folded\n/// away at compile time. Kept rather than deleted: it is what to fall back on when a panel comes up wrong.\nconst DESIGNER: bool = true;\n\n/// Whether touch is wanted, read at compile time so the driver, the calibration and the sampling fold\n/// away when it is off: no SPI traffic to a controller nobody asked for. Only \"0\" is off, so a project\n/// generated before the setting existed keeps the touchscreen it had.\nconst TOUCH: bool = match option_env!(\"TOUCH_ENABLED\") {\n    Some(value) => !(value.len() == 1 && value.as_bytes()[0] == b'0'),\n    None => true,\n};\n") : ''}

// The ESP-IDF bootloader expects an application descriptor in the image. Without it the
// bootloader refuses to start the image, so this line is not decoration.
esp_bootloader_esp_idf::esp_app_desc!();

#[esp_rtos::main]
async fn main(${template === 'wifi' ? 'spawner' : '_spawner'}: Spawner) -> ! {
${espBootBlock(board, template)}
${body}
}
${template === 'bluetooth' ? espBluetoothSupport() : template === 'wifi' ? espWifiSupport() : template === 'display' && display !== undefined ? espPanelSupport(display, board) : ''}`;
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
        .orientation(Orientation::new()${flips}.rotate(rotation))`;
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
 * The TF card: mount it, then read it.
 *
 * Deliberately built on `embedded-sdmmc` rather than a hand-rolled SD SPI sequence. The handshake (CMD0, CMD8,
 * ACMD41, CMD58, CMD16) is easy to get subtly wrong, and even done perfectly it leaves the user with raw
 * sectors rather than a filesystem. The crate is the one the rest of the ecosystem tests against, and it brings
 * FAT12/16/32 with it.
 *
 * Two deliberate choices worth naming:
 *
 * 1. **The bus runs at 400 kHz.** A card must initialise below 400 kHz, and this stays there rather than
 *    switching up for the data phase. embedded-sdmmc 0.8 has a clock-controller hook for exactly that
 *    (new_with_options), and adding it is the next improvement -- but a correct slow read beats a fast one
 *    that corrupts a sector, and there is no correctness reason to rush a mount.
 * 2. **The clock is fixed.** The filesystem records timestamps when it writes; this template only reads, so a
 *    fixed one is honest rather than a fake time. It is also what the crate's own example does.
 */
/**
 * Mounting the card, as one block expression that leaves `sd_mounted` behind.
 *
 * Shared by the card template and the board template rather than copied between them: a mount sequence is
 * exactly the kind of thing that drifts when there are two of it. The crate's raw API is used deliberately --
 * `iterate_dir` wants a `RawDirectory`, and this way the same handle is used for the open, the listing and the
 * close instead of converting between the ergonomic wrapper and the raw form.
 */
function espSdMountCode(board: EspBoardProfile, peripheral = 'SPI2', binding = 'sd_mounted'): string {
    const sd = board.sd;
    if (sd === undefined) {
        return '    let sd_mounted = false;';
    }
    return `    // A fixed timestamp: the filesystem records one when it *writes*, and these templates only read, so a
    // fixed value is honest rather than a pretended clock. It is also what the crate's own example does.
    struct FixedClock;

    impl TimeSource for FixedClock {
        fn get_timestamp(&self) -> Timestamp {
            // The crate counts years from 1970 and indexes months and days from zero: 56 is 2026.
            Timestamp {
                year_since_1970: 56,
                zero_indexed_month: 0,
                zero_indexed_day: 0,
                hours: 0,
                minutes: 0,
                seconds: 0,
            }
        }
    }

    let ${binding} = {
        // The card's own SPI bus. These are the TF socket's pins, not the panel's.
        let card_spi = Spi::new(
            peripherals.${peripheral},
            // 400 kHz: the clock a card is specified to initialise at, and what it is read at here.
            SpiConfig::default().with_frequency(Rate::from_khz(400)),
        )
        .expect("SPI configuration")
            .with_sck(peripherals.GPIO${sd.spi.sclk})
            .with_mosi(peripherals.GPIO${sd.spi.mosi})
            .with_miso(peripherals.GPIO${sd.spi.miso});

        let card_cs = Output::new(peripherals.GPIO${sd.cs}, Level::Low, OutputConfig::default());
        let card = ExclusiveDevice::new(card_spi, card_cs, Delay::new()).expect("card chip select");

        log::info!(
            "sd: mounting (cs GPIO${sd.cs}, sclk GPIO${sd.spi.sclk}, mosi GPIO${sd.spi.mosi}, miso GPIO${sd.spi.miso})"
        );

        let card = SdCard::new(card, Delay::new());
        match card.num_bytes() {
            Ok(bytes) => log::info!("sd: card reports {} bytes ({} MiB)", bytes, bytes / (1024 * 1024)),
            Err(error) => log::error!("sd: the card did not answer ({:?})", error),
        }

        let mut volumes = VolumeManager::new(card, FixedClock);
        let mut mounted = false;

        match volumes.open_raw_volume(VolumeIdx(0)) {
            Ok(volume) => {
                log::info!("sd: volume 0 opened");
                match volumes.open_root_dir(volume) {
                    Ok(directory) => {
                        // Walking the directory walks the FAT, so this fails on a damaged filesystem rather
                        // than quietly reporting a size.
                        log::info!("sd: root directory opened - the filesystem is readable");
                        // The callback returns unit in this version of the crate, not a Result: it is
                        // called for its side effect and the iterator's own error is what comes back.
                        match volumes.iterate_dir(directory, |entry| {
                            log::info!("sd:   {} ({} bytes)", entry.name, entry.size);
                        }) {
                            Ok(()) => log::info!("sd: root directory listed"),
                            Err(error) => log::error!("sd: listing failed ({:?})", error),
                        }
                        let _ = volumes.close_dir(directory);
                        mounted = true;
                    }
                    Err(error) => log::error!("sd: no root directory ({:?})", error),
                }
            }
            Err(error) => log::error!(
                "sd: no volume 0 - is the card inserted and FAT formatted? ({:?})",
                error
            ),
        }

        mounted
    };`;
}

/**
 * The TF card template on its own: mount it, list it, and say whether it worked.
 */
/**
 * The Wi-Fi station body.
 *
 * esp-radio's own quick start, plus the two things a first-time user needs: the credentials come from the
 * environment (the same four keys the Pico template reads, so the extension's prompt serves both), and a
 * failed association is retried with a factual message instead of leaving the board silent.
 *
 * What this driver does *not* offer is an address: esp-radio 1.0.0-beta.1 has no DHCP, netif or IPv4 API
 * anywhere in its Wi-Fi module, so the firmware cannot log the address it was given. The log says so in as
 * many words rather than printing a plausible-looking number, because the association is real either way --
 * the router's own client list is where the address can be seen (checked by reading the crate's source).
 */
function espWifiBody(): string {
    return `

    // Credentials are read at *compile* time, so they never end up in your source tree.
    //
    // In VS Code, press Flash or Debug: the extension asks for the network name and password the first
    // time and remembers them. Building from a terminal instead, pass them on the command line:
    //
    //   WIFI_SSID="my-ssid" WIFI_PASSWORD="secret" cargo run --release
    //
    // A fixed address is the escape hatch for a network whose DHCP server never answers:
    //
    //   WIFI_STATIC_IP="192.168.1.50/24" WIFI_GATEWAY="192.168.1.1" cargo run --release
    //
    // Leave those two unset to use DHCP, which is the default. An empty password joins an open network.
    const WIFI_SSID: &str = match option_env!("WIFI_SSID") {
        Some(value) => value,
        None => "YOUR_WIFI_SSID",
    };
    const WIFI_PASSWORD: &str = match option_env!("WIFI_PASSWORD") {
        Some(value) => value,
        None => "YOUR_WIFI_PASSWORD",
    };
    const WIFI_STATIC_IP: Option<&str> = option_env!("WIFI_STATIC_IP");
    const WIFI_GATEWAY: Option<&str> = option_env!("WIFI_GATEWAY");

    // Open and protected networks are configured differently, and the difference is not cosmetic: WPA2
    // with an empty key never associates, and an open network rejects a key that was supplied.
    let authentication = if WIFI_PASSWORD.is_empty() {
        log::info!("no WIFI_PASSWORD set, joining as an open network");
        AuthenticationMethodConfig::Open
    } else {
        // WPA *and* WPA2, so an access point offering only the older one is not a bare failure. WPA3/SAE
        // does not appear in this driver's configuration at all.
        AuthenticationMethodConfig::WpaWpa2Personal(
            WIFI_PASSWORD.try_into().expect("the password is longer than 64 bytes"),
        )
    };
    let station_config = WifiConfig::Station(
        StationConfig::default()
            .with_ssid(WIFI_SSID.try_into().expect("the network name is longer than 32 bytes"))
            .with_authentication(authentication),
    );

    // The interface is the network stack's driver and it is a singleton, so it is taken before the
    // controller is built. The controller then has to stay alive for the life of the program: dropping it
    // deinitialises Wi-Fi and takes the interface down with it, which looks exactly like a dead network.
    let wifi_interface = Interface::station();
    let mut controller = WifiController::new(
        peripherals.WIFI,
        ControllerConfig::default().with_initial_config(station_config),
    )
    .expect("Wi-Fi refuses to start on this board");

    // Association is retried rather than attempted once: a router that is still booting, or a first
    // attempt that races the radio coming up, would otherwise leave the board sitting there silently.
    let mut attempt: u32 = 0;
    loop {
        attempt += 1;
        log::info!("joining {} (attempt {})", WIFI_SSID, attempt);
        match controller.connect_async().await {
            Ok(info) => {
                log::info!(
                    "associated with {:?} on channel {} (association id {})",
                    info.ssid,
                    info.channel,
                    info.aid
                );
                break;
            }
            Err(error) => {
                log::warn!("association failed: {:?}", error);
                log::warn!("check WIFI_SSID/WIFI_PASSWORD, and that the access point has a 2.4 GHz radio");
                Timer::after(Duration::from_secs(5)).await;
            }
        }
    }

    // A malformed WIFI_STATIC_IP falls back to DHCP rather than panicking: a typo in a build variable
    // should not leave the board in a boot loop whose only message is a panic.
    let net_config = match WIFI_STATIC_IP.and_then(|ip| static_ipv4_config(ip, WIFI_GATEWAY)) {
        Some(config) => {
            log::info!("using the fixed address from WIFI_STATIC_IP, so DHCP is skipped");
            config
        }
        None => {
            log::info!("using DHCP");
            NetConfig::dhcpv4(Default::default())
        }
    };

    // The stack wants a seed for its own randomness, and the chip's generator is the honest source.
    let rng = Rng::new();
    let seed = (rng.random() as u64) << 32 | rng.random() as u64;
    // The stack's buffer pool has to outlive this function, so it lives in a static. (This is written out
    // rather than hidden behind a macro: a macro_rules definition is scoped textually, so one defined in
    // the items emitted *after* main would not be visible here -- which is how the first version failed.)
    static STACK_RESOURCES: static_cell::StaticCell<StackResources<3>> = static_cell::StaticCell::new();
    let (stack, runner) = embassy_net::new(
        wifi_interface,
        net_config,
        STACK_RESOURCES.uninit().write(StackResources::<3>::new()),
        seed,
    );

    // Without this task running, not one packet is processed and the wait below never resolves.
    spawner.spawn(net_task(runner).expect("the network task is spawned exactly once"));

    stack.wait_config_up().await;
    match stack.config_v4() {
        Some(config) => log::info!("address: {}", config.address),
        None => log::warn!("the stack came up without an IPv4 address"),
    }

    // Then keep reporting, so a lease that is lost later is visible instead of the log simply stopping.
    let mut heartbeat: u32 = 0;
    loop {
        Timer::after(Duration::from_secs(10)).await;
        heartbeat = heartbeat.wrapping_add(1);
        match stack.config_v4() {
            Some(config) => log::info!("heartbeat {} at {}", heartbeat, config.address),
            None => log::warn!("heartbeat {} with no address", heartbeat),
        }
    }`;
}

/**
 * The file-scope items the Wi-Fi template needs: the address parser and the task that drives the stack.
 * Emitted after `main`: functions are hoisted, so their position does not matter.
 */
function espWifiSupport(): string {
    return `

/// Parses WIFI_STATIC_IP ("a.b.c.d/prefix") with an optional WIFI_GATEWAY ("a.b.c.d").
///
/// Returns None when the address is absent or malformed, which is what puts the stack back on DHCP. A
/// prefix longer than 32 is treated as a mistake rather than silently narrowed: it cannot mean anything.
fn static_ipv4_config(ip: &str, gateway: Option<&str>) -> Option<NetConfig> {
    let (address, prefix) = ip.split_once('/')?;
    let address = Ipv4Addr::from_str(address.trim()).ok()?;
    let prefix: u8 = prefix.trim().parse().ok()?;
    if prefix > 32 {
        return None;
    }
    let gateway = match gateway {
        Some(value) if !value.trim().is_empty() => Some(Ipv4Addr::from_str(value.trim()).ok()?),
        _ => None,
    };
    Some(NetConfig::ipv4_static(StaticConfigV4 {
        address: Ipv4Cidr::new(address, prefix),
        gateway,
        dns_servers: Default::default(),
    }))
}

/// Drives the network stack. It runs for the life of the program: no packet moves while it is not being
/// polled, and the wait in main would simply wait forever.
#[embassy_executor::task]
async fn net_task(mut runner: Runner<'static, Interface>) {
    runner.run().await;
}
`;
}

/**
 * The Bluetooth LE body: the statements that bring the controller up and hand it to the host stack.
 *
 * A Bluetooth controller is only an HCI transport -- it moves bytes and knows nothing about advertising,
 * connections or GATT. Those live in a host stack, and the one esp-radio's own BLE example uses is
 * `trouble-host` (see espBluetoothSupport below). The device advertises under a fixed name so that a
 * phone's Bluetooth scan lists it, and the log says when a central connects and disconnects, because
 * that is the whole point of the template: proving the radio and the stack come up on this board.
 */
function espBluetoothBody(): string {
    return `
    let connector = BleConnector::new(peripherals.BT, Default::default())
        .expect("the Bluetooth controller refuses to start on this board");
    let controller: ExternalController<_, 1> = ExternalController::new(connector);

    // This runs the advertising and GATT loops; it only returns if the stack gives up.
    ble_peripheral_run(controller).await;

    // Belt and braces: main has to diverge, and the stack loop's divergence is not visible from here.
    loop {
        Timer::after(Duration::from_secs(3600)).await;
    }`;
}

/**
 * The file-scope items the Bluetooth template needs: the host stack, the GATT server and its tasks.
 *
 * These are emitted after `main` rather than nested inside it -- a `#[gatt_server]` expansion is far more
 * at home at file scope, and nothing here needs to see main's locals. The shape follows esp-radio's own
 * BLE example (a battery service that also streams its level to a connected central), so the code is the
 * vendor's arrangement rather than something invented here.
 */
function espBluetoothSupport(): string {
    return `
/// The name a phone's Bluetooth scan will show. Change this to whatever you like, but keep it short:
/// the advertisement payload is 31 bytes and the name shares it with the flags and the service UUID
/// below, so a long name makes AdStructure::encode_slice fail at runtime, not at compile time.
const DEVICE_NAME: &str = "Rusty-Platform";

/// Max number of connections
const CONNECTIONS_MAX: usize = 1;
/// Max number of L2CAP channels.
const L2CAP_CHANNELS_MAX: usize = 2; // Signal + att

// GATT Server definition (bonus: makes the peripheral actually usable, not just visible).
#[gatt_server]
struct Server {
    battery_service: BatteryService,
}

/// Battery service
#[gatt_service(uuid = service::BATTERY)]
struct BatteryService {
    /// Battery Level
    #[descriptor(uuid = descriptors::VALID_RANGE, read, value = [0, 100])]
    #[descriptor(uuid = descriptors::MEASUREMENT_DESCRIPTION, name = "hello", read, value = "Battery Level", type = &'static str)]
    #[characteristic(uuid = characteristic::BATTERY_LEVEL, read, notify, value = 10)]
    level: u8,
    #[characteristic(uuid = "408813df-5dd4-1f87-ec11-cdb001100000", write, read, notify)]
    status: bool,
}

/// Run the BLE stack.
async fn ble_peripheral_run<C>(controller: C)
where
    C: Controller,
{
    let address: Address = Address::random([0xff, 0x8f, 0x1a, 0x05, 0xe4, 0xff]);
    info!("Our address = {:?}", address);

    let mut resources: HostResources<_, DefaultPacketPool, CONNECTIONS_MAX, L2CAP_CHANNELS_MAX> =
        HostResources::new();
    let stack = trouble_host::new(controller, &mut resources)
        .set_random_address(address)
        .build();
    let runner = stack.runner();
    let mut peripheral = stack.peripheral();

    info!("Starting advertising and GATT service");
    let server = Server::new_with_config(GapConfig::Peripheral(PeripheralConfig {
        name: DEVICE_NAME,
        appearance: &appearance::power_device::GENERIC_POWER_DEVICE,
    }))
    .unwrap();

    let _ = join(ble_task(runner), async {
        loop {
            match advertise(DEVICE_NAME, &mut peripheral, &server).await {
                Ok(conn) => {
                    // set up tasks when the connection is established to a central, so they don't
                    // run when no one is connected.
                    let a = gatt_events_task(&server, &conn);
                    let b = custom_task(&server, &conn, &stack);
                    // run until any task ends (usually because the connection has been closed),
                    // then return to advertising state.
                    select(a, b).await;
                }
                Err(e) => {
                    panic!("[adv] error: {:?}", e);
                }
            }
        }
    })
    .await;
}

/// This is a background task that is required to run forever alongside any other BLE tasks.
async fn ble_task<C: Controller, P: PacketPool>(mut runner: Runner<'_, C, P>) {
    loop {
        if let Err(e) = runner.run().await {
            panic!("[ble_task] error: {:?}", e);
        }
    }
}

/// Stream Events until the connection closes.
///
/// This function will handle the GATT events and process them.
async fn gatt_events_task<P: PacketPool>(
    server: &Server<'_>,
    conn: &GattConnection<'_, '_, P>,
) -> Result<(), Error> {
    let level = server.battery_service.level;
    let reason = loop {
        match conn.next().await {
            GattConnectionEvent::Disconnected { reason } => break reason,
            GattConnectionEvent::Gatt { event } => {
                match &event {
                    GattEvent::Read(event) => {
                        if event.handle() == level.handle {
                            let value = server.get(&level);
                            info!("[gatt] Read Event to Level Characteristic: {:?}", value);
                        }
                    }
                    GattEvent::Write(event) => {
                        event.with_data(|offset, data| {
                            info!(
                                "[gatt] Write Event to Level Characteristic at {}: {:?}",
                                offset, data
                            )
                        });
                    }
                    _ => {}
                };
                // This step is also performed at drop(), but writing it explicitly is necessary
                // in order to ensure reply is sent.
                match event.accept() {
                    Ok(reply) => reply.send().await,
                    Err(e) => warn!("[gatt] error sending response: {:?}", e),
                };
            }
            _ => {} // ignore other Gatt Connection Events
        }
    };
    info!("[gatt] disconnected: {:?}", reason);
    Ok(())
}

/// Create an advertiser to use to connect to a BLE Central, and wait for it to connect.
async fn advertise<'values, 'server, C: Controller>(
    name: &'values str,
    peripheral: &mut Peripheral<'values, C, DefaultPacketPool>,
    server: &'server Server<'values>,
) -> Result<GattConnection<'values, 'server, DefaultPacketPool>, BleHostError<C::Error>> {
    let mut advertiser_data = [0; 31];
    let len = AdStructure::encode_slice(
        &[
            AdStructure::Flags(LE_GENERAL_DISCOVERABLE | BR_EDR_NOT_SUPPORTED),
            AdStructure::IncompleteServiceUuids16(&[[0x0f, 0x18]]),
            AdStructure::CompleteLocalName(name.as_bytes()),
        ],
        &mut advertiser_data[..],
    )?;
    let advertiser = peripheral
        .advertise(
            &Default::default(),
            Advertisement::ConnectableScannableUndirected {
                adv_data: &advertiser_data[..len],
                scan_data: &[],
            },
        )
        .await?;
    info!("[adv] advertising as {}", name);
    let conn = advertiser.accept().await?.with_attribute_server(server)?;
    info!("[adv] connection established (central connected)");
    Ok(conn)
}

/// Example task to use the BLE notifier interface.
/// This task will notify the connected central of a counter value every 2 seconds.
/// and will stop when the connection is closed by the central or an error occurs.
async fn custom_task<C: Controller, P: PacketPool>(
    server: &Server<'_>,
    conn: &GattConnection<'_, '_, P>,
    stack: &Stack<'_, C, P>,
) {
    let mut tick: u8 = 0;
    let level = server.battery_service.level;
    loop {
        tick = tick.wrapping_add(1);
        // The attribute is stored *before* it is announced. Notifying without storing leaves the
        // characteristic at its initial value, so a central that reads it gets one answer while the
        // notifications carry another - and the read looks like a stale value rather than a bug. Found by
        // reading the characteristic on a real phone instead of only watching the notify stream (NOTES 78).
        if conn.set(&level, &tick).is_err() {
            warn!("[custom_task] could not store the level, so a read will not match the notifications");
        }
        info!("[custom_task] notifying connection of tick {}", tick);
        if level.notify(conn, &tick, true).await.is_err() {
            info!("[custom_task] error notifying connection");
            break;
        };
        // read RSSI (Received Signal Strength Indicator) of the connection.
        if let Ok(rssi) = conn.raw().rssi(stack).await {
            info!("[custom_task] RSSI: {:?}", rssi);
        } else {
            info!("[custom_task] error getting RSSI");
            break;
        };
        Timer::after(Duration::from_secs(2)).await;
    }
}
`;
}

function espSdcardBody(board: EspBoardProfile): string {
    return `
${espSdMountCode(board)}

    loop {
        log::info!(
            "sd: {}",
            if sd_mounted {
                "mounted and readable"
            } else {
                "not mounted - insert a FAT-formatted card in the TF socket and reset"
            }
        );
        Timer::after(Duration::from_secs(10)).await;
    }`;
}

/**
 * The board's sensors and its speaker/**
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
    designer = false,
): string {
    // The board template is this template plus whatever else the board carries: the RGB LED as a status
    // light, the light sensor in the log, and a beep on the speaker when a corner is recorded. One function
    // rather than two templates' worth of copied code, because the touch half is the long half and a second
    // copy of it is a second place for the next fix to be forgotten.
    const led = includeHardware && board.led.kind === 'rgb' ? board.led : undefined;
    const ldr = includeHardware ? board.ldr : undefined;
    const audio = includeHardware ? board.audio : undefined;
    // The card is mounted before the panel comes up: it needs no display, and its result belongs in the log
    // next to the rest of the board's hardware rather than in the middle of the touch loop.
    // SPI3, not SPI2: the panel takes SPI2 in the same firmware, and a driver owns its peripheral for good
    // once it has been handed over -- so the card cannot borrow the panel's bus here. On an ESP32 there are
    // two, which is why the socket was wired to pins that can reach the second one.
    const sdSetup = includeHardware && board.sd !== undefined
        ? espSdMountCode(board, 'SPI3', '_sd_mounted')
        : '';

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

    // One definition of what a beep is, shared by the reply to a touch and the longer confirmation at a
    // recorded corner, so the two cannot drift apart. A macro rather than a function because it borrows the
    // DAC -- whose type is not worth naming -- and because it awaits.
    const beepMacro = audio === undefined
        ? ''
        : `
    // A ~2 kHz square wave for the given number of milliseconds, then back to the middle of the DAC's range
    // so the amplifier is not left against a rail. 250 us per half period is two half periods per
    // millisecond, hence the doubling.
    macro_rules! beep {
        ($speaker:expr, $millis:expr) => {{
            for _ in 0..($millis * 2) {
                $speaker.write(215);
                Timer::after(Duration::from_micros(250)).await;
                $speaker.write(40);
                Timer::after(Duration::from_micros(250)).await;
            }
            $speaker.write(128);
        }};
    }
`;
    // The corner confirmation is the longer of the two.
    const beep = audio === undefined ? '' : `
                        beep!(speaker, 200);`;

    const hardwareLog = [
        led === undefined ? undefined : 'RGB LED',
        ldr === undefined ? undefined : `LDR on GPIO${ldr.pin}`,
        audio === undefined ? undefined : `speaker on GPIO${audio.pin}`,
    ].filter((line): line is string => line !== undefined);


    return `${sdSetup}${espPanelSetup(display, true)}
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
    // A touch this soon after boot means "I want to recalibrate" rather than "use the stored calibration".
    // The loop below sleeps 20 ms, so 100 ticks is about two seconds. Without this the stored record could
    // only ever be *replaced* by completing a new calibration, never discarded - so a panel calibrated for
    // the wrong orientation, or with a mapping that has drifted, had no way back to the corner screen.
    const RECALIBRATE_TICKS: u32 = 100;

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

${designer ? `    // Only when touch is wanted: naming the controller is part of having asked for it.
    if TOUCH {
` : ''}    log::info!(
        "touch: ${touch.controller} on GPIO${touch.cs} (cs), GPIO${touch.irq} (irq), pen level now {}",
        touch_irq.is_low()
    );${designer ? `
    }` : ''}
${hardwareSetup}${beepMacro}
${hardwareLog.length > 0 ? `    log::info!("board hardware: ${hardwareLog.join(', ')}");` : ''}

    // The calibration lives in the last 4 KB sector of the application partition. The app image is roughly
    // 120 KB of a 4 MB partition, so that sector is ours -- and it is not the NVS partition the bootloader
    // may read. esp-storage wraps every flash operation in a critical section (its default feature), which
    // is what makes this safe with interrupts running.
    const CALIBRATION_OFFSET: u32 = 0x3F_F000;
    const CALIBRATION_MAGIC: u32 = 0x5443_5831;

    fn calibration_bytes(
        rotation: u8,
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
        // Which orientation the numbers were measured in: the same corners on a turned panel are a
        // different mapping, so a record without this cannot be trusted after a rotation change.
        bytes[22] = rotation;
        // A plain sum over everything but the checksum byte, so a half-written or erased sector is not
        // mistaken for a calibration.
        let mut sum = 0u8;
        for (index, byte) in bytes.iter().enumerate() {
            if index != 21 {
                sum = sum.wrapping_add(*byte);
            }
        }
        bytes[21] = sum;
        bytes
    }

    // Returns the stored calibration, or nothing when the sector has never been written (an erased sector
    // reads as 0xFF, which fails both the magic and the checksum).
    fn calibration_load(flash: &mut FlashStorage<'_>) -> Option<(u8, usize, i32, i32, i32, i32)> {
        let mut bytes = [0u8; 24];
        flash.read(CALIBRATION_OFFSET, &mut bytes).ok()?;
        if u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) != CALIBRATION_MAGIC {
            return None;
        }
        let mut sum = 0u8;
        for (index, byte) in bytes.iter().enumerate() {
            if index != 21 {
                sum = sum.wrapping_add(*byte);
            }
        }
        if sum != bytes[21] {
            return None;
        }
        let word = |at: usize| -> i32 {
            i32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
        };
        Some((bytes[22], usize::from(bytes[4]), word(5), word(9), word(13), word(17)))
    }

    // esp_storage's Flash is the FLASH peripheral itself, so it is handed over rather than constructed.
    let mut flash = FlashStorage::new(peripherals.FLASH);

    // The idle baseline, taken before anything is drawn: this is what the axes read with nothing on the
    // glass, and a touch is judged by how far they move from it.
    //
    // With touch off there is no baseline, because taking one *is* talking to the controller: the bus would be
    // switched to its clock, two readings taken and the chip powered down again. Found on the board -- the
    // first version of this guard stopped the sampling in the loop and left the startup naming the controller
    // and reading it, which is not what "touch off" promised.
    let (idle_a, idle_b) = ${designer ? 'if TOUCH {' : '{'}
        bus.borrow_mut().apply_config(&touch_clock()).expect("touch clock");
        let (idle_a, _) = touch_axis(&mut touch, TOUCH_AXIS_A);
        let (idle_b, _) = touch_axis(&mut touch, TOUCH_AXIS_B);
        touch_idle(&mut touch);
        bus.borrow_mut().apply_config(&panel_clock()).expect("panel clock");
        let (idle_a, idle_b) = (i32::from(idle_a), i32::from(idle_b));
        log::info!("touch: idle baseline a={} b={}", idle_a, idle_b);
        (idle_a, idle_b)
    }${designer ? ' else {\n        (0, 0)\n    }' : ''};

    // A stored calibration is used straight away; a touch within RECALIBRATE_TICKS of boot throws it away
    // and asks for the corners again (see the press edge in the loop below). That gesture is the only way back
    // to the calibration screen once a panel has been calibrated.
    // A calibration is only valid for the orientation it was measured in: the mapping is a linear fit in the
    // content coordinate space, and that space is a different shape after a rotation. A record from another
    // orientation is discarded and the corners are asked for again -- otherwise every touch would land
    // somewhere plausible and wrong, which is the worst way for it to fail.
    // Read only when touch is wanted: an uncalibrated panel needs no calibration, and with the setting off the
    // design is painted without a calibration screen ever being considered.
    let stored = match ${designer ? 'if TOUCH { calibration_load(&mut flash) } else { None }' : 'calibration_load(&mut flash)'} {
        Some(found) if found.0 == rotation_code => Some(found),
        Some(found) => {
            log::warn!(
                "calibration: stored for rotation {} but this build is rotation {} - recalibrating",
                found.0,
                rotation_code
            );
            None
        }
        None => None,
    };
    // Two arms rather than a format_args! inside one: the numbers are printed so they can be read back
    // without a debugger, and the temporary the one-argument form would need does not outlive the log call.
    match stored {
        Some((_, axis, x_from, x_to, y_from, y_to)) => log::info!(
            "calibration: loaded from flash - axis{} {}..{} {}..{}",
            axis,
            x_from,
            x_to,
            y_from,
            y_to
        ),
        None => ${designer ? '{\n            if TOUCH {\n                log::info!("calibration: none stored");\n            }\n        }' : 'log::info!("calibration: none stored"),'}
    }

    // The four corners the screen asks for, in the order it asks.
    //
    // Everything below lives in the *content* coordinate space, which is the panel's size the other way
    // round when the rotation is vertical (see the panel setup above). The calibration targets, the
    // raw-to-screen mapping, the readout box and the graphics screen all follow from these two numbers, so
    // changing the rotation moves the whole interface rather than only the image inside it.
    const MARGIN: i32 = 24;
    // The area the driver actually draws into: the panel's size the other way round when the rotation is
    // vertical, because that is what mipidsi does to it. Everything below - the calibration targets, the
    // raw-to-screen mapping, the readout box and this template's own graphics screen - is expressed in this
    // space, so a rotated panel gets a landscape interface rather than a portrait one that runs off it.
    let width_i: i32 = if rotated { height as i32 } else { width as i32 };
    let height_i: i32 = if rotated { width as i32 } else { height as i32 };
    let box_w: i32 = (width_i - 20).min(280);
    let box_h: i32 = 104;
    let box_x: i32 = (width_i - box_w) / 2;
    let box_y: i32 = height_i / 2 - box_h / 2;
    let targets = [
        (MARGIN, MARGIN),
        (width_i - MARGIN, MARGIN),
        (width_i - MARGIN, height_i - MARGIN),
        (MARGIN, height_i - MARGIN),
    ];
    let corners = ["top-left", "top-right", "bottom-right", "bottom-left"];
    let mut measured = [[0u16; 2]; 4];
    let mut corner: usize = 0;
    // Initialised from the stored calibration when there is one, so a calibrated panel boots straight into
    // the graphics test screen and never shows the calibration screen again.
    let mut raw_x_axis: usize = stored.map(|(_, axis, _, _, _, _)| axis).unwrap_or(0);
    let mut x_from: i32 = stored.map(|(_, _, x_from, _, _, _)| x_from).unwrap_or(0);
    let mut x_to: i32 = stored.map(|(_, _, _, x_to, _, _)| x_to).unwrap_or(0);
    let mut y_from: i32 = stored.map(|(_, _, _, _, y_from, _)| y_from).unwrap_or(0);
    let mut y_to: i32 = stored.map(|(_, _, _, _, _, y_to)| y_to).unwrap_or(0);
    let mut point = (width_i / 2, height_i / 2);
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
    let mut calibrated = stored.is_some();${designer ? `
    // The design, built once on the first calibrated frame and driven by touch from then on.
    let mut screen: Option<ui::Designer> = None;` : ''}

    loop {
        if redraw_screen {
            display.clear(Rgb565::BLACK).expect("panel write failed");
            let style = MonoTextStyle::new(&FONT_6X10, Rgb565::WHITE);

            if ${designer ? 'TOUCH && ' : ''}!calibrated {
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
${designer ? `                // The design, painted instead of the diagnostic screen. DESIGNER is a const, so the
                // diagnostic branch below it is folded away in a Designer project and compiled out.
                if DESIGNER {
                    let screen = screen.get_or_insert_with(|| {
                        // Built once, on the first calibrated frame, and logged: when this project is flashed
                        // the log is what says whether the design exists at all, since a design that fails to
                        // build panics and a design that draws says nothing on its own.
                        let built = ui::Designer::new(width_i as u32, height_i as u32);
                        log::info!("design: built and painted {}x{}", width_i, height_i);
                        built
                    });
                    display.clear(Rgb565::BLACK).expect("panel write failed");
                    screen.repaint(&mut display).expect("the design did not render");
                } else {
` : ''}                // The graphics test screen, back again once the calibration is done: a frame around the
                // whole panel, four coloured corner markers, five bars and a cross through the centre.
                Text::new("Touch: numbers below, and the log", Point::new(8, 10), style)
                    .draw(&mut display)
                    .expect("panel write failed");
                Rectangle::new(Point::new(1, 1), Size::new(width_i as u32 - 2, height_i as u32 - 2))
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
                // The five bars share the width, so they read the same in portrait and landscape instead of
                // huddling on the left of a turned panel.
                let bar_gap: i32 = (width_i / 64).max(2);
                let bar_width: i32 = ((width_i - 2 * MARGIN - 4 * bar_gap) / 5).max(4);
                for (index, colour) in [Rgb565::RED, Rgb565::GREEN, Rgb565::BLUE, Rgb565::BLACK, Rgb565::WHITE]
                    .iter()
                    .enumerate()
                {
                    Rectangle::new(
                        Point::new(MARGIN + (index as i32) * (bar_width + bar_gap), 40),
                        Size::new(bar_width as u32, 40),
                    )
                        .into_styled(PrimitiveStyle::with_fill(*colour))
                        .draw(&mut display)
                        .expect("panel write failed");
                }
                Line::new(Point::new(width_i / 2, 96), Point::new(width_i / 2, height_i - 96))
                    .into_styled(PrimitiveStyle::with_stroke(Rgb565::new(16, 40, 16), 1))
                    .draw(&mut display)
                    .expect("panel write failed");
                Line::new(Point::new(8, height_i / 2), Point::new(width_i - 8, height_i / 2))
                    .into_styled(PrimitiveStyle::with_stroke(Rgb565::new(16, 40, 16), 1))
                    .draw(&mut display)
                    .expect("panel write failed");${designer ? `
                }` : ''}
            }
            redraw_screen = false;
            redraw_box = true;
        }

        // Only the readout box is repainted while a finger is down: a full clear costs about 200 ms of
        // SPI, and the numbers are supposed to keep up with the finger.
        //
        // In a Designer project it is not drawn at all. The box is a diagnostic -- raw controller readings over
        // the middle of the panel -- and it sits *outside* the branch that chooses between the design and the
        // diagnostic screen, so without this guard a touch anywhere repainted it on top of the design. Reported
        // from the board: "I can touch anywhere on the screen to update the touch readout."
        if ${designer ? '!DESIGNER && ' : ''}redraw_box {
            // The interior first, then the border on top of its edges. The numbers change length as a finger
            // moves -- "raw a=0 b=0" is shorter than "raw a=1806 b=286" -- so without clearing, each reading
            // is drawn over the tail of the one before it. Filling and then stroking is what keeps the border
            // whole: the other order erases half its width.
            Rectangle::new(Point::new(box_x, box_y), Size::new(box_w as u32, box_h as u32))
                .into_styled(PrimitiveStyle::with_fill(Rgb565::BLACK))
                .draw(&mut display)
                .expect("panel write failed");
            Rectangle::new(Point::new(box_x, box_y), Size::new(box_w as u32, box_h as u32))
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
            Text::new(line.as_str(), Point::new(box_x + 8, box_y + 8), small)
                .draw(&mut display)
                .expect("panel write failed");

            let mut line = Numbers::new();
            let _ = write!(&mut line, "raw a={} b={}", raw_a, raw_b);
            Text::new(line.as_str(), Point::new(box_x + 8, box_y + 26), small)
                .draw(&mut display)
                .expect("panel write failed");

            let mut line = Numbers::new();
            if calibrated {
                let _ = write!(&mut line, "x={} y={}", point.0, point.1);
            } else {
                let _ = write!(&mut line, "x=? y=?");
            }
            Text::new(line.as_str(), Point::new(box_x + 8, box_y + 44), big)
                .draw(&mut display)
                .expect("panel write failed");

            let mut line = Numbers::new();
            let _ = write!(&mut line, "pen={} idle a={} b={}", touch_irq.is_low(), idle_a, idle_b);
            Text::new(line.as_str(), Point::new(box_x + 8, box_y + 78), small)
                .draw(&mut display)
                .expect("panel write failed");

            shown_a = raw_a;
            shown_b = raw_b;
            redraw_box = false;
        }

        // Every third tick is about 60 ms; a burst is a few bytes at 2 MHz, so the panel's clock is only
        // away for microseconds.
        ticks = ticks.wrapping_add(1);
        // Every third tick, and only when touch is wanted: with the setting off this whole block is folded
        // away, which keeps the controller's chip select and the bus clock untouched as well as unread.
        if ${designer ? 'TOUCH && ' : ''}ticks % 3 == 0 {
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
                ${audio === undefined ? '' : 'beep!(speaker, 40);'}
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
                if calibrated && ticks < RECALIBRATE_TICKS {
                    // The touch that triggers the gesture is *consumed* by it, not recorded as a corner: the
                    // finger is wherever the user aimed at the middle of the screen, and calibrating from that
                    // would be worse than not calibrating at all.
                    calibrated = false;
                    corner = 0;
                    redraw_screen = true;
                    redraw_box = true;
                    log::info!(
                        "calibration: discarded by a touch in the first {} ticks - measure the four corners again",
                        RECALIBRATE_TICKS
                    );${beep}
                } else if !calibrated {
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
                            raw_x_axis, x_from, x_to, raw_y_axis, y_from, y_to, width_i, height_i
                        );
                        // Written once, and only after a whole set of corners: a half-set is not a
                        // calibration, so nothing is stored until the fourth one lands.
                        let bytes = calibration_bytes(rotation_code, raw_x_axis, x_from, x_to, y_from, y_to);
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
                    width_i / 2
                } else {
                    MARGIN + (i32::from(axis_x) - x_from) * (width_i - 2 * MARGIN) / (x_to - x_from)
                }
                .clamp(0, width_i - 1);
                let py = if y_to == y_from {
                    height_i / 2
                } else {
                    MARGIN + (i32::from(axis_y) - y_from) * (height_i - 2 * MARGIN) / (y_to - y_from)
                }
                .clamp(0, height_i - 1);
                point = (px, py);${designer ? `
                // Hand the sample to the design: the press and the release are what a widget acts on, and the
                // moves are what let a slider follow the finger.
                if let Some(screen) = screen.as_mut() {
                    screen.pointer(px, py, pressed);
                    screen.pump();
                    if screen.is_dirty() {
                        screen.render(&mut display).expect("the design did not render");
                    }
                }` : ''}
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

        // Not in a Designer project: the per-touch lines below and the design's own event logs are the sign of
        // life that matters there, and a line every two seconds that says "touch test" is noise in an app.
        if ${designer ? '!DESIGNER && ' : ''}ticks % 100 == 0 {
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

    // The rotation is read at *compile* time from LCD_ROTATION, which lives in this project's
    // .cargo/esp-config.toml. That is deliberate: it means the panel can be turned by changing a setting or
    // a config line, and this file -- which is where your own code goes -- never has to be edited again.
    // 0 = none, 1 = 90, 2 = 180, 3 = 270 degrees clockwise; anything else is no rotation.
    let rotation = match option_env!("LCD_ROTATION") {
        Some("1") => Rotation::Deg90,
        Some("2") => Rotation::Deg180,
        Some("3") => Rotation::Deg270,
        _ => Rotation::Deg0,
    };
    // Logged because the value comes from outside this file: a silent fall back to no rotation would be
    // indistinguishable from a rotation that was applied and simply not noticed.
    log::info!("panel rotation setting: {}", option_env!("LCD_ROTATION").unwrap_or("0"));${shared ? `
    // The rotation as a number, because the touch calibration is only valid for the orientation it was
    // measured in and the record has to say which that was.
    let rotation_code: u8 = match rotation {
        Rotation::Deg90 => 1,
        Rotation::Deg180 => 2,
        Rotation::Deg270 => 3,
        _ => 0,
    };` : ''}

    // The drawing area stays the panel's native size, whatever the rotation. Handing mipidsi the *rotated*
    // size instead looks like the obvious way to get a landscape layout, and it is not: mipidsi's
    // set_address_window computes its clipping offset as FRAMEBUFFER_SIZE - display_size, which underflows
    // once the display size is larger than the panel's framebuffer on either axis. With a mirrored
    // orientation - which this panel needs - that produces a garbage address window and the screen stays
    // white. See NOTES.md 81/82.
    let (width, height) = (${display.width}u16, ${display.height}u16);
    // mipidsi swaps the *drawing area* itself for a vertical rotation (its own display_size does that),
    // while the clipping offset is computed from the size passed in -- so the native size is both the right
    // thing to pass and what the layouts below have to be solved against when the rotation is vertical.
    let rotated = matches!(rotation, Rotation::Deg90 | Rotation::Deg270);
    let mut display = Builder::new(models::${display.controller}, di)
        .display_size(width, height)${reset}${orientation(display)}
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

    // The rotation is read at *compile* time from LCD_ROTATION, which lives in this project's
    // .cargo/esp-config.toml. That is deliberate: it means the panel can be turned by changing a setting or
    // a config line, and this file -- which is where your own code goes -- never has to be edited again.
    // 0 = none, 1 = 90, 2 = 180, 3 = 270 degrees clockwise; anything else is no rotation.
    let rotation = match option_env!("LCD_ROTATION") {
        Some("1") => Rotation::Deg90,
        Some("2") => Rotation::Deg180,
        Some("3") => Rotation::Deg270,
        _ => Rotation::Deg0,
    };
    // Logged because the value comes from outside this file: a silent fall back to no rotation would be
    // indistinguishable from a rotation that was applied and simply not noticed.
    log::info!("panel rotation setting: {}", option_env!("LCD_ROTATION").unwrap_or("0"));${shared ? `
    // The rotation as a number, because the touch calibration is only valid for the orientation it was
    // measured in and the record has to say which that was.
    let rotation_code: u8 = match rotation {
        Rotation::Deg90 => 1,
        Rotation::Deg180 => 2,
        Rotation::Deg270 => 3,
        _ => 0,
    };` : ''}

    // The drawing area stays the panel's native size, whatever the rotation. Handing mipidsi the *rotated*
    // size instead looks like the obvious way to get a landscape layout, and it is not: mipidsi's
    // set_address_window computes its clipping offset as FRAMEBUFFER_SIZE - display_size, which underflows
    // once the display size is larger than the panel's framebuffer on either axis. With a mirrored
    // orientation - which this panel needs - that produces a garbage address window and the screen stays
    // white. See NOTES.md 81/82.
    let (width, height) = (${display.width}u16, ${display.height}u16);
    // mipidsi swaps the *drawing area* itself for a vertical rotation (its own display_size does that),
    // while the clipping offset is computed from the size passed in -- so the native size is both the right
    // thing to pass and what the layouts below have to be solved against when the rotation is vertical.
    let rotated = matches!(rotation, Rotation::Deg90 | Rotation::Deg270);
    let mut display = Builder::new(models::${display.controller}, di)
        .display_size(width, height)${reset}${orientation(display)}
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

export function espDiagnosticLayout(
    display: EspDisplay,
    board: EspBoardProfile,
    size: { width: number; height: number } = { width: display.width, height: display.height },
): EspDiagnosticLayout {
    const width = size.width;
    const height = size.height;
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
/**
 * The diagnostic layout as a Rust type, plus one constant per orientation.
 *
 * The layout follows the drawing area, and the drawing area follows the rotation, so both are emitted and
 * the firmware picks at runtime. The maths stays here, where the tests can check it against every panel in
 * the catalog: a layout that would not fit is a failing test rather than a screen nobody can read.
 */
function espPanelSupport(display: EspDisplay, board: EspBoardProfile): string {
    const portrait = espDiagnosticLayout(display, board);
    // Solving a landscape layout is the right thing to do, and it is deliberately *not* selected yet: the
    // drawing area cannot exceed the panel's framebuffer (see the note in the panel setup), so a landscape
    // layout drawn into it would simply be clipped. The landscape shape is kept here, unused, so that the
    // mechanism is in place when rotation stops going through mipidsi's address window - see NOTES.md 82.
    const landscape = espDiagnosticLayout(display, board, { width: display.height, height: display.width });

    const constant = (name: string, layout: EspDiagnosticLayout): string => `const ${name}: DiagnosticLayout = DiagnosticLayout {
    width: ${layout.width},
    height: ${layout.height},
    margin: ${layout.margin},
    corner_size: ${layout.cornerSize},
    bar_gap: ${layout.barGap},
    bar_width: ${layout.barWidth},
    bar_height: ${layout.barHeight},
    bar_y: ${layout.barY},
    greeting_big: ${layout.greetingFont === 'FONT_10X20' ? 'true' : 'false'},
    greeting_x: ${layout.greetingX},
    greeting_y: ${layout.greetingY},
    status_x: ${layout.statusX},
    status_y: ${layout.statusY},
    status_step: ${layout.statusStep},
    status_lines: &[${layout.statusLines.map((line) => JSON.stringify(line)).join(', ')}],
    blink_size: ${layout.blinkSize},
    blink_x: ${layout.blinkX},
    blink_y: ${layout.blinkY},
};`;

    return `
/// Where the diagnostic screen puts everything, solved for one orientation.
///
/// Two are generated - portrait and landscape - and the firmware picks the one matching the rotation,
/// because the drawing area (and so every position inside it) follows the rotation. A square panel gets two
/// identical constants, which is harmless and keeps the selection uniform.
struct DiagnosticLayout {
    width: i32,
    height: i32,
    margin: i32,
    corner_size: i32,
    bar_gap: i32,
    bar_width: i32,
    bar_height: i32,
    bar_y: i32,
    greeting_big: bool,
    greeting_x: i32,
    greeting_y: i32,
    status_x: i32,
    status_y: i32,
    status_step: i32,
    status_lines: &'static [&'static str],
    blink_size: i32,
    blink_x: i32,
    blink_y: i32,
}

${constant('PORTRAIT_DIAGNOSTICS', portrait)}

${constant('LANDSCAPE_DIAGNOSTICS', landscape)}
`;
}

/**
 * The designer's screen on a board with no touch controller.
 *
 * There is nothing to interact with, so the design is painted once and the loop only keeps the log alive --
 * but it is the same markup, the same budgets and the same `ui::Designer`, so a design moved between this
 * board and the touch one behaves the same as far as the layout goes.
 */
function espDesignerDisplayBody(display: EspDisplay): string {
    return `${espPanelSetup(display, false)}

    let (width_i, height_i) = if rotated {
        (height as u32, width as u32)
    } else {
        (width as u32, height as u32)
    };
    let mut screen = ui::Designer::new(width_i, height_i);
    display.clear(Rgb565::BLACK).expect("panel write failed");
    screen.repaint(&mut display).expect("the design did not render");
    log::info!("design drawn: {}x{}", width_i, height_i);

    loop {
        log::info!("design alive");
        Timer::after(Duration::from_secs(10)).await;
    }`;
}

function espDisplayBody(display: EspDisplay): string {
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

    // Which geometry to draw with. The two were solved for the panel's two orientations, and only one of
    // them is the shape the glass is currently in.
    let layout = if rotated { &LANDSCAPE_DIAGNOSTICS } else { &PORTRAIT_DIAGNOSTICS };

    // A full-size frame, two pixels wide: every side visible means the whole area is addressable.
    Rectangle::new(Point::new(1, 1), Size::new(layout.width as u32 - 2, layout.height as u32 - 2))
        .into_styled(PrimitiveStyle::with_stroke(Rgb565::WHITE, 2))
        .draw(&mut display)
        .expect("panel write failed");

    // The centre cross, drawn before the bars and the text so neither is covered by it.
    Line::new(Point::new(layout.width / 2, 0), Point::new(layout.width / 2, layout.height))
        .into_styled(PrimitiveStyle::with_stroke(Rgb565::YELLOW, 1))
        .draw(&mut display)
        .expect("panel write failed");
    Line::new(Point::new(0, layout.height / 2), Point::new(layout.width, layout.height / 2))
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
            Point::new(layout.margin + (index as i32) * (layout.bar_width + layout.bar_gap), layout.bar_y),
            Size::new(layout.bar_width as u32, layout.bar_height as u32),
        )
            .into_styled(PrimitiveStyle::with_fill(*colour))
            .draw(&mut display)
            .expect("panel write failed");
    }

    // Corner markers, so a shift is measurable: red top-left, green top-right, blue bottom-left, white
    // bottom-right. A red square that is not in the corner, or one cut in half, is the answer.
    for (x, y, colour) in [
        (0, 0, Rgb565::RED),
        (layout.width - layout.corner_size, 0, Rgb565::GREEN),
        (0, layout.height - layout.corner_size, Rgb565::BLUE),
        (layout.width - layout.corner_size, layout.height - layout.corner_size, Rgb565::WHITE),
    ] {
        Rectangle::new(Point::new(x, y), Size::new(layout.corner_size as u32, layout.corner_size as u32))
            .into_styled(PrimitiveStyle::with_fill(colour))
            .draw(&mut display)
            .expect("panel write failed");
    }

    // The greeting font is chosen per orientation: a line that fits a 128 px panel would have to shrink on
    // a 480 px one, and the layout already worked out which.
    let greeting_style = MonoTextStyle::new(
        if layout.greeting_big { &FONT_10X20 } else { &FONT_6X10 },
        Rgb565::YELLOW,
    );
    Text::new("Hello Grumpy!", Point::new(layout.greeting_x, layout.greeting_y), greeting_style)
        .draw(&mut display)
        .expect("panel write failed");

    // What this screen is supposed to look like, in the panel's own words. Each orientation carries its own
    // list, already filtered to the lines that fit it: a status line drawn off the edge is worse than no
    // status line, and a line that fits a 480 px panel does not necessarily fit a 320 px one.
    let small = MonoTextStyle::new(&FONT_6X10, Rgb565::WHITE);
    let mut line = layout.status_y;
    for &text in layout.status_lines {
        Text::new(text, Point::new(layout.status_x, line), small)
            .draw(&mut display)
            .expect("panel write failed");
        line += layout.status_step;
    }
    log::info!(
        "diagnostics drawn in {} ms: frame, corners, 5 bars, cross and text",
        drawn_at.elapsed().as_millis()
    );
    let mut tick: u32 = 0;
    loop {
        // One small square, blinking: proof the loop is alive, placed clear of every diagnostic so it cannot
        // be mistaken for one.
        let colour = if tick % 2 == 0 { Rgb565::WHITE } else { Rgb565::BLACK };
        Rectangle::new(Point::new(layout.blink_x, layout.blink_y), Size::new(layout.blink_size as u32, layout.blink_size as u32))
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

function espVscodeSettings(board: EspBoardProfile, rotation: LcdRotation, usesPanel: boolean): string {
    // Written workspace-scoped so the value travels with the project: the extension reads it back to keep
    // .cargo/esp-config.toml in step, so changing the setting here is all it takes.
    const settings: Record<string, unknown> = {
        'rust-analyzer.cargo.target': board.target,
        'rust-analyzer.check.allTargets': false,
        'rust-analyzer.linkedProjects': ['Cargo.toml'],
    };
    if (usesPanel) {
        settings['rustyPlatform.lcdRotation'] = rotation;
    }
    return `${JSON.stringify(settings, null, 2)}\n`;
}

function espReadme(
    board: EspBoardProfile,
    crateName: string,
    template: AppTemplate,
    choices: BoardChoices,
    rotation: LcdRotation,
): string {
    // Only the pins the generated firmware actually drives are listed: the SD socket is still
    // described in the notes rather than claimed, because no template touches it yet.
    // Asked rather than re-listed. This was a second copy of the rule, and the designer was added to the
    // shared helper without reaching here -- which generated a Designer project whose body was the RGB LED
    // heartbeat. Found by generating one, 2026-10-08.
    const usesPanel = templateUsesPanel(template);
    const display = usesPanel ? displayFor(board, choices) : undefined;
    // A Designer project drives touch where the board has a controller and is a static screen where it does
    // not: the T-QT has a panel and no touch controller.
    const touch =
        template === 'touch' || template === 'board' || template === 'designer' ? board.touch : undefined;
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

    // The Wi-Fi template shares the Pico's credentials contract, so the same prompt serves it. What it
    // cannot do is report an address, and the README says so in as many words: esp-radio 1.0.0-beta.1 has
    // no address API, and a README that implied DHCP would be the first place a user looks and the last
    // place the truth appears.
    const wifiNote = template === 'wifi'
        ? `
## Wi-Fi credentials

Credentials are read at *compile* time, so they never end up in your source tree.

The easy way: press **Flash** or **Debug** - Grumpy's Rusty Platform asks for the network name
and password the first time and remembers them (in VS Code's keyring, not in this project).

From a plain terminal, pass them yourself:

\`\`\`sh
WIFI_SSID="my-ssid" WIFI_PASSWORD="secret" cargo run --release
\`\`\`

An empty password joins an open network.

### Getting an address

The radio driver moves frames; **embassy-net** sits on top of it and owns the address. So the log tells
you what the board got:

    associated with "MyNetwork" on channel 6 (association id 32769)
    using DHCP
    address: 192.168.1.74/24
    heartbeat 1 at 192.168.1.74/24

If your network's DHCP server never answers, give the board a fixed address instead - the credential
prompt has fields for it, or pass them when building:

\`\`\`sh
WIFI_STATIC_IP="192.168.1.50/24" WIFI_GATEWAY="192.168.1.1" cargo run --release
\`\`\`

Leave them unset for DHCP, which is the default. A malformed address falls back to DHCP rather than
stopping the build, so a typo is survivable.

### What this firmware does not do

**WPA3/SAE is not supported** - the driver offers open, WEP, WPA and WPA2 personal only - and the radio
is 2.4 GHz, so a 5 GHz-only network will never be joined. A failed association is retried every five
seconds and each failure is logged with the driver's own reason rather than being swallowed.
`
        : '';
    const bluetoothNote = template === 'bluetooth'
        ? `
## Bluetooth

The board advertises as **Rusty-Platform**; change \`DEVICE_NAME\` in \`src/main.rs\` to rename it,
and keep the replacement short - the advertisement payload is 31 bytes and the name shares it with
the flags and the service UUID, so a long one fails at runtime.

Scan for it with a phone. The log reports the connection, and the GATT service it carries is the
upstream example's battery-service skeleton - its level is a counter that ticks every two seconds,
not a battery reading, so replace it with something true for your project before you ship it. The
counter is stored in the characteristic before it is announced, so **a read returns the same value the
notifications carry**; the two cannot disagree. It wraps at 255 ticks (about eight and a half minutes).
`
        : '';
    const rotationSection = templateUsesPanel(template)
        ? `
## Panel rotation

This project is generated for **${LCD_ROTATION_LABELS[rotation]}**. The choice lives in two places:

- \`LCD_ROTATION\` in \`.cargo/esp-config.toml\` - what the firmware actually reads, at **compile time**;
- \`rustyPlatform.lcdRotation\` in \`.vscode/settings.json\` - the same choice as a **setting scoped to this
  project**, which is the convenient way to change it: change the setting and Grumpy's Rusty Platform
  rewrites the line above for you.

Editing the line in \`.cargo/esp-config.toml\` by hand works too, since that is the file the compiler reads;
the setting will still show the old value until you change it. Either way, rebuild to apply it. There is
nothing to edit in \`src/main.rs\`, and no need to regenerate the project. 0 is no rotation, and 1/2/3 are
90/180/270 degrees clockwise.

The rotation turns the interface, and the drawing area turns with it. You hand the display driver the panel's
native size and the driver swaps the area it draws into when the rotation is 90 or 270 degrees, so the generated
screens are solved for the shape that is actually being addressed: a landscape rotation gets a landscape frame,
bars, corner markers, status lines and touch targets, and a portrait rotation gets a portrait one. Verified at
270 degrees on hardware with every edge, corner and bar visible.${board.touch !== undefined ? `
The touch calibration is versioned by rotation: a record measured in one orientation is
discarded when the rotation changes and the four corners are asked for again. To force that by hand, touch
the glass within the first two seconds after a reset - the stored calibration is thrown away and the corner
screen comes back.` : ''}
`
        : '';
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
${wifiNote}${bluetoothNote}${rotationSection}
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
