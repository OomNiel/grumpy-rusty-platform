'use strict';

/**
 * The three Pico panel templates, as the generator emits them.
 *
 * The firmware itself is proved by compiling it (a generated project for thumbv6m and thumbv8m, warning-free),
 * which a t1 test cannot do. What is asserted here is the part a compiler would *accept* while being wrong:
 * which pins reach which peripheral, that a module's own facts (model, colour order, size) travel into
 * `src/panel.rs`, that the card and the radio are wired the way the hardware asks for, and that a wiring the
 * validator refuses never reaches a project at all.
 */

const { test, ok, notOk, equal, contains, notContains, sketchSource } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const { boardById } = compiled('boards/catalog');
const { defaultWiring, panelModule, parseWiring, validateWiring, wiringFile } = compiled('boards/panels');
const { generateProjectFiles, templatesFor } = compiled('generate/files');
const { DESIGNER_FILES } = compiled('designer/generate');
const { DESIGNER_HARDWARE_PATH } = compiled('designer/model');

const BOARDS = ['pico', 'pico2', 'picow', 'pico2w'];

/** One generated project's files, keyed by path. */
function project(boardId, template, options = {}) {
    const board = boardById(boardId);
    const files = generateProjectFiles({
        board,
        projectName: 'panelprobe',
        template,
        wiring: options.wiring ?? defaultWiring(board, options.panel ?? 'ili9341'),
        rotation: options.rotation ?? 0,
        clockOffsetMinutes: 120,
        ...options.extra,
    });
    return new Map(files.map((file) => [file.path, file.content]));
}

/**
 * The loop paints what the damage says, and only that.
 *
 * Regression (bench, 2026-10-27): the generated loop called `repaint`, which paints the whole screen
 * *without* filling the damaged rectangles first. A clock draws its hands straight onto the panel and has no
 * opaque face of its own, so every tick drew the new hands and left the old ones on the glass -- a smear that
 * only the Pico templates had, because the ESP32 loop already rendered the damage.
 */
test('the loop renders the damaged rectangles, so a moving clock hand erases the one before it', () => {
    for (const id of BOARDS) {
        const main = project(id, 'designer').get('src/main.rs');
        // setup() paints the whole screen once, on a panel that has just been cleared.
        const loop = main.slice(main.indexOf('async fn main('));
        ok(main.slice(0, main.indexOf('async fn main(')).includes('.repaint(&mut hardware.display)'), `${id} paints the first frame whole`);
        contains(loop, '.render(&mut state.hardware.display)', `${id} renders what changed`);
        // The frame's own paint is the one that must honour the damage. `repaint` is allowed in the loop only
        // where something has cleared the glass underneath the design -- the touch calibration screen does --
        // and that is a deliberate repaint of the whole thing, not the per-frame path.
        const frame = loop.slice(loop.indexOf('if state.design.is_dirty()'));
        contains(frame.slice(0, 400), '.render(&mut state.hardware.display)', `${id} renders the damaged rectangles`);
        notContains(frame.slice(0, 400), '.repaint(', `${id}: a whole-screen paint every frame leaves the old hands behind`);
    }
});

/**
 * The touch controller on a panel's own SPI bus.
 *
 * Regressions from the bench, 2026-10-28: nothing happened when the glass was touched, for two reasons that
 * had nothing to do with each other. An XPT2046 converts in its own time and cannot be clocked at the speed
 * the panel runs at, so every frame came back as noise; and a turned panel addresses its pixels transposed,
 * so even a good reading landed somewhere else.
 */
test('a touch reading runs the bus at the controller\'s own clock, not the panel\'s', () => {
    const panel = project('pico2w', 'designer').get('src/panel.rs');
    contains(panel, 'const TOUCH_CLOCK_HZ: u32 = 1_000_000;');
    // Slowed for the reading, put back after it: the glass keeps its tens of megahertz.
    contains(panel, 'set_frequency(TOUCH_CLOCK_HZ)');
    contains(panel, 'set_frequency(PANEL_CLOCK_HZ)');
    // The device has to be able to reach the bus to change it, so the touch holds it as well as the CS pin.
    contains(panel, 'bus: &\'static PanelBus,');
    contains(panel, 'Touch { device: touch_device, bus, irq: touch_irq, idle: (0, 0), down: false }');
    // The conversion delay has to stay between the command and its data, or the controller reads mid-scale.
    contains(panel, 'Operation::DelayNs(TOUCH_SETTLE_NS)');
});

