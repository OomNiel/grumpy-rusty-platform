import * as vscode from 'vscode';
import * as path from 'path';
import { RustyState } from '../state';
import { ActiveProject } from '../project/activeProject';
import { activeProbeRsSession } from '../project/debugSessions';
import { makeWithProject } from './withProject';
import { ToolchainStatus } from '../toolchain/detect';
import { augmentedEnv } from '../util/exec';
import { describeUf2Info } from '../flash/bootsel';
import { flashRouteForProject, routeReason, uf2FamilyForProject, usesSerialFlash } from '../flash/route';
import { probeFlashCommand } from '../flash/probeFlash';
import {
    espFlashAndMonitorCommand,
    espFlashCommand,
    espMonitorCommand,
    pickSerialPort,
    readSerialPortEntries,
    serialPortCandidates,
} from '../flash/espFlash';
import { FLASH_PROFILE, flashProfileFor } from '../flash/profile';
import { UsbFlashConfirmation, buildElf, flashProjectOverUsb } from '../flash/usbFlashRunner';
import { LAST_FLASHED_KEY } from '../project/launchConfig';
import { activeWifiEnv } from '../wifi/credentials';
import { ensureWifiEnv } from '../wifi/wifiPrompt';
import { closeTerminal, defmtEnv, defmtPrefix, espEnv, openTerminalNames, runInTerminal } from './terminal';
import { ensureEspToolchain } from './espToolchainCommands';

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
    context: vscode.ExtensionContext,
): vscode.Disposable[] {
    const withProject = makeWithProject(state, output);

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
            // A UF2 copy only ever serves the Raspberry Pi boards, and the image it writes exists to
            // be debugged, so this route stays on the debug build.
            const result = await flashProjectOverUsb(
                { folder: project.folder, familyId, profile: flashProfileFor(project.board), env: buildEnv() },
                { output, confirmWrite: (request) => confirmUsbFlash(request, reason) },
            );
            if (!result.written) {
                output.appendLine(`Nothing was written to ${result.volume}.`);
                return;
            }
            // The UF2 write is the same build as the probe route, so the debug configurations that
            // load it stay valid.
            await context.workspaceState.update(LAST_FLASHED_KEY, FLASH_PROFILE);
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

    /** `probe-rs` as configured, or the one on PATH. */
    function probeRsCommand(): string {
        const configured = vscode.workspace.getConfiguration('rustyPlatform').get<string>('probeRsPath');
        return configured && configured.trim() !== '' ? configured.trim() : 'probe-rs';
    }

    /** `espflash` as configured, or the one on PATH (it is a cargo-installed tool). */
    function espflashCommand(): string {
        const configured = vscode.workspace.getConfiguration('rustyPlatform').get<string>('espflashPath');
        return configured && configured.trim() !== '' ? configured.trim() : 'espflash';
    }

    /**
     * The serial port to hand to espflash, when we can tell which one it is.
     *
     * A configured port wins; otherwise only an unambiguous candidate is used, so espflash is not
     * choosing between two boards on its own. `isEspProgrammerName` refuses the Raspberry Pi
     * boards that also publish a name here — one of them must never be written to by accident.
     */
    function espPort(): string | undefined {
        const configured = vscode.workspace.getConfiguration('rustyPlatform').get<string>('serialPort');
        return pickSerialPort(serialPortCandidates(readSerialPortEntries()), configured);
    }

    /** What a build has to see beyond the plain environment: credentials, and an optional log level. */
    function buildEnv(): NodeJS.ProcessEnv {
        // espEnv() is empty unless espup has run: for an ESP project it is what puts the Xtensa
        // linker on PATH, for an RP project it changes nothing.
        return augmentedEnv({ ...activeWifiEnv(), ...defmtEnv(), ...espEnv() });
    }

    /**
     * A probe-rs debug session holds the probe for as long as it runs, so a flash started during one
     * fails with "the selected USB device could not be opened". Offer to stop it rather than let the
     * user meet that message and read it as a hardware fault.
     */
    async function releaseSessionHoldingProbe(): Promise<boolean> {
        const session = activeProbeRsSession();
        if (session === undefined) {
            return true;
        }
        const answer = await vscode.window.showWarningMessage(
            `"${session.name}" is debugging through the probe, and only one program can use it at a
            time. Stop it and flash?`,
            { modal: true },
            'Stop it and flash',
        );
        if (answer !== 'Stop it and flash') {
            output.appendLine('flash: cancelled - the debug session still holds the probe.');
            return false;
        }
        await vscode.debug.stopDebugging(session);
        // The adapter releases the USB device as it exits; give it a moment before probe-rs opens it.
        await new Promise((resolve) => setTimeout(resolve, 500));
        return true;
    }

    /**
     * Flashing through the probe: build the release image, write it, reset, and let the probe go.
     *
     * Flash used to be `cargo run`, whose runner is `probe-rs run`. That flashes and then *stays
     * attached* to stream defmt over RTT, so the probe stayed claimed until the terminal was closed
     * and the next debug session could not open it. A flash is a one-shot write; streaming is
     * Monitor's job.
     */
    async function flashOverProbe(project: ActiveProject, chip: string): Promise<void> {
        try {
            // On this route the profile is the one the debug configurations load, never a different
            // one: a flash whose build differs from what Debug expects leaves the next session unable
            // to bind a single breakpoint. `flashProfileFor` is what decides it per board — always
            // `debug` for a probe route, `release` where no session exists at all.
            const profile = flashProfileFor(project.board);
            const elf = await buildElf(project.folder, output, profile, buildEnv());
            output.appendLine(`Writing ${path.basename(elf)} through the probe (chip ${chip})`);
            runInTerminal('Rusty: flash', probeFlashCommand(probeRsCommand(), chip, elf), project.folder);
            // Remember what the chip now holds: the no-flash entries are only safe against a match.
            await context.workspaceState.update(LAST_FLASHED_KEY, profile);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            output.appendLine(`flash failed: ${message}`);
            output.show(true);
            void vscode.window.showErrorMessage(`Flash did not finish: ${message.split('\n')[0]}`, 'Show Log');
        }
    }

    /**
     * A Monitor terminal holds the serial port while it runs, and a flash cannot share it.
     *
     * The same trap as a debug session holding the probe, and it reads just like a hardware fault:
     * the useful move is to offer to close the terminal that is in the way.
     */
    async function releaseMonitorHoldingPort(): Promise<boolean> {
        if (!openTerminalNames().includes('Rusty: monitor')) {
            return true;
        }
        const answer = await vscode.window.showWarningMessage(
            'The Monitor terminal is using the serial port, and only one program can have it open. ' +
            'Close it and flash?',
            { modal: true },
            'Close it and flash',
        );
        if (answer !== 'Close it and flash') {
            output.appendLine('flash: cancelled - the monitor terminal still holds the serial port.');
            return false;
        }
        closeTerminal('Rusty: monitor');
        // Give the port a moment to come back before espflash opens it.
        await new Promise((resolve) => setTimeout(resolve, 300));
        return true;
    }

    /**
     * Flashing an ESP over USB serial.
     *
     * `espflash flash` is a one-shot write, exactly like the probe route: it exits when the image is
     * on the chip, so the port is free again afterwards. Following the log stays Monitor's job — or,
     * when the Debug button asked for it, the chained `&&` in the same terminal.
     */
    async function flashOverSerial(project: ActiveProject, monitorAfter: boolean): Promise<void> {
        const board = project.board;
        if (board === undefined || board.kind !== 'esp') {
            void vscode.window.showErrorMessage(
                'This project is not an ESP board, so there is nothing to flash over USB serial.',
            );
            return;
        }

        // Without the toolchain the build stops at a linker error that says nothing about espup, so
        // the offer to install it comes first.
        if (!(await ensureEspToolchain(output))) {
            output.appendLine('flash: the ESP toolchain is not ready, so the build was not started.');
            return;
        }

        // A monitor terminal holds the port; flashing beside it would fail to open the device.
        if (!(await releaseMonitorHoldingPort())) {
            return;
        }

        const chip = project.chip ?? board.espChip;
        const port = espPort();
        try {
            // An ESP board flashes `release`: there is no probe-rs session on that route to bind a
            // breakpoint in a debug build, and the debug build's drawing is measured in tens of
            // seconds where the release build's is a fifth of one (see `flash/profile.ts`).
            const profile = flashProfileFor(project.board);
            const elf = await buildElf(project.folder, output, profile, buildEnv());
            output.appendLine(
                `Writing ${path.basename(elf)} over USB serial (chip ${chip}${port === undefined ? '' : `, port ${port}`})`,
            );
            const command = monitorAfter
                ? espFlashAndMonitorCommand(espflashCommand(), chip, elf, port)
                : espFlashCommand(espflashCommand(), chip, elf, port);
            runInTerminal('Rusty: flash', command, project.folder);
            // Remember what the chip now holds, the same way the RP routes do.
            await context.workspaceState.update(LAST_FLASHED_KEY, profile);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            output.appendLine(`flash failed: ${message}`);
            output.show(true);
            void vscode.window.showErrorMessage(`Flash did not finish: ${message.split('\n')[0]}`, 'Show Log');
        }
    }

    return [
        vscode.commands.registerCommand('rustyPlatform.build', () =>
            withProject(({ folder }) => {
                runInTerminal('Rusty: build', `${defmtPrefix()}cargo build`, folder);
            }),
        ),

        vscode.commands.registerCommand('rustyPlatform.flash', (options?: { monitor?: boolean }) =>
            withProject(async (project) => {
                // Ask for the network before anything is compiled: the wireless templates bake the
                // credentials in at compile time, so a prompt after the build would arrive too late.
                await ensureWifiEnv(context, project.folder, output);

                // The board decides first, and for an ESP that answer depends on no probe at all — so
                // the (slow) probe diagnosis only runs when it can change the outcome.
                if (usesSerialFlash(project.board)) {
                    await flashOverSerial(project, options?.monitor === true);
                    return;
                }

                // Always look again: the route depends on whether a probe is usable *now*, and the
                // cached status may predate plugging the board in.
                const status = await refreshWithNotice(state);
                const kind = status.probeDiagnosis.kind;

                if (flashRouteForProject(project.board, kind) === 'probe') {
                    if (!(await releaseSessionHoldingProbe())) {
                        return;
                    }
                    const projectBoard = project.board;
                    const chip =
                        project.chip ??
                        (projectBoard === undefined
                            ? undefined
                            : projectBoard.kind === 'rp'
                                ? projectBoard.probeChip
                                : projectBoard.espChip);
                    if (chip === undefined) {
                        void vscode.window.showErrorMessage(
                            'Cannot tell which chip this project targets. Add `runner = "probe-rs run --chip <CHIP>"` to .cargo/config.toml.',
                        );
                        return;
                    }
                    await flashOverProbe(project, chip);
                    return;
                }

                await flashOverUsb(project, routeReason(kind));
            }),
        ),

        // Available even when a probe is attached: the USB route is also the recovery path
        // for a probe that is present but unusable.
        vscode.commands.registerCommand('rustyPlatform.flashUsb', () =>
            withProject(async (project) => {
                await ensureWifiEnv(context, project.folder, output);
                if (usesSerialFlash(project.board)) {
                    // The explicit "USB" route: for an ESP that is espflash over serial, not a UF2 copy.
                    await flashOverSerial(project, false);
                    return;
                }
                await flashOverUsb(project);
            }),
        ),

        vscode.commands.registerCommand('rustyPlatform.monitor', () =>
            withProject((project) => {
                const board = project.board;
                if (board?.kind === 'esp') {
                    // `espflash monitor` holds the serial port until this terminal is closed, which is
                    // the whole point of a monitor - and why no flash can run beside it.
                    runInTerminal(
                        'Rusty: monitor',
                        espMonitorCommand(espflashCommand(), project.chip ?? board.espChip, espPort()),
                        project.folder,
                    );
                    return;
                }

                const { folder, chip } = project;
                if (!chip) {
                    void vscode.window.showWarningMessage(
                        'Cannot determine the chip id for this project. Add `runner = "probe-rs run --chip <CHIP>"` to .cargo/config.toml.',
                    );
                    return;
                }
                // `probe-rs attach` holds the probe until this terminal is closed, which is the whole
                // point of a monitor - and why no flash or debug session can run beside it.
                runInTerminal('Rusty: monitor', `${probeRsCommand()} attach --chip ${chip}`, folder);
            }, 'monitor'),
        ),

        vscode.commands.registerCommand('rustyPlatform.clean', () =>
            withProject(({ folder }) => {
                runInTerminal('Rusty: build', 'cargo clean', folder);
            }),
        ),
    ];
}
