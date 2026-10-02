'use strict';

const { test, ok, equal, notOk, contains, notContains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const {
    BOARDS,
    boardById,
    allTargets,
    BOARD_CATALOG_VERSION,
} = compiled('boards/catalog');

test('the catalog contains the two Pico boards', () => {
    ok(boardById('pico'), 'board "pico" missing');
    ok(boardById('pico2'), 'board "pico2" missing');
});

test('board ids are unique', () => {
    const ids = BOARDS.map((b) => b.id);
    equal(new Set(ids).size, ids.length, 'duplicate board id in catalog');
});

test('board names are unique', () => {
    const names = BOARDS.map((b) => b.name);
    equal(new Set(names).size, names.length, 'duplicate board name in catalog');
});

test('unknown board id resolves to undefined', () => {
    notOk(boardById('nope'));
    notOk(boardById(undefined));
});

test('RP2040 board uses the Cortex-M0+ target and a boot2 stage', () => {
    const pico = boardById('pico');
    equal(pico.family, 'RP2040');
    equal(pico.target, 'thumbv6m-none-eabi');
    equal(pico.probeChip, 'RP2040');
    equal(pico.memory.boot2, true, 'RP2040 boots through boot2');
    equal(pico.memory.bootInfoSections, false);
    contains(pico.embassyFeatures.join(','), 'rp2040');
    notContains(pico.embassyFeatures.join(','), 'rp235x', 'RP2040 must not enable RP235x features');
    contains(pico.linkArgs.join(' '), '-Tlink-rp.x', 'RP2040 needs the boot2 linker script');
});

test('RP2350 board uses the Cortex-M33 target, rp235xa and binary-info', () => {
    const pico2 = boardById('pico2');
    equal(pico2.family, 'RP2350');
    equal(pico2.target, 'thumbv8m.main-none-eabihf');
    equal(pico2.probeChip, 'RP235x', 'probe-rs names the RP2350 family "RP235x"');
    equal(pico2.memory.boot2, false, 'RP2350 has no second-stage bootloader');
    equal(pico2.memory.bootInfoSections, true, 'RP2350 needs the boot ROM image definition');
    contains(pico2.embassyFeatures.join(','), 'rp235xa');
    contains(pico2.embassyFeatures.join(','), 'binary-info', 'RP2350 needs binary-info for the image definition');
    notContains(pico2.linkArgs.join(' '), '-Tlink-rp.x', 'RP2350 must not link the boot2 script');
});

test('the Pico 2 splits its 4 MB of flash into a 3 MB app plus a 1 MB drive', () => {
    const memory = boardById('pico2').memory;
    equal(memory.flash.length, '3072K');
    ok(memory.flashReserve, 'the drive reservation must be recorded, not just implied');
    equal(memory.flashReserve.name, 'FS');
    equal(memory.flashReserve.region.origin, '0x10300000');
    equal(memory.flashReserve.region.length, '1024K');
    // 0x10000000 + 3072K == 0x10300000, and 0x10300000 + 1024K == 0x10400000 (4 MB).
    equal(totalFlashBytes(memory), 4 * 1024 * 1024, 'app + drive must cover exactly the 4 MB chip');
});

test('the Pico splits its 2 MB of flash into a 1.5 MB app plus a 512 KB drive', () => {
    const memory = boardById('pico').memory;
    equal(memory.flash.length, '1536K - 0x100', 'the app region stops short of the drive');
    ok(memory.flashReserve, 'the drive reservation must be recorded, not just implied');
    equal(memory.flashReserve.name, 'FS');
    equal(memory.flashReserve.region.origin, '0x10180000');
    equal(memory.flashReserve.region.length, '512K');
    equal(totalFlashBytes(memory), 2 * 1024 * 1024, 'app + drive must cover exactly the 2 MB chip');
});

/** Bytes covered by the application region plus the reserved drive region. */
function totalFlashBytes(memory) {
    return parseFlashSize(memory.flash.length) + parseFlashSize(memory.flashReserve.region.length);
}

function parseFlashSize(text) {
    // The RP2040 app region carries a `- 0x100` boot2 offset, e.g. `1536K - 0x100`.
    const match = /^(\d+)K/.exec(text);
    if (!match) {
        throw new Error(`unexpected flash size ${text}`);
    }
    return Number(match[1]) * 1024;
}

test('every board declares the shared embassy features', () => {
    for (const board of BOARDS) {
        const features = board.embassyFeatures;
        for (const required of ['defmt', 'unstable-pac', 'time-driver', 'critical-section-impl', 'executor-thread', 'executor-interrupt']) {
            ok(features.includes(required), `${board.id} is missing feature "${required}"`);
        }
    }
});

test('every board declares exactly one chip feature', () => {
    for (const board of BOARDS) {
        const chipFeatures = board.embassyFeatures.filter((f) => f === 'rp2040' || f.startsWith('rp235x'));
        equal(chipFeatures.length, 1, `${board.id} should declare exactly one chip feature`);
    }
});

test('every board has an LED pin, notes and a vendor', () => {
    for (const board of BOARDS) {
        matches_pin(board.ledPin, board.id);
        ok(board.notes && board.notes.length > 10, `${board.id} needs notes for the wizard`);
        ok(board.vendor, `${board.id} needs a vendor`);
    }
});

function matches_pin(pin, id) {
    if (!/^PIN_\d+$/.test(pin)) {
        throw new Error(`${id} has an invalid LED pin: ${pin}`);
    }
}

test('allTargets is sorted, unique and covers every board', () => {
    const targets = allTargets();
    equal(targets.length, new Set(targets).size, 'allTargets should not repeat a triple');
    equal(targets, [...targets].sort(), 'allTargets should be sorted');
    for (const board of BOARDS) {
        ok(targets.includes(board.target), `allTargets is missing ${board.target}`);
    }
});

test('the catalog version is a positive integer', () => {
    ok(Number.isInteger(BOARD_CATALOG_VERSION) && BOARD_CATALOG_VERSION > 0);
});
