/**
 * Installing the Espressif toolchain.
 *
 * The moment a user creates their first ESP project is the moment the toolchain matters, so the
 * offer is made right there rather than buried in a command. Everything the install needs is in
 * `../toolchain/espToolchain`; this file only talks to the editor.
 */

import * as vscode from 'vscode';
import { espTargets } from '../boards/catalog';
import { cargoBinDir } from '../util/exec';
import {
    EspToolchainStatus,
    chipsForTargets,
    espInstallCommandLine,
    espInstallCommands,
    espToolchainSummary,
    missingEspPieces,
} from '../toolchain/espToolchain';
import { detectEspToolchainNow } from '../toolchain/espDetect';
import { runInTerminal } from './terminal';

export const INSTALL_ESP_TOOLCHAIN = 'rustyPlatform.installEspToolchain';

/** The chips every ESP board in the catalog can need, e.g. `['esp32', 'esp32s3']`. */
export function requiredEspChips(): string[] {
    return chipsForTargets(espTargets());
}

export async function currentEspStatus(): Promise<EspToolchainStatus> {
    return detectEspToolchainNow({ chips: requiredEspChips() });
}

/**
 * Run the install steps in a visible terminal.
 *
 * A terminal rather than a spawned process: this downloads a few hundred MB and compiles
 * espflash, so the user should be able to watch it and see any prompt it produces.
 */
export async function installEspToolchain(output: vscode.OutputChannel): Promise<void> {
    const status = await currentEspStatus();
    const steps = espInstallCommands(status, status.chips);

    if (steps.length === 0) {
        void vscode.window.showInformationMessage(`ESP toolchain: ${espToolchainSummary(status)}`);
        return;
    }

    for (const step of steps) {
        output.appendLine(`${step.label}: ${step.command}`);
    }
    output.appendLine('The export file is applied to the extension\'s own builds automatically.');
    output.show(true);

    // VS Code's terminal uses the user's shell, but a desktop-launched editor may not have
    // ~/.cargo/bin on PATH, so it is put there for this one command.
    const line = `export PATH="${cargoBinDir()}:$PATH" && ${espInstallCommandLine(steps)}`;
    runInTerminal('Rusty: ESP toolchain', line);

    void vscode.window.showInformationMessage(
        'Installing the ESP toolchain — watch the terminal. Run "Check Toolchain" when it finishes.',
    );
}

/**
 * Make sure the machine can build for ESP, offering the install when it cannot.
 *
 * Returns true when the toolchain was already complete. A "not now" answer is remembered only
 * for this project creation: the next one asks again, because the reason has not gone away.
 */
export async function ensureEspToolchain(output: vscode.OutputChannel): Promise<boolean> {
    const status = await currentEspStatus();
    if (status.ready) {
        output.appendLine(
            `ESP toolchain: ${espToolchainSummary(status)} (chips: ${status.chips.join(', ')})`,
        );
        return true;
    }

    const missing = missingEspPieces(status);
    const install = 'Install now';
    const showCommands = 'Show commands';

    const answer = await vscode.window.showWarningMessage(
        `This ESP project needs the Xtensa toolchain. Missing: ${missing.join(', ')}.`,
        {
            modal: true,
            detail:
                "Espressif's rustc fork (a few hundred MB) and espflash are installed with espup. " +
                'Until then the project cannot be compiled or flashed.',
        },
        install,
        showCommands,
    );

    if (answer === install) {
        await installEspToolchain(output);
        return false;
    }

    if (answer === showCommands) {
        for (const step of espInstallCommands(status, status.chips)) {
            output.appendLine(`${step.label}: ${step.command}`);
        }
        output.appendLine(espInstallCommands(status, status.chips)[0]?.detail ?? '');
        output.show(true);
    }

    return false;
}
