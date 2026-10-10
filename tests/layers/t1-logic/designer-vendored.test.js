'use strict';

/**
 * The crates a Designer project vendors, and whether the copy it holds is this extension's.
 *
 * A Designer project builds against `codegen/rusty-gui-widgets` and `codegen/embedded-gui-codegen` -- copies the
 * wizard made from the extension, referenced by path. The price of that is staleness: a project made by 0.0.60
 * keeps 0.0.60's crates, and the markup a later designer writes can name something they do not know. The six
 * vertex offsets of a triangle are exactly that case: an older fork reads the three attributes it knows, ignores
 * the six it does not, and paints the isosceles triangle it always did -- a successful build and a silent lie
 * about what is on the glass.
 *
 * So the copy records which version made it, and these tests pin both halves of the answer: what to conclude
 * from the marker, and that the copying actually writes one (a marker written by a *different* code path than
 * the one that reads it is the same bug wearing a hat).
 */

const fs = require('fs');
const path = require('path');
const { test, ok, notOk, equal, contains, repoRoot, compiled } = require('../../lib/harness');
const {
    VENDORED_CRATES,
    VENDORED_MARKER,
    VENDORED_SOURCE,
    vendoredState,
    vendoredUpdateNeeded,
    vendoredDescription,
    hasVendoredCrates,
    readVendoredMarker,
    copyVendoredCrates,
} = compiled('designer/vendored');