/**
 * How a finger is detected.
 *
 * Regression (bench, 2026-10-28): the first version asked the controller's pressure channel. On these modules
 * that reading sits near full scale whether or not anything is touching, so the driver believed a finger was
 * down for ever -- the calibration screen was drawn and then sat waiting for a finger to *leave* that was
 * never there. The ESP32 templates have never used a pressure channel: a touch is the axes moving away from
 * where they rest.
 */
test('a touch is the axes moving off their idle baseline, not a pressure channel', () => {
    const panel = project('pico2w', 'designer').get('src/panel.rs');
    contains(panel, 'const TOUCH_MOVE: i32 = 200;');
    contains(panel, 'fn read_raw_at_speed(&mut self) -> Option<(i32, i32)>');
    contains(panel, '(raw_a - self.idle.0).abs() > TOUCH_MOVE');
    contains(panel, '(raw_b - self.idle.1).abs() > TOUCH_MOVE');
    // The baseline is measured once, at start-up, before anything can be touched by accident.
    contains(panel, 'touch.measure_idle();');
    contains(panel, 'fn measure_idle(&mut self) {');
    contains(panel, 'info!("touch: idle baseline a={} b={}", idle_a, idle_b);');
    // And the pressure channel is gone: no command byte, no threshold on it.
    notContains(panel, 'TOUCH_PRESSURE');
    notContains(panel, '0xB1');
});

/**
 * What the bench needs to be told when the glass stays silent.
 *
 * A controller that is not being read and a controller nobody has touched look the same from the loop, so the
 * firmware has to say which it is: a baseline pegged at a rail means the data line is not coming back, and that
 * is a wiring answer, not a software one.
 */
test('the firmware says when the controller is not answering, instead of waiting for ever', () => {
    const panel = project('pico2w', 'designer').get('src/panel.rs');
    contains(panel, 'if (idle_a == 0 && idle_b == 0) || (idle_a >= 0x0FFF && idle_b >= 0x0FFF) {');
    contains(panel, 'it is not answering');
    // Each press and release is logged with the raw pair, and only on the edge.
    contains(panel, 'if pressed != self.down {');
    contains(panel, '"touch: {} a={} b={} (idle a={} b={})"');
    // The calibration cannot hang: one budget for a corner nobody touches, one for a glass that reads pressed.
    contains(panel, 'no reading at the {} corner after a minute');
    contains(panel, 'the glass reads as pressed with nothing on it');
});

test('a touch reading is turned into the drawing area the design is laid out in', () => {
    const panel = project('pico2w', 'designer').get('src/panel.rs');
    contains(panel, 'fn touch_to_draw_area(column: i32, row: i32) -> (i32, i32) {');
    // One arm per rotation, each the inverse of the panel driver's own addressing: a landscape build has the
    // glass's columns in the design's rows.
    contains(panel, 'if ROTATION == Rotation::Deg0 {');
    contains(panel, 'if ROTATION == Rotation::Deg90 {');
    contains(panel, 'if ROTATION == Rotation::Deg180 {');
    contains(panel, '(last_row - row, column)');
    contains(panel, 'Some(touch_to_draw_area(column, row))');
});

test('a build with no touch controller carries none of the driver', () => {
    // The 1.54" module has no controller at all: the whole XPT2046 block folds away.
    const panel = project('pico2w', 'designer', { panel: 'st7789' }).get('src/panel.rs');
    notContains(panel, 'TOUCH_CLOCK_HZ');
    notContains(panel, 'set_frequency(TOUCH_CLOCK_HZ)');
});

/**
 * The touch calibration: asked for on the first run, kept in the flash the board reserves.
 *
 * The raw counts an XPT2046 gives differ from glass to glass, and which of its axes follows the design's X
 * depends on how the module was wired, so the corners are measured rather than assumed -- which needs
 * somewhere to keep the answer across a power cycle, and a Pico has no NVS.
 */
