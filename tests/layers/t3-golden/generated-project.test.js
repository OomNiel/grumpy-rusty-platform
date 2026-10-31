'use strict';

/**
 * t3-golden: byte-for-byte snapshots of generated projects, for every
 * board *and* every template that board supports.
 *
 * Regenerate with:  UPDATE_SNAPSHOTS=1 node tests/runner.js --layer t3-golden
 *
 * Any unintended change to a template shows up here as a diff, which is what makes
 * refactoring the generator safe. Layout: __snapshots__/<board>/<template>/<file>.
 */

const fs = require('fs');
const path = require('path');
const { test, ok, equal, fail } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');

const { BOARDS } = compiled('boards/catalog');
const { generateProjectFiles, templatesFor } = compiled('generate/files');
const { defaultWiring } = compiled('boards/panels');
const {
    generateArduinoProjectFiles,
    templatesForArduino,
} = compiled('generate/arduino');

const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';
const SNAPSHOT_DIR = path.join(__dirname, '__snapshots__');
/**
 * The C++ snapshots, in their own tree.
 *
 * A sketch and an Embassy project share nothing but their board, so a shared tree would only make it harder
 * to see which language changed. The orphan check below walks one tree, and this is the other.
 */
const ARDUINO_DIR = path.join(__dirname, '__snapshots-cpp__');
const PROJECT_NAME = 'snapshot-project';

function snapshotPathFor(boardId, template, relative) {
    return path.join(SNAPSHOT_DIR, boardId, template, relative);
}

function arduinoSnapshotPathFor(boardId, template, relative) {
    return path.join(ARDUINO_DIR, boardId, template, relative);
}

/** Every (board, template) pair the generator supports. */
function combinations() {
    const pairs = [];
    for (const board of BOARDS) {
        for (const info of templatesFor(board)) {
            pairs.push({ board, template: info.id });
        }
    }
    return pairs;
}

function firstDifference(expected, actual) {
    const expectedLines = expected.split('\n');
    const actualLines = actual.split('\n');
    const count = Math.max(expectedLines.length, actualLines.length);
    for (let i = 0; i < count; i += 1) {
        if (expectedLines[i] !== actualLines[i]) {
            return `line ${i + 1}:\n        snapshot: ${JSON.stringify(expectedLines[i])}\n        generated: ${JSON.stringify(actualLines[i])}`;
        }
    }
    return 'files differ only in trailing content';
}

test('generated projects match the recorded snapshots', () => {
    const problems = [];
    const created = [];
    const refreshed = [];

    for (const { board, template } of combinations()) {
        for (const file of generateProjectFiles({ board, projectName: PROJECT_NAME, template })) {
            const snapshotPath = snapshotPathFor(board.id, template, file.path);

            if (UPDATE) {
                const existed = fs.existsSync(snapshotPath);
                if (existed && fs.readFileSync(snapshotPath, 'utf8') !== file.content) {
                    refreshed.push(`${board.id}/${template}/${file.path}`);
                } else if (!existed) {
                    created.push(`${board.id}/${template}/${file.path}`);
                }
                fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
                fs.writeFileSync(snapshotPath, file.content, 'utf8');
                continue;
            }

            if (!fs.existsSync(snapshotPath)) {
                problems.push(`${board.id}/${template}/${file.path}: no snapshot recorded`);
                continue;
            }
            const expected = fs.readFileSync(snapshotPath, 'utf8');
            if (expected !== file.content) {
                problems.push(`${board.id}/${template}/${file.path}: ${firstDifference(expected, file.content)}`);
            }
        }
    }

    if (created.length > 0) {
        console.log(`      (recorded ${created.length} new snapshots)`);
    }
    if (refreshed.length > 0) {
        console.log(`      (refreshed ${refreshed.length} changed snapshots)`);
    }
    if (problems.length > 0) {
        fail(
            `${problems.length} snapshot mismatch(es):\n      ${problems.join('\n      ')}\n\n` +
            '      If the change was intended, regenerate with:\n' +
            '        UPDATE_SNAPSHOTS=1 node tests/runner.js --layer t3-golden',
        );
    }
    ok(true);
});

test('there are no orphaned snapshot files', () => {
    if (!fs.existsSync(SNAPSHOT_DIR)) {
        fail('no snapshots recorded yet — run UPDATE_SNAPSHOTS=1 node tests/runner.js --layer t3-golden');
    }

    const expected = new Set();
    for (const { board, template } of combinations()) {
        for (const file of generateProjectFiles({ board, projectName: PROJECT_NAME, template })) {
            expected.add(`${board.id}/${template}/${file.path}`);
        }
    }
    const orphans = [];
    const walk = (current, prefix) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
            if (entry.isDirectory()) {
                walk(path.join(current, entry.name), relative);
            } else if (!expected.has(relative)) {
                orphans.push(relative);
            }
        }
    };
    walk(SNAPSHOT_DIR, '');

    equal(
        orphans,
        [],
        `snapshot files the generator no longer produces:\n      ${orphans.join('\n      ')}`,
    );
});

