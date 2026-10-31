import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ExecFn, execFileFn } from '../util/exec';
import { arduinoCliPath } from './arduinoCli';
import {
    ARDUINO_BUILD_DIR,
    INTELLISENSE_CONFIG_PATH,
    fqbnFromSketchYaml,
    intelliSenseConfig,
} from '../generate/arduinoIntelliSense';

/**
 * Makes a C++ sketch folder understandable to the editor.
 *
 * The work is `arduino-cli compile --only-compilation-database`: a second of preprocessing that leaves the
 * compiler's own command line in `.arduino/build/compile_commands.json`, which the C/C++ extension reads. The
 * config file beside it is only a pointer, so a project whose core is not installed yet is left with a file
 * that says what to do rather than with invented include paths that go stale.
 *
 * This is the first arduino-cli call in the extension; the detect/build/upload work of
 * `plans/arduino-backend.md` phase 3 will grow from it.
 */

export type IntelliSenseOutcome = 'written' | 'no-cli' | 'no-fqbn' | 'failed';

function readText(file: string): string | undefined {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return undefined;
    }
}

/**
 * Regenerates the compilation database and the editor config for one C++ project.
 *
 * Never throws: every failure is an outcome the caller can report, because this runs *after* a project has
 * been created and must not turn a made project into an error dialog.
 */
export async function writeArduinoIntelliSense(options: {
    project: vscode.Uri;
    output: vscode.OutputChannel;
    run?: ExecFn;
}): Promise<IntelliSenseOutcome> {
    const { project, output } = options;
    const run = options.run ?? execFileFn;
    const folder = project.fsPath;

    const sketchYaml = readText(path.join(folder, 'sketch.yaml'));
    const fqbn = sketchYaml === undefined ? undefined : fqbnFromSketchYaml(sketchYaml);
    if (fqbn === undefined) {
        output.appendLine('[intellisense] no `fqbn:` in sketch.yaml, so there is no board to ask arduino-cli about');
        return 'no-fqbn';
    }

    const cli = arduinoCliPath();
    if (cli === undefined) {
        output.appendLine('[intellisense] arduino-cli not found; the editor config was written without a database');
        writeConfig(folder, fqbn, false);
        return 'no-cli';
    }

    const buildPath = path.join(folder, ARDUINO_BUILD_DIR);
    const result = await run(
        cli,
        ['compile', '--fqbn', fqbn, '--only-compilation-database', '--build-path', buildPath],
        { cwd: folder, timeoutMs: 120_000 },
    );
    const database = path.join(buildPath, 'compile_commands.json');
    if (result.code !== 0 || !fs.existsSync(database)) {
        // The core is missing, the sketch does not parse, or the tool is too old. Say which, keep the message
        // to one line, and still write the config so the next attempt has somewhere to point.
        const detail = (result.stderr || result.stdout).trim().split('\n').slice(-1)[0] ?? '';
        output.appendLine(`[intellisense] arduino-cli could not write the database: ${detail}`);
        writeConfig(folder, fqbn, false);
        return 'failed';
    }

    writeConfig(folder, fqbn, true);
    output.appendLine(`[intellisense] ${fqbn}: compiler database written to ${ARDUINO_BUILD_DIR}`);
    return 'written';
}

function writeConfig(folder: string, fqbn: string, hasDatabase: boolean): void {
    const target = path.join(folder, INTELLISENSE_CONFIG_PATH);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const family = fqbn.startsWith('esp32:') ? 'esp' : 'rp';
    fs.writeFileSync(target, intelliSenseConfig({ family, hasDatabase }), 'utf8');
}
