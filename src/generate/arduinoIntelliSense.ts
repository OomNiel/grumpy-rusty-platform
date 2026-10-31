/**
 * What a C++ project needs for its editor to understand it.
 *
 * A sketch is not a normal C++ project: `Arduino.h`, `SPI.h` and every `-D` come from whichever core is
 * installed, and Arduino's build recipes are full of flags no `c_cpp_properties.json` could guess. The one
 * description that is exactly right is the compiler's own command line, and `arduino-cli` will write it:
 *
 *     arduino-cli compile --fqbn <fqbn> --only-compilation-database --build-path .arduino/build
 *
 * That leaves a `compile_commands.json` in the project, which the C/C++ extension reads directly. This module
 * owns the *text* of the config; `src/toolchain/arduinoIntelliSense.ts` runs the command and writes it.
 *
 * Pure on purpose: no `vscode`, no processes, so the t1 layer can pin both the file and the FQBN parsing.
 */

/** Where the compilation database is kept, relative to the project. Ignored by the generated `.gitignore`. */
export const ARDUINO_BUILD_DIR = '.arduino/build';

/**
 * The database the C/C++ extension is pointed at, relative to the project.
 *
 * Not arduino-cli's own file: that one names the *copy* of the sketch under `.arduino/build/sketch/`, and the
 * C/C++ extension matches database entries to files by absolute path. A person's `src/ui.cpp` is not in it, so
 * every entry was silently ignored and IntelliSense fell back to `includePath` -- which knows nothing about
 * LVGL, `lv_conf.h` or the board's `-D`s. The problems pane then showed "cannot open source file lvgl.h" for a
 * project that compiled perfectly (bench, 2026-10-31). The rewritten file beside arduino-cli's own adds an
 * entry per project source, with the same command line, so the editor sees exactly what the compiler did.
 */
export const INTELLISENSE_DATABASE_PATH = '.arduino/compile_commands.json';

/** The file the C/C++ extension reads. */
export const INTELLISENSE_CONFIG_PATH = '.vscode/c_cpp_properties.json';

/**
 * The board a sketch is built for, read back out of its `sketch.yaml`.
 *
 * The manifest is the project's own record of what `arduino-cli` should build, so it is also the only thing
 * that has to be right for the editor config to be right: nothing here re-derives a board from pins.
 */