test('every board and template has a snapshot directory', () => {
    for (const { board, template } of combinations()) {
        ok(
            fs.existsSync(path.join(SNAPSHOT_DIR, board.id, template)),
            `${board.id}/${template} has no snapshots`,
        );
    }
});

test('the snapshot set covers every board', () => {
    const boards = new Set(combinations().map((pair) => pair.board.id));
    equal([...boards].sort(), BOARDS.map((board) => board.id).sort());
});

// --------------------------------------------------------------- the C++ side
//
// Same idea, one tree over: a sketch of every board and every template it offers, recorded byte for byte. The
// panel pins make these snapshots depend on the board catalogue and on the panel wiring, which is exactly the
// kind of cross-module change these are here to catch.

/** Every (board, template) pair the C++ generator offers, with the wiring a wizard would have collected. */
function arduinoCombinations() {
    const pairs = [];
    for (const board of BOARDS) {
        for (const info of templatesForArduino(board)) {
            pairs.push({ board, template: info.id });
        }
    }
    return pairs;
}

function arduinoOptions(board, template) {
    return {
        board,
        projectName: PROJECT_NAME,
        template,
        choices: {},
        // One fixed module for every Pico snapshot: the wiring is a wizard answer, and a snapshot has to be
        // reproducible from the catalogue alone.
        wiring: board.kind === 'rp' ? defaultWiring(board, 'ili9341') : undefined,
        rotation: 0,
    };
}

test('generated C++ sketches match the recorded snapshots', () => {
    const problems = [];
    const created = [];
    const refreshed = [];

    for (const { board, template } of arduinoCombinations()) {
        for (const file of generateArduinoProjectFiles(arduinoOptions(board, template))) {
            const snapshotPath = arduinoSnapshotPathFor(board.id, template, file.path);

            if (UPDATE) {
                const existed = fs.existsSync(snapshotPath);
                if (existed && fs.readFileSync(snapshotPath, 'utf8') !== file.content) {
                    refreshed.push(`${board.id}/${template}/${file.path}`);
                } else if (!existed) {
                    created.push(`${board.id}/${template}/${file.path}`);
                }
                fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
                fs.writeFileSync(snapshotPath, file.content, 'utf8');
                continue;
            }

            if (!fs.existsSync(snapshotPath)) {
                problems.push(`${board.id}/${template}/${file.path}: no snapshot recorded`);
                continue;
            }
            const expected = fs.readFileSync(snapshotPath, 'utf8');
            if (expected !== file.content) {
                problems.push(`${board.id}/${template}/${file.path}: ${firstDifference(expected, file.content)}`);
            }
        }
    }

    if (created.length > 0) {
        console.log(`      (recorded ${created.length} new C++ snapshots)`);
    }
    if (refreshed.length > 0) {
        console.log(`      (refreshed ${refreshed.length} changed C++ snapshots)`);
    }
    if (problems.length > 0) {
        fail(
            `${problems.length} C++ snapshot mismatch(es):\n      ${problems.join('\n      ')}\n\n` +
            '      If the change was intended, regenerate with:\n' +
            '        UPDATE_SNAPSHOTS=1 node tests/runner.js --layer t3-golden',
        );
    }
    ok(true);
});

test('there are no orphaned C++ snapshot files', () => {
    const expected = new Set();
    for (const { board, template } of arduinoCombinations()) {
        for (const file of generateArduinoProjectFiles(arduinoOptions(board, template))) {
            expected.add(`${board.id}/${template}/${file.path}`);
        }
    }
    const orphans = [];
    const walk = (current, prefix) => {
        if (!fs.existsSync(current)) {
            return;
        }
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
            if (entry.isDirectory()) {
                walk(path.join(current, entry.name), relative);
            } else if (!expected.has(relative)) {
                orphans.push(relative);
            }
        }
    };
    walk(ARDUINO_DIR, '');

    equal(orphans, [], `C++ snapshot files the generator no longer produces:\n      ${orphans.join('\n      ')}`);
});

test('every board and template has a C++ snapshot directory', () => {
    for (const { board, template } of arduinoCombinations()) {
        ok(
            fs.existsSync(path.join(ARDUINO_DIR, board.id, template)),
            `${board.id}/${template} has no C++ snapshots`,
        );
    }
});
