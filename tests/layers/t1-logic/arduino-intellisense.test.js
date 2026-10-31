'use strict';

/**
 * What tells the editor where a sketch's headers are.
 *
 * A C++ project is unreadable to the C/C++ extension without this: `Arduino.h` and `SPI.h` live inside the
 * installed core, and the flags that go with them come from Arduino's build recipes. Two small pieces decide
 * whether that works, and both are pure functions:
 *
 *   - the board is read back out of the project's own `sketch.yaml`, so nothing re-derives it;
 *   - the config points at the compiler database arduino-cli writes, and says so honestly when it is missing.
 */

const { test, ok, equal, contains, notContains, compiled } = require('../../lib/harness');
const {
    ARDUINO_BUILD_DIR,
    INTELLISENSE_CONFIG_PATH,
    INTELLISENSE_DATABASE_PATH,
    expandCompileArguments,
    fqbnFromSketchYaml,
    intelliSenseConfig,
    parseArduinoProperties,
    parseCompileFlags,
    projectCompileDatabase,
} = compiled('generate/arduinoIntelliSense');

const SKETCH_YAML = `# Grumpy's Rusty Platform -- the board this sketch is built for.
#
# \`arduino-cli compile\` and \`arduino-cli upload\` read the FQBN from here.

profiles:
  default:
    fqbn: rp2040:rp2040:rpipico2w
`;

// ------------------------------------------------------------------------- FQBN

test('the board is read out of the sketch manifest, which is the project\'s own record', () => {
    equal(fqbnFromSketchYaml(SKETCH_YAML), 'rp2040:rp2040:rpipico2w', 'the Pico 2 W');
    equal(fqbnFromSketchYaml('    fqbn: esp32:esp32:esp32s3\n'), 'esp32:esp32:esp32s3', 'an S3');
    equal(fqbnFromSketchYaml('fqbn: "rp2040:rp2040:rpipico2"'), 'rp2040:rp2040:rpipico2', 'quoted');
});

test('a manifest with no board, or a malformed one, yields nothing rather than a guess', () => {
    equal(fqbnFromSketchYaml(''), undefined, 'empty');
    equal(fqbnFromSketchYaml('profiles:\n  default:\n    platforms: []\n'), undefined, 'no fqbn line');
    equal(fqbnFromSketchYaml('fqbn: rp2040\n'), undefined, 'not a FQBN at all');
    equal(fqbnFromSketchYaml('  # fqbn: rp2040:rp2040:rpipico\n'), undefined, 'commented out');
});

// ------------------------------------------------------------------------ config

test('the config points the editor at the compiler database, in the project', () => {
    const text = intelliSenseConfig({ family: 'rp', hasDatabase: true });
    equal(ARDUINO_BUILD_DIR, '.arduino/build', 'the database lives beside the project');
    equal(INTELLISENSE_CONFIG_PATH, '.vscode/c_cpp_properties.json', 'and that is the file the extension reads');
    // Not arduino-cli's own file: its entries name the *copy* of the sketch, so the editor ignored every one of
    // them and fell back to includePath. The rewritten file beside it carries an entry per project source.
    equal(INTELLISENSE_DATABASE_PATH, '.arduino/compile_commands.json', 'the rewritten database');
    contains(text, '${workspaceFolder}/.arduino/compile_commands.json', 'pointed at by the config');
    contains(text, '"includePath": ["${workspaceFolder}/src", "${workspaceFolder}"]', 'the sketch itself still resolves');
    contains(text, '"intelliSenseMode": "gcc-arm"', 'the RP2040 compiler family');
    contains(text, '"version": 4', 'and it is a version 4 file');
    ok(text.includes('Arduino: Refresh C++ IntelliSense'), 'it says how to refresh it');
});

test('the ESP32 boards get their own compiler family', () => {
    contains(intelliSenseConfig({ family: 'esp', hasDatabase: true }), '"intelliSenseMode": "gcc-x86"', 'xtensa');
});

test('a config with no database says so, instead of pretending the includes will resolve', () => {
    const missing = intelliSenseConfig({ family: 'rp', hasDatabase: false });
    contains(missing, 'compiler database is missing', 'it names the problem');
    contains(missing, 'Arduino: Refresh C++ IntelliSense', 'and the command that fixes it');
    notContains(missing, 'Run "Arduino: Refresh C++ IntelliSense" after installing a library', 'not the "it works" wording');
});

test('the file is valid JSON once its comments are dropped, which is what the C/C++ extension reads', () => {
    const text = intelliSenseConfig({ family: 'rp', hasDatabase: true })
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
    const parsed = JSON.parse(text);
    equal(parsed.version, 4, 'version 4');
    equal(parsed.configurations.length, 1, 'one configuration');
    equal(parsed.configurations[0].name, 'Arduino (C++)', 'named for what it is');
    equal(parsed.configurations[0].cppStandard, 'gnu++17', 'and a C++ standard cpptools knows');
});

// ------------------------------------------------------- the core's own properties

const SHOW_PROPERTIES = [
    'build.core.path=/c/core',
    'build.system.path=/c/system',
    'build.variant.path=/c/variant',
    'runtime.platform.path=/c/platform',
    'compiler.path=/t/bin/',
    'compiler.cpp.cmd=arm-none-eabi-g++',
].join('\n');

