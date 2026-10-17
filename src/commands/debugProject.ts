import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { RustyState } from '../state';
import { ActiveProject } from '../project/activeProject';
import { augmentedEnv, execFileFn, findExecutable } from '../util/exec';
import {
    BuildProfile,
    DebugChoice,
    LAST_FLASHED_KEY,
    PROBE_RS_DEBUGGER_EXTENSION,
    configurationNames,
    debugConfigurationChoices,
    debugPickerItems,
    debuggerSchemaOf,
    launchConfigProblems,
    onlyGeneratedConfigurations,
    probeRsConfigurationCount,
    profileMismatch,
} from '../project/launchConfig';
import { launchJson } from '../generate/files';
import {
    ChipCheckResult,
    DEBUG_ANYWAY,
    FLASH_THEN_DEBUG,
    classifyVerifyOutput,
    flashingChoice,
    mismatchMessage,
    needsChipCheck,
    verifyArgs,
} from '../project/chipCheck';
import { activeProbeRsSession } from '../project/debugSessions';
import { activeWifiEnv } from '../wifi/credentials';
import { ensureWifiEnv } from '../wifi/wifiPrompt';
import { defmtEnv, espEnv } from './terminal';
import { makeWithProject } from './withProject';

/**
 * Debug: build the project, then start the probe-rs debug session the wizard generated.
 *
 * Two things make this more than `vscode.debug.startDebugging()`:
 *
 *  - the generated `launch.json` points at the **debug** profile binary, so a fresh build has
 *    to happen first. It runs as a real task, which means the user sees the compiler output,
 *    can stop it, and we can await its exit code rather than guessing;
 *  - `probe-rs-debug` needs the probe-rs debugger extension, which is not installed by
 *    default. Without it VS Code fails the session with a confusing message, so it is worth
 *    offering the install up front.
 */

const TASK_SOURCE = "Grumpy's Rusty Platform";

/** `ShellExecution` will not accept `string | undefined` values, so drop those. */
function stringEnv(source: NodeJS.ProcessEnv): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(source)) {
        if (typeof value === 'string') {
            env[key] = value;
        }
    }
    return env;
}

async function readLaunchJson(project: ActiveProject): Promise<string | undefined> {
    try {
        const bytes = await vscode.workspace.fs.readFile(
            vscode.Uri.joinPath(project.folder, '.vscode', 'launch.json'),
        );
        return Buffer.from(bytes).toString('utf8');
    } catch {
        return undefined;
    }
}

/**
 * Picks the configuration to start.
 *
 * One configuration is used silently. Several become a QuickPick with the flashing one first, so
 * pressing Enter keeps the one-click behaviour while "no flashing" is a keystroke away.
 */
async function chooseConfiguration(
    launchJson: string,
    lastFlashed: BuildProfile | undefined,
    output: vscode.OutputChannel,
): Promise<{ name: string; choice: DebugChoice } | undefined> {
    const items = debugPickerItems(launchJson, lastFlashed);
    const [first] = items;
    if (first === undefined) {
        void vscode.window.showErrorMessage(
            'No probe-rs launch configuration found in .vscode/launch.json. ' +
            'Expected a configuration with `"type": "probe-rs-debug"`.',
        );
        return undefined;
    }
    if (items.length === 1) {
        return { name: first.choice.name, choice: first.choice };
    }

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Which debug configuration?',
        matchOnDetail: true,
    });
    if (picked === undefined) {
        output.appendLine('debug: cancelled while choosing a configuration.');
        return undefined;
    }
    output.appendLine(`debug: ${picked.label} - ${picked.detail}`);
    return { name: picked.choice.name, choice: picked.choice };
}

