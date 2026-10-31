import { BoardProfile, RpBoardProfile, isEspBoard } from '../boards/types';
import {
    cardSharesPanelBus,
    defaultWiring,
    panelModuleOrDefault,
    rpPinUsage,
    validateWiring,
    wiringFile,
    wiringHasErrors,
    type PanelWiring,
} from '../boards/panels';
import { binaryNameFrom, crateNameFrom } from './naming';
import { emitPanelRs } from './rp-panel';
import { emitRpSdRs } from './rp-sd';
import { emitRpNetRs, isRpPanelTemplate, rpPanelMainFiles, type RpPanelTemplate } from './rp-designer';
import {
    DESIGNER_FILES,
    RP_LOG_MACRO,
    emitHandlersRs,
    emitProjectKdl,
    emitStarterKdl,
    emitUiRs,
    starterDocument,
} from '../designer/generate';
import { DESIGNER_HARDWARE_PATH } from '../designer/model';
import { DEFAULT_BRIGHTNESS, clampBrightness } from '../display/backlight';
import { asLcdRotation, type LcdRotation } from '../display/rotation';
import {
    SKETCH_HEADER_PATH,
    SketchFiles,
    StateField,
    againstState,
    codeGuidance,
    exampleFunction,
    headerGuidance,
    hoistHeader,
    immutableLocals,
    mainFn,
    publicHeaderItems,
    setupFn,
    sketchFiles,
    splitAtLoop,
    stateStruct,
} from './sketch';
import { defaultTemplateForEsp, generateEspProjectFiles, offeredTemplateIds, templatesForEsp } from './esp';

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
    // Every Pico can drive a panel somebody wired to it, so the three panel templates are offered on all
    // four boards. What differs per board is only which GPIOs are free, and the Designer's Hardware panel
    // is where that is checked -- not a per-board template list.
    const panelTemplates: AppTemplateInfo[] = [
        {
            id: 'designer',
            label: 'WYSIWYG designer',
            description:
                'A project whose screen is a design rather than Rust: the extension opens the designer, the '
                + 'design is written to src/ui.kdl, and the widgets\' events land in src/ui_handlers.rs for you '
                + 'to fill in. Asks which display module is wired and starts from a working set of GPIOs.',
        },
        {
            id: 'display',
            label: 'Panel diagnostic screen',
            description:
                'Initialises the wired module and draws a screen to read: frame, corner markers, colour bars '
                + 'and a blinking square, with the paint time in the log.',
        },
        {
            id: 'sdcard',
            label: 'SD card test',
            description:
                'Mounts the card in the module\'s socket and reports its capacity, on the glass and in the log.',
        },
    ];
    if (board.wireless === 'none') {
        return [
            {
                id: 'blinky',
                label: 'LED blinky',
                description: 'Blinks the on-board LED. The classic starting point.',
            },
            ...panelTemplates,
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
        ...panelTemplates,
    ];
}

export function isTemplateValidFor(board: BoardProfile, template: AppTemplate): boolean {
    return templatesFor(board).some((info) => info.id === template);
}

/**
 * What the New Project wizard offers when a board is picked.
 *
 * `templatesFor` answers what the board can generate; this answers what its option presents. They differ
 * only where a board's own list is narrower (the ESP32-035 offers the WYSIWYG designer alone), which keeps
 * a board bought for its panel from opening with a menu of diagnostics nobody chose it for.
 */