test('the calibration is asked for on the first run, before the design is drawn', () => {
    const main = project('pico2w', 'designer').get('src/main.rs');
    const calibrateAt = main.indexOf('panel::calibrate(&mut hardware).await');
    const designAt = main.indexOf('ui::Designer::new');
    ok(calibrateAt !== -1, 'the corners are asked for');
    ok(designAt !== -1, 'the design is built');
    ok(calibrateAt < designAt, 'the corners come first: the mapping is what makes a pointer possible');
    contains(main, 'if hardware.calibration.is_none() {');
});

test('the corner screen measures the four corners and keeps the result in the reserved flash', () => {
    const panel = project('pico2w', 'designer').get('src/panel.rs');
    // The record: which raw axis follows the design's X, the counts at each end of both axes, and the
    // rotation it was measured for.
    contains(panel, 'pub struct TouchCalibration {');
    contains(panel, 'pub fn pixel(&self, raw_a: i32, raw_b: i32) -> Option<(i32, i32)>');
    contains(panel, '"top-left"');
    contains(panel, '"bottom-right"');
    // The flash: the record lives at the start of the region the board reserves, so a write can never reach
    // the application. 4 MB board -> 1 MB reserved at 0x10300000.
    contains(panel, 'const TOUCH_CAL_OFFSET: u32 = 0x300000;');
    contains(panel, 'const FLASH_BYTES: usize = 4194304;');
    contains(panel, 'flash.blocking_erase(TOUCH_CAL_OFFSET, TOUCH_CAL_OFFSET + TOUCH_CAL_SECTOR)');
    contains(panel, 'flash.blocking_write(TOUCH_CAL_OFFSET, &bytes)');
    contains(panel, 'pub fn forget_calibration(flash: &mut PanelFlash) -> bool');
    // A 2 MB board reserves 512 KB at 0x10180000, and the driver still wants the whole capacity.
    const small = project('pico', 'designer').get('src/panel.rs');
    contains(small, 'const TOUCH_CAL_OFFSET: u32 = 0x180000;');
    contains(small, 'const FLASH_BYTES: usize = 2097152;');
});

test('the design\'s pointer comes from the calibration, never from a guess', () => {
    const main = project('pico2w', 'designer').get('src/main.rs');
    contains(main, 'panel::touch_point(&mut state.hardware)');
    // The default-mapping `sample()` is for the diagnostic templates only: a design must not fall back to
    // numbers that are one panel's guess.
    notContains(main, 'touch.sample()');
});

test('a held top-left corner throws the calibration away and measures it again', () => {
    const main = project('pico2w', 'designer').get('src/main.rs');
    contains(main, 'const CORNER_HOLD_BOX: i32 = 40;');
    contains(main, 'const CORNER_HOLD_SAMPLES: u32 = 50;');
    contains(main, 'panel::forget_calibration(&mut state.hardware.flash)');
    contains(main, 'state.hardware.calibration = None;');
    contains(main, 'state.design.repaint(&mut state.hardware.display)');
});

test('a project whose module has no controller carries no calibration at all', () => {
    const files = project('pico2w', 'designer', { panel: 'st7789' });
    const panel = files.get('src/panel.rs');
    const main = files.get('src/main.rs');
    notContains(panel, 'TouchCalibration');
    notContains(panel, 'TOUCH_CAL_OFFSET');
    notContains(main, 'panel::calibrate');
    notContains(main, 'CORNER_HOLD_BOX');
});

test('every Pico offers the three panel templates', () => {
    for (const id of BOARDS) {
        const ids = templatesFor(boardById(id)).map((info) => info.id);
        for (const template of ['designer', 'display', 'sdcard']) {
            ok(ids.includes(template), `${id} offers ${template}`);
        }
    }
});

