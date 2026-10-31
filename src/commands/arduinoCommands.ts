import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ActiveProject } from '../project/activeProject';
import { fqbnFromSketchYaml, ARDUINO_BUILD_DIR } from '../generate/arduinoIntelliSense';
import {
    ARDUINO_ARTIFACT_DIR,
    collectDiagnostics,
    compileArgs,
    fqbnOption,
    lastLineOf,
    monitorArgs,
    projectPathOf,
    uploadArgs,
    uploadNeedsPort,
    withFqbnOption,
    withoutFqbnOption,
} from '../toolchain/arduinoBuild';
import {
    ArduinoPort,
    coreIdFor,
    detectArduino,
    hasCoreFor,
    listArduinoPorts,
    parseUploadMethodMenu,
    readSketchYaml,
    setSketchFqbn,
} from '../toolchain/arduinoCli';
import { configuredArduinoCliPath, writeArduinoIntelliSense } from '../toolchain/arduinoIntelliSense';
import { execFileFn } from '../util/exec';
import { runInTerminal } from './terminal';

/**
 * Build, Upload and Monitor for an Arduino (C++) project.
 *
 * The Rust route is a terminal running cargo. A C++ build is captured instead, for one reason: arduino-cli
 * prints diagnostics as JSON, and capturing them is what puts the errors on the Problems pane with a line to
 * click — the same thing cargo's own output does not give us. The compiler's full text still goes to the
 * Rusty Platform log, so nothing is hidden.
 *
 * Every entry point here answers for itself instead of throwing: a missing CLI, a missing core or an empty
 * port list are ordinary states of a fresh machine.
 */

let diagnostics: vscode.DiagnosticCollection | undefined;

function diagnosticsFor(context: vscode.ExtensionContext): vscode.DiagnosticCollection {
    if (diagnostics === undefined) {
        diagnostics = vscode.languages.createDiagnosticCollection('rusty-arduino');
        context.subscriptions.push(diagnostics);
    }
    return diagnostics;
}

/** The board this sketch is built for, from the project's own manifest. */
function sketchFqbn(project: ActiveProject): string | undefined {
    const yaml = readSketchYaml(project.folder.fsPath);
    return yaml === undefined ? undefined : fqbnFromSketchYaml(yaml);
}

function noFqbn(): void {
    void vscode.window.showErrorMessage(
        'This C++ project\'s sketch.yaml has no `fqbn:` line, so there is no board to build for. ' +
        'Add one (for example `fqbn: rp2040:rp2040:rpipico2w`), then try again.',
    );
}

function noCli(): void {
    void vscode.window.showErrorMessage(
        'arduino-cli was not found. Install it (https://arduino.github.io/arduino-cli/) or put it on the ' +
        'PATH, then try again.',
    );
}

/**
 * Makes sure the board's core is installed, offering the one command that does it.
 *
 * Installing a core is hundreds of megabytes, so it is a question and it runs in a terminal the user can
 * watch — not something a Build button does silently.
 */
async function ensureCore(cli: string, fqbn: string, output: vscode.OutputChannel): Promise<boolean> {
    const status = await detectArduino(execFileFn, cli);
    if (hasCoreFor(status, fqbn)) {
        return true;
    }
    const core = coreIdFor(fqbn);
    const choice = await vscode.window.showWarningMessage(
        `The ${core} core is not installed, so this sketch cannot be built. Install it now?`,
        { modal: true },
        'Install',
    );
    if (choice !== 'Install') {
        return false;
    }
    output.appendLine(`[arduino] installing ${core}`);
    runInTerminal(`Rusty: ${core}`, `${quote(cli)} core install ${core}`);
    void vscode.window.showInformationMessage(
        `Installing ${core} in the Rusty: ${core} terminal. Build again when it finishes.`,
    );
    return false;
}

function quote(exe: string): string {
    return exe.includes(' ') ? `"${exe}"` : exe;
}

/** Whether this project draws with LVGL, which is what a designer project always does. */
function hasLvConf(folder: string): boolean {
    return fs.existsSync(path.join(folder, 'lv_conf.h'));
}

/** Runs one arduino-cli command with its output captured, and logs it. */
async function runCaptured(
    cli: string,
    args: string[],
    cwd: string,
    output: vscode.OutputChannel,
): Promise<{ code: number; stdout: string; stderr: string }> {
    const result = await execFileFn(cli, args, { cwd, timeoutMs: 15 * 60_000 });
    output.appendLine(`$ ${quote(cli)} ${args.join(' ')}`);
    if (result.stdout.trim() !== '') {
        output.appendLine(result.stdout.trimEnd());
    }
    if (result.stderr.trim() !== '') {
        output.appendLine(result.stderr.trimEnd());
    }
    return result;
}