export function templatesOfferedFor(board: BoardProfile): AppTemplateInfo[] {
    const all = templatesFor(board);
    if (!isEspBoard(board)) {
        return all;
    }
    const only = offeredTemplateIds(board);
    if (only === undefined) {
        return all;
    }
    return all.filter((info) => only.includes(info.id));
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
    /**
     * Whether the project should drive its touch controller.
     *
     * Only a Designer project on a board that has one asks: a board without a controller has no touch code to
     * switch, and the explicit templates are what their names say.
     */
    touch?: boolean;
    /**
     * The UTC offset, in minutes, a Designer project's Wi-Fi time is shown at. Defaults to 0 (UTC);
     * the wizard passes the machine's own offset so a new clock is right without an edit.
     */
    clockOffsetMinutes?: number;
    /**
     * The panel backlight's brightness in percent, for a panel with a backlight pin. Defaults to fully on.
     */
    brightness?: number;
    /**
     * The GPIO wiring of a Pico panel project.
     *
     * Omitted for a project that drives no panel, and defaulted for one that does: the wizard always passes
     * what its Hardware step started from, so a generated project and the Designer agree about every pin.
     */
    wiring?: PanelWiring;
}

/**
 * A Pico panel project, resolved: which template, which module, which GPIOs, and the two settings the
 * firmware reads at compile time.
 */
interface RpPanelProject {
    template: RpPanelTemplate;
    wiring: PanelWiring;
    touch: boolean;
    sd: boolean;
    rotation: LcdRotation;
    brightness: number;
    clockOffsetMinutes: number;
}

/**
 * Resolves the panel side of an RP generation, or `undefined` for a template that drives no panel.
 *
 * A wiring with an error is refused here rather than written out: every rule in `validateWiring` is also a
 * rule embassy-rp's typed pins enforce, so the alternative is a project that fails to compile with a
 * trait-bound error naming a type instead of a GPIO. The message is the validator's own, which names the
 * pin and says what else it could be.
 */
