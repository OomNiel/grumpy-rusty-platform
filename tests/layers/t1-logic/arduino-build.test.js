'use strict';

/**
 * Build, upload and monitor for a C++ project: the exact command lines, and the parsing of what arduino-cli
 * says.
 *
 * All of it is pure, so the t1 layer can pin the things that are invisible until a board is on the bench: which
 * flags LVGL needs, where a diagnostic's file really is, and which of the tool's two error formats is used.
 */

const { test, ok, equal, contains, notContains, compiled } = require('../../lib/harness');
const {
    ARDUINO_ARTIFACT_DIR,
    compileArgs,
    uploadArgs,
    monitorArgs,
    collectDiagnostics,
    parseCompileJson,
    parseGccText,
    projectPathOf,
    lastLineOf,
} = compiled('toolchain/arduinoBuild');
const { parseCoreList, parseBoardList, coreIdFor, hasCoreFor, arduinoCliPath } = compiled('toolchain/arduinoCli');
const { ARDUINO_BUILD_DIR } = compiled('generate/arduinoIntelliSense');

// ------------------------------------------------------------------- command lines

test('the build puts the sketch copy inside the project, so a diagnostic names a real file', () => {
    const args = compileArgs('rp2040:rp2040:rpipico2w');
    equal(args[0], 'compile', 'compile');
    contains(args.join(' '), '--fqbn rp2040:rp2040:rpipico2w', 'the board');
    contains(args.join(' '), `--build-path ${ARDUINO_BUILD_DIR}`, 'the sketch copy');
    contains(args.join(' '), `--output-dir ${ARDUINO_ARTIFACT_DIR}`, 'and the artifacts');
    notContains(args.join(' '), 'LV_CONF', 'a project with no LVGL asks for no LVGL flags');
});

test('a designer project builds with the LVGL flags, because LVGL cannot find its config without them', () => {
    const args = compileArgs('rp2040:rp2040:rpipico2w', '/home/me/sketch', true);
    const line = args.join(' ');
    contains(line, '-DLV_CONF_INCLUDE_SIMPLE -I/home/me/sketch', 'the define and the project root');
    equal(args.filter((arg) => arg === '--build-property').length, 2, 'for the C and the C++ compiler');
    contains(line, 'compiler.cpp.extra_flags=', 'C++');
    contains(line, 'compiler.c.extra_flags=', 'C');
});

test('upload uses the artifacts the build made, and monitor uses the sketch baud rate', () => {
    equal(uploadArgs('esp32:esp32:esp32', '/dev/ttyACM1').join(' '), `upload --fqbn esp32:esp32:esp32 -p /dev/ttyACM1 --input-dir ${ARDUINO_ARTIFACT_DIR}`, 'upload');
    equal(monitorArgs('/dev/ttyACM1').join(' '), 'monitor -p /dev/ttyACM1 --config baudrate=115200', 'monitor');
});

// ---------------------------------------------------------------------- diagnostics

test('the JSON diagnostics become the Problems the editor already speaks', () => {
    const stdout = JSON.stringify({
        builder_result: {
            diagnostics: [
                {
                    severities: ['ERROR'],
                    message: "'Foo' was not declared in this scope",
                    locations: [{ file: '/p/.arduino/build/sketch/src/ui.cpp', line: 42, column: 7 }],
                },
                { severities: ['NOTE'], message: 'declared here', locations: [{ file: '/p/src/ui.h', line: 3, column: 1 }] },
                { severities: ['WARNING'], message: 'unused variable', locations: [{ file: '/p/src/ui.cpp', line: 9, column: 2 }] },
            ],
        },
    });
    const found = parseCompileJson(stdout);
    equal(found.length, 2, 'the error and the warning; a note has nowhere to go on this pane');
    equal(found[0].severity, 'error', 'error');
    equal(found[0].line, 42, 'with its line');
    equal(found[1].severity, 'warning', 'warning');
});

test('anything that is not that JSON yields no diagnostics rather than an exception', () => {
    equal(parseCompileJson('not json').length, 0, 'garbage');
    equal(parseCompileJson('{}').length, 0, 'an object with nothing in it');
    equal(parseCompileJson(JSON.stringify({ builder_result: { diagnostics: [] } })).length, 0, 'an empty list');
});

test('gcc\'s own text is the fallback, because the linker and picotool only speak text', () => {
    const text = [
        '/p/src/ui.cpp:12:5: error: expected \';\' before \'}\' token',
        '                 ^',
        '/p/src/ui.cpp:20:1: warning: control reaches end of non-void function',
        '/p/src/ui.cpp:21:1: note: this note is not an error',
    ].join('\n');
    const found = parseGccText(text);
    equal(found.length, 2, 'one error and one warning');
    equal(found[0].file, '/p/src/ui.cpp', 'the file');
    equal(found[0].line, 12, 'the line');
    equal(found[0].column, 5, 'the column');
    equal(found[1].severity, 'warning', 'warnings are kept');
});

test('the same error reported twice is one problem, not two', () => {
    const stdout = JSON.stringify({
        builder_result: {
            diagnostics: [
                { severities: ['ERROR'], message: 'boom', locations: [{ file: '/p/src/a.cpp', line: 4, column: 2 }] },
            ],
        },
    });
    const stderr = '/p/src/a.cpp:4:2: error: boom';
    equal(collectDiagnostics(stdout, stderr).length, 1, 'deduplicated');
});

