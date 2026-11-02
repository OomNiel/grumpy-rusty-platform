'use strict';

/**
 * The Arduino (C++) generator: what a C++ project is made of, per board and per template.
 *
 * The C++ side has to be right about *hardware* the same way the Rust one is, and wrong in the same visible
 * way when it is not -- a wrong GPIO lights nothing, a wrong colour order turns white into a colour. So these
 * tests pin:
 *
 *   - every board in the catalogue has a board definition the cores actually know (`CPP_FQBN`), and each one
 *     is a FQBN arduino-cli would accept (`package:architecture:board`);
 *   - a sketch's folder, `.ino` and build name are one valid identifier, because Arduino requires it;
 *   - the pins and the controller in `panel.cpp` are the ones the wizard collected, not a second guess;
 *   - the three templates emit what they say: blinky drives the LED, display paints the diagnostic screen,
 *     designer adds the two files the Designer owns plus the handler file a person edits;
 *   - nothing generated needs a library, and every generated file is marked so a person knows what to edit.
 */

const { test, ok, notOk, equal, contains, notContains, throws, compiled } = require('../../lib/harness');
const { BOARDS } = compiled('boards/catalog');
const { arduinoBackend } = compiled('generate/backends');
const { defaultWiring, PANEL_MODULES } = compiled('boards/panels');
const {
    ARDUINO_TEMPLATE_IDS,
    CPP_FQBN,
    corePackageFor,
    defaultTemplateForArduino,
    fqbnFor,
    generateArduinoProjectFiles,
    isArduinoTemplate,
    setPanelRotation,
    sketchNameFrom,
    templatesForArduino,
} = compiled('generate/arduino');

function boardById(id) {
    const board = BOARDS.find((candidate) => candidate.id === id);
    ok(board !== undefined, `the ${id} board is in the catalogue`);
    return board;
}

/** A project of this board and template, with the wiring the wizard would have collected. */
function project(boardId, template, over = {}) {
    const board = boardById(boardId);
    return {
        board,
        projectName: 'check-project',
        template,
        choices: {},
        wiring: board.kind === 'rp' ? defaultWiring(board, 'ili9341') : undefined,
        ...over,
    };
}

function paths(files) {
    return files.map((file) => file.path);
}

function fileAt(files, path) {
    const found = files.find((file) => file.path === path);
    ok(found !== undefined, `${path} was generated`);
    return found;
}

// -------------------------------------------------------------------------- FQBN

test('every board has a board definition, and it is a FQBN arduino-cli would accept', () => {
    const problems = [];
    for (const board of BOARDS) {
        const fqbn = CPP_FQBN[board.id];
        if (fqbn === undefined) {
            problems.push(`${board.id} has no FQBN`);
            continue;
        }
        if (!/^[A-Za-z0-9_]+\:[A-Za-z0-9_]+\:[A-Za-z0-9_]+$/.test(fqbn)) {
            problems.push(`${board.id}: "${fqbn}" is not package:architecture:board`);
        }
    }
    equal(problems.length, 0, problems.join('; '));

    // The two cores answer 1 as well, so a board added to the catalogue without its C++ side is caught here
    // rather than by a user whose new board silently has no language choice.
    equal(fqbnFor(boardById('pico')), CPP_FQBN.pico, 'fqbnFor is the table');
    equal(corePackageFor(fqbnFor(boardById('pico'))), 'rp2040:rp2040', 'and the core package falls out of it');
    equal(corePackageFor(fqbnFor(boardById('esp32-devkitc'))), 'esp32:esp32', 'for the other family too');
    throws(
        () => fqbnFor({ id: 'not-a-board', name: 'Nothing', kind: 'rp' }),
        'a board with no entry names itself in the error',
    );
});

test('the RP boards are arduino-pico boards and the ESP32-S3 is the chip-generic one', () => {
    equal(CPP_FQBN.pico, 'rp2040:rp2040:rpipico', 'Pico');
    equal(CPP_FQBN.picow, 'rp2040:rp2040:rpipicow', 'Pico W');
    equal(CPP_FQBN.pico2, 'rp2040:rp2040:rpipico2', 'Pico 2');
    equal(CPP_FQBN.pico2w, 'rp2040:rp2040:rpipico2w', 'Pico 2 W');
    equal(CPP_FQBN['lilygo-tqt'], 'esp32:esp32:esp32s3', 'S3 silicon, pins from our own catalogue');
});

