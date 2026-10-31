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

import { DEBUG_PROFILE, type AppTemplate, type AppTemplateInfo, type GeneratedFile } from './files';
import { crateNameFrom } from './naming';
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
import { DESIGNER_SD_PERIPHERAL, emitSdRs } from './esp-sd';
import { BoardChoices, displayFor, hasBacklight, touchFor } from '../boards/esp';
import { EspBoardProfile, EspDisplay, EspTouch } from '../boards/types';
import { LCD_ROTATION_LABELS, LcdRotation, asLcdRotation, templateUsesPanel } from '../display/rotation';
import { DEFAULT_BRIGHTNESS, clampBrightness } from '../display/backlight';
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
    /** The no-interrupt lock around the mounted card in the Designer template's `sd.rs`. */
    criticalSection: '1.2.0',
    embeddedGraphics: '0.8',
    /** The Bluetooth host stack on top of esp-radio's HCI controller (advertising + GATT). */
    troubleHost: '0.7.0',
    staticCell: '2.1.1',
    /**
     * The ESP32-S3's peripheral access crate, named directly by a Designer project only: the USB
     * controller's Start-of-Frame status is the one "is a host attached?" signal esp-hal does not
     * expose, and the register block lives here. Same line esp-hal 1.2.2 itself resolves to, so
     * there is only ever one of it in the tree.
     */
    esp32s3Pac: '0.36',
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
    /**
     * The UTC offset, in minutes, a Designer project's Wi-Fi time should be shown at.
     *
     * The time server answers in UTC and a no_std image has no timezone database, so the offset is a
     * build-time number written into `.cargo/esp-config.toml` (and editable there). Omitted means 0,
     * which is UTC -- the tests' stable default; the wizard passes the machine's own offset.
     */
    clockOffsetMinutes?: number;
    /**
     * The panel backlight's brightness, in percent, when the panel has a backlight pin.
     *
     * Written into `.cargo/esp-config.toml` and read at compile time, like the rotation -- the Designer's
     * Brightness slider is the thing that changes it later. Omitted means fully on.
     */
    brightness?: number;
}

/**
 * The templates a board's option in the New Project wizard offers, when that is narrower than what the
 * board can generate.
 *
 * The ESP32-035 is a design-first panel; asked for 2026-10-21, its board option offers the WYSIWYG designer
 * and nothing else, so a new project from that board is always the one the board is for. Asked for
 * 2026-10-23, the ESP32-DevKitC V4 offers only the WYSIWYG designer and the Bluetooth LE peripheral. The
 * other templates stay generatable: the panel diagnostic is still how a glass is brought up and what the
 * board is verified with, so it remains reachable from code and from the golden and board tests -- it is
 * simply not offered when the board is picked in the wizard.
 */
const OFFERED_TEMPLATES: Record<string, readonly AppTemplate[]> = {
    'sunton-3248s035r': ['designer'],
    'esp32-devkitc': ['designer', 'bluetooth'],
    'lilygo-tqt': ['designer', 'wifi', 'bluetooth'],
};

/**
 * The ids a board offers in the wizard, or `undefined` when it offers everything it can generate.
 *
 * Kept apart from [`templatesForEsp`] on purpose: "what can this board generate" and "what does the wizard
 * suggest for this board" are different questions, and only the second one was narrowed here.
 */
export function offeredTemplateIds(board: EspBoardProfile): readonly AppTemplate[] | undefined {
    return OFFERED_TEMPLATES[board.id];
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
    // A board with a panel was bought for its panel, so that is the interesting default -- unless the
    // board's option is narrowed to one template, which is then the only sensible default.
    const only = offeredTemplateIds(board);
    if (only !== undefined && only.length > 0) {
        return only[0] as AppTemplate;
    }
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
    // touch code to switch, and the firmware reads an absent key as "on". The controller may belong to the
    // board (the CYD's XPT2046) or to the display module plugged into it (a DevKitC's ILI9341), which is why
    // the answer is taken from the panel that was chosen.
    const touchSetting =
        template === 'designer' && touchFor(board, panel) !== undefined ? (options.touch ?? true) : undefined;
    // The backlight is a wire on the panel, not a promise of the board: a module that leaves BL unconnected
    // gets no key, and a template that never brings the panel up (blinky, wifi, ...) has nothing to dim.
    const brightness = usesPanel && hasBacklight(panel)
        ? clampBrightness(options.brightness ?? DEFAULT_BRIGHTNESS)
        : undefined;

    const files: GeneratedFile[] = [
        { path: 'Cargo.toml', content: espCargoToml(board, crateName, template, choices) },
        { path: '.cargo/config.toml', content: espCargoConfigToml(board, template) },
        { path: '.cargo/esp-config.toml', content: espConfigToml(rotation, usesPanel, touchSetting, template === 'designer' ? options.clockOffsetMinutes ?? 0 : undefined, brightness) },
        { path: 'rust-toolchain.toml', content: espRustToolchainToml() },
        { path: 'build.rs', content: espBuildRs() },
        ...espMainFiles(board, template, choices),
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
            { path: DESIGNER_FILES.rust, content: emitUiRs(starter, touchFor(board, panel) !== undefined) },
            { path: DESIGNER_FILES.handlers, content: emitHandlersRs(starter, touchFor(board, panel) !== undefined) },
            { path: DESIGNER_FILES.document, content: `${JSON.stringify(starter, null, 2)}\n` },
            // The manifest that anchors asset paths to the project root -- without it the crate resolves
            // them from src/, which is where the screen file lives.
            { path: DESIGNER_FILES.manifest, content: emitProjectKdl(starter) },
        );
    }
    if (template === 'designer' && board.sd !== undefined) {
        // The card reader a design's `sd:` image controls call. Generated with the board's socket pins, and
        // only where the catalog declares a card: a board without one gets no module, no dependency and no
        // call in `main`, so nothing about its project changes.
        files.push({ path: 'src/sd.rs', content: emitSdRs(board) });
    }
    if (template === 'designer') {
        // The clock's second source: Wi-Fi and SNTP, for a board with no PC on the cable. Net-free
        // at runtime unless the design has a clock and the RTC has never been set (see main.rs).
        files.push({ path: 'src/net.rs', content: emitNetRs() });
    }
    return files;
}

// ---------------------------------------------------------------------- Cargo

/**
 * The `[features]` block of a Designer Cargo.toml, or `''` when the project carries none.
 *
 * The block exists in two cases: a board whose catalog entry offers more than one display module (the LilyGo
 * T-QT exposes both a GC9107 and a GC9A01, and a DevKitC takes an ST7789 or an ILI9341 module), and a Designer
 * project that can switch its SD card off. The panel features are also what tells the Designer which module a
 * project was made for -- its size and whether it brings a touch controller -- so they are written for every
 * choice, not only the chosen one. The card is gated behind cargo's `sd` feature -- optional `embedded-sdmmc`
 * and `critical-section` dependencies plus a `#[cfg(feature = "sd")]` on `mod sd;` and the `sd::init` call --
 * so that *enabling* the card adds the FAT filesystem to the build and *disabling* it drops the crate again.
 * `default` starts out carrying `"sd"` on a board that has a socket, which is every Designer project as it is
 * generated; the Designer toolbar is what flips it later. Keeping the feature in `default` is what lets the
 * setting be changed without regenerating `src/main.rs`, in the same way the panel-revision switch already does.
 */
function espFeaturesSection(panelChoice: string | undefined, sdFeature: boolean, board?: EspBoardProfile): string {
    if (panelChoice === undefined && !sdFeature) {
        return '';
    }
    const defaultItems: string[] = [];
    if (panelChoice !== undefined) {
        defaultItems.push(`"panel-${panelChoice}"`);
    }
    if (sdFeature) {
        defaultItems.push('"sd"');
    }
    const lines: string[] = [''];
    lines.push('[features]');
    if (panelChoice !== undefined) {
        lines.push('# The display this project was made for. A board like the DevKitC takes any module plugged into');
        lines.push('# it, so the choice is recorded here; flip it and rebuild to use another. It also tells the');
        lines.push('# Designer which panel -- and therefore which size and touch controller -- the project has.');
    }
    lines.push(`default = [${defaultItems.join(', ')}]`);
    if (panelChoice !== undefined) {
        const choices = board?.options.find((option) => option.id === 'panel')?.choices ?? [];
        const ids = choices.length > 0 ? choices.map((choice) => choice.id) : [panelChoice];
        for (const id of ids) {
            lines.push(`panel-${id} = []`);
        }
    }
    if (sdFeature) {
        lines.push(
            '',
            '# A TF-card socket is wired to this board. The `sd` feature pulls in the FAT filesystem',
            '# (embedded-sdmmc) and the critical-section mutex it is kept behind, and gates the `sd::init`',
            '# call in main.rs. It is on by default; switch it off in the Designer toolbar to drop the',
            '# card and its filesystem from the build. It is a cargo feature rather than a config key so',
            '# that enabling it is what adds the filesystem, not merely what reads a flag.',
            'sd = ["dep:embedded-sdmmc", "dep:critical-section"]',
        );
    }
    return `${lines.join('\n')}\n`;
}