/** `cargo build` (debug profile) as a visible task, awaited. True when it exited 0. */
async function buildDebugProfile(
    project: ActiveProject,
    scope: vscode.WorkspaceFolder | vscode.TaskScope,
    output: vscode.OutputChannel,
): Promise<boolean> {
    const task = new vscode.Task(
        { type: 'rusty-platform-build' },
        scope,
        'Rusty: build (debug)',
        TASK_SOURCE,
        new vscode.ShellExecution('cargo build', {
            cwd: project.folder.fsPath,
            // The same environment a flash builds with, so the two produce the same bytes and the
            // chip check cannot report a mismatch over a `DEFMT_LOG` difference.
            env: stringEnv(augmentedEnv({ ...activeWifiEnv(), ...defmtEnv(), ...espEnv() })),
        }),
        ['$rustc'],
    );
    task.presentationOptions = {
        reveal: vscode.TaskRevealKind.Always,
        panel: vscode.TaskPanelKind.Shared,
        clear: false,
    };

    const finished = new Promise<number | undefined>((resolve) => {
        const subscription = vscode.tasks.onDidEndTaskProcess((event) => {
            if (event.execution.task.name === task.name && event.execution.task.source === TASK_SOURCE) {
                subscription.dispose();
                resolve(event.exitCode);
            }
        });
    });

    output.appendLine('debug: cargo build (debug profile)');
    await vscode.tasks.executeTask(task);
    const exitCode = await finished;
    output.appendLine(`debug: cargo build exited with ${exitCode ?? 'unknown'}`);
    return exitCode === 0;
}

/** Offers the marketplace install when the debugger extension is missing. */
async function ensureDebuggerExtension(): Promise<boolean> {
    if (vscode.extensions.getExtension(PROBE_RS_DEBUGGER_EXTENSION) !== undefined) {
        return true;
    }

    const choice = await vscode.window.showWarningMessage(
        `Debugging an embedded target needs the probe-rs debugger extension (${PROBE_RS_DEBUGGER_EXTENSION}).\n\n` +
        'Install it now?',
        { modal: true },
        'Install',
        'Open in Marketplace',
    );
    if (choice === 'Install') {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', PROBE_RS_DEBUGGER_EXTENSION);
        void vscode.window.showInformationMessage(
            'probe-rs debugger installed. Press Debug again — the extension needs a moment to activate.',
        );
        return false;
    }
    if (choice === 'Open in Marketplace') {
        await vscode.env.openExternal(
            vscode.Uri.parse(`https://marketplace.visualstudio.com/items?itemName=${PROBE_RS_DEBUGGER_EXTENSION}`),
        );
    }
    return false;
}

/**
 * Asks the chip what it holds, with `probe-rs verify` against the binary the session will use.
 *
 * A check that cannot run is deliberately not fatal: the probe may be busy, probe-rs may not be on
 * PATH, or the build may not have produced the file launch.json names. None of those is evidence
 * that the chip is wrong, so they come back as `unknown` and are reported rather than guessed at.
 */
async function checkChipHoldsBuild(
    project: ActiveProject,
    choice: DebugChoice,
    output: vscode.OutputChannel,
): Promise<ChipCheckResult> {
    const cannotCheck = (reason: string): ChipCheckResult => {
        output.appendLine(`debug: could not check the chip's build - ${reason}`);
        return { verdict: 'unknown', reason };
    };

    if (choice.binary === undefined) {
        return cannotCheck('launch.json does not say which binary this session uses');
    }
    const binaryPath = path.resolve(project.folder.fsPath, choice.binary);
    if (!fs.existsSync(binaryPath)) {
        return cannotCheck(`${choice.binary} is not on disk - the build did not produce it`);
    }
    const probeRs = findExecutable(
        'probe-rs',
        vscode.workspace.getConfiguration('rustyPlatform').get<string>('probeRsPath'),
    );
    if (probeRs === undefined) {
        return cannotCheck('probe-rs was not found');
    }

    output.appendLine(`debug: probe-rs verify ${choice.binary} (against the build just made)`);
    const started = Date.now();
    const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Rusty: checking the chip holds this build' },
        () =>
            execFileFn(probeRs, verifyArgs(project.chip, binaryPath), {
                cwd: project.folder.fsPath,
                timeoutMs: 120_000,
            }),
    );
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    if (result.notFound) {
        return cannotCheck('probe-rs could not be started');
    }
    const verdict = classifyVerifyOutput(result.stdout, result.stderr);
    output.appendLine(`debug: chip check ${verdict.verdict} in ${elapsed}s - ${verdict.reason}`);
    return verdict;
}