// ------------------------------------------------------------------------- names

test('a sketch name is one identifier, because Arduino requires it', () => {
    equal(sketchNameFrom('blinky-pico'), 'blinky_pico', 'hyphens become underscores');
    equal(sketchNameFrom('  Pico 2 W test '), 'Pico_2_W_test', 'spaces too, and the ends are trimmed');
    equal(sketchNameFrom('2fast'), 'sketch_2fast', 'a leading digit is prefixed');
    equal(sketchNameFrom('---'), 'sketch', 'a name with nothing left in it still names something');
    equal(sketchNameFrom(''), 'sketch', 'including an empty one');
    ok(/^[A-Za-z_][A-Za-z0-9_]*$/.test(sketchNameFrom('a.b/c d-e')), 'and the result is always an identifier');
});

// --------------------------------------------------------------------- templates

test('the C++ side has three templates, and says so plainly', () => {
    equal(ARDUINO_TEMPLATE_IDS.length, 3, 'blinky, display, designer');
    ok(isArduinoTemplate('blinky') && isArduinoTemplate('display') && isArduinoTemplate('designer'), 'those three');
    notOk(isArduinoTemplate('wifi'), 'no Embassy-shaped menu');
    notOk(isArduinoTemplate('sdcard'), 'and no named template for a card either');

    const board = boardById('pico');
    const offered = templatesForArduino(board);
    equal(offered.length, 3, 'all three offered');
    equal(offered[0].id, 'blinky', 'blinky first');
    equal(offered[1].id, 'display', 'then the diagnostic screen');
    equal(offered[2].id, 'designer', 'then the designer');
    contains(offered[1].description, 'Pico', 'the panel line names the board family');
    equal(defaultTemplateForArduino(board), 'blinky', 'and blinky is what a board starts at');
});

test('an ESP board\'s panel is named in its own menu', () => {
    const offered = templatesForArduino(boardById('sunton-3248s035r'));
    contains(offered[1].description, 'ST7796', 'the soldered panel is what the diagnostic screen drives');
});

// ------------------------------------------------------------------------ files

test('a blinky is a sketch folder and nothing more', () => {
    const files = generateArduinoProjectFiles(project('pico', 'blinky'));
    equal(
        paths(files).sort().join(' '),
        '.gitignore README.md check_project.ino sketch.yaml src/main.cpp src/main.h',
        'six files, no panel, no UI',
    );
    const main = fileAt(files, 'src/main.cpp').content;
    contains(main, 'void setup()', 'the Arduino contract');
    contains(main, 'void loop()', 'in the one place everything else is');
    contains(main, 'pinMode(25, OUTPUT)', 'the Pico\'s own LED');
    notContains(main, 'panel_init', 'and no panel code at all');
});

test('a display template brings the panel and paints the diagnostic screen', () => {
    const files = generateArduinoProjectFiles(project('pico', 'display'));
    contains(paths(files).join(' '), 'src/panel.cpp', 'the driver is there');
    contains(paths(files).join(' '), 'src/panel.h', 'with its header');
    const main = fileAt(files, 'src/main.cpp').content;
    contains(main, 'panel_init();', 'brought up in setup()');
    contains(main, 'panel_draw_test();', 'and painted once');
    contains(main, 'panel_blink_marker();', 'then blinked from loop()');
    notContains(main, 'ui_init', 'no screen object tree');
});

