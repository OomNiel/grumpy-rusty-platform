import * as vscode from 'vscode';
import { RustyState } from '../state';
import { readActiveProject } from '../project/activeProject';
import { defmtPrefix, runInTerminal } from './terminal';

/** Build / Flash / Monitor / Clean, wired to the integrated terminal. */
export function registerProjectCommands(state: RustyState): vscode.Disposable[] {
    const withProject = async (
        run: (folder: vscode.Uri, chip: string | undefined) => void | Promise<void>,
    ): Promise<void> => {
        const status = state.status ?? (await state.refresh());
        if (!status.cargo.found) {
            const choice = await vscode.window.showErrorMessage(
                'cargo was not found. Install the Rust toolchain first.',
                'Install Toolchain',
            );
            if (choice === 'Install Toolchain') {
                await vscode.commands.executeCommand('rustyPlatform.installToolchain');
            }
            return;
        }

        const project = await readActiveProject();
        if (!project) {
            const choice = await vscode.window.showWarningMessage(
                'No Rusty Platform project found in this workspace.',
                'New Project…',
            );
            if (choice === 'New Project…') {
                await vscode.commands.executeCommand('rustyPlatform.newProject');
            }
            return;
        }

        await run(project.folder, project.chip);
    };

    return [
        vscode.commands.registerCommand('rustyPlatform.build', () =>
            withProject((folder) => {
                runInTerminal('Rusty: build', `${defmtPrefix()}cargo build`, folder);
            }),
        ),

        vscode.commands.registerCommand('rustyPlatform.flash', () =>
            withProject((folder) => {
                // `cargo run` uses the runner from .cargo/config.toml (probe-rs run --chip ...),
                // which flashes, resets and streams defmt over RTT.
                runInTerminal('Rusty: flash', `${defmtPrefix()}cargo run --release`, folder);
            }),
        ),

        vscode.commands.registerCommand('rustyPlatform.monitor', () =>
            withProject((folder, chip) => {
                if (!chip) {
                    void vscode.window.showWarningMessage(
                        'Cannot determine the chip id for this project. Add `runner = "probe-rs run --chip <CHIP>"` to .cargo/config.toml.',
                    );
                    return;
                }
                const configured = vscode.workspace.getConfiguration('rustyPlatform').get<string>('probeRsPath');
                const probeRs = configured && configured.trim() !== '' ? configured.trim() : 'probe-rs';
                runInTerminal('Rusty: monitor', `${probeRs} attach --chip ${chip}`, folder);
            }),
        ),

        vscode.commands.registerCommand('rustyPlatform.clean', () =>
            withProject((folder) => {
                runInTerminal('Rusty: build', 'cargo clean', folder);
            }),
        ),
    ];
}
