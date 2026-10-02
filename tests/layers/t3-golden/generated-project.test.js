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

const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';
const SNAPSHOT_DIR = path.join(__dirname, '__snapshots__');
const PROJECT_NAME = 'snapshot-project';

function snapshotPathFor(boardId, template, relative) {
    return path.join(SNAPSHOT_DIR, boardId, template, relative);
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

test('the snapshot set covers all four boards', () => {
    const boards = new Set(combinations().map((pair) => pair.board.id));
    equal([...boards].sort(), ['pico', 'pico2', 'pico2w', 'picow']);
});
