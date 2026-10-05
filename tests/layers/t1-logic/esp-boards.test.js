'use strict';

/**
 * The Espressif boards.
 *
 * Everything asserted here has a source: the vendor's own project scaffolding
 * (`esp-rs/esp-generate`), the boards' schematics or board definitions, and the crates'
 * published APIs. The point of the file is that the *generated* project keeps matching
 * them -- an ESP project cannot be built on this machine's host toolchain, so these tests
 * are what stands between a template edit and firmware that does not compile.
 */

const { test, ok, equal, notOk, contains, notContains, matches } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const { BOARDS, boardById, allTargets, rpTargets, espTargets } = compiled('boards/catalog');
const { isEspBoard } = compiled('boards/types');
const { displayFor, needsPanelChoice, panelChoices, defaultChoices } = compiled('boards/esp');
const { templatesFor, generateProjectFiles, defaultTemplateFor } = compiled('generate/files');

const ESP_IDS = ['esp32-devkitc', 'lilygo-tqt', 'sunton-3248s035r'];

/** Every panel controller the generated code can name, as mipidsi 0.10 spells them. */
const MIPIDSI_MODELS = ['GC9107', 'GC9A01', 'ST7796'];

function espBoard(id) {
    const board = boardById(id);
    ok(board, `unknown board ${id}`);
    ok(isEspBoard(board), `${id} should be an ESP board`);
    return board;
}

function filesFor(board, template, choices) {
    const files = generateProjectFiles({
        board,
        projectName: 'demo',
        template: template ?? defaultTemplateFor(board),
        choices,
    });
    return new Map(files.map((file) => [file.path, file.content]));
}

test('the catalog contains the three Espressif boards', () => {
    for (const id of ESP_IDS) {
        ok(boardById(id), `board "${id}" missing`);
    }
});

test('every ESP board names its chip, target and flash size', () => {
    const expected = {
        'esp32-devkitc': ['ESP32', 'esp32', 'xtensa-esp32-none-elf', '4 MB'],
        'lilygo-tqt': ['ESP32S3', 'esp32s3', 'xtensa-esp32s3-none-elf', '4 MB'],
        'sunton-3248s035r': ['ESP32', 'esp32', 'xtensa-esp32-none-elf', '4 MB'],
    };
    for (const [id, [family, chip, target, flashSize]] of Object.entries(expected)) {
        const board = espBoard(id);
        equal(board.family, family, `${id} family`);
        equal(board.espChip, chip, `${id} espflash/esp-hal chip name`);
        equal(board.target, target, `${id} Xtensa target triple`);
        equal(board.flashSize, flashSize, `${id} flash size`);
        equal(board.psram, false, `${id} must not claim PSRAM by default`);
    }
});

test('no ESP board carries RP-only fields', () => {
    // The union makes these type errors, and this keeps them from creeping back as data:
    // a `probeChip` or `memory.x` on an ESP board would make the RP code paths run.
    for (const id of ESP_IDS) {
        const board = espBoard(id);
        equal(board.memory, undefined, `${id} must not declare MEMORY regions`);
        equal(board.probeChip, undefined, `${id} must not claim a probe-rs chip id`);
        equal(board.embassyFeatures, undefined, `${id} must not declare embassy-rp features`);
        equal(board.cyw43, undefined, `${id} has no CYW43`);
        equal(board.wireless, undefined, `${id} must not use the RP wireless field`);
    }
});

test('the Xtensa triples are kept apart from the rustup targets', () => {
    equal(espTargets(), ['xtensa-esp32-none-elf', 'xtensa-esp32s3-none-elf']);
    for (const target of espTargets()) {
        notOk(rpTargets().includes(target), `${target} is not a rustup target`);
    }
    equal(allTargets(), [...new Set([...rpTargets(), ...espTargets()])].sort());
});