test('a designer project carries the design, the hardware and the card', () => {
    const files = project('pico2w', 'designer');
    for (const path of [
        'src/panel.rs',
        'src/sd.rs',
        'src/net.rs',
        DESIGNER_FILES.markup,
        DESIGNER_FILES.rust,
        DESIGNER_FILES.handlers,
        DESIGNER_FILES.document,
        DESIGNER_FILES.manifest,
        DESIGNER_HARDWARE_PATH,
    ]) {
        ok(files.has(path), `a designer project has ${path}`);
    }
    // The wiring the wizard started from is the file the Designer reads back: one source of pins.
    const wiring = parseWiring(JSON.parse(files.get(DESIGNER_HARDWARE_PATH)), boardById('pico2w'));
    equal(wiring.notes, []);
    equal(wiring.wiring.panel, 'ili9341');
});

test('the diagnostic and the card test do not drag the design runtime in', () => {
    const display = project('pico2w', 'display');
    notOk(display.has(DESIGNER_FILES.rust), 'no ui.rs in a diagnostic project');
    notOk(display.has('src/sd.rs'), 'the diagnostic mounts no filesystem');
    contains(display.get('Cargo.toml'), 'mipidsi = "0.10.0"');
    notContains(display.get('Cargo.toml'), 'embedded-gui');
    notContains(display.get('Cargo.toml'), '[patch.crates-io]');

    const card = project('pico2w', 'sdcard');
    ok(card.has('src/sd.rs'));
    // The card *test* needs the mount, not the image reader: that one needs the vendored widget crate.
    notContains(card.get('src/sd.rs'), 'rusty_gui_widgets');
    contains(card.get('src/sd.rs'), 'pub fn list_root()');
});

test('the designer\'s manifest vendors the runtime and switches the two features', () => {
    const files = project('pico2w', 'designer');
    const cargo = files.get('Cargo.toml');
    contains(cargo, 'embedded-gui = { version = "0.2.7"');
    contains(cargo, 'rusty-gui-widgets = { path = "codegen/rusty-gui-widgets"');
    contains(cargo, '[patch.crates-io]');
    contains(cargo, 'sd = ["dep:embedded-sdmmc"]');
    contains(cargo, 'time-wifi = []');
    contains(cargo, 'default = ["sd", "time-wifi"]');
    // The stack's DNS and UDP support is what the SNTP query needs, and only a designer project asks.
    contains(cargo, '"dns", "udp"');
});

test('a Pico with no radio gets no net module and no Wi-Fi feature', () => {
    const files = project('pico', 'designer');
    notOk(files.has('src/net.rs'));
    notContains(files.get('Cargo.toml'), 'time-wifi');
    notContains(sketchSource([...files].map(([path, content]) => ({ path, content }))), 'mod net;');
    // The clock still works: it starts at the build time, which is what a board with no network has.
    contains(files.get('src/MainHeader.rs'), 'BUILD_EPOCH');
});

test('the panel module reaches src/panel.rs: model, size, colour order and clock', () => {
    const files = project('pico2w', 'designer', { panel: 'st7796' });
    const panel = files.get('src/panel.rs');
    contains(panel, 'models::ST7796');
    contains(panel, 'pub const PANEL_WIDTH: u16 = 320;');
    contains(panel, 'pub const PANEL_HEIGHT: u16 = 480;');
    contains(panel, '.color_order(ColorOrder::Bgr)');
    contains(panel, '.flip_horizontal()');
    contains(panel, 'const PANEL_CLOCK_HZ: u32 = 24_000_000;');
    // The wiring's own numbers, as tokens and as documented constants.
    contains(panel, 'pub const PIN_SCLK: u8 = 18;');
    contains(panel, 'Spi::new_blocking(');
    contains(panel, 'p.PIN_18,');
    contains(panel, 'p.PIN_19,');
    contains(panel, 'p.PIN_16,');
    contains(panel, 'CriticalSectionDevice::new(bus, panel_cs, Delay)');
});