function publish(
    context: vscode.ExtensionContext,
    result: { code: number; stdout: string; stderr: string },
    folder: vscode.Uri,
): number {
    const found = collectDiagnostics(result.stdout, result.stderr);
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const diagnostic of found) {
        const absolute = projectPathOf(
            path.isAbsolute(diagnostic.file)
                ? diagnostic.file
                : path.join(folder.fsPath, diagnostic.file),
            folder.fsPath,
        );
        const message = new vscode.Diagnostic(
            new vscode.Range(
                Math.max(0, diagnostic.line - 1),
                Math.max(0, diagnostic.column - 1),
                Math.max(0, diagnostic.line - 1),
                400,
            ),
            diagnostic.message,
            diagnostic.severity === 'error'
                ? vscode.DiagnosticSeverity.Error
                : vscode.DiagnosticSeverity.Warning,
        );
        message.source = 'arduino-cli';
        const list = byFile.get(absolute) ?? [];
        list.push(message);
        byFile.set(absolute, list);
    }
    const collection = diagnosticsFor(context);
    collection.clear();
    for (const [file, list] of byFile) {
        collection.set(vscode.Uri.file(file), list);
    }
    return found.length;
}

/**
 * Makes sure LVGL is installed, which a designer project cannot build without.
 *
 * The library is machine-wide (Arduino keeps one copy under `~/Arduino/libraries`), so it is asked for once and
 * installed in a terminal like a core is — same reasoning: it is a download, and watching it is the only way to
 * know it worked.
 */
async function ensureLvgl(cli: string, output: vscode.OutputChannel): Promise<boolean> {
    const result = await execFileFn(cli, ['lib', 'list', '--format', 'json'], { timeoutMs: 60_000 });
    if (result.code === 0 && /"name":\s*"lvgl"|\blvgl\b/.test(result.stdout)) {
        return true;
    }
    const choice = await vscode.window.showWarningMessage(
        'This project draws with LVGL, which is not installed. Install it now? (arduino-cli lib install lvgl)',
        { modal: true },
        'Install',
    );
    if (choice !== 'Install') {
        return false;
    }
    output.appendLine('[arduino] installing lvgl');
    runInTerminal('Rusty: lvgl', `${quote(cli)} lib install lvgl`);
    void vscode.window.showInformationMessage(
        'Installing LVGL in the Rusty: lvgl terminal. Build again when it finishes.',
    );
    return false;
}

/**
 * Compiles the sketch, putting every diagnostic on the Problems pane.
 *
 * Returns whether it succeeded, which is what Upload uses to decide whether to build once more.
 */
export async function arduinoBuild(
    context: vscode.ExtensionContext,
    project: ActiveProject,
    output: vscode.OutputChannel,
): Promise<boolean> {
    const cli = configuredArduinoCliPath();
    if (cli === undefined) {
        noCli();
        return false;
    }
    const fqbn = sketchFqbn(project);
    if (fqbn === undefined) {
        noFqbn();
        return false;
    }
    if (!(await ensureCore(cli, fqbn, output))) {
        return false;
    }
    const lvgl = hasLvConf(project.folder.fsPath);
    if (lvgl && !(await ensureLvgl(cli, output))) {
        return false;
    }

    output.show(true);
    const ok = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `${fqbn}: building`, cancellable: false },
        async () => {
            const result = await runCaptured(
                cli,
                compileArgs(fqbn, project.folder.fsPath, hasLvConf(project.folder.fsPath)),
                project.folder.fsPath,
                output,
            );
            const count = publish(context, result, project.folder);
            if (result.code !== 0) {
                void vscode.window.showErrorMessage(
                    `Build failed${count > 0 ? ` — ${count} problem${count === 1 ? '' : 's'} in the Problems pane` : ''}: ` +
                    (lastLineOf(result.stderr) || lastLineOf(result.stdout) || 'see the log'),
                );
                return false;
            }
            void vscode.window.showInformationMessage(`Built for ${fqbn}.`);
            // The include paths are the same answer as the build's, so refresh them while we are here.
            void writeArduinoIntelliSense({ project: project.folder, output, run: execFileFn });
            return true;
        },
    );
    return ok;
}