test('the T-QT asks which panel revision it has', () => {
    const board = espBoard('lilygo-tqt');
    equal(board.displays.length, 2, 'both revisions have to be described');
    equal(needsPanelChoice(board), true, 'only the user can tell the two panels apart');
    equal(panelChoices(board).length, 2);
    equal(defaultChoices(board).panel, 'gc9107', 'the older panel is the preselected one');

    const chosen = displayFor(board, { panel: 'gc9a01' });
    equal(chosen.controller, 'GC9A01');
    equal(displayFor(board, {}).controller, 'GC9107', 'without an answer the default applies');
});

test('the T-QT panel revisions share the same wiring', () => {
    const board = espBoard('lilygo-tqt');
    const panels = board.displays;
    for (const panel of panels) {
        equal(panel.width, 128, 'panel width');
        equal(panel.height, 128, 'panel height');
        equal(panel.cs, 5);
        equal(panel.dc, 6);
        equal(panel.rst, 1);
        equal(panel.backlight, 10, 'LilyGo drives the backlight from GPIO10');
        equal(panel.backlightActiveLow, true, "LilyGo's setup turns the backlight on with a LOW level");
        equal(panel.spi.sclk, 3);
        equal(panel.spi.mosi, 2);
        equal(panel.spi.miso, undefined, 'the T-QT does not route MISO to the panel');
        equal(panel.colorOrder, 'rgb');
    }
    // LilyGo runs the newer panel at 40 MHz and the older one at 27 MHz.
    equal(panels.find((p) => p.panelChoice === 'gc9107').spiHz, 27_000_000);
    equal(panels.find((p) => p.panelChoice === 'gc9a01').spiHz, 40_000_000);
});

test('the CYD panel matches the board schematic', () => {
    const panel = displayFor(espBoard('sunton-3248s035r'), {});
    equal(panel.label, '3.5" ST7796 320x480');
    equal(panel.controller, 'ST7796');
    equal(panel.width, 320);
    equal(panel.height, 480);
    equal(panel.cs, 15);
    equal(panel.dc, 2);
    equal(panel.rst, undefined, 'the schematic ties the panel reset to the board reset');
    equal(panel.backlight, 27);
    equal(panel.backlightActiveLow, false);
    equal(panel.spi.sclk, 14);
    equal(panel.spi.mosi, 13);
    equal(panel.spi.miso, 12, 'the panel and the card share this MISO');
    equal(panel.colorOrder, 'bgr');
    equal(panel.spiHz, 24_000_000);
});

test('the CYD board carries its touch and microSD wiring', () => {
    const board = espBoard('sunton-3248s035r');
    equal(board.touch.controller, 'XPT2046');
    equal(board.touch.cs, 33);
    equal(board.touch.irq, 36);
    equal(board.sd.cs, 5);
    equal(board.sd.spi.sclk, 18);
    equal(board.sd.spi.mosi, 19);
    equal(board.sd.spi.miso, 12);
});

test('every panel names a controller that mipidsi actually ships', () => {
    for (const board of BOARDS.filter(isEspBoard)) {
        for (const panel of board.displays) {
            ok(
                MIPIDSI_MODELS.includes(panel.controller),
                `${board.id}: mipidsi 0.10 has no model called ${panel.controller}`,
            );
        }
    }
});

test('an ESP board offers only templates that are implemented', () => {
    equal(
        templatesFor(espBoard('esp32-devkitc')).map((info) => info.id),
        ['blinky'],
        'the DevKitC has no panel, so a panel template would be meaningless',
    );
    for (const id of ['lilygo-tqt', 'sunton-3248s035r']) {
        equal(templatesFor(espBoard(id)).map((info) => info.id), ['blinky', 'display']);
        equal(defaultTemplateFor(espBoard(id)), 'display', 'a panel board is bought for its panel');
    }
});

test('an unimplemented template is refused, not generated', () => {
    let message = '';
    try {
        generateProjectFiles({ board: espBoard('esp32-devkitc'), projectName: 'x', template: 'wifi' });
    } catch (error) {
        message = String(error && error.message ? error.message : error);
    }
    matches(
        message,
        /not available/,
        'the Wi-Fi template does not exist yet, so asking for it has to fail loudly',
    );
});