test('the core\'s own properties give the include paths and the compiler', () => {
    const parsed = parseArduinoProperties(SHOW_PROPERTIES);
    equal(parsed.includePaths.join(' '), '/c/core /c/variant /c/system /c/platform/include', 'core, variant, system, include');
    equal(parsed.compilerPath, '/t/bin/arm-none-eabi-g++', 'the compiler that comes with the package');
    equal(parseArduinoProperties('').includePaths.length, 0, 'nothing to say is nothing');
});

test('the config carries those paths, so a header resolves even if the database is refused', () => {
    const parsed = parseArduinoProperties(SHOW_PROPERTIES);
    const text = intelliSenseConfig({ family: 'rp', hasDatabase: true, ...parsed });
    contains(text, '"/c/core"', 'the core is on the include path');
    contains(text, '"/c/variant"', 'so is the variant');
    contains(text, '"compilerPath": "/t/bin/arm-none-eabi-g++"', 'and the compiler is named');
});

test('a config with no properties is still valid, just less helpful', () => {
    const text = intelliSenseConfig({ family: 'rp', hasDatabase: true, includePaths: [] });
    contains(text, '"includePath": ["${workspaceFolder}/src", "${workspaceFolder}"]', 'the sketch itself');
    notContains(text, 'compilerPath', 'and no compiler invented');
});

// ------------------------------------------- the database, as the editor needs it

// What arduino-cli leaves in `compile_commands.json`: the entry names arduino-cli's *copy* of the sketch, and
// the pico-sdk's includes hide behind `@response` files plus `-iprefix`. Both are exactly what the C/C++
// extension cannot read. Found on the bench 2026-10-31 as "cannot open source file lvgl.h" and "lwip/init.h"
// in a project whose build was clean.
const DATABASE = JSON.stringify([
    {
        directory: '/p',
        arguments: [
            '/t/bin/arm-none-eabi-g++',
            '-iprefix/c/',
            '@/c/lib/core_inc.txt',
            '-I/lvgl/src',
            '-DLV_CONF_INCLUDE_SIMPLE',
            '-I/p',
            '-c',
            '-mcpu=cortex-m33',
            '-o',
            '/p/.arduino/build/sketch/src/ui.cpp.o',
            '/p/.arduino/build/sketch/src/ui.cpp',
        ],
        file: '/p/.arduino/build/sketch/src/ui.cpp',
    },
]);
const RESPONSES = { '/c/lib/core_inc.txt': '-iwithprefixbefore/pico-sdk/lib/lwip/src/include\n' };
const readResponse = (file) => RESPONSES[file];

test('a response file is opened, because the editor will not open it', () => {
    const args = expandCompileArguments(['-iprefix/c/', '@/c/lib/core_inc.txt', '-I/x'], readResponse);
    equal(args.join(' '), '-I/c//pico-sdk/lib/lwip/src/include -I/x', 'the SDK path becomes an ordinary -I');
    equal(expandCompileArguments(['@/missing.txt'], readResponse).length, 0, 'a file that is not there is skipped');
});

test('the flags are taken apart into includes, defines and the rest', () => {
    const args = expandCompileArguments(
        ['/t/bin/g++', '-I', '/a', '-I/b', '-DLV_CONF_INCLUDE_SIMPLE', '-DX="two words"', '-c', '-mcpu=x',
            '-o', '/p/x.o', 'x.cpp'],
        readResponse,
    );
    const flags = parseCompileFlags(args);
    equal(flags.includes.join(' '), '/a /b', 'both spellings of -I');
    equal(flags.defines.join(' '), 'LV_CONF_INCLUDE_SIMPLE X="two words"', 'the defines, quotes kept');
    equal(flags.compilerArgs.join(' '), '-mcpu=x', 'and the flags a Cortex-M header needs, but -o is not one');
});

test('the database names the project\'s own files, so the editor matches them', () => {
    const text = projectCompileDatabase(DATABASE, '/p', readResponse);
    const entries = JSON.parse(text);
    equal(entries.length, 1, 'one entry, not two: the copy is replaced by the project file');
    equal(entries[0].file, '/p/src/ui.cpp', 'the file the editor has open');
    equal(entries[0].directory, '/p', 'with the project as its working folder');
    equal(entries[0].arguments.filter((arg) => arg.startsWith('@')).length, 0, 'and nothing left to expand');
});

test('a database it cannot read is handed back untouched', () => {
    equal(projectCompileDatabase('not json', '/p'), 'not json', 'garbage in, garbage out');
    equal(projectCompileDatabase('{}', '/p'), '{}', 'and so is an object');
});

test('the config points at the rewritten database and carries the flags', () => {
    const text = intelliSenseConfig({
        family: 'rp',
        hasDatabase: true,
        includePaths: ['/lvgl/src'],
        defines: ['LV_CONF_INCLUDE_SIMPLE'],
        compilerArgs: ['-mcpu=cortex-m33'],
    });
    contains(text, `"\${workspaceFolder}/${INTELLISENSE_DATABASE_PATH}"`, 'the rewritten database');
    contains(text, '"defines": ["LV_CONF_INCLUDE_SIMPLE"]', 'LVGL\'s own switch');
    contains(text, '"compilerArgs": ["-mcpu=cortex-m33"]', 'and the CPU the SDK headers insist on');
});
