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

import { execFileSync } from 'child_process';
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
    handover?: ClockHandover,
    platform: NodeJS.Platform = process.platform,
): string {
    const args = espFlashArgs(chip, elfPath, port);
    const rendered = [args[0], ...args.slice(1, -1), quotePath(elfPath)];
    const flash = `${espflash} ${rendered.join(' ')}`;
    if (handover === undefined) {
        return flash;
    }
    // The board only boots into the new image after the write has finished, so the line is sent a
    // couple of seconds later; a write that fails is not a flash that failed.
    const write = writeSerialLineCommand(handover.port, handover.line, platform);
    return platform === 'win32'
        ? `${flash}; if ($LASTEXITCODE -eq 0) { Start-Sleep -Milliseconds 2000; try { ${write} } catch { } }`
        : `${flash} && (sleep 2; ${write} || true)`;
}

/** The local time to hand the board, and the port to hand it over on. */
export interface ClockHandover {
    port: string;
    line: string;
}

/**
 * Follow the log. This one *does* hold the serial port until the terminal is closed — the same
 * trade-off as `probe-rs attach` on the RP side, and the reason a flash cannot run beside it.
 */
export function espMonitorCommand(espflash: string, chip: string, port?: string): string {
    return `${espflash} ${espMonitorArgs(chip, port).join(' ')}`;
}

/**
 * The line the firmware takes its clock from: `TIME HH:MM:SS`, the PC's local time.
 *
 * An ESP32's internal RTC has no battery, so a board that has been powered off has no idea of the
 * time. The firmware reads this line off the console (see `parse_clock_time` in the generated
 * `main.rs`), and a design's clock follows it from then on -- so the hands show the PC's clock, not
 * a count that started when the board booted.
 */
