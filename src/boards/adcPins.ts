/**
 * The GPIOs a board can measure with its ADC.
 *
 * The Designer offers these for a status bar's battery pin. The list is per *board* because the pins are a
 * property of the silicon and of what the board already soldered to them: an ESP32's ADC1 is GPIO32-39, an
 * ESP32-S3's is GPIO1-10, and a Pico's is GPIO26-29. A pin the panel, touch controller, SD socket, LED or
 * on-board sensor already uses is still listed -- a battery divider can share a pin with an unused sensor
 * header if that is how the board was wired -- but it carries the name of the thing it is already used by,
 * so choosing it is a deliberate act rather than a surprise.
 *
 * No `vscode` and no `fs`: this is plain board data, like the rest of `src/boards`, so the catalogue and its
 * tests can load it without a window.
 */

import { BOARDS } from './catalog';
import type { BoardProfile } from './types';

/** One selectable ADC input. */
export interface AdcPinOption {
    /** The GPIO number, as the markup and the generated firmware spell it. */
    value: string;
    /** What the Designer shows, e.g. `GPIO34 (ADC1 channel 6)`. */
    label: string;
    /** What the board already does with this pin, when it does anything. */
    usedBy?: string;
    /**
     * True when choosing this pin would take it from something the firmware drives or samples.
     *
     * The LDR is the exception: it is parked on this board and its read is not generated, so the pin is
     * offered as a battery input with its old purpose named rather than hidden.
     */
    disabled?: boolean;
}

/** Every ADC1 pin of an ESP32, with the channel each one samples. */
const ESP32_ADC1: readonly { pin: number; channel: number }[] = [
    { pin: 32, channel: 4 },
    { pin: 33, channel: 5 },
    { pin: 34, channel: 6 },
    { pin: 35, channel: 7 },
    { pin: 36, channel: 0 },
    { pin: 37, channel: 1 },
    { pin: 38, channel: 2 },
    { pin: 39, channel: 3 },
];

/** Every ADC1 pin of an ESP32-S3. */
const ESP32S3_ADC1: readonly { pin: number; channel: number }[] = Array.from(
    { length: 10 },
    (_, index) => ({ pin: index + 1, channel: index }),
);

/** The ADC inputs of an RP2040/RP2350. */
const RP_ADC: readonly { pin: number; channel: number }[] = [
    { pin: 26, channel: 0 },
    { pin: 27, channel: 1 },
    { pin: 28, channel: 2 },
    { pin: 29, channel: 3 },
];

/** Every pin the board itself already drives or reads, and what it is for. */
function usedPins(board: BoardProfile): Map<string, string> {
    const used = new Map<string, string>();
    const mark = (pin: number | string | undefined, what: string): void => {
        if (pin !== undefined) {
            used.set(String(pin), what);
        }
    };
    if (board.kind === 'rp') {
        if (board.led.kind === 'gpio') {
            mark(board.led.pin.replace(/^PIN_/, ''), 'on-board LED');
        }
        if (board.wireless === 'cyw43') {
            const cyw43 = board.cyw43;
            for (const [pin, what] of [
                [cyw43?.pwrPin, 'CYW43 power'],
                [cyw43?.csPin, 'CYW43 CS'],
                [cyw43?.dioPin, 'CYW43 data'],
                [cyw43?.clkPin, 'CYW43 clock'],
            ] as const) {
                mark(pin?.replace(/^PIN_/, ''), what);
            }
        }
        return used;
    }

    for (const display of board.displays) {
        mark(display.cs, 'panel CS');
        mark(display.dc, 'panel DC');
        mark(display.rst, 'panel reset');
        mark(display.backlight, 'panel backlight');
        mark(display.spi.sclk, 'panel SCLK');
        mark(display.spi.mosi, 'panel MOSI');
        mark(display.spi.miso, 'panel MISO');
        if (display.touch !== undefined) {
            mark(display.touch.cs, 'touch CS');
            mark(display.touch.irq, 'touch IRQ');
        }
    }
    if (board.touch !== undefined) {
        mark(board.touch.cs, 'touch CS');
        mark(board.touch.irq, 'touch IRQ');
    }
    if (board.sd !== undefined) {
        mark(board.sd.cs, 'SD CS');
        mark(board.sd.spi.sclk, 'SD SCLK');
        mark(board.sd.spi.mosi, 'SD MOSI');
        mark(board.sd.spi.miso, 'SD MISO');
    }
    mark(board.audio?.pin, 'audio');
    mark(board.ldr?.pin, 'LDR');
    if (board.led.kind === 'gpio') {
        mark(board.led.pin, 'on-board LED');
    } else if (board.led.kind === 'rgb') {
        mark(board.led.red, 'RGB LED red');
        mark(board.led.green, 'RGB LED green');
        mark(board.led.blue, 'RGB LED blue');
    }
    return used;
}

/** The ADC inputs of a board, in a stable order, with what each one is already used for. */
export function adcPinsForBoard(boardId: string): AdcPinOption[] {
    const board = BOARDS.find((entry) => entry.id === boardId);
    if (board === undefined) {
        return [];
    }
    const pins = board.kind === 'rp'
        ? RP_ADC
        : board.family === 'ESP32S3'
            ? ESP32S3_ADC1
            : ESP32_ADC1;
    const used = usedPins(board);
    const adc = board.kind === 'rp' ? 'ADC' : 'ADC1';
    return pins.map(({ pin, channel }) => {
        const what = used.get(String(pin));
        return {
            value: String(pin),
            label: `GPIO${pin} (${adc} channel ${channel})`,
            ...(what === undefined ? {} : { usedBy: what }),
            ...(what === undefined || what === 'LDR' ? {} : { disabled: true }),
        };
    });
}