test('the drawing area follows the rotation, because mipidsi swaps it itself', () => {
    const portrait = project('pico2w', 'designer', { panel: 'st7796', rotation: 0 }).get('src/panel.rs');
    contains(portrait, 'pub const DRAW_WIDTH: u16 = if LANDSCAPE { PANEL_HEIGHT } else { PANEL_WIDTH };');
    const landscape = project('pico2w', 'designer', { panel: 'st7796', rotation: 1 }).get('src/panel.rs');
    contains(landscape, 'pub const DRAW_HEIGHT: u16 = if LANDSCAPE { PANEL_WIDTH } else { PANEL_HEIGHT };');
    // The number itself is a compile-time setting, so turning the glass never rewrites the file.
    contains(landscape, 'option_env!("LCD_ROTATION")');
    contains(project('pico2w', 'designer', { rotation: 1 }).get('.cargo/config.toml'), 'LCD_ROTATION = "1"');
});

test('a touchless module gets no touch driver at all', () => {
    const files = project('pico', 'display', { panel: 'st7789' });
    const panel = files.get('src/panel.rs');
    notContains(panel, 'XPT2046');
    notContains(panel, 'pub struct Touch');
    notContains(panel, 'Operation::Write');
    contains(panel, 'pub touch: Option<()>');
    // ... and a touch module gets one, with both of its pins.
    const withTouch = project('pico', 'display', { panel: 'ili9341' }).get('src/panel.rs');
    contains(withTouch, 'pub struct Touch');
    contains(withTouch, 'const TOUCH_AXIS_A: u8 = 0xD1;');
    contains(withTouch, 'p.PIN_14,');
    contains(withTouch, 'p.PIN_15,');
});

test('the card on its own pins gets a second SPI peripheral; on the panel\'s it gets a chip select', () => {
    const separate = project('pico2w', 'designer', { panel: 'ili9341' }).get('src/panel.rs');
    contains(separate, 'ExclusiveDevice::new(card_spi, card_cs, Delay)');
    contains(separate, 'p.SPI1,');
    contains(separate, 'pub const PIN_CARD_CS: u8 = 13;');

    // The same three data pins as the panel: one bus, one more chip select.
    const board = boardById('pico2w');
    const wiring = { ...defaultWiring(board, 'ili9341'), sdSclk: 18, sdMosi: 19, sdMiso: 16, sdCs: 13 };
    const shared = project('pico2w', 'designer', { wiring }).get('src/panel.rs');
    contains(shared, 'CriticalSectionDevice::new(bus, card_cs, Delay)');
    notContains(shared, 'ExclusiveDevice');
});

test('the backlight is PWM on the slice its pin belongs to', () => {
    // GPIO22 is slice 3 channel A; GPIO1 is slice 0 channel B. The HAL enforces the pair, so a wrong one
    // would not build -- this is the other half: that the emitter derives it from the wiring at all.
    const on22 = project('pico2w', 'designer').get('src/panel.rs');
    contains(on22, 'Pwm::new_output_a(\n        p.PWM_SLICE3,');
    contains(on22, "pub type Backlight = Pwm<'static>;");
    const board = boardById('pico2w');
    const onOne = project('pico2w', 'designer', { wiring: { ...defaultWiring(board), backlight: 1 } });
    contains(onOne.get('src/panel.rs'), 'Pwm::new_output_b(\n        p.PWM_SLICE0,');
    // No BL pin, no channel and no slider.
    const noBl = project('pico2w', 'designer', { wiring: { ...defaultWiring(board), backlight: null } });
    notContains(noBl.get('src/panel.rs'), 'Pwm::new_output_');
    contains(noBl.get('src/panel.rs'), 'pub backlight: Option<()>');
});

test('the radio\'s own pins come back in Rest rather than being taken by the panel', () => {
    const wireless = project('pico2w', 'designer').get('src/panel.rs');
    contains(wireless, 'pub struct Rest {');
    contains(wireless, 'pub pin23: Peri<\'static, PIN_23>,');
    contains(wireless, 'pub pio0: Peri<\'static, PIO0>,');
    contains(wireless, 'pub dma_ch0: Peri<\'static, DMA_CH0>,');
    // One DMA channel, never two: cyw43-pio 0.10 pumps everything through a single one.
    notContains(wireless, 'DMA_CH1');
    // A plain Pico has nothing outside the panel, and gets the empty struct.
    contains(project('pico', 'display').get('src/panel.rs'), 'pub struct Rest;');
});