test('a diagnostic about the compiled copy is moved back to the project file', () => {
    const project = '/home/me/sketch';
    equal(
        projectPathOf(`${project}/.arduino/build/sketch/src/ui.cpp`, project),
        `${project}/src/ui.cpp`,
        'the copy becomes the real file',
    );
    equal(projectPathOf(`${project}/src/ui.cpp`, project), `${project}/src/ui.cpp`, 'a real path is left alone');
    equal(
        projectPathOf('/home/niel/.arduino15/packages/x/y/core.cpp', project),
        '/home/niel/.arduino15/packages/x/y/core.cpp',
        'and so is a core file, which is somebody else\'s source',
    );
});

test('the one line worth quoting from a failed run is the last one', () => {
    equal(lastLineOf('a\n\nb  \n'), 'b', 'trimmed');
    equal(lastLineOf(''), '', 'nothing to say');
});

// ------------------------------------------------------------------------- toolchain

test('the installed cores are read from the CLI\'s JSON', () => {
    const cores = parseCoreList(
        JSON.stringify({ platforms: [{ id: 'rp2040:rp2040', installed: '6.3.1' }, { id: 'esp32:esp32', installed_version: '3.3.12' }, { id: 'nope' }] }),
    );
    equal(cores.length, 2, 'two usable entries');
    equal(cores[0].id, 'rp2040:rp2040', 'with its id');
    equal(cores[1].version, '3.3.12', 'and its version, whichever field the CLI used');
    equal(coreIdFor('rp2040:rp2040:rpipico2w'), 'rp2040:rp2040', 'an FQBN yields its core');
    ok(hasCoreFor({ cores }, 'rp2040:rp2040:rpipico2w'), 'and a board is buildable when its core is there');
    ok(!hasCoreFor({ cores }, 'esp32:esp32:esp32s3') === false, 'the esp32 core is there too');
    ok(!hasCoreFor({ cores: [] }, 'rp2040:rp2040:rpipico'), 'nothing installed means nothing buildable');
});

test('the ports are the ones the CLI can talk to, with the board it recognised', () => {
    const ports = parseBoardList(
        JSON.stringify({
            detected_ports: [
                { address: '/dev/ttyACM1', protocol: 'serial', label: 'ttyACM1', boards: [{ name: 'Raspberry Pi Pico 2W', fqbn: 'rp2040:rp2040:rpipico2w' }] },
                { address: '192.168.1.9', protocol: 'network', label: 'esp' },
                { address: '/dev/ttyS0', label: 'a port with no discovery tool' },
            ],
        }),
    );
    equal(ports.length, 2, 'the serial one and the network one');
    equal(ports[0].label, 'Raspberry Pi Pico 2W', 'named by the board when the CLI knows it');
    equal(ports[0].fqbn, 'rp2040:rp2040:rpipico2w', 'with the FQBN');
    equal(ports[1].label, 'esp', 'or by its own label when it does not');
    equal(parseBoardList('nonsense').length, 0, 'and garbage is no ports, not a crash');
});

test('the CLI path can be named by a setting, and an empty one falls back to detection', () => {
    // No editor here: the module takes the configured value as an argument, which is what keeps it testable.
    equal(arduinoCliPath('/definitely/not/here'), undefined, 'an explicit path that is not there is not a guess');
    // Whether a PATH lookup finds anything is the machine's business; what matters is that it does not throw.
    ok(arduinoCliPath() === undefined || arduinoCliPath().endsWith('arduino-cli'), 'and detection still works');
});

// ------------------------------------------------------- the command wrapper

test('the shared command wrapper does not refuse a sketch before its own code runs', () => {
    // The trap this pins, found on the bench 2026-10-31: the wrapper ran *before* every command body, so a
    // refusal there made Build/Flash/Monitor unreachable on a sketch while their arduino-cli implementations sat
    // inside `run` below it -- and every button reported the same wrong-route warning.
    const fs = require('fs');
    const path = require('path');
    const wrapper = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'out', 'commands', 'withProject.js'), 'utf8');
    contains(wrapper, "project.language === 'rust' && purpose", 'the toolchain check is for Rust only');
    notContains(wrapper, 'That command is the Rust route', 'and nothing refuses on the way in');
});

test('Clean removes the output instead of asking arduino-cli to clean and rebuild', () => {
    // `arduino-cli compile --clean` means *clean, then compile* -- and it was run without the LVGL build
    // properties, so it stopped on lv_conf.h while a plain Build worked (bench, 2026-10-31). An editor's Clean
    // has to be the cargo-shaped one: take the output away and stop.
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
        path.join(__dirname, '..', '..', '..', 'src', 'commands', 'arduinoCommands.ts'),
        'utf8',
    );
    const clean = source.slice(source.indexOf('export async function arduinoClean'));
    notContains(clean, '--clean', 'no arduino-cli clean, which would rebuild as well');
    notContains(clean, 'runInTerminal', 'and nothing to watch in a terminal');
    contains(clean, 'ARDUINO_ARTIFACT_DIR', 'the artifacts Upload uses');
    contains(clean, 'ARDUINO_BUILD_DIR', 'and arduino-cli\'s own objects');
});
