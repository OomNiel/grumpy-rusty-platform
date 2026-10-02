import * as vscode from 'vscode';
import * as os from 'os';
import { allTargets } from '../boards/catalog';
import { RustyState } from '../state';
import { planInstallation, UDEV_RULES_CONTENT } from '../toolchain/installPlan';
import { runInstallPlan } from '../toolchain/installRunner';

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
        lines.push(`udev rules: ${status.udevRulesPresent ? 'installed' : 'MISSING'}`);
    }
    return lines.join('\n');
}

export function registerToolchainCommands(state: RustyState, output: vscode.OutputChannel): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('rustyPlatform.checkToolchain', async () => {
            await state.refresh();
            const status = state.status;
            output.appendLine(summaryLine(state));
            output.show(true);

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
            if (status && status.probeDiagnosis.kind !== 'ok') {
                problems.push(status.probeDiagnosis.message);
            }

            if (problems.length === 0) {
                void vscode.window.showInformationMessage("Grumpy's Rusty Platform: toolchain looks good. 🎉");
                return;
            }
            const choice = await vscode.window.showWarningMessage(
                `Toolchain needs attention:\n• ${problems.join('\n• ')}`,
                { modal: true },
                'Install Missing Pieces',
            );
            if (choice === 'Install Missing Pieces') {
                await vscode.commands.executeCommand('rustyPlatform.installToolchain');
            }
        }),

        vscode.commands.registerCommand('rustyPlatform.installToolchain', async () => {
            const status = await currentStatus(state);
            const steps = planInstallation(status, {
                targets: allTargets(),
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
    ];
}
