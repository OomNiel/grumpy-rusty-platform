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
const { espDiagnosticLayout } = compiled('generate/esp');

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
    // Confirmed by a bit-banged sweep of every candidate pin on this board: CS 33 and MISO 12 are the
    // pair that answers, and its values move for a touch. A hand tracing had suggested CS 25 / IRQ 39;
    // the measurement said 33/36, and the measurement wins (NOTES 58).
    equal(board.touch.cs, 33, 'the chip select the controller actually answers on');
    equal(board.touch.irq, 36, 'and the line that idles high, which is what PENIRQ does');
    equal(board.touch.spiHz, 1_000_000, 'half the specified maximum: 2 MHz reads zeros on this board');
    // The LDR, traced to module pin 6 = GPIO34 = ADC1 channel 6. Recorded before it can be read: the pin is
    // the thing that decides which ADC channel it is, and no template drives it yet.
    equal(board.ldr.pin, '34', 'the light sensor is on an ADC-capable, input-only pin');
    // 3.3V -> 5k -> pin -> LDR -> GND. The polarity is the part worth pinning: the LDR is the lower leg, so
    // brighter light has to read as a smaller number, and a template that assumed the other way would look
    // like a dead sensor on a bright day.
    equal(board.ldr.seriesOhms, 5_000);
    equal(board.ldr.toGround, true, 'the LDR faces ground, so the reading falls as the light rises');
    // Module pin 11 = GPIO26 = DAC channel 2, into an LTK8002D through a 4k7 resistor. The pin being a DAC
    // is the fact that decides how the template makes sound, so it is pinned here.
    equal(board.audio.pin, '26');
    equal(board.audio.amplifier, 'LTK8002D');
    equal(board.audio.seriesOhms, 4_700);
    ok(['25', '26'].includes(board.audio.pin), 'the amplifier has to hang off one of the two DAC pins');
    equal(board.sd.cs, 5);
    equal(board.sd.spi.sclk, 18);
    // CMD is the card's data *in* and DAT0 its data out, so in SPI mode MOSI is CMD (23) and MISO is
    // DAT0 (19). The community definition had these the other way round (ESP32-035 hardware notes).
    equal(board.sd.spi.mosi, 23);
    equal(board.sd.spi.miso, 19);
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
        ['blinky', 'wifi', 'bluetooth'],
        'the DevKitC has no panel and no card, so it gets the two radio templates and nothing else',
    );
    equal(
        templatesFor(espBoard('lilygo-tqt')).map((info) => info.id),
        ['blinky', 'display', 'wifi', 'bluetooth'],
        'the T-QT has a panel, no touch controller, and the S3 radio',
    );
    // The CYD is the only board with a touch controller, so it is the only one offered the touch test.
    equal(
        templatesFor(espBoard('sunton-3248s035r')).map((info) => info.id),
        ['blinky', 'display', 'sdcard', 'board', 'peripherals', 'touch', 'wifi', 'bluetooth'],
        'the card sits with the panel templates, board is everything, and wireless comes after the hardware',
    );
    for (const id of ['lilygo-tqt', 'sunton-3248s035r']) {
        equal(defaultTemplateFor(espBoard(id)), 'display', 'a panel board is bought for its panel');
    }
});

test('the touch template is only offered where a touch controller exists', () => {
    for (const board of BOARDS.filter(isEspBoard)) {
        const ids = templatesFor(board).map((info) => info.id);
        equal(
            ids.includes('touch'),
            board.touch !== undefined,
            `${board.id}: the touch template follows the controller, not the panel`,
        );
    }
    const cyd = espBoard('sunton-3248s035r');
    equal(cyd.touch.controller, 'XPT2046');
    equal(defaultTemplateFor(cyd), 'display', 'touch is a test, not the default for a new project');
});

test('a template the board cannot run is refused, not generated', () => {
    let message = '';
    try {
        // The DevKitC has no touch controller at all, so this board/template pair can never work and the
        // generator has to say so rather than emitting firmware that talks to a chip that is not there.
        generateProjectFiles({ board: espBoard('esp32-devkitc'), projectName: 'x', template: 'touch' });
    } catch (error) {
        message = String(error && error.message ? error.message : error);
    }
    matches(
        message,
        /not available/,
        'a template the board does not support has to fail loudly',
    );
});

