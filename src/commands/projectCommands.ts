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
    clockHandoverLine,
    espFlashAndMonitorCommand,
    espFlashCommand,
    espMonitorCommand,
    pickSerialPort,
    serialPortCandidates,
    serialPortEntriesForPlatform,
} from '../flash/espFlash';
import {
    FlashProfileChoice,
    flashProfileFor,
    parseFlashProfileChoice,
    profileWarnings,
} from '../flash/profile';
import { UsbFlashConfirmation, buildElf, flashProjectOverUsb } from '../flash/usbFlashRunner';
import { BuildProfile, LAST_FLASHED_KEY } from '../project/launchConfig';
import { activeWifiEnv } from '../wifi/credentials';
import { ensureWifiEnv } from '../wifi/wifiPrompt';
import { ensureSmtpEnv } from '../smtp/wizard';
import { activeSmtpEnv } from '../smtp/credentials';
import { closeTerminal, defmtEnv, defmtPrefix, espEnv, openTerminalNames, runInTerminal } from './terminal';
import { ensureEspToolchain } from './espToolchainCommands';
import { rearmClockListener } from '../designer/editor';

const PROBE_CHECK_NOTICE_DELAY_MS = 500;

/**
 * Runs `after` once the flash command in its terminal has ended.
 *
 * The clock listener is closed before a flash so `espflash` can own the serial port, and it has to
 * come back afterwards -- a board that is powered off later asks for the time, and nobody would be
 * listening. Shell integration is what says the command ended; where it is unavailable nothing
 * happens, which is safe: the flash's own TIME line has already set the RTC, so only a later cold
 * boot would go without a listener.
 */
