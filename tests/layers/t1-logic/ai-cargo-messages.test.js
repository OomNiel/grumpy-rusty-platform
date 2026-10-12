'use strict';

/**
 * Cargo's own words, turned into data the assistant can act on.
 *
 * The build is the oracle for every repair the assistant offers, and the JSON message stream is where the
 * exact file, line, column and error code live — the pretty-printed output does not carry them. These tests
 * drive the parser with the shapes cargo really emits, including the two things that would make the counts
 * lie: a duplicate message from a second target, and a diagnostic that points into a dependency or `target/`
 * rather than the user's code.
 */

const { test, ok, notOk, equal, contains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const {
    parseCargoMessages,
    parseRustcText,
    parseCargoOutput,
    isProjectSource,
    resolveInProject,
    environmentFailure,
    firstCargoError,
} = compiled('ai/cargoMessages');

const PROJECT = '/proj';

/** One `--message-format=json` line, with only the fields the parser promises. */
function compilerMessage({ message, code, level, spans }) {
    return JSON.stringify({
        reason: 'compiler-message',
        message: { message, code: code ? { code } : null, level, spans },
    });
}

function primarySpan(fileName, line = 1, column = 1) {
    return { file_name: fileName, line_start: line, column_start: column, is_primary: true };
}

test('a primary-span error becomes a diagnostic with file, position, code and severity', () => {
    const line = compilerMessage({
        message: 'cannot find value `x` in this scope',
        code: 'E0425',
        level: 'error',
        spans: [primarySpan('src/main.rs', 12, 5)],
    });
    const { diagnostics, projectErrors, skipped } = parseCargoMessages(line, PROJECT);
    equal(diagnostics, [
        {
            file: '/proj/src/main.rs',
            line: 12,
            column: 5,
            severity: 'error',
            code: 'E0425',
            message: 'cannot find value `x` in this scope',
        },
    ]);
    equal(projectErrors, []);
    equal(skipped, 0);
});

test('a primary-span warning keeps its severity and a fallback span is used when none is primary', () => {
    const warning = compilerMessage({
        message: 'unused variable: `x`',
        code: 'unused_variables',
        level: 'warning',
        spans: [primarySpan('src/main.rs', 3, 9)],
    });
    equal(parseCargoMessages(warning, PROJECT).diagnostics[0].severity, 'warning');

    const noPrimary = compilerMessage({
        message: 'mismatched types',
        code: 'E0308',
        level: 'error',
        spans: [{ file_name: 'src/main.rs', line_start: 7, column_start: 1, is_primary: false }],
    });
    equal(parseCargoMessages(noPrimary, PROJECT).diagnostics[0].line, 7);
});

test('an error with no span is a project error, not a diagnostic', () => {
    const line = compilerMessage({ message: 'aborting due to 1 previous error', code: undefined, level: 'error', spans: [] });
    const { diagnostics, projectErrors } = parseCargoMessages(line, PROJECT);
    equal(diagnostics, []);
    equal(projectErrors, [{ code: '', message: 'aborting due to 1 previous error' }]);
});

test('a diagnostic in target/ or the registry is not one of the project’s own', () => {
    const inTarget = compilerMessage({
        message: 'unused import',
        code: 'unused_imports',
        level: 'warning',
        spans: [primarySpan('target/debug/build/foo/src/lib.rs')],
    });
    const target = parseCargoMessages(inTarget, PROJECT);
    equal(target.diagnostics, []);
    equal(target.skipped, 1, 'a dependency warning is counted, not reported');

    const inRegistry = compilerMessage({
        message: 'trait bound not satisfied',
        code: 'E0277',
        level: 'error',
        spans: [primarySpan('/home/u/.cargo/registry/src/foo/src/lib.rs', 4, 2)],
    });
    const registry = parseCargoMessages(inRegistry, PROJECT);
    equal(registry.diagnostics, []);
    equal(registry.projectErrors.length, 1);
    contains(registry.projectErrors[0].message, '/home/u/.cargo/registry/src/foo/src/lib.rs');
});

test('duplicate messages from a second target are counted once', () => {
    const line = compilerMessage({
        message: 'cannot find value `x` in this scope',
        code: 'E0425',
        level: 'error',
        spans: [primarySpan('src/main.rs', 12, 5)],
    });
    const out = parseCargoMessages(`${line}\n${line}`, PROJECT);
    equal(out.diagnostics.length, 1);
    equal(out.skipped, 1);
});

test('non-JSON, non-compiler and other-reason lines are ignored', () => {
    const text = ['Compiling firmware v0.1.0', '{"reason":"build-finished","success":true}', '', 'not json at all'].join('\n');
    equal(parseCargoMessages(text, PROJECT), { diagnostics: [], projectErrors: [], skipped: 0 });
});

test('parseRustcText reads a located error and a located warning', () => {
    const located = parseRustcText('src/main.rs:12:5: error[E0425]: cannot find value `x` in this scope', PROJECT);
    equal(located.diagnostics, [
        {
            file: '/proj/src/main.rs',
            line: 12,
            column: 5,
            severity: 'error',
            code: 'E0425',
            message: 'cannot find value `x` in this scope',
        },
    ]);
    equal(located.projectErrors, []);

    const warning = parseRustcText('src/lib.rs:2:1: warning: unused variable: `y`', PROJECT);
    equal(warning.diagnostics[0].severity, 'warning');
    equal(warning.diagnostics[0].code, '');
});

test('parseRustcText drops a located line outside the project and reads a bare cargo error', () => {
    equal(parseRustcText('target/debug/x.rs:1:1: error: boom', PROJECT).diagnostics, []);
    const bare = parseRustcText('error: could not compile `firmware` (bin "firmware")', PROJECT);
    equal(bare.projectErrors, [{ code: '', message: 'could not compile `firmware` (bin "firmware")' }]);
});

test('parseCargoOutput merges the JSON and text parsers without double-counting', () => {
    const json = compilerMessage({
        message: 'cannot find value `x` in this scope',
        code: 'E0425',
        level: 'error',
        spans: [primarySpan('src/main.rs', 12, 5)],
    });
    const plain = 'src/main.rs:12:5: error[E0425]: cannot find value `x` in this scope';
    const merged = parseCargoOutput([json, plain].join('\n'), PROJECT);
    equal(merged.diagnostics.length, 1);
    equal(merged.diagnostics[0].code, 'E0425');

    const jsonNoSpan = compilerMessage({ message: 'could not compile `firmware`', code: undefined, level: 'error', spans: [] });
    const plainNoSpan = 'error: could not compile `firmware`';
    const mergedErrors = parseCargoOutput([jsonNoSpan, plainNoSpan].join('\n'), PROJECT);
    equal(mergedErrors.projectErrors, [{ code: '', message: 'could not compile `firmware`' }]);
});

test('isProjectSource keeps the project in and dependencies and target/ out', () => {
    ok(isProjectSource('/proj/src/main.rs', PROJECT));
    ok(isProjectSource('src/main.rs', PROJECT));
    notOk(isProjectSource('/proj/target/debug/x.rs', PROJECT));
    notOk(isProjectSource('/proj/.git/x', PROJECT));
    notOk(isProjectSource('/elsewhere/x.rs', PROJECT));
});

test('resolveInProject joins relative names and leaves absolute ones alone', () => {
    equal(resolveInProject('/proj', 'src/main.rs'), '/proj/src/main.rs');
    equal(resolveInProject('/proj///', 'src/main.rs'), '/proj/src/main.rs');
    equal(resolveInProject('/proj', '/abs/x.rs'), '/abs/x.rs');
    equal(resolveInProject('/proj', 'C:\\src\\main.rs'), 'C:/src/main.rs');
});

test('firstCargoError picks the first error line out of cargo output', () => {
    equal(
        firstCargoError('   Compiling firmware v0.1.0\n  error[E0425]: cannot find value `x`\nerror: could not compile `firmware`'),
        'error[E0425]: cannot find value `x`',
    );
    equal(firstCargoError('Finished dev profile'), undefined);
});

// A build that died before the compiler looked at any code is not something a fixer can help with, and cargo's
// own line for it (`error: failed to run custom build command for …`) blames the project for an environment
// problem. This is the real stderr from an ESP project built without espup's environment (2026-10-12).
test('a build that never reached the code says so, and says what to do', () => {
    const stderr = [
        '',
        'Caused by:',
        '  process didn\'t exit successfully: `.../build-script-build` (exit status: 101)',
        '  --- stderr',
        '  thread \'main\' panicked at build.rs:36:9:',
        '  Xtensa linker `xtensa-esp32-elf-gcc` was not found on PATH.',
        '',
        'error: failed to run custom build command for `testv69 v0.1.0`',
        '',
    ].join('\n');
    const why = environmentFailure(stderr);
    ok(why !== undefined, 'an unbuildable environment is named as one');
    contains(why, 'Xtensa', 'naming the linker');
    contains(why, 'not a code error', 'and saying there is nothing in the code to fix');
    contains(why, 'ESP Toolchain', 'with the action that fixes it');

    // A normal compiler error is not an environment failure, and neither is silence.
    equal(environmentFailure('error[E0425]: cannot find value `x` in this scope'), undefined);
    equal(environmentFailure(''), undefined);
});