/**
 * What the launch-configuration check found.
 *
 * `replacement` is set only when rewriting the file would lose nothing -- see
 * `onlyGeneratedConfigurations`. Its presence is what turns "this is wrong" into "here is the fix".
 */
interface LaunchConfigReport {
    problems: string[];
    /** Why nothing could be checked, when nothing was. */
    unchecked?: string;
    /** A freshly generated file, when the existing one holds only our own configurations. */
    replacement?: string;
    /** The relative path the old file is kept at, when there is a replacement to write. */
    backupPath: string;
}

/** The crate name a generated project's `Cargo.toml` carries, for the binary path in launch.json. */
function crateNameOf(cargoToml: string): string | undefined {
    // `[package] name = "..."` comes first in a generated file; `[[bin]]`/`[lib]` sections, if a
    // user adds them, come after it.
    const match = /^\s*name\s*=\s*"([^"]+)"/m.exec(cargoToml);
    return match?.[1];
}

/**
 * Does this project's `.vscode/launch.json` still match the debugger that is installed?
 *
 * The configurations are generated, so the interesting failure is not "the user typed something
 * wrong" but "the debugger's schema moved and the file did not". Checked against the installed
 * extension's own `package.json`, so there is no version table here to go stale.
 */
async function inspectLaunchConfigurations(project: ActiveProject): Promise<LaunchConfigReport> {
    const backupPath = '.vscode/launch.json.old';
    const text = await readLaunchJson(project);
    if (text === undefined) {
        return { problems: [], unchecked: 'this project has no .vscode/launch.json', backupPath };
    }

    const extension = vscode.extensions.getExtension(PROBE_RS_DEBUGGER_EXTENSION);
    if (extension === undefined) {
        return {
            problems: [],
            unchecked: `the probe-rs debugger (${PROBE_RS_DEBUGGER_EXTENSION}) is not installed, so there is no schema to check against`,
            backupPath,
        };
    }
    const schema = debuggerSchemaOf(extension.packageJSON);
    if (schema === undefined) {
        return {
            problems: [],
            unchecked: 'the installed probe-rs debugger publishes no configuration schema',
            backupPath,
        };
    }
    if (probeRsConfigurationCount(text) === 0) {
        return { problems: [], unchecked: 'launch.json holds no probe-rs configuration', backupPath };
    }

    const problems = launchConfigProblems(text, schema);
    if (problems.length === 0) {
        return { problems, backupPath };
    }

    const board = project.board;
    const crateName = crateNameOf(project.cargoToml);
    if (board === undefined || !('probeChip' in board) || crateName === undefined) {
        // Not a generated RP project, so there is no template to restore from.
        return { problems, backupPath };
    }
    const fresh = launchJson(board, crateName);
    return {
        problems,
        backupPath,
        replacement: onlyGeneratedConfigurations(text, configurationNames(fresh)) ? fresh : undefined,
    };
}

/**
 * Reports a failed check, and repairs it when repairing is safe.
 *
 * Returns whether the file was rewritten. A file holding anything the user wrote is reported and
 * left alone: overwriting that is data loss, not a fix.
 */