function rpPanelProject(
    board: RpBoardProfile,
    template: AppTemplate,
    options: GenerateOptions,
): RpPanelProject | undefined {
    if (!isRpPanelTemplate(template)) {
        return undefined;
    }
    const wiring = options.wiring ?? defaultWiring(board);
    const problems = validateWiring(board, wiring);
    if (wiringHasErrors(problems)) {
        throw new Error(
            `The panel wiring for ${board.name} is not usable: ` +
            problems
                .filter((problem) => problem.severity === 'error')
                .map((problem) => problem.message)
                .join(' '),
        );
    }
    const module = panelModuleOrDefault(wiring.panel);
    return {
        template,
        wiring,
        // Touch follows the module: a controller that is not on the glass has nothing to drive, and one
        // that is has no reason to be switched off.
        touch: module.touch && wiring.touchCs !== null && wiring.touchIrq !== null,
        // The card is mounted by the Designer (a design can name `sd:` images) and by the card test, whose
        // whole purpose it is. The diagnostic screen is about the glass, so it does not mount a filesystem
        // it never reads -- which also keeps `embedded-sdmmc` out of that project.
        sd: template !== 'display' && wiring.sdCs !== null,
        rotation: asLcdRotation(options.rotation ?? 0),
        brightness: clampBrightness(options.brightness ?? DEFAULT_BRIGHTNESS),
        clockOffsetMinutes: options.clockOffsetMinutes ?? 0,
    };
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
            touch: options.touch,
            clockOffsetMinutes: options.clockOffsetMinutes,
            brightness: options.brightness,
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
    const panel = rpPanelProject(board, template, options);

    const files: GeneratedFile[] = [
        { path: 'Cargo.toml', content: cargoToml(board, crateName, template, panel) },
        { path: '.cargo/config.toml', content: cargoConfigToml(board, panel) },
        { path: 'rust-toolchain.toml', content: rustToolchainToml(board) },
        { path: 'memory.x', content: memoryX(board) },
        { path: 'build.rs', content: buildRs(board) },
        ...rpMainFiles(board, template, panel),
        { path: '.vscode/settings.json', content: vscodeSettings(board) },
        { path: '.vscode/launch.json', content: launchJson(board, binaryName) },
        { path: '.gitignore', content: gitignore() },
        { path: 'README.md', content: readme(board, crateName, template, panel) },
    ];

    if (panel !== undefined) {
        // The hardware the whole project is wired to. The Designer rewrites this file on every save, so it
        // is generated from the same wiring the wizard started from -- there is no second source of pins.
        files.push({
            path: 'src/panel.rs',
            content: emitPanelRs({ board, wiring: panel.wiring, touch: panel.touch, sd: panel.sd }),
        });
        if (panel.sd) {
            files.push({
                path: 'src/sd.rs',
                content: emitRpSdRs({
                    sharedBus: cardSharesPanelBus(panel.wiring),
                    // Only a design reads files from the card; the card test just mounts it.
                    imageReader: panel.template === 'designer',
                }),
            });
        }
        if (panel.template === 'designer' && board.wireless === 'cyw43') {
            // The clock's second source. Its task is only spawned with the `time-wifi` feature on, and the
            // feature is only defined on a board that has a radio.
            files.push({ path: 'src/net.rs', content: emitRpNetRs(board) });
        }
        if (panel.template === 'designer') {
            // The wiring, beside the design document: what the screen is plugged into, as opposed to what
            // it looks like. The Designer reads it back and offers every number in it for editing.
            files.push({ path: DESIGNER_HARDWARE_PATH, content: wiringFile(panel.wiring) });

            // The four files a Designer project is born with: the design, the markup it compiles to, the Rust
            // that drives it and the code-behind the user fills in. The module's touch controller decides
            // whether the generated Rust carries the pointer plumbing at all.
            const starter = starterDocument({
                boardId: board.id,
                panelWidth: panelModuleOrDefault(panel.wiring.panel).width,
                panelHeight: panelModuleOrDefault(panel.wiring.panel).height,
                rotation: panel.rotation,
            });
            files.push(
                { path: DESIGNER_FILES.markup, content: emitStarterKdl(starter) },
                { path: DESIGNER_FILES.rust, content: emitUiRs(starter, panel.touch) },
                { path: DESIGNER_FILES.handlers, content: emitHandlersRs(starter, panel.touch, RP_LOG_MACRO) },
                { path: DESIGNER_FILES.document, content: `${JSON.stringify(starter, null, 2)}\n` },
                { path: DESIGNER_FILES.manifest, content: emitProjectKdl(starter) },
            );
        }
    }

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

function cargoToml(
    board: RpBoardProfile,
    crateName: string,
    template: AppTemplate,
    panel?: RpPanelProject,
): string {
    const wireless = board.wireless === 'cyw43';
    const bluetooth = template === 'wifi-bluetooth';
    // The SNTP module needs DNS and a UDP socket, and a designer project on a W board is the only thing
    // that asks for them: the plain Wi-Fi templates never resolve a name.
    const netFeatures = panel?.template === 'designer'
        ? '"defmt", "dhcpv4", "medium-ethernet", "proto-ipv4", "dns", "udp"'
        : '"defmt", "dhcpv4", "medium-ethernet", "proto-ipv4"';

    const wirelessBlock = wireless
        ? `
# CYW43 Wi-Fi/Bluetooth chip, driven over PIO SPI. The firmware blobs live in
# ./firmware and are baked into the image with \`aligned_bytes!\`.
cyw43 = { version = "${CRATE_VERSIONS.cyw43}", features = [${bluetooth ? '"defmt", "bluetooth"' : '"defmt"'}] }
cyw43-pio = { version = "${CRATE_VERSIONS.cyw43Pio}", features = ["defmt"] }
embassy-net = { version = "${CRATE_VERSIONS.embassyNet}", features = [${netFeatures}] }
static_cell = "${CRATE_VERSIONS.staticCell}"
# static_cell performs an atomic compare-exchange. The Cortex-M0+ has no atomic CAS,
# so portable-atomic provides one via critical-section (as Embassy's examples do).
portable-atomic = { version = "${CRATE_VERSIONS.portableAtomic}", features = ["critical-section"] }
${panel?.template === 'designer' ? 'embassy-sync = "0.8"\n' : ''}`
        : '';

    const panelBlock = panel === undefined
        ? ''
        : `
# --- the panel ------------------------------------------------------------
# mipidsi drives the controller. embedded-hal-bus is what shares one SPI peripheral between the panel, its
# touch controller and (when the socket shares the bus) the card, each with its own chip select.
mipidsi = "0.10.0"
embedded-hal = "1.0.0"
embedded-hal-bus = "0.3.0"
embedded-graphics = "0.8"
${wireless
            ? ''
            : `static_cell = "${CRATE_VERSIONS.staticCell}"
# static_cell performs an atomic compare-exchange. The Cortex-M0+ has no atomic CAS, so portable-atomic
# provides one via critical-section (as Embassy's examples do).
portable-atomic = { version = "${CRATE_VERSIONS.portableAtomic}", features = ["critical-section"] }
`
        }${panel.sd
            ? '# The card, pulled in by the `sd` feature the Designer switches.\nembedded-sdmmc = { version = "0.8.2", optional = true }\n'
            : ''
        }${panel.template === 'designer'
            ? '# The runtime the design compiles against, vendored into codegen/ by the project wizard.\nembedded-gui = { version = "0.2.7", default-features = false, features = ["rich-widgets", "embedded-graphics", "macros", "micromath"] }\nrusty-gui-widgets = { path = "codegen/rusty-gui-widgets", default-features = false }\n'
            : ''
        }`;

    // Both settings are cargo features rather than keys, because enabling them is what adds code to the
    // build: a feature can pull in a dependency or a module, and a config value cannot. `default` carries
    // them so a project generated today is complete; the Designer's switches move them afterwards.
    const featureLines: string[] = [];
    if (panel?.sd) {
        featureLines.push('sd = ["dep:embedded-sdmmc"]');
    }
    if (panel?.template === 'designer' && wireless) {
        featureLines.push('# The clock taken from the network instead of the build time.');
        featureLines.push('time-wifi = []');
    }
    const defaults = [panel?.sd ? '"sd"' : '', panel?.template === 'designer' && wireless ? '"time-wifi"' : '']
        .filter((entry) => entry !== '')
        .join(', ');
    const featureBlock = featureLines.length === 0
        ? ''
        : `
[features]
${featureLines.join('\n')}
default = [${defaults}]
`;

    // `[patch.crates-io]` is resolved even when nothing depends on the patched crate, so a dangling one
    // stops every other template dead -- it is written for the Designer template only, as on the ESP side.
    const vendored = panel?.template === 'designer'
        ? `
# Vendored alongside every Designer project (see crates/ in this extension): the shapes widget crate, the
# codegen fork that emits add_custom_widget calls for shapes, and the runtime fork a design can name.
[patch.crates-io]
embedded-gui-codegen = { path = "codegen/embedded-gui-codegen" }
embedded-gui = { path = "codegen/embedded-gui" }
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
${wirelessBlock}${bluetoothBlock}${panelBlock}
defmt = "${CRATE_VERSIONS.defmt}"
defmt-rtt = "${CRATE_VERSIONS.defmtRtt}"
panic-probe = { version = "${CRATE_VERSIONS.panicProbe}", features = ["print-defmt"] }
cortex-m = { version = "${CRATE_VERSIONS.cortexM}", features = ["inline-asm"] }
cortex-m-rt = "${CRATE_VERSIONS.cortexMRt}"
critical-section = "${CRATE_VERSIONS.criticalSection}"
${featureBlock}${vendored}${DEBUG_PROFILE}
[profile.release]
debug = true
lto = true
opt-level = "s"
`;
}

function cargoConfigToml(board: RpBoardProfile, panel?: RpPanelProject): string {
    // The panel project's settings are environment variables rather than lines in `main.rs`, for the same
    // reason the ESP side uses `esp-config`: `panel.rs` reads them with `option_env!` at compile time, so
    // turning the glass or dimming the backlight is a rebuild and never an edit of a file the Designer owns.
    const panelEnv = panel === undefined
        ? ''
        : `# The panel's rotation: 0 none, 1 = 90, 2 = 180, 3 = 270 degrees clockwise. The Designer writes
# this when the design is turned, and src/panel.rs reads it.
LCD_ROTATION = "${panel.rotation}"
# Backlight brightness in percent; a module with no BL pin ignores it. The Designer's Brightness slider
# writes it.
BACKLIGHT_BRIGHTNESS = "${panel.brightness}"
# The time this project is built at, in Unix seconds. A Pico has no RTC on the chip, so a clock design
# starts from here; the extension refreshes it before every build, which is what makes "set when it was
# flashed" true.
RUSTY_EPOCH = "0"
# Minutes to add to UTC for the clock on the glass. A no_std image has no timezone database, so the
# offset is a build-time number; edit it when the clocks change.
RUSTY_UTC_OFFSET = "${panel.clockOffsetMinutes}"
`;
    return `# Generated by Grumpy's Rusty Platform for VS Code.
[target.'cfg(all(target_arch = "arm", target_os = "none"))']
runner = "probe-rs run --chip ${board.probeChip}"

[build]
target = "${board.target}"

[env]
# 'info', not 'debug': the extension's own diagnostics are info lines, and 'debug' switches on every library's
# chatter -- embassy's executor and timer logs are the chatty ones, and every line costs the target time and
# RTT bandwidth it would rather spend on the panel.
DEFMT_LOG = "info"
${panelEnv}`;
}

/**
 * The debug profile, tuned for a panel rather than for a breakpoint.
 *
 * Rust's dev profile builds *everything* at opt-level 0 -- the project's own crate and every library under it
 * -- so a debug build spends most of a frame inside `embedded-graphics`' iterator plumbing, unable to inline
 * any of it. A C++ project does not feel this the same way because its libraries are usually shipped compiled.
 * Giving the libraries `opt-level = 3` is the fix; `opt-level = 1` for the project's own crate keeps the locals
 * a breakpoint can show.
 */
export const DEBUG_PROFILE = `
# The debug profile is what the Debug button builds, and a design repaints a whole panel every frame: at
# opt-level 0, embedded-graphics spends most of that frame in iterator plumbing it is not allowed to inline.
# Level 1 keeps the variables a breakpoint can show, and the libraries are built as released -- which is where
# the pixels are actually drawn. Debugging is unaffected: the lines and the locals are still there.
[profile.dev]
opt-level = 1
debug = 2

[profile.dev.package."*"]
opt-level = 3
`;

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

/** The two files a template's sketch is written to: `src/main.rs` and `src/MainHeader.rs`. */
function rpMainFiles(board: RpBoardProfile, template: AppTemplate, panel?: RpPanelProject): GeneratedFile[] {
    // A panel template's two files are written whole rather than assembled from sketch markers: every line
    // of them is about the hardware `panel.rs` brought up, and there is no second family variant to share a
    // marker language with.
    if (panel !== undefined) {
        const files = rpPanelMainFiles({
            board,
            template: panel.template,
            wiring: panel.wiring,
            touch: panel.touch,
            sd: panel.sd,
            clockOffsetMinutes: panel.clockOffsetMinutes,
        });
        return [
            { path: 'src/main.rs', content: files.main },
            { path: SKETCH_HEADER_PATH, content: files.header },
        ];
    }
    const sketch = rpSketch(board, template);
    return [
        { path: 'src/main.rs', content: sketch.main },
        { path: SKETCH_HEADER_PATH, content: sketch.header },
    ];
}

/**
 * One RP template's sketch, in the Arduino shape: see `generate/sketch.ts` for what the three pieces are.
 *
 * The bodies below are read as one piece of Rust each; the generator splits them at the markers into the
 * header's material, `setup()`'s body and the loop that goes inside `main()`.
 */
function rpSketch(board: RpBoardProfile, template: AppTemplate): SketchFiles {
    const wireless = board.wireless === 'cyw43';
    const fields = rpStateFields(board, template);
    const hoisted = hoistHeader(mainRs(board, template));
    const split = splitAtLoop(hoisted.body);
    const support = wireless
        ? [publicHeaderItems(cyw43Support(board, template)), CYW43_CONTROL_ALIAS].join('\n\n')
        : '';
    return sketchFiles({
        banner: mainHeader(board, template).trimEnd(),
        imports: rpImports(board, template),
        sideEffects: [],
        prologue: '#![no_std]\n#![no_main]',
        state: stateStruct(rpStateDoc(template), fields),
        setup: setupFn({
            doc: rpSetupDoc(template),
            params: wireless ? 'spawner: Spawner' : '',
            body: immutableLocals(split.init, fields),
            fields,
        }),
        main: mainFn({
            doc: rpMainDoc(),
            attribute:
                '#[embassy_executor::main(executor = "embassy_rp::executor::Executor", ' +
                'entry = "cortex_m_rt::entry")]',
            signature: `async fn main(${wireless ? 'spawner' : '_spawner'}: Spawner)`,
            setupCall: wireless ? 'setup(spawner).await' : 'setup().await',
            loop: againstState(split.loop, fields.map((field) => field.name)),
            diverges: false,
        }),
        footer: codeGuidance(
            exampleFunction(fields, board.led.kind === 'cyw43' ? board.led.index : 0),
        ),
        material: [support, hoisted.material, headerGuidance()].filter((text) => text !== '').join('\n\n'),
    });
}

/**
 * The imports an RP header carries.
 *
 * embassy-rp provides its own multicore-capable executor, so it has to be named in the entry attribute --
 * there is no `platform-cortex-m` feature on embassy-executor (see the comment the emitted `main()` keeps).
 */
function rpImports(board: RpBoardProfile, template: AppTemplate): string[] {
    const cyw = board.cyw43;
    const divider = cyw?.clockDivider ?? 'DEFAULT_CLOCK_DIVIDER';
    // `use … as _;` two lines down are the side-effect imports; the rest are re-exported by the header.
    const common = ['use panic_probe as _;', 'use defmt_rtt as _;'];
    if (board.wireless !== 'cyw43') {
        return [
            'use defmt::info;',
            'use embassy_executor::Spawner;',
            'use embassy_rp::gpio::{Level, Output};',
            'use embassy_time::Timer;',
            ...common,
        ];
    }
    // `static_cell` is a dependency of the wireless projects only: it holds the CYW43 state and the network
    // stack's resources, so a plain Pico project must not import it -- there is nothing to link against.
    const wireless = ['use static_cell::StaticCell;', ...common];
    if (template === 'blinky') {
        return [
            'use cyw43::aligned_bytes;',
            `use cyw43_pio::{${divider}, PioSpi};`,
            'use defmt::*;',
            'use embassy_executor::Spawner;',
            'use embassy_rp::gpio::{Level, Output};',
            `use embassy_rp::peripherals::{${cyw?.dmaCh0}, ${cyw?.pio}};`,
            'use embassy_rp::pio::{InterruptHandler, Pio};',
            'use embassy_rp::{bind_interrupts, dma};',
            'use embassy_time::Timer;',
            ...wireless,
        ];
    }
    return [
        'use cyw43::{aligned_bytes, JoinOptions};',
        `use cyw43_pio::{${divider}, PioSpi};`,
        'use defmt::*;',
        'use embassy_executor::Spawner;',
        'use embassy_rp::clocks::RoscRng;',
        'use embassy_rp::gpio::{Level, Output};',
        `use embassy_rp::peripherals::{${cyw?.dmaCh0}, ${cyw?.pio}};`,
        'use embassy_rp::pio::{InterruptHandler, Pio};',
        'use embassy_rp::{bind_interrupts, dma};',
        'use embassy_time::{Duration, Timer};',
        ...wireless,
    ];
}

/** One phrase per template, for the generated docs. */
const RP_SKETCH_SUBJECT: Record<AppTemplate, string> = {
    blinky: 'the LED',
    wifi: 'the wireless chip, the network stack and the LED',
    bluetooth: 'the wireless chip',
    'wifi-bluetooth': 'the wireless chip, the network stack and the LED',
    display: 'the panel',
    touch: 'the panel and its touch controller',
    peripherals: 'the board\u2019s peripherals',
    board: 'everything this board carries',
    designer: 'the design and the panel it is drawn on',
    sdcard: 'the card',
};

/** What `State` is, for the struct's own comment. */
function rpStateDoc(template: AppTemplate): string {
    return `Every value this sketch keeps: ${RP_SKETCH_SUBJECT[template]}, created once by setup() and used by the
loop in main().\n`;
}

/** What `setup()` is for, for its comment. */
function rpSetupDoc(template: AppTemplate): string {
    return `One-time initialisation -- the Arduino setup().\n\nBrings up ${RP_SKETCH_SUBJECT[template]} and hands it back as a State for main() to run. Everything that must
happen once, and only once, belongs here.\n`;
}

/** What `main()` is for, for its comment. */
function rpMainDoc(): string {
    return `The sketch\u2019s entry point -- the Arduino main() around setup() and the loop.

setup() runs once, then the implementation below repeats for as long as the board is powered. This is the
function to edit: everything it needs from setup() is in state.
`;
}

/** The fields of `State` for an RP template. */
function rpStateFields(board: RpBoardProfile, template: AppTemplate): StateField[] {
    const fields: StateField[] = [];
    if (board.wireless !== 'cyw43') {
        return [
            {
                name: 'led',
                type: "Output<'static>",
                doc: `The LED${board.led.kind === 'gpio' ? ` on GPIO${board.led.pin}` : ' on the board'}.`,
            },
        ];
    }
    fields.push({
        name: 'control',
        type: 'Cyw43Control',
        mutableInSetup: true,
        doc: 'The wireless chip, once its firmware is running. The LED on a Pico W is a GPIO on this chip,'
            + ' and the loop drives it through here.',
    });
    if (template === 'wifi' || template === 'wifi-bluetooth') {
        fields.push({
            name: 'stack',
            type: "embassy_net::Stack<'static>",
            keepAlive: true,
            doc: 'The network stack, once the association and the lease are settled. Nothing in the loop reads'
                + ' it: it is kept so that the handle is not dropped while the stack is still running.',
        });
    }
    return fields;
}

function mainRsWired(board: RpBoardProfile): string {
    const pin = board.led.kind === 'gpio' ? board.led.pin : 'PIN_25';
    return `
    // RTT keeps the previous image's bytes after a reset, and a stale frame can decode into
    // nonsense (defmt's own strings show up as log values). The current run begins at the last
    // line like this one.
    info!("=== {} {} starting ===", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"));

    let p = embassy_rp::init(Default::default());
    info!("Hello from Grumpy's Rusty Platform on ${board.family}!");

    let led = Output::new(p.${pin}, Level::Low);

    //@loop
        led.set_high();
        Timer::after_millis(500).await;
        led.set_low();
        Timer::after_millis(500).await;
    //@end`;
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
    const ledIndex = board.led.kind === 'cyw43' ? board.led.index : 0;
    return `
${cyw43BringUp(board)}
    let (_net_device, mut control, runner) = cyw43::new(state, pwr, spi, fw, nvram).await;
    spawner.spawn(unwrap!(cyw43_task(runner)));

    control.init(clm).await;
    control
        .set_power_management(cyw43::PowerManagementMode::PowerSave)
        .await;

    info!("CYW43 is up on ${board.family}");

    //@loop
        control.gpio_set(${ledIndex}, true).await;
        Timer::after_millis(250).await;
        control.gpio_set(${ledIndex}, false).await;
        Timer::after_millis(250).await;
    //@end`;
}

/**
 * The interrupt bindings and the CYW43 runner task, as header material.
 *
 * Both are items rather than statements — the task macro expands to a struct and a function — and neither
 * needs anything `setup()` created, so they belong in the header beside the imports. `pub` is written into
 * the macro invocation by hand: the bindings it declares have to be visible to `main.rs`, and a macro has no
 * way to be told that from the outside.
 */
function cyw43Support(board: RpBoardProfile, template: AppTemplate): string {
    const cyw = board.cyw43;
    const netTask =
        template === 'wifi' || template === 'wifi-bluetooth'
            ? `

/// Drives the network stack. It runs for the life of the program: no packet moves while it is not being
/// polled.
#[embassy_executor::task]
async fn net_task(mut runner: embassy_net::Runner<'static, cyw43::NetDriver<'static>>) -> ! {
    runner.run().await
}`
            : '';
    return `bind_interrupts!(pub struct Irqs {
    ${cyw?.pio}_IRQ_0 => InterruptHandler<${cyw?.pio}>;
    DMA_IRQ_0 => dma::InterruptHandler<${cyw?.dmaCh0}>;
});

/// Runs the firmware half of the CYW43 driver. Spawned by setup(), and it owns the runner for good.
#[embassy_executor::task]
async fn cyw43_task(
    runner: cyw43::Runner<'static, cyw43::SpiBus<Output<'static>, PioSpi<'static, ${cyw?.pio}, 0>>>,
) -> ! {
    runner.run().await
}${netTask}`;
}

/** The CYW43 control handle's type, named once so the `State` field can be written down. */
const CYW43_CONTROL_ALIAS = `/// The CYW43 control handle: how the sketch drives the radio and the on-board LED.
pub type Cyw43Control = cyw43::Control<'static>;`;

function mainRsWifi(board: RpBoardProfile, withBluetooth: boolean): string {
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

    return `
    //@header
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
    //@header-end

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
    //@loop
        control.gpio_set(${ledIndex}, true).await;
        Timer::after_millis(250).await;
        control.gpio_set(${ledIndex}, false).await;
        Timer::after_millis(250).await;
    //@end`;
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

/**
 * The file a project is born with, and the one the launch-configuration check offers to restore.
 * Exported so that "what a fresh project gets" has exactly one definition.
 */
export function launchJson(board: RpBoardProfile, binaryName: string): string {
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

function readme(
    board: RpBoardProfile,
    crateName: string,
    template: AppTemplate,
    panel?: RpPanelProject,
): string {
    const wireless = board.wireless === 'cyw43';
    const ledLine = wireless
        ? 'The on-board LED is connected to the CYW43 wireless chip, not to GPIO25.'
        : `The on-board LED is on \`${board.led.kind === 'gpio' ? board.led.pin : 'PIN_25'}\`.`;
    const panelSection = panel === undefined
        ? ''
        : `
## Panel wiring

${panelModuleOrDefault(panel.wiring.panel).label}, on the GPIOs below. The numbers live in
\`src/panel.rs\`, which the Designer rewrites: change them there from the Designer's **Hardware** panel
rather than by hand, or the next save will put them back.

| GPIO (module pin) | Signal |
|---|---|
${rpPinUsage(panel.wiring).map((line) => {
            const [pin, ...rest] = line.split(': ');
            return `| ${pin} | ${rest.join(': ')} |`;
        }).join('\n')}
${panel.template === 'designer'
            ? `
The design itself is \`designer/panel.ui.json\`; the markup it compiles to (\`src/ui.kdl\`) and the Rust
that drives it (\`src/ui.rs\`) are written by the Designer on every save. Put your own code in
\`src/ui_handlers.rs\`, where a stub is added for each event you ask the Designer for.
`
            : ''}
${panel.template === 'designer' && wireless
            ? `
A design with a clock starts from the time this project was built and is corrected over Wi-Fi when the
board is on a network. The **Time source** switch in the Designer chooses between that and a
battery-backed module (not supported yet).
`
            : ''}
${panel.sd
            ? `
The card socket is mounted at boot; a design reads \`sd:/NAME.BMP\` images from it. The **SD** switch in
the Designer's control bar turns the filesystem off without deleting \`src/sd.rs\`.
`
            : ''}
`;
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
${panelSection}${wifiNote}
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
