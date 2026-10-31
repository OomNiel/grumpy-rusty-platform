import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ExecFn, execFileFn } from '../util/exec';
import { arduinoCliPath } from './arduinoCli';

/**
 * The arduino-cli this window should use, honouring `rustyPlatform.arduinoCliPath`.
 *
 * The setting is read here rather than inside `arduinoCliPath` so that module stays importable without an
 * editor -- the t1 layer loads it directly.
 */
export function configuredArduinoCliPath(): string | undefined {
    return arduinoCliPath(vscode.workspace.getConfiguration('rustyPlatform').get<string>('arduinoCliPath'));
}
import {
    ARDUINO_BUILD_DIR,
    INTELLISENSE_CONFIG_PATH,
    INTELLISENSE_DATABASE_PATH,
    fqbnFromSketchYaml,
    intelliSenseConfig,
    expandCompileArguments,
    parseArduinoProperties,
    parseCompileFlags,
    projectCompileDatabase,
} from '../generate/arduinoIntelliSense';
import { lvConfBuildProperties } from './arduinoBuild';

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

    const cli = configuredArduinoCliPath();
    if (cli === undefined) {
        output.appendLine('[intellisense] arduino-cli not found; the editor config was written without a database');
        writeConfig(folder, fqbn, false);
        return 'no-cli';
    }

    const buildPath = path.join(folder, ARDUINO_BUILD_DIR);
    // The same `--build-property` the build passes, or the database describes a project with no LVGL in it:
    // `lv_conf.h` unresolved, `lv_obj_t` undeclared, and a Problems pane full of errors for a sketch that
    // compiles (bench, 2026-10-31). One helper, used by both, so they cannot drift.
    const result = await run(
        cli,
        [
            'compile',
            '--fqbn',
            fqbn,
            '--only-compilation-database',
            '--build-path',
            buildPath,
            ...lvConfBuildProperties(folder, fs.existsSync(path.join(folder, 'lv_conf.h'))),
        ],
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

    // The database names the *copy* of the sketch; the editor matches by path, so it gets its own copy with one
    // entry per project file, built from the same command line.
    let flags: { includes: string[]; defines: string[]; compilerArgs: string[] } = {
        includes: [],
        defines: [],
        compilerArgs: [],
    };
    try {
        const raw = fs.readFileSync(database, 'utf8');
        const readResponse = (file: string): string | undefined => readText(file);
        fs.writeFileSync(
            path.join(folder, INTELLISENSE_DATABASE_PATH),
            projectCompileDatabase(raw, folder, readResponse),
            'utf8',
        );
        const entries = JSON.parse(raw) as { file?: unknown; arguments?: unknown }[];
        const project = entries.find(
            (entry) =>
                typeof entry.file === 'string' &&
                entry.file.startsWith(`${folder}/${ARDUINO_BUILD_DIR}/sketch/`) &&
                entry.file.endsWith('.cpp'),
        );
        if (project !== undefined && Array.isArray(project.arguments)) {
            const args = project.arguments.filter((arg): arg is string => typeof arg === 'string');
            flags = parseCompileFlags(expandCompileArguments(args, readResponse));
        }
    } catch (error) {
        output.appendLine(
            `[intellisense] could not read the database: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    // The explicit paths, from the core itself: `compileCommands` above is the precise answer, but the C/C++
    // extension drops an entry it cannot parse and then every core header reads as missing. Same answer, in the
    // form it always understands -- and the reason this runs `--show-properties` at all.
    const properties = await run(cli, ['compile', '--fqbn', fqbn, '--show-properties'], {
        cwd: folder,
        timeoutMs: 60_000,
    });
    const parsed = properties.code === 0 ? parseArduinoProperties(properties.stdout) : { includePaths: [] };
    writeConfig(folder, fqbn, true, {
        // The database's own paths first: they include every library the sketch actually uses, which the core's
        // property list does not know about.
        includePaths: [...new Set([...flags.includes, ...parsed.includePaths])],
        defines: flags.defines,
        compilerArgs: flags.compilerArgs,
        ...(parsed.compilerPath === undefined ? {} : { compilerPath: parsed.compilerPath }),
    });
    output.appendLine(
        `[intellisense] ${fqbn}: compiler database written to ${ARDUINO_BUILD_DIR}` +
        (parsed.includePaths.length === 0 ? ' (no core paths: --show-properties failed)' : ''),
    );
    return 'written';
}

function writeConfig(
    folder: string,
    fqbn: string,
    hasDatabase: boolean,
    properties: {
        includePaths: string[];
        defines?: string[];
        compilerArgs?: string[];
        compilerPath?: string;
    } = { includePaths: [] },
): void {
    const target = path.join(folder, INTELLISENSE_CONFIG_PATH);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const family = fqbn.startsWith('esp32:') ? 'esp' : 'rp';
    fs.writeFileSync(
        target,
        intelliSenseConfig({
            family,
            hasDatabase,
            includePaths: properties.includePaths,
            ...(properties.defines === undefined ? {} : { defines: properties.defines }),
            ...(properties.compilerArgs === undefined ? {} : { compilerArgs: properties.compilerArgs }),
            ...(properties.compilerPath === undefined ? {} : { compilerPath: properties.compilerPath }),
        }),
        'utf8',
    );
}
