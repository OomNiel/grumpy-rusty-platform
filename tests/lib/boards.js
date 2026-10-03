'use strict';

/**
 * Board sets for the tests.
 *
 * The catalog holds two silicon families that share almost nothing: RP boards are embassy-rp
 * projects with `memory.x`, a probe-rs runner and UF2 images, while ESP boards are esp-hal
 * projects flashed over USB serial. An invariant that is true of one family is usually not
 * even expressible for the other, so the tests say which set they mean instead of iterating
 * every board and asserting RP facts about an ESP board.
 */

const { compiled } = require('./harness');
const { BOARDS } = compiled('boards/catalog');
const { isEspBoard, isRpBoard } = compiled('boards/types');

/** Raspberry Pi boards: embassy-rp, memory.x, probe-rs/UF2. */
function rpBoards() {
    return BOARDS.filter(isRpBoard);
}

/** Espressif boards: esp-hal + esp-rtos, flashed with espflash. */
function espBoards() {
    return BOARDS.filter(isEspBoard);
}

/** Espressif boards with a soldered panel. */
function panelBoards() {
    return espBoards().filter((board) => board.displays.length > 0);
}

module.exports = { rpBoards, espBoards, panelBoards };
