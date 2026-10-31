'use strict';

/**
 * A panel wired to a Pico: the module catalogue and the GPIO wiring rules.
 *
 * This is the layer that has to be right before any firmware is written, because everything else reads
 * it: the wizard offers these modules, the Designer's Hardware panel edits these numbers, and the
 * generator turns them into `src/panel.rs`. The rules asserted here are the same ones embassy-rp enforces
 * through its typed pins -- except that a refusal here says "GPIO19 is not an SPI0 data-out pin" instead
 * of a trait-bound error about `MosiPin<SPI0>`.
 */

const { test, ok, notOk, equal, contains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const { boardById } = compiled('boards/catalog');
const {
    DEFAULT_PANEL_ID,
    MAX_GPIO,
    PANEL_MODULES,
    SPI_ALT_BLOCKS,
    SPI_BLOCKS,
    SPI_PIN_FUNCTIONS,
    busLabel,
    cardSharesPanelBus,
    chooseBlock,
    defaultWiring,
    headerPin,
    otherBus,
    panelModule,
    panelModuleOrDefault,
    parseWiring,
    pinFromName,
    planWiring,
    reservedPins,
    rpPinUsage,
    spiIndexOf,
    timeSourcesFor,
    validateWiring,
    wiringFile,
    wiringHasErrors,
} = compiled('boards/panels');

const RP_BOARDS = ['pico', 'pico2', 'picow', 'pico2w'];

function board(id) {
    return boardById(id);
}

/** The wiring with one field replaced, which is how every refusal below is provoked. */
function withPin(wiring, field, value) {
    return { ...wiring, [field]: value };
}

/** The messages of the errors a wiring produces, joined -- so an assertion names the reason it refused. */
function errors(wiring, boardId = 'pico') {
    return validateWiring(board(boardId), wiring)
        .filter((problem) => problem.severity === 'error')
        .map((problem) => problem.message);
}

function warnings(wiring, boardId = 'pico') {
    return validateWiring(board(boardId), wiring)
        .filter((problem) => problem.severity === 'warning')
        .map((problem) => problem.message);
}

test('the catalogue is the three modules the ESP side already lists, under the same ids', () => {
    equal(PANEL_MODULES.length, 3);
    equal(
        PANEL_MODULES.map((module) => module.id),
        ['st7789', 'ili9341', 'st7796'],
    );
    const [st7789, ili9341, st7796] = PANEL_MODULES;
    equal([st7789.width, st7789.height], [240, 240]);
    equal([ili9341.width, ili9341.height], [240, 320]);
    equal([st7796.width, st7796.height], [320, 480]);
    // Only the 1.54" module comes without a touch controller; all three have a card socket.
    notOk(st7789.touch);
    ok(ili9341.touch);
    ok(st7796.touch);
    ok(PANEL_MODULES.every((module) => module.sd));
    equal(DEFAULT_PANEL_ID, 'st7789');
});

test('the glass facts match the ESP catalogue for the same modules', () => {
    // Re-guessed per family is how a module's colour order goes wrong: white turns into a colour and no
    // compiler can see it. The three numbers below are the ESP32-DevKitC's own, verified on real glass.
    const [st7789, ili9341, st7796] = PANEL_MODULES;
    equal([st7789.colorOrder, st7789.mirrorX], ['rgb', false]);
    equal([ili9341.colorOrder, ili9341.mirrorX], ['bgr', true]);
    equal([st7796.colorOrder, st7796.mirrorX], ['bgr', true]);
    equal(st7796.spiHz, 24_000_000);
    notOk(PANEL_MODULES.some((module) => module.invertColors));
});

test('an unknown module id falls back to the default one rather than to nothing', () => {
    equal(panelModuleOrDefault('st7796').id, 'st7796');
    equal(panelModuleOrDefault('gc9a01').id, DEFAULT_PANEL_ID);
    equal(panelModuleOrDefault(undefined).id, DEFAULT_PANEL_ID);
    equal(panelModule('nope'), undefined);
});

test('the default wiring is legal on all four Pico boards, with no errors at all', () => {
    for (const id of RP_BOARDS) {
        const wiring = defaultWiring(board(id));
        equal(errors(wiring, id), [], `${id} rejects its own default wiring`);
        equal(warnings(wiring, id), [], `${id} warns about its own default wiring`);
    }
});

test('the default wiring keeps the card on its own SPI bus, as the modules are wired', () => {
    const wiring = defaultWiring(board('pico2w'), 'ili9341');
    equal(spiIndexOf(wiring.sclk), 0);
    equal(spiIndexOf(wiring.sdSclk), 1);
    notOk(cardSharesPanelBus(wiring));
    // Touch and card are separate peripherals, so the touch shares the panel bus and the card does not.
    ok(wiring.touchCs !== null && wiring.touchIrq !== null);
});

test('a touch module gets touch pins by default and a touchless one does not', () => {
    const st7789 = defaultWiring(board('pico'), 'st7789');
    equal([st7789.touchCs, st7789.touchIrq], [null, null]);
    const st7796 = defaultWiring(board('pico'), 'st7796');
    equal([st7796.touchCs, st7796.touchIrq], [14, 15]);
});

test('the default time source follows the radio: Wi-Fi on the W boards, flash on the others', () => {
    equal(timeSourcesFor(board('pico')), ['flash']);
    equal(timeSourcesFor(board('pico2')), ['flash']);
    equal(timeSourcesFor(board('picow')), ['flash', 'wifi']);
    equal(timeSourcesFor(board('pico2w')), ['flash', 'wifi']);
    equal(defaultWiring(board('pico')).timeSource, 'flash');
    equal(defaultWiring(board('picow')).timeSource, 'wifi');
});

test('SPI clock pins decide the peripheral, and the tables are the HAL\'s own', () => {
    equal(spiIndexOf(18), 0);
    equal(spiIndexOf(10), 1);
    equal(spiIndexOf(17), undefined);
    equal(SPI_PIN_FUNCTIONS[0].sclk, [2, 6, 18]);
    equal(SPI_PIN_FUNCTIONS[1].sclk, [10, 14]);
});

test('GPIO numbers outside the header are refused by name', () => {
    equal(MAX_GPIO, 29);
    const wiring = withPin(defaultWiring(board('pico')), 'dc', 30);
    const messages = errors(wiring);
    equal(messages.length, 1);
    contains(messages[0], 'Panel DC is GPIO30');
    contains(messages[0], 'GPIO0 to GPIO29');
});

test('one GPIO cannot be two signals', () => {
    const wiring = withPin(defaultWiring(board('pico')), 'dc', 17);
    const messages = errors(wiring);
    ok(messages.some((message) => message.includes('GPIO17 is used twice')));
    ok(messages.some((message) => message.includes('Panel CS') && message.includes('Panel DC')));
});

test('the wireless chip\'s own pins are refused, and the LED pin is only a warning', () => {
    const cw = errors(withPin(defaultWiring(board('picow')), 'dc', 24), 'picow');
    ok(cw.some((message) => message.includes('GPIO24') && message.includes('wireless')));

    const led = warnings(withPin(defaultWiring(board('pico')), 'dc', 25), 'pico');
    ok(led.some((message) => message.includes('GPIO25') && message.includes('LED')));
    // The same pin is a plain GPIO on a Pico W (its LED is on the wireless chip), so it is not even a warning.
    const w = withPin(defaultWiring(board('picow')), 'dc', 25);
    ok(errors(w, 'picow').some((message) => message.includes('GPIO25')));
});

test('a pin that is not an SPI pin for the chosen bus is refused with the legal list', () => {
    const notClock = errors(withPin(defaultWiring(board('pico')), 'sclk', 19));
    ok(notClock.some((message) => message.includes('GPIO19 is not an SPI clock pin')));
    ok(notClock.some((message) => message.includes('2, 6 or 18')));

    // GPIO19 is SPI0's data-out pin, so moving the clock to GPIO10 (SPI1) must move MOSI too.
    const wrongBus = errors(withPin(defaultWiring(board('pico')), 'sclk', 10));
    ok(wrongBus.some((message) => message.includes('not an SPI1 data-out pin')));
    ok(wrongBus.some((message) => message.includes('11, 15')));
});

test('a touch module without its pins, or without a data-in line, is refused', () => {
    const noCs = errors(withPin(defaultWiring(board('pico'), 'ili9341'), 'touchCs', null));
    ok(noCs.some((message) => message.includes('touch chip select')));
    const noIrq = errors(withPin(defaultWiring(board('pico'), 'ili9341'), 'touchIrq', null));
    ok(noIrq.some((message) => message.includes('touch interrupt')));
    const noMiso = errors(withPin(defaultWiring(board('pico'), 'ili9341'), 'miso', null));
    ok(noMiso.some((message) => message.includes('Touch reads the panel bus')));
});

test('a touchless module with touch pins says they are ignored rather than failing', () => {
    const wiring = withPin(defaultWiring(board('pico'), 'st7789'), 'touchCs', 14);
    equal(errors(wiring), []);
    ok(warnings(wiring).some((message) => message.includes('no touch controller')));
});

test('the card may share the panel bus, and must not be a second driver on the same peripheral', () => {
    const shared = {
        ...defaultWiring(board('pico'), 'ili9341'),
        sdSclk: 18,
        sdMosi: 19,
        sdMiso: 16,
        sdCs: 13,
    };
    ok(cardSharesPanelBus(shared));
    equal(errors(shared), [], 'a shared bus with its own chip select is legal');

    // SPI0 twice with different pins would be two drivers over one peripheral.
    const twoDrivers = withPin(defaultWiring(board('pico'), 'ili9341'), 'sdSclk', 2);
    const messages = errors(twoDrivers);
    ok(messages.some((message) => message.includes('already the panel\'s bus')));
});

test('three of the card\'s four pins is refused, and so is an illegal card pin', () => {
    const missing = errors(withPin(defaultWiring(board('pico')), 'sdMiso', null));
    ok(missing.some((message) => message.includes('Card MISO is empty')));
    const illegal = errors(withPin(defaultWiring(board('pico')), 'sdMiso', 13));
    ok(illegal.some((message) => message.includes('not an SPI1 data-in pin')));
});

test('a card left switched off is legal: all four pins clear together', () => {
    const noCard = {
        ...defaultWiring(board('pico')),
        sdSclk: null,
        sdMosi: null,
        sdMiso: null,
        sdCs: null,
    };
    equal(errors(noCard), []);
    notOk(cardSharesPanelBus(noCard));
    notOk(rpPinUsage(noCard).some((line) => line.includes('microSD')));
});

test('time over Wi-Fi is refused on a board with no radio, and the RTC module for now', () => {
    const wifiOnPico = errors({ ...defaultWiring(board('pico')), timeSource: 'wifi' });
    ok(wifiOnPico.some((message) => message.includes('no Wi-Fi')));
    const rtc = errors({ ...defaultWiring(board('picow')), timeSource: 'rtc' }, 'picow');
    ok(rtc.some((message) => message.includes('not supported yet')));
    equal(errors({ ...defaultWiring(board('picow')), timeSource: 'wifi' }, 'picow'), []);
});

test('an unknown module id is refused before anything else is looked at', () => {
    const messages = errors({ ...defaultWiring(board('pico')), panel: 'st7735' });
    equal(messages.length, 1);
    contains(messages[0], 'not a module this extension knows');
});

test('reading a file: a cleared pin stays cleared, a missing one is defaulted', () => {
    const { wiring, notes } = parseWiring(
        { panel: 'ili9341', rst: null, backlight: null, cs: 9 },
        board('pico'),
    );
    equal([wiring.rst, wiring.backlight], [null, null]);
    equal(wiring.cs, 9);
    equal(notes, []);
    // Everything the file does not mention comes from the module's own defaults.
    equal(wiring.touchCs, 14);
    equal(wiring.sdSclk, 10);
});

test('reading a file: rubbish is said out loud and replaced, never propagated', () => {
    const unknownModule = parseWiring({ panel: 'gc9a01' }, board('pico'));
    equal(unknownModule.wiring.panel, DEFAULT_PANEL_ID);
    ok(unknownModule.notes.some((note) => note.includes('gc9a01')));

    const badPin = parseWiring({ dc: 'twenty' }, board('pico'));
    equal(badPin.wiring.dc, defaultWiring(board('pico')).dc);
    ok(badPin.notes.some((note) => note.includes('"dc"')));

    const badSource = parseWiring({ timeSource: 'sundial' }, board('pico'));
    equal(badSource.wiring.timeSource, 'flash');
    ok(badSource.notes.some((note) => note.includes('"timeSource"')));

    const notAnObject = parseWiring(7, board('pico'));
    ok(notAnObject.notes.length > 0);
    equal(notAnObject.wiring.panel, DEFAULT_PANEL_ID);
});

test('the file is written in a fixed order with one trailing newline', () => {
    const text = wiringFile(defaultWiring(board('pico'), 'st7796'));
    ok(text.endsWith('\n'));
    notOk(text.endsWith('\n\n'));
    const keys = Object.keys(JSON.parse(text));
    equal(keys[0], 'panel');
    equal(keys[keys.length - 1], 'timeSource');
    // Two saves of the same wiring are byte-identical, which is what keeps a repository from churning.
    equal(wiringFile(parseWiring(JSON.parse(text), board('pico')).wiring), text);
});

test('a GPIO number and the module pin it comes out on are both named', () => {
    // What a soldering iron needs is the header pin, and it is not the GPIO number: GPIO 18 is pin 24. The
    // mapping is the same on all four boards because they are the same 40-pin module.
    equal(headerPin(0), 1);
    equal(headerPin(1), 2);
    equal(headerPin(2), 4);
    equal(headerPin(10), 14);
    equal(headerPin(16), 21);
    equal(headerPin(18), 24);
    equal(headerPin(22), 29);
    equal(headerPin(26), 31);
    equal(headerPin(28), 34);
    // Not brought out: the wireless chip's pins and the on-board LED.
    equal(headerPin(23), null);
    equal(headerPin(24), null);
    equal(headerPin(25), null);
    equal(headerPin(29), null);
    equal(headerPin(null), null, 'an empty box has no pin');
});

test('the README lines name every pin the module actually uses', () => {
    const lines = rpPinUsage(defaultWiring(board('pico'), 'ili9341'));
    ok(lines.some((line) => line.startsWith('GPIO18 (pin 24): panel SPI clock (SPI0)')));
    ok(lines.some((line) => line.includes('touch chip select (XPT2046)')));
    ok(lines.some((line) => line.includes('microSD clock (SPI1)')));
    // A module with no touch controller gets no touch lines even though the wiring type has the fields.
    const noTouch = rpPinUsage(defaultWiring(board('pico'), 'st7789'));
    notOk(noTouch.some((line) => line.includes('touch')));
});

test('PIN_ names are read as numbers, and nothing else is', () => {
    equal(pinFromName('PIN_23'), 23);
    equal(pinFromName('PIN_0'), 0);
    equal(pinFromName('GPIO23'), undefined);
    equal(pinFromName('PIN_'), undefined);
});

test('a wiring is only invalid when something is an error, not a warning', () => {
    ok(wiringHasErrors(validateWiring(board('pico'), withPin(defaultWiring(board('pico')), 'dc', 30))));
    notOk(wiringHasErrors(validateWiring(board('pico'), withPin(defaultWiring(board('pico')), 'dc', 25))));
});

test('validateWiring refuses a half-filled object instead of throwing on it', () => {
    // The Designer sends whole objects, but a test or a hand-edited file can send less; a crash here would
    // take the panel down instead of showing the user what is wrong. An unknown module is refused first,
    // so the signals are never even read.
    const problems = validateWiring(board('pico'), {});
    equal(problems.length, 1);
    contains(problems[0].message, 'not a module this extension knows');
});

// ------------------------------------------------------------------ the planner

/** The pins of a wiring as one comparable object, so a whole plan can be asserted at once. */
function pins(wiring) {
    return {
        sclk: wiring.sclk,
        mosi: wiring.mosi,
        miso: wiring.miso,
        cs: wiring.cs,
        dc: wiring.dc,
        rst: wiring.rst,
        bl: wiring.backlight,
        touch: [wiring.touchCs, wiring.touchIrq],
        card: [wiring.sdSclk, wiring.sdMosi, wiring.sdMiso, wiring.sdCs],
    };
}

/** Plans a wiring for a panel on `bus`, as the Hardware panel's selector does. */
function plan(boardId, panelId, bus, extra = {}) {
    return planWiring({
        panel: panelId,
        bus,
        alt: false,
        sd: true,
        reserved: reservedPins(board(boardId)),
        timeSource: 'flash',
        ...extra,
    });
}

test('SPI0 is planned as a block, with the control lines and the touch pair beside it', () => {
    // The numbers every Pico project has used so far: the panel on 16-19, DC/RESET/BL just above it, the
    // touch pair below, and the card on the other peripheral.
    for (const id of RP_BOARDS) {
        equal(plan(id, 'ili9341', 0).wiring.bus, 0, `${id} remembers the bus it was planned for`);
        equal(pins(plan(id, 'ili9341', 0).wiring), {
            sclk: 18,
            mosi: 19,
            miso: 16,
            cs: 17,
            dc: 20,
            rst: 21,
            bl: 22,
            touch: [14, 15],
            card: [10, 11, 12, 13],
        }, `${id} plans SPI0 differently`);
    }
});

test('SPI1 is planned as its own block, and the card moves to SPI0', () => {
    // 16-19 are the card's on this plan, so BL steps past them to 20 -- the point of planning the card before
    // the control lines rather than after.
    for (const id of RP_BOARDS) {
        const { wiring } = plan(id, 'ili9341', 1);
        equal(pins(wiring), {
            sclk: 10,
            mosi: 11,
            miso: 12,
            cs: 13,
            dc: 14,
            rst: 15,
            bl: 20,
            touch: [8, 9],
            card: [18, 19, 16, 17],
        }, `${id} plans SPI1 differently`);
        equal(spiIndexOf(wiring.sclk), 1);
        equal(spiIndexOf(wiring.sdSclk), 0);
        notOk(cardSharesPanelBus(wiring));
    }
});

test('with the socket switched off the four card pins are left free', () => {
    const { wiring } = plan('pico', 'ili9341', 1, { sd: false });
    equal([wiring.sdSclk, wiring.sdMosi, wiring.sdMiso, wiring.sdCs], [null, null, null, null]);
    // Free means free: BL takes 16, the nearest pin above the block, because nothing holds it now.
    equal(wiring.backlight, 16);
    equal(validateWiring(board('pico'), wiring).filter((problem) => problem.severity === 'error'), []);
});

test('both buses are legal on all four boards, with nothing to warn about', () => {
    for (const id of RP_BOARDS) {
        for (const bus of [0, 1]) {
            for (const panelId of PANEL_MODULES.map((module) => module.id)) {
                const { wiring, notes } = planWirings(id, panelId, bus);
                equal(notes, [], `${id}/${panelId}/SPI${bus} had to move something`);
                equal(errors(wiring, id), [], `${id}/${panelId}/SPI${bus} is not legal`);
                equal(warnings(wiring, id), [], `${id}/${panelId}/SPI${bus} warns`);
            }
        }
    }
});

/** `plan`, with the notes as well. */
function planWirings(boardId, panelId, bus) {
    return plan(boardId, panelId, bus);
}

test('a plan never takes a pin the board itself needs', () => {
    // The radio's four and the LED: a plan that dimmed a backlight from GPIO25 would leave the board unable to
    // blink, and one that took GPIO24 would not boot.
    equal(reservedPins(board('pico')), [25]);
    ok(reservedPins(board('picow')).includes(24));
    ok(reservedPins(board('pico2w')).includes(29));
    for (const id of RP_BOARDS) {
        for (const bus of [0, 1]) {
            for (const panelId of PANEL_MODULES.map((module) => module.id)) {
                const wiring = plan(id, panelId, bus).wiring;
                const used = rpPinUsage(wiring).filter((line) => line !== '');
                for (const pin of reservedPins(board(id))) {
                    notOk(
                        used.some((line) => line.startsWith(`GPIO${pin}:`)),
                        `${id} planned a signal on reserved GPIO${pin}`,
                    );
                }
            }
        }
    }
});

test('an override survives a bus change when it is still legal', () => {
    // DC on 26 is legal anywhere, so moving the panel from SPI0 to SPI1 has no reason to touch it.
    const before = withPin(defaultWiring(board('pico'), 'ili9341', 0), 'dc', 26);
    const { wiring, notes } = planWiring({
        panel: 'ili9341',
        bus: 1,
        alt: false,
        sd: true,
        reserved: reservedPins(board('pico')),
        timeSource: 'flash',
        keep: before,
    });
    equal(wiring.dc, 26);
    notOk(notes.some((note) => note.startsWith('DC')), 'DC was kept but reported as moved');
    // The SPI pins cannot survive: 18 is not an SPI1 clock.
    ok(notes.some((note) => note === 'SCK moved from GPIO18 to GPIO10'));
    ok(notes.some((note) => note.includes('MOSI moved from GPIO19 to GPIO11')));
});

test('an override that is no longer legal is planned again, and said so', () => {
    // MOSI 3 is SPI0's alone. On SPI1 the plan has to give it 11, and the user has to be told which pin moved
    // rather than finding a silently different number in the field.
    const before = withPin(defaultWiring(board('pico'), 'ili9341', 0), 'mosi', 3);
    const { wiring, notes } = planWiring({
        panel: 'ili9341',
        bus: 1,
        alt: false,
        sd: true,
        reserved: reservedPins(board('pico')),
        timeSource: 'flash',
        keep: before,
    });
    equal(wiring.mosi, 11);
    ok(notes.includes('MOSI moved from GPIO3 to GPIO11'));
});

test('planning is stable: the same wiring planned again moves nothing', () => {
    const first = plan('pico2w', 'st7796', 1).wiring;
    const second = planWiring({
        panel: 'st7796',
        bus: 1,
        alt: false,
        sd: true,
        reserved: reservedPins(board('pico2w')),
        timeSource: 'flash',
        keep: first,
    });
    equal(second.notes, []);
    equal(second.wiring, first);
});

test('the module decides whether there is a touch pair to assign', () => {
    const touchless = plan('pico', 'st7789', 0).wiring;
    equal([touchless.touchCs, touchless.touchIrq], [null, null]);
    const touch = plan('pico', 'st7789', 0, { keep: touchless });
    // Switching module to one with a controller assigns the pair it needs.
    const switching = planWiring({
        panel: 'ili9341',
        bus: 0,
        alt: false,
        sd: true,
        reserved: reservedPins(board('pico')),
        timeSource: 'flash',
        keep: touchless,
    });
    equal([switching.wiring.touchCs, switching.wiring.touchIrq], [14, 15]);
    equal(touch.notes, []);
});

test('the blocks are the four pins each peripheral owns, and the other bus is the other one', () => {
    equal(SPI_BLOCKS[0], { sclk: 18, mosi: 19, miso: 16, cs: 17 });
    equal(SPI_BLOCKS[1], { sclk: 10, mosi: 11, miso: 12, cs: 13 });
    // Every pin in a block is a legal function for that role on that peripheral -- the planner starts from the
    // block, so a block pin the HAL does not accept would be a plan the compiler refuses.
    for (const bus of [0, 1]) {
        for (const role of ['sclk', 'mosi', 'miso']) {
            ok(
                SPI_PIN_FUNCTIONS[bus][role].includes(SPI_BLOCKS[bus][role]),
                `SPI${bus} ${role} GPIO${SPI_BLOCKS[bus][role]} is not one of its own pins`,
            );
        }
        equal(spiIndexOf(SPI_BLOCKS[bus].sclk), bus);
    }
    equal(otherBus(0), 1);
    equal(otherBus(1), 0);
});

test('a wiring whose bus contradicts its own clock pin is an error, not a re-plan', () => {
    // The bus is what the firmware was planned against; a clock pin from the other peripheral means the two
    // disagree, and guessing which was meant would compile the wrong pins.
    const wiring = { ...defaultWiring(board('pico'), 'ili9341', 0), bus: 1 };
    const messages = errors(wiring);
    ok(messages.some((message) => message.includes('SPI0 clock pin') && message.includes('display bus is SPI1')));
});

test('an older hardware file has its bus read from the clock pin', () => {
    // Files written before the bus existed: SPI1 is the only honest answer for a 10/11/12/13 wiring.
    const text = {
        panel: 'ili9341',
        sclk: 10,
        mosi: 11,
        miso: 12,
        cs: 13,
        dc: 14,
        rst: 15,
        backlight: 20,
        backlightActiveLow: false,
        touchCs: 8,
        touchIrq: 9,
        sdSclk: 18,
        sdMosi: 19,
        sdMiso: 16,
        sdCs: 17,
        timeSource: 'flash',
    };
    const parsed = parseWiring(text, board('pico'), 'st7789');
    equal(parsed.wiring.bus, 1);
    equal(errors(parsed.wiring), []);

    // And it is written back, in the fixed order, so the file gains the field once and stops churning.
    const written = wiringFile(parsed.wiring);
    contains(written, '  "panel": "ili9341",\n  "bus": 1,\n  "alt": false,\n  "sclk": 10,');
    equal(JSON.parse(written).bus, 1);
});

// ------------------------------------------------- SPI0's second group of pins

/** Plans the wiring on SPI0's low group, as picking "SPI0-Alt" in the bus list does. */
function lowGroup(boardId, base) {
    return planWiring({
        panel: 'ili9341',
        bus: 0,
        alt: true,
        sd: true,
        reserved: reservedPins(board(boardId)),
        timeSource: 'flash',
        keep: base,
    });
}

test('the bus list names the group: SPI0, SPI0-Alt and SPI1', () => {
    equal(SPI_ALT_BLOCKS[0], { sclk: 2, mosi: 3, miso: 4, cs: 5 });
    equal(SPI_ALT_BLOCKS[1], undefined, 'SPI1 has one group of pins');
    ok(chooseBlock(0, false) === SPI_BLOCKS[0]);
    ok(chooseBlock(0, true) === SPI_ALT_BLOCKS[0]);
    ok(chooseBlock(1, true) === SPI_BLOCKS[1], 'the low group is SPI0\'s alone');
    equal(busLabel(0, false), 'SPI0 (GPIO 18/19/16/17)');
    equal(busLabel(0, true), 'SPI0-Alt (GPIO 2/3/4/5)');
    equal(busLabel(1, false), 'SPI1 (GPIO 10/11/12/13)');
});

test('picking SPI0-Alt moves the whole group, and leaves SPI1 alone', () => {
    // What the third entry of the bus list is for: the four SPI pins and the control lines around them are
    // planned again to match the group. The card is on the other peripheral, so none of its pins move.
    const base = defaultWiring(board('pico2w'), 'ili9341', 0);
    const { wiring, notes } = lowGroup('pico2w', base);
    equal(pins(wiring), {
        sclk: 2,
        mosi: 3,
        miso: 4,
        cs: 5,
        dc: 6,
        rst: 7,
        bl: 8,
        touch: [0, 1],
        card: [10, 11, 12, 13],
    });
    equal(wiring.alt, true);
    ok(notes.includes('MOSI moved from GPIO19 to GPIO3'));
    ok(notes.includes('DC moved from GPIO20 to GPIO6'));
    ok(notes.includes('BL moved from GPIO22 to GPIO8'));
    notOk(notes.some((note) => note.startsWith('Card')), 'the card stayed where it was');
    equal(errors(wiring), [], 'and the plan is legal');
});

test('the low group is legal on all four boards', () => {
    for (const id of RP_BOARDS) {
        const base = defaultWiring(board(id), 'ili9341', 0);
        const { wiring } = lowGroup(id, base);
        equal(errors(wiring, id), [], `${id} rejects the low group`);
        equal(warnings(wiring, id), [], `${id} warns about the low group`);
        equal(spiIndexOf(wiring.sclk), 0, `${id}: GPIO2 is still SPI0's clock`);
    }
});

test('picking SPI0 again returns the high group', () => {
    const base = defaultWiring(board('pico2w'), 'ili9341', 0);
    const low = lowGroup('pico2w', base).wiring;
    const back = planWiring({
        panel: 'ili9341',
        bus: 0,
        alt: false,
        sd: true,
        reserved: reservedPins(board('pico2w')),
        timeSource: 'flash',
        keep: low,
    });
    equal(pins(back.wiring), pins(base));
    equal(back.wiring.alt, false);
});

test('a socket switched off does not move the panel off the group it is on', () => {
    // The SD switch replans with the same bus and group, so only the four card pins come and go.
    const base = defaultWiring(board('pico'), 'ili9341', 0);
    const low = lowGroup('pico', base).wiring;
    const off = planWiring({
        panel: 'ili9341',
        bus: 0,
        alt: true,
        sd: false,
        reserved: reservedPins(board('pico')),
        timeSource: 'flash',
        keep: low,
    }).wiring;
    equal([off.sclk, off.mosi, off.miso, off.cs], [2, 3, 4, 5]);
    equal([off.dc, off.rst, off.backlight], [6, 7, 8]);
    equal([off.sdSclk, off.sdMosi, off.sdMiso, off.sdCs], [null, null, null, null]);
});

test('a clock pin from the other group is a warning that names the option', () => {
    // Typing GPIO2 into the clock box while the bus list still says SPI0 leaves a legal but mixed wiring: it is
    // not an error, so it saves -- but the panel says which entry of the list plans the rest of the group.
    const mixed = withPin(defaultWiring(board('pico'), 'ili9341', 0), 'sclk', 2);
    equal(errors(mixed), [], 'the pins themselves are legal');
    const said = warnings(mixed);
    equal(said.length, 1);
    contains(said[0], 'on SPI0 (GPIO 18/19/16/17), but SCK is GPIO2');
    contains(said[0], 'Choose SPI0-Alt');

    // And the other way round: SPI0-Alt with the high group's clock.
    const other = withPin(lowGroup('pico', defaultWiring(board('pico'), 'ili9341', 0)).wiring, 'sclk', 18);
    ok(warnings(other).some((message) => message.includes('on SPI0-Alt (GPIO 2/3/4/5), but SCK is GPIO18')));
});

test('the choice is written to the file, and read back', () => {
    const low = lowGroup('pico', defaultWiring(board('pico'), 'ili9341', 0)).wiring;
    const text = wiringFile(low);
    contains(text, '"bus": 0,\n  "alt": true,\n  "sclk": 2,');
    equal(parseWiring(JSON.parse(text), board('pico'), 'st7789').wiring.alt, true);
    // A file written before the choice existed: the clock pin says which group it is on.
    const legacy = { ...low };
    delete legacy.alt;
    equal(parseWiring(legacy, board('pico'), 'st7789').wiring.alt, true, 'GPIO2 reads as the low group');
    equal(
        parseWiring({ ...legacy, sclk: 18 }, board('pico'), 'st7789').wiring.alt,
        false,
        'and GPIO18 as the high one',
    );
    // Never on SPI1, which has no second group: a stray `true` is written as false and reads back as false.
    const spi1 = { ...defaultWiring(board('pico'), 'ili9341', 1), alt: true };
    contains(wiringFile(spi1), '"alt": false');
    equal(parseWiring(spi1, board('pico'), 'st7789').wiring.alt, false);
});


test('a GPIO with no header pin is named without one', () => {
    // GPIO 25 is the on-board LED on a plain Pico: a real signal that has no pin to solder to, so the README
    // says "GPIO25" and stops rather than naming a pin that is not there.
    const wiring = { ...defaultWiring(board('pico'), 'ili9341'), backlight: 25 };
    const line = rpPinUsage(wiring).find((each) => each.startsWith('GPIO25'));
    ok(line !== undefined, 'the backlight is listed');
    notOk(line.includes('(pin'), `nothing to bracket: ${line}`);
});
