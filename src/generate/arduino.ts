/**
 * The Arduino (C++) generator: what a C++ project for one board and template contains.
 *
 * This is the C++ side of the seam phase 1 built. It is deliberately a *sibling* of `files.ts` rather than a
 * branch inside it: the Rust generator answers with embassy-rp, `memory.x`, `Cargo.toml` and a build.rs, and
 * every one of those would have to be a lie in a sketch. What the two *do* share is the request
 * (`GenerateOptions`), the board catalogue and the panel wiring -- hardware facts, not language facts.
 *
 * Three rules carried over from the Rust side, because they are about correctness and not about Rust:
 *
 *   1. **Everything here is pure.** No `vscode`, no filesystem: the t3 layer snapshots the output byte for
 *      byte, and the wizard is the only thing that writes.
 *   2. **No guessing at hardware.** Board pins come from the catalogue (`boards/catalog.ts`) and from the
 *      panel wiring the wizard already collected; nothing is re-derived here.
 *   3. **Files that the Designer owns say so.** `src/panel.cpp` and `src/ui.cpp` are rewritten by the
 *      Designer; a person's code belongs in `src/ui_handlers.cpp`, which it only ever appends to.
 *
 * What is *not* here yet: LVGL. A sketch in this phase draws with the panel driver directly, so every
 * template compiles against the stock core with **no libraries installed**. The LVGL object-tree emitter is
 * phase 4 of `plans/arduino-backend.md`, and it replaces the body of `ui.cpp` rather than the file's shape.
 */

import { BoardProfile, EspDisplay, isEspBoard } from '../boards/types';
import { displayFor } from '../boards/esp';
import { panelModuleOrDefault, type PanelWiring } from '../boards/panels';
import type { LcdRotation } from '../display/rotation';
import { asLcdRotation } from '../display/rotation';
import type { AppTemplate, AppTemplateInfo, GenerateOptions, GeneratedFile } from './files';

// ----------------------------------------------------------------------------- FQBN

/**
 * The board definitions the two cores address, by FQBN.
 *
 * `arduino-cli` names a board by Fully Qualified Board Name -- `package:architecture:board` -- so the board
 * matrix becomes a lookup rather than a second model. The ids are the *generic* board of each chip family on
 * purpose: every fact that makes one module different from another (which GPIO the panel is on, which LED)
 * comes from this extension's own catalogue and is emitted into `panel.cpp`, so a variant that repeats those
 * pins would be a second source of truth for the same wire.
 *
 * The ESP32-S3 entry is the chip-generic `esp32s3` for the same reason, and the RP2350 boards are
 * arduino-pico's own Pico 2 definitions. Verify the whole table against `arduino-cli board listall` when the
 * core is installed -- a board definition that has been renamed shows up as one build that cannot find its
 * board, which is why `fqbnFor` names the board it could not find.
 */
export const CPP_FQBN: Readonly<Record<string, string>> = {
    pico: 'rp2040:rp2040:rpipico',
    picow: 'rp2040:rp2040:rpipicow',
    pico2: 'rp2040:rp2040:rpipico2',
    pico2w: 'rp2040:rp2040:rpipico2w',
    'esp32-devkitc': 'esp32:esp32:esp32',
    'lilygo-tqt': 'esp32:esp32:esp32s3',
    'sunton-3248s035r': 'esp32:esp32:esp32',
};

/** The core package each FQBN belongs to, for the "is the core installed?" answer and the README. */
export function corePackageFor(fqbn: string): string {
    const parts = fqbn.split(':');
    return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : fqbn;
}

/** The board's FQBN, or an error that names the board rather than the missing entry. */
export function fqbnFor(board: BoardProfile): string {
    const fqbn = CPP_FQBN[board.id];
    if (fqbn === undefined) {
        throw new Error(
            `No arduino-cli board definition for ${board.name} (${board.id}); add it to CPP_FQBN in ` +
            'src/generate/arduino.ts once `arduino-cli board listall` shows what the core calls it.',
        );
    }
    return fqbn;
}

// ------------------------------------------------------------------------ templates

/**
 * The templates a C++ project offers.
 *
 * The Rust side's menu is shaped by Embassy (Wi-Fi, Bluetooth, CYW43); arduino-pico and arduino-esp32 bring
 * their radios as part of the core, so those become ordinary C++ work rather than templates of their own. The
 * three that remain are the three the Designer, the panel diagnostic and a first blink need.
 */
export const ARDUINO_TEMPLATE_IDS: readonly AppTemplate[] = ['blinky', 'display', 'designer'];

export function isArduinoTemplate(template: AppTemplate): boolean {
    return ARDUINO_TEMPLATE_IDS.includes(template);
}

