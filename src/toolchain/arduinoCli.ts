import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExecFn, findExecutable } from '../util/exec';

/**
 * `arduino-cli` itself: where it is, what version it is, and what it has installed.
 *
 * One module for "is the C++ toolchain here?", so the editor config, the Build button and (later) the core
 * installer all agree. Every call here is read-only; nothing installs anything.
 */

/** Where a locally installed `arduino-cli` usually is when it is not on the PATH. */
function arduinoCliCandidates(): string[] {
    const exe = process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli';
    const home = os.homedir();
    return [
        path.join(home, '.local', 'bin', exe),
        path.join(home, 'bin', exe),
        path.join(home, '.arduino15', 'bin', exe),
        // The official installer's defaults.
        '/usr/local/bin/arduino-cli',
        '/opt/homebrew/bin/arduino-cli',
        path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Arduino15', exe),
    ];
}

function isExecutable(candidate: string): boolean {
    try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * The `arduino-cli` this window should use.
 *
 * PATH first (so a version manager's choice wins), then the usual install locations: VS Code started from a
 * desktop launcher does not always inherit the PATH a terminal has.
 */
export function arduinoCliPath(explicitPath?: string): string | undefined {
    // An explicit path wins, exactly as `cargoPath` and `probeRsPath` do: a machine with two arduino-cli builds
    // (an Arduino IDE one and an apt one) must be able to say which. The setting is read by the caller, in
    // `configuredArduinoCliPath`, because this module has to stay importable from a test with no editor.
    if (explicitPath !== undefined && explicitPath.trim() !== '') {
        return findExecutable(explicitPath.trim());
    }
    const onPath = findExecutable('arduino-cli');
    if (onPath !== undefined) {
        return onPath;
    }
    return arduinoCliCandidates().find(isExecutable);
}

export interface ArduinoCore {
    /** `rp2040:rp2040`, as `arduino-cli core list` spells it. */
    id: string;
    version: string;
}

export interface ArduinoStatus {
    /** `undefined` when the tool is not installed at all. */
    cli?: string;
    version?: string;
    cores: ArduinoCore[];
    /** The error from the first command that failed, for the log. */
    trouble?: string;
}

/**
 * Reads the version and the installed cores.
 *
 * `core list --format json` is the machine-readable answer, but older releases printed a table; both shapes are
 * accepted rather than pinning the extension to one CLI version.
 */
export async function detectArduino(run: ExecFn, cliPath?: string): Promise<ArduinoStatus> {
    const cli = cliPath ?? arduinoCliPath();
    if (cli === undefined) {
        return { cores: [] };
    }

    const versionResult = await run(cli, ['version'], { timeoutMs: 20_000 });
    const version = versionResult.code === 0 ? /Version:\s*(\S+)/.exec(versionResult.stdout)?.[1] : undefined;
    if (versionResult.code !== 0) {
        return {
            cli,
            cores: [],
            trouble: (versionResult.stderr || versionResult.stdout).trim().split('\n')[0],
        };
    }

    const coresResult = await run(cli, ['core', 'list', '--format', 'json'], { timeoutMs: 60_000 });
    return { cli, version, cores: parseCoreList(coresResult.stdout), trouble: undefined };
}

/**
 * The installed cores out of `core list --format json`.
 *
 * The JSON is `{"platforms": [{"id": "rp2040:rp2040", "installed": "6.3.1", ...}]}`; anything else (an old
 * CLI printing a table, an empty index) yields no cores rather than an exception, because "no cores" is
 * exactly what the caller must handle anyway.
 */
export function parseCoreList(stdout: string): ArduinoCore[] {
    try {
        const parsed = JSON.parse(stdout) as { platforms?: unknown };
        if (!Array.isArray(parsed.platforms)) {
            return [];
        }
        const cores: ArduinoCore[] = [];
        for (const entry of parsed.platforms) {
            if (entry === null || typeof entry !== 'object') {
                continue;
            }
            const platform = entry as { id?: unknown; installed?: unknown; installed_version?: unknown };
            if (typeof platform.id !== 'string') {
                continue;
            }
            const version = platform.installed ?? platform.installed_version;
            // An entry with no version is in the index but *not* installed; treating it as installed would make
            // the Build button skip the core install and then fail with a much worse message.
            if (typeof version !== 'string' || version.trim() === '') {
                continue;
            }
            cores.push({ id: platform.id, version });
        }
        return cores;
    } catch {
        return [];
    }
}

/** `rp2040:rp2040` for the FQBN `rp2040:rp2040:rpipico2w`; the core a board needs installed. */
export function coreIdFor(fqbn: string): string {
    const parts = fqbn.split(':');
    return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : fqbn;
}

/** Whether the core this board belongs to is installed. */
export function hasCoreFor(status: ArduinoStatus, fqbn: string): boolean {
    const wanted = coreIdFor(fqbn);
    return status.cores.some((core) => core.id === wanted);
}

export interface ArduinoPort {
    address: string;
    /** `serial`, `network`, ... as the CLI reports it. */
    protocol: string;
    label: string;
    /** The board the CLI recognised on that port, when it recognised one. */
    fqbn?: string;
}

/**
 * The ports `arduino-cli board list` reports.
 *
 * Only the ones it can actually talk to: a port with no protocol is a placeholder for a platform whose
 * discovery tool is missing, and offering it would produce an upload that fails for a reason the user cannot
 * see.
 */
export function parseBoardList(stdout: string): ArduinoPort[] {
    try {
        const parsed = JSON.parse(stdout) as { detected_ports?: unknown };
        if (!Array.isArray(parsed.detected_ports)) {
            return [];
        }
        const ports: ArduinoPort[] = [];
        for (const entry of parsed.detected_ports) {
            if (entry === null || typeof entry !== 'object') {
                continue;
            }
            // arduino-cli 1.x wraps the port in its own object and puts the boards it might be beside it:
            // `{"port":{"address","protocol","label"},"matching_boards":[{"name","fqbn"}]}`. Reading the
            // address from the entry itself found nothing, so *every* upload stopped at "No board found on any
            // port" — on a bench with two boards plugged in (2026-10-31). Both shapes are accepted, because the
            // flat one is what arduino-cli itself documented first.
            const entryRecord = entry as {
                port?: unknown;
                matching_boards?: unknown;
                address?: unknown;
                protocol?: unknown;
                protocol_label?: unknown;
                label?: unknown;
                boards?: unknown;
            };
            const port =
                entryRecord.port !== null && typeof entryRecord.port === 'object'
                    ? (entryRecord.port as typeof entryRecord)
                    : entryRecord;
            if (typeof port.address !== 'string' || typeof port.protocol !== 'string') {
                continue;
            }
            const boards = Array.isArray(entryRecord.matching_boards)
                ? entryRecord.matching_boards
                : Array.isArray(entryRecord.boards)
                    ? entryRecord.boards
                    : [];
            const first = boards[0] as { name?: unknown; fqbn?: unknown } | undefined;
            ports.push({
                address: port.address,
                protocol: port.protocol,
                label:
                    typeof first?.name === 'string'
                        ? first.name
                        : typeof port.label === 'string'
                            ? port.label
                            : port.address,
                fqbn: typeof first?.fqbn === 'string' ? first.fqbn : undefined,
            });
        }
        return ports;
    } catch {
        return [];
    }
}

/**
 * The ways this board can be programmed, from the core's own menu.
 *
 * arduino-pico's boards.txt has `menu.uploadmethod` with `default` (UF2 over USB), `picotool` and
 * `picoprobe_cmsis_dap` (a debug probe over SWD), and `arduino-cli board details` reports it. Reading it here
 * means a choice the core offers is a choice the extension can offer, without a table of its own to go stale.
 * Returns the option name (`uploadmethod`) and its values, or `undefined` when the board has no such menu.
 */
export function parseUploadMethodMenu(stdout: string): { option: string; values: string[] } | undefined {
    try {
        const parsed = JSON.parse(stdout) as { config_options?: unknown };
        if (!Array.isArray(parsed.config_options)) {
            return undefined;
        }
        for (const entry of parsed.config_options) {
            const option = (entry as { option?: unknown }).option;
            const values = (entry as { values?: unknown }).values;
            if (typeof option !== 'string' || !Array.isArray(values) || !/^upload/i.test(option)) {
                continue;
            }
            const names = values
                .map((value) => (value as { value?: unknown }).value)
                .filter((value): value is string => typeof value === 'string');
            if (names.length > 0) {
                return { option, values: names };
            }
        }
        return undefined;
    } catch {
        return undefined;
    }
}

/** Asks the CLI which ports are there now. */
export async function listArduinoPorts(run: ExecFn, cliPath: string): Promise<ArduinoPort[]> {
    const result = await run(cliPath, ['board', 'list', '--format', 'json'], { timeoutMs: 30_000 });
    return result.code === 0 ? parseBoardList(result.stdout) : [];
}

/**
 * Records a different FQBN in the project's own manifest.
 *
 * Only the `fqbn:` line is rewritten; the comments around it are the project's documentation of *why* the board
 * is what it is, and a rewrite of the whole file would throw that away. Everything else in the file is left
 * byte for byte.
 */
export function setSketchFqbn(folder: string, fqbn: string): void {
    const file = path.join(folder, 'sketch.yaml');
    const text = fs.readFileSync(file, 'utf8');
    const next = /^\s*fqbn:.*$/m.test(text)
        ? text.replace(/^(\s*fqbn:).*$/m, `$1 ${fqbn}`)
        : `${text.trimEnd()}\n\nfqbn: ${fqbn}\n`;
    fs.writeFileSync(file, next, 'utf8');
}

/** The sketch's board, which is the project's own record and the only thing upload and compile need. */
export function readSketchYaml(folder: string): string | undefined {
    try {
        return fs.readFileSync(path.join(folder, 'sketch.yaml'), 'utf8');
    } catch {
        return undefined;
    }
}