test('a designer template adds the two files the Designer owns and the one a person edits', () => {
    const files = generateArduinoProjectFiles(project('pico', 'designer'));
    const list = paths(files);
    for (const path of ['src/ui.cpp', 'src/ui.h', 'src/ui_handlers.cpp', 'src/ui_handlers.h', 'src/panel.cpp']) {
        contains(list.join(' '), path, path);
    }
    contains(fileAt(files, 'src/main.cpp').content, 'ui_init();', 'the screen is brought up');
    contains(fileAt(files, 'src/main.cpp').content, 'ui_tick();', 'and ticked');
    // The handler file is the one a person owns, and it has a stub with a body in it from the first build.
    const handlers = fileAt(files, 'src/ui_handlers.cpp').content;
    contains(handlers, 'on_go_clicked', 'a stub with a body');
    contains(fileAt(files, 'src/ui_handlers.h').content, 'extern "C" void on_go_clicked();', 'declared for ui.cpp');
    // LVGL is what the design is drawn with, so a designer project carries its configuration and its display
    // driver as well as the two files the Designer owns.
    contains(list.join(' '), 'lv_conf.h', 'the LVGL configuration');
    contains(list.join(' '), 'src/lvgl_display.cpp', 'and the driver that puts LVGL on the glass');
});