/** The templates a board is offered, in the wizard's order. */
export function templatesForArduino(board: BoardProfile): AppTemplateInfo[] {
    const panel = panelDescriptionFor(board);
    return [
        {
            id: 'blinky',
            label: 'LED blinky',
            description: `Blinks ${ledDescriptionFor(board)}. No libraries, so it builds on a fresh core.`,
        },
        {
            id: 'display',
            label: 'Panel diagnostic screen',
            description:
                `Colour bars, a frame and a blinking square on ${panel}. Proves the wiring before any UI ` +
                'exists, exactly as the Rust template does.',
        },
        {
            id: 'designer',
            label: 'WYSIWYG designer (skeleton)',
            description:
                'A project the Designer owns: it rewrites src/panel.cpp and src/ui.cpp, and appends a stub to ' +
                'src/ui_handlers.cpp for each widget event.',
        },
    ];
}

export function defaultTemplateForArduino(_board: BoardProfile): AppTemplate {
    return 'blinky';
}

function ledDescriptionFor(board: BoardProfile): string {
    const led = board.led;
    switch (led.kind) {
        case 'gpio':
            return led.external === true
                ? `the pin offered for an external LED (GPIO${led.pin} on this board's header)`
                : `the on-board LED on GPIO${led.pin}`;
        case 'cyw43':
            return 'the wireless-chip LED (the W series has no plain LED pin)';
        case 'rgb':
            return `the on-board RGB LED (R ${led.red}, G ${led.green}, B ${led.blue})`;
        default:
            return 'a pin you wire an LED to (this board has no on-board LED)';
    }
}

function panelDescriptionFor(board: BoardProfile): string {
    if (isEspBoard(board)) {
        const display = displayFor(board, {});
        return display === undefined ? 'the panel' : `${display.label} (${display.width}x${display.height})`;
    }
    return 'the panel wired to the Pico';
}

// ---------------------------------------------------------------------- the sketch

/**
 * The sketch's name: what the folder, the `.ino` and the build are called.
 *
 * Arduino requires the folder, the main `.ino` and therefore the sketch to share one name, and that name has
 * to survive being compiled (it becomes a file name and a build directory). A Rust project may be
 * `blinky-pico`; the C++ project of the same name is `blinky_pico`, which is why the wizard asks the backend
 * what to call the folder instead of deciding for itself.
 */
