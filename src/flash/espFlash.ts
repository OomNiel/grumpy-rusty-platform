/**
 * Flashing and monitoring an Espressif chip over USB serial with `espflash`.
 *
 * This is not the probe-less *fallback* the RP boards have: an Xtensa chip has no SWD at all, so
 * there is no probe route to fall back from. That is why the flash route is decided by the board
 * before any probe is looked for (see `flashRouteForProject`).
 *
 * The commands here are terminal commands, so they are built as strings and quoted once, here,
 * where a test can see them.
 */

import * as fs from 'fs';
import * as path from 'path';
import { quotePath } from './probeFlash';

/** Where Linux keeps stable, descriptive names for serial devices. */
export const SERIAL_BY_ID_DIR = '/dev/serial/by-id';

export function espFlashArgs(chip: string, elfPath: string, port?: string): string[] {
    const args = ['flash', '--chip', chip];
    if (port !== undefined && port !== '') {
        args.push('--port', port);
    }
    args.push(elfPath);
    return args;
}

export function espMonitorArgs(chip: string, port?: string): string[] {
    const args = ['monitor', '--chip', chip];
    if (port !== undefined && port !== '') {
        args.push('--port', port);
    }
    return args;
}

/**
 * Write the image. One-shot: espflash exits when it is done, which is what keeps the port free
 * for the monitor (or for the next flash).
 */
export function espFlashCommand(
    espflash: string,
    chip: string,
    elfPath: string,
    port?: string,
): string {
    const args = espFlashArgs(chip, elfPath, port);
    const rendered = [args[0], ...args.slice(1, -1), quotePath(elfPath)];
    return `${espflash} ${rendered.join(' ')}`;
}

/**
 * Follow the log. This one *does* hold the serial port until the terminal is closed — the same
 * trade-off as `probe-rs attach` on the RP side, and the reason a flash cannot run beside it.
 */
export function espMonitorCommand(espflash: string, chip: string, port?: string): string {
    return `${espflash} ${espMonitorArgs(chip, port).join(' ')}`;
}

/** Both, in one terminal, so the log starts only after a successful write. */
export function espFlashAndMonitorCommand(
    espflash: string,
    chip: string,
    elfPath: string,
    port?: string,
): string {
    return `${espFlashCommand(espflash, chip, elfPath, port)} && ${espMonitorCommand(espflash, chip, port)}`;
}

/**
 * Does this `/dev/serial/by-id` name belong to an ESP programmer?
 *
 * The bridge chips are what matter: an ESP32-DevKitC has a CP2102, the CYD a CH340, the T-QT
 * presents its native USB. The exclusion is the important half — a Raspberry Pi Pico also
 * publishes a CDC name here, and on this bench one of them is a board that must never be
 * written to by accident.
 */
export function isEspProgrammerName(name: string): boolean {
    if (/Raspberry_Pi_Pico|RP2040|RP2350|2e8a/i.test(name)) {
        return false;
    }
    // Both the descriptive text and the USB vendor id are matched: a CH340 usually shows up as
    // `usb-1a86_USB_Serial-if00-port0`, with the chip's name nowhere in sight.
    // 303a = Espressif, 10c4 = Silicon Labs, 1a86 = WCH (CH340/CH9102), 0403 = FTDI.
    return /Silicon_Labs|CP210|CH34|CH91|QinHeng|wch|Espressif|USB_JTAG|USB-Serial|FTDI|303a|10c4|1a86|0403/i.test(
        name,
    );
}

export interface SerialPortEntry {
    name: string;
    /** What the symlink points at, e.g. `/dev/ttyUSB0`. */
    target: string;
}

/** Read `/dev/serial/by-id`, tolerating a machine that has no such directory. */
export function readSerialPortEntries(dir: string = SERIAL_BY_ID_DIR): SerialPortEntry[] {
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }

    const entries: SerialPortEntry[] = [];
    for (const name of names) {
        try {
            const target = fs.readlinkSync(path.join(dir, name));
            entries.push({ name, target: path.isAbsolute(target) ? target : path.join(dir, target) });
        } catch {
            // A device that vanished between readdir and readlink is simply not a candidate.
        }
    }
    return entries;
}

/** Ports an ESP could be on, most likely first. */
export function serialPortCandidates(entries: SerialPortEntry[]): string[] {
    return entries
        .filter((entry) => isEspProgrammerName(entry.name))
        .map((entry) => entry.target)
        .filter((target, index, all) => all.indexOf(target) === index)
        .sort();
}

/**
 * The port to hand to espflash, or nothing to let it decide.
 *
 * A configured port always wins. Otherwise a *single* candidate is used, because passing it makes
 * espflash non-interactive; with several candidates the choice is espflash's to make (it prints
 * what it found and asks), rather than us guessing between two boards.
 */
export function pickSerialPort(candidates: string[], configured?: string): string | undefined {
    const chosen = configured?.trim();
    if (chosen !== undefined && chosen !== '') {
        return chosen;
    }
    return candidates.length === 1 ? candidates[0] : undefined;
}