test('the wireless templates follow the chip radio, not the family name', () => {
    for (const board of BOARDS.filter(isEspBoard)) {
        const ids = templatesFor(board).map((info) => info.id);
        equal(ids.includes('wifi'), board.radio.wifi, `${board.id}: Wi-Fi follows radio.wifi`);
        equal(
            ids.includes('bluetooth'),
            board.radio.bluetooth === 'ble',
            `${board.id}: Bluetooth follows radio.bluetooth`,
        );
    }
});

test('a chip without Bluetooth is never offered the Bluetooth template', () => {
    // The ESP32-S2 has no Bluetooth controller at all, so the field has to be able to say "none" and the
    // template list has to obey it. A synthetic profile is the only way to exercise that: every chip in the
    // catalog happens to have BLE, so a bug that ignored the field would be invisible against real boards.
    const s2 = { ...espBoard('esp32-devkitc'), family: 'ESP32', radio: { wifi: true, bluetooth: 'none' } };
    equal(
        templatesFor(s2).map((info) => info.id),
        ['blinky', 'wifi'],
        'Wi-Fi stays, Bluetooth goes',
    );
    const deaf = { ...s2, radio: { wifi: false, bluetooth: 'none' } };
    equal(
        templatesFor(deaf).map((info) => info.id),
        ['blinky'],
        'a chip with no radio at all gets neither',
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
    // The full `embedded-graphics` crate, not the `_core` split: the diagnostics need `Text`, `Line` and
    // `Rectangle`, and its `prelude` is what brings `DrawTarget` (clear()) and `RgbColor` into scope. The
    // `_core` crate carried the shape but none of the drawing primitives (2026-10-05).
    contains(main, 'use embedded_graphics::prelude::*;', 'clear() and the colour traits come from the prelude');
    notOk(main.includes('embedded-graphics-core'), 'the split crate is not depended on any more');
    contains(main, 'use mipidsi::options::{ColorOrder, Orientation};');
    contains(main, 'Builder::new(models::ST7796, di)');
    // The panel is wired with its X axis mirroring the controller's default. The board data said so from the
    // start (mirrorX: true, from the community board definition) and the template simply never emitted it, so
    // the first flash of this screen came out as a mirror -- text and all. The hardware settled the data's
    // claim; the pair below stops the emit from going missing again.
    contains(main, '.orientation(Orientation::new().flip_horizontal())');
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
    notOk(/^use embedded_graphics::prelude::RgbColor;/m.test(main),
        'RgbColor is reached through the prelude, not a second import of the same crate');
    contains(main, `Output::new(peripherals.GPIO${panel.dc}, Level::Low, OutputConfig::default())`);
    contains(main, `peripherals.GPIO${panel.backlight}`, 'the backlight has to be switched on');
    contains(main, 'SPIInterface::new(spi, dc, &mut buffer)');
});

// A panel that lights up is not the same as a panel that is *right*: cropped active area, swapped colour
// order and a rotated image all look like "it works" on a flat fill. The generated screen draws the frame,
// the four corner markers, the named bars, a centred cross, the greeting and a blinking square, so a user
// (or a support thread) can read the three failures off the screen instead of guessing (2026-10-05).
test('the panel template draws a diagnostic screen, not a flat fill', () => {
    const main = filesFor(espBoard('sunton-3248s035r'), 'display').get('src/main.rs');

    contains(main, 'display.clear(Rgb565::BLACK)');
    notOk(/PrimitiveStyle::with_fill\(Rgb565::BLACK\)\)\s*\.draw\(&mut display\)/.test(main),
        'a black fill hides everything that matters');

    contains(main, 'Rectangle::new(Point::new(1, 1), Size::new(320 - 2, 480 - 2))', 'the frame is the panel, minus its stroke');
    // The corners, by colour: each one names what a shifted panel looks like in that spot.
    for (const corner of ['Rgb565::RED', 'Rgb565::GREEN', 'Rgb565::BLUE', 'Rgb565::WHITE']) {
        contains(main, corner);
    }
    contains(main, 'for (x, y, colour) in [');
    // The bars are named in the comment in the order they are drawn, so a swap is diagnosable from the read.
    contains(main, 'bars L to R: red green blue black white');
    contains(main, 'Line::new(Point::new(320 / 2, 0)', 'the cross has to be centred by the panel size, not a number');
    contains(main, 'Line::new(Point::new(0, 480 / 2)');
    contains(main, 'Hello Grumpy!');
    // The blink is the only moving pixel: it proves the loop runs without covering a diagnostic.
    contains(main, 'let colour = if tick % 2 == 0 { Rgb565::WHITE } else { Rgb565::BLACK };');
    contains(main, 'Timer::after(Duration::from_millis(700))');
    // Every extra text line is a size asked of the font, so check the font that fits the width.
    contains(main, 'FONT_6X10');
    contains(main, 'FONT_10X20');
    // The screen times itself, because "the panel is slow" is otherwise a feeling: a debug build of this
    // template took 29.4 s to paint on a CYD against 0.223 s for a release build (2026-10-05).
    contains(main, 'let drawn_at = Instant::now();');
    contains(main, 'drawn_at.elapsed().as_millis()');
    contains(main, 'use embassy_time::{Duration, Instant, Timer};');
});

