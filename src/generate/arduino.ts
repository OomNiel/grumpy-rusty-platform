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

import { BOARDS } from '../boards/catalog';
import { BoardProfile, EspDisplay, isEspBoard } from '../boards/types';
import { displayFor } from '../boards/esp';
import { panelModuleOrDefault, wiringFile, type PanelWiring } from '../boards/panels';
import type { LcdRotation } from '../display/rotation';
import { asLcdRotation } from '../display/rotation';
import type { AppTemplate, AppTemplateInfo, GenerateOptions, GeneratedFile } from './files';
import {
    emitHandlerStubsCpp,
    emitHandlersCppHeader,
    emitUiCpp,
    emitUiCppHeader,
} from '../designer/lvgl';
import { DESIGNER_DOCUMENT_PATH, DESIGNER_HARDWARE_PATH, type DesignerDocument } from '../designer/model';
import { starterDocument } from '../designer/generate';

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

/**
 * The catalogue board a sketch is built for, read back out of its FQBN.
 *
 * A crate carries its board in `Cargo.toml`, which is what `detectBoardFromProject` reads. A sketch carries it in
 * `sketch.yaml` instead, and this is the other half of that: the same board record, found by the definition the
 * project names. Without it a C++ project has no board at all, and the Designer -- which decides from the board
 * whether there is a panel to draw -- refuses to open.
 */
export function boardForFqbn(fqbn: string): BoardProfile | undefined {
    // The options tail (`:uploadmethod=picoprobe_cmsis_dap`) says how to program the board, not which board it
    // is, so the comparison is on the first three parts only.
    const wanted = fqbn.trim().split(':').slice(0, 3).join(':');
    if (wanted === '') {
        return undefined;
    }
    for (const board of BOARDS) {
        if (CPP_FQBN[board.id] === wanted) {
            return board;
        }
    }
    return undefined;
}

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
            label: 'WYSIWYG designer',
            description:
                'A project whose screen is a design rather than code: the extension opens the designer for this ' +
                'board, the design is written to src/ui.cpp as LVGL objects, and the widgets\' events land in ' +
                'src/ui_handlers.cpp for you to fill in.',
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

/**
 * The design a C++ Designer project is born with.
 *
 * The same document the Rust designer writes, so one canvas serves both languages and a design can be moved
 * between them. Only the two widgets a starter needs are in it: a title and one button that raises `clicked`,
 * which gives the first build something that proves the whole chain.
 */
function cppStarterDesign(
    board: BoardProfile,
    panel: CppPanel,
    rotation: number | undefined,
): DesignerDocument {
    return starterDocument({
        boardId: board.id,
        panelWidth: panel.width,
        panelHeight: panel.height,
        rotation: asLcdRotation(rotation),
    });
}

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
        // LVGL: the widget library the design is drawn with. Its configuration has to live in the project,
        // and LVGL only looks for `lv_conf.h` where a compiler flag points (see the build properties in
        // toolchain/arduinoBuild.ts) -- which is why the file sits at the root and not in src/.
        // The design itself, so the canvas has something to open: the *same* document format the Rust
        // designer uses, which is what lets one canvas serve both languages.
        const design = cppStarterDesign(board, panel!, options.rotation);
        files.push({ path: DESIGNER_DOCUMENT_PATH, content: `${JSON.stringify(design, null, 2)}\n` });
        if (options.wiring !== undefined) {
            // A Pico's panel is *wired*, so the pins are the project's own record and the Designer edits them.
            // An ESP board's panel is soldered, and the board record already says everything.
            files.push({ path: DESIGNER_HARDWARE_PATH, content: wiringFile(options.wiring) });
        }
        files.push({ path: 'lv_conf.h', content: lvConfHeader() });
        files.push({ path: 'src/lvgl_display.h', content: lvglDisplayHeader() });
        files.push({ path: 'src/lvgl_display.cpp', content: lvglDisplaySource() });
        // Every one of these four comes from the design that was just written above, through the *same*
        // emitters the Designer saves with. A hand-written skeleton here disagreed with them: it called a
        // handler of its own (`on_screen_tapped`) while the save path rewrote the header from the design, so
        // the first build of a real project failed with "'on_screen_tapped' was not declared in this scope"
        // (bench, 2026-10-31). One source of truth for both, and the files cannot drift apart again.
        files.push({ path: 'src/ui.h', content: emitUiCppHeader() });
        files.push({ path: 'src/ui.cpp', content: emitUiCpp(design) });
        files.push({ path: 'src/ui_handlers.h', content: emitHandlersCppHeader(design) });
        files.push({ path: 'src/ui_handlers.cpp', content: handlersSource(design) });
    }

    return files;
}

/**
 * `src/panel.cpp` for a design whose pins have moved.
 *
 * This is the C++ twin of `emitPanelRs` in the Designer's save path: the wiring the Hardware panel edits is the
 * only source of pins, so the file is rewritten from it rather than patched.
 */
