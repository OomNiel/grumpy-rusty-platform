'use strict';

/**
 * Reading the project's `.vscode/launch.json`.
 *
 * The Debug button starts whatever probe-rs configuration it finds there, so this has to be
 * right for the file the generator actually writes — and tolerant of the comments people add,
 * because `launch.json` is jsonc and `JSON.parse` would fail on them.
 */

const { test, ok, equal, notOk, contains } = require('../../lib/harness');
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

// --------------------------------------------------- checked against the debugger's own schema
//
// Copied from `probe-rs.probe-rs-debugger-0.32.0`'s package.json on 2026-10-17, trimmed to the
// properties this generator uses (plus a couple of neighbours, so "known key" is not a special
// case). The real check reads the *installed* extension at run time; this copy is what proves the
// validator does something sensible with such a schema at all.

const fs = require('fs');
const nodePath = require('path');
const {
    debuggerSchemaOf,
    validateLaunchConfiguration,
    launchConfigProblems,
    configurationNames,
    onlyGeneratedConfigurations,
    closestSchemaKey,
    probeRsConfigurationCount,
    PROBE_RS_DEBUG_TYPE,
} = compiled('project/launchConfig');

const PROBE_RS_PACKAGE_JSON = {
    name: 'probe-rs-debugger',
    contributes: {
        debuggers: [
            {
                type: 'probe-rs-debug',
                configurationAttributes: {
                    launch: {
                        required: ['chip', 'coreConfigs'],
                        properties: {
                            cwd: {},
                            chip: {},
                            chipDescriptionPath: {},
                            speed: {},
                            flashingConfig: {
                                properties: {
                                    flashingEnabled: {},
                                    haltAfterReset: {},
                                    verifyAfterFlashing: {},
                                },
                            },
                            coreConfigs: {
                                type: 'array',
                                items: {
                                    required: ['programBinary'],
                                    properties: {
                                        coreIndex: {},
                                        programBinary: {},
                                        rttEnabled: {},
                                        svdFile: {},
                                    },
                                },
                            },
                        },
                    },
                    attach: {
                        required: ['chip', 'coreConfigs'],
                        properties: {
                            cwd: {},
                            chip: {},
                            chipDescriptionPath: {},
                            coreConfigs: {
                                type: 'array',
                                items: {
                                    required: ['programBinary'],
                                    properties: { coreIndex: {}, programBinary: {}, rttEnabled: {}, svdFile: {} },
                                },
                            },
                        },
                    },
                },
            },
        ],
    },
};

const REAL_SCHEMA = debuggerSchemaOf(PROBE_RS_PACKAGE_JSON);

test('the schema is read from a debugger extension package.json', () => {
    ok(REAL_SCHEMA, 'a debugger with configurationAttributes should produce a schema');
    equal(REAL_SCHEMA.type, PROBE_RS_DEBUG_TYPE);
    equal(Object.keys(REAL_SCHEMA.requests).sort().join(','), 'attach,launch');
    equal(REAL_SCHEMA.requests.launch.required.join(','), 'chip,coreConfigs');
    ok(REAL_SCHEMA.requests.launch.properties.flashingConfig.properties.flashingEnabled, 'nested properties survive');
    ok(REAL_SCHEMA.requests.launch.properties.coreConfigs.items.required.includes('programBinary'), 'items schema survives');
});

test('a package.json with no usable debugger contributes nothing rather than throwing', () => {
    equal(debuggerSchemaOf(undefined), undefined, 'an absent manifest');
    equal(debuggerSchemaOf({}), undefined, 'a manifest without contributes');
    equal(debuggerSchemaOf({ contributes: { debuggers: [] } }), undefined, 'no debuggers');
    equal(
        debuggerSchemaOf({ contributes: { debuggers: [{ type: 'other' }] } }),
        undefined,
        'a debugger of another type',
    );
});

test('every generated RP launch.json validates clean against the debugger schema', () => {
    // The point of the check: a key this generator writes that the debugger does not declare would
    // be ignored silently, and the session would then do something other than the file says.
    for (const board of rpBoards()) {
        const problems = launchConfigProblems(launchJsonFor(board.id), REAL_SCHEMA);
        equal(problems.length, 0, `${board.id}: ${problems.join(' | ')}`);
    }
});

test('a key the debugger does not declare is reported, with the likely intended one', () => {
    const configuration = {
        type: 'probe-rs-debug',
        request: 'launch',
        name: 'Mine',
        chip: 'RP235x',
        flashConfig: { flashingEnabled: true },
        coreConfigs: [{ coreIndex: 0, programBinary: 'target/x/debug/y' }],
    };
    const problems = validateLaunchConfiguration(configuration, REAL_SCHEMA);
    equal(problems.length, 1, problems.join(' | '));
    contains(problems[0], 'flashConfig');
    contains(problems[0], 'flashingConfig');
});