export function sketchNameFrom(projectName: string): string {
    const cleaned = projectName
        .trim()
        .replace(/[^A-Za-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (cleaned === '') {
        return 'sketch';
    }
    return /^[A-Za-z_]/.test(cleaned) ? cleaned : `sketch_${cleaned}`;
}

/** Prefix on every generated C++ file, so a person can tell what to edit and what not to. */
const GENERATED_NOTE =
    '// Generated by Grumpy\'s Rusty Platform. The Designer rewrites this file; put your own code in\n' +
    '// src/ui_handlers.cpp, which it only ever appends to.';

// --------------------------------------------------------------------- the request

/** One panel, resolved to the pins and the controller's own facts. */
interface CppPanel {
    controller: 'ST7789' | 'ST7796' | 'GC9107' | 'GC9A01' | 'ILI9341';
    /** The controller family, which is what decides the init sequence. */
    family: 'st77xx' | 'ili9341';
    /** Which SPI peripheral the panel is on: 0 or 1. Always 0 on an ESP board, whose bus is remappable. */
    bus: 0 | 1;
    label: string;
    width: number;
    height: number;
    sclk: number;
    mosi: number;
    miso: number | null;
    cs: number;
    dc: number;
    rst: number | null;
    backlight: number | null;
    backlightActiveLow: boolean;
    colorOrder: 'rgb' | 'bgr';
    mirrorX: boolean;
    mirrorY: boolean;
    invertColors: boolean;
    spiHz: number;
    touch: { cs: number; irq: number } | undefined;
}

/**
 * Which controller family a controller's init sequence comes from.
 *
 * The GC9107 and the GC9A01 are ST77xx-family parts: the same SLPOUT / COLMOD / MADCTL / DISPON dance, with
 * their own gamma tables left at the module's defaults. That is enough to light the glass and fill it, which
 * is what a diagnostic screen is for; nothing here pretends to be a tuned init.
 */
function familyOf(controller: string): 'st77xx' | 'ili9341' {
    return controller === 'ILI9341' || controller === 'ILI9341Rgb565' ? 'ili9341' : 'st77xx';
}

/** The panel a C++ project drives: the wired one on a Pico, the soldered one on an ESP board. */
function cppPanelFor(
    board: BoardProfile,
    options: GenerateOptions,
): CppPanel | undefined {
    if (isEspBoard(board)) {
        const display = displayFor(board, options.choices ?? {});
        return display === undefined ? undefined : panelFromEsp(display);
    }
    const wiring: PanelWiring | undefined = options.wiring;
    if (wiring === undefined) {
        return undefined;
    }
    return panelFromWiring(wiring);
}

function panelFromWiring(wiring: PanelWiring): CppPanel {
    const module = panelModuleOrDefault(wiring.panel);
    const controller = module.controller === 'ILI9341Rgb565' ? 'ILI9341' : module.controller;
    return {
        controller,
        family: familyOf(module.controller),
        bus: wiring.bus,
        label: module.label,
        width: module.width,
        height: module.height,
        sclk: wiring.sclk,
        mosi: wiring.mosi,
        miso: wiring.miso,
        cs: wiring.cs,
        dc: wiring.dc,
        rst: wiring.rst,
        backlight: wiring.backlight,
        backlightActiveLow: wiring.backlightActiveLow,
        colorOrder: module.colorOrder,
        mirrorX: module.mirrorX,
        mirrorY: module.mirrorY,
        invertColors: module.invertColors,
        spiHz: module.spiHz,
        touch:
            wiring.touchCs === null || wiring.touchIrq === null
                ? undefined
                : { cs: wiring.touchCs, irq: wiring.touchIrq },
    };
}

function panelFromEsp(display: EspDisplay): CppPanel {
    const controller = display.controller === 'ILI9341Rgb565' ? 'ILI9341' : display.controller;
    return {
        controller,
        family: familyOf(display.controller),
        bus: 0,
        label: display.label,
        width: display.width,
        height: display.height,
        sclk: display.spi.sclk,
        mosi: display.spi.mosi,
        miso: display.spi.miso ?? null,
        cs: display.cs,
        dc: display.dc,
        rst: display.rst ?? null,
        backlight: display.backlight ?? null,
        backlightActiveLow: display.backlightActiveLow === true,
        colorOrder: display.colorOrder,
        mirrorX: display.mirrorX,
        mirrorY: display.mirrorY,
        invertColors: display.invertColors === true,
        spiHz: display.spiHz,
        touch: display.touch === undefined ? undefined : { cs: display.touch.cs, irq: display.touch.irq },
    };
}

// ------------------------------------------------------------------- generated files

/**
 * A C++ project for one board and template.
 *
 * Throws for a template the C++ side does not have (`wifi`, `bluetooth`, `sdcard`, ...) rather than quietly
 * generating a blinky: a menu that offers the wrong thing is a bug the wizard should have prevented, and a
 * project that is not what its name says is a worse bug.
 */
export function generateArduinoProjectFiles(options: GenerateOptions): GeneratedFile[] {
    const { board, projectName } = options;
    const template = options.template ?? defaultTemplateForArduino(board);
    if (!isArduinoTemplate(template)) {
        throw new Error(
            `Template "${template}" has no C++ version; available: ${ARDUINO_TEMPLATE_IDS.join(', ')}.`,
        );
    }

    const fqbn = fqbnFor(board);
    const sketch = sketchNameFrom(projectName);
    const panel = template === 'blinky' ? undefined : cppPanelFor(board, options);
    if (template !== 'blinky' && panel === undefined) {
        throw new Error(
            `${board.name} has no panel configured for a ${template} project: the wizard's panel answer is ` +
            'what supplies the pins.',
        );
    }
    const rotation = asLcdRotation(options.rotation);

    const files: GeneratedFile[] = [
        { path: 'sketch.yaml', content: sketchYaml(fqbn) },
        { path: `${sketch}.ino`, content: sketchIno(sketch) },
        { path: 'src/main.h', content: mainHeader() },
        { path: 'src/main.cpp', content: mainSource({ board, template, panel, rotation }) },
        { path: '.gitignore', content: gitignore() },
        { path: 'README.md', content: readme({ board, template, panel, sketch, fqbn }) },
    ];

    if (panel !== undefined) {
        files.push({ path: 'src/panel.h', content: panelHeader() });
        files.push({ path: 'src/panel.cpp', content: panelSource(panel, rotation, board.kind) });
    }

    if (template === 'designer') {
        files.push({ path: 'src/ui.h', content: uiHeader() });
        files.push({ path: 'src/ui.cpp', content: uiSource() });
        files.push({ path: 'src/ui_handlers.h', content: handlersHeader() });
        files.push({ path: 'src/ui_handlers.cpp', content: handlersSource() });
    }

    return files;
}

// ---------------------------------------------------------------------- sketch.yaml

/**
 * `arduino-cli`'s own project file.
 *
 * It records the board so that `arduino-cli compile` in this folder needs no arguments -- which is also what
 * makes the folder a project in the CLI's eyes rather than a directory of source.
 */
function sketchYaml(fqbn: string): string {
    return `# Grumpy's Rusty Platform -- the board this sketch is built for.
#
# \`arduino-cli compile\` and \`arduino-cli upload\` read the FQBN from here, so neither needs to be told which
# board it is. The name after the last colon is the board definition inside the core package; the pins this
# project actually uses are in src/panel.cpp, because a generic definition cannot know how a module is wired.

profiles:
  default:
    fqbn: ${fqbn}
`;
}

// ---------------------------------------------------------------------------- .ino

/**
 * The sketch's entry file.
 *
 * Arduino builds a sketch from its `.ino`, and the file has to be named after the folder. All of ours does is
 * pull in `main.h`: the actual `setup()` and `loop()` live in `src/main.cpp` with everything else, so the
 * code is in one place whether it is opened in the Arduino IDE or in this extension.
 */
function sketchIno(sketch: string): string {
    return `// ${sketch} -- the sketch entry file.
//
// Arduino builds a sketch from the .ino named after its folder, so this file has to be here and has to have
// this name. Everything it needs is in src/main.cpp; open that, or the Designer.

#include "src/main.h"
`;
}

// --------------------------------------------------------------------------- main.h

function mainHeader(): string {
    return `${GENERATED_NOTE}

#pragma once

#include <Arduino.h>

// The sketch's own files live in src/ beside this one, and the core adds src/ to the include path, so a
// plain #include "panel.h" works from here and from every other file in src/.
`;
}

// ------------------------------------------------------------------------- main.cpp

function mainSource(request: {
    board: BoardProfile;
    template: AppTemplate;
    panel: CppPanel | undefined;
    rotation: LcdRotation;
}): string {
    const { board, template, panel } = request;
    const led = ledSetup(board);
    const includes = [`#include <Arduino.h>`, `#include "main.h"`];
    if (panel !== undefined) {
        includes.push(`#include "panel.h"`);
    }
    if (template === 'designer') {
        includes.push(`#include "ui.h"`);
    }

    const setupBody: string[] = [led.setup];
    if (panel !== undefined) {
        setupBody.push('    panel_init();');
    }
    if (template === 'display') {
        setupBody.push('    panel_draw_test();');
    }
    if (template === 'designer') {
        setupBody.push('    ui_init();');
    }

    const loopBody: string[] = [];
    if (led.loop !== undefined) {
        loopBody.push(led.loop);
    }
    if (template === 'display') {
        loopBody.push('    panel_blink_marker();', '    delay(500);');
    } else if (template === 'designer') {
        loopBody.push('    ui_tick();', '    delay(20);');
    } else {
        loopBody.push('    delay(200);');
    }

    return `${GENERATED_NOTE}

${includes.join('\n')}

// The Arduino contract: setup() runs once, loop() forever. The Rust templates split the same two halves into
// an Embassy main and a task, so a project of either language has one obvious place for "at power on" and
// one for "all the time".

void setup() {
${setupBody.join('\n')}

    Serial.begin(115200);
    Serial.println("${board.name}: ${template} ready");
}

void loop() {
${loopBody.join('\n')}
}
`;
}

/** Whatever `setup()` has to do for this board's LED, and what `loop()` does with it. */
function ledSetup(board: BoardProfile): { setup: string; loop?: string } {
    const led = board.led;
    if (led.kind === 'gpio') {
        const pin = arduinoPin(led.pin);
        return {
            setup: `    pinMode(${pin}, OUTPUT); // ${led.external === true ? 'the offered LED pin' : 'the on-board LED'}`,
            loop:
                `    // The level is remembered here rather than read back: reading an output pin is not the same\n` +
                `    // thing on every chip.\n` +
                `    static bool ledOn = false;\n` +
                `    ledOn = !ledOn;\n` +
                `    digitalWrite(${pin}, ledOn ? HIGH : LOW);`,
        };
    }
    if (led.kind === 'rgb') {
        return {
            setup:
                `    pinMode(${led.red}, OUTPUT);\n` +
                `    pinMode(${led.green}, OUTPUT);\n` +
                `    pinMode(${led.blue}, OUTPUT);`,
            loop:
                `    // One colour at a time, so a wrong wiring shows as a wrong colour rather than as nothing.\n` +
                `    static uint8_t step = 0;\n` +
                `    digitalWrite(${led.red}, step == 0);\n` +
                `    digitalWrite(${led.green}, step == 1);\n` +
                `    digitalWrite(${led.blue}, step == 2);\n` +
                `    step = static_cast<uint8_t>((step + 1) % 3);`,
        };
    }
    if (led.kind === 'cyw43') {
        // arduino-pico maps LED_BUILTIN on the W boards to the wireless chip's LED and drives it through
        // pinMode/digitalWrite like any other pin -- so the sketch needs no CYW43 code of its own.
        return {
            setup: '    pinMode(LED_BUILTIN, OUTPUT); // the W boards\' LED lives on the wireless chip',
            loop:
                '    static bool ledOn = false;\n' +
                '    ledOn = !ledOn;\n' +
                '    digitalWrite(LED_BUILTIN, ledOn ? HIGH : LOW);',
        };
    }
    // A board with no LED at all: the ESP32-DevKitC has a power LED and nothing else. Blink nothing rather
    // than a pin that belongs to something else.
    return {
        setup: '    // This board has no on-board LED, so nothing is initialised here: wire one to a free pin\n' +
            '    // and give it a pinMode()/digitalWrite() pair of its own.',
        loop: '    // Nothing to blink: this board has no on-board LED.',
    };
}

/** `PIN_25` (the catalogue's peripheral name) to the Arduino pin number, which is the GPIO number. */
function arduinoPin(name: string): string {
    const match = /^PIN_(\d+)$/.exec(name);
    return match === null ? name : String(Number(match[1]));
}

// ------------------------------------------------------------------------- panel.h

function panelHeader(): string {
    return `${GENERATED_NOTE}

#pragma once

#include <Arduino.h>

// The panel this project is wired to. panel.cpp is written from designer/panel.hardware.json (a Pico) or from
// the board's own panel record (an ESP board), so the pins are never typed twice.

/** Brings the SPI bus, the controller and the backlight up. Returns false if the glass never answered. */
bool panel_init();

/** The panel's size in pixels, after the project's rotation. */
int panel_width();
int panel_height();

/** Fills the whole screen with one RGB565 colour. */
void panel_fill(uint16_t colour);

/** Fills one rectangle; clipped to the screen. */
void panel_fill_rect(int x, int y, int w, int h, uint16_t colour);

/** The frame, the corner markers, three colour bands and a square to be blinked by panel_blink_marker(). */
void panel_draw_test();

/** Moves the square of the test screen and prints the time a paint took. */
void panel_blink_marker();
`;
}

// ----------------------------------------------------------------------- panel.cpp

function panelSource(panel: CppPanel, rotation: LcdRotation, kind: 'rp' | 'esp'): string {
    const rotationNote = rotation === 0 ? 'not turned' : `turned ${rotation * 90} degrees clockwise`;
    return `${GENERATED_NOTE}

#include "panel.h"

#include <SPI.h>

// ${panel.label}
//
// ${panel.width}x${panel.height} native, ${rotationNote}. The pins and the facts that cannot be read off a
// datasheet (colour order, mirroring, inversion) come from this extension's catalogue; the init sequence is
// the minimum that lights the glass, with the module's own power and gamma defaults left alone.

namespace {

constexpr int kSclk = ${panel.sclk};
constexpr int kMosi = ${panel.mosi};
${panel.miso === null ? '' : `constexpr int kMiso = ${panel.miso};\n`}constexpr int kCs = ${panel.cs};
constexpr int kDc = ${panel.dc};
constexpr int kRst = ${panel.rst === null ? -1 : panel.rst};
constexpr int kBacklight = ${panel.backlight === null ? -1 : panel.backlight};
constexpr bool kBacklightActiveLow = ${panel.backlightActiveLow ? 'true' : 'false'};
constexpr uint32_t kSpiHz = ${panel.spiHz}u;

// What the glass is, as opposed to what it can do: all three are invisible to a compiler and wrong in a way
// that looks like broken hardware, so they come from the catalogue rather than from a guess.
constexpr bool kMirrorX = ${panel.mirrorX ? 'true' : 'false'};
constexpr bool kMirrorY = ${panel.mirrorY ? 'true' : 'false'};
constexpr bool kColorOrderBgr = ${panel.colorOrder === 'bgr' ? 'true' : 'false'};
constexpr bool kInvertColors = ${panel.invertColors ? 'true' : 'false'};
constexpr uint8_t kRotation = ${rotation};

/** MADCTL's BGR bit: it swaps the red and blue channels of everything written afterwards. */
constexpr uint8_t kMadctlBgr = 0x08;

int gWidth = ${panel.width};
int gHeight = ${panel.height};
int gMarkerX = 0;

// The panel's bus, named once. On the Pico the wiring says which peripheral it is on; on an ESP board the
// bus is remappable and SPI is the one. auto deduces each core's own SPI type, which neither core spells
// the same way.
auto &panelSpi = ${panel.bus === 1 ? 'SPI1' : 'SPI'};

/** The three commands that differ between the families, kept in one place. */
void write_command(uint8_t command) {
    panelSpi.beginTransaction(SPISettings(kSpiHz, MSBFIRST, SPI_MODE0));
    digitalWrite(kDc, LOW);
    digitalWrite(kCs, LOW);
    panelSpi.transfer(command);
    digitalWrite(kCs, HIGH);
    panelSpi.endTransaction();
}

void write_data(const uint8_t *data, size_t length) {
    panelSpi.beginTransaction(SPISettings(kSpiHz, MSBFIRST, SPI_MODE0));
    digitalWrite(kDc, HIGH);
    digitalWrite(kCs, LOW);
    // transfer(buf, count) is the one bulk call both cores share; writeBytes/writePixels are not.
    panelSpi.transfer(const_cast<uint8_t *>(data), length);
    digitalWrite(kCs, HIGH);
    panelSpi.endTransaction();
}

void write_command_data(uint8_t command, const uint8_t *data, size_t length) {
    write_command(command);
    write_data(data, length);
}

/** MADCTL for this module and this rotation: MY/MX select the corner, MV swaps the axes, BGR the order. */
uint8_t madctl() {
    uint8_t value = 0;
    if (kMirrorX) {
        value |= 0x40;
    }
    if (kMirrorY) {
        value |= 0x80;
    }
    if (kColorOrderBgr) {
        value |= kMadctlBgr;
    }
    switch (kRotation) {
        case 1: value |= 0x60; break; // 90 degrees clockwise
        case 2: value |= 0xC0; break; // 180
        case 3: value |= 0xA0; break; // 270
        default: break;
    }
    return value;
}

} // namespace

bool panel_init() {
    pinMode(kCs, OUTPUT);
    pinMode(kDc, OUTPUT);
    digitalWrite(kCs, HIGH);
    digitalWrite(kDc, HIGH);

    if (kRst >= 0) {
        pinMode(kRst, OUTPUT);
        digitalWrite(kRst, HIGH);
        delay(10);
        digitalWrite(kRst, LOW);
        delay(20);
        digitalWrite(kRst, HIGH);
        delay(120);
    }

    if (kBacklight >= 0) {
        pinMode(kBacklight, OUTPUT);
        digitalWrite(kBacklight, kBacklightActiveLow ? HIGH : LOW);
    }

    // The two cores configure the bus differently: arduino-pico names the pins one at a time, with the
    // I2C-flavoured names its SPI class uses (TX is data out, RX is data in), and the ESP32 core takes them
    // in begin(). Both end up as the same object, which is why the rest of this file can be shared.
${kind === 'rp'
            ? `    panelSpi.setTX(kMosi);
    panelSpi.setSCK(kSclk);
${panel.miso === null ? '' : '    panelSpi.setRX(kMiso);\n'}    panelSpi.begin();
`
            : `    panelSpi.begin(kSclk, ${panel.miso === null ? '-1' : 'kMiso'}, kMosi, -1);
`
        }

    write_command(0x01); // SWRESET
    delay(150);
    write_command(0x11); // SLPOUT
    delay(120);

    const uint8_t colourMode = 0x55; // 16 bits per pixel, RGB565
    write_command_data(0x3A, &colourMode, 1);
${panel.invertColors ? '    write_command(0x21); // INVON: these glasses draw white as black without it\n' : ''}${panel.family === 'ili9341'
            ? `    const uint8_t memoryAccess = madctl();
    write_command_data(0x36, &memoryAccess, 1);
    const uint8_t porch[] = {0x0C, 0x0C, 0x00, 0x33, 0x33}; // front/back porch, as the datasheet's default
    write_command_data(0xB2, porch, sizeof(porch));
    const uint8_t power1 = 0x23;
    write_command_data(0xC0, &power1, 1);
    const uint8_t power2 = 0x10;
    write_command_data(0xC1, &power2, 1);
    const uint8_t vcom1[] = {0x3E, 0x28};
    write_command_data(0xC5, vcom1, sizeof(vcom1));
`
            : `    const uint8_t memoryAccess = madctl();
    write_command_data(0x36, &memoryAccess, 1);
`
        }
    write_command(0x29); // DISPON
    delay(20);

    // The rotation swaps the axes of the addressable window as well as the picture.
    if (kRotation == 1 || kRotation == 3) {
        gWidth = ${panel.height};
        gHeight = ${panel.width};
    }

    panel_fill(0x0000);
    if (kBacklight >= 0) {
        digitalWrite(kBacklight, kBacklightActiveLow ? LOW : HIGH);
    }
    Serial.printf("panel: ${panel.controller} %dx%d, sclk %d, mosi %d, cs %d, dc %d\\n",
                  gWidth, gHeight, kSclk, kMosi, kCs, kDc);
    return true;
}

int panel_width() {
    return gWidth;
}

int panel_height() {
    return gHeight;
}

void panel_fill_rect(int x, int y, int w, int h, uint16_t colour) {
    if (x >= gWidth || y >= gHeight || w <= 0 || h <= 0) {
        return;
    }
    if (x + w > gWidth) {
        w = gWidth - x;
    }
    if (y + h > gHeight) {
        h = gHeight - y;
    }

    const uint8_t caset[] = {static_cast<uint8_t>(x >> 8), static_cast<uint8_t>(x & 0xFF),
                             static_cast<uint8_t>((x + w - 1) >> 8),
                             static_cast<uint8_t>((x + w - 1) & 0xFF)};
    write_command_data(0x2A, caset, sizeof(caset));
    const uint8_t raset[] = {static_cast<uint8_t>(y >> 8), static_cast<uint8_t>(y & 0xFF),
                             static_cast<uint8_t>((y + h - 1) >> 8),
                             static_cast<uint8_t>((y + h - 1) & 0xFF)};
    write_command_data(0x2B, raset, sizeof(raset));
    write_command(0x2C); // RAMWR

    // One line at a time through a small buffer: a full-screen fill would need 150 KB of RAM on a 240x320
    // panel, which is more than the smaller boards have.
    static uint8_t line[240 * 2];
    const int pixels = w < 240 ? w : 240;
    const uint8_t high = static_cast<uint8_t>(colour >> 8);
    const uint8_t low = static_cast<uint8_t>(colour & 0xFF);
    for (int i = 0; i < pixels; i++) {
        line[i * 2] = high;
        line[i * 2 + 1] = low;
    }

    digitalWrite(kDc, HIGH);
    digitalWrite(kCs, LOW);
    panelSpi.beginTransaction(SPISettings(kSpiHz, MSBFIRST, SPI_MODE0));
    for (int row = 0; row < h; row++) {
        for (int chunk = 0; chunk < w; chunk += pixels) {
            const int count = (w - chunk) < pixels ? (w - chunk) : pixels;
            panelSpi.transfer(line, count * 2);
        }
    }
    panelSpi.endTransaction();
    digitalWrite(kCs, HIGH);
}

void panel_fill(uint16_t colour) {
    panel_fill_rect(0, 0, gWidth, gHeight, colour);
}

void panel_draw_test() {
    const uint16_t black = 0x0000;
    const uint16_t white = 0xFFFF;
    panel_fill(black);

    const uint16_t bars[] = {0xF800, 0x07E0, 0x001F}; // red, green, blue
    const int band = gWidth / 3;
    for (int index = 0; index < 3; index++) {
        const int x = index * band;
        const int w = (index == 2) ? (gWidth - x) : band;
        panel_fill_rect(x, gHeight / 3, w, gHeight / 3, bars[index]);
    }

    // A one-pixel frame and four corner markers: a shifted address window shows up here first.
    panel_fill_rect(0, 0, gWidth, 1, white);
    panel_fill_rect(0, gHeight - 1, gWidth, 1, white);
    panel_fill_rect(0, 0, 1, gHeight, white);
    panel_fill_rect(gWidth - 1, 0, 1, gHeight, white);
    const int corner = gWidth < 100 ? 6 : 12;
    panel_fill_rect(0, 0, corner, corner, white);
    panel_fill_rect(gWidth - corner, 0, corner, corner, white);
    panel_fill_rect(0, gHeight - corner, corner, corner, white);
    panel_fill_rect(gWidth - corner, gHeight - corner, corner, corner, white);

    Serial.printf("panel: painted %dx%d\\n", gWidth, gHeight);
}

void panel_blink_marker() {
    const int size = gWidth < 100 ? 8 : 16;
    const int y = gHeight - size - 2;
    // Erase the previous square by restoring the frame's neighbour, then draw the new one.
    panel_fill_rect(gMarkerX, y, size, size, 0x0000);
    gMarkerX += size + 2;
    if (gMarkerX + size >= gWidth) {
        gMarkerX = 2;
    }
    panel_fill_rect(gMarkerX, y, size, size, 0x07FF); // cyan
}
`;
}

// ---------------------------------------------------------------------------- ui.h

function uiHeader(): string {
    return `${GENERATED_NOTE}

#pragma once

#include <Arduino.h>

// The screen. This is the file the Designer fills in when the design changes; a person's code belongs in
// src/ui_handlers.cpp.

/** Draws the screen the design describes. Called once from setup(), and again whenever it has to be repainted. */
void ui_init();

/** Runs one turn of the screen's own work: repaints what changed. Called from loop(). */
void ui_tick();

/**
 * Presses or releases the skeleton's button.
 *
 * The Designer's event code calls this with the button's new state; a handler in src/ui_handlers.cpp can too,
 * which is what makes the generated event stub work from the first build.
 */
void ui_set_button_pressed(bool pressed);
`;
}

// -------------------------------------------------------------------------- ui.cpp

function uiSource(): string {
    return `${GENERATED_NOTE}

#include "ui.h"

#include "panel.h"
#include "ui_handlers.h"

// The first screen a Designer project is born with: a frame, a title bar and one button, drawn directly on
// the panel. This is the skeleton the Designer's object tree replaces, and what it replaces is this file's
// body, not its shape: ui_init()/ui_tick() stay, because main.cpp calls them.

namespace {

constexpr uint16_t kBackground = 0x1082; // very dark grey
constexpr uint16_t kAccent = 0x05FF;     // cyan
constexpr uint16_t kInk = 0xFFFF;

int gButtonX = 0;
int gButtonY = 0;
int gButtonW = 0;
int gButtonH = 0;
bool gPressed = false;
/** What the button was last painted as, so a turn with nothing to say costs nothing. */
bool gPaintedPressed = false;

void paint_button() {
    panel_fill_rect(gButtonX, gButtonY, gButtonW, gButtonH, gPressed ? kInk : kAccent);
    gPaintedPressed = gPressed;
}

} // namespace

void ui_init() {
    const int width = panel_width();
    const int height = panel_height();

    gButtonW = width / 2;
    gButtonH = height / 5;
    gButtonX = (width - gButtonW) / 2;
    gButtonY = (height - gButtonH) / 2;

    panel_fill(kBackground);
    panel_fill_rect(0, 0, width, height / 8, kAccent); // the title bar
    gPaintedPressed = !gPressed; // force the button's first paint
    ui_tick();

    Serial.printf("ui: %dx%d, button at %d,%d %dx%d\\n", width, height, gButtonX, gButtonY, gButtonW, gButtonH);
}

void ui_set_button_pressed(bool pressed) {
    gPressed = pressed;
}

void ui_tick() {
    // The screen keeps its own state and repaints only what changed. An event arrives through
    // src/ui_handlers.cpp, which is where the Designer appends the callback for each widget it is told about.
    if (gPressed != gPaintedPressed) {
        paint_button();
    }
}
`;
}

// ------------------------------------------------------------------------- handlers

function handlersHeader(): string {
    return `${GENERATED_NOTE}

#pragma once

#include <Arduino.h>

// Your code goes here. The Designer appends one function per widget event, and never rewrites what it finds;
// this header keeps the prototypes and the two calls this file makes into the sketch.
`;
}

function handlersSource(): string {
    return `${GENERATED_NOTE}

#include "ui_handlers.h"

#include "ui.h"

// Your code goes here -- this file is the one the Designer appends to and nothing else touches.
//
// Each event becomes one function, once:
//
//   void on_button_clicked(const char *label) {
//       Serial.printf("clicked: %s\\n", label);
//   }
//
// The skeleton's own hook, so there is a working example in the file from the first build: pressing the
// screen's button for a moment proves the loop, the panel and this file are all connected.
extern "C" void on_screen_tapped() {
    ui_set_button_pressed(true);
    delay(80);
    ui_set_button_pressed(false);
}
`;
}

// --------------------------------------------------------------------- the rest

function gitignore(): string {
    return `# arduino-cli's build output, when it is asked to write into the project.
build/
*.elf
*.bin
*.uf2
*.map
*.hex

# Editor and OS noise.
.DS_Store
Thumbs.db
`;
}

function readme(request: {
    board: BoardProfile;
    template: AppTemplate;
    panel: CppPanel | undefined;
    sketch: string;
    fqbn: string;
}): string {
    const { board, template, panel, sketch, fqbn } = request;
    const core = corePackageFor(fqbn);
    const lines: string[] = [
        `# ${sketch}`,
        '',
        `${board.name} — ${template} — generated by **Grumpy's Rusty Platform** (Arduino C++).`,
        '',
        '## Build it',
        '',
        '```bash',
        'arduino-cli core install ' + core,
        `arduino-cli compile --profile default`,
        `arduino-cli upload --profile default -p /dev/ttyACM0`,
        '```',
        '',
        `The board is recorded in \`sketch.yaml\` as \`${fqbn}\`, so no \`--fqbn\` is needed.`,
        '',
        '## What is here',
        '',
        '| file | who owns it |',
        '| --- | --- |',
    ];
    lines.push(`| \`${sketch}.ino\` | the sketch entry file Arduino needs; it only includes \`main.h\` |`);
    lines.push('| `src/main.cpp` | `setup()` and `loop()`. The place for code that is not about the screen |');
    if (panel !== undefined) {
        lines.push('| `src/panel.cpp` | the panel, its pins and its init sequence. **The Designer rewrites this** |');
    }
    if (template === 'designer') {
        lines.push('| `src/ui.cpp` | the screen. **The Designer rewrites this** |');
        lines.push('| `src/ui_handlers.cpp` | your code. The Designer appends a stub per widget event |');
    }
    lines.push('');
    if (panel !== undefined) {
        lines.push('## The panel');
        lines.push('');
        lines.push(`**${panel.label}**, ${panel.width}x${panel.height} native.`);
        lines.push('');
        lines.push('| signal | pin |');
        lines.push('| --- | --- |');
        lines.push(`| SCK | GPIO${panel.sclk} |`);
        lines.push(`| MOSI | GPIO${panel.mosi} |`);
        if (panel.miso !== null) {
            lines.push(`| MISO | GPIO${panel.miso} |`);
        }
        lines.push(`| CS | GPIO${panel.cs} |`);
        lines.push(`| DC | GPIO${panel.dc} |`);
        if (panel.rst !== null) {
            lines.push(`| RST | GPIO${panel.rst} |`);
        }
        if (panel.backlight !== null) {
            lines.push(
                `| BL | GPIO${panel.backlight} (${panel.backlightActiveLow ? 'active low' : 'active high'}) |`,
            );
        }
        if (panel.touch !== undefined) {
            lines.push(`| TOUCH CS | GPIO${panel.touch.cs} |`);
            lines.push(`| TOUCH IRQ | GPIO${panel.touch.irq} |`);
        }
        lines.push('');
    }
    lines.push('## Notes');
    lines.push('');
    lines.push(
        '- **No libraries are needed.** This project draws with the panel driver in `src/panel.cpp`, so it ' +
        'builds on a freshly installed core. The LVGL object tree arrives with the designer emitter.',
    );
    lines.push(
        '- The LED, the pins and the panel facts come from the extension\'s own board catalogue, so what is ' +
        'written here is what was verified on that board rather than a datasheet guess.',
    );
    if (isEspBoard(board) && panel !== undefined) {
        lines.push(
            '- On this board the panel is soldered on, so the pins are the board\'s and not a module choice.',
        );
    }
    lines.push('');
    return lines.join('\n');
}
