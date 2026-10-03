'use strict';

/**
 * Reading the project's `.vscode/launch.json`.
 *
 * The Debug button starts whatever probe-rs configuration it finds there, so this has to be
 * right for the file the generator actually writes — and tolerant of the comments people add,
 * because `launch.json` is jsonc and `JSON.parse` would fail on them.
 */

const { test, ok, equal, contains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const { parseJsonc, findProbeRsDebugConfiguration, debugConfigurationChoices, debugPickerItems, profileMismatch, pickProbeRsSession, PROBE_RS_DEBUGGER_EXTENSION } = compiled('project/launchConfig');
const { generateProjectFiles } = compiled('generate/files');
const { BOARDS } = compiled('boards/catalog');
const { rpBoards } = require('../../lib/boards');

function launchJsonFor(boardId) {
    const board = BOARDS.find((candidate) => candidate.id === boardId);
    ok(board, `unknown board ${boardId}`);
    const file = generateProjectFiles({ board, projectName: 'my-blinky', template: 'blinky' }).find(
        (candidate) => candidate.path === '.vscode/launch.json',
    );
    ok(file, 'the generator must produce .vscode/launch.json');
    return file.content;
}

test('every generated RP launch.json has a probe-rs configuration we can find', () => {
    for (const board of rpBoards()) {
        const configuration = findProbeRsDebugConfiguration(launchJsonFor(board.id));
        ok(configuration, `${board.id} should expose a debug configuration`);
        equal(configuration.type, 'probe-rs-debug');
        includesBoardFamily(configuration.name, board.family);
    }
});

function includesBoardFamily(name, family) {
    ok(name.includes(family), `"${name}" should name the chip family ${family}`);
}

test('the found configuration is the one the debugger needs', () => {
    const configuration = findProbeRsDebugConfiguration(launchJsonFor('pico2w'));
    equal(configuration.name, 'Flash & Debug (RP2350)');
});

test('comments and trailing commas do not stop us, because launch.json is jsonc', () => {
    const text = `{
    // the generator's configuration
    "version": "0.2.0",
    "configurations": [
        {
            /* leading block comment */
            "type": "probe-rs-debug",
            "request": "launch",
            "name": "Flash & Debug (RP2350)",
            "chip": "RP235x", // trailing comment
        },
    ],
}`;
    const configuration = findProbeRsDebugConfiguration(text);
    ok(configuration);
    equal(configuration.name, 'Flash & Debug (RP2350)');
});

test('comment markers inside strings are left alone', () => {
    const parsed = parseJsonc('{ "path": "a//b", "url": "https://example.invalid/*x*/", "n": 1 }');
    equal(parsed.path, 'a//b');
    equal(parsed.url, 'https://example.invalid/*x*/');
    equal(parsed.n, 1);
});

test('a different debugger type is not mistaken for probe-rs', () => {
    const text = `{
    "configurations": [
        { "type": "cortex-debug", "name": "Cortex Debug", "request": "launch" },
        { "type": "probe-rs-debug", "name": "Flash & Debug (RP2040)", "request": "launch" }
    ]
}`;
    equal(findProbeRsDebugConfiguration(text).name, 'Flash & Debug (RP2040)');
});

test('broken or unexpected files report "nothing found" instead of throwing', () => {
    equal(findProbeRsDebugConfiguration('{ this is not json'), undefined);
    equal(findProbeRsDebugConfiguration(''), undefined);
    equal(findProbeRsDebugConfiguration('{}'), undefined);
    equal(findProbeRsDebugConfiguration('{ "configurations": [] }'), undefined);
    equal(findProbeRsDebugConfiguration('{ "configurations": "nope" }'), undefined);
    equal(findProbeRsDebugConfiguration('{ "configurations": [ { "type": "probe-rs-debug" } ] }'), undefined, 'a configuration without a name cannot be started');
});

test('the required extension id is the one the marketplace uses', () => {
    equal(PROBE_RS_DEBUGGER_EXTENSION, 'probe-rs.probe-rs-debugger');
    contains(PROBE_RS_DEBUGGER_EXTENSION, '.');
});

test('the stop action targets a probe-rs session, never somebody else\'s', () => {
    const probeRs = { type: 'probe-rs-debug', name: 'Flash & Debug (RP2350)' };
    const python = { type: 'python', name: 'Python: Current File' };

    equal(pickProbeRsSession([probeRs], probeRs), probeRs, 'the active probe-rs session wins');
    equal(
        pickProbeRsSession([probeRs, python], python),
        probeRs,
        'with another debugger focused, our session is still the one to stop',
    );
    equal(pickProbeRsSession([], undefined), undefined, 'nothing running, nothing to stop');
    equal(pickProbeRsSession([python], python), undefined, 'a Python session is not ours to kill');
});

test('any future probe-rs-* session type is recognised', () => {
    const future = { type: 'probe-rs-remote', name: 'remote' };
    equal(pickProbeRsSession([future], undefined), future);
});

test('the picker offers every generated configuration with a truthful description', () => {
    for (const board of rpBoards()) {
        const choices = debugConfigurationChoices(launchJsonFor(board.id));
        equal(choices.length, 4, `${board.id}: expected four configurations`);

        const [flashAndRun, halt, restart, attach] = choices;
        contains(flashAndRun.detail, 'flashes', 'the first choice flashes');
        contains(flashAndRun.detail, 'breakpoints', 'and stops at your breakpoints');
        contains(halt.detail, 'halt', 'the second choice halts on the reset vector');

        // Debugging always uses the debug build, whichever configuration is picked.
        for (const choice of choices) {
            equal(choice.profile, 'debug', `${choice.name} must debug the debug build`);
        }

        // The two no-flash entries are not interchangeable, and the picker has to say why.
        for (const choice of [restart, attach]) {
            equal(choice.flashing, false, 'neither of these writes the chip');
            contains(choice.detail, 'no flashing', 'and both say so');
            ok(!choice.detail.includes('flashes'), 'without implying otherwise');
        }
        contains(restart.detail, 'reset', 'the restart entry resets the chip');
        contains(restart.detail, 'bind anywhere', 'which is why breakpoints work everywhere');
        contains(attach.detail, 'runs again', 'the attach entry must warn that only repeated code can stop');
        ok(!attach.detail.includes('bind anywhere'), 'and must not promise what it cannot do');

        const details = new Set(choices.map((choice) => choice.detail));
        equal(details.size, 4, 'four choices are useless if they read the same');
    }
});

test('the picker says which build the chip holds', () => {
    const launch = launchJsonFor('pico2w');
    const attachIn = (profile) => debugPickerItems(launch, profile).find((item) => !item.choice.flashing);

    const matches = attachIn('debug');
    ok(matches, 'the attach entry should be in the picker');
    equal(matches.description, 'matches the last flash');

    // The Flash button leaves a release image, which no debug configuration can use.
    const mismatch = attachIn('release');
    equal(mismatch.description, 'the chip holds the release build');
    ok(profileMismatch(mismatch.choice, 'release'), 'a release image cannot carry debug symbols');
    ok(!profileMismatch(mismatch.choice, 'debug'));
    ok(!profileMismatch(mismatch.choice, undefined), 'unknown is not a mismatch to warn about');
    ok(debugPickerItems(launch, undefined).every((item) => item.description === undefined));
});

test('a hand-written release attach is described honestly', () => {
    // Nothing generated points at a release build any more, but a hand-written file might.
    const text = JSON.stringify({
        version: '0.2.0',
        configurations: [
            {
                type: 'probe-rs-debug',
                request: 'attach',
                name: 'Attach release',
                chip: 'RP235x',
                coreConfigs: [{ programBinary: 'target/thumbv8m.main-none-eabihf/release/app' }],
            },
        ],
    });
    const [choice] = debugConfigurationChoices(text);
    equal(choice.profile, 'release');
    contains(choice.detail, 'optimised', 'a release attach must warn that some breakpoints cannot bind');
});

test('a configuration without flashingConfig is described as not flashing', () => {
    // That is probe-rs-debugger's default, and the reason a session used to attach to a stale image.
    const text = JSON.stringify({
        version: '0.2.0',
        configurations: [
            { type: 'probe-rs-debug', request: 'launch', name: 'Old style', chip: 'RP235x' },
            { type: 'cppdbg', name: 'not ours' },
        ],
    });
    const choices = debugConfigurationChoices(text);
    equal(choices.length, 1, 'only probe-rs configurations belong in the picker');
    equal(choices[0].name, 'Old style');
    contains(choices[0].detail, 'no flashing');
});

test('jsonc comments do not hide a configuration from the picker', () => {
    const text = `{
        // written by hand
        "configurations": [
            { "type": "probe-rs-debug", "request": "attach", "name": "Attach", },
        ],
    }`;
    const choices = debugConfigurationChoices(text);
    equal(choices.length, 1);
    contains(choices[0].detail, 'no flashing');
});
