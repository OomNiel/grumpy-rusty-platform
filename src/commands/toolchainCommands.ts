import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { rpTargets } from '../boards/catalog';
import { espToolchainSummary } from '../toolchain/espToolchain';
import { INSTALL_ESP_TOOLCHAIN, currentEspStatus, installEspToolchain } from './espToolchainCommands';
import { RustyState } from '../state';
import { augmentedEnv, cargoBinDir } from '../util/exec';
import { planInstallation, UDEV_RULES_CONTENT } from '../toolchain/installPlan';
import { runInstallPlan } from '../toolchain/installRunner';
import { addCargoToPath, cargoBinPath, profileCandidates } from '../toolchain/shellPath';
import {
    DEBUGPROBE_IMAGES,
    minimumFirmwareFromProbeRs,
    planProbeFirmwareUpdate,
    updateReason,
} from '../toolchain/debugProbe';
import { BOOTSEL_INFO_FILE, describeUf2Info } from '../flash/bootsel';
import {
    ConfirmWriteRequest,
    isImageCached,
    updateProbeFirmware,
} from '../toolchain/probeFirmwareRunner';

/**
 * The gate before anything is copied onto a BOOTSEL volume. `INFO_UF2.TXT` names only the
 * *type* of board and carries no serial number, so the person at the bench is the only
 * thing standing between this flow and the wrong Pico — which would lose whatever
 * firmware that board was holding.
 */
async function confirmBootselWrite(request: ConfirmWriteRequest): Promise<boolean> {
    const lines = [
        `About to write ${request.image.fileName} (${request.image.size} bytes) to:`,
        request.info
            ? describeUf2Info(request.info)
            : `  ${request.volume}\n  (could not read ${BOOTSEL_INFO_FILE})`,
    ];
    if (request.warning) {
        lines.push('', `⚠ ${request.warning}`);
    }
    lines.push('', 'Make sure this is the board you mean.');
    const answer = await vscode.window.showWarningMessage(
        lines.join('\n'),
        { modal: true },
        'Write firmware',
    );
    return answer === 'Write firmware';
}

async function currentStatus(state: RustyState) {
    return state.status ?? state.refresh();
}

function summaryLine(state: RustyState): string {
    const status = state.status;
    if (!status) {
        return 'Detection has not run yet.';
    }
    const lines = [
        `cargo: ${status.cargo.found ? status.cargo.version ?? 'found' : 'NOT INSTALLED'}`,
        `rustup: ${status.rustup.found ? status.rustup.version ?? 'found' : 'NOT INSTALLED'}`,
        `probe-rs: ${status.probeRs.found ? status.probeRs.version ?? 'found' : 'NOT INSTALLED'}`,
        `targets installed: ${status.installedTargets.join(', ') || '(none)'}`,
        `targets missing: ${status.missingTargets.join(', ') || '(none)'}`,
        `debug probe: ${status.probes.map((p) => `${p.name} [${p.selector}]`).join('; ') || 'none detected'}`,
        `probe status: ${status.probeDiagnosis.message}`,
    ];
    if (status.platform === 'linux') {
        lines.push(`usb permissions: ${status.udevRulesPresent ? 'ok' : 'MISSING'}`);
    }
    return lines.join('\n');
}

