'use strict';

/**
 * The Cargo.toml dependency editor.
 *
 * This module writes into a file the user owns, so most of these tests are about what it
 * must NOT do: move other lines, drop comments, lose keys it does not understand, or change
 * a version the project already pins. The inputs are the projects the generator really
 * produces, not hand-written fixtures.
 */

const { test, ok, equal, notOk, contains, notContains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const { parseCargoToml, applyDependency, formatDependencyLine, findDependency } = compiled('library/cargoToml');
const { generateProjectFiles, templatesFor } = compiled('generate/files');
const { BOARDS } = compiled('boards/catalog');

function board(id) {
    const found = BOARDS.find((candidate) => candidate.id === id);
    ok(found, `unknown board ${id}`);
    return found;
}

/** The real generated Cargo.toml for a board/template combination. */
function generatedCargoToml(boardId, template) {
    const files = generateProjectFiles({ board: board(boardId), projectName: 'demo-project', template });
    const file = files.find((candidate) => candidate.path === 'Cargo.toml');
    ok(file, 'the generator must produce a Cargo.toml');
    return file.content;
}

const WIRED = generatedCargoToml('pico', 'blinky');
const WIRELESS = generatedCargoToml('pico2w', 'wifi');
const BLUETOOTH = generatedCargoToml('pico2w', 'wifi-bluetooth');

test('the generated dependency table parses, for every board and template', () => {
    for (const profile of BOARDS) {
        // Ask the generator which templates exist rather than assuming an RP-shaped list.
        for (const info of templatesFor(profile)) {
            const model = parseCargoToml(generatedCargoToml(profile.id, info.id));
            const names = model.dependencies.map((dependency) => dependency.name);
            const expected =
                profile.kind === 'rp'
                    ? ['embassy-executor', 'embassy-time', 'embassy-rp', 'defmt', 'defmt-rtt', 'panic-probe']
                    : [
                        'esp-hal',
                        'esp-rtos',
                        'esp-bootloader-esp-idf',
                        'esp-println',
                        'esp-backtrace',
                        'embassy-executor',
                        'embassy-time',
                        'log',
                    ];
            for (const name of expected) {
                ok(names.includes(name), `${profile.id}/${info.id} should list ${name}`);
            }
            if (profile.kind === 'esp') {
                notOk(names.includes('embassy-rp'), 'an ESP project must not pull in embassy-rp');
                notOk(names.includes('defmt-rtt'), 'ESP logs over USB serial, not RTT');
            }
            ok(model.dependenciesHeaderLine !== undefined, `${profile.id}/${info.id} has a [dependencies] table`);
        }
    }
});

test('only the dependency table contributes entries', () => {
    const model = parseCargoToml(WIRED);
    const names = model.dependencies.map((dependency) => dependency.name);
    for (const notADependency of ['package', 'dependencies', 'profile.release', 'release']) {
        notOk(names.includes(notADependency), `"${notADependency}" is a section, not a dependency`);
    }
    for (const dependency of model.dependencies) {
        ok(dependency.startLine > model.dependenciesHeaderLine, `${dependency.name} must sit inside the table`);
    }
});

test('a commented-out dependency is not a dependency', () => {
    const names = parseCargoToml(BLUETOOTH).dependencies.map((dependency) => dependency.name);
    notOk(
        names.includes('trouble-host'),
        'the Bluetooth entry is commented out in the generated file, and must stay that way',
    );
});

test('plain and table forms are both read with their features', () => {
    const model = parseCargoToml(WIRELESS);
    const defmt = findDependency(model, 'defmt');
    equal(defmt.form, 'plain');
    equal(defmt.version, '1.1');

    const embassy = findDependency(model, 'embassy-rp');
    equal(embassy.form, 'table');
    ok(embassy.features.includes('rp235xa'), 'embassy-rp carries its silicon features');
    ok(embassy.features.includes('binary-info'));
});

test('adding a dependency inserts exactly one line, inside the table', () => {
    const outcome = applyDependency(WIRED, { name: 'embassy-sync', version: '0.8.0', features: ['defmt'] });
    ok(outcome.ok, outcome.ok ? '' : outcome.reason);
    equal(outcome.action, 'added');
    equal(outcome.line, 'embassy-sync = { version = "0.8.0", features = ["defmt"] }');

    const before = WIRED.split('\n');
    const after = outcome.text.split('\n');
    equal(after.length, before.length + 1, 'one line was added');

    const inserted = after.indexOf(outcome.line);
    ok(inserted > 0, 'the new line is in the file');
    const restored = [...after.slice(0, inserted), ...after.slice(inserted + 1)].join('\n');
    equal(restored, WIRED, 'every other byte of the file is untouched');
    ok(inserted < after.indexOf('[profile.release]'), 'it lands in [dependencies], before the profile');
});

test('the generated comments survive a write', () => {
    const outcome = applyDependency(WIRELESS, { name: 'heapless', version: '0.9.3', features: ['defmt'] });
    ok(outcome.ok);
    contains(outcome.text, '# CYW43 Wi-Fi/Bluetooth chip, driven over PIO SPI.');
    contains(outcome.text, '# so portable-atomic provides one via critical-section');
    contains(outcome.text, 'portable-atomic = { version = "1.5", features = ["critical-section"] }');
});

test('a commented-out dependency stays commented out after a write', () => {
    // The Bluetooth entry is deliberately left commented in the generated file (NOTES.md 9).
    const outcome = applyDependency(BLUETOOTH, { name: 'heapless', version: '0.9.3', features: ['defmt'] });
    ok(outcome.ok);
    contains(outcome.text, '# trouble-host = ');
    notOk(parseCargoToml(outcome.text).dependencies.some((dependency) => dependency.name === 'trouble-host'));
});

test('the written file still parses and holds the new entry', () => {
    const outcome = applyDependency(WIRELESS, { name: 'heapless', version: '0.9.3', features: ['defmt', 'serde'] });
    const model = parseCargoToml(outcome.text);
    const added = findDependency(model, 'heapless');
    equal(added.version, '0.9.3');
    equal(added.features, ['defmt', 'serde']);
    equal(model.dependencies.length, parseCargoToml(WIRELESS).dependencies.length + 1);
});

test('updating a plain entry rewrites that line only', () => {
    const outcome = applyDependency(WIRED, { name: 'defmt', version: '1.1.1', features: ['alloc'] });
    ok(outcome.ok);
    equal(outcome.action, 'updated');
    equal(outcome.line, 'defmt = { version = "1.1.1", features = ["alloc"] }');
    equal(outcome.previous, 'defmt = "1.1"');
    equal(outcome.text.split('\n').length, WIRED.split('\n').length, 'no line was added or lost');
    equal(findDependency(parseCargoToml(outcome.text), 'defmt').features, ['alloc']);
});

test('updating a table entry keeps the keys this editor does not own', () => {
    const source = [
        '[package]',
        'name = "x"',
        '',
        '[dependencies]',
        'foo = { git = "https://example.invalid/f.git", features = ["old"], optional = true }',
        '',
    ].join('\n');

    const outcome = applyDependency(source, { name: 'foo', version: '1.2.3', features: ['new'] });
    ok(outcome.ok);
    equal(
        outcome.line,
        'foo = { version = "1.2.3", features = ["new"], git = "https://example.invalid/f.git", optional = true }',
    );
    contains(outcome.text, 'name = "x"', 'the rest of the file is intact');
});

test('a version is only written when one is given', () => {
    const outcome = applyDependency(WIRED, { name: 'embassy-futures', features: [] });
    equal(outcome.line, 'embassy-futures = "*"', 'no version, no version key');
});

test('default-features is written only when it is turned off', () => {
    equal(
        formatDependencyLine({ name: 'x', version: '1.0.0', features: [], defaultFeatures: false }),
        'x = { version = "1.0.0", default-features = false }',
    );
    equal(
        formatDependencyLine({ name: 'x', version: '1.0.0', features: [], defaultFeatures: true }),
        'x = { version = "1.0.0" }',
        'leaving the default alone writes nothing',
    );
});

test('default-features = false is carried through an update', () => {
    const outcome = applyDependency(WIRED, { name: 'embassy-time', version: '0.5.1', features: [], defaultFeatures: false });
    equal(outcome.line, 'embassy-time = { version = "0.5.1", default-features = false }');
});

test('duplicate features are collapsed, order preserved', () => {
    const outcome = applyDependency(WIRED, { name: 'x', version: '1.0.0', features: ['b', 'a', 'b'] });
    equal(outcome.line, 'x = { version = "1.0.0", features = ["b", "a"] }');
});

test('writing the same request twice changes nothing', () => {
    const once = applyDependency(WIRED, { name: 'heapless', version: '0.9.3', features: ['defmt'] });
    const twice = applyDependency(once.text, { name: 'heapless', version: '0.9.3', features: ['defmt'] });
    ok(twice.ok);
    equal(twice.action, 'updated');
    equal(twice.text, once.text, 'the second pass is a no-op on the text');
});

test('a file with no [dependencies] table gets one appended', () => {
    const source = ['[package]', 'name = "minimal"', 'version = "0.1.0"', '', '[profile.release]', 'lto = true', ''].join('\n');
    const outcome = applyDependency(source, { name: 'heapless', version: '0.9.3', features: ['defmt'] });
    ok(outcome.ok);
    contains(outcome.text, '[dependencies]\nheapless = { version = "0.9.3", features = ["defmt"] }');
    equal(findDependency(parseCargoToml(outcome.text), 'heapless').version, '0.9.3');
});

test('the old [dependencies.foo] section form is updated in place', () => {
    const source = ['[package]', 'name = "x"', '', '[dependencies.foo]', 'version = "0.1.0"', 'optional = true', ''].join('\n');
    const model = parseCargoToml(source);
    const existing = findDependency(model, 'foo');
    equal(existing.form, 'section', 'the section form is recognised');
    equal(existing.version, '0.1.0');

    const outcome = applyDependency(source, { name: 'foo', version: '0.2.0', features: ['a', 'b'] });
    ok(outcome.ok);
    equal(outcome.action, 'updated');
    contains(outcome.text, 'version = "0.2.0"');
    contains(outcome.text, 'features = ["a", "b"]');
    contains(outcome.text, 'optional = true', 'the keys we do not own stay');
    notContains(outcome.text, 'version = "0.1.0"');
    equal(findDependency(parseCargoToml(outcome.text), 'foo').version, '0.2.0');
});

test('the section form gets a features line even when it had none', () => {
    const source = ['[dependencies.foo]', 'version = "0.1.0"', ''].join('\n');
    const outcome = applyDependency(source, { name: 'foo', version: '0.1.0', features: ['a'] });
    equal(outcome.text.split('\n').slice(0, 3), ['[dependencies.foo]', 'version = "0.1.0"', 'features = ["a"]']);
});

test('an entry we cannot rewrite is refused with a reason, not mangled', () => {
    const source = ['[dependencies]', 'foo = 1.0', ''].join('\n');
    const outcome = applyDependency(source, { name: 'foo', version: '1.0.0', features: [] });
    notOk(outcome.ok);
    contains(outcome.reason, 'foo');
    contains(outcome.reason, 'line 2', 'the reason says where to look');
});

test('a multi-line table is refused rather than half-rewritten', () => {
    const source = ['[dependencies]', 'foo = {', '  version = "1.0",', '}', ''].join('\n');
    const model = parseCargoToml(source);
    equal(findDependency(model, 'foo').form, 'opaque');
    const outcome = applyDependency(source, { name: 'foo', version: '2.0.0', features: [] });
    notOk(outcome.ok);
    contains(outcome.reason, 'by hand');
});

test('CRLF and a missing trailing newline are preserved', () => {
    const source = '[package]\r\nname = "x"\r\n\r\n[dependencies]\r\ndefmt = "1.1"';
    const outcome = applyDependency(source, { name: 'heapless', version: '0.9.3', features: [] });
    ok(outcome.ok);
    ok(outcome.text.includes('\r\n'), 'the file stays CRLF');
    notOk(outcome.text.includes('\n\n\n'), 'no stray blank lines');
    ok(!outcome.text.endsWith('\r\n'), 'and it still has no trailing newline, because it never had one');
});

test('a trailing newline is kept', () => {
    const outcome = applyDependency(WIRED, { name: 'heapless', version: '0.9.3', features: [] });
    ok(outcome.text.endsWith('\n'));
    equal(outcome.text.endsWith('\n\n'), false);
});

test('the parser reports the line an entry starts on, for the Project view', () => {
    const model = parseCargoToml(WIRED);
    for (const dependency of model.dependencies) {
        const line = WIRED.split('\n')[dependency.startLine];
        ok(
            line.trimStart().startsWith(`${dependency.name} `) || line.trimStart().startsWith(`${dependency.name}=`),
            `line ${dependency.startLine} should hold ${dependency.name}, found "${line}"`,
        );
    }
});
