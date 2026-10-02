import * as vscode from 'vscode';
import * as path from 'path';
import { RustyState } from '../state';
import { ActiveProject, readActiveProject } from '../project/activeProject';
import { ToolchainStatus } from '../toolchain/detect';
import { describeUf2Info } from '../flash/bootsel';
import { flashRouteFor, routeReason, uf2FamilyForProject } from '../flash/route';
import { UsbFlashConfirmation, flashProjectOverUsb } from '../flash/usbFlashRunner';
import { defmtPrefix, runInTerminal } from './terminal';

const PROBE_CHECK_NOTICE_DELAY_MS = 500;

/**
 * Refreshes the toolchain status, naming the work only once it has taken long enough to be
 * noticed. The check spawns `probe-rs`, which is slow enough on some machines to look like a
 * stall — but a toast that blinks in and out on a fast one is worse than a brief pause, so a
 * quick check stays silent.
 */
async function refreshWithNotice(
    state: RustyState,
    delayMs = PROBE_CHECK_NOTICE_DELAY_MS,
): Promise<ToolchainStatus> {
    const work = state.refresh();
    const slow = new Promise<'slow'>((resolve) => {
        setTimeout(() => resolve('slow'), delayMs);
    });

    if ((await Promise.race([work.then(() => 'done' as const), slow])) === 'done') {
        return work;
    }
    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Rusty Platform: looking for a debug probe…',
        },
        () => work,
    );
}

/** Build / Flash / Monitor / Clean, wired to the integrated terminal. */
export function registerProjectCommands(
    state: RustyState,
    output: vscode.OutputChannel,
): vscode.Disposable[] {
    const withProject = async (run: (project: ActiveProject) => void | Promise<void>): Promise<void> => {
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

        await run(project);
    };

    /**
     * The gate before a probe-less flash — the same rule as the probe firmware flow:
     * `INFO_UF2.TXT` names a board *type* and carries no serial number, so a person has to
     * confirm which board is about to be written.
     */
    async function confirmUsbFlash(
        request: UsbFlashConfirmation,
        reason?: string,
    ): Promise<boolean> {
        const lines: string[] = [];
        if (reason) {
            lines.push(`${reason} Flashing over USB — hold BOOTSEL while plugging the board in.`, '');
        }
        lines.push(
            `About to flash ${path.basename(request.uf2Path)} (${request.bytes} bytes) onto:`,
            request.info ? describeUf2Info(request.info) : `  ${request.volume}`,
        );
        if (request.warning) {
            lines.push('', `⚠ ${request.warning}`);
        }
        lines.push('', 'The board restarts as soon as the file lands.');
        const answer = await vscode.window.showWarningMessage(
            lines.join('\n'),
            { modal: true },
            'Flash it',
        );
        return answer === 'Flash it';
    }

    /** Build, convert and wait for BOOTSEL — shared by the fallback and the explicit command. */
    async function flashOverUsb(project: ActiveProject, reason?: string): Promise<void> {
        const familyId = uf2FamilyForProject(project.board, project.chip);
        if (familyId === undefined) {
            void vscode.window.showErrorMessage(
                'Cannot tell which chip this project targets, so the UF2 family is unknown. ' +
                'Make sure .cargo/config.toml has `runner = "probe-rs run --chip <CHIP>"`.',
            );
            return;
        }

        try {
            const result = await flashProjectOverUsb(
                { folder: project.folder, familyId },
                { output, confirmWrite: (request) => confirmUsbFlash(request, reason) },
            );
            if (!result.written) {
                output.appendLine(`Nothing was written to ${result.volume}.`);
                return;
            }
            const choice = await vscode.window.showInformationMessage(
                'Flashed over USB. Without a probe there is no RTT, so defmt output is not available.',
                'Show File',
            );
            if (choice === 'Show File') {
                await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(result.uf2));
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            output.appendLine(`USB flash failed: ${message}`);
            output.show(true);
            void vscode.window.showErrorMessage(`USB flash did not finish: ${message.split('\n')[0]}`, 'Show Log');
        }
    }

    return [
        vscode.commands.registerCommand('rustyPlatform.build', () =>
            withProject(({ folder }) => {
                runInTerminal('Rusty: build', `${defmtPrefix()}cargo build`, folder);
            }),
        ),

        vscode.commands.registerCommand('rustyPlatform.flash', () =>
            withProject(async (project) => {
                // Always look again: the route depends on whether a probe is usable *now*, and the
                // cached status may predate plugging the board in.
                const status = await refreshWithNotice(state);
                const kind = status.probeDiagnosis.kind;

                if (flashRouteFor(kind) === 'probe') {
                    // `cargo run` uses the runner from .cargo/config.toml
                    // (probe-rs run --chip ...), which flashes, resets and streams defmt over RTT.
                    runInTerminal('Rusty: flash', `${defmtPrefix()}cargo run --release`, project.folder);
                    return;
                }

                await flashOverUsb(project, routeReason(kind));
            }),
        ),

        // Available even when a probe is attached: the USB route is also the recovery path
        // for a probe that is present but unusable.
        vscode.commands.registerCommand('rustyPlatform.flashUsb', () =>
            withProject((project) => flashOverUsb(project)),
        ),

        vscode.commands.registerCommand('rustyPlatform.monitor', () =>
            withProject(({ folder, chip }) => {
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
            withProject(({ folder }) => {
                runInTerminal('Rusty: build', 'cargo clean', folder);
            }),
        ),
    ];
}