// The panel's scan direction is board data, and every panel states it in the generated code -- including the
// ones that need no flip. `mirrorX`/`mirrorY` sat in the catalog unused until the first flash of the
// diagnostic screen came out mirrored (2026-10-05), so this walks *all* of it rather than the CYD alone.
test('the panel orientation comes from the board data, for every panel', () => {
    for (const board of BOARDS.filter(isEspBoard)) {
        for (const panel of board.displays) {
            const main = filesFor(board, 'display', { panel: panel.panelChoice }).get('src/main.rs');
            const expected = `.orientation(Orientation::new()`
                + `${panel.mirrorX ? '.flip_horizontal()' : ''}${panel.mirrorY ? '.flip_vertical()' : ''})`;
            contains(main, expected, `${board.id} ${panel.label}`);
            contains(main, 'use mipidsi::options::{ColorOrder, Orientation};');
        }
    }
    // and the data itself still says what the hardware showed: the CYD's X axis is mirrored.
    const cyd = displayFor(espBoard('sunton-3248s035r'), {});
    equal(cyd.mirrorX, true, 'the CYD panel mirrors X');
    equal(cyd.mirrorY, false, 'and not Y');
    const tqt = displayFor(espBoard('lilygo-tqt'), {});
    equal(tqt.mirrorX, false, 'the T-QT needs no flip');
});

