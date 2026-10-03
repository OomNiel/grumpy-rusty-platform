/* The board, written down for the model — the facts a small local model cannot look up.
 *
 * WHY THIS EXISTS. A local 3B-7B model asked to "blink the LED" will confidently write `PIN_25` on a Pico
 * **W**, where the LED hangs off the CYW43 wireless chip and `PIN_25` is wrong; asked to drive the LCD on
 * a Sunton board it will invent an SPI clock pin. The compiler cannot catch either — the pin constants
 * exist, they are simply the wrong ones — so the fix has to happen before the prompt is sent: tell the
 * model what the board actually is, in the words the project's own board profile already uses.
 *
 * This is the Rust analogue of the designer's `dataSetFactsFor`: the same facts the deterministic parts of
 * the extension use (the generator, the wizard, the README) are handed to the model, so "what is true" has
 * one source rather than a second one invented for the prompt. It is pure and free of `vscode`, so the t1
 * suite can assert what a Pico 2 W and an ESP32-DevKitC actually say.
 */

import type { BoardProfile, BoardLed } from '../boards/types';

/** A `BoardLed` in one line, with the warning its kind deserves. */
export function ledText(led: BoardLed): string {
    switch (led.kind) {
        case 'gpio':
            return led.external
                ? `No on-board LED; GPIO ${led.pin} is offered as an external one (wire your own LED there).`
                : `On-board LED on GPIO ${led.pin}.`;
        case 'cyw43':
            return `On-board LED hangs off the CYW43 wireless chip (index ${led.index}) — it is driven through ` +
                'the cyw43 driver, NOT a GPIO pin. Do not use a PIN_25-style constant for it.';
        case 'none':
            return 'This board has no LED.';
    }
}

/**
 * What the board and its wiring are, as the prompt's "authoritative facts" block.
 *
 * Deliberately ends with the rule that makes the block useful: a model that is told *"never invent a GPIO
 * number"* is measurably less likely to, while the same model told only the pin list still guesses.
 */
export function boardFacts(board: BoardProfile | undefined, chip?: string): string {
    if (!board) return '';
    const lines: string[] = [];
    lines.push(`Board: ${board.vendor} ${board.name} (${board.family}), Rust target \`${board.target}\`${chip ? `, chip \`${chip}\`` : ''}.`);
    lines.push(ledText(board.led));
    if (board.kind === 'rp') {
        lines.push(
            board.wireless === 'cyw43'
                ? 'Wireless: a CYW43 chip on the board (embassy-rp\'s `cyw43` support).'
                : 'No wireless chip on this board.'
        );
        if (board.cyw43) {
            const w = board.cyw43;
            lines.push(
                `CYW43 wiring: pwr=${w.pwrPin}, cs=${w.csPin}, dio=${w.dioPin}, clk=${w.clkPin}, ` +
                `pio=${w.pio}, dma=${w.dmaCh0}/${w.dmaCh1} — use the board's own embassy examples for this, not a guess.`
            );
        }
    } else {
        lines.push(`Flash: ${board.flashSize}${board.psram ? ', with PSRAM (off by default)' : ''}.`);
        for (const d of board.displays) {
            lines.push(
                `Panel: ${d.label} (${d.controller}) ${d.width}x${d.height}, SPI sclk=${d.spi.sclk} mosi=${d.spi.mosi}` +
                `${d.spi.miso !== undefined ? ` miso=${d.spi.miso}` : ''} cs=${d.cs} dc=${d.dc}` +
                `${d.rst !== undefined ? ` rst=${d.rst}` : ''} backlight=${d.backlight}${d.backlightActiveLow ? ' (active low)' : ''}, ` +
                `colour order ${d.colorOrder}, ${d.spiHz} Hz.`
            );
        }
        if (board.touch) {
            const t = board.touch;
            lines.push(`Touch: ${t.controller} on the panel's SPI bus, cs=${t.cs}, irq=${t.irq}.`);
        }
        if (board.sd) {
            lines.push(`microSD: cs=${board.sd.cs}, sclk=${board.sd.spi.sclk}, mosi=${board.sd.spi.mosi}.`);
        }
    }
    if (board.notes.trim()) lines.push(`Board notes: ${board.notes.trim()}`);
    lines.push(
        'This is an embedded `no_std` Embassy project. Never invent a GPIO number, a peripheral name or a ' +
        'HAL method: use only the pins above and the APIs in the dependencies and the code you are given.'
    );
    return lines.join('\n');
}
