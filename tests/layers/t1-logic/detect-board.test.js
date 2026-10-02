'use strict';

const { test, ok, equal, notOk, contains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const { detectBoardFromProject, detectChipFromProject } = compiled('boards/detect');

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