test('the firmware\'s entry point is one call, and main.rs never names a display pin', () => {
    for (const id of BOARDS) {
        const files = project(id, 'designer');
        const main = files.get('src/main.rs');
        const header = files.get('src/MainHeader.rs');
        contains(main, 'let (mut hardware, rest) = panel::init(p);');
        for (const pin of ['PIN_18', 'PIN_19', 'PIN_17', 'PIN_20', 'PIN_22']) {
            notContains(main, pin, `${id}: main.rs names no display pin`);
            notContains(header, pin, `${id}: the header names no display pin`);
        }
        contains(main, 'ui::Designer::new(');
        contains(main, 'panel::DRAW_WIDTH as u32');
    }
});

test('a wiring the validator refuses never becomes a project', () => {
    const board = boardById('pico2w');
    const broken = { ...defaultWiring(board), sclk: 19 };
    let message = '';
    try {
        generateProjectFiles({ board, projectName: 'broken', template: 'designer', wiring: broken });
    } catch (error) {
        message = String(error.message ?? error);
    }
    contains(message, 'not usable');
    contains(message, 'GPIO19 is not an SPI clock pin');
    ok(validateWiring(board, broken).some((problem) => problem.severity === 'error'));
});

test('the hardware file the generator writes reads back unchanged', () => {
    const files = project('pico', 'designer', { panel: 'st7796' });
    const text = files.get(DESIGNER_HARDWARE_PATH);
    equal(wiringFile(parseWiring(JSON.parse(text), boardById('pico')).wiring), text);
});

test('a design with a clock and a radio starts from the build time and is corrected over Wi-Fi', () => {
    const files = project('picow', 'designer');
    const main = files.get('src/main.rs');
    contains(main, 'let (hour, minute, second) = boot_time();');
    contains(main, 'state.design.set_wall_clock(hour, minute, second);');
    contains(main, 'net::SYNCED_TIME.try_take()');
    contains(main, '#[cfg(feature = "time-wifi")]');
    // The task is spawned only with the feature, because the radio can only be moved once per boot.
    contains(main, 'spawner.spawn(unwrap!(net::time_task(rest)));');
    contains(files.get('src/net.rs'), 'pool.ntp.org');
    contains(files.get('src/net.rs'), '2_208_988_800');
});

test('the card test paints an answer and logs the number', () => {
    const files = project('pico2w', 'sdcard');
    const main = files.get('src/main.rs');
    contains(main, 'sd::card_bytes()');
    contains(main, 'Rgb565::CSS_GREEN');
    contains(main, 'sdcard: no card answered');
});

test('the panel templates keep the sketch shape and its guidance', () => {
    for (const template of ['designer', 'display', 'sdcard']) {
        const files = project('pico2w', template);
        const sketch = sketchSource([...files].map(([path, content]) => ({ path, content })));
        contains(sketch, 'pub async fn setup(spawner: Spawner) -> State', `${template}: setup()`);
        contains(sketch, '#[embassy_executor::main', `${template}: the entry point`);
        contains(sketch, 'Your own code goes below this line', `${template}: where the user writes`);
        contains(sketch, 'is called from the loop with', `${template}: and how it is called`);
        contains(sketch, 'has to be pub', `${template}: and the header's visibility rule`);
    }
});

test('a module label with a quote in it cannot break the generated Rust', () => {
    // The 2.8" ILI9341 label carries a `"`, and it is printed in an info! line: unescaped, it ends the
    // string literal and the compile error appears somewhere else entirely.
    const panel = project('pico2w', 'display', { panel: 'ili9341' }).get('src/panel.rs');
    contains(panel, 'Generic 2.8\\" TFT SPI ILI9341');
    equal(panelModule('ili9341').label.includes('"'), true);
});