function espCargoToml(
    board: EspBoardProfile,
    crateName: string,
    template: AppTemplate,
    choices: BoardChoices,
): string {
    // The touch template drives the same panel, so everything the panel needs is needed there too.
    const display = templateUsesPanel(template) ? displayFor(board, choices) : undefined;
    const panelChoice = display?.panelChoice;
    const sdFeature = template === 'designer' && board.sd !== undefined;
    const features = espFeaturesSection(panelChoice, sdFeature, board);
    const espRtosFeatures = ['embassy', board.espChip];

    // The radio templates: Wi-Fi on `wifi`, the Bluetooth LE controller on `bluetooth`. A Designer
    // project needs Wi-Fi too -- it is where the time comes from when no host is on the cable.
    const radio = template === 'wifi' || template === 'bluetooth' || template === 'designer';

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
            // The panel's batching buffer is borrowed by the interface, and the interface is part of the
            // `State` that `setup()` hands back -- so the buffer has to outlive `setup()` and lives in a
            // `StaticCell` (2026-10-16, the Arduino-style split: see generate/sketch.ts).
            `static_cell = "${ESP_CRATE_VERSIONS.staticCell}"`,
        );
    }
    if (template === 'sdcard') {
        // The board template already declares this for its panel; declaring it twice is a duplicate key.
        dependencies.push(`embedded-hal-bus = "${ESP_CRATE_VERSIONS.embeddedHalBus}"`);
    }
    const designerSd = template === 'designer' && board.sd !== undefined;
    if (template === 'sdcard' || template === 'board' || designerSd) {
        // The correct way to talk to a card: the ecosystem's own SD/SPI plus FAT implementation rather than
        // a hand-rolled CMD0/CMD8/ACMD41 sequence. It is the maintained crate that filesystems are tested
        // against, and getting the SD init handshake subtly wrong is a classic way to lose a day.
        //
        // A Designer project keeps it behind the `sd` cargo feature (see `espFeaturesSection`) so the toolbar
        // can turn the card off and the crate never reaches the build; the `sdcard` and `board` templates are
        // the whole point of the card, so theirs stay mandatory and feature-free. `optional` is what lets
        // `dep:embedded-sdmmc` in the feature switch the crate in and out without a second version line.
        dependencies.push(
            designerSd
                ? `embedded-sdmmc = { version = "${ESP_CRATE_VERSIONS.embeddedSdmmc}", optional = true }`
                : `embedded-sdmmc = "${ESP_CRATE_VERSIONS.embeddedSdmmc}"`,
        );
    }
    if (designerSd) {
        // The mounted card has to survive between calls, so it lives in a critical-section Mutex. The crate
        // itself is already in the tree (esp-hal implements it), but a transitive dependency is not nameable,
        // so it is declared here too -- the same version line, so there is only ever one of it. Optional,
        // because a Designer project built without the `sd` feature names neither the Mutex nor the card.
        dependencies.push(`critical-section = { version = "${ESP_CRATE_VERSIONS.criticalSection}", optional = true }`);
    }
    if (template === 'touch' || template === 'board' || (template === 'designer' && touchFor(board, display) !== undefined)) {
        // The calibration is kept in flash, so the project needs the NOR-flash crate. Its chip feature is
        // what selects the flash driver, and it pulls the ROM glue that is already in the tree.
        dependencies.push(`esp-storage = { version = "${ESP_CRATE_VERSIONS.espStorage}", features = ["${board.espChip}"] }`);
    }
    if (template === 'designer') {
        // The chip's own PAC, on the one board whose USB socket is wired to it: the connection to
        // the host is the USB-Serial-JTAG controller's Start-of-Frame status, and esp-hal does not
        // expose it. Declared for the T-QT only, so the CYD's manifest is unchanged.
        if (board.espChip === 'esp32s3') {
            dependencies.push(`esp32s3 = "${ESP_CRATE_VERSIONS.esp32s3Pac}"`);
        }
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
    if (template === 'touch' || template === 'board' || (template === 'designer' && touchFor(board, display) !== undefined)) {
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
            template === 'bluetooth' ? '"ble"' : '"wifi"',
            '"log-04"',
            '"unstable"',
        ];
        dependencies.push(
            `esp-radio = { version = "${ESP_CRATE_VERSIONS.espRadio}", features = [${radioFeatures.join(', ')}] }`,
            `esp-alloc = { version = "${ESP_CRATE_VERSIONS.espAlloc}", features = ["${board.espChip}"] }`,
        );
        if (template === 'wifi' || template === 'designer') {
            // The addressing lives here, not in the radio driver: DHCP, a fixed address, and the stack that
            // makes the interface usable at all. A Designer project needs DNS and UDP for its time
            // request and nothing else, so it does not carry the TCP socket layer.
            dependencies.push(
                template === 'designer'
                    ? `embassy-net = { version = "${ESP_CRATE_VERSIONS.embassyNet}", features = ["dhcpv4", "medium-ethernet", "dns", "udp"] }`
                    : `embassy-net = { version = "${ESP_CRATE_VERSIONS.embassyNet}", features = ["dhcpv4", "medium-ethernet", "tcp", "dns"] }`,
                // static_cell is already declared by the display block for a Designer project.
                ...(template === 'designer' ? [] : [`static_cell = "${ESP_CRATE_VERSIONS.staticCell}"`]),
            );
        }
        if (template === 'designer') {
            // The NTP answer reaches the loop through an embassy Signal; the version is the one
            // embassy-net 0.9.1 itself resolves to, so there is only ever one of it in the tree.
            dependencies.push('embassy-sync = "0.8.0"');
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
# Vendored alongside every Designer project (see crates/ in this extension): the shapes widget crate, the
# codegen fork that emits add_custom_widget calls for shapes instead of add_panel/add_spacer stubs, and the
# runtime fork that lets a design name values its renderers used to hard-code (a checkbox's box size, a gauge's
# tick and needle colours). Patched together because the fork's builders are what the fork's emitter calls.
[patch.crates-io]
embedded-gui-codegen = { path = "codegen/embedded-gui-codegen" }
embedded-gui = { path = "codegen/embedded-gui" }
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
${vendored}${DEBUG_PROFILE}
[profile.release]
opt-level = "s"
lto = true
debug = true
`;
}

function espCargoConfigToml(board: EspBoardProfile, template: AppTemplate): string {
    // Both radio templates allocate: the Wi-Fi and Bluetooth stacks are not static-buffer-only, so the
    // generated manifest rebuilds core *and* alloc from source (the espup toolchain ships rust-src for this).
    // A Designer project carries Wi-Fi for its clock, so it allocates too.
    const needsAlloc = template === 'wifi' || template === 'bluetooth' || template === 'designer';
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

function espConfigToml(rotation: LcdRotation, usesPanel: boolean, touch?: boolean, clockOffsetMinutes?: number, brightness?: number): string {
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
    // The time server answers in UTC; the glass should show local time. This is the offset the build
    // was given (the machine's own when the project was made), and it is a plain edit here -- there is
    // no timezone database in a no_std image, and DST is not followed automatically.
    const clockEntry =
        clockOffsetMinutes === undefined
            ? ''
            : `
# Your UTC offset in minutes, read at compile time by src/net.rs: 120 is UTC+2, -300 is UTC-5.
# The Wi-Fi time server answers in UTC; this is what turns it into the time on the glass. Add an
# hour here when the clocks go forward, and take it back when they go back.
TZ_OFFSET_MINUTES = "${clockOffsetMinutes}"
`;
    // The backlight is dimmed by PWM on its BL pin. The number is the brightness a person sees -- the
    // firmware inverts it for a panel whose transistor switches on with a low level, so 30 always means
    // 30 % of the light and never a duty cycle.
    const backlightEntry =
        brightness === undefined
            ? ''
            : `
# The panel backlight's brightness in percent, read at compile time by src/main.rs. 100 is fully on,
# 0 is off. The Designer's Brightness slider writes this line; editing it here works just as well, and
# neither ever touches src/main.rs.
BACKLIGHT_BRIGHTNESS = "${brightness}"
`;
    return `# Runtime configuration for the ESP logging stack.
[env]
# log level for esp-println, read by esp_println::logger::init_logger_from_env() in main;
# change to "debug" or "trace" when something is silent.
ESP_LOG = "info"
${rotationEntry}${touchEntry}${clockEntry}${backlightEntry}`;
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

/**
 * The common prologue: HAL init, the esp-rtos scheduler, and a boot marker.
 *
 * Single core, deliberately and for now: `esp_rtos::start` pins the scheduler and this context to the first
 * core, and the second one is started only by an explicit `esp_rtos::start_second_core`. Using it is deferred
 * work with a plan -- moving the *touch sampling* there is what it is for, since a long draw blocks the finger
 * while the card and panel buses (which a second core cannot split) are what makes a draw slow. See
 * `plans/touch-on-core1.md` for the API, the bus-sharing constraint and how to verify it.
 */
function espBootBlock(board: EspBoardProfile, template: AppTemplate): string {
    // The radio stacks allocate at runtime, and esp-radio's own quick start installs the heap between
    // `esp_hal::init` and the scheduler start. The order is not cosmetic: the first block is memory the
    // bootloader has finished with (`reclaimed`), so it can only be taken once the HAL has initialised,
    // and the radio cannot be created until both are in place.
    // The sizes are the ones esp-radio's own examples use, per stack rather than one number for both:
    // Wi-Fi takes two blocks (the first is memory the second-stage bootloader is finished with, the second
    // is reserved from SRAM), Bluetooth takes one. On the classic ESP32 the heap lands in .bss, so it is
    // counted against the 128 KiB the DRAM linker segment allows -- the two figures are not interchangeable.
    const heap = template === 'wifi' || template === 'designer'
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

/**
 * The LEDC imports a panel with a backlight pin needs -- and nothing at all for a panel without one.
 *
 * An unused import is a warning in a generated project, so the lines are added where the hardware is: the
 * backlight is the only thing the sketch PWMs, and a module that leaves BL unconnected has no channel.
 */
function backlightImports(display: EspDisplay | undefined): string[] {
    if (!hasBacklight(display)) {
        return [];
    }
    return [
        'use esp_hal::gpio::DriveMode;',
        'use esp_hal::ledc::channel::{self, Channel, ChannelIFace};',
        'use esp_hal::ledc::timer::{self, TimerIFace};',
        'use esp_hal::ledc::{Ledc, LSGlobalClkSource, LowSpeed};',
    ];
}

/**
 * The mipidsi options a panel needs, named in one import line.
 *
 * `ColorInversion` appears only for a glass that draws inverted: an unused import is a warning in every
 * project the extension generates, and those are the ones a new user reads first.
 */
function mipidsiOptionImports(display: EspDisplay | undefined): string {
    return display?.invertColors === true
        ? 'use mipidsi::options::{ColorInversion, ColorOrder, Orientation, Rotation};'
        : 'use mipidsi::options::{ColorOrder, Orientation, Rotation};';
}

function espImports(board: EspBoardProfile, template: AppTemplate, display: EspDisplay | undefined): string {
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
            'use esp_hal::analog::adc::{Adc, AdcConfig, AdcPin, Attenuation};',
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
    if (template === 'touch' || template === 'board' || (template === 'designer' && touchFor(board, display) !== undefined)) {
        // Only the board template drives the LDR and the speaker, and an unused import is a warning, so the
        // analog imports are added where the hardware actually is.
        // The paint timing below is Designer-only, and an unused import is a warning in a generated project.
        const clockImports = template === 'designer' ? ['use embassy_time::Instant;'] : [];
        // The console's receiver: the toolchain hands the board the PC's local time over it once
        // the firmware is running, which is what a design's clock follows. A Designer project also
        // keeps that time in the chip's RTC, so it names the driver for it here.
        const consoleImports = template === 'designer'
            ? ['use esp_hal::rtc_cntl::Rtc;', 'use esp_hal::uart::{Config as UartConfig, Uart};']
            : ['use esp_hal::uart::{Config as UartConfig, Uart};'];
        const hardwareImports = template === 'board'
            ? [
                'use esp_hal::analog::adc::{Adc, AdcConfig, AdcPin, Attenuation};',
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
            ...clockImports,
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
            // The radio's heap lives in a reclaimed RAM region, named by this attribute macro -- and only a
            // Designer project has a heap (its clock task). The named templates would warn about it.
            ...(template === 'designer' ? ['use esp_hal::ram;'] : []),
            // `Input`/`Pull` are the touch controller's PENIRQ line: low means pressed.
            'use esp_hal::gpio::{Input, InputConfig, Level, Output, OutputConfig, Pull};',
            ...backlightImports(display),
            // Flash access, for keeping the calibration across a power cycle.
            'use esp_storage::FlashStorage;',
            ...hardwareImports,
            ...consoleImports,
            'use esp_hal::spi::master::{Config as SpiConfig, Spi};',
            'use esp_hal::time::Rate;',
            'use esp_hal::timer::timg::TimerGroup;',
            'use esp_println as _;',
            mipidsiOptionImports(display),
            'use mipidsi::{models, Builder};',
            'use mipidsi::interface::SpiInterface as SPIInterface;',
        ].join('\n');
    }
    if (template === 'designer' && touchFor(board, display) === undefined) {
        // The panel bring-up imports without the diagnostic screen's drawing primitives and fonts. This
        // template paints a design through the GUI, so keeping them produced eight unused-import warnings in
        // every Designer project on a board with no touch controller (the T-QT).
        return [
            'use embassy_executor::Spawner;',
            'use embassy_time::{Duration, Instant, Timer};',
            'use embedded_graphics::pixelcolor::Rgb565;',
            // A glob, so it costs nothing when unused: `display.clear` comes from this prelude.
            'use embedded_graphics::prelude::*;',
            'use embedded_hal_bus::spi::ExclusiveDevice;',
            'use esp_hal::clock::CpuClock;',
            'use esp_hal::delay::Delay;',
            'use esp_hal::gpio::{Level, Output, OutputConfig};',
            ...backlightImports(display),
            // The heap's reclaimed region is declared with this attribute macro, and an attribute
            // macro has to be in scope to be named: #[ram(reclaimed)] alone is unresolved.
            'use esp_hal::ram;',
            // The chip's RTC keeps the design's time across a reset; the USB-Serial-JTAG controller
            // is this board's console, because its socket is wired to the chip and not to a bridge.
            'use esp_hal::rtc_cntl::Rtc;',
            'use esp_hal::spi::master::{Config as SpiConfig, Spi};',
            'use esp_hal::time::Rate;',
            'use esp_hal::timer::timg::TimerGroup;',
            ...(board.espChip === 'esp32s3'
                ? ['use esp_hal::usb::usb_serial_jtag::UsbSerialJtag;']
                : ['use esp_hal::uart::{Config as UartConfig, Uart};']),
            'use esp_println as _;',
            mipidsiOptionImports(display),
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
            ...backlightImports(display),
            'use esp_hal::spi::master::{Config as SpiConfig, Spi};',
            'use esp_hal::time::Rate;',
            'use esp_hal::timer::timg::TimerGroup;',
            'use esp_println as _;',
            mipidsiOptionImports(display),
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
        // `Duration` is only named by the bodies that spell a delay out; a blink that uses `after_millis`
        // would otherwise carry an unused import into a project the user has just created.
        board.led.kind === 'rgb'
            ? 'use embassy_time::{Duration, Timer};'
            : 'use embassy_time::Timer;',
        'use esp_hal::clock::CpuClock;',
        'use esp_hal::timer::timg::TimerGroup;',
        'use esp_println as _;',
    ];
    if (board.led.kind === 'gpio' || board.led.kind === 'rgb') {
        lines.push('use esp_hal::gpio::{Level, Output, OutputConfig};');
    }
    return lines.join('\n');
}

/** The two files a template's sketch is written to. */
function espMainFiles(board: EspBoardProfile, template: AppTemplate, choices: BoardChoices): GeneratedFile[] {
    const sketch = espSketch(board, template, choices);
    return [
        { path: 'src/main.rs', content: sketch.main },
        { path: SKETCH_HEADER_PATH, content: sketch.header },
    ];
}

/**
 * One template's sketch, as `src/main.rs` and `src/MainHeader.rs`.
 *
 * The bodies below are the Rust they always were — the same statements in the same order — split into the three
 * pieces the sketch layout needs (`see generate/sketch.ts`):
 *
 * - the regions a body marked `//@header` are lifted into the header, dedented and made public;
 * - everything above its `//@loop` marker becomes `setup()`'s body, and the fields it leaves behind are the
 *   `State` struct `setup()` hands back;
 * - the loop itself becomes the body of `main()`'s loop, with every mention of one of those fields rewritten to
 *   `state.<field>`.
 *
 * So a template's own function still reads as one piece of Rust while the generator, not a person, does the
 * mechanical half of turning it into a sketch.
 */
function espSketch(board: EspBoardProfile, template: AppTemplate, choices: BoardChoices): SketchFiles {
    const usesPanel = templateUsesPanel(template);
    const display = usesPanel ? displayFor(board, choices) : undefined;
    // The controller can be the board's own (the CYD) or the display module's (a DevKitC panel with an
    // XPT2046 on it), so it is asked of the panel that was chosen rather than of the board alone.
    const touch =
        template === 'touch' || template === 'board' || template === 'designer'
            ? touchFor(board, display)
            : undefined;
    const led = board.led;
    const withHardware = template === 'board';

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
                            ? espDesignerDisplayBody(display, board)
                            : display !== undefined && touch !== undefined
                                ? espTouchBody(display, board, touch, withHardware)
                                : display !== undefined
                                    ? espDisplayBody(display)
                                    : led.kind === 'gpio'
                                        ? espLedBody(led.pin, led.external === true)
                                        : led.kind === 'rgb'
                                            ? espRgbLedBody(led.red, led.green, led.blue)
                                            : espHeartbeatBody();

    const fields = espStateFields(board, template, display, touch);
    const stretched = stretch(body, fields);
    const support =
        template === 'bluetooth'
            ? publicHeaderItems(espBluetoothSupport()) + `\n\n${ESP_BT_CONTROLLER_ALIAS}`
            : template === 'wifi'
                ? publicHeaderItems(espWifiSupport())
                : template === 'display' && display !== undefined
                    ? publicHeaderItems(espPanelSupport(display, board))
                    : '';
    const material = [
        display === undefined ? '' : espPanelMaterial(display, touch),
        support,
        stretched.material,
        // A Designer project keeps the time in the chip's RTC, so it carries the helpers that read
        // and write it, the line parser, and -- on a board whose USB is the chip's own -- the
        // connection check. Other templates have no design to draw a clock in.
        template === 'designer' ? espClockMaterial(board) : '',
        headerGuidance(),
    ].filter((text) => text !== '').join('\n\n');

    return sketchFiles({
        banner: espMainHeader(board, template).trimEnd(),
        imports: espImportList(board, template, display),
        sideEffects: [],
        modules: espModules(board, template, touch),
        prologue: `#![no_std]
#![no_main]

// The ESP-IDF bootloader expects an application descriptor in the image. Without it the
// bootloader refuses to start the image, so this line is not decoration.
esp_bootloader_esp_idf::esp_app_desc!();`,
        statics: [display === undefined ? '' : espPanelStatics(touch !== undefined, hasBacklight(display))]
            .filter((text) => text !== '')
            .join('\n\n'),
        state: stateStruct(espStateDoc(template), fields),
        setup: setupFn({
            doc: espSetupDoc(template),
            params: template === 'wifi' || template === 'designer' ? 'spawner: Spawner' : '',
            body: `${espBootBlock(board, template)}${espDesignerSdInit(board, template)}${stretched.init}`,
            fields,
        }),
        main: mainFn({
            doc: espMainDoc(),
            attribute: '#[esp_rtos::main]',
            signature: `async fn main(${template === 'wifi' || template === 'designer' ? 'spawner' : '_spawner'}: Spawner)`,
            setupCall: template === 'wifi' || template === 'designer' ? 'setup(spawner).await' : 'setup().await',
            prelude: template === 'bluetooth' ? espBluetoothHandover() : '',
            loop: stretched.loop,
            // The no-touch designer loop asks the design whether it is dirty on every pass, so it
            // names `state` and mutates it. It used to paint once and sleep for ten seconds, and
            // its loop never touched the state at all -- which is why a clock on a panel without a
            // touchscreen never moved.
            mutable: !(template === 'sdcard' || template === 'bluetooth'),
        }),
        footer: codeGuidance(
            exampleFunction(fields, board.led.kind === 'cyw43' ? board.led.index : 0),
        ),
        material,
    });
}

/** The Bluetooth controller's concrete type, named once so the `State` field can be written down. */
const ESP_BT_CONTROLLER_ALIAS = `/// The controller as the host stack wants it: esp-radio's connector, wrapped to prove to the stack that
/// the radio is ours alone.
pub type BtController = ExternalController<BleConnector<'static>, 1>;`;

/**
 * The imports the header carries: the template's own list, plus what only `main.rs` may keep.
 *
 * A `use … as _;` names nothing — it installs a logger, or a panic handler, or a `write!` implementation —
 * and that only happens in the file it is compiled in, so the two side-effect imports stay in the crate root
 * and are not re-exported. Duplicates are dropped: the template lists already carry `esp_println`.
 */
function espImportList(board: EspBoardProfile, template: AppTemplate, display: EspDisplay | undefined): string[] {
    const lines = [...espImports(board, template, display).split('\n'), 'use esp_println as _;', 'use esp_backtrace as _;']
        .map((line) => line.trim())
        .filter((line) => line !== '');
    return [...new Set(lines)];
}

/** The panel's own types and clock functions, as header material. */
function espPanelMaterial(display: EspDisplay, touch: EspTouch | undefined): string {
    const shared = touch !== undefined;
    const reset = display.rst === undefined ? 'mipidsi::NoResetPin' : "Output<'static>";
    const device = shared
        ? "RefCellDevice<'static, HalSpi, Output<'static>, Delay>"
        : 'ExclusiveDevice<HalSpi, Output<\'static>, Delay>';
    const references = [
        `/// The panel's driver type. The buffer it batches pixels in is a static, which is why this is a type
/// alias worth having: the whole chain is long enough to hide what it is for.
pub type DisplayDriver = mipidsi::Display<PanelInterface, models::${display.controller}, ${reset}>;`,
    ];
    const aliases = [
        `/// The SPI bus' concrete type: \`Spi<'static, Blocking>\`, from the peripherals \`esp_hal::init\` hands
/// out as 'static values.
pub type HalSpi = Spi<'static, esp_hal::Blocking>;`,
        shared
            ? `/// The panel and the touch controller share one bus, so the bus lives in a \`RefCell\` and each chip
/// gets its own device with its own chip select.
pub type HalBus = RefCell<HalSpi>;

/// One chip's device on that shared bus: the bus, its chip select, and a delay.
pub type BusDevice = ${device};`
            : `/// The panel's device: the bus, its chip select and a delay. Nothing else is on this bus, so it can
/// own the bus outright.
pub type PanelDevice = ${device};`,
        `/// The panel's SPI interface: its device, the data/command pin and the batching buffer.
pub type PanelInterface = SPIInterface<'static, ${shared ? 'BusDevice' : 'PanelDevice'}, Output<'static>>;`,
    ];
    const clocks = [
        `/// The panel's clock. A function rather than a constant because the touch controller on the same bus
/// needs a slower one, and the bus is re-configured around each of its bursts.
pub fn panel_clock() -> SpiConfig {
    SpiConfig::default().with_frequency(Rate::from_khz(${Math.round(display.spiHz / 1000)}))
}`,
        shared
            ? `/// The touch controller's clock: an XPT2046 is a slow part, and its chip select is asserted across
/// the whole transaction.
pub fn touch_clock() -> SpiConfig {
    SpiConfig::default().with_frequency(Rate::from_khz(${Math.round((touch as EspTouch).spiHz / 1000)}))
}`
            : '',
    ].filter((text) => text !== '');
    return [...aliases, ...references, ...clocks, ...backlightMaterial(display)].join('\n\n');
}

/**
 * The backlight's PWM plumbing, as header material: the channel's name and the brightness constants.
 *
 * The brightness is read at *compile* time from `BACKLIGHT_BRIGHTNESS` in `.cargo/esp-config.toml`, the same
 * way the rotation is, so changing the Designer's slider never rewrites `src/main.rs`. The number in that
 * file is the brightness a person sees; the duty the pin needs is the complement for a panel whose
 * transistor switches on with a LOW level, and that inversion happens here rather than in the file.
 */
function backlightMaterial(display: EspDisplay): string[] {
    if (!hasBacklight(display)) {
        return [];
    }
    const activeLow = display.backlightActiveLow === true;
    return [
        `/// The backlight's PWM channel: the LEDC channel that dims the panel by switching its transistor.
pub type Backlight = Channel<'static, LowSpeed>;`,
        `/// The brightness setting, as a percentage: 0-100 from \`.cargo/esp-config.toml\`, read at compile time.
/// Anything that is not a number in range -- an empty value, a typo, a hand-edited line -- is 100, so a
/// mistake can never leave the panel dark.
pub const BACKLIGHT_PERCENT: u8 = match option_env!("BACKLIGHT_BRIGHTNESS") {
    Some(text) => percent_from_env(text),
    None => 100,
};

const fn percent_from_env(text: &str) -> u8 {
    let bytes = text.as_bytes();
    if bytes.len() == 0 {
        return 100;
    }
    let mut value: u32 = 0;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte < b'0' || byte > b'9' {
            return 100;
        }
        value = value * 10 + (byte - b'0') as u32;
        index += 1;
    }
    if value > 100 { 100 } else { value as u8 }
}

/// The duty the pin runs at, in percent of its *high* time. ${activeLow
            ? 'This board switches the backlight transistor on with a LOW level, so the duty is the complement of\n/// the brightness: 100 % brightness is a pin held low.'
            : 'This board switches the backlight transistor on with a HIGH level, so the duty is the\n/// brightness itself.'}
pub const BACKLIGHT_DUTY_PCT: u8 = ${activeLow ? '100 - BACKLIGHT_PERCENT' : 'BACKLIGHT_PERCENT'};`,
    ];
}

/** The statics the panel's storage lives in, which is what lets it outlive `setup()`. */
function espPanelStatics(shared: boolean, backlight: boolean): string {
    const bus = shared
        ? `/// The shared SPI bus. A static rather than a local because the panel's device borrows it and the
/// panel travels back to main() in the sketch's State.
static BUS_CELL: static_cell::StaticCell<HalBus> = static_cell::StaticCell::new();`
        : '';
    const buffer = `/// The batching buffer mipidsi's interface borrows, for the same reason: the interface is part of the
/// State, so the buffer has to outlive setup().
static BUFFER_CELL: static_cell::StaticCell<[u8; 512]> = static_cell::StaticCell::new();`;
    // The channel borrows the peripheral *and* the timer, and it travels back to main() in the State -- so
    // both have to be 'static. A local timer would be dropped at the end of setup(), and the channel's
    // stored reference would outlive it.
    const pwm = backlight
        ? `/// The LEDC peripheral, a static for the same reason the timer is: the backlight channel borrows both.
static LEDC_CELL: static_cell::StaticCell<Ledc<'static>> = static_cell::StaticCell::new();

/// The backlight's PWM timer. The channel keeps a reference to it once configured, so it may not be a local.
static BACKLIGHT_TIMER_CELL: static_cell::StaticCell<timer::Timer<'static, LowSpeed>> =
    static_cell::StaticCell::new();`
        : '';
    return [bus, buffer, pwm].filter((text) => text !== '').join('\n\n');
}

/** One phrase per template, used to say what the sketch is for in the generated docs. */
const ESP_SKETCH_SUBJECT: Record<AppTemplate, string> = {
    blinky: 'the on-board LED',
    wifi: 'the Wi-Fi station and the network stack',
    bluetooth: 'the Bluetooth LE peripheral',
    'wifi-bluetooth': 'the radio skeleton',
    display: 'the panel',
    touch: 'the panel and its touch controller',
    peripherals: 'the sensors and the speaker',
    board: 'everything this board carries',
    designer: 'the design and the panel it is drawn on',
    sdcard: 'the card in the TF socket',
};

/** What `State` is, for the struct's own comment. */
function espStateDoc(template: AppTemplate): string {
    return `Every value this sketch keeps: ${ESP_SKETCH_SUBJECT[template]}, created once by setup() and used by
the loop in main().
`;
}

/** What `setup()` is for, for its comment. */
function espSetupDoc(template: AppTemplate): string {
    return `One-time initialisation -- the Arduino setup().

Brings up ${ESP_SKETCH_SUBJECT[template]} and hands it back as a State for main() to run. Everything that
must happen once, and only once, belongs here.
`;
}

/** What `main()` is for, for its comment. */
function espMainDoc(): string {
    return `The sketch's entry point -- the Arduino main() around setup() and the loop.

setup() runs once, then the implementation below repeats for as long as the board is powered. This is the
function to edit: everything it needs from setup() is in state.
`;
}

/**
 * The clock's durable half: a time kept in the chip's RTC, the line a host sends, and -- on the
 * ESP32-S3 -- the USB controller's own answer to "is a PC on the cable?".
 *
 * An ESP's RTC counts across an ordinary reset (a flash, a panic, the reset button) and only loses its
 * offset when the power goes. That makes it the right place for a design's clock: without it, every
 * flash made the hands jump back to the time the design was drawn with. What the RTC cannot do is learn
 * the time -- only a PC knows what a PC's clock says -- so the firmware asks, once a second, until a
 * host answers with the same `TIME HH:MM:SS` line a flash writes.
 */
function espClockMaterial(board: EspBoardProfile): string {
    const usbHost = board.espChip === 'esp32s3'
        ? `
/// Whether a USB host is attached, asked of the chip's own USB-Serial-JTAG controller.
///
/// The controller reports a Start-of-Frame packet every millisecond while a host is on the cable and
/// nothing at all when it is not, so its raw interrupt register is the connection check the hardware
/// offers. The T-QT's USB socket is wired to the chip directly, which is why this board can see the
/// cable and the CYD -- whose socket goes through a CH340 bridge -- cannot.
pub fn usb_host_attached() -> bool {
    // SAFETY: reading INT_RAW is read-only status, and clearing the one SOF bit with a
    // write-one-to-clear is the documented way to consume it. Nothing else in this firmware touches
    // the JTAG side of the controller.
    let usb = unsafe { &*esp32s3::USB_DEVICE::ptr() };
    if usb.int_raw().read().sof().bit_is_set() {
        // The PAC types the clear field as write-one-to-clear, whose writer spells the write
        // bit(true) rather than set_bit().
        usb.int_clr().write(|w| w.sof().bit(true));
        true
    } else {
        false
    }
}
`
        : '';
    return `
/// The line a host sends: TIME HH:MM:SS, local time, no date and no zone. Anything else on the
/// console is ignored rather than half-parsed: a line the user typed must not set the clock.
pub fn parse_clock_time(line: &[u8]) -> Option<(u8, u8, u8)> {
    let text = core::str::from_utf8(line).ok()?;
    let mut words = text.split_whitespace();
    if !words.next()?.eq_ignore_ascii_case("TIME") {
        return None;
    }
    let mut fields = words.next()?.split(':');
    let hour: u8 = fields.next()?.parse().ok()?;
    let minute: u8 = fields.next()?.parse().ok()?;
    let second: u8 = fields.next()?.parse().ok()?;
    if fields.next().is_some() || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    Some((hour, minute, second))
}

/// The dated line a host sends instead: TIME YYYY-MM-DD HH:MM:SS.
///
/// A bare TIME HH:MM:SS can only set the hands, so a board with no network kept counting from the
/// RTC's 2000 base and lost the calendar day. The extension writes this line first and the bare one
/// after it, which is also what keeps a project generated before the date existed working: its
/// parser wants HH:MM:SS as the second word and ignores this line.
pub fn parse_clock_datetime(line: &[u8]) -> Option<(u16, u8, u8, u8, u8, u8)> {
    let text = core::str::from_utf8(line).ok()?;
    let mut words = text.split_whitespace();
    if !words.next()?.eq_ignore_ascii_case("TIME") {
        return None;
    }
    let mut date = words.next()?.split('-');
    let year: u16 = date.next()?.parse().ok()?;
    let month: u8 = date.next()?.parse().ok()?;
    let day: u8 = date.next()?.parse().ok()?;
    if date.next().is_some() || year < 2000 || month < 1 || month > 12 || day < 1 || day > 31 {
        return None;
    }
    let mut fields = words.next()?.split(':');
    let hour: u8 = fields.next()?.parse().ok()?;
    let minute: u8 = fields.next()?.parse().ok()?;
    let second: u8 = fields.next()?.parse().ok()?;
    if fields.next().is_some() || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    Some((year, month, day, hour, minute, second))
}

/// The RTC counts from the last set (or from power-on), so a value this large can only have been
/// written by us: it is the RTC's "has been set" mark as well as its base. 2000-01-01T00:00:00 is a
/// whole number of days, which makes the time of day a plain remainder.
const CLOCK_RTC_BASE_SECONDS: u64 = 946_684_800;

/// The time of day the RTC holds, or None when it has never been set.
pub fn rtc_time_of_day(rtc: &Rtc<'_>) -> Option<(u8, u8, u8)> {
    let seconds = rtc.current_time_us() / 1_000_000;
    if seconds < CLOCK_RTC_BASE_SECONDS {
        return None;
    }
    let day = (seconds - CLOCK_RTC_BASE_SECONDS) % 86_400;
    Some(((day / 3600) as u8, ((day / 60) % 60) as u8, (day % 60) as u8))
}

/// Days from 1970-01-01 to 2000-01-01. The RTC's base and the civil calendar's 1970 epoch are both whole
/// numbers of days, so a civil date folds back into the counter with no remainder.
const DAYS_1970_TO_2000: i64 = (CLOCK_RTC_BASE_SECONDS / 86_400) as i64;

/// Howard Hinnant's civil-from-days: days since 1970-01-01 to (year, month, day). Integer math only,
/// no_std, and div_euclid on the era keeps dates before the epoch correct too.
pub fn civil_from_days(days: i64) -> (u16, u8, u8) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 157_908) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let month_day = (5 * doy + 2) / 153;
    let day = (doy - (153 * month_day + 2) / 5 + 1) as u8;
    let month = if month_day < 10 { month_day + 3 } else { month_day - 9 } as u8;
    if month <= 2 {
        year += 1;
    }
    (year as u16, month, day)
}

/// The inverse of civil_from_days: a civil date back to days since 1970-01-01.
pub fn days_from_civil(year: i64, month: u8, day: u8) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let month = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * month as i64 + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The calendar date and the time of day the network gave, written into the RTC together so the whole
/// wall-clock -- not just the hands -- survives a reset. The counter is advanced to the local civil
/// timestamp, which is exactly what rtc_time_of_day reads back as the time of day.
pub fn set_rtc_datetime(rtc: &Rtc<'_>, year: u16, month: u8, day: u8, hour: u8, minute: u8, second: u8) {
    let days = days_from_civil(year as i64, month, day) - DAYS_1970_TO_2000;
    let now = hour.min(23) as u64 * 3600 + minute.min(59) as u64 * 60 + second.min(59) as u64;
    let seconds = CLOCK_RTC_BASE_SECONDS + days.max(0) as u64 * 86_400 + now;
    rtc.set_current_time_us(seconds * 1_000_000);
}

/// Writes the time of day into the RTC, base included. esp-hal keeps the offset in the RTC domain, so
/// this survives a reset -- which is exactly why the mark above works. A host's TIME line is a hand-over
/// of the time only: it carries no date, so the date the RTC already holds is kept, and a board that
/// learned a calendar day from the network is not dragged back to the 2000 base when a host hands the
/// hands over.
pub fn set_rtc_time_of_day(rtc: &Rtc<'_>, hour: u8, minute: u8, second: u8) {
    let seconds = rtc.current_time_us() / 1_000_000;
    let day = (seconds.saturating_sub(CLOCK_RTC_BASE_SECONDS) / 86_400) * 86_400;
    let now = hour.min(23) as u64 * 3600 + minute.min(59) as u64 * 60 + second.min(59) as u64;
    rtc.set_current_time_us((CLOCK_RTC_BASE_SECONDS + day + now) * 1_000_000);
}
${usbHost}`;
}

/** The setup-side declarations the clock machinery needs, per console chip. */
function espClockSetupDecls(board: EspBoardProfile): string {
    const console = board.espChip === 'esp32s3'
        ? `    // The console is the chip's own USB-Serial-JTAG controller: the T-QT's USB socket is wired to
    // the ESP32-S3 directly, so there is no bridge to configure and no UART pin to take.
    let mut console = UsbSerialJtag::new(peripherals.USB_DEVICE);`
        : `    // The console the host talks over: UART0 on the CH340's side of the CYD's USB socket. Only its
    // receiver is taken, so the log keeps working and a quiet console costs one register read a pass.
    //
    // Optional, and never an expect: a console that cannot be opened costs the hand-over and nothing
    // else. Found the hard way -- an expect here took the whole panel down on a board that had been
    // flashing happily until the reader was added.
    let mut console = match Uart::new(peripherals.UART0, UartConfig::default().with_baudrate(115_200)) {
        Ok(uart) => Some(uart.with_rx(peripherals.GPIO3)),
        Err(error) => {
            log::warn!("clock: the console UART did not open ({:?}); no host can hand the time over", error);
            None
        }
    };`;
    return `${console}
    let mut console_line = [0u8; 32];
    let mut console_len: usize = 0;
    // The chip's RTC: the one thing on the board that still knows the time after a reset. It is
    // asked before the design exists, so a board that was only reset starts with the right hands.
    let rtc = Rtc::new(peripherals.RTC_TIMER);
    let rtc_time = rtc_time_of_day(&rtc);
    match rtc_time {
        Some((hour, minute, second)) => log::info!(
            "clock: the RTC kept {:02}:{:02}:{:02} across the reset",
            hour,
            minute,
            second
        ),
        None => log::info!("clock: the RTC is not set; a host can hand the time over"),
    }
    let mut needs_time = rtc_time.is_none();
    let mut host_seen = false;
    let mut last_time_ask: Option<Instant> = None;
    // What the design is showing: the RTC's time, or whatever the host last said. The design itself
    // is built on the first calibrated frame, so the value is kept here until there is one to tell.
    let mut wall_clock: Option<(u8, u8, u8)> = rtc_time;
    let mut wall_clock_applied = false;
    if ui::HAS_CLOCK && needs_time {
        spawner.spawn(
            crate::net::time_task(peripherals.WIFI).expect("the network time task is spawned exactly once"),
        );
    }`;
}

/**
 * The loop-side half: read what the host said, and ask for the time when the RTC has never been set.
 *
 * The request is one plain line (TIME?) rather than a log line, so whatever is on the other end of the
 * cable can recognise it. The CYD can only learn that a host exists from a byte arriving -- its bridge
 * hides the cable -- so the host-side listener says hello first.
 */
/**
 * What the loop does with one complete console line: a dated `TIME` line first, then the bare form.
 *
 * One text for both chips, because the two readers differ in how a byte arrives and in nothing else --
 * a copy per chip is how the S3 and the CYD consoles drift apart. `indent` is the depth the reader
 * sits at, since the two `match` arms are not at the same one.
 */
function espClockLineHandler(indent: string): string {
    const inner = `${indent}    `;
    return [
        `${indent}// A local, because a range ending in console_len reads as a field access`,
        `${indent}// to the code that rewrites the loop's names onto state.`,
        `${indent}let filled = console_len;`,
        `${indent}// A dated line first: its date is the half a bare TIME HH:MM:SS cannot`,
        `${indent}// carry, and the extension writes both, so a project generated before the date`,
        `${indent}// existed still works.`,
        `${indent}if let Some((year, month, day, hour, minute, second)) =`,
        `${inner}parse_clock_datetime(&console_line[..filled])`,
        `${indent}{`,
        `${inner}wall_clock = Some((hour, minute, second));`,
        `${inner}wall_clock_applied = false;`,
        `${inner}set_rtc_datetime(&rtc, year, month, day, hour, minute, second);`,
        `${inner}needs_time = false;`,
        `${inner}log::info!(`,
        `${inner}    "clock: the console says {:04}-{:02}-{:02} {:02}:{:02}:{:02}",`,
        `${inner}    year,`,
        `${inner}    month,`,
        `${inner}    day,`,
        `${inner}    hour,`,
        `${inner}    minute,`,
        `${inner}    second`,
        `${inner});`,
        `${indent}} else if let Some((hour, minute, second)) =`,
        `${inner}parse_clock_time(&console_line[..filled])`,
        `${indent}{`,
        `${inner}wall_clock = Some((hour, minute, second));`,
        `${inner}wall_clock_applied = false;`,
        `${inner}set_rtc_time_of_day(&rtc, hour, minute, second);`,
        `${inner}needs_time = false;`,
        `${inner}log::info!(`,
        `${inner}    "clock: the console says {:02}:{:02}:{:02}",`,
        `${inner}    hour,`,
        `${inner}    minute,`,
        `${inner}    second`,
        `${inner});`,
        `${indent}}`,
        `${indent}console_len = 0;`,
    ].join('\n');
}

function espClockLoop(board: EspBoardProfile, screenAccess: string): string {
    const read = board.espChip === 'esp32s3'
        ? `        // A host on the cable is visible in the USB-Serial-JTAG controller itself; anything it says
        // arrives on the same peripheral. Both are the "is a PC there?" answer this board can give.
        if usb_host_attached() {
            host_seen = true;
        }
        loop {
            match console.read_byte() {
                Ok(byte) => {
                    host_seen = true;
                    match byte {
                        b'\\r' => {}
                        b'\\n' => {
${espClockLineHandler('                            ')}
                        }
                        _ if console_len < console_line.len() => {
                            console_line[console_len] = byte;
                            console_len += 1;
                        }
                        // A line longer than the buffer is not a time line: start again rather than
                        // keeping half of it.
                        _ => console_len = 0,
                    }
                }
                Err(_) => break,
            }
        }`
        : `        // Whatever the host has said over the console. Non-blocking: an empty FIFO reads zero
        // bytes, so a quiet console costs one register read a pass. A byte is also the CYD's only
        // evidence that a PC is on the other end of the cable: its USB socket goes through a bridge,
        // and the firmware cannot see the cable itself.
        if let Some(uart) = console.as_mut() {
            let mut byte = [0u8; 1];
            while uart.read_ready() {
                if !matches!(uart.read(&mut byte), Ok(1)) {
                    break;
                }
                host_seen = true;
                match byte[0] {
                    b'\\r' => {}
                    b'\\n' => {
${espClockLineHandler('                        ')}
                    }
                    _ if console_len < console_line.len() => {
                        console_line[console_len] = byte[0];
                        console_len += 1;
                    }
                    // A line longer than the buffer is not a time line: start again rather than
                    // keeping half of it.
                    _ => console_len = 0,
                }
            }
        }`;
    const ask = board.espChip === 'esp32s3'
        ? '                let _ = console.write(b"TIME?\\n");'
        : `                // esp-println's plain println, not the logger: a log line carries its level and
                // colour codes, and the host has to be able to recognise this line exactly.
                esp_println::println!("TIME?");`;
    // A bridge hides the cable: the CYD's only evidence that a host exists is data, and a board that
    // has just been powered on has received none -- so it asks anyway, and a TIME? written into a
    // port nobody is reading costs one UART write. The T-QT can see the cable (Start-of-Frame), so
    // it waits for a host that is really attached.
    const hostGate = board.espChip === 'esp32s3' ? ' && host_seen' : '';
    return `${read}
        // The network's answer, when the Wi-Fi task got one. Same effect as a console line: the RTC
        // is set and the hands follow. A time that arrives after another source already set the RTC
        // is taken and dropped, so the two never fight over the clock.
        if let Some((year, month, day, hour, minute, second)) = net::SYNCED_TIME.try_take() {
            if needs_time {
                wall_clock = Some((hour, minute, second));
                wall_clock_applied = false;
                set_rtc_datetime(&rtc, year, month, day, hour, minute, second);
                needs_time = false;
                log::info!(
                    "clock: the network says {:04}-{:02}-{:02} {:02}:{:02}:{:02}",
                    year,
                    month,
                    day,
                    hour,
                    minute,
                    second
                );
            }
        }
        // The design exists only from the first frame, and the time can arrive before it: the value
        // is remembered until there is a design to tell.
        if !wall_clock_applied {
            if let (Some(design), Some((hour, minute, second))) = (${screenAccess}, wall_clock) {
                design.set_wall_clock(hour, minute, second);
                wall_clock_applied = true;
            }
        }
        // A design with a clock and an RTC that has never been set: ask for the time once a second
        // until one arrives. Asking a cable that is not there costs nothing, and a host that appears
        // later -- after the board was powered on, or after a flash -- answers on its next try.
        if ui::HAS_CLOCK && needs_time${hostGate} {
            let due = match last_time_ask {
                None => true,
                Some(last) => last.elapsed().as_secs() >= 1,
            };
            if due {
${ask}
                last_time_ask = Some(Instant::now());
            }
        }`;
}

/** The fields of `State`: one per peripheral, plus the values the loop keeps between frames. */
function espStateFields(
    board: EspBoardProfile,
    template: AppTemplate,
    display: EspDisplay | undefined,
    touch: EspTouch | undefined,
): StateField[] {
    const fields: StateField[] = [];
    const led = board.led;
    const panel = display !== undefined;
    const drivesTouch =
        template === 'touch' || template === 'board' || (template === 'designer' && touch !== undefined);

    if (panel) {
        fields.push({
            name: 'display',
            type: 'DisplayDriver',
            // The display is drawn on in setup() by the diagnostic template, and by a Designer project on a
            // board with no touch controller -- which paints its one frame there and only logs in the loop.
            mutableInSetup: template === 'display' || (template === 'designer' && touch === undefined),
            keepAlive: template === 'designer' && touch === undefined,
            doc: 'The panel, brought up and ready to draw on.',
        });
        // A panel with no backlight pin wired has nothing to keep alive and nothing to dim.
        if (hasBacklight(display)) {
            fields.push({
                name: 'backlight',
                type: 'Backlight',
                // `configure` takes `&mut self`, so the local may not lose its `mut` (see sketch.ts).
                mutableInSetup: true,
                keepAlive: true,
                doc: 'The backlight\u2019s PWM channel. Nothing reads it: it is kept so the channel -- and the' +
                    ' timer it borrows -- outlive `setup()`, which is what holds the panel lit. Its duty comes' +
                    ' from BACKLIGHT_BRIGHTNESS, so the Designer\u2019s Brightness slider reaches the glass.',
            });
        }
    }
    if (drivesTouch && panel) {
        fields.push(
            {
                name: 'touch',
                type: 'BusDevice',
                mutableInSetup: true,
                doc: 'The touch controller, on the panel\u2019s bus with its own chip select.',
            },
            {
                name: 'bus',
                type: "&'static HalBus",
                doc: 'The bus itself, shared by the panel and the controller: the clock is switched around each'
                    + ' touch burst, so the loop needs to reach it.',
            },
            {
                name: 'touch_irq',
                type: "Input<'static>",
                doc: 'The controller\u2019s PENIRQ line. Logged rather than trusted: an interrupt that fires by'
                    + ' itself would otherwise walk the calibration through all four corners.',
            },
            {
                name: 'flash',
                type: "FlashStorage<'static>",
                mutableInSetup: true,
                doc: 'Flash, where a measured calibration is kept across a power cycle.',
            },
            {
                name: 'width_i',
                type: 'i32',
                doc: 'The drawing area, in the orientation the panel is currently turned to.',
            },
            { name: 'height_i', type: 'i32', doc: 'The drawing area\u2019s height.' },
            {
                name: 'box_w',
                type: 'i32',
                doc: 'The readout box, solved from the drawing area rather than hard-coded: its width and',
            },
            { name: 'box_h', type: 'i32', doc: 'height, so the box fits a 128 px panel as well as a 480 px one,' },
            { name: 'box_x', type: 'i32', doc: 'and where it starts.' },
            { name: 'box_y', type: 'i32', doc: 'The readout box\u2019s top-left corner.' },
            {
                name: 'rotation_code',
                type: 'u8',
                doc: 'The rotation as a number. A calibration is only valid for the orientation it was measured'
                    + ' in, so the record has to say which that was.',
            },
            { name: 'targets', type: '[(i32, i32); 4]', doc: 'The four corner targets, in the order they are asked for.' },
            { name: 'corners', type: "[&'static str; 4]", doc: 'Their names, in the same order, for the screen and the log.' },
            {
                name: 'idle_a',
                type: 'i32',
                doc: 'What the two axes read with nothing on the glass. A touch is judged by how far they move'
                    + ' from this, never by the interrupt line on its own.',
            },
            { name: 'idle_b', type: 'i32', doc: 'The second axis at rest.' },
            { name: 'calibrated', type: 'bool', doc: 'Whether the four corners have been measured yet, by this run or' + ' by a stored record.' },
            { name: 'corner', type: 'usize', doc: 'Which of the four the screen is asking for.' },
            { name: 'measured', type: '[[u16; 2]; 4]', doc: 'The raw readings taken at each corner.' },
            { name: 'raw_x_axis', type: 'usize', doc: 'Which raw axis follows the display\u2019s X, worked out from the' + ' corners rather than assumed from the wiring.' },
            { name: 'x_from', type: 'i32', doc: 'The raw-to-screen mapping: the two raw readings that map onto' },
            { name: 'x_to', type: 'i32', doc: 'the edges of the drawing area, per axis.' },
            { name: 'y_from', type: 'i32', doc: 'The mapping\u2019s two raw readings for the other axis.' },
            { name: 'y_to', type: 'i32', doc: 'And the far edge of it.' },
            { name: 'raw_a', type: 'i32', doc: 'The latest reading of each axis, and the readings the readout' },
            { name: 'raw_b', type: 'i32', doc: 'box was last painted with -- so it is repainted only when the' },
            { name: 'shown_a', type: 'i32', doc: 'numbers have moved far enough to be worth the pixels.' },
            { name: 'shown_b', type: 'i32', doc: 'The second axis\u2019 last painted reading.' },
            { name: 'pressed', type: 'bool', doc: 'Whether a finger is down now, and whether one was down on the' },
            { name: 'was_touched', type: 'bool', doc: 'previous sample. The edge between the two is what a press is.' },
            { name: 'redraw_screen', type: 'bool', doc: 'Whether the whole screen needs repainting this frame: a full' + ' clear is slow, so it is done only when something changed.' },
            { name: 'redraw_box', type: 'bool', doc: 'Whether the readout box does.' },
            { name: 'ticks', type: 'u32', doc: 'Loop counter. The sampling, the readout and the heartbeat are all' + ' scheduled off it.' },
            { name: 'point', type: '(i32, i32)', doc: 'The touch position in screen coordinates, after calibration.' },
            { name: 'hold_samples', type: 'u32', doc: 'How many samples a corner finger has been held still for.' },
            { name: 'hold_a', type: 'i32', doc: 'The raw readings a corner hold started at: a finger that moves is' },
            { name: 'hold_b', type: 'i32', doc: 'a drag, not a request to forget the calibration.' },
            { name: 'console', type: "Option<Uart<'static, esp_hal::Blocking>>", doc: 'The console the toolchain hands the time over on, when it' },
            { name: 'console_line', type: '[u8; 32]', doc: 'One line of it, in the making.' },
            { name: 'console_len', type: 'usize', doc: 'How much of that line is filled.' },
        );
    }
    if (template === 'designer') {
        // Touch projects build the design on the first calibrated frame; a panel without a touchscreen
        // builds it in setup() and lives in the loop, which is what lets a design that changes on its
        // own -- a running clock -- repaint with no finger involved.
        fields.push(
            touch !== undefined
                ? {
                    name: 'screen',
                    type: 'Option<ui::Designer>',
                    doc: 'The design, built on the first calibrated frame and driven by touch from then on.',
                }
                : {
                    name: 'screen',
                    type: 'ui::Designer',
                    // Built and painted in setup() on this board: there is no touch, so nothing in
                    // the loop creates it -- it only asks whether it changed.
                    mutableInSetup: true,
                    doc: 'The design. On a panel with no touchscreen this loop is the only thing that asks it whether anything changed.',
                },
        );
        // The clock's own state: the RTC that survives a reset, and the hand-over that fills it. A board
        // with a touch controller declares the console and wall-clock fields in the touch block above; this
        // adds the two the hand-over needs there, since the touch block is shared with templates that have
        // no design to tell the time to.
        if (touch !== undefined) {
            fields.push(
                { name: 'wall_clock', type: 'Option<(u8, u8, u8)>', doc: 'The local time the toolchain sent, and whether the design has' },
                { name: 'wall_clock_applied', type: 'bool', doc: 'been told yet: the design only exists after the first frame.' },
            );
        } else {
            const consoleField = board.espChip === 'esp32s3'
                ? {
                    name: 'console',
                    type: "UsbSerialJtag<'static, esp_hal::Blocking>",
                    doc: 'The console the host hands the time over on. This board\u2019s USB socket is wired to'
                        + ' the chip, so its console is the USB-Serial-JTAG controller itself.',
                }
                : {
                    name: 'console',
                    type: "Option<Uart<'static, esp_hal::Blocking>>",
                    doc: 'The console the host hands the time over on. This board\u2019s USB socket goes through a'
                        + ' bridge, so its console is UART0 on the bridge\u2019s side.',
                };
            fields.push(
                consoleField,
                { name: 'console_line', type: '[u8; 32]', doc: 'One line of it, in the making.' },
                { name: 'console_len', type: 'usize', doc: 'How much of that line is filled.' },
                { name: 'wall_clock', type: 'Option<(u8, u8, u8)>', doc: 'The local time the host sent, and whether the design has' },
                { name: 'wall_clock_applied', type: 'bool', doc: 'been told yet.' },
            );
        }
        fields.push(
            {
                name: 'rtc',
                type: "Rtc<'static>",
                doc: 'The chip\u2019s RTC: the only thing on the board that still knows the time after a reset.',
            },
            {
                name: 'needs_time',
                type: 'bool',
                doc: 'Whether the RTC was never set. Until it has been, the design asks a host for the time.',
            },
            {
                name: 'host_seen',
                type: 'bool',
                doc: 'Whether anything has arrived from a host. The CYD\u2019s USB socket goes through a bridge, so'
                    + ' a byte is the only evidence that a PC is on the other end.',
            },
            {
                name: 'last_time_ask',
                type: 'Option<Instant>',
                doc: 'When the time was last asked for, so the request is once a second and not once a pass.',
            },
        );
    }
    if (template === 'designer' && touch === undefined) {
        fields.push({
            name: 'alive',
            type: 'u32',
            doc: 'Poll counter. The heartbeat is one line every hundred passes, not one per poll.',
        });
    }
    if (template === 'board' && led.kind === 'rgb') {
        fields.push(
            { name: 'led_red', type: "Output<'static>", doc: 'The RGB status LED: red while uncalibrated, green' },
            { name: 'led_green', type: "Output<'static>", doc: 'while a finger is down, blue when idle and' },
            { name: 'led_blue', type: "Output<'static>", doc: 'calibrated. Wiring it to the state makes it a' + ' diagnostic rather than decoration.' },
        );
    }
    if (template === 'board' && board.ldr !== undefined) {
        const ldr = board.ldr;
        fields.push(
            {
                name: 'adc',
                type: `Adc<'static, esp_hal::peripherals::ADC1<'static>, esp_hal::Blocking>`,
                doc: 'The ADC the light sensor is read through.',
            },
            {
                name: 'light',
                type: `AdcPin<esp_hal::peripherals::GPIO${ldr.pin}<'static>, esp_hal::peripherals::ADC1<'static>, ()>`,
                doc: `The light sensor on GPIO${ldr.pin}: the lower leg of a divider, so a brighter room reads lower.`,
            },
        );
    }
    if (template === 'board' && board.audio !== undefined) {
        const audio = board.audio;
        fields.push({
            name: 'speaker',
            type: "Dac<'static, esp_hal::peripherals::DAC2<'static>>",
            doc: `The speaker on GPIO${audio.pin}, through an ${audio.amplifier}: what is written to the DAC is the`
                + ' waveform itself.',
        });
    }
    if (template === 'wifi') {
        fields.push(
            {
                name: 'controller',
                type: "WifiController<'static>",
                keepAlive: true,
                mutableInSetup: true,
                doc: 'The radio\u2019s controller. Nothing reads it after setup: dropping it deinitialises Wi-Fi and'
                    + ' takes the interface down with it, which looks exactly like a dead network.',
            },
            {
                name: 'stack',
                type: "embassy_net::Stack<'static>",
                doc: 'The network stack, once the association and the address are settled.',
            },
            { name: 'heartbeat', type: 'u32', doc: 'Heartbeat counter, so the log says the stack is still up.' },
        );
    }
    if (template === 'bluetooth') {
        fields.push({
            name: 'controller',
            type: 'BtController',
            doc: 'The Bluetooth controller, handed to the host stack by `main()` once. Nothing in the loop reads'
                + ' it: the stack owns it from that point on.',
        });
    }
    if (template === 'sdcard') {
        fields.push({
            name: 'sd_mounted',
            type: 'bool',
            doc: 'Whether the card mounted and its root directory listed.',
        });
    }
    if (template === 'peripherals') {
        if (board.ldr !== undefined) {
            const ldr = board.ldr;
            fields.push(
                {
                    name: 'adc',
                    type: `Adc<'static, esp_hal::peripherals::ADC1<'static>, esp_hal::Blocking>`,
                    doc: 'The ADC the light sensor is read through.',
                },
                {
                    name: 'light',
                    type: `AdcPin<esp_hal::peripherals::GPIO${ldr.pin}<'static>, esp_hal::peripherals::ADC1<'static>, ()>`,
                    doc: `The light sensor on GPIO${ldr.pin}.`,
                },
            );
        }
        if (board.audio !== undefined) {
            fields.push({
                name: 'speaker',
                type: "Dac<'static, esp_hal::peripherals::DAC2<'static>>",
                doc: 'The speaker, written to as a square wave.',
            });
        }
    }
    if (template === 'blinky') {
        if (led.kind === 'rgb') {
            fields.push(
                { name: 'red', type: "Output<'static>", doc: 'The RGB LED\u2019s three channels.' },
                { name: 'green', type: "Output<'static>", doc: 'Driven one at a time, so a swapped channel shows' },
                { name: 'blue', type: "Output<'static>", doc: 'as the wrong colour rather than as nothing.' },
            );
        } else if (led.kind === 'gpio') {
            fields.push({ name: 'led', type: "Output<'static>", doc: `The LED on GPIO${led.pin}.` });
        }
    }
    if (template === 'blinky' && led.kind === 'none') {
        fields.push({ name: 'tick', type: 'u32', doc: 'Heartbeat counter: this board has no LED, so the log is' + ' what says the firmware is alive.' });
    }
    if (template === 'display') {
        fields.push(
            {
                name: 'layout',
                type: "&'static DiagnosticLayout",
                doc: 'The diagnostic screen\u2019s geometry, solved for the orientation the panel is turned to.',
            },
            { name: 'tick', type: 'u32', doc: 'Loop counter for the blinking square.' },
        );
    }
    return fields;
}

/**
 * A template body's three steps, kept in one place so none of them can be forgotten.
 *
 * `fields` is what `setup()` hands back, and therefore also the list of names the loop has to reach through
 * `state.`.
 */
function stretch(body: string, fields: readonly StateField[]): {
    material: string;
    init: string;
    loop: string;
} {
    const hoisted = hoistHeader(body);
    const split = splitAtLoop(hoisted.body);
    return {
        material: hoisted.material,
        init: immutableLocals(split.init, fields),
        loop: againstState(split.loop, fields.map((field) => field.name)),
    };
}

/**
 * What the loop of a Bluetooth sketch runs after the controller has been handed over.
 *
 * The host stack owns the controller for good once it has it, so the hand-over happens once, before the loop,
 * and the loop below is only reached if the stack ever gives up.
 */
function espBluetoothHandover(): string {
    return `    // The host stack takes the controller for good: advertising, connections and the GATT server run until
    // it gives up, which is the whole program. A controller can only be given away once, so the hand-over
    // happens here, before the loop, rather than inside it.
    let controller = state.controller;
    ble_peripheral_run(controller).await;`;
}

/**
 * The `sd::init` call a Designer project gets on a board with a card.
 *
 * `src/main.rs` is written once at project creation and never regenerated, so the call is spelled out with
 * the socket's pins and their labels: a project generated before the card existed can be fixed by hand from
 * what is printed here, and the designer tells its user what to add.
 */
/**
 * `src/net.rs`: the time from the network, for a Designer project with no host on the cable.
 *
 * A board plugged into a charger has no PC to answer its TIME? request, so a design with a clock
 * would keep the time it was drawn with. This module joins the network the build was given, asks an
 * NTP server, and publishes the local time of day through a Signal; `main.rs` puts it in the RTC the
 * same way it does a console line. It is started only when the design has a clock and the RTC has
 * never been set, so a design without one never brings the radio up.
 *
 * Failure is quiet and final: no network, no DHCP lease, no NTP answer after three tries, and the
 * board carries on with the design's own time. The console hand-over still works in that case.
 */
function emitNetRs(): string {
    return `// Generated by Grumpy's Rusty Platform for VS Code.
//
// The time without a host: Wi-Fi and SNTP.
//
// The console hand-over (TIME HH:MM:SS) covers a board with a PC listening on its serial port. This
// covers a board plugged into a charger: join the network the build was given, ask an NTP server,
// and publish the local time of day. main.rs puts it in the RTC exactly as it does a console line.

// The radio can only be moved once per boot, so this module's task is only spawned when the clock
// needs the time. The items stay compiled in either way.
#![allow(dead_code)]

use embassy_executor::Spawner;
use embassy_net::dns::DnsQueryType;
use embassy_net::udp::{PacketMetadata, UdpSocket};
use embassy_net::{Config as NetConfig, Runner, StackResources};
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::signal::Signal;
use embassy_time::{with_timeout, Duration, Timer};
use esp_hal::peripherals::WIFI;
use esp_hal::rng::Rng;
use esp_radio::wifi::sta::StationConfig;
use esp_radio::wifi::{
    AuthenticationMethodConfig, Config as WifiConfig, ControllerConfig, Interface, WifiController,
};

/// The local date and time of day an NTP server gave, waiting for the main loop to put it in the RTC.
pub static SYNCED_TIME: Signal<CriticalSectionRawMutex, (u16, u8, u8, u8, u8, u8)> = Signal::new();

/// The network the build was given. The same contract as the Wi-Fi template: read at compile time,
//  never in the source tree.
const WIFI_SSID: &str = match option_env!("WIFI_SSID") {
    Some(value) => value,
    None => "YOUR_WIFI_SSID",
};
const WIFI_PASSWORD: &str = match option_env!("WIFI_PASSWORD") {
    Some(value) => value,
    None => "YOUR_WIFI_PASSWORD",
};

/// The time server. pool.ntp.org resolves to a nearby server and is the usual choice.
const NTP_SERVER: &str = "pool.ntp.org";

/// Minutes to add to UTC to get the time on the glass. Written into .cargo/esp-config.toml.
fn tz_offset_minutes() -> i64 {
    match option_env!("TZ_OFFSET_MINUTES") {
        Some(value) => value.trim().parse().unwrap_or(0),
        None => 0,
    }
}

/// The stack's buffer pool has to outlive the task, so it is a static. It is written once: the task
/// is spawned at most once per boot.
static STACK_RESOURCES: static_cell::StaticCell<StackResources<3>> = static_cell::StaticCell::new();

/// Joins the network and asks an NTP server for the time, then ends. A board with no network keeps
/// the design's own time, and the console hand-over is still there.
#[embassy_executor::task]
pub async fn time_task(wifi: WIFI<'static>) {
    // Open and protected networks are configured differently: WPA2 with an empty key never
    // associates, and an open network rejects a key that was supplied.
    let authentication = if WIFI_PASSWORD.is_empty() {
        AuthenticationMethodConfig::Open
    } else {
        AuthenticationMethodConfig::WpaWpa2Personal(
            WIFI_PASSWORD
                .try_into()
                .expect("the password is longer than 64 bytes"),
        )
    };
    let station_config = WifiConfig::Station(
        StationConfig::default()
            .with_ssid(WIFI_SSID.try_into().expect("the network name is longer than 32 bytes"))
            .with_authentication(authentication),
    );
    // The interface is the stack's driver and is a singleton, so it is taken before the controller.
    // The controller has to stay alive until the time is in: dropping it deinitialises Wi-Fi.
    let interface = Interface::station();
    let mut controller = match WifiController::new(
        wifi,
        ControllerConfig::default().with_initial_config(station_config),
    ) {
        Ok(controller) => controller,
        Err(error) => {
            log::warn!("clock: Wi-Fi refuses to start ({:?})", error);
            return;
        }
    };

    let mut joined = false;
    for attempt in 1..=5u32 {
        log::info!("clock: joining {} (attempt {})", WIFI_SSID, attempt);
        match controller.connect_async().await {
            Ok(_) => {
                joined = true;
                break;
            }
            Err(error) => {
                log::warn!("clock: association failed: {:?}", error);
                Timer::after(Duration::from_secs(5)).await;
            }
        }
    }
    if !joined {
        log::warn!("clock: no network; the design keeps its own time");
        return;
    }

    let rng = Rng::new();
    let seed = (rng.random() as u64) << 32 | rng.random() as u64;
    let (stack, runner) = embassy_net::new(
        interface,
        NetConfig::dhcpv4(Default::default()),
        STACK_RESOURCES.uninit().write(StackResources::<3>::new()),
        seed,
    );
    // Without this task running, not one packet is processed and every wait below never resolves.
    // for_current_executor is unsafe because it must be called from inside a task (it reads the
    // executor out of the current waker); this module is only ever entered from time_task.
    let spawner = unsafe { Spawner::for_current_executor().await };
    spawner.spawn(net_task(runner).expect("the network stack task is spawned exactly once"));

    // A router that has the address leased already is quick; one that does not is a board with no
    // network, and waiting on it for ever is not what a clock should do.
    if with_timeout(Duration::from_secs(30), stack.wait_config_up())
        .await
        .is_err()
    {
        log::warn!("clock: no address from DHCP; the design keeps its own time");
        return;
    }
    match stack.config_v4() {
        Some(config) => log::info!("clock: network up at {}", config.address),
        None => return,
    }

    for attempt in 1..=3u32 {
        if let Some((year, month, day, hour, minute, second)) = ntp_time(stack).await {
            log::info!(
                "clock: the network says {:04}-{:02}-{:02} {:02}:{:02}:{:02} (attempt {})",
                year,
                month,
                day,
                hour,
                minute,
                second,
                attempt
            );
            SYNCED_TIME.signal((year, month, day, hour, minute, second));
            return;
        }
        log::warn!("clock: no answer from the time server (attempt {})", attempt);
        Timer::after(Duration::from_secs(2)).await;
    }
    log::warn!("clock: giving up on the network time; the design keeps its own");
}

/// One SNTP request, and the local date and time of day from its answer.
async fn ntp_time(stack: embassy_net::Stack<'static>) -> Option<(u16, u8, u8, u8, u8, u8)> {
    // The server is a name, so the stack's resolver is used first. A literal address would skip
    // this, but a hard-coded one is a server that can move.
    let addresses = with_timeout(
        Duration::from_secs(10),
        stack.dns_query(NTP_SERVER, DnsQueryType::A),
    )
    .await
    .ok()?
    .ok()?;
    let server = match addresses.first()? {
        embassy_net::IpAddress::Ipv4(address) => *address,
        #[allow(unreachable_patterns)]
        _ => return None,
    };

    let mut rx_meta = [PacketMetadata::EMPTY; 2];
    let mut rx_buffer = [0u8; 64];
    let mut tx_meta = [PacketMetadata::EMPTY; 1];
    let mut tx_buffer = [0u8; 64];
    let mut socket = UdpSocket::new(
        stack,
        &mut rx_meta,
        &mut rx_buffer,
        &mut tx_meta,
        &mut tx_buffer,
    );
    if socket.bind(0).is_err() {
        return None;
    }

    // LI 0, version 4, mode 3 (client); everything else zero is a valid SNTP request.
    let mut request = [0u8; 48];
    request[0] = 0x23;
    socket.send_to(&request, (server, 123)).await.ok()?;

    let mut response = [0u8; 48];
    let (length, _) = with_timeout(
        Duration::from_secs(5),
        socket.recv_from(&mut response),
    )
    .await
    .ok()?
    .ok()?;
    if length < 48 {
        return None;
    }
    // The transmit timestamp is the last eight bytes: seconds since 1900, big endian, then the
    // fraction -- which a clock that shows whole seconds has no use for.
    let seconds =
        u32::from_be_bytes([response[40], response[41], response[42], response[43]]) as i64;
    if seconds == 0 {
        return None;
    }
    let unix = seconds - 2_208_988_800;
    let local = unix + tz_offset_minutes() * 60;
    let (year, month, day) = crate::main_header::civil_from_days(local.div_euclid(86_400));
    let tod = local.rem_euclid(86_400);
    Some((year, month, day, (tod / 3600) as u8, ((tod / 60) % 60) as u8, (tod % 60) as u8))
}

/// Drives the network stack; no packet moves while it is not being polled.
#[embassy_executor::task]
async fn net_task(mut runner: Runner<'static, Interface>) {
    runner.run().await
}
`;
}

/** The extra modules a Designer project is made of, and the two constants that describe it. */
function espModules(board: EspBoardProfile, template: AppTemplate, touch: EspTouch | undefined): string {
    if (template !== 'designer') {
        return '';
    }
    return (
        "// The design's own module, and the code-behind it calls.\nmod ui;\nmod ui_handlers;\n" +
        // The time without a host: Wi-Fi and SNTP, for a board plugged into a charger.
        "\n// Where the time comes from when no PC is listening on the cable.\nmod net;\n" +
        (board.sd === undefined
            ? ''
            : "\n// The card a design's `sd:/NAME.BMP` images are read from.\n#[cfg(feature = \"sd\")]\nmod sd;\n") +
        (touch === undefined
            ? ''
            : "\n/// This project draws the design, so the diagnostic screen the touch template can paint is folded\n/// away at compile time. Kept rather than deleted: it is what to fall back on when a panel comes up wrong.\nconst DESIGNER: bool = true;\n\n/// Whether touch is wanted, read at compile time so the driver, the calibration and the sampling fold\n/// away when it is off: no SPI traffic to a controller nobody asked for. Only \"0\" is off, so a project\n/// generated before the setting existed keeps the touchscreen it had.\nconst TOUCH: bool = match option_env!(\"TOUCH_ENABLED\") {\n    Some(value) => !(value.len() == 1 && value.as_bytes()[0] == b'0'),\n    None => true,\n};\n")
    );
}


/**
 * The `sd::init` call a Designer project gets on a board with a card.
 *
 * `src/main.rs` is written once at project creation and never regenerated, so the call is spelled out with
 * the socket's pins and their labels: a project generated before the card existed can be fixed by hand from
 * what is printed here, and the designer tells its user what to add.
 */
function espDesignerSdInit(board: EspBoardProfile, template: AppTemplate): string {
    const sd = board.sd;
    if (template !== 'designer' || sd === undefined) {
        return '';
    }
    return `
    // Mount the card before the panel and the design: a design can name \`sd:/...\` images, and the first
    // frame should already have somewhere to read them from. A missing card is logged and leaves those
    // images to draw nothing rather than stopping the firmware.
    #[cfg(feature = "sd")]
    sd::init(
        peripherals.${DESIGNER_SD_PERIPHERAL},
        peripherals.GPIO${sd.cs}, // card chip select
        peripherals.GPIO${sd.spi.sclk}, // card SPI clock
        peripherals.GPIO${sd.spi.mosi}, // card SPI data out
        peripherals.GPIO${sd.spi.miso}, // card SPI data in
    );`;
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
 * The panel's colour polarity, when the glass draws inverted.
 *
 * "Inverted" here is the panel's own INVERTON setting, not the drawing: with the default polarity a T-QT of
 * the newer GC9A01 revision paints white as black (reported 2026-10-24), and no other panel catalogued here
 * does. Nothing in a compile can prove which way a glass is wired, so the catalogue carries the answer and a
 * board that needs nothing emits nothing -- the controller's default is normal.
 */
function inversion(display: EspDisplay): string {
    if (display.invertColors !== true) {
        return '';
    }
    return `
        // ${display.label}: this glass draws inverted, so normal colours come out as their negative.
        .invert_colors(ColorInversion::Inverted)`;
}

/**
 * Where the glass's first pixel sits inside the controller's RAM, for a module that is not at (0, 0).
 *
 * The offset moves the *address window*, not the logical coordinate system, so the design is untouched and a
 * board that needs none emits nothing -- the controller's default is the origin. Without it the last row and
 * column of the panel are never written, which shows as a band of random pixels along two edges.
 */
function offset(display: EspDisplay): string {
    if (display.displayOffset === undefined) {
        return '';
    }
    const { x, y } = display.displayOffset;
    return `
        // ${display.label}: the glass starts ${x}px/${y}px into the controller's RAM.
        .display_offset(${x}, ${y})`;
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

    //@loop
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
    //@end`;
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
    return `    //@header
    // A fixed timestamp: the filesystem records one when it *writes*, and these templates only read, so a
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
    //@header-end

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

    //@header
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
    //@header-end

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

    //@loop
        Timer::after(Duration::from_secs(10)).await;
        heartbeat = heartbeat.wrapping_add(1);
        match stack.config_v4() {
            Some(config) => log::info!("heartbeat {} at {}", heartbeat, config.address),
            None => log::warn!("heartbeat {} with no address", heartbeat),
        }
    //@end`;
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
    let controller: BtController = ExternalController::new(connector);

    //@loop
        Timer::after(Duration::from_secs(3600)).await;
    //@end`;
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

    //@loop
        log::info!(
            "sd: {}",
            if sd_mounted {
                "mounted and readable"
            } else {
                "not mounted - insert a FAT-formatted card in the TF socket and reset"
            }
        );
        Timer::after(Duration::from_secs(10)).await;
    //@end`;
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
    //@loop
${ldrLoop}${audioLoop}
        Timer::after(Duration::from_millis(1000)).await;
    //@end`;
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
    //@header
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
    //@header-end
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
    // The touch controller's own clock is touch_clock() in MainHeader.rs, next to the panel's: the bus is
    // switched to the slow one around every burst and put back afterwards.

    // The same bus, a second chip select. PENIRQ is open drain: low means pressed, and the line is only
    // logged because it is not reliable here -- GPIO34-39 have no internal pull-ups either, so what the
    // pin reads with nothing touching it says more about the board than about the glass.
    let touch_cs = Output::new(peripherals.GPIO${touch.cs}, Level::Low, OutputConfig::default());
    let mut touch = RefCellDevice::new(&bus, touch_cs, Delay::new()).expect("touch chip select");
    let touch_irq = Input::new(peripherals.GPIO${touch.irq}, InputConfig::default().with_pull(Pull::Up));

    //@header
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
    // "Forget the calibration" is a finger held still in the top-left corner of the display. It is the
    // only way back once a panel has been calibrated, and it has to be *deliberate*: it used to be
    // "any touch in the first two seconds after a reset", which caught the ordinary touch of someone
    // testing a slider straight after a flash and threw a good calibration away -- reported from the
    // board as "when I try to drag the slider, or when long touching the screen, the screen
    // calibration routine fires". A corner hold cannot be mistaken for a drag (the finger moves), for
    // a long press on a widget (it is not in the corner) or for the tap that starts a test.
    //
    // The square is in content pixels, so it is the corner the user can see whatever the rotation;
    // the hold is counted in samples, each about 60 ms (every third 20 ms tick); and the slop is in
    // raw controller counts, so a finger that is merely resting is not also "moving".
    const RECALIBRATE_CORNER: i32 = 48;
    const RECALIBRATE_HOLD_SAMPLES: u32 = 33;
    const RECALIBRATE_SLOP: i32 = 300;

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
    //@header-end

${designer ? `    // Only when touch is wanted: naming the controller is part of having asked for it.
    if TOUCH {
` : ''}    log::info!(
        "touch: ${touch.controller} on GPIO${touch.cs} (cs), GPIO${touch.irq} (irq), pen level now {}",
        touch_irq.is_low()
    );${designer ? `
    }` : ''}
${hardwareSetup}${beepMacro}
${hardwareLog.length > 0 ? `    log::info!("board hardware: ${hardwareLog.join(', ')}");` : ''}

    //@header
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
    //@header-end

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

    // A stored calibration is used straight away; a finger held in the top-left corner for a couple of
    // seconds throws it away and asks for the corners again (see the press edge in the loop below). That
    // gesture is the only way back to the calibration screen once a panel has been calibrated.
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
    //@header
    const MARGIN: i32 = 24;
${designer ? '' : `
    // The line the toolchain sends over the console once the board is running: TIME HH:MM:SS,
    // local time, no date and no zone -- an ESP32's internal RTC has no battery, so a board that
    // has been powered off has no idea of the time until it is told, and the toolchain is the only
    // thing that knows what the PC's clock says.
    //
    // Anything else on the console is ignored rather than half-parsed: a line the user typed must
    // not be able to set the clock by accident.
    fn parse_clock_time(line: &[u8]) -> Option<(u8, u8, u8)> {
        let text = core::str::from_utf8(line).ok()?;
        let mut words = text.split_whitespace();
        if !words.next()?.eq_ignore_ascii_case("TIME") {
            return None;
        }
        let mut fields = words.next()?.split(':');
        let hour: u8 = fields.next()?.parse().ok()?;
        let minute: u8 = fields.next()?.parse().ok()?;
        let second: u8 = fields.next()?.parse().ok()?;
        if fields.next().is_some() || hour > 23 || minute > 59 || second > 59 {
            return None;
        }
        Some((hour, minute, second))
    }`}

    // Where a raw reading lands on the display, in content pixels.
    //
    // The touch readout, the design and the corner gesture that throws a calibration away all use
    // this one mapping, so "the top-left corner" means the corner on the glass whatever the
    // rotation and whichever raw axis is the horizontal one.
    fn touch_pixel(
        raw_x: i32,
        raw_y: i32,
        x_from: i32,
        x_to: i32,
        y_from: i32,
        y_to: i32,
        width_i: i32,
        height_i: i32,
    ) -> (i32, i32) {
        let px = if x_to == x_from {
            width_i / 2
        } else {
            MARGIN + (raw_x - x_from) * (width_i - 2 * MARGIN) / (x_to - x_from)
        }
        .clamp(0, width_i - 1);
        let py = if y_to == y_from {
            height_i / 2
        } else {
            MARGIN + (raw_y - y_from) * (height_i - 2 * MARGIN) / (y_to - y_from)
        }
        .clamp(0, height_i - 1);
        (px, py)
    }
    //@header-end
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
    // The corner-hold gesture that throws a stored calibration away: how many samples it has lasted,
    // and where the finger was when it started (the raw readings, for the "still" test). Zero means
    // "no gesture running" -- a press that began anywhere but the corner sets it to zero.
    let mut hold_samples: u32 = 0;
    let mut hold_a: i32 = 0;
    let mut hold_b: i32 = 0;
${designer ? espClockSetupDecls(board) : `    // The console the toolchain talks over. It is the same UART0 the logger writes to, and only
    // its receiver is taken: the log keeps working, and a quiet console costs one register read
    // per pass.
    //
    // Optional, and never an expect: a console that cannot be opened costs the wall clock and
    // nothing else -- the one-second timer still steps the design's own time, which is the fallback
    // a board with no RTC gets anyway. Found the hard way: an expect here took the whole panel down
    // on a board that had been flashing happily until the reader was added.
    let mut console = match Uart::new(peripherals.UART0, UartConfig::default().with_baudrate(115_200)) {
        Ok(uart) => Some(uart.with_rx(peripherals.GPIO3)),
        Err(error) => {
            log::warn!("clock: the console UART did not open ({:?}); the timer will step the clock", error);
            None
        }
    };
    let mut console_line = [0u8; 32];
    let mut console_len: usize = 0;`}
    // Whether the four corners have been measured -- by this run or by a previous one, which is what the
    // flash sector is for. Until they have, the panel shows the calibration screen.
    let mut calibrated = stored.is_some();${designer ? `
    // The design, built once on the first calibrated frame and driven by touch from then on.
    let mut screen: Option<ui::Designer> = None;` : ''}

    //@loop
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
                    let design = screen.get_or_insert_with(|| {
                        // Built once, on the first calibrated frame, and logged: when this project is flashed
                        // the log is what says whether the design exists at all, since a design that fails to
                        // build panics and a design that draws says nothing on its own.
                        ui::Designer::new(width_i as u32, height_i as u32)
                    });
                    display.clear(Rgb565::BLACK).expect("panel write failed");
                    // Timed, because "the panel feels slow" needs a number before a change to it can be
                    // judged. This is the *full* paint -- build, clear and every widget -- and it happens
                    // only on a calibration frame; a touch repaints just the damaged rectangles below.
                    let painted_at = Instant::now();
                    design.repaint(&mut display).expect("the design did not render");
                    log::info!(
                        "design: painted {}x{} in {} ms (full frame)",
                        width_i,
                        height_i,
                        painted_at.elapsed().as_millis()
                    );
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

${designer ? espClockLoop(board, 'screen.as_mut()') : `        // Whatever the toolchain sent over the console. Non-blocking: an empty FIFO reads zero
        // bytes, so a quiet console costs one register read a pass.
        if let Some(uart) = console.as_mut() {
            let mut byte = [0u8; 1];
            // A plain read *waits* for a byte that may never come: that stopped the whole panel at
            // the first frame, found on the board (2026-10-17). read_ready costs one register read
            // and answers at once, so a quiet console costs one test a pass and nothing else.
            while uart.read_ready() {
                if !matches!(uart.read(&mut byte), Ok(1)) {
                    break;
                }
                match byte[0] {
                    b'\\r' => {}
                    b'\\n' => {
                        // A local, because a range ending in console_len reads as a field access
                        // to the code that rewrites the loop's names onto state.
                        let filled = console_len;
                        if let Some((hour, minute, second)) =
                            parse_clock_time(&console_line[..filled])
                        {
                            log::info!(
                                "clock: the console says {:02}:{:02}:{:02}",
                                hour,
                                minute,
                                second
                            );
                        }
                        console_len = 0;
                    }
                    _ if console_len < console_line.len() => {
                        console_line[console_len] = byte[0];
                        console_len += 1;
                    }
                    // A line longer than the buffer is not a time line: start again rather than
                    // keeping half of it.
                    _ => console_len = 0,
                }
            }
        }
`}

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
                } else {
                    // Calibrated: a press that lands in the top-left corner starts the gesture that
                    // throws this calibration away. Anywhere else is an ordinary touch, and a press
                    // that starts anywhere else can never finish the gesture.
                    let (raw_x, raw_y) = if raw_x_axis == 0 {
                        (i32::from(a), i32::from(b))
                    } else {
                        (i32::from(b), i32::from(a))
                    };
                    let (corner_x, corner_y) = touch_pixel(
                        raw_x,
                        raw_y,
                        x_from,
                        x_to,
                        y_from,
                        y_to,
                        width_i,
                        height_i,
                    );
                    hold_samples = if corner_x < RECALIBRATE_CORNER
                        && corner_y < RECALIBRATE_CORNER
                    {
                        1
                    } else {
                        0
                    };
                    hold_a = raw_a;
                    hold_b = raw_b;
                }
            } else if pressed && hold_samples > 0 {
                // Still down, and it began in the corner: count it, unless the finger has moved --
                // a drag is not a request to recalibrate.
                if (raw_a - hold_a).abs() <= RECALIBRATE_SLOP
                    && (raw_b - hold_b).abs() <= RECALIBRATE_SLOP
                {
                    hold_samples += 1;
                } else {
                    hold_samples = 0;
                }
                if hold_samples >= RECALIBRATE_HOLD_SAMPLES {
                    // The finger is consumed by the gesture rather than recorded as a corner: it is
                    // still down, so no press edge will fire until it is lifted and put back.
                    calibrated = false;
                    corner = 0;
                    redraw_screen = true;
                    redraw_box = true;
                    hold_samples = 0;
                    log::info!(
                        "calibration: discarded by a finger held in the corner for {} samples - measure the four corners again",
                        RECALIBRATE_HOLD_SAMPLES
                    );${beep}
                }
            } else if !pressed {
                hold_samples = 0;
            }

            // The mapped position follows the finger for as long as it is down, and the readout is
            // repainted when it has moved enough to be worth the pixels.
            if calibrated && (pressed || was_touched) {
                let axis_x = if raw_x_axis == 0 { a } else { b };
                let axis_y = if raw_x_axis == 0 { b } else { a };
                let (px, py) = touch_pixel(
                    i32::from(axis_x),
                    i32::from(axis_y),
                    x_from,
                    x_to,
                    y_from,
                    y_to,
                    width_i,
                    height_i,
                );
                point = (px, py);${designer ? `
                // Hand the sample to the design: the press and the release are what a widget acts on, and the
                // moves are what let a slider follow the finger. Painting is *not* done here -- see the
                // pass-level check below, which is what keeps a design that changes on its own moving.
                if let Some(design) = screen.as_mut() {
                    design.pointer(px, py, pressed);
                    design.pump();
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
        }${designer ? `

        // The design paints what changed on every pass, not only while a finger is down. A clock with
        // its movement attached is due once a second, so a panel nobody has touched for an hour still
        // has to show the time -- and this used to live inside the touch branch above, which is why a
        // clock sat at whatever time it was flashed at.
        if let Some(design) = screen.as_mut() {
            if design.is_dirty() {
                design.render(&mut display).expect("the design did not render");
            }
        }` : ''}

        // Not in a Designer project: the per-touch lines below and the design's own event logs are the sign of
        // life that matters there, and a line every two seconds that says "touch test" is noise in an app.
        if ${designer ? '!DESIGNER && ' : ''}ticks % 100 == 0 {
            // A heartbeat with the numbers that matter, so "the log is quiet" cannot be mistaken for
            // "the app is not running".
            log::info!("touch test alive: a={} b={} idle a={} b={} pen={}", raw_a, raw_b, idle_a, idle_b, touch_irq.is_low());
        }
${hardwareLoop}
        Timer::after(Duration::from_millis(20)).await;
    //@end`;
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
    // Built once and used by both branches: the two differ in how the bus is shared, never in how the
    // backlight is brought up.
    const backlight = backlightSetup(display);

    if (shared) {
        return `
${backlight}${resetSetup}
    // The panel's clock is the function in MainHeader.rs: the touch controller on the same bus needs a
    // slower one, and the bus is re-configured around each touch read and put back afterwards.
    let spi = Spi::new(peripherals.SPI2, panel_clock())
    .expect("SPI configuration")
        .with_sck(peripherals.GPIO${display.spi.sclk})
        .with_mosi(peripherals.GPIO${display.spi.mosi})${miso};

    // The touch controller shares this bus, so the bus goes into a RefCell and each chip gets its own
    // device with its own CS pin. It is kept in a StaticCell rather than a local because the panel's
    // device borrows it and the panel is handed back to main in the sketch's State -- a local would be
    // dropped the moment setup() returned.
    let bus: &'static HalBus = BUS_CELL.init(RefCell::new(spi));
    let cs = Output::new(peripherals.GPIO${display.cs}, Level::Low, OutputConfig::default());
    // Shadows the bus with the panel's *device*, exactly as the exclusive branch does, so the rest of
    // the setup -- and mipidsi's interface below -- does not care which of the two it was handed.
    let spi = RefCellDevice::new(&bus, cs, Delay::new()).expect("panel chip select");

    // 512 bytes is mipidsi's own example buffer size: enough to batch pixels, small
    // enough to live on the stack, so this build needs no heap. It is kept in a StaticCell for the same
    // reason the bus is: the panel's interface borrows it, and the panel outlives setup().
    let buffer: &'static mut [u8; 512] = BUFFER_CELL.init([0u8; 512]);
    let dc = Output::new(peripherals.GPIO${display.dc}, Level::Low, OutputConfig::default());
    let di = SPIInterface::new(spi, dc, buffer);

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
        .display_size(width, height)${offset(display)}${reset}${orientation(display)}
        .color_order(ColorOrder::${display.colorOrder === 'bgr' ? 'Bgr' : 'Rgb'})${inversion(display)}
        .init(&mut delay)
        .expect("panel initialisation");

    log::info!("panel ready: ${rustString(display.label)}");
`;
    }
    return `
${backlight}${resetSetup}
    let spi = Spi::new(
        peripherals.SPI2,
        // ${display.label}: ${display.spiHz} Hz. Lower this first if the image is unstable.
        panel_clock(),
    )
    .expect("SPI configuration")
        .with_sck(peripherals.GPIO${display.spi.sclk})
        .with_mosi(peripherals.GPIO${display.spi.mosi})${miso};

    // esp-hal's Spi is a *bus*; mipidsi wants a SpiDevice, which is that bus plus its own CS pin.
    // embedded-hal-bus is the crate that joins the two (the recipe esp-hal's own examples use).
    let cs = Output::new(peripherals.GPIO${display.cs}, Level::Low, OutputConfig::default());
    let spi = ExclusiveDevice::new(spi, cs, Delay::new()).expect("SPI device");

    // 512 bytes is mipidsi's own example buffer size: enough to batch pixels, small
    // enough to live on the stack, so this build needs no heap. It is kept in a StaticCell because the
    // panel's interface borrows it and the panel outlives setup(), which is where the sketch's state is
    // built.
    let buffer: &'static mut [u8; 512] = BUFFER_CELL.init([0u8; 512]);
    let dc = Output::new(peripherals.GPIO${display.dc}, Level::Low, OutputConfig::default());
    let di = SPIInterface::new(spi, dc, buffer);

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
        .display_size(width, height)${offset(display)}${reset}${orientation(display)}
        .color_order(ColorOrder::${display.colorOrder === 'bgr' ? 'Bgr' : 'Rgb'})${inversion(display)}
        .init(&mut delay)
        .expect("panel initialisation");

    log::info!("panel ready: ${rustString(display.label)}");
`;
}

/**
 * The backlight, brought up as a PWM channel rather than a pin held on.
 *
 * A panel's backlight transistor is a switch, so a square wave on its pin is a dimmer: the duty cycle is the
 * brightness. The timer and the peripheral live in statics (see `espPanelStatics`) because the channel keeps
 * references to both for as long as it exists, and it travels back to main() in the sketch's State.
 *
 * A module with no BL pin wired gets nothing at all: no channel, no pin driven by accident, and -- in the
 * Designer -- no Brightness setting to offer.
 */
function backlightSetup(display: EspDisplay): string {
    if (display.backlight === undefined) {
        return '';
    }
    const level = display.backlightActiveLow === true
        ? 'this board switches the transistor on with a LOW level, so BACKLIGHT_DUTY_PCT is inverted'
        : 'this board switches the transistor on with a HIGH level, so the duty is the brightness';
    return `
    // Backlight first: PWM on its pin, so the brightness in .cargo/esp-config.toml is what the glass shows.
    // Note the level: ${level}.
    let ledc = LEDC_CELL.init(Ledc::new(peripherals.LEDC));
    ledc.set_global_slow_clock(LSGlobalClkSource::APBClk);
    let backlight_timer = BACKLIGHT_TIMER_CELL.init(ledc.timer::<LowSpeed>(timer::Number::Timer0));
    // 10 bits is 1024 steps across the range -- finer than an eye can see -- and 5 kHz is far above the
    // frequency at which a backlight flicker would be visible.
    backlight_timer
        .configure(timer::config::Config {
            duty: timer::config::Duty::Duty10Bit,
            clock_source: timer::LSClockSource::APBClk,
            frequency: Rate::from_khz(5),
        })
        .expect("the backlight PWM timer");
    let mut backlight = ledc.channel(channel::Number::Channel0, peripherals.GPIO${display.backlight});
    backlight
        .configure(channel::config::Config {
            timer: backlight_timer,
            duty_pct: BACKLIGHT_DUTY_PCT,
            drive_mode: DriveMode::PushPull,
        })
        .expect("the backlight PWM channel");
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
function espDesignerDisplayBody(display: EspDisplay, board: EspBoardProfile): string {
    return `${espPanelSetup(display, false)}

    let (width_i, height_i) = if rotated {
        (height as u32, width as u32)
    } else {
        (width as u32, height as u32)
    };
    let mut screen = ui::Designer::new(width_i, height_i);
    display.clear(Rgb565::BLACK).expect("panel write failed");
    // Timed, like the diagnostics screen and for the same reason: the number is what turns "the panel is
    // slow" into something a change can be compared against. The shapes draw in rows -- one canvas call
    // each -- because on a panel with no framebuffer every call is an address window.
    let drawn_at = Instant::now();
    screen.repaint(&mut display).expect("the design did not render");
    log::info!(
        "design drawn: {}x{} in {} ms",
        width_i,
        height_i,
        drawn_at.elapsed().as_millis()
    );

    // Counts passes, so the heartbeat below is one line every ten seconds rather than one per poll.
    let mut alive: u32 = 0;
${espClockSetupDecls(board)}

    //@loop
        // The clock comes first: a wall clock handed over (or kept by the RTC) has to be in the
        // design before it is asked whether it is dirty, or the first frame shows the drawn time.
${espClockLoop(board, 'Some(&mut screen)')}
        // Asked every pass, for the same reason as the touch body: a design that changes on its own --
        // a clock with its movement attached -- has no finger to make it repaint.
        if screen.is_dirty() {
            screen.render(&mut display).expect("the design did not render");
        }
        alive += 1;
        if alive % 100 == 0 {
            log::info!("design alive");
        }
        // 100 ms: often enough for a clock to be a second-keeping clock, cheap enough that the dirty
        // check is the only work most passes do.
        Timer::after(Duration::from_millis(100)).await;
    //@end`;
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

    //@loop
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
    //@end`;
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

    //@loop
        led.set_high();
        Timer::after_millis(500).await;
        led.set_low();
        Timer::after_millis(500).await;
    //@end`;
}

function espHeartbeatBody(): string {
    return `
    // No LED to blink on this board, so the heartbeat goes to the log instead. The panel
    // template is the interesting one here.
    let mut tick: u32 = 0;

    //@loop
        tick += 1;
        log::info!("alive (tick {})", tick);
        Timer::after(Duration::from_secs(1)).await;
    //@end`;
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
    // Only the pins the generated firmware actually drives are listed. A Designer project on a board with a
    // card drives the socket too (its `sd:` images are read from it), so those pins are claimed here as well.
    // Asked rather than re-listed. This was a second copy of the rule, and the designer was added to the
    // shared helper without reaching here -- which generated a Designer project whose body was the RGB LED
    // heartbeat. Found by generating one, 2026-10-08.
    const usesPanel = templateUsesPanel(template);
    const display = usesPanel ? displayFor(board, choices) : undefined;
    // A Designer project drives touch where the *chosen panel* has a controller and is a static screen where it
    // does not: the T-QT has a panel and no controller, and a DevKitC's modules differ (the ILI9341 brings an
    // XPT2046, the ST7789 does not).
    const touch =
        template === 'touch' || template === 'board' || template === 'designer'
            ? touchFor(board, display)
            : undefined;
    // The card is claimed by a Designer project only: the sdcard and board templates mount it too, but they
    // are diagnostic and describe it in their own log rather than in this table.
    const designerCard = template === 'designer' ? board.sd : undefined;
    const pinRows: string[] = [];
    if (display) {
        pinRows.push(`| ${display.cs} | panel chip select |`);
        pinRows.push(`| ${display.dc} | panel data/command |`);
        if (display.rst !== undefined) {
            pinRows.push(`| ${display.rst} | panel reset |`);
        }
        if (display.backlight !== undefined) {
            pinRows.push(`| ${display.backlight} | panel backlight (PWM) |`);
        }
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
    if (designerCard !== undefined) {
        pinRows.push(`| ${designerCard.cs} | TF card chip select |`);
        pinRows.push(`| ${designerCard.spi.sclk} | TF card SPI clock |`);
        pinRows.push(`| ${designerCard.spi.mosi} | TF card SPI data out |`);
        pinRows.push(`| ${designerCard.spi.miso} | TF card SPI data in |`);
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
270 degrees on hardware with every edge, corner and bar visible.${touch === undefined ? '' : `
The touch calibration is versioned by rotation: a record measured in one orientation is
discarded when the rotation changes and the four corners are asked for again. To force that by hand, press
and hold in the top-left corner of the screen for about two seconds - the stored calibration is thrown away
and the corner screen comes back. Anything else you do with a finger (a tap, a long press on a widget, a
drag) leaves the calibration alone.`}
`
        : '';
    // The card is a Designer feature here: an image whose source the design writes as `sd:/PIC1.BMP` is
    // streamed off the card at draw time instead of being compiled into flash.
    const cardNote =
        designerCard === undefined
            ? ''
            : `
## Reading images from the card

An image control whose source is written as \`sd:/PIC1.BMP\` is read from the TF card when it is drawn,
not compiled into flash. The file must be on a FAT-formatted card under a short 8.3 name
(\`PIC1.BMP\`, not \`holiday photo.bmp\`: the filesystem library has no long-name support), and the card
is mounted once at boot. A missing or unreadable card is logged and leaves the image blank.
`;
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

    // The backlight is PWM, so its brightness is a build-time number rather than a pin held on. Said here
    // because it is the one panel setting a user changes after the glass is already working.
    const backlightSection = display?.backlight === undefined
        ? ''
        : `
## Backlight brightness

GPIO${display.backlight} is the panel's backlight, driven by **PWM** rather than held on. Its brightness is
\`BACKLIGHT_BRIGHTNESS\` (0-100) in \`.cargo/esp-config.toml\`, read at **compile time** -- the Designer's
**Brightness** slider writes that line, editing it by hand works just as well, and nothing in \`src/main.rs\`
has to change. A project that does not mention the key is fully on. Rebuild to apply a change.
`;

    return `# ${crateName}

${board.family} firmware for **${board.name}**, generated by Grumpy's Rusty Platform
for VS Code.

- Target: \`${board.target}\`
- Chip: \`${board.espChip}\` (${board.flashSize} flash)
- Template: \`${template}\`
- Flashed with: \`espflash\` over USB serial — **no debug probe**
${wifiNote}${bluetoothNote}${rotationSection}${backlightSection}${cardNote}
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