export function clockHandoverLine(now: Date = new Date()): string {
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `TIME ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/**
 * A shell command that writes one line to the serial port, quoted once, for the platform's own
 * shell.
 *
 * There is no serial library in this extension and adding one for a single line would be a
 * dependency on a native module, so the platform's shell does it: `stty` and a redirect on a POSIX
 * shell, `System.IO.Ports` in PowerShell. Both assume the port is free, which it is: this runs
 * after `espflash` has exited and before `espflash monitor` opens it.
 */
export function writeSerialLineCommand(
    port: string,
    line: string,
    platform: NodeJS.Platform = process.platform,
): string {
    if (platform === 'win32') {
        return (
            `$p = [System.IO.Ports.SerialPort]::new('${port}', 115200); $p.Open(); ` +
            `$p.Write("${line}\`n"); $p.Close()`
        );
    }
    // `-F` is GNU stty, `-f` is BSD/macOS: try the one this machine has, so the same command works
    // on both.
    return (
        `(stty -F ${port} 115200 raw -echo 2>/dev/null || stty -f ${port} 115200 raw -echo) && ` +
        `printf '%s\\n' '${line}' > ${port}`
    );
}

/**
 * Both, in one terminal, so the log starts only after a successful write.
 *
 * The chaining operator is shell-specific and cannot be shared: `&&` is POSIX-only, and Windows
 * PowerShell 5.1 -- still what a `terminal.integrated.defaultProfile.windows` of "PowerShell"
 * gives you -- rejects it as a syntax error rather than treating it as a separator. There the
 * second command runs only when the first one reported success, which is the same intent.
 */
export function espFlashAndMonitorCommand(
    espflash: string,
    chip: string,
    elfPath: string,
    port?: string,
    platform: NodeJS.Platform = process.platform,
    handover?: ClockHandover,
): string {
    // The hand-over goes between the two: the monitor holds the port, so it is the last thing that
    // may run. The flash half is built *without* one, so the pair is assembled here exactly once.
    const flash = espFlashCommand(espflash, chip, elfPath, port);
    const monitor = espMonitorCommand(espflash, chip, port);
    const write =
        handover === undefined
            ? undefined
            : writeSerialLineCommand(handover.port, handover.line, platform);
    if (platform === 'win32') {
        const between =
            write === undefined ? '' : `Start-Sleep -Milliseconds 2000; try { ${write} } catch { } `;
        return `${flash}; if ($LASTEXITCODE -eq 0) { ${between}${monitor} }`;
    }
    if (write === undefined) {
        return `${flash} && ${monitor}`;
    }
    // One `&&`, then the write and the monitor in sequence: a failed write must not cost the log.
    return `${flash} && (sleep 2; ${write} || true; ${monitor})`;
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

// --------------------------------------------------------------------- Windows
//
// Windows has no `/dev/serial/by-id`, so the port has to be enumerated through the device manager.
// Two things are worth keeping when it is: which port, and *whose* port -- the vendor id is what
// stops this extension writing to a Raspberry Pi Pico by mistake, and `/dev/serial/by-id` names on
// Linux carry it in the file name. Here it comes from the PNP device id instead, and both are
// folded into `name` so `isEspProgrammerName` keeps working without a second rule book.

/**
 * The PowerShell query that lists every COM port with the device behind it.
 *
 * `Win32_PnPEntity` rather than `Win32_SerialPort`: the latter lists only ports whose serial
 * driver is loaded and registered, so a board whose driver is still starting -- exactly the moment
 * a user presses Flash -- is missing from it. `Win32_PnPEntity` has the port as soon as it exists.
 */
export const WINDOWS_SERIAL_PORT_SCRIPT =
    "Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\\(COM\\d+\\)' } | " +
    'Select-Object Name, PNPDeviceID | ConvertTo-Json -Compress';

/** How to run that query: a command and its arguments, so a test can inspect both. */
export function windowsSerialPortsQuery(): { file: string; args: string[] } {
    return {
        file: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SERIAL_PORT_SCRIPT],
    };
}

/**
 * Parse the query's JSON into entries.
 *
 * `ConvertTo-Json` emits a bare object for one match and an array for several, so both shapes are
 * read. A port whose name has no `(COM<n>)` is dropped; the port is upper-cased because `COM3` and
 * `com3` are the same device to espflash and different strings to a Set.
 */
export function parseWindowsSerialPorts(json: string): SerialPortEntry[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return [];
    }
    if (parsed === null || typeof parsed !== 'object') {
        return [];
    }
    const records: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

    const entries: SerialPortEntry[] = [];
    const seen = new Set<string>();
    for (const record of records) {
        const record$ = record as { Name?: unknown; PNPDeviceID?: unknown } | undefined;
        const name = typeof record$?.Name === 'string' ? record$.Name : '';
        const pnp = typeof record$?.PNPDeviceID === 'string' ? record$.PNPDeviceID : '';
        const match = /\((COM\d+)\)/i.exec(name);
        if (match === null) {
            continue;
        }
        const port = (match[1] ?? '').toUpperCase();
        if (port === '' || seen.has(port)) {
            continue;
        }
        seen.add(port);
        // The friendly name reads well in a log; the PNP id is the half that carries the vendor.
        entries.push({ name: `${name} ${pnp}`.trim(), target: port });
    }
    return entries;
}

/** Runs a command and returns its stdout, or `undefined` when it could not be run at all. */
export type CommandRunner = (file: string, args: string[]) => string | undefined;

const runCommand: CommandRunner = (file, args) => {
    try {
        return execFileSync(file, args, {
            encoding: 'utf8',
            timeout: 15_000,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    } catch {
        // No PowerShell, an execution policy that forbids it, a machine with no COM ports: all of
        // them mean "no candidates", and espflash is then left to ask its own question.
        return undefined;
    }
};

/** The COM ports on this machine, in the shape `serialPortCandidates` takes. */
export function windowsSerialPortEntries(run: CommandRunner = runCommand): SerialPortEntry[] {
    const query = windowsSerialPortsQuery();
    const output = run(query.file, query.args);
    return output === undefined ? [] : parseWindowsSerialPorts(output);
}

/**
 * Serial-port entries for the platform the extension is running on.
 *
 * macOS is deliberately left alone: it publishes `/dev/cu.*` without a stable descriptive name, so
 * there is nothing to filter a vendor out of, and espflash's own picker is the better answer there
 * than a guess.
 */
export function serialPortEntriesForPlatform(
    platform: NodeJS.Platform = process.platform,
    run: CommandRunner = runCommand,
): SerialPortEntry[] {
    return platform === 'win32' ? windowsSerialPortEntries(run) : readSerialPortEntries();
}