test('an ESP project has no RP-shaped files', () => {
    for (const id of ESP_IDS) {
        const files = filesFor(espBoard(id));
        notOk(files.has('memory.x'), `${id} must not generate memory.x: the bootloader owns the layout`);
        notOk(files.has('.vscode/launch.json'), `${id} has no SWD to debug, so no launch.json`);
        ok(files.has('.cargo/esp-config.toml'), `${id} needs the runtime-config file`);
        ok(files.has('.cargo/config.toml'));
    }
});

test('the manifest pins esp-hal 1.2 and the esp-rtos stack', () => {
    for (const id of ESP_IDS) {
        const cargo = filesFor(espBoard(id)).get('Cargo.toml');
        contains(cargo, 'edition = "2024"');
        contains(cargo, 'rust-version = "1.95"', 'esp-hal 1.2 requires this Rust');
        contains(cargo, 'esp-hal = { version = "~1.2.2"');
        contains(cargo, 'esp-rtos = { version = "0.4.0"');
        contains(cargo, 'esp-bootloader-esp-idf = { version = "0.6.0"');
        contains(cargo, 'esp-println = { version = "0.18.0"');
        contains(cargo, 'embassy-executor = { version = "0.10.0"');
        // The RP dependencies must not leak in: esp-hal is the HAL here.
        for (const wrong of ['embassy-rp', 'defmt-rtt', 'panic-probe', 'cyw43', 'cortex-m']) {
            notContains(cargo, wrong, `${id} must not depend on ${wrong}`);
        }
    }
});

test('the chip feature follows the board', () => {
    contains(filesFor(espBoard('esp32-devkitc')).get('Cargo.toml'), '"esp32"');
    contains(filesFor(espBoard('lilygo-tqt')).get('Cargo.toml'), '"esp32s3"');
    notContains(
        filesFor(espBoard('esp32-devkitc')).get('Cargo.toml'),
        '"esp32s3"',
        'an ESP32 project must not enable the S3 feature',
    );
});

test('.cargo/config.toml flashes over USB serial with espflash', () => {
    for (const id of ESP_IDS) {
        const board = espBoard(id);
        const config = filesFor(board).get('.cargo/config.toml');
        contains(config, `target = "${board.target}"`);
        contains(config, `runner = "espflash flash --monitor --chip ${board.espChip}"`);
        contains(config, 'include = ["esp-config.toml"]');
        contains(config, 'build-std = ["core"]');
        notContains(config, 'probe-rs', 'an ESP32 is not programmed through SWD');
    }
});

test('rust-toolchain.toml names the espup toolchain channel', () => {
    const toolchain = filesFor(espBoard('esp32-devkitc')).get('rust-toolchain.toml');
    contains(toolchain, 'channel = "esp"');
    contains(toolchain, 'espup install');
    contains(toolchain, 'source $HOME/export-esp.sh');
});

test('build.rs adds the esp-hal linker script and explains a missing Xtensa linker', () => {
    const build = filesFor(espBoard('esp32-devkitc')).get('build.rs');
    contains(build, 'println!("cargo:rustc-link-arg=-Tlinkall.x");');
    contains(build, 'export-esp.sh', 'a bare "linker not found" tells the user nothing');
    contains(build, 'espup install');
    // Mentioning memory.x in prose is fine; linking or reading one is not -- the ESP-IDF
    // bootloader owns the flash layout, so those directives belong to RP projects only.
    notContains(build, 'rerun-if-changed=memory.x');
    notContains(build, 'include_bytes!("memory.x")');
});