export function fqbnFromSketchYaml(text: string): string | undefined {
    // Unquoted or quoted, and tolerant of trailing comments: the file is written by this extension, but a
    // person may edit it by hand and a stray quote must not silently produce a broken command line.
    const match = /^\s*fqbn:\s*["']?([A-Za-z0-9_]+:[A-Za-z0-9_]+:[A-Za-z0-9_-]+)["']?\s*$/m.exec(text);
    return match === null ? undefined : match[1];
}

/**
 * The include paths and compiler `arduino-cli` reports for a board.
 *
 * `compile --show-properties` is the only honest source for these: the core, the variant, the core's own system
 * folder and the compiler that comes with the package. Read here rather than guessed, so the editor's answer is
 * the build's answer.
 */
export function parseArduinoProperties(stdout: string): { includePaths: string[]; compilerPath?: string } {
    const values = new Map<string, string>();
    for (const line of stdout.split('\n')) {
        const match = /^([A-Za-z0-9_.]+)=(.*)$/.exec(line.trim());
        if (match !== null && match[1] !== undefined && match[2] !== undefined) {
            values.set(match[1], match[2]);
        }
    }
    const includePaths: string[] = [];
    for (const key of ['build.core.path', 'build.variant.path', 'build.system.path']) {
        const value = values.get(key);
        if (value !== undefined && value !== '' && !includePaths.includes(value)) {
            includePaths.push(value);
        }
    }
    const platform = values.get('runtime.platform.path');
    if (platform !== undefined && platform !== '') {
        includePaths.push(`${platform}/include`);
    }
    const toolchain = values.get('compiler.path');
    const compiler = values.get('compiler.cpp.cmd');
    const compilerPath =
        toolchain !== undefined && compiler !== undefined && toolchain !== ''
            ? `${toolchain}${compiler}`
            : undefined;
    return compilerPath === undefined ? { includePaths } : { includePaths, compilerPath };
}

/**
 * `c_cpp_properties.json`, as text.
 *
 * `compileCommands` is what does the work. `includePath` names only the sketch itself, because a project whose
 * database has not been generated yet should still resolve `#include "panel.h"` — and should still show
 * `Arduino.h` as missing, which is the honest state of a folder with no core behind it.
 *//** Reads a response file named by an `@argument`. Injected so this module stays pure. */
export type ResponseFileReader = (file: string) => string | undefined;

/**
 * A compiler command line with its `@response` files opened.
 *
 * arduino-pico puts sixty-odd pico-sdk include folders in `@…/core_inc.txt`, reached through
 * `-iprefix<core>/` plus `-iwithprefixbefore/pico-sdk/…`. A compiler opens them; the C/C++ extension does not,
 * so IntelliSense saw none of those paths and reported `lwip/init.h` (and `<pico/stdlib.h>`) as missing for a
 * sketch that compiles — the persistent red squiggles on the bench (2026-10-31). The tokens are inlined here,
 * and `-iprefix` + `-iwithprefixbefore` become an ordinary `-I<absolute path>` that every tool understands.
 */
export function expandCompileArguments(args: readonly string[], read: ResponseFileReader): string[] {
    const out: string[] = [];
    let prefix = '';
    const push = (tokens: readonly string[]): void => {
        for (const token of tokens) {
            if (token === '') {
                continue;
            }
            if (token.startsWith('-iprefix')) {
                prefix = token.slice('-iprefix'.length);
            } else if (token.startsWith('-iwithprefixbefore')) {
                // Relative to `-iprefix`, which is a spelling no editor understands; as a path it is plain.
                out.push(`-I${prefix}${token.slice('-iwithprefixbefore'.length)}`);
            } else if (token.startsWith('-iwithprefix')) {
                out.push(`-I${prefix}include/${token.slice('-iwithprefix'.length)}`);
            } else {
                out.push(token);
            }
        }
    };
    for (const arg of args) {
        if (arg.startsWith('@')) {
            const text = read(arg.slice(1));
            push(text === undefined ? [] : text.split(/\s+/).filter((token) => token !== ''));
            continue;
        }
        push([arg]);
    }
    return out;
}

/**
 * The include paths and `-D`s one compiled file was given, out of a `compile_commands.json` entry.
 *
 * Only the two forms a person's headers care about are kept: `-I<dir>`/`-I <dir>` and `-D<name>[=value]`. The
 * rest of a core's recipe (`-mcpu`, `-g`, `-pipe`, …) belongs to the build; the C/C++ extension is told the
 * same thing twice, once through the database and once through these.
 */
export function parseCompileFlags(args: readonly string[]): {
    includes: string[];
    defines: string[];
    compilerArgs: string[];
} {
    const includes: string[] = [];
    const defines: string[] = [];
    const compilerArgs: string[] = [];
    const add = (list: string[], value: string): void => {
        if (value !== '' && !list.includes(value)) {
            list.push(value);
        }
    };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index] ?? '';
        if (arg === '-I' || arg === '-D') {
            const value = args[index + 1];
            if (value !== undefined) {
                add(arg === '-I' ? includes : defines, value);
            }
            index += 1;
        } else if (arg.startsWith('-I') && arg.length > 2) {
            add(includes, arg.slice(2));
        } else if (arg.startsWith('-D') && arg.length > 2) {
            add(defines, arg.slice(2));
        } else if (arg === '-o') {
            index += 1;
        } else if (arg.startsWith('-') && arg !== '-c') {
            // The rest of the recipe is not optional for a Cortex-M: without `-mcpu`/`-march` pico-sdk's own
            // `spin_lock.h` stops with "no SW_SPIN_LOCK_LOCK available", which the editor would report as an
            // error in a sketch that builds. `compilerArgs` is where the C/C++ extension wants these.
            add(compilerArgs, arg);
        }
    }
    return { includes, defines, compilerArgs };
}

/**
 * A compilation database the editor can actually use, from the one arduino-cli wrote.
 *
 * arduino-cli compiles a *copy* of the sketch (`.arduino/build/sketch/src/ui.cpp`), which is what keeps a
 * diagnostic's path mappable and the build folder disposable — but it also means the database has no entry for
 * `src/ui.cpp`, and the C/C++ extension matches entries by absolute path. The fix is to add one entry per
 * project file: same command line, `file` and `directory` pointing at the project. The originals stay, so the
 * copied sketch still resolves for anything that reads the build tree.
 *
 * Returns the input unchanged when nothing matched, so a database for some other layout is never emptied.
 */
export function projectCompileDatabase(json: string, folder: string, read: ResponseFileReader = () => undefined): string {
    let entries: unknown;
    try {
        entries = JSON.parse(json);
    } catch {
        return json;
    }
    if (!Array.isArray(entries)) {
        return json;
    }
    const copyRoot = `${folder}/${ARDUINO_BUILD_DIR}/sketch/`;
    const merged: unknown[] = [];
    for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') {
            merged.push(entry);
            continue;
        }
        const record = entry as { directory?: unknown; arguments?: unknown; file?: unknown };
        if (typeof record.file !== 'string' || !Array.isArray(record.arguments)) {
            merged.push(entry);
            continue;
        }
        const args = record.arguments.filter((arg): arg is string => typeof arg === 'string');
        const expanded = expandCompileArguments(args, read);
        if (record.file.startsWith(copyRoot)) {
            // The same command line for the project's own file, which is the path the editor has open.
            merged.push({ directory: folder, arguments: expanded, file: `${folder}/${record.file.slice(copyRoot.length)}` });
        } else {
            merged.push({ ...record, arguments: expanded });
        }
    }
    return `${JSON.stringify(merged, null, 2)}\n`;
}

