import * as vscode from 'vscode';

/**
 * Terminal helper.
 *
 * Build/flash/monitor must run in a *real* terminal (not a child process): the
 * user needs to see defmt output, cancel long builds and, for the udev step,
 * type a sudo password.
 */

interface TerminalEntry {
    terminal: vscode.Terminal;
    cwd?: string;
}

const terminals = new Map<string, TerminalEntry>();

export function runInTerminal(name: string, command: string, cwd?: vscode.Uri): vscode.Terminal {
    const key = `${name}::${cwd?.toString() ?? ''}`;
    const existing = terminals.get(key);
    let terminal = existing && existing.terminal.exitStatus === undefined ? existing.terminal : undefined;

    if (!terminal) {
        terminal = vscode.window.createTerminal({ name, cwd });
        terminals.set(key, { terminal, cwd: cwd?.toString() });
        terminal.sendText(command);
    } else {
        terminal.sendText(command);
    }

    if (vscode.workspace.getConfiguration('rustyPlatform').get<boolean>('revealTerminalOnRun', true)) {
        terminal.show(false);
    }
    return terminal;
}

/** Called from `deactivate` so we don't keep dead terminals around on reload. */
export function disposeTerminals(): void {
    terminals.clear();
}

/** Prefix used when the user's DEFMT_LOG setting differs from the generated default. */
export function defmtPrefix(): string {
    const level = vscode.workspace.getConfiguration('rustyPlatform').get<string>('defmtLogLevel', 'debug');
    if (level === 'debug' || level === '') {
        return '';
    }
    // The generated .cargo/config.toml sets DEFMT_LOG=debug; only override when the
    // user explicitly chose something else. PowerShell/cmd need different syntax,
    // hence the platform check.
    return process.platform === 'win32' ? `$env:DEFMT_LOG="${level}"; ` : `DEFMT_LOG=${level} `;
}