test('the build time is a line the firmware can read, and a no-op build leaves the file alone', () => {
    const { configHasBuildEpoch, configHasEpochSecond, setBuildEpochInConfig } = compiled('display/buildEpoch');
    const config = '<CARGO>\n[env]\nDEFMT_LOG = "debug"\nRUSTY_EPOCH = "0"\n';
    ok(configHasBuildEpoch(config));
    const stamped = setBuildEpochInConfig(config, 1_790_000_000);
    contains(stamped, 'RUSTY_EPOCH = "1790000000"');
    // Only that one line moves: the rest of the file is the project's.
    contains(stamped, 'DEFMT_LOG = "debug"');
    contains(stamped, '[env]');
    ok(configHasEpochSecond(stamped, 1_790_000_000));
    notOk(configHasEpochSecond(stamped, 1_790_000_001));
    // A project with no such key is not given one: the stamp is for a clock design, not for every Pico.
    notOk(configHasBuildEpoch('[env]\nDEFMT_LOG = "debug"\n'));
});

test('a Pico stub is judged by the macro it was written with, and pruned when its event goes', () => {
    const { syncHandlerStubs, RP_LOG_MACRO, ESP_LOG_MACRO } = compiled('designer/generate');
    const { starterDocument } = compiled('designer/generate');
    // The file a project is born with on a Pico, then the design loses its button's event.
    const declared = [
        '// The code behind your design\'s events.',
        '// rusty-designer-handlers',
        '',
        '/// Raised by the design. Called from `ui::Designer::pump`.',
        'pub fn on_go_clicked() {',
        '    defmt::info!("design: on_go_clicked fired");',
        '}',
        '',
    ].join('\n');
    // The same document with nothing on it: the starter design ships a button whose event *is*
    // `on_go_clicked`, which is the case where the stub must stay.
    const document = {
        ...starterDocument({
            boardId: 'pico2w',
            panelWidth: 240,
            panelHeight: 320,
            rotation: 0,
        }),
        widgets: [],
    };
    const untouched = syncHandlerStubs(declared, document, true, RP_LOG_MACRO);
    notContains(untouched, 'on_go_clicked', 'the stub of a lost event is removed');
    contains(untouched, 'rusty-designer-handlers', 'and the file itself stays');

    // The bug (2026-10-27): judged with the ESP spelling, the very same stub looked like the user's own code
    // and was kept for ever -- a `dead_code` warning about a function `src/ui.rs` no longer calls.
    equal(syncHandlerStubs(declared, document, true, ESP_LOG_MACRO), declared);
});

test('the designer hands the code-behind the family\'s own macro', () => {
    // A source-level guard: the pruner takes the macro as an argument, and passing the wrong one is silent.
    const { readFileSync } = require('fs');
    const { repoRoot } = require('../../lib/harness');
    const source = readFileSync(`${repoRoot()}/src/designer/editor.ts`, 'utf8');
    contains(source, "this.wiring === undefined ? ESP_LOG_MACRO : RP_LOG_MACRO");
    contains(source, 'syncHandlerStubs(existing, document, this.touchEnabled, log)');
    // ... and the file is tidied on open, not only on the next save: an orphaned stub warns in the user's
    // crate until something removes it.
    contains(source, 'await current.syncHandlers(document);');
});

/**
 * The Debug button is the one people use on the bench, and a design repaints the whole panel every frame.
 *
 * Rust's dev profile builds *everything* at opt-level 0, dependencies included, so a debug build spends most of
 * a frame inside embedded-graphics' iterator plumbing -- which is why it felt so much slower than a C++ debug
 * build whose libraries ship compiled. The generated manifest tunes it instead.
 */
test('a debug build compiles the libraries optimised, so the panel is not driven at opt-level 0', () => {
    for (const id of BOARDS) {
        const cargo = project(id, 'designer').get('Cargo.toml');
        contains(cargo, '[profile.dev]\nopt-level = 1\ndebug = 2');
        contains(cargo, '[profile.dev.package."*"]\nopt-level = 3');
        // Release keeps its own block: the two profiles must not be merged into one.
        contains(cargo, '[profile.release]');
    }
});

test('the generated defmt level is info, so the libraries do not log every frame', () => {
    const config = project('pico2w', 'designer').get('.cargo/config.toml');
    contains(config, 'DEFMT_LOG = "info"');
    notContains(config, 'DEFMT_LOG = "debug"');
});