test('main.rs uses the esp-rtos entry point and the app descriptor', () => {
    for (const id of ESP_IDS) {
        for (const info of templatesFor(espBoard(id))) {
            const main = filesFor(espBoard(id), info.id).get('src/main.rs');
            contains(main, '#![no_std]');
            contains(main, '#![no_main]');
            contains(main, '#[esp_rtos::main]', 'esp-hal 1.x brought the executor into esp-rtos');
            contains(main, 'esp_bootloader_esp_idf::esp_app_desc!()', 'the bootloader demands this');
            contains(main, 'esp_hal::Config::default().with_cpu_clock(CpuClock::max())');
            contains(main, 'esp_hal::init(config)');
            contains(main, 'esp_rtos::start(timg0.timer0, peripherals.FROM_CPU_INTR0)');
            contains(main, 'use esp_backtrace as _;');
            notContains(main, 'embassy_rp::', `${id}/${info.id} must not use embassy-rp`);
        }
    }
});

test('the DevKitC blinky drives an offered external LED and says so', () => {
    const main = filesFor(espBoard('esp32-devkitc'), 'blinky').get('src/main.rs');
    contains(main, 'peripherals.GPIO4');
    contains(main, 'no user LED', 'Espressif ships no user LED on this board: say so');
    // Output::new takes three arguments in esp-hal 1.2.
    contains(main, 'Output::new(peripherals.GPIO4, Level::Low, OutputConfig::default())');
});

test('a board with no LED logs a heartbeat instead of inventing one', () => {
    const main = filesFor(espBoard('lilygo-tqt'), 'blinky').get('src/main.rs');
    contains(main, 'alive (tick');
    notContains(main, 'Output::new', 'the T-QT has no user LED');
});

test('the panel template initialises the panel over its own pins', () => {
    const panel = displayFor(espBoard('sunton-3248s035r'), {});
    const main = filesFor(espBoard('sunton-3248s035r'), 'display').get('src/main.rs');

    // The **buffered** interface: the call below passes `&mut buffer`, and only mipidsi's own
    // `interface::SpiInterface` takes one. `display_interface_spi::SPIInterface::new(spi, dc)` takes two, so
    // importing that emitted a project that could not compile — a user's working Sunton project carried this
    // fix by hand before the generator had it (2026-10-05).
    contains(main, 'use mipidsi::interface::SpiInterface as SPIInterface;');
    // The pair, pinned together: a call that passes a buffer needs the three-argument type, and this is what
    // stops the import and the call drifting apart again.
    if (/SPIInterface::new\([^)]*&mut buffer/.test(main)) {
        ok(main.includes('mipidsi::interface::SpiInterface'), 'a buffered call needs the buffered interface');
        notOk(main.includes('display_interface_spi::SPIInterface'), 'and never the two-argument one');
    }
    contains(main, 'use embedded_graphics_core::draw_target::DrawTarget;', 'clear() comes from this trait');
    contains(main, 'Builder::new(models::ST7796, di)');
    contains(main, '.display_size(320, 480)');
    contains(main, '.color_order(ColorOrder::Bgr)');
    contains(main, `.init(&mut delay)`);
    contains(main, `with_sck(peripherals.GPIO${panel.spi.sclk})`);
    contains(main, `with_mosi(peripherals.GPIO${panel.spi.mosi})`);
    contains(main, `with_miso(peripherals.GPIO${panel.spi.miso})`);
    // The CS pin is the board's, but it is *not* handed to the bus: esp-hal's Spi is a SpiBus and mipidsi needs
    // a SpiDevice. The pin goes to the adapter that makes one — `.with_cs(...)` on the bus was the shape that
    // could not compile (found by building a generated project, 2026-10-05).
    contains(main, `Output::new(peripherals.GPIO${panel.cs}`);
    contains(main, 'ExclusiveDevice::new(spi, cs');
    notOk(main.includes('.with_cs('), 'the bus is not given a CS pin it cannot use');
    contains(main, 'embedded-hal-bus', 'the adapter crate is a dependency of the project');
    contains(main, 'let mut delay = Delay::new();', 'Delay is a unit struct in esp-hal 1.x, built with new()');
    contains(main, 'RgbColor', 'the colour constants need their trait in scope');
    contains(main, `Output::new(peripherals.GPIO${panel.dc}, Level::Low, OutputConfig::default())`);
    contains(main, `peripherals.GPIO${panel.backlight}`, 'the backlight has to be switched on');
    contains(main, 'SPIInterface::new(spi, dc, &mut buffer)');
});