test('every handler ui.cpp calls is declared, so a fresh project compiles', () => {
    // The trap this pins, found on the bench 2026-10-31: the generator wrote a hand-made skeleton that called
    // `on_screen_tapped()`, while the Designer's save rewrote `ui_handlers.h` from the design -- which declares
    // `on_go_clicked()` and nothing else. The first build of a real project failed with "'on_screen_tapped' was
    // not declared in this scope". Both files now come from the same design, and this is the check that says so
    // for every board: what the screen calls, the header declares and the handler file defines.
    const problems = [];
    for (const board of BOARDS) {
        const files = generateArduinoProjectFiles(project(board.id, 'designer'));
        const screen = fileAt(files, 'src/ui.cpp').content;
        const header = fileAt(files, 'src/ui_handlers.h').content;
        const body = fileAt(files, 'src/ui_handlers.cpp').content;
        // `on_<widget>_<event>_cb` is the LVGL callback, and it lives in ui.cpp itself.
        const called = [...screen.matchAll(/\b(on_[A-Za-z0-9_]+)\(/g)].map((match) => match[1]);
        const unique = [...new Set(called)].filter((name) => !name.endsWith('_cb'));
        if (unique.length === 0) {
            problems.push(`${board.id}: ui.cpp calls no handler at all, so the stub wiring is not being tested`);
        }
        for (const name of unique) {
            if (!header.includes(`extern "C" void ${name}(`)) {
                problems.push(`${board.id}: ui.cpp calls ${name}() and ui_handlers.h does not declare it`);
            }
            if (!body.includes(`extern "C" void ${name}(`)) {
                problems.push(`${board.id}: ui.cpp calls ${name}() and ui_handlers.cpp does not define it`);
            }
        }
        // And the other way round: a declaration nobody calls is a handler that can never run.
        const declared = [...header.matchAll(/extern "C" void (on_[A-Za-z0-9_]+)\(/g)].map((match) => match[1]);
        for (const name of declared) {
            if (!unique.includes(name)) {
                problems.push(`${board.id}: ui_handlers.h declares ${name}() and ui.cpp never calls it`);
            }
        }
    }
    equal(problems.length, 0, problems.slice(0, 6).join('; '));
});

test('a template the C++ side does not have is refused rather than quietly made into a blinky', () => {
    throws(() => generateArduinoProjectFiles(project('pico', 'wifi')), 'wifi has no C++ version');
    throws(() => generateArduinoProjectFiles(project('esp32-devkitc', 'bluetooth')), 'nor has bluetooth');
});

test('a panel template with no wiring is refused, because there are no pins to write', () => {
    throws(
        () => generateArduinoProjectFiles(project('pico', 'display', { wiring: undefined })),
        'the wizard\'s panel answer is what supplies the pins',
    );
});

// ------------------------------------------------------------------------- panel

test('the panel is written from the wiring the wizard collected, pin for pin', () => {
    const board = boardById('pico');
    const wiring = defaultWiring(board, 'ili9341');
    const files = generateArduinoProjectFiles({ board, projectName: 'pins', template: 'display', wiring });
    const panel = fileAt(files, 'src/panel.cpp').content;
    equal(/auto &panelSpi = SPI1;/.test(panel), wiring.bus === 1, 'the bus the wiring names');

    contains(panel, `constexpr int kSclk = ${wiring.sclk};`, 'clock');
    contains(panel, `constexpr int kMosi = ${wiring.mosi};`, 'data out');
    contains(panel, `constexpr int kMiso = ${wiring.miso};`, 'data in');
    contains(panel, `constexpr int kCs = ${wiring.cs};`, 'chip select');
    contains(panel, `constexpr int kDc = ${wiring.dc};`, 'data/command');
    contains(panel, `constexpr int kRst = ${wiring.rst};`, 'reset');
    contains(panel, `constexpr int kBacklight = ${wiring.backlight};`, 'backlight');
    contains(panel, 'ILI9341', 'and the controller that wiring names');
    contains(panel, 'kColorOrderBgr = true', 'the ILI9341 module draws BGR');
    contains(panel, 'kMirrorX = true', 'and is mirrored in X');
});

test('a module whose RESET is tied to the board emits no reset pin at all', () => {
    const files = generateArduinoProjectFiles(
        project('pico', 'display', { wiring: { ...defaultWiring(boardById('pico'), 'st7789'), rst: null } }),
    );
    const panel = fileAt(files, 'src/panel.cpp').content;
    contains(panel, 'constexpr int kRst = -1;', 'a sentinel instead of a pin');
    contains(panel, 'if (kRst >= 0) {', 'and the reset is skipped at run time');
});

test('the ESP32 panel comes from the board record, not from a module choice', () => {
    const board = boardById('esp32-devkitc');
    const display = board.displays.find((candidate) => candidate.panelChoice === undefined) ?? board.displays[0];
    const files = generateArduinoProjectFiles({ board, projectName: 'esp-panel', template: 'display', choices: {} });
    const panel = fileAt(files, 'src/panel.cpp').content;
    contains(panel, `constexpr int kSclk = ${display.spi.sclk};`, 'the soldered panel\'s clock');
    contains(panel, `constexpr int kCs = ${display.cs};`, 'and its chip select');
    // The two cores configure the bus in different calls, and the wrong one does not compile at all.
    contains(panel, 'panelSpi.begin(kSclk,', 'the ESP32 core takes the pins in begin()');
    notContains(panel, '.setTX(', 'not the arduino-pico setters');
});

test('a Pico\'s panel uses the arduino-pico way of naming the bus pins', () => {
    const files = generateArduinoProjectFiles(project('pico', 'display'));
    const panel = fileAt(files, 'src/panel.cpp').content;
    // arduino-pico's SPI class names the pins after I2C: TX is data out, RX is data in. The first version of
    // this emitter said setSDA/setMISO, which is what the ESP32 core's examples say and what a real
    // `arduino-cli compile` rejected.
    contains(panel, 'panelSpi.setTX(kMosi);', 'data out');
    contains(panel, 'panelSpi.setRX(kMiso);', 'data in');
    contains(panel, 'panelSpi.setSCK(kSclk);', 'clock');
    notContains(panel, 'setSDA', 'and not the names arduino-pico does not have');
    notContains(panel, 'panelSpi.begin(kSclk', 'nor the ESP32 form');
});

test('the rotation is the module\'s own MADCTL bits, and it swaps the addressable size', () => {
    const upright = generateArduinoProjectFiles(project('pico', 'display', { rotation: 0 }));
    const turned = generateArduinoProjectFiles(project('pico', 'display', { rotation: 1 }));
    contains(fileAt(upright, 'src/panel.cpp').content, 'constexpr uint8_t kRotation = 0;', 'no rotation');
    contains(fileAt(turned, 'src/panel.cpp').content, 'constexpr uint8_t kRotation = 1;', 'a quarter turn');
    contains(fileAt(turned, 'src/panel.cpp').content, 'if (kRotation == 1 || kRotation == 3)', 'axes swapped');
});

test('every generated file says what it is and who owns it', () => {
    for (const template of ARDUINO_TEMPLATE_IDS) {
        const files = generateArduinoProjectFiles(project('pico', template));
        // lv_conf.h is a configuration header, not one of the generated sources, so it is checked below in its
        // own words rather than by the marker every .cpp/.h carries.
        for (const file of files.filter(
            (candidate) =>
                candidate.path !== 'lv_conf.h' &&
                (candidate.path.endsWith('.cpp') || candidate.path.endsWith('.h')),
        )) {
            contains(file.content, 'Generated by Grumpy\'s Rusty Platform', `${file.path} is marked as generated`);
        }
        // lv_conf.h is a config header rather than a generated source file, so it says what it is in its own
        // words -- still a marker, and still something a person knows not to hand-edit blindly.
        if (template === 'designer') {
            contains(fileAt(files, 'lv_conf.h').content, "Grumpy's Rusty Platform", 'lv_conf.h says where it came from');
        }
    }
});

test('only the designer template needs LVGL, and the other two need no library at all', () => {
    for (const board of BOARDS) {
        for (const template of ARDUINO_TEMPLATE_IDS) {
            const options = {
                board,
                projectName: 'no-libs',
                template,
                choices: {},
                wiring: board.kind === 'rp' ? defaultWiring(board, 'st7789') : undefined,
            };
            const files = generateArduinoProjectFiles(options);
            for (const file of files) {
                if (template !== 'designer') {
                    notContains(file.content, 'lvgl.h', `${board.id}/${template}: no LVGL here`);
                }
                notContains(file.content, 'TFT_eSPI', `${board.id}/${template}: no display library`);
                notContains(file.content, 'Adafruit_', `${board.id}/${template}: no Adafruit library`);
            }
            // A designer project is the one place a library is expected, and it is LVGL -- nothing else.
            if (template === 'designer') {
                contains(fileAt(files, 'src/lvgl_display.cpp').content, '#include <lvgl.h>', `${board.id}: LVGL`);
            }
        }
    }
});

test('sketch.yaml records the board, so no command needs to name it', () => {
    for (const board of BOARDS) {
        const files = generateArduinoProjectFiles({ board, projectName: 'yaml', template: 'blinky', choices: {} });
        const yaml = fileAt(files, 'sketch.yaml').content;
        contains(yaml, `fqbn: ${CPP_FQBN[board.id]}`, `${board.id} is recorded`);
        contains(yaml, 'profiles:', 'as a profile');
        contains(yaml, 'default:', 'the one arduino-cli reads without being told');
    }
});

test('the README names the build commands, the board and the panel\'s pins', () => {
    const files = generateArduinoProjectFiles(project('pico', 'display'));
    const readme = fileAt(files, 'README.md').content;
    contains(readme, 'arduino-cli core install rp2040:rp2040', 'how to get the core');
    contains(readme, 'arduino-cli compile --profile default', 'how to build it');
    contains(readme, 'arduino-cli upload --profile default', 'and how to flash it');
    contains(readme, 'GPIO18', 'the clock pin it is actually wired to');
    contains(readme, 'No libraries are needed', 'and that it builds on a fresh core');
});

test('a C++ project of every board and template is generated without throwing', () => {
    for (const board of BOARDS) {
        for (const template of templatesForArduino(board)) {
            const files = generateArduinoProjectFiles({
                board,
                projectName: `all-${board.id}-${template.id}`,
                template: template.id,
                choices: {},
                wiring: board.kind === 'rp' ? defaultWiring(board, PANEL_MODULES[0].id) : undefined,
            });
            ok(files.length >= 6, `${board.id}/${template.id} has its files`);
            equal(new Set(paths(files)).size, files.length, `${board.id}/${template.id} has no duplicate path`);
        }
    }
});

test('every board offers the WYSIWYG designer in the wizard, and it is called that', () => {
    // The option existed but was labelled "Designer screen (no canvas yet)" long after the canvas worked, and the
    // wizard never offered to open it -- so a person asked for the WYSIWYG option and could not find one
    // (bench, 2026-10-31).
    const problems = [];
    for (const board of BOARDS) {
        const offered = templatesForArduino(board);
        const designer = offered.find((entry) => entry.id === 'designer');
        if (designer === undefined) {
            problems.push(`${board.id}: no designer template`);
            continue;
        }
        if (designer.label !== 'WYSIWYG designer') {
            problems.push(`${board.id}: the designer is called "${designer.label}"`);
        }
        if (/no canvas|not wired up/i.test(designer.description)) {
            problems.push(`${board.id}: the description still says it has no canvas`);
        }
        // And the board can really make one: the template needs a panel, and every catalogue board has one.
        const files = generateArduinoProjectFiles(project(board.id, 'designer'));
        for (const path of ['src/ui.cpp', 'src/ui_handlers.cpp', 'designer/panel.ui.json']) {
            if (!paths(files).includes(path)) {
                problems.push(`${board.id}: a designer project has no ${path}`);
            }
        }
    }
    equal(problems.length, 0, problems.slice(0, 5).join('; '));
});

test('a designer project is refused unless it really carries its design', () => {
    // The wizard's last line of defence: a template that quietly produces something else must not be written and
    // called WYSIWYG. Found on the bench 2026-11-01, when a WYSIWYG project arrived named `blinky_pico2w`.
    const { requiredTemplateFiles } = compiled('generate/backends');
    equal(requiredTemplateFiles(arduinoBackend, 'designer').join(' '), 'designer/panel.ui.json src/ui_handlers.cpp', 'a sketch needs its design and its code-behind');
    equal(requiredTemplateFiles(arduinoBackend, 'blinky').length, 0, 'a blinky has no signature to check');
    for (const board of BOARDS) {
        const files = generateArduinoProjectFiles(project(board.id, 'designer'));
        const missing = requiredTemplateFiles(arduinoBackend, 'designer').filter(
            (path) => !files.some((file) => file.path === path),
        );
        equal(missing.length, 0, `${board.id}: ${missing.join(', ')}`);
    }
});

test('pixels go out high byte first, or every colour is byte-swapped', () => {
    // Red rendering as blue on the bench (2026-11-01) was not the colour order: MADCTL's BGR bit was already set,
    // exactly as mipidsi sets it on the Rust side. A uint16_t sits in memory low byte first, so a blitted RGB565
    // buffer reaches an ILI9341 byte-swapped, and 0xF800 (red) arrives as 0x00F8 (blue).
    const problems = [];
    for (const board of BOARDS) {
        const files = generateArduinoProjectFiles(project(board.id, 'designer'));
        const panel = fileAt(files, 'src/panel.cpp').content;
        if (!/uint16_t swap_pixel\(uint16_t value\)/.test(panel)) {
            problems.push(`${board.id}: no swap_pixel`);
            continue;
        }
        if (!/line\[column\] = swap_pixel\(source\[column\]\);/.test(panel)) {
            problems.push(`${board.id}: stream_pixels sends the buffer raw`);
        }
        if (!/line\[i\] = swap_pixel\(colour\);/.test(panel)) {
            problems.push(`${board.id}: panel_fill_rect sends the colour raw`);
        }
        // The scratch line has to hold the panel's widest dimension, or a wide blit is truncated.
        const widest = /constexpr int kLinePixels = (\d+);/.exec(panel)?.[1];
        if (widest === undefined || !/line\[kLinePixels\]/.test(panel)) {
            problems.push(`${board.id}: the line buffer is not sized from kLinePixels`);
        }
    }
    equal(problems.length, 0, problems.slice(0, 4).join('; '));
});

test('the design\'s rotation is written into the panel driver, and nothing else moves', () => {
    // The rotation is one constant in `panel.cpp`; a design save used to leave it alone, so turning the design
    // changed the canvas and not the glass.
    const source = [
        '// a panel driver',
        'constexpr int kCs = 9;',
        'constexpr uint8_t kRotation = 0;',
        'constexpr uint8_t kMadctlBgr = 0x08;',
    ].join('\n');
    const turned = setPanelRotation(source, 3);
    contains(turned, 'constexpr uint8_t kRotation = 3;', 'the constant follows the design');
    contains(turned, 'constexpr int kCs = 9;', 'the pins are left alone');
    contains(turned, 'constexpr uint8_t kMadctlBgr = 0x08;', 'and so is everything else');
    equal(setPanelRotation(turned, 3), turned, 'a second save writes nothing');
    // A hand-written driver with no such constant is left as it is rather than gaining one.
    equal(setPanelRotation('int main() {}', 1), 'int main() {}', 'a file without the constant is untouched');
});