// The diagnostic screen is offered to a 128x128 panel as well as the 3.5" CYD, so its geometry is solved
// from the panel size. These are the properties that make the numbers safe to emit: everything inside the
// frame, every band below the one before it, and nothing under the blinking square.
test('the diagnostic layout fits the glass it is drawn on', () => {
    for (const board of BOARDS.filter(isEspBoard)) {
        for (const panel of board.displays) {
            const layout = espDiagnosticLayout(panel, board);
            const where = `${board.id} ${panel.label}`;
            const inside = (x, y, w, h, what) => {
                ok(x >= 0 && y >= 0, `${where}: ${what} starts off the panel`);
                ok(x + w <= layout.width && y + h <= layout.height, `${where}: ${what} runs off the panel`);
            };

            inside(1, 1, layout.width - 2, layout.height - 2, 'the frame');
            equal(layout.barY, layout.cornerSize + 6, `${where}: the bars start below the corners`);
            inside(layout.margin, layout.barY, 5 * layout.barWidth + 4 * layout.barGap, layout.barHeight, 'the bars');
            inside(layout.greetingX, layout.greetingY,
                13 * (layout.greetingFont === 'FONT_10X20' ? 10 : 6),
                layout.greetingFont === 'FONT_10X20' ? 20 : 10, 'the greeting');

            // The text bands, then the blinking square, in that order and never overlapping.
            let line = layout.statusY;
            for (const text of layout.statusLines) {
                ok(text.length * 6 + layout.statusX <= layout.width, `${where}: "${text}" is wider than the panel`);
                ok(line >= layout.greetingY + 10, `${where}: status text overlaps the greeting`);
                ok(line + 10 <= layout.blinkY - 2, `${where}: "${text}" runs into the blinking square`);
                line += layout.statusStep;
            }
            inside(layout.blinkX, layout.blinkY, layout.blinkSize, layout.blinkSize, 'the blinking square');
            ok(layout.blinkY + layout.blinkSize <= layout.height - layout.cornerSize,
                `${where}: the blinking square overlaps the bottom corner markers`);
            ok(layout.statusLines.length > 0, `${where}: at least one status line has to fit`);
        }
    }
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
    contains(readme, 'TF card', 'the board\'s own features belong in its notes');
    contains(readme, 'XPT2046', 'including the touch controller it shares the bus with');
    contains(readme, 'BUSY', 'and that its BUSY pin is not wired, which is why the driver waits');
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
    // The board used to be called `Sunton ESP32-3248S035R (3.5" CYD)`, and that quote broke the generated
    // log line until the generator started escaping it. No shipped board name has a quote any more, so this
    // walks whatever the catalog does say rather than relying on one of them being adversarial.
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

// The touch template: panel bring-up with the XPT2046 sharing the bus, a four-corner calibration, and a
// crosshair where the firmware thinks the finger is. Everything asserted here was checked against the
// datasheet-derived reference implementations and against two independent configurations for this exact
// board family; **none of it has worked on the one CYD we have**, whose controller never responds to a
// touch (NOTES §57). So these hold the shape of the code, not a working touch screen.
test('the touch template shares the panel bus and speaks the XPT2046 protocol', () => {
    const main = filesFor(espBoard('sunton-3248s035r'), 'touch').get('src/main.rs');
    const touch = espBoard('sunton-3248s035r').touch;
    const cargo = filesFor(espBoard('sunton-3248s035r'), 'touch').get('Cargo.toml');

    // The bus goes into a RefCell and each chip gets its own device, with its own chip select.
    contains(main, 'use core::cell::RefCell;');
    contains(main, 'let bus = RefCell::new(spi);');
    contains(main, 'RefCellDevice::new(&bus, cs, Delay::new())');
    contains(main, `RefCellDevice::new(&bus, touch_cs, Delay::new())`);
    notContains(main, 'ExclusiveDevice', 'one bus, two devices: the exclusive adapter cannot express that');
    contains(cargo, 'embedded-hal-bus');
    contains(cargo, 'embedded-hal = "1.0.0"', 'the read helper is generic over SpiDevice, so the trait is named');

    // The pins come from the board data, not from the template.
    contains(main, `Output::new(peripherals.GPIO${touch.cs}, Level::Low`);
    contains(main, `Input::new(peripherals.GPIO${touch.irq}, InputConfig::default().with_pull(Pull::Up))`);

    // The controller's clock is its own, and the bus is switched around each burst.
    contains(main, `Rate::from_khz(${Math.round(touch.spiHz / 1000)})`);
    contains(main, 'apply_config(&touch_clock()).expect("touch clock")');
    contains(main, 'apply_config(&panel_clock()).expect("panel clock")');

    // Control bytes from the datasheet: two axes, and the power-down command that re-enables PENIRQ.
    contains(main, 'const TOUCH_AXIS_A: u8 = 0xD1;');
    contains(main, 'const TOUCH_AXIS_B: u8 = 0x91;');
    contains(main, 'const TOUCH_POWER_DOWN: u8 = 0xD0;');
    // The result arrives one command behind and is nibble-aligned; the common shift-by-three decode is
    // eight times too small, which is how the first corner read 14 counts instead of 2050.
    contains(main, 'fn touch_frame<D: SpiDevice>');
    contains(main, '(((frame >> 8) & 0x00FF) << 4) | ((frame & 0x00FF) >> 4)');
    contains(main, 'fn touch_idle<D: SpiDevice>');
});

test('a touch is the axes moving, never the interrupt line on its own', () => {
    const main = filesFor(espBoard('sunton-3248s035r'), 'touch').get('src/main.rs');

    // Measured: the interrupt line reads low with nothing near the glass, and every phantom tap arrived
    // with both axes still on their idle values -- it walked the calibration through all four corners by
    // itself. A touch is the axes moving, and the interrupt is logged next to it rather than OR-ed in.
    contains(main, 'pressed = (raw_a - idle_a).abs() > TOUCH_MOVE || (raw_b - idle_b).abs() > TOUCH_MOVE;');
    notContains(main, 'irq ||');
    contains(main, '"touch test alive: a={} b={} idle a={} b={} pen={}",',
        'the interrupt is still logged, just not trusted');
});

test('the touch template asks for the four corners and says what it measured', () => {
    const main = filesFor(espBoard('sunton-3248s035r'), 'touch').get('src/main.rs');

    contains(main, 'let corners = ["top-left", "top-right", "bottom-right", "bottom-left"];');
    // The calibration screen: a red block per corner with a crosshair in it, one lit at a time, and the
    // graphics test screen back afterwards.
    contains(main, 'Touch the crosshair in the bright block');
    contains(main, 'Touch: numbers below, and the log');
    // The calibration starts from whatever the flash sector holds, so a calibrated panel never sees this
    // screen again; the fourth corner ends it either way.
    contains(main, 'let mut calibrated = stored.is_some();');
    contains(main, 'calibrated = true;', 'the fourth corner ends the calibration');
    contains(main, 'FlashStorage::new(peripherals.FLASH)', 'and the values are read back at boot');
    contains(main, 'flash.write(CALIBRATION_OFFSET, &bytes)', 'and written once the fourth corner lands');
    contains(main, 'const CALIBRATION_OFFSET: u32 = 0x3F_F000', 'in the sector the application partition leaves free');
    contains(main, 'if !calibrated {', 'the calibration screen is the first thing shown');
    // And the live readout the panel shows while a finger is down.
    contains(main, 'raw a={} b={}', 'the raw pair');
    contains(main, 'x={} y={}', 'the mapped pair');
    contains(main, 'BOX_X: i32 =', 'the readout sits in the middle of the panel');
    contains(main, 'TOUCH_REPAINT', 'and only repaints when the numbers move');
    // The readout is cleared before it is drawn: the numbers change length, and a fill followed by the border
    // is the order that neither leaves the old reading behind nor eats half the border.
    contains(main, 'PrimitiveStyle::with_fill(Rgb565::BLACK)');
    contains(main, 'the other order erases half its width');
    contains(main, '"calibration: raw axis{} {}..{} and axis{} {}..{} over {}x{}"',
        'the numbers a user can report back');
    contains(main, 'frames a=[{:04X} {:04X} {:04X}] b=[{:04X} {:04X} {:04X}]',
        'the raw frames, which is what identified the fault');
    // The axis choice is worked out from the corners, not assumed.
    contains(main, 'raw_x_axis = if delta_a >= delta_b { 0 } else { 1 };');
    contains(main, 'TOUCH_MOVE: i32 = 200');
});

// The sensors and sound template. Both halves exist because of *this board's* wiring rather than a generic
// demo: an LDR that is the lower leg of a divider, and a speaker on a DAC channel with no PWM in sight.
test('the peripherals template reads the LDR and drives the DAC the board actually wires', () => {
    const files = filesFor(espBoard('sunton-3248s035r'), 'peripherals');
    const main = files.get('src/main.rs');
    const cargo = files.get('Cargo.toml');

    contains(main, 'use esp_hal::analog::adc::{Adc, AdcConfig, Attenuation};');
    contains(main, 'enable_pin(peripherals.GPIO34, Attenuation::_11dB)', 'the LDR pin, at full range');
    contains(main, 'adc.read_oneshot(&mut light)', 'an ADC read, not a digital one');
    contains(main, 'use esp_hal::analog::dac::Dac;');
    contains(main, 'Dac::new(peripherals.DAC2, peripherals.GPIO26)', 'the speaker is DAC channel 2');
    // The polarity is the thing that looks like a broken sensor if it is assumed backwards.
    contains(main, 'brighter light reads lower on this board');
    // And the feature that makes the analog modules visible at all.
    contains(cargo, '"unstable"', 'the ADC and DAC are behind esp-hal\'s unstable feature');
    contains(cargo, '"esp32"', 'alongside the chip feature it has always had');
});

// The board template is the touch template plus the rest of the board's hardware, in one firmware. It exists
// because that is how the user wants to select features -- one project per board, not one project per
// peripheral -- so what matters is that all of it is actually in there and that nothing is duplicated.
test('the board template has the panel, touch, the LED, the sensor and the speaker', () => {
    const files = filesFor(espBoard('sunton-3248s035r'), 'board');
    const main = files.get('src/main.rs');
    const cargo = files.get('Cargo.toml');

    // The panel and touch half, same as the touch template.
    contains(main, 'Builder::new(models::ST7796');
    contains(main, 'XPT2046 on GPIO33 (cs), GPIO36 (irq)');
    contains(main, 'Touch the crosshair in the bright block');
    contains(main, 'Touch: numbers below, and the log');
    // And the rest of the board.
    contains(main, 'LED::Low'.replace('LED::', 'Level::'), 'the RGB LED is driven');
    contains(main, 'let mut led_red = Output::new(peripherals.GPIO4');
    contains(main, 'let mut led_green = Output::new(peripherals.GPIO17');
    contains(main, 'let mut led_blue = Output::new(peripherals.GPIO16');
    contains(main, 'adc.read_oneshot(&mut light)', 'the light sensor is read');
    contains(main, 'Dac::new(peripherals.DAC2, peripherals.GPIO26)', 'and the speaker is driven');
    contains(main, 'board hardware: RGB LED, LDR on GPIO34, speaker on GPIO26');
    // The speaker answers every touch, not only a recorded corner: with the calibration kept in flash, a
    // calibrated board never records a corner again, so a corner-only beep left the amplifier untestable.
    contains(main, 'macro_rules! beep');
    contains(main, 'beep!(speaker, 40);', 'a short reply to any touch');
    contains(main, 'beep!(speaker, 200);', 'and a longer confirmation at a corner');
    // The dependencies the analog half needs.
    contains(cargo, '"unstable"');
    contains(cargo, 'embedded-hal = "1.0.0"');
    contains(cargo, 'mipidsi');

    // The touch template must not have grown the board hardware: the two are separate choices.
    const touch = filesFor(espBoard('sunton-3248s035r'), 'touch').get('src/main.rs');
    notContains(touch, 'led_red', 'the touch template stays touch-only');
    notContains(touch, 'read_oneshot');
    notContains(touch, 'Dac::new');
});

// The TF card template. Built on embedded-sdmmc rather than a hand-rolled SD SPI sequence: the init handshake
// is easy to get subtly wrong, and even done perfectly it leaves raw sectors rather than a filesystem.
test('the TF card template mounts the card on the socket the board wires', () => {
    const files = filesFor(espBoard('sunton-3248s035r'), 'sdcard');
    const main = files.get('src/main.rs');
    const cargo = files.get('Cargo.toml');
    const sd = espBoard('sunton-3248s035r').sd;

    contains(main, 'use embedded_sdmmc::{SdCard, TimeSource, Timestamp, VolumeIdx, VolumeManager};');
    contains(cargo, 'embedded-sdmmc', 'the filesystem crate is the dependency');
    contains(cargo, 'embedded-hal-bus', 'and the bus-to-device adapter the card needs');
    // The socket's pins, from the board data: CS, CLK, CMD (MOSI) and DAT0 (MISO).
    contains(main, `with_sck(peripherals.GPIO${sd.spi.sclk})`);
    contains(main, `with_mosi(peripherals.GPIO${sd.spi.mosi})`);
    contains(main, `with_miso(peripherals.GPIO${sd.spi.miso})`);
    contains(main, `Output::new(peripherals.GPIO${sd.cs}, Level::Low`);
    // 400 kHz: the clock a card is specified to initialise at, and the one it is read at here.
    contains(main, 'Rate::from_khz(400)');
    contains(main, 'SdCard::new(card, Delay::new())');
    contains(main, 'card.num_bytes()');
    contains(main, 'VolumeManager::new(card, FixedClock)');
    // The raw API throughout: one handle for the open, the listing and the close.
    contains(main, 'volumes.open_raw_volume(VolumeIdx(0))');
    contains(main, 'volumes.open_root_dir(volume)');
    contains(main, 'volumes.iterate_dir(directory, |entry|');
    contains(main, 'entry.name, entry.size');
    contains(main, 'volumes.close_dir(directory)');
    // The crate counts years from 1970 and indexes months and days from zero.
    contains(main, 'year_since_1970: 56');
    contains(main, 'zero_indexed_month: 0');
    contains(main, 'impl TimeSource for FixedClock', 'the clock the filesystem wants, defined where it is used');
});