async function reportLaunchConfigProblems(
    project: ActiveProject,
    report: LaunchConfigReport,
    output: vscode.OutputChannel,
): Promise<boolean> {
    for (const problem of report.problems) {
        output.appendLine(`launch.json: ${problem}`);
    }

    const body = report.problems.join('\n');
    if (report.replacement === undefined) {
        void vscode.window.showWarningMessage(
            `The debug configurations do not match the installed probe-rs debugger:\n\n${body}\n\n` +
                'They were left untouched because they may be yours. Compare them with a freshly ' +
                'generated project, or delete them and let the wizard write new ones.',
            { modal: true },
            'OK',
        );
        return false;
    }

    const choice = await vscode.window.showWarningMessage(
        `The debug configurations do not match the installed probe-rs debugger:\n\n${body}\n\n` +
            `Regenerating rewrites .vscode/launch.json from the wizard template and keeps the old ` +
            `file as ${report.backupPath}.`,
        { modal: true },
        'Regenerate',
    );
    if (choice !== 'Regenerate') {
        return false;
    }

    const folder = project.folder;
    const target = vscode.Uri.joinPath(folder, '.vscode', 'launch.json');
    const backup = vscode.Uri.joinPath(folder, '.vscode', 'launch.json.old');
    try {
        const existing = await vscode.workspace.fs.readFile(target);
        await vscode.workspace.fs.writeFile(backup, existing);
        await vscode.workspace.fs.writeFile(target, Buffer.from(report.replacement, 'utf8'));
    } catch (error) {
        output.appendLine(`launch.json: could not rewrite the file - ${String(error)}`);
        void vscode.window.showErrorMessage(`Could not rewrite .vscode/launch.json: ${String(error)}`);
        return false;
    }
    output.appendLine(`launch.json: regenerated (the old file is ${report.backupPath})`);
    void vscode.window.showInformationMessage(
        'Debug configurations regenerated. Press Debug again.',
    );
    return true;
}

