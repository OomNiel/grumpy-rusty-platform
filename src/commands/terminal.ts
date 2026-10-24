import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { EXPORT_ESP_FILES, parseExportEspFile } from '../toolchain/espToolchain';
import { augmentedEnv } from '../util/exec';
import { activeWifiEnv, wifiEnvVersion } from '../wifi/credentials';
import { activeSmtpEnv, smtpEnvVersion } from '../smtp/credentials';

/**
 * Terminal helper.
 *
 * Build/flash/monitor must run in a *real* terminal (not a child process): the
 * user needs to see defmt output, cancel long builds and, for the udev step,
 * type a sudo password.
 *
 * Every terminal we create gets `augmentedEnv()`, because VS Code started from a desktop
 * launcher inherits a PATH without `~/.cargo/bin` — and rustup is installed with
 * `--no-modify-path`, so nothing else puts it there either. Without this, Build fails with
 * "Command 'cargo' not found" even though the extension found cargo seconds earlier
 * (detection looks in `~/.cargo/bin` explicitly).
 */

interface TerminalEntry {
    terminal: vscode.Terminal;
    /** The name we asked for: `Terminal.name` is VS Code's, and it may add a suffix. */
    name: string;
    cwd?: string;
}

const terminals = new Map<string, TerminalEntry>();

export function runInTerminal(name: string, command: string, cwd?: vscode.Uri): vscode.Terminal {
    // The Wi-Fi credentials are part of the identity: a terminal created before the prompt must not
    // be reused for a build after it, or the image would silently carry the placeholder SSID. The
    // SMTP password is in the same identity class: it is part of the build environment too.
    const key = `${name}::${cwd?.toString() ?? ''}::${wifiEnvVersion()}::${smtpEnvVersion()}::${espEnvVersion()}`;
    const existing = terminals.get(key);
    let terminal = existing && existing.terminal.exitStatus === undefined ? existing.terminal : undefined;

    if (!terminal) {
        terminal = vscode.window.createTerminal({
            name,
            cwd,
            env: augmentedEnv({ ...activeWifiEnv(), ...activeSmtpEnv(), ...espEnv() }),
        });
        terminals.set(key, { terminal, name, cwd: cwd?.toString() });
        terminal.sendText(command);
    } else {
        terminal.sendText(command);
    }

    if (vscode.workspace.getConfiguration('rustyPlatform').get<boolean>('revealTerminalOnRun', true)) {
        terminal.show(false);
    }
    return terminal;
}

/**
 * espup's environment, for the commands we start ourselves.
 *
 * `espup install` writes `~/export-esp.sh` (`~/export-esp.ps1` on Windows), and the Xtensa linker
 * only exists on PATH after it has been sourced. Sourcing it from here is not an option (it would
 * have to happen in the process we spawn, and a terminal's `source` cannot reach the extension
 * host), so the file is read and its variables are merged into the environment instead. Empty when
 * espup was never installed, which is also the normal case for an RP project.
 */
export function espEnv(): Record<string, string> {
    const home = os.homedir();
    let fileName: string | undefined;
    let content: string | undefined;
    for (const candidate of EXPORT_ESP_FILES) {
        try {
            content = fs.readFileSync(path.join(home, candidate), 'utf8');
            fileName = candidate;
            break;
        } catch {
            // espup writes exactly one of them, depending on the platform.
        }
    }
    if (content === undefined || fileName === undefined) {
        return {};
    }

    const exported = parseExportEspFile(fileName, content, home);
    const patch: Record<string, string> = { ...exported.vars };
    if (exported.pathPrepend.length > 0) {
        const existing = augmentedEnv().PATH ?? '';
        patch.PATH = [...exported.pathPrepend, ...(existing === '' ? [] : [existing])].join(path.delimiter);
    }
    return patch;
}

/** Part of a terminal's identity: a shell started before the install has the wrong PATH. */
function espEnvVersion(): string {
    return EXPORT_ESP_FILES.some((file) => fs.existsSync(path.join(os.homedir(), file)))
        ? 'esp'
        : 'no-esp';
}

/** Called from `deactivate` so we don't keep dead terminals around on reload. */
export function disposeTerminals(): void {
    terminals.clear();
}

/** Names of the terminals we started that are still open. */
export function openTerminalNames(): string[] {
    return [...terminals.values()]
        .filter((entry) => entry.terminal.exitStatus === undefined)
        .map((entry) => entry.name);
}

/**
 * Close a terminal we started.
 *
 * Used when a terminal is *holding* something: `espflash monitor` keeps the serial port open for as
 * long as it runs, so a flash started beside it fails to open the device - the same shape of
 * problem as a debug session holding the probe, and just as easy to misread as a hardware fault.
 */
export function closeTerminal(name: string): boolean {
    let closed = false;
    for (const [key, entry] of terminals) {
        if (entry.name === name && entry.terminal.exitStatus === undefined) {
            entry.terminal.dispose();
            terminals.delete(key);
            closed = true;
        }
    }
    return closed;
}

/**
 * Close *every* terminal the window has open, whoever started it, and answer with their names.
 *
 * A terminal is a thing that holds things: `espflash monitor` and `probe-rs attach` keep the port or
 * the probe for as long as they run, the Designer's clock listener keeps the serial port open for
 * the life of the panel, and a shell where someone typed `espflash monitor` by hand holds it with no
 * record of ours at all. Each of those turns a flash into "could not open the device", which reads as
 * a hardware fault and costs a session to chase.
 *
 * The rule (user, 2026-10-24): *kill all terminals open in the IDE before executing build or
 * flashing.* So this is deliberately the whole list, not just ours - the user's own shells included -
 * and it is why the flash no longer has to ask whether a Monitor terminal may be closed.
 */
export function killAllTerminals(): string[] {
    const names: string[] = [];
    for (const terminal of vscode.window.terminals) {
        names.push(terminal.name);
        terminal.dispose();
    }
    // Our records go with them: an entry whose terminal has exited would only be reused by name.
    for (const [key, entry] of terminals) {
        if (entry.terminal.exitStatus !== undefined) {
            terminals.delete(key);
        }
    }
    return names;
}

/** Prefix used when the user's DEFMT_LOG setting differs from the generated default. */
export function defmtPrefix(): string {
    const level = defmtLogLevel();
    if (level === undefined) {
        return '';
    }
    // The generated .cargo/config.toml sets DEFMT_LOG=debug; only override when the
    // user explicitly chose something else. PowerShell/cmd need different syntax,
    // hence the platform check.
    return process.platform === 'win32' ? `$env:DEFMT_LOG="${level}"; ` : `DEFMT_LOG=${level} `;
}

/**
 * The same override as an environment pair, for builds the extension runs itself rather than in a
 * terminal: `{}` when the generated default stands.
 */
export function defmtEnv(): Record<string, string> {
    const level = defmtLogLevel();
    return level === undefined ? {} : { DEFMT_LOG: level };
}

/** The configured level, or undefined when the generated default (`debug`) should be left alone. */
function defmtLogLevel(): string | undefined {
    const level = vscode.workspace.getConfiguration('rustyPlatform').get<string>('defmtLogLevel', 'debug');
    return level === 'debug' || level === undefined || level === '' ? undefined : level;
}
