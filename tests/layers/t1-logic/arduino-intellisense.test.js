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
    fqbnFromSketchYaml,
    intelliSenseConfig,
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
    contains(text, '${workspaceFolder}/.arduino/build/compile_commands.json', 'pointed at by the config');
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