/**
 * The include paths that are actually there.
 *
 * arduino-pico's `core_inc.txt` still lists pico-sdk 2.x folders (`common/pico_base`, `common/pico_bit_ops`, …)
 * that the rp2350 layout replaced with `…_headers` names. A compiler ignores a `-I` that does not exist, but the
 * C/C++ extension reports each one as *Cannot find* in the Problems pane, against `c_cpp_properties.json` itself
 * — six warnings for a project that builds and for paths nobody chose (bench, 2026-10-31). A path that is not
 * on disk cannot help an editor, so it is dropped here and nowhere else: the database keeps everything the
 * compiler was given.
 */
export function existingIncludePaths(paths: readonly string[], isDirectory: (path: string) => boolean): string[] {
    const kept: string[] = [];
    for (const entry of paths) {
        // `${workspaceFolder}/…` and other substitutions stay: only absolute paths can be checked here.
        if (entry === '' || kept.includes(entry)) {
            continue;
        }
        if (path_isAbsolute(entry) && !isDirectory(entry)) {
            continue;
        }
        kept.push(entry);
    }
    return kept;
}

/** `path.isAbsolute` without importing `path` into a module that has no other reason to know the platform. */
function path_isAbsolute(value: string): boolean {
    return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

export function intelliSenseConfig(settings: {
    /** Which compiler family the board uses: the C/C++ extension picks its own defaults from this. */
    family: 'rp' | 'esp';
    /** Whether the compilation database exists already; the comment then says how to refresh it. */
    hasDatabase: boolean;
    /**
     * The include paths the core reports, and the compiler it is built with.
     *
     * Belt and braces: `compileCommands` is the precise answer, but the C/C++ extension silently refuses a
     * database entry it cannot make sense of, and then every header from the core reads as missing. These are
     * the same paths in a form it always understands.
     */
    includePaths?: string[];
    /**
     * The `-D`s the compiler was given, from the same database entry.
     *
     * `LV_CONF_INCLUDE_SIMPLE` is the one that matters most: without it LVGL looks for `lv_conf.h` beside its
     * own header, so the editor reports the file as missing and every LVGL type as undeclared while the build
     * is perfectly happy.
     */
    defines?: string[];
    /** The compiler's own flags: `-mcpu`, `-march`, `-std` and the like, which the core's headers depend on. */
    compilerArgs?: string[];
    compilerPath?: string;
}): string {
    const mode = settings.family === 'rp' ? 'gcc-arm' : 'gcc-x86';
    // Two whole sentences, each on its own line, so the command's name is never split by a wrap: a person who
    // reads this file is meant to be able to copy it out.
    const howTo = settings.hasDatabase
        ? 'Run "Arduino: Refresh C++ IntelliSense" after installing a library or changing the board.'
        : "The compiler database is missing, so only this project's own headers resolve. Run the command\n" +
        '    // "Arduino: Refresh C++ IntelliSense" to write it (it needs arduino-cli and this board\'s core).';
    return `{
    // Written by Grumpy's Rusty Platform.
    //
    // The C/C++ extension reads the command line arduino-cli would use for this board, so every include and
    // every -D resolves exactly as a real build sees it. ${howTo}
    "configurations": [
        {
            "name": "Arduino (C++)",
            "compileCommands": "\${workspaceFolder}/${INTELLISENSE_DATABASE_PATH}",
            "includePath": [${[
            '"${workspaceFolder}/src"',
            '"${workspaceFolder}"',
            ...(settings.includePaths ?? []).map((path) => JSON.stringify(path)),
        ].join(', ')}],${settings.defines === undefined || settings.defines.length === 0 ? '' : `\n            "defines": [${settings.defines.map((define) => JSON.stringify(define)).join(', ')}],`}${settings.compilerArgs === undefined || settings.compilerArgs.length === 0 ? '' : `\n            "compilerArgs": [${settings.compilerArgs.map((arg) => JSON.stringify(arg)).join(', ')}],`}${settings.compilerPath === undefined ? '' : `\n            "compilerPath": ${JSON.stringify(settings.compilerPath)},`}
            "cStandard": "gnu17",
            "cppStandard": "gnu++17",
            "intelliSenseMode": "${mode}"
        }
    ],
    "version": 4
}
`;
}