/** A scratch directory under the gitignored `tests/tmp`, empty before each use. */
function scratch(name) {
    const dir = path.join(repoRoot(), 'tests', 'tmp', 'vendored-test', name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

const MINE = '9.9.9';

// ---------------------------------------------------------------- what to conclude

test('a project with no codegen folder has nothing to update', () => {
    // Every non-Designer project looks like this, and asking about crates it never had would be noise.
    equal(vendoredState({ hasCrates: false, version: MINE }), 'absent', 'no crates, no question');
    equal(vendoredUpdateNeeded('absent'), false, 'and nothing to do');
    // Even a stray marker means nothing when there is no crates folder to go with it.
    equal(vendoredState({ hasCrates: false, marker: '0.0.1', version: MINE }), 'absent', 'the folder decides');
});

test('a copy this extension made is current, and any other version is stale', () => {
    equal(vendoredState({ hasCrates: true, marker: MINE, version: MINE }), 'current', 'its own version');
    equal(vendoredUpdateNeeded('current'), false, 'and is left alone');
    // The file is written with a trailing newline; reading it back must not make it look stale.
    equal(vendoredState({ hasCrates: true, marker: `${MINE}\n`, version: MINE }), 'current', 'whitespace ignored');

    for (const marker of ['0.0.1', '0.0.60', '10.0.0', '9.9.8', 'nightly']) {
        equal(vendoredState({ hasCrates: true, marker, version: MINE }), 'stale', `${marker} is not ${MINE}`);
        equal(vendoredUpdateNeeded('stale'), true, `${marker} wants updating`);
        contains(vendoredDescription('stale', marker), marker, 'and the reason names the version it came from');
    }
});

test('a codegen folder with no marker is an older copy, not a current one', () => {
    // This is the case the user's own projects are in: created before the marker existed. Treating "no
    // evidence" as "current" would leave exactly the projects most likely to be stale untouched.
    for (const marker of [undefined, '', '   ']) {
        equal(vendoredState({ hasCrates: true, marker, version: MINE }), 'unmarked', `"${marker}" is unmarked`);
        equal(vendoredUpdateNeeded('unmarked'), true, 'so it is offered an update');
    }
    contains(vendoredDescription('unmarked', undefined), 'before', 'and says why it cannot be trusted');
});

// ---------------------------------------------------------------- the copying itself

test('copying the crates writes the version marker the reader looks for', () => {
    const extension = scratch('extension');
    const project = scratch('project');
    fs.mkdirSync(path.join(project, 'codegen'), { recursive: true });
    for (const crate of VENDORED_CRATES) {
        fs.mkdirSync(path.join(extension, VENDORED_SOURCE, crate, 'src'), { recursive: true });
        fs.writeFileSync(path.join(extension, VENDORED_SOURCE, crate, 'Cargo.toml'), `# ${crate}\n`, 'utf8');
        fs.writeFileSync(path.join(extension, VENDORED_SOURCE, crate, 'src', 'lib.rs'), '// src\n', 'utf8');
        // A leftover in the project that the new copy does not have: it has to go, or it keeps compiling.
        fs.mkdirSync(path.join(project, 'codegen', crate), { recursive: true });
        fs.writeFileSync(path.join(project, 'codegen', crate, 'gone.rs'), '// stale\n', 'utf8');
    }
    const lines = [];
    const context = {
        extension: { packageJSON: { version: MINE } },
        extensionUri: { fsPath: extension },
    };
    copyVendoredCrates(context, { fsPath: project }, { appendLine: (line) => lines.push(line) });

    for (const crate of VENDORED_CRATES) {
        const copied = path.join(project, 'codegen', crate);
        ok(fs.existsSync(path.join(copied, 'Cargo.toml')), `${crate} was copied`);
        ok(fs.existsSync(path.join(copied, 'src', 'lib.rs')), `${crate}'s sources came too`);
        notOk(fs.existsSync(path.join(copied, 'gone.rs')), `${crate}'s stale file is gone`);
    }
    // The reader and the writer have to agree, byte for byte: the marker is read back by the same constant.
    const recorded = fs.readFileSync(path.join(project, VENDORED_MARKER), 'utf8');
    equal(recorded.trim(), MINE, 'the copy recorded which version made it');
    equal(readVendoredMarker({ fsPath: project }), recorded, 'and the reader finds it where the writer put it');
    equal(
        vendoredState({ hasCrates: hasVendoredCrates({ fsPath: project }), marker: recorded, version: MINE }),
        'current',
        'so a fresh copy is not offered an update',
    );
    ok(
        lines.some((line) => line.includes('rusty-gui-widgets')),
        'the output names what was copied',
    );
    fs.rmSync(path.join(project, VENDORED_MARKER));
    equal(hasVendoredCrates({ fsPath: project }), true, 'the crates are still detectable without a marker');
    equal(readVendoredMarker({ fsPath: project }), undefined, 'and an unreadable marker is undefined, not a throw');
});

// ---------------------------------------------------------------- the wiring

test('the project wizard and the designer both use this one copy, and the designer asks first', () => {
    // Two implementations of "copy the crates" would drift, and the one that forgets the marker would make every
    // project it creates look stale. Read from the sources rather than the compiled output, so the guard is on
    // what a reviewer reads.
    const read = (file) => fs.readFileSync(path.join(repoRoot(), file), 'utf8');
    const wizard = read('src/commands/newProject.ts');
    contains(wizard, "from '../designer/vendored'", 'the wizard imports the shared copier');
    notOk(
        wizard.includes('function copyVendoredCrates'),
        'and does not carry a second copy of it that would never write the marker',
    );
    notOk(
        /\[(?:[^\]]*'rusty-gui-widgets'|\s*'embedded-gui-codegen')/.test(wizard),
        'nor lists the crates itself: the list lives in one place',
    );

    const editor = read('src/designer/editor.ts');
    contains(editor, 'ensureVendoredCrates(context, project.folder, output)', 'the designer checks on open');
    contains(editor, "'Update Crates'", 'and asks rather than overwriting files in the project');
    const open = editor.indexOf('ensureVendoredCrates(context, project.folder, output)');
    const panel = editor.indexOf('current = new DesignerPanel(');
    ok(open > 0 && panel > 0, 'the check is wired in, before the panel that draws on that promise');
    ok(open < panel, 'and it runs first');

    // The generated Cargo.toml points at `codegen/<crate>`, which is what makes a stale copy matter at all.
    const esp = read('src/generate/esp.ts');
    for (const crate of VENDORED_CRATES) {
        contains(esp, `codegen/${crate}`, `${crate} is referenced from the project's Cargo.toml`);
    }
    equal(VENDORED_MARKER.startsWith('codegen/'), true, 'the marker lives inside the folder it describes');
});