export function registerToolchainCommands(state: RustyState, output: vscode.OutputChannel): vscode.Disposable[] {
    /**
     * Appends the cargo PATH block to the user's shell profile(s), after confirming which
     * files change. Kept here so `Check Toolchain` and the palette command share one path.
     */
    async function addCargoToPathInteractive(): Promise<void> {
        const files = profileCandidates(process.platform).map((name) => path.join(os.homedir(), name));
        if (files.length === 0) {
            void vscode.window.showInformationMessage(
                `On Windows, add ${cargoBinPath()} to PATH through the environment-variables dialog — ` +
                'or re-run the rustup installer and let it do it.',
            );
            return;
        }

        const present: string[] = [];
        const pending: Array<{ file: string; content: string }> = [];
        for (const file of files) {
            let text: string;
            try {
                text = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(file))).toString('utf8');
            } catch {
                continue; // ~/.bashrc often does not exist yet
            }
            present.push(file);
            const edit = addCargoToPath(text);
            if (edit.changed) {
                pending.push({ file, content: edit.content });
            }
        }

        if (present.length === 0) {
            void vscode.window.showWarningMessage(`Found no shell profile to edit (looked for ${files.join(', ')}).`);
            return;
        }
        if (pending.length === 0) {
            void vscode.window.showInformationMessage(
                `${cargoBinPath()} is already on PATH in ${present.join(', ')}. Open a new terminal to use it.`,
            );
            return;
        }

        const confirmed = await vscode.window.showWarningMessage(
            [
                `Add ${cargoBinPath()} to PATH by appending a block to:`,
                '',
                ...pending.map((entry) => `  ${entry.file}`),
                '',
                'A .bak copy is kept next to each file. New terminals pick it up immediately.',
                '',
                'Continue?',
            ].join('\n'),
            { modal: true },
            'Add to PATH',
        );
        if (confirmed !== 'Add to PATH') {
            return;
        }

        for (const entry of pending) {
            const uri = vscode.Uri.file(entry.file);
            try {
                await vscode.workspace.fs.copy(uri, vscode.Uri.file(`${entry.file}.bak`), { overwrite: true });
            } catch {
                // A missing backup must not block an additive edit.
            }
            await vscode.workspace.fs.writeFile(uri, Buffer.from(entry.content, 'utf8'));
            output.appendLine(`added ${cargoBinPath()} to PATH in ${entry.file} (backup: ${entry.file}.bak)`);
        }

        const choice = await vscode.window.showInformationMessage(
            'PATH updated. Open a new terminal to use cargo directly — VS Code itself needs a reload.',
            'Open New Terminal',
        );
        if (choice === 'Open New Terminal') {
            vscode.window.createTerminal({ name: 'Rusty: new shell', cwd: os.homedir(), env: augmentedEnv() }).show();
        }
    }

    return [
        vscode.commands.registerCommand(INSTALL_ESP_TOOLCHAIN, async () => {
            await installEspToolchain(output);
        }),
        vscode.commands.registerCommand('rustyPlatform.checkToolchain', async () => {
            await state.refresh();
            const status = state.status;
            output.appendLine(summaryLine(state));
            output.show(true);

            // Reported, but never as a *problem*: an RP-only user does not need the Xtensa
            // toolchain, and telling them it is missing would be noise.
            const esp = await currentEspStatus();
            output.appendLine(`ESP toolchain: ${espToolchainSummary(esp)}`);
            if (!esp.ready) {
                output.appendLine(
                    `  install it with "Install ESP Toolchain" (chips: ${esp.chips.join(', ')})`,
                );
            }

            const problems: string[] = [];
            if (!status?.cargo.found) {
                problems.push('cargo is missing');
            }
            if (!status?.probeRs.found) {
                problems.push('probe-rs is missing');
            }
            if (status && status.missingTargets.length > 0) {
                problems.push(`missing targets: ${status.missingTargets.join(', ')}`);
            }
            // `chip-not-autodetected` is normal for RP235x and not a problem to fix.
            if (
                status &&
                status.probeDiagnosis.kind !== 'ok' &&
                status.probeDiagnosis.kind !== 'chip-not-autodetected'
            ) {
                problems.push(status.probeDiagnosis.message);
            }

            // Cargo can be found by us and still be invisible to the user's own shells: rustup
            // is installed with --no-modify-path, and VS Code inherits a PATH without
            // ~/.cargo/bin. Our terminals add it, a hand-opened one cannot.
            const notOnShellPath = Boolean(status?.cargo.found) && !(process.env.PATH ?? '').split(path.delimiter).includes(cargoBinDir());

            if (problems.length === 0 && !notOnShellPath) {
                void vscode.window.showInformationMessage("Grumpy's Rusty Platform: toolchain looks good. 🎉");
                return;
            }

            if (problems.length === 0) {
                const choice = await vscode.window.showInformationMessage(
                    `cargo is installed at ${cargoBinPath()} but is not on this shell's PATH, so \`cargo build\` typed by hand will fail.`,
                    'Add Cargo to PATH…',
                );
                if (choice === 'Add Cargo to PATH…') {
                    await addCargoToPathInteractive();
                }
                return;
            }

            const buttons = ['Install Missing Pieces'];
            if (notOnShellPath) {
                buttons.push('Add Cargo to PATH…');
            }
            if (status?.probeDiagnosis.kind === 'firmware-outdated') {
                buttons.push('Update Probe Firmware');
            }
            const notes = [...problems];
            if (notOnShellPath) {
                notes.push(`cargo is not on this shell's PATH (${cargoBinPath()})`);
            }
            const choice = await vscode.window.showWarningMessage(
                `Toolchain needs attention:\n• ${notes.join('\n• ')}`,
                { modal: true },
                ...buttons,
            );
            if (choice === 'Install Missing Pieces') {
                await vscode.commands.executeCommand('rustyPlatform.installToolchain');
            } else if (choice === 'Add Cargo to PATH…') {
                await addCargoToPathInteractive();
            } else if (choice === 'Update Probe Firmware') {
                await vscode.commands.executeCommand('rustyPlatform.updateProbeFirmware');
            }
        }),

        vscode.commands.registerCommand('rustyPlatform.installToolchain', async () => {
            const status = await currentStatus(state);
            const steps = planInstallation(status, {
                targets: rpTargets(),
                platform: process.platform,
                arch: process.arch,
            });

            if (steps.length === 0) {
                void vscode.window.showInformationMessage('Nothing to install — the toolchain is complete.');
                return;
            }

            const listing = steps
                .map((step, index) => `${index + 1}. ${step.title}${step.requiresElevation ? '  (asks for your password)' : ''}`)
                .join('\n');
            const confirmed = await vscode.window.showWarningMessage(
                `The following will be installed:\n\n${listing}\n\nContinue?`,
                { modal: true },
                'Install',
            );
            if (confirmed !== 'Install') {
                return;
            }

            await runInstallPlan({ output }, steps, process.arch);
            await state.refresh();
        }),

        vscode.commands.registerCommand('rustyPlatform.fixShellPath', () => addCargoToPathInteractive()),

        vscode.commands.registerCommand('rustyPlatform.installUdevRules', async () => {
            if (process.platform !== 'linux') {
                void vscode.window.showInformationMessage('USB permissions are only needed on Linux.');
                return;
            }
            const terminal = vscode.window.createTerminal({
                name: 'Rusty Platform: USB permissions',
                cwd: os.homedir(),
            });
            terminal.show();
            const staged = `${os.tmpdir()}/grumpy-rusty-platform-probe-rs.rules`;
            await vscode.workspace.fs.writeFile(
                vscode.Uri.file(staged),
                Buffer.from(UDEV_RULES_CONTENT, 'utf8'),
            );
            terminal.sendText(
                `sudo install -m0644 '${staged}' /etc/udev/rules.d/69-probe-rs.rules && ` +
                'sudo udevadm control --reload-rules && sudo udevadm trigger',
            );
            void vscode.window.showInformationMessage(
                'Type your password in the terminal, then reconnect the debug probe.',
            );
        }),

        vscode.commands.registerCommand('rustyPlatform.showProbes', async () => {
            const status = await currentStatus(state);
            if (status.probes.length === 0) {
                const choice = await vscode.window.showWarningMessage(
                    status.probeDiagnosis.message,
                    'Install Toolchain',
                    'Refresh',
                );
                if (choice === 'Install Toolchain') {
                    await vscode.commands.executeCommand('rustyPlatform.installToolchain');
                } else if (choice === 'Refresh') {
                    await vscode.commands.executeCommand('rustyPlatform.refresh');
                }
                return;
            }
            const picked = await vscode.window.showQuickPick(
                status.probes.map((probe) => ({
                    label: `$(plug) ${probe.name}`,
                    description: probe.selector,
                    detail: `protocol: ${probe.protocol} — ${status.probeDiagnosis.message}`,
                })),
                { title: 'Connected debug probes' },
            );
            void picked;
        }),

        vscode.commands.registerCommand('rustyPlatform.updateProbeFirmware', async () => {
            const status = await currentStatus(state);
            const required = minimumFirmwareFromProbeRs(status.probeDiagnosis.raw ?? '');
            const reason = updateReason(status.probeDiagnosis.kind, required);
            output.appendLine(`probe firmware: ${reason}`);

            const picked = await vscode.window.showQuickPick(
                DEBUGPROBE_IMAGES.map((image) => ({
                    label: image.label,
                    description: `${image.fileName} · ${image.size} bytes`,
                    detail: image.description,
                    image,
                })),
                { title: 'Which firmware should be written?' },
            );
            if (!picked) {
                return;
            }
            const image = picked.image;

            const steps = planProbeFirmwareUpdate(image, {
                hasCachedImage: isImageCached(image),
                diagnosis: status.probeDiagnosis.kind,
            });
            const listing = steps
                .map((step, index) => `${index + 1}. ${step.title}${step.physical ? '   ← needs your hands' : ''}`)
                .join('\n');
            const confirmed = await vscode.window.showWarningMessage(
                `${reason}\n\n${listing}\n\nReady?`,
                { modal: true },
                'Start',
            );
            if (confirmed !== 'Start') {
                return;
            }

            try {
                const { volume, written } = await updateProbeFirmware(image, {
                    output,
                    confirmWrite: confirmBootselWrite,
                });
                if (!written) {
                    output.appendLine(`Nothing was written to ${volume}.`);
                    return;
                }
                output.appendLine(`Wrote ${image.fileName} to ${volume}`);
                void vscode.window.showInformationMessage('Probe firmware written. Give it a few seconds to boot.');
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                output.appendLine(`probe firmware update failed: ${message}`);
                output.show(true);
                const choice = await vscode.window.showErrorMessage(
                    `Firmware update did not finish: ${message.split('\n')[0]}`,
                    'Show Log',
                );
                if (choice === 'Show Log') {
                    output.show(true);
                }
            } finally {
                await state.refresh();
            }
        }),
    ];
}