export function emitArduinoPanel(
    wiring: PanelWiring,
    rotation: number,
    kind: 'rp' | 'esp' = 'rp',
): { header: string; source: string } {
    return {
        header: panelHeader(),
        source: panelSource(panelFromWiring(wiring), asLcdRotation(rotation), kind),
    };
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
        includes.push(`#include "ui.h"`, `#include "lvgl_display.h"`);
    }

    const setupBody: string[] = [led.setup];
    if (panel !== undefined) {
        setupBody.push('    panel_init();');
    }
    if (template === 'display') {
        setupBody.push('    panel_draw_test();');
    }
    if (template === 'designer') {
        setupBody.push('    lvgl_display_begin();', '    ui_init();');
    }

    const loopBody: string[] = [];
    if (led.loop !== undefined) {
        loopBody.push(led.loop);
    }
    if (template === 'display') {
        loopBody.push('    panel_blink_marker();', '    delay(500);');
    } else if (template === 'designer') {
        // LVGL owns the screen: it is asked for the next frame every few milliseconds and never asked to be
        // drawn by hand. The delay is what keeps the loop from spinning on nothing.
        loopBody.push('    lvgl_display_tick();', '    ui_tick();', '    delay(5);');
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

/**
 * Writes a block of RGB565 pixels straight to the panel.
 *
 * This is the call LVGL's flush hands its drawing to: the rows are already in the panel's own colour format,
 * so nothing is converted and nothing is copied twice.
 */
void panel_blit(int x, int y, int w, int h, const uint16_t *pixels);

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

/** Opens the address window a write is about to fill. */
bool open_window(int x, int y, int w, int h) {
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x >= gWidth || y >= gHeight) {
        return false;
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
    return true;
}

/** Streams a block of RGB565 pixels, row by row, with no buffer of its own. */
void stream_pixels(const uint16_t *pixels, int stride, int w, int h) {
    digitalWrite(kDc, HIGH);
    digitalWrite(kCs, LOW);
    panelSpi.beginTransaction(SPISettings(kSpiHz, MSBFIRST, SPI_MODE0));
    for (int row = 0; row < h; row++) {
        panelSpi.transfer(const_cast<uint16_t *>(pixels + row * stride), static_cast<size_t>(w) * 2);
    }
    panelSpi.endTransaction();
    digitalWrite(kCs, HIGH);
}

void panel_blit(int x, int y, int w, int h, const uint16_t *pixels) {
    if (pixels == nullptr) {
        return;
    }
    const int stride = w;
    if (x + w > gWidth) {
        w = gWidth - x;
    }
    if (y + h > gHeight) {
        h = gHeight - y;
    }
    if (!open_window(x, y, w, h)) {
        return;
    }
    stream_pixels(pixels, stride, w, h);
}

void panel_fill_rect(int x, int y, int w, int h, uint16_t colour) {
    if (x + w > gWidth) {
        w = gWidth - x;
    }
    if (y + h > gHeight) {
        h = gHeight - y;
    }
    if (!open_window(x, y, w, h)) {
        return;
    }
    // One line at a time through a small buffer: a full-screen fill would need 150 KB of RAM on a 240x320
    // panel, which is more than the smaller boards have.
    static uint16_t line[320];
    const int pixels = w < 320 ? w : 320;
    for (int i = 0; i < pixels; i++) {
        line[i] = colour;
    }
    digitalWrite(kDc, HIGH);
    digitalWrite(kCs, LOW);
    panelSpi.beginTransaction(SPISettings(kSpiHz, MSBFIRST, SPI_MODE0));
    for (int row = 0; row < h; row++) {
        for (int chunk = 0; chunk < w; chunk += pixels) {
            const int count = (w - chunk) < pixels ? (w - chunk) : pixels;
            panelSpi.transfer(line, static_cast<size_t>(count) * 2);
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

// ------------------------------------------------------------------------ LVGL

/**
 * The LVGL configuration this project builds with.
 *
 * Only what differs from LVGL's own defaults is set: the colour format of the glass (RGB565), a heap that fits
 * a 320x240 screen with room to spare, no OS (the Arduino loop is the scheduler) and the one font the design
 * format starts with. Everything else is LVGL's default, which is what makes this file short enough to read.
 */
function lvConfHeader(): string {
    return `/* Grumpy's Rusty Platform -- the LVGL configuration for this project.
 *
 * This file is at the project root rather than in src/ because that is where LVGL looks: the build passes
 * \`-DLV_CONF_INCLUDE_SIMPLE -I<project>\` (see the README), and without that flag LVGL looks for
 * \`lv_conf.h\` inside its own library folder instead.
 *
 * Anything not set here is LVGL's own default. */
#ifndef LV_CONF_H
#define LV_CONF_H

/* The panels this extension drives are RGB565. LV_COLOR_DEPTH is deprecated in LVGL 9 and kept only so that
 * an older 9.x still agrees with a newer one. */
#define LV_COLOR_FORMAT_DEFAULT LV_COLOR_FORMAT_RGB565
#define LV_COLOR_DEPTH 16

/* 64 KB: a full 320x240 screen is 150 KB, so LVGL renders through the display buffer and never holds a whole
 * frame. This is the heap for objects, styles and strings. */
#define LV_MEM_SIZE (64 * 1024U)

#define LV_USE_OS LV_OS_NONE
#define LV_USE_LOG 0

/* The font a label starts with. Every other size is off, which is most of LVGL's code size. */
#define LV_FONT_MONTSERRAT_14 1
#define LV_FONT_MONTSERRAT_16 1
#define LV_FONT_DEFAULT &lv_font_montserrat_14

#endif /* LV_CONF_H */
`;
}

function lvglDisplayHeader(): string {
    return `${GENERATED_NOTE}

#pragma once

#include <Arduino.h>

// LVGL's view of the panel: one display, one drawing buffer, and a tick that comes from millis().

/** Initialises LVGL and binds it to the panel. Call after panel_init(). */
void lvgl_display_begin();

/** Gives LVGL its turn: runs the timers and flushes what changed. Call from loop(). */
void lvgl_display_tick();
`;
}

function lvglDisplaySource(): string {
    return `${GENERATED_NOTE}

#include "lvgl_display.h"

#include "lv_conf.h"
#include <lvgl.h>

#include "panel.h"

// The bridge between LVGL and the glass.
//
// LVGL renders into a buffer of its own and hands finished areas to a flush callback; this is that callback,
// and it does one thing -- put the pixels where they belong through the panel driver. The buffer is a band of
// the screen rather than the whole thing: a full 320x240 frame is 150 KB, which no Pico has to spare.

namespace {

// 20 lines of the widest panel this extension drives. 12.8 KB, and small enough to leave the rest of the RAM
// to the sketch.
constexpr int kMaxWidth = 320;
constexpr int kBandLines = 20;
uint16_t gBuffer[kMaxWidth * kBandLines];

lv_display_t *gDisplay = nullptr;

void flush(lv_display_t *display, const lv_area_t *area, uint8_t *pixels) {
    const int w = static_cast<int>(area->x2 - area->x1) + 1;
    const int h = static_cast<int>(area->y2 - area->y1) + 1;
    panel_blit(static_cast<int>(area->x1), static_cast<int>(area->y1), w, h,
               reinterpret_cast<const uint16_t *>(pixels));
    lv_display_flush_ready(display);
}

/** LVGL's clock. millis() is what a sketch already has; nothing here keeps a second one. */
uint32_t tick_ms() {
    return static_cast<uint32_t>(millis());
}

} // namespace

void lvgl_display_begin() {
    lv_init();
    lv_tick_set_cb(tick_ms);

    gDisplay = lv_display_create(panel_width(), panel_height());
    lv_display_set_flush_cb(gDisplay, flush);
    lv_display_set_buffers(gDisplay, gBuffer, nullptr, sizeof(gBuffer), LV_DISPLAY_RENDER_MODE_PARTIAL);

    Serial.printf("lvgl: %s, %dx%d\\n", lv_version_info(), panel_width(), panel_height());
}

void lvgl_display_tick() {
    lv_timer_handler();
}
`;
}

// ------------------------------------------------------------------------- handlers

/**
 * `src/ui_handlers.cpp` for a brand-new project: the stubs the starter design asks for, and nothing else.
 *
 * The file is the one a person owns -- the Designer only ever appends to it and prunes a stub that is still
 * exactly what it wrote -- so what it is born with has to be what `src/ui.cpp` calls, or the first build fails
 * on a handler nobody declared. That is why it takes the note below rather than `GENERATED_NOTE`: this file is
 * not rewritten on save, and saying it is would be the first untrue thing in it.
 */
function handlersSource(design: DesignerDocument): string {
    const stubs = emitHandlerStubsCpp(design).join('\n');
    return `// Generated by Grumpy's Rusty Platform from the design. This file is yours: the Designer appends a stub
// for a new event and removes one the design no longer asks for, and never rewrites what you wrote.

#include "ui_handlers.h"

#include "ui.h"

// Each event becomes one function, once, named after its widget:
//
//   extern "C" void on_go_clicked() {
//       Serial.println("pressed");
//   }
//
// Leave a stub alone (its TODO and its Serial.println are how the Designer tells it from your own code) and it
// is tidied away when the event is unticked; fill it in and it is yours for good.
${stubs}
`;
}

// --------------------------------------------------------------------- the rest

function gitignore(): string {
    return `# arduino-cli's build output, when it is asked to write into the project.
build/
# The compiler database that makes the editor's include paths work ("Arduino: Refresh C++ IntelliSense").
.arduino/
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
        ...(panel !== undefined && template === 'designer'
            ? [
                'arduino-cli lib install lvgl',
                '# LVGL needs its config pointed at, and that is what these two flags do:',
                'arduino-cli compile --fqbn ' + fqbn +
                ' --build-property "compiler.cpp.extra_flags=-DLV_CONF_INCLUDE_SIMPLE -I$PWD"' +
                ' --build-property "compiler.c.extra_flags=-DLV_CONF_INCLUDE_SIMPLE -I$PWD"',
                'arduino-cli upload --fqbn ' + fqbn + ' -p /dev/ttyACM0',
            ]
            : [`arduino-cli compile --profile default`, `arduino-cli upload --profile default -p /dev/ttyACM0`]),
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
