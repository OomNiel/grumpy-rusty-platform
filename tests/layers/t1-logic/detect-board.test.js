'use strict';

const fs = require('fs');
const path = require('path');
const { test, ok, equal, notOk, contains, repoRoot } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const { detectBoardFromProject, detectChipFromProject } = compiled('boards/detect');

/** A generated project's manifest, as the generator actually wrote it. */
function manifest(board, template) {
    return fs.readFileSync(
        path.join(repoRoot(), 'tests', 'layers', 't3-golden', '__snapshots__', board, template, 'Cargo.toml'),
        'utf8',
    );
}

const PICO_CARGO = `[package]
name = "blinky"
edition = "2024"

[dependencies]
embassy-rp = { version = "0.10.0", features = ["defmt", "rp2040"] }
`;

const PICO2_CARGO = `[package]
name = "blinky"
edition = "2024"

[dependencies]
embassy-rp = { version = "0.10.0", features = ["defmt", "rp235xa", "binary-info"] }
`;

const PICO_CONFIG = `[target.'cfg(all(target_arch = "arm", target_os = "none"))']
runner = "probe-rs run --chip RP2040"

[build]
target = "thumbv6m-none-eabi"
`;

const PICO2_CONFIG = `[target.'cfg(all(target_arch = "arm", target_os = "none"))']
runner = "probe-rs run --chip RP235x"

[build]
target = "thumbv8m.main-none-eabihf"
`;

test('an rp2040 feature identifies the Pico', () => {
    const board = detectBoardFromProject({ cargoToml: PICO_CARGO, cargoConfigToml: PICO_CONFIG });
    ok(board);
    equal(board.id, 'pico');
});

test('an rp235xa feature identifies the Pico 2', () => {
    const board = detectBoardFromProject({ cargoToml: PICO2_CARGO, cargoConfigToml: PICO2_CONFIG });
    ok(board);
    equal(board.id, 'pico2');
});

test('the chip feature wins over a mismatched config triple', () => {
    const board = detectBoardFromProject({ cargoToml: PICO2_CARGO, cargoConfigToml: PICO_CONFIG });
    equal(board.id, 'pico2');
});

test('the target triple is a fallback when no chip feature is present', () => {
    const board = detectBoardFromProject({
        cargoToml: '[package]\nname = "mystery"\n',
        cargoConfigToml: PICO2_CONFIG,
    });
    ok(board);
    equal(board.id, 'pico2');
});

test('an unrelated Cargo.toml is not mistaken for a board', () => {
    notOk(detectBoardFromProject({ cargoToml: '[package]\nname = "server"\n' }));
    notOk(detectBoardFromProject({ cargoToml: '', cargoConfigToml: '' }));
});

test('the chip id is reported for the monitor command', () => {
    equal(detectChipFromProject({ cargoToml: PICO_CARGO, cargoConfigToml: PICO_CONFIG }), 'RP2040');
    equal(detectChipFromProject({ cargoToml: PICO2_CARGO, cargoConfigToml: PICO2_CONFIG }), 'RP235x');
});

test('the runner line is used when the board is unknown', () => {
    const chip = detectChipFromProject({
        cargoToml: '[package]\nname = "custom"\n',
        cargoConfigToml: 'runner = "probe-rs run --chip STM32G431CBTx"\n',
    });
    equal(chip, 'STM32G431CBTx');
});

test('a project without any probe-rs runner reports no chip', () => {
    equal(detectChipFromProject({ cargoToml: '[package]\nname = "x"\n', cargoConfigToml: '[build]\n' }), undefined);
    contains('no chip', 'no chip');
});

// ------------------------------------------------------------------ ESP32-035 vs DevKitC
//
// Both are esp32 boards with a panel, so the feature guess alone cannot tell them apart -- and the
// ESP32-035 has a soldered XPT2046, which the Designer offers a Touch switch for. Read as a DevKitC
// it got that board's default module (an ST7789 with no controller) and the switch was disabled
// (reported 2026-11-14).

test('an ESP32-035 designer manifest is read as the ESP32-035, not a DevKitC', () => {
    const board = detectBoardFromProject({ cargoToml: manifest('sunton-3248s035r', 'designer') });
    ok(board);
    equal(board.id, 'sunton-3248s035r');
    equal(board.kind, 'esp');
    ok(board.touch, 'the board carries its own touch controller');
    equal(board.touch.controller, 'XPT2046');
});

test('a DevKitC designer manifest keeps its own board and its panel choice', () => {
    const board = detectBoardFromProject({ cargoToml: manifest('esp32-devkitc', 'designer') });
    ok(board);
    equal(board.id, 'esp32-devkitc');
    notOk(board.touch, 'a DevKitC has no controller of its own: the module brings it');
});

test('every generated manifest is read back as the board it names', () => {
    const expected = [
        ['pico', 'pico'],
        ['pico2', 'pico2'],
        ['picow', 'picow'],
        ['pico2w', 'pico2w'],
        ['esp32-devkitc', 'esp32-devkitc'],
        ['lilygo-tqt', 'lilygo-tqt'],
        ['sunton-3248s035r', 'sunton-3248s035r'],
    ];
    for (const [folder, id] of expected) {
        const board = detectBoardFromProject({ cargoToml: manifest(folder, 'designer') });
        equal(board?.id, id, `${folder}/designer`);
    }
});

test('a manifest without the board header is still identified by its panel feature', () => {
    const cargoToml = `[dependencies]
esp-hal = { version = "~1.2.2", features = ["esp32", "log-04"] }
mipidsi = "0.10.0"

[features]
default = ["panel-ili9341"]
panel-ili9341 = []
`;
    equal(detectBoardFromProject({ cargoToml }).id, 'esp32-devkitc');
});