function whenFlashCommandEnds(after: () => void): void {
    const events = vscode.window as unknown as {
        onDidEndTerminalShellExecution?: (
            listener: (event: { execution?: { commandLine?: { value?: string } } }) => void,
        ) => vscode.Disposable;
    };
    if (events.onDidEndTerminalShellExecution === undefined) {
        return;
    }
    const disposable = events.onDidEndTerminalShellExecution((event) => {
        const line = event.execution?.commandLine?.value ?? '';
        if (line.includes('espflash')) {
            disposable.dispose();
            after();
        }
    });
}

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
    async function flashOverUsb(project: ActiveProject, profile: BuildProfile, reason?: string): Promise<void> {
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
                { folder: project.folder, familyId, profile, env: buildEnv() },
                { output, confirmWrite: (request) => confirmUsbFlash(request, reason) },
            );
            if (!result.written) {
                output.appendLine(`Nothing was written to ${result.volume}.`);
                return;
            }
            // Record what was written, not what was intended: the no-flash entries are only safe
            // against a match.
            await context.workspaceState.update(LAST_FLASHED_KEY, profile);
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
        // Linux reads `/dev/serial/by-id`, Windows asks PowerShell for the COM ports; both come
        // back with the vendor inside the entry's name, so the Pico exclusion applies either way.
        return pickSerialPort(serialPortCandidates(serialPortEntriesForPlatform()), configured);
    }

    /** What a build has to see beyond the plain environment: credentials, and an optional log level. */
    function buildEnv(): NodeJS.ProcessEnv {
        // espEnv() is empty unless espup has run: for an ESP project it is what puts the Xtensa
        // linker on PATH, for an RP project it changes nothing.
        return augmentedEnv({ ...activeWifiEnv(), ...activeSmtpEnv(), ...defmtEnv(), ...espEnv() });
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
    async function flashOverProbe(project: ActiveProject, chip: string, profile: BuildProfile): Promise<void> {
        try {
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
    async function flashOverSerial(
        project: ActiveProject,
        profile: BuildProfile,
        monitorAfter: boolean,
    ): Promise<void> {
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

        // A monitor terminal holds the port; flashing beside it would fail to open the device. The
        // clock listener holds it too, for as long as it is waiting for the board to ask -- a flash
        // is a reason not to wait any longer, and closing it releases the handle.
        if (closeTerminal('Rusty: clock')) {
            output.appendLine('clock: closed the time listener so the flash can have the serial port.');
        }
        if (!(await releaseMonitorHoldingPort())) {
            return;
        }

        const chip = project.chip ?? board.espChip;
        const port = espPort();
        try {
            const elf = await buildElf(project.folder, output, profile, buildEnv());
            output.appendLine(
                `Writing ${path.basename(elf)} over USB serial (chip ${chip}${port === undefined ? '' : `, port ${port}`})`,
            );
            // An ESP32's internal RTC has no battery, so the board is told the PC's local time
            // over the console once it is running: that is what a design's clock follows. Without a
            // port of our own there is nothing to write to -- espflash is left to pick one, and the
            // design starts from its own time instead.
            const handover = port === undefined ? undefined : { port, line: clockHandoverLine() };
            if (handover !== undefined) {
                output.appendLine(
                    `clock: handing the board ${handover.line} on ${handover.port} when the write finishes`,
                );
            }
            const command = monitorAfter
                ? espFlashAndMonitorCommand(espflashCommand(), chip, elf, port, process.platform, handover)
                : espFlashCommand(espflashCommand(), chip, elf, port, handover);
            runInTerminal('Rusty: flash', command, project.folder);
            // The flash borrowed the port from the clock listener; the listener comes back when the
            // command ends, so a board powered off later still finds a host that can answer it.
            whenFlashCommandEnds(() => rearmClockListener());
            // Remember what the chip now holds, the same way the RP routes do.
            await context.workspaceState.update(LAST_FLASHED_KEY, profile);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            output.appendLine(`flash failed: ${message}`);
            output.show(true);
            void vscode.window.showErrorMessage(`Flash did not finish: ${message.split('\n')[0]}`, 'Show Log');
        }
    }

    /** The standing answer from `rustyPlatform.flashProfile`. */
    function configuredProfileChoice(): FlashProfileChoice {
        const configured = vscode.workspace.getConfiguration('rustyPlatform').get<string>('flashProfile');
        return parseFlashProfileChoice(configured);
    }

    /**
     * One flash, however the route turns out.
     *
     * Extracted so the profile controls are exactly the Flash button with one argument changed: three
     * entry points that each re-implemented the routing would be three places to forget a fix.
     */
    async function flashProject(
        project: ActiveProject,
        options: { choice: FlashProfileChoice; monitor?: boolean },
    ): Promise<void> {
        const profile = flashProfileFor(project.board, options.choice);
        // Ask for the network before anything is compiled: the wireless templates bake the credentials
        // in at compile time, so a prompt after the build would arrive too late.
        await ensureWifiEnv(context, project.folder, output);
        // The SMTP connection info is baked in the same way, and lives in the keyring only -- without
        // this a reload would silently build the placeholder (an empty relay).
        await ensureSmtpEnv(context, project.folder, output);
        output.appendLine(
            `flash: profile ${profile}` +
            `${options.choice === 'auto' ? ' (auto, from the board)' : ' (chosen)'}` +
            `${project.board === undefined ? '' : ` for ${project.board.id}`}`,
        );
        for (const warning of profileWarnings(project.board, profile, options.choice)) {
            output.appendLine(`flash: ${warning}`);
        }

        // The board decides first, and for an ESP that answer depends on no probe at all — so the
        // (slow) probe diagnosis only runs when it can change the outcome.
        if (usesSerialFlash(project.board)) {
            await flashOverSerial(project, profile, options.monitor === true);
            return;
        }

        // Always look again: the route depends on whether a probe is usable *now*, and the cached
        // status may predate plugging the board in.
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
            await flashOverProbe(project, chip, profile);
            return;
        }

        await flashOverUsb(project, profile, routeReason(kind));
    }

    return [
        // The two build controls. `rustyPlatform.build` stays registered for the palette and for anyone
        // with it in a keybinding; the controls run these two.
        vscode.commands.registerCommand('rustyPlatform.build', () =>
            withProject(async (project) => {
                await ensureSmtpEnv(context, project.folder, output);
                runInTerminal('Rusty: build', `${defmtPrefix()}cargo build`, project.folder);
            }),
        ),
        vscode.commands.registerCommand('rustyPlatform.buildDebug', () =>
            withProject(async (project) => {
                await ensureSmtpEnv(context, project.folder, output);
                runInTerminal('Rusty: build', `${defmtPrefix()}cargo build`, project.folder);
            }),
        ),
        vscode.commands.registerCommand('rustyPlatform.buildRelease', () =>
            withProject(async (project) => {
                await ensureSmtpEnv(context, project.folder, output);
                runInTerminal('Rusty: build', `${defmtPrefix()}cargo build --release`, project.folder);
            }),
        ),

        vscode.commands.registerCommand('rustyPlatform.flash', (options?: { monitor?: boolean }) =>
            withProject(async (project) => {
                await flashProject(project, { choice: configuredProfileChoice(), monitor: options?.monitor === true });
            }),
        ),

        // The two explicit build choices, from the Controls section (2026-10-05). They override the
        // setting for this flash only, and do not change it: a control that quietly rewrites a setting
        // is a worse control than one that does exactly what it says.
        vscode.commands.registerCommand('rustyPlatform.flashDebug', () =>
            withProject(async (project) => {
                await flashProject(project, { choice: 'debug' });
            }),
        ),
        vscode.commands.registerCommand('rustyPlatform.flashRelease', () =>
            withProject(async (project) => {
                await flashProject(project, { choice: 'release' });
            }),
        ),

        // Available even when a probe is attached: the USB route is also the recovery path
        // for a probe that is present but unusable.
        vscode.commands.registerCommand('rustyPlatform.flashUsb', () =>
            withProject(async (project) => {
                // On this route "USB" is not a choice to make on an ESP32: its upload *is* USB serial, and
                // the board profile says which route this board takes, so Upload is the answer either way.
                await ensureWifiEnv(context, project.folder, output);
                await ensureSmtpEnv(context, project.folder, output);
                const profile = flashProfileFor(project.board, configuredProfileChoice());
                if (usesSerialFlash(project.board)) {
                    // The explicit "USB" route: for an ESP that is espflash over serial, not a UF2 copy.
                    await flashOverSerial(project, profile, false);
                    return;
                }
                await flashOverUsb(project, profile);
            }),
        ),

        vscode.commands.registerCommand('rustyPlatform.monitor', () =>
            withProject(async (project) => {
                const board = project.board;
                if (board?.kind === 'esp') {
                    // `espflash monitor` holds the serial port until this terminal is closed, which is
                    // the whole point of a monitor - and why no flash can run beside it. The clock
                    // listener is the other holder, so it is closed rather than left to time out.
                    if (closeTerminal('Rusty: clock')) {
                        output.appendLine('clock: closed the time listener so Monitor can have the serial port.');
                    }
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
            withProject(async (project) => {
                runInTerminal('Rusty: build', 'cargo clean', project.folder);
            }),
        ),
    ];
}