test('a renamed key inside coreConfigs is reported too', () => {
    const configuration = {
        type: 'probe-rs-debug',
        request: 'launch',
        name: 'Mine',
        chip: 'RP235x',
        coreConfigs: [{ coreIndex: 0, programBinary: 'target/x/debug/y', rttEnabledx: true }],
    };
    const problems = validateLaunchConfiguration(configuration, REAL_SCHEMA);
    equal(problems.length, 1, problems.join(' | '));
    contains(problems[0], 'coreConfigs[0]');
    contains(problems[0], 'rttEnabledx');
    contains(problems[0], 'rttEnabled');
});

test('a required key that is missing is reported', () => {
    const problems = validateLaunchConfiguration(
        { type: 'probe-rs-debug', request: 'launch', name: 'Mine', coreConfigs: [] },
        REAL_SCHEMA,
    );
    equal(problems.length, 1, problems.join(' | '));
    contains(problems[0], '"chip"');
    contains(problems[0], 'required');
});

test('a flashingConfig on an attach configuration is reported -- probe-rs rejects it', () => {
    const configuration = {
        type: 'probe-rs-debug',
        request: 'attach',
        name: 'Attach',
        chip: 'RP235x',
        flashingConfig: { flashingEnabled: true },
        coreConfigs: [{ programBinary: 'target/x/debug/y' }],
    };
    const problems = validateLaunchConfiguration(configuration, REAL_SCHEMA);
    equal(problems.length, 1, problems.join(' | '));
    contains(problems[0], 'flashingConfig');
});

test('an unknown request is reported against the requests the debugger has', () => {
    const problems = validateLaunchConfiguration(
        { type: 'probe-rs-debug', request: 'launch-and-pray', name: 'Mine' },
        REAL_SCHEMA,
    );
    equal(problems.length, 1);
    contains(problems[0], 'launch-and-pray');
    contains(problems[0], 'launch, attach');
});

test('nothing is reported when there is no schema, because nothing could be checked', () => {
    equal(launchConfigProblems(launchJsonFor('pico'), undefined).length, 0);
});

test('jsonc comments do not stop the check from finding the configurations', () => {
    const text = `{
        // probe-rs configuration, hand-edited
        "version": "0.2.0",
        "configurations": [
            {
                "type": "probe-rs-debug",
                "request": "launch",
                "name": "Mine",
                "chip": "RP235x",
                "coreConfigs": [{ "programBinary": "target/x/debug/y" }],
            },
        ],
    }`;
    equal(probeRsConfigurationCount(text), 1);
    equal(launchConfigProblems(text, REAL_SCHEMA).length, 0, 'this one is complete and known');
});

test('regenerating is only offered when the file holds nothing but our own configurations', () => {
    const text = launchJsonFor('pico');
    const names = configurationNames(text);
    equal(names.length, 4, 'the wizard writes four configurations');
    ok(onlyGeneratedConfigurations(text, names), 'a freshly generated file is ours');

    const withExtra = JSON.parse(text);
    withExtra.configurations.push({ type: 'cppdbg', request: 'launch', name: 'My C program' });
    notOk(
        onlyGeneratedConfigurations(JSON.stringify(withExtra), names),
        'a configuration of another debugger type means the file is not only ours',
    );

    const handMade = JSON.parse(text);
    handMade.configurations.push({ type: 'probe-rs-debug', request: 'attach', name: 'Mine' });
    notOk(
        onlyGeneratedConfigurations(JSON.stringify(handMade), names),
        'a probe-rs configuration we did not write is still not ours to overwrite',
    );

    notOk(onlyGeneratedConfigurations('{"version":"0.2.0","configurations":[]}', names), 'an empty file');
    notOk(onlyGeneratedConfigurations('not json', names), 'a file we cannot read');
});

test('closestSchemaKey suggests a rename, and says nothing when there is no near match', () => {
    const known = ['flashingConfig', 'coreConfigs', 'chip', 'cwd'];
    equal(closestSchemaKey('flashConfig', known), 'flashingConfig');
    equal(closestSchemaKey('chiip', known), 'chip');
    equal(closestSchemaKey('zzzzzzzz', known), undefined);
});

test('the check is a declared command, and the Debug command runs it first', () => {
    const root = nodePath.join(__dirname, '../../..');
    const manifest = JSON.parse(fs.readFileSync(nodePath.join(root, 'package.json'), 'utf8'));
    const declared = (manifest.contributes.commands || []).find(
        (command) => command.command === 'rustyPlatform.checkLaunchConfig',
    );
    ok(declared, 'package.json must declare rustyPlatform.checkLaunchConfig');
    contains(declared.category, 'Rusty Platform');

    const source = fs.readFileSync(nodePath.join(root, 'src/commands/debugProject.ts'), 'utf8');
    contains(source, "'rustyPlatform.checkLaunchConfig'", 'the command must be registered');
    contains(source, 'inspectLaunchConfigurations(project)', 'Debug must consult it before running a session');
});