export function registerDebugCommand(
    state: RustyState,
    output: vscode.OutputChannel,
    context: vscode.ExtensionContext,
): vscode.Disposable[] {
    const withProject = makeWithProject(state, output);

    return [
        vscode.commands.registerCommand('rustyPlatform.debug', () =>
            withProject(async (project) => {
                // An ESP32 has no SWD, so there is no session to start and no breakpoint to bind.
                // Rather than refusing, Debug does the useful thing for that chip: build, write the
                // image, and follow the log in one terminal.
                if (project.board?.kind === 'esp') {
                    void vscode.window.showInformationMessage(
                        'No breakpoints for an ESP32: Xtensa is debugged over JTAG, which needs separate ' +
                        'hardware. Flashing and monitoring instead.',
                    );
                    await vscode.commands.executeCommand('rustyPlatform.flash', { monitor: true });
                    return;
                }

                // VS Code only loads `.vscode/launch.json` for a folder it has opened, and the
                // Task/debug APIs need the WorkspaceFolder rather than a bare Uri.
                const folder = vscode.workspace.getWorkspaceFolder(project.folder);
                if (folder === undefined) {
                    void vscode.window.showErrorMessage(
                        'Open this project as a folder in VS Code, so its .vscode/launch.json is loaded.',
                    );
                    return;
                }

                const launchJson = await readLaunchJson(project);
                if (launchJson === undefined) {
                    void vscode.window.showErrorMessage(
                        'This project has no .vscode/launch.json, so there is nothing to debug. ' +
                        'Generate a project with the wizard to get one.',
                    );
                    return;
                }

                // The file is generated against a schema the debugger is free to change, and an
                // unknown key is not an error to VS Code: the session would start and quietly do
                // something other than what the file says. So check, and repair when that is safe,
                // before starting a session that would mislead.
                const launchReport = await inspectLaunchConfigurations(project);
                if (launchReport.problems.length > 0) {
                    output.appendLine('debug: the launch configuration does not match the installed debugger');
                    await reportLaunchConfigProblems(project, launchReport, output);
                    return;
                }

                const lastFlashed = context.workspaceState.get<BuildProfile>(LAST_FLASHED_KEY);
                let configuration = await chooseConfiguration(launchJson, lastFlashed, output);
                if (configuration === undefined) {
                    return;
                }

                // Our own record of the last flash is only a hint - a terminal `cargo run` writes the
                // chip too - so a disagreement is logged, not turned into a dialog. The chip itself
                // is asked below, and that answer is what the user is warned about.
                if (profileMismatch(configuration.choice, lastFlashed)) {
                    output.appendLine(
                        `debug: warning - "${configuration.name}" expects the ${configuration.choice.profile} build, ` +
                        `but the last flash from here wrote the ${lastFlashed} build. Checking the chip itself.`,
                    );
                }

                if (!(await ensureDebuggerExtension())) {
                    return;
                }

                // A wireless build without credentials produces a board that cannot join; ask here,
                // before the compiler runs, rather than after the flash.
                await ensureWifiEnv(context, project.folder, output);

                if (!(await buildDebugProfile(project, folder, output))) {
                    void vscode.window.showErrorMessage(
                        'The debug build failed, so the debug session was not started. See the terminal for the compiler output.',
                    );
                    return;
                }

                // The build on disk is current now. A no-flash session, however, debugs whatever is
                // in flash - which is only the same thing if nothing has written the chip since. So
                // ask the chip, and offer the one-click repair when the answer is no.
                if (needsChipCheck(configuration.choice)) {
                    const checked = await checkChipHoldsBuild(project, configuration.choice, output);
                    if (checked.verdict === 'mismatch') {
                        const flash = flashingChoice(debugConfigurationChoices(launchJson));
                        const answer = await vscode.window.showWarningMessage(
                            mismatchMessage(configuration.choice.binary, checked.reason, flash !== undefined),
                            { modal: true },
                            ...(flash === undefined ? [DEBUG_ANYWAY] : [FLASH_THEN_DEBUG, DEBUG_ANYWAY]),
                        );
                        if (answer === undefined) {
                            output.appendLine('debug: cancelled - the chip does not hold this build.');
                            return;
                        }
                        if (answer === FLASH_THEN_DEBUG && flash !== undefined) {
                            output.appendLine(`debug: flashing first, with "${flash.name}".`);
                            configuration = { name: flash.name, choice: flash };
                        }
                    } else if (checked.verdict === 'unknown') {
                        // Not a verdict: the session may well be fine, so it goes ahead - but the
                        // user is told the check did not happen instead of being reassured falsely.
                        void vscode.window.showWarningMessage(
                            `Could not check what the chip holds (${checked.reason}), so this session may not line up with the code running on it.`,
                        );
                    }
                }

                output.appendLine(`debug: starting "${configuration.name}"`);
                const started = await vscode.debug.startDebugging(folder, configuration.name);
                if (!started) {
                    void vscode.window.showErrorMessage(
                        `Could not start "${configuration.name}". Is a debug probe connected and is the chip id correct?`,
                    );
                    return;
                }
                if (configuration.choice.flashing) {
                    // Remember what the chip now holds, so the attach entries can say whether they
                    // match it.
                    await context.workspaceState.update(LAST_FLASHED_KEY, 'debug');
                }
            }),
        ),

        // Stop: the status bar button is only visible while a probe-rs session runs, so this is
        // normally reached from there, and from the palette when a session is stuck.
        vscode.commands.registerCommand('rustyPlatform.debugStop', async () => {
            const session = activeProbeRsSession();
            if (session === undefined) {
                void vscode.window.showInformationMessage('No probe-rs debug session is running.');
                return;
            }
            output.appendLine(`debug: stopping "${session.name}" (${session.type})`);
            await vscode.debug.stopDebugging(session);
        }),

        // The same guard rail, on demand. It lives here rather than only inside Debug because the
        // useful moment is often *after* a debugger update and *before* the next session, and
        // because a project that cannot be debugged at all still needs the diagnosis.
        vscode.commands.registerCommand('rustyPlatform.checkLaunchConfig', () =>
            withProject(async (project) => {
                const report = await inspectLaunchConfigurations(project);
                if (report.unchecked !== undefined) {
                    output.appendLine(`launch.json: nothing to check - ${report.unchecked}`);
                    void vscode.window.showInformationMessage(`Nothing to check: ${report.unchecked}.`);
                    return;
                }
                if (report.problems.length === 0) {
                    output.appendLine(
                        'launch.json: every probe-rs configuration matches the installed debugger',
                    );
                    void vscode.window.showInformationMessage(
                        'The debug configurations match the installed probe-rs debugger.',
                    );
                    return;
                }
                output.appendLine('launch.json: the file does not match the installed debugger');
                void reportLaunchConfigProblems(project, report, output);
            }),
        ),
    ];
}