/** The port to upload or monitor on: the only one there is, or the one the user picks. */
async function pickPort(cli: string, fqbn: string): Promise<ArduinoPort | undefined> {
    const ports = await listArduinoPorts(execFileFn, cli);
    if (ports.length === 0) {
        const hint = fqbn.startsWith('rp2040:')
            ? ' Hold BOOTSEL while plugging the board in (or press it while RESET is held) so it appears as a ' +
            'drive, then try again. A **debug probe** does not appear as a port at all — use "Rusty: Upload ' +
            'Method" to flash over SWD instead.'
            : '';
        void vscode.window.showErrorMessage(`No board found on any port.${hint.replace(/\*\*/g, '')}`);
        return undefined;
    }
    if (ports.length === 1) {
        return ports[0];
    }
    const picked = await vscode.window.showQuickPick(
        ports.map((port) => ({
            label: port.label,
            description: `${port.address} · ${port.protocol}`,
            detail: port.fqbn ?? '',
            port,
        })),
        { title: 'Which board?', placeHolder: 'Port' },
    );
    return picked?.port;
}

/**
 * Uploads the sketch, building it first when the last build did not run or failed.
 *
 * `upload --input-dir build` is what makes this the same artifacts the Build button produced; without it the
 * CLI would rebuild into a fresh temporary directory and upload that, which is how a project ends up flashed
 * with something the editor never saw.
 */
export async function arduinoUpload(
    context: vscode.ExtensionContext,
    project: ActiveProject,
    output: vscode.OutputChannel,
    options: { monitor?: boolean } = {},
): Promise<void> {
    const cli = configuredArduinoCliPath();
    if (cli === undefined) {
        noCli();
        return;
    }
    const fqbn = sketchFqbn(project);
    if (fqbn === undefined) {
        noFqbn();
        return;
    }
    if (!(await ensureCore(cli, fqbn, output))) {
        return;
    }

    const building = await arduinoBuild(context, project, output);
    if (!building) {
        return;
    }
    // A probe programs over SWD and a bootloader upload takes the UF2; neither has a serial port to pick, and
    // asking for one is what stopped a probe user at "No board found" before flashing anything (2026-10-31).
    const port = uploadNeedsPort(fqbn) ? await pickPort(cli, fqbn) : undefined;
    if (uploadNeedsPort(fqbn) && port === undefined) {
        return;
    }

    output.show(true);
    const result = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: port === undefined ? 'Uploading over the debug probe' : `Uploading to ${port.address}`,
            cancellable: false,
        },
        () => runCaptured(cli, uploadArgs(fqbn, port?.address), project.folder.fsPath, output),
    );
    if (result.code !== 0) {
        void vscode.window.showErrorMessage(
            `Upload failed: ${lastLineOf(result.stderr) || lastLineOf(result.stdout) || 'see the log'}`,
        );
        return;
    }
    void vscode.window.showInformationMessage(
        port === undefined ? 'Uploaded over the debug probe.' : `Uploaded to ${port.address}.`,
    );
    if (options.monitor === true && port !== undefined) {
        runInTerminal('Rusty: monitor', `${quote(cli)} ${monitorArgs(port.address).join(' ')}`, project.folder);
    }
}

/** Opens the serial monitor; it holds the port until its terminal is closed, as the Rust monitor does. */
export async function arduinoMonitor(
    project: ActiveProject,
    output: vscode.OutputChannel,
): Promise<void> {
    const cli = configuredArduinoCliPath();
    if (cli === undefined) {
        noCli();
        return;
    }
    const fqbn = sketchFqbn(project);
    if (fqbn === undefined) {
        noFqbn();
        return;
    }
    const port = await pickPort(cli, fqbn);
    if (port === undefined) {
        return;
    }
    output.appendLine(`[arduino] monitor on ${port.address}`);
    runInTerminal('Rusty: monitor', `${quote(cli)} ${monitorArgs(port.address).join(' ')}`, project.folder);
}

/**
 * Chooses how this board is programmed, from the core's own menu.
 *
 * arduino-pico offers `default` (UF2 over USB), `picotool` and `picoprobe_cmsis_dap` (a debug probe over SWD),
 * and the difference is not cosmetic: the method decides the debug script and `upload.maximum_data_size`, so the
 * *build* has to carry the same option as the flash. That is why the answer is written into the project's
 * `sketch.yaml` and not held in a setting -- it belongs to the project, next to the board it is about.
 *
 * This is the way out of "No board found on any port" for a probe user: a CMSIS-DAP probe never appears as a
 * port, because it programs over SWD rather than through a serial link.
 */
