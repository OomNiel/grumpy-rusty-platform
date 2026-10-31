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
 */
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
            "compileCommands": "\${workspaceFolder}/${ARDUINO_BUILD_DIR}/compile_commands.json",
            "includePath": [${[
                '"${workspaceFolder}/src"',
                '"${workspaceFolder}"',
                ...(settings.includePaths ?? []).map((path) => JSON.stringify(path)),
            ].join(', ')}],${settings.compilerPath === undefined ? '' : `\n            "compilerPath": ${JSON.stringify(settings.compilerPath)},`}
            "cStandard": "gnu17",
            "cppStandard": "gnu++17",
            "intelliSenseMode": "${mode}"
        }
    ],
    "version": 4
}
`;
}
