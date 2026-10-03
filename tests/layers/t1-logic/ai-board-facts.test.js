'use strict';

/**
 * The board facts handed to the model before it writes a line of Rust.
 *
 * A small local model asked to blink an LED on a Pico W writes `PIN_25` — which exists, and is the LED pin
 * on the *non-wireless* Pico, so the compiler accepts the wrong program. These tests pin the facts that
 * stop exactly that: the CYW43 LED is not a GPIO, a GPIO board names its pin, and a board with a panel
 * lists the SPI pins the panel is actually soldered to.
 */

const { test, ok, equal, contains, notContains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const { boardFacts, ledText } = compiled('ai/boardFacts');
const { BOARDS } = compiled('boards/catalog');

function board(id) {
    const found = BOARDS.find((candidate) => candidate.id === id);
    ok(found, `unknown board ${id}`);
    return found;
}

test('no board means no facts block at all', () => {
    equal(boardFacts(undefined), '');
});

test('a CYW43 LED board says the LED is not a GPIO pin', () => {
    for (const id of ['picow', 'pico2w']) {
        const facts = boardFacts(board(id));
        contains(facts, 'CYW43');
        contains(facts, 'NOT a GPIO pin');
        contains(facts, 'Do not use a PIN_25-style constant');
        notContains(facts, 'On-board LED on GPIO');
    }
});

test('a GPIO LED board names the pin it is on', () => {
    contains(boardFacts(board('pico')), 'On-board LED on GPIO PIN_25.');
    contains(boardFacts(board('pico2')), 'On-board LED on GPIO PIN_25.');
});

test('ledText describes every LED kind', () => {
    equal(ledText({ kind: 'none' }), 'This board has no LED.');
    contains(ledText({ kind: 'gpio', pin: '4', external: true }), 'GPIO 4');
    contains(ledText({ kind: 'gpio', pin: '25', external: false }), 'On-board LED on GPIO 25.');
    contains(ledText({ kind: 'cyw43', index: 0 }), 'index 0');
});

test('a board with a panel lists the panel’s SPI pins', () => {
    const facts = boardFacts(board('sunton-3248s035r'));
    contains(facts, 'Panel:');
    contains(facts, 'sclk=14 mosi=13');
    contains(facts, 'cs=15 dc=2');
    contains(facts, 'backlight=27');
    contains(facts, '24000000 Hz');
});

test('an ESP board opens with its flash size and closes with the no-invention rule', () => {
    const facts = boardFacts(board('esp32-devkitc'));
    contains(facts, 'Flash: 4 MB');
    contains(facts, 'Never invent a GPIO number');
});

test('a chip passed in is named on the board line', () => {
    contains(boardFacts(board('picow'), 'RP2040'), 'chip `RP2040`');
});
