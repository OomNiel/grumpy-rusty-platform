'use strict';

/**
 * "Does the chip hold the build this session will use?"
 *
 * The check exists because an attach session cannot repair a mismatch and fails silently. Its verdict
 * comes from `probe-rs verify`'s *output text*, never its exit code: probe-rs 0.32.0 exits 0 for a
 * failed verification too (measured on the bench 2026-10-03). The two lines below are copied from real
 * runs, so a probe-rs that changes them fails here instead of in the field.
 */

const { test, ok, equal, contains, notContains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const {
    classifyVerifyOutput,
    flashingChoice,
    mismatchMessage,
    needsChipCheck,
    verifyArgs,
    FLASH_THEN_DEBUG,
    DEBUG_ANYWAY,
} = compiled('project/chipCheck');
const { debugConfigurationChoices } = compiled('project/launchConfig');
const { generateProjectFiles } = compiled('generate/files');
const { BOARDS } = compiled('boards/catalog');
const { rpBoards } = require('../../lib/boards');

/** Copied verbatim from `probe-rs verify` runs on the bench, 2026-10-03. */
const SUCCESSFUL = 'Reading 1527808 bytes from 0x10000000\nVerification successful\n';
const FAILED = 'Reading 1527808 bytes from 0x10000000\nVerification failed: contents do not match\n';

test('a successful verify is read from the words, never the exit code', () => {
    const result = classifyVerifyOutput(SUCCESSFUL, '');
    equal(result.verdict, 'match');
    contains(result.reason, 'matches');
});

test('a failed verify is a mismatch, and the reason is probe-rs own words', () => {
    const result = classifyVerifyOutput(FAILED, '');
    equal(result.verdict, 'mismatch');
    contains(result.reason, 'contents do not match');
});

test('anything that is not a verdict is unknown, with its reason kept', () => {
    const noProbe = classifyVerifyOutput('', 'Error: Failed to open the probe: no probe was found\n');
    equal(noProbe.verdict, 'unknown');
    contains(noProbe.reason, 'no probe was found', 'the user needs to know why the check did not happen');

    // A timeout kills the process before it prints a verdict; that must not read as "mismatch".
    const timedOut = classifyVerifyOutput('Reading 1527808 bytes from 0x10000000\n', '');
    equal(timedOut.verdict, 'unknown');

    const silent = classifyVerifyOutput('', '');
    equal(silent.verdict, 'unknown');
    ok(silent.reason.length > 0, 'even silence has to say something');
});

test('the verify command is repeatable and never interactive', () => {
    const binary = '/p/target/thumbv8m.main-none-eabihf/debug/my-app';
    const args = verifyArgs('RP235x', binary);
    equal(args[0], 'verify');
    contains(args.join(' '), '--chip RP235x');
    contains(args.join(' '), '--non-interactive', 'it must never wait for an answer');
    contains(args.join(' '), '--disable-progressbars', 'progress bars would muddy the verdict');
    equal(args[args.length - 1], binary, 'the file to compare comes last');

    // No chip named anywhere: let probe-rs guess rather than pass an empty argument value.
    ok(!verifyArgs(undefined, 'app').includes('--chip'));
    ok(!verifyArgs('   ', 'app').includes('--chip'));
});

test('only an RP configuration that does not flash needs the check', () => {
    for (const board of rpBoards()) {
        const file = generateProjectFiles({ board, projectName: 'my-blinky', template: 'blinky' }).find(
            (candidate) => candidate.path === '.vscode/launch.json',
        );
        ok(file, 'the generator must produce .vscode/launch.json');
        const choices = debugConfigurationChoices(file.content);

        const checked = choices.filter(needsChipCheck);
        equal(checked.length, 2, `${board.id}: both no-flash entries have to be verified`);
        for (const choice of checked) {
            equal(choice.flashing, false);
            ok(typeof choice.binary === 'string' && choice.binary.length > 0, 'the check needs a file name');
            contains(choice.binary, '/debug/', 'and it must be the build the Debug button makes');
        }
        for (const choice of choices.filter((candidate) => !needsChipCheck(candidate))) {
            ok(choice.flashing, 'a flashing configuration writes the build it debugs');
        }

        // The one-click repair has to exist for a generated project.
        ok(flashingChoice(choices), `${board.id}: need a configuration that can flash instead`);
    }

    equal(flashingChoice([]), undefined, 'nothing to fall back on is not a crash');
});

test('the mismatch dialog names the file and offers a way out', () => {
    const message = mismatchMessage(
        'target/thumbv8m.main-none-eabihf/debug/my-app',
        'Verification failed: contents do not match',
        true,
    );
    contains(message, 'debug/my-app', 'the user has to see which file was compared');
    contains(message, 'contents do not match', 'and what probe-rs said');
    contains(message, FLASH_THEN_DEBUG);
    contains(message, DEBUG_ANYWAY);

    // A hand-written launch.json may have nothing that flashes; do not offer a button that cannot work.
    const noFallback = mismatchMessage(undefined, 'Verification failed: contents do not match', false);
    notContains(noFallback, FLASH_THEN_DEBUG);
    contains(noFallback, DEBUG_ANYWAY);
});
