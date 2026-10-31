'use strict';

/**
 * The language seam: which backend a project is read with, and what the wizard asks from it.
 *
 * Phase 1 of `plans/arduino-backend.md` puts today's Rust generation behind a `SketchBackend` and promises **no
 * behaviour change**, so these tests pin exactly that:
 *
 *   - a project that says nothing is Rust, and a marker that says something unreadable is Rust too, because a
 *     corrupt marker must not make a working project invisible;
 *   - the wizard's file list for Rust is the generator's own output, file for file -- not "looks similar";
 *   - a marker is only written for a language that is not the default, so no golden and no project on disk
 *     gains a file it did not have;
 *   - one backend is registered, which is what keeps the language step out of the wizard until there is a
 *     real choice to make.
 */

const { test, ok, notOk, equal, contains, throws, compiled } = require('../../lib/harness');
const {
    DEFAULT_LANGUAGE,
    LANGUAGE_MARKER,
    SKETCH_LANGUAGES,
    isSketchLanguage,
    languageMarker,
    readProjectLanguage,
} = compiled('project/language');
const {
    BACKENDS,
    availableBackends,
    backendFor,
    backendOrDefault,
    projectFiles,
    rustBackend,
} = compiled('generate/backends');
const { BOARDS } = compiled('boards/catalog');
const { generateProjectFiles, templatesFor } = compiled('generate/files');

/** A Pico board with a panel: the board that exercises the most of the generator. */
function pico() {
    const board = BOARDS.find((b) => b.id === 'pico');
    ok(board !== undefined, 'the Pico is in the catalogue');
    return board;
}

// ------------------------------------------------------------- the marker file

test('a project with no marker is Rust, which is every project that exists today', () => {
    equal(readProjectLanguage(undefined), 'rust', 'no file at all');
    equal(readProjectLanguage(''), 'rust', 'an empty file');
    equal(readProjectLanguage('   \n\t '), 'rust', 'whitespace');
    equal(readProjectLanguage('{}'), 'rust', 'an object without a language');
});

test('a marker that cannot be read is Rust rather than an error', () => {
    equal(readProjectLanguage('{"language":'), 'rust', 'truncated JSON');
    equal(readProjectLanguage('<xml/>'), 'rust', 'not JSON at all');
    equal(readProjectLanguage('null'), 'rust', 'JSON null');
    equal(readProjectLanguage('{"language":42}'), 'rust', 'a number');
    equal(readProjectLanguage('{"language":"cobol"}'), 'rust', 'a language nobody knows');
});

test('a marker that names a language this build knows is read back exactly', () => {
    for (const language of SKETCH_LANGUAGES) {
        const text = languageMarker(language);
        contains(text, language, `${language} is in the file it wrote`);
        equal(readProjectLanguage(text), language, `${language} round-trips`);
    }
    equal(DEFAULT_LANGUAGE, 'rust', 'and the default is still Rust');
    equal(LANGUAGE_MARKER, 'rusty.project.json', 'the marker file is one file, named once');
});

test('the marker a build writes is JSON with a trailing newline, so git diffs stay tidy', () => {
    equal(languageMarker('arduino'), '{\n  "language": "arduino"\n}\n', 'two-space JSON');
    ok(isSketchLanguage('rust') && isSketchLanguage('arduino'), 'the two languages');
    notOk(isSketchLanguage('Rust'), 'case matters');
    notOk(isSketchLanguage(undefined), 'and a missing value is not a language');
});

// ----------------------------------------------------------------- the backend

test('one backend is registered in this build, so the wizard has nothing to ask', () => {
    equal(BACKENDS.length, 1, 'exactly one');
    equal(availableBackends().length, 1, 'and that is what the wizard offers');
    equal(availableBackends()[0].id, 'rust', 'Rust');
    equal(rustBackend.label, 'Rust (Embassy)', 'named for the wizard that will show it');
    ok(rustBackend.detail.length > 20, 'with a line of detail under the name');
});

test('the Rust backend is today\'s generator, not a copy of it', () => {
    equal(rustBackend.markerFile, 'Cargo.toml', 'a Rust project is one with a Cargo.toml');
    equal(rustBackend.handlersPath(), 'src/ui_handlers.rs', 'the Designer appends stubs here');
    equal(rustBackend.panelPath(), 'src/panel.rs', 'and rewrites this when a pin moves');

    const board = pico();
    const options = { board, projectName: 'seam-check', template: 'blinky' };
    const throughBackend = rustBackend.files(options);
    const direct = generateProjectFiles(options);
    equal(throughBackend.length, direct.length, 'the same number of files');
    for (let index = 0; index < direct.length; index += 1) {
        equal(throughBackend[index].path, direct[index].path, `file ${index} has the same path`);
        equal(throughBackend[index].content, direct[index].content, `and the same bytes: ${direct[index].path}`);
    }
});

test('the templates come from the backend, so a second one can offer a different menu', () => {
    const board = pico();
    const offered = rustBackend.templatesOfferedFor(board);
    const direct = templatesFor(board);
    equal(offered.length, direct.length, 'the same templates');
    equal(rustBackend.defaultTemplateFor(board), 'blinky', 'a wired Pico starts at blinky');
    ok(offered.some((info) => info.id === 'designer'), 'and the designer is among them');
});

test('asking for a language this build cannot generate is an error, and reading one falls back', () => {
    equal(backendFor('rust').id, 'rust', 'the one that exists');
    throws(() => backendFor('arduino'), 'not in this build yet');

    equal(backendOrDefault(undefined).id, 'rust', 'no language is Rust');
    equal(backendOrDefault('rust').id, 'rust', 'and so is Rust');
    equal(backendOrDefault('arduino').id, 'rust', 'a language with no backend reads as Rust, not as a crash');
});

// ------------------------------------------------------------------ the files

test('a Rust project gains no marker file: every generated file is what it always was', () => {
    const board = pico();
    const options = { board, projectName: 'no-marker', template: 'blinky' };
    const files = projectFiles(rustBackend, options);
    equal(files.length, generateProjectFiles(options).length, 'not one file more');
    notOk(
        files.some((file) => file.path === LANGUAGE_MARKER),
        'a Rust project says nothing, because saying nothing already means Rust',
    );
});

test('a project in another language records it, in the marker file, once', () => {
    const board = pico();
    const arduino = {
        ...rustBackend,
        id: 'arduino',
        label: 'Arduino (C++)',
        markerFile: 'sketch.yaml',
    };
    const files = projectFiles(arduino, { board, projectName: 'cpp-marker', template: 'blinky' });
    const markers = files.filter((file) => file.path === LANGUAGE_MARKER);
    equal(markers.length, 1, 'one marker');
    equal(readProjectLanguage(markers[0].content), 'arduino', 'saying which language it is');
    equal(files.length, projectFiles(rustBackend, { board, projectName: 'cpp-marker', template: 'blinky' }).length + 1, 'and one file more than Rust');
});