test('the T-QT panel revision becomes a cargo feature, not dead code', () => {
    const board = espBoard('lilygo-tqt');
    const older = filesFor(board, 'display', { panel: 'gc9107' });
    contains(older.get('Cargo.toml'), '[features]');
    contains(older.get('Cargo.toml'), 'default = ["panel-gc9107"]');
    contains(older.get('Cargo.toml'), 'panel-gc9a01 = []', 'the other revision stays switchable');
    contains(older.get('src/main.rs'), 'models::GC9107');

    const newer = filesFor(board, 'display', { panel: 'gc9a01' });
    contains(newer.get('Cargo.toml'), 'default = ["panel-gc9a01"]');
    contains(newer.get('src/main.rs'), 'models::GC9A01');
});

test('the backlight polarity comes from the board, not from a guess', () => {
    const low = filesFor(espBoard('lilygo-tqt'), 'display', { panel: 'gc9107' }).get('src/main.rs');
    contains(low, 'Level::Low', 'the T-QT switches its backlight transistor on with a low level');

    const high = filesFor(espBoard('sunton-3248s035r'), 'display').get('src/main.rs');
    contains(high, 'Level::High', 'the CYD is active high');
});

test('the README explains the missing debugger and the first-time setup', () => {
    const readme = filesFor(espBoard('sunton-3248s035r'), 'display').get('README.md');
    contains(readme, 'espflash');
    contains(readme, 'no breakpoints', 'there is no SWD on this chip: the README has to say so');
    contains(readme, 'Flash & Monitor', 'and offer what the Debug button does instead');
    contains(readme, 'espup install');
    contains(readme, 'microSD', "the board's own features belong in its notes");
});

test('an ESP README only lists pins the generated code drives', () => {
    const readme = filesFor(espBoard('sunton-3248s035r'), 'display').get('README.md');
    // The touch controller and the card socket exist on the board, but no generated code
    // touches them yet, so the pin table must not claim them.
    notContains(readme, '| 33 |', 'the touch chip select is not used by this template');
    notContains(readme, '| 5 |', 'the microSD chip select is not used by this template');
    contains(readme, '| 15 | panel chip select |');
});

test('no board name reaches generated Rust code unescaped', () => {
    // The CYD is called `Sunton ESP32-3248S035R (3.5" CYD)`, and that quote broke the
    // generated log line until the generator started escaping it.
    for (const board of BOARDS) {
        for (const info of templatesFor(board)) {
            for (const file of generateProjectFiles({ board, projectName: 'x', template: info.id })) {
                if (!file.path.endsWith('.rs')) {
                    continue;
                }
                file.content.split('\n').forEach((line, index) => {
                    if (line.trim().startsWith('//') || !line.includes(board.name)) {
                        return;
                    }
                    ok(
                        line.includes(board.name.replace(/"/g, '\\"')),
                        `${board.id}/${info.id} ${file.path}:${index + 1} puts an unescaped quote in a string literal`,
                    );
                });
            }
        }
    }
});

test('every generated ESP file ends with a newline and uses LF', () => {
    for (const id of ESP_IDS) {
        for (const info of templatesFor(espBoard(id))) {
            for (const [path, content] of filesFor(espBoard(id), info.id)) {
                ok(content.endsWith('\n'), `${id}/${info.id}/${path} should end with a newline`);
                notContains(content, '\r', `${id}/${info.id}/${path} must use LF`);
            }
        }
    }
});

test('the ESP catalog entries are the only ones with Xtensa targets', () => {
    for (const board of BOARDS) {
        const xtensa = board.target.startsWith('xtensa-');
        equal(xtensa, isEspBoard(board), `${board.id}: Xtensa target and board family disagree`);
    }
    matches(boardById('pico').target, /^thumbv\d/, 'and the RP boards keep their Arm triples');
});
