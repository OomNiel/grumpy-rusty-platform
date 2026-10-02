'use strict';

/**
 * Finding the ELF cargo actually produced. Guessing `target/<triple>/release/<name>` breaks
 * the moment a project sets `CARGO_TARGET_DIR`, a custom `target-dir` or a workspace layout,
 * so the answer is read out of cargo's own JSON stream.
 */

const { test, ok, equal, notOk } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const { parseCargoArtifact, findElfArtifactPath } = compiled('flash/cargoArtifacts');

/** A real `--message-format=json` line for a binary target. */
function artifactLine(overrides = {}) {
    return JSON.stringify({
        reason: 'compiler-artifact',
        package_id: 'path+file:///home/niel/pico#hil-pico2w-blinky@0.1.0',
        manifest_path: '/home/niel/pico/Cargo.toml',
        target: {
            kind: ['bin'],
            crate_types: ['bin'],
            name: 'hil-pico2w-blinky',
            src_path: '/home/niel/pico/src/main.rs',
            edition: '2021',
        },
        profile: { opt_level: '3', debuginfo: 2, debug_assertions: false, overflow_checks: false, test: false },
        features: [],
        filenames: ['/tmp/target/thumbv8m.main-none-eabihf/release/hil-pico2w-blinky'],
        executable: '/tmp/target/thumbv8m.main-none-eabihf/release/hil-pico2w-blinky',
        fresh: false,
        ...overrides,
    });
}

test('a binary artefact yields its executable path', () => {
    const artifact = parseCargoArtifact(artifactLine());
    ok(artifact);
    equal(artifact.executable, '/tmp/target/thumbv8m.main-none-eabihf/release/hil-pico2w-blinky');
    equal(artifact.targetName, 'hil-pico2w-blinky');
});

test('a library artefact is not mistaken for something flashable', () => {
    const artifact = parseCargoArtifact(
        artifactLine({ target: { kind: ['lib'], name: 'embassy-rp' }, executable: null }),
    );
    ok(artifact, 'it is still an artefact');
    notOk(artifact.executable, 'but there is no binary in it');
});

test('everything that is not an artefact message is ignored', () => {
    const noisy = [
        '',
        '   ',
        '   Compiling embassy-rp v0.10.0',
        '{"reason":"build-script-executed","package_id":"x"}',
        '{"reason":"compiler-message","message":{"rendered":"warning: unused variable"}}',
        '{"reason":"build-finished","success":true}',
        'not json at all',
        '{"reason":',
    ];
    for (const line of noisy) {
        notOk(parseCargoArtifact(line), `should ignore: ${line}`);
    }
});

test('the last binary wins, so a rebuild reports the current file', () => {
    const stdout = [
        artifactLine({ executable: '/tmp/old/hil-pico2w-blinky' }),
        '   Compiling something',
        artifactLine({ executable: '/tmp/new/hil-pico2w-blinky' }),
    ].join('\n');
    equal(findElfArtifactPath(stdout), '/tmp/new/hil-pico2w-blinky');
});

test('a stream with no binary artefact reports nothing', () => {
    equal(findElfArtifactPath('{"reason":"build-finished","success":true}'), undefined);
    equal(findElfArtifactPath(''), undefined);
});