export async function arduinoUploadMethod(project: ActiveProject, output: vscode.OutputChannel): Promise<void> {
    const cli = configuredArduinoCliPath();
    if (cli === undefined) {
        noCli();
        return;
    }
    const fqbn = sketchFqbn(project);
    if (fqbn === undefined) {
        noFqbn();
        return;
    }
    const details = await execFileFn(cli, ['board', 'details', '--fqbn', fqbn.split(':').slice(0, 3).join(':'), '--format', 'json'], {
        timeoutMs: 60_000,
    });
    const menu = details.code === 0 ? parseUploadMethodMenu(details.stdout) : undefined;
    if (menu === undefined) {
        void vscode.window.showInformationMessage(
            `The ${fqbn.split(':').slice(0, 2).join(':')} core offers no upload-method menu for this board, so there is ` +
            'nothing to choose: it is flashed over USB.',
        );
        return;
    }
    const current = fqbnOption(fqbn, menu.option) ?? menu.values[0];
    const described = menu.values.map((value) => ({
        label: value,
        description: value === current ? 'current' : undefined,
        detail: UPLOAD_METHOD_NOTES[value],
        value,
    }));
    const picked = await vscode.window.showQuickPick(described, {
        title: 'How should this board be programmed?',
        placeHolder: 'Upload method',
    });
    if (picked === undefined || picked.value === current) {
        return;
    }
    const next = menu.values[0] === picked.value ? withoutFqbnOption(fqbn, menu.option) : withFqbnOption(fqbn, menu.option, picked.value);
    setSketchFqbn(project.folder.fsPath, next);
    output.appendLine(`[arduino] upload method: ${next}`);
    void vscode.window.showInformationMessage(
        `Upload method is now ${picked.value}. Build and Upload start from scratch with it.`,
    );
}

/** What each arduino-pico upload method means, for the picker. Keys are the core's own value names. */
const UPLOAD_METHOD_NOTES: Record<string, string> = {
    default: 'UF2 over USB — the board appears as a drive when you hold BOOTSEL',
    picotool: 'picotool talks to the bootloader directly',
    picoprobe_cmsis_dap: 'A debug probe (Pico Probe / CMSIS-DAP) over SWD — no serial port involved',
};

/**
 * Removes the build output, which is what `cargo clean` means on this side.
 *
 * Not `arduino-cli compile --clean`: that flag means *clean before compiling*, so it preprocesses the sketch and
 * then builds it — and it was invoked without the LVGL `--build-property`, so it died on `lv_conf.h` while a
 * plain Build worked (bench, 2026-10-31). A Clean that also rebuilds is not a Clean, and the two folders it
 * should empty are this project's own: `build/` (the artifacts Upload uses) and `.arduino/build` (arduino-cli's
 * objects — the 100 MB of the two).
 *
 * The editor's `c_cpp_properties.json` is deliberately left alone: it already carries the include paths, defines
 * and compiler flags from the last build, so IntelliSense keeps working without the database. Regenerating that
 * database here would put 40 MB straight back, which is the one thing a Clean must not do.
 */
export async function arduinoClean(project: ActiveProject, output: vscode.OutputChannel): Promise<void> {
    const folder = project.folder.fsPath;
    const targets = [path.join(folder, ARDUINO_ARTIFACT_DIR), path.join(folder, ARDUINO_BUILD_DIR)];
    const removed: string[] = [];
    for (const target of targets) {
        if (!fs.existsSync(target)) {
            continue;
        }
        const bytes = directorySize(target);
        try {
            fs.rmSync(target, { recursive: true, force: true });
            removed.push(`${path.relative(folder, target)} (${(bytes / 1_048_576).toFixed(1)} MB)`);
        } catch (error) {
            void vscode.window.showErrorMessage(
                `Could not remove ${path.relative(folder, target)}: ` +
                (error instanceof Error ? error.message : String(error)),
            );
            return;
        }
    }
    if (removed.length === 0) {
        void vscode.window.showInformationMessage('Nothing to clean: this project has no build output.');
        return;
    }
    output.appendLine(`[arduino] cleaned ${removed.join(', ')}`);
    void vscode.window.showInformationMessage(`Cleaned ${removed.join(', ')}. The next Build starts from scratch.`);
}

/** What a folder costs, so the message can say what was freed rather than only that something happened. */
function directorySize(folder: string): number {
    let total = 0;
    const walk = (current: string): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const child = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(child);
            } else {
                try {
                    total += fs.statSync(child).size;
                } catch {
                    // A file that vanished while we walked it costs nothing to report as zero.
                }
            }
        }
    };
    walk(folder);
    return total;
}
