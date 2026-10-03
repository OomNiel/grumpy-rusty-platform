'use strict';

/**
 * The build-driven repair loop.
 *
 * The loop is where a rule-based helper is allowed to edit a file, so the safety properties are what the
 * tests pin: a fix that does not reduce the error list is reverted, an error whose fixer has already had a
 * go is never retried for ever, a `no-fix` answer moves on to the next error, and a build that cannot run
 * at all is reported rather than mistaken for a clean one. Everything the loop touches is injected, so the
 * whole pass logic runs against an in-memory fake — no compiler, no files, no window.
 */

const { test, ok, notOk, equal, contains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const { repairUntilClean, errorKey, describeError } = compiled('ai/repair');

function diag(line, opts = {}) {
    return {
        file: opts.file || '/p/src/main.rs',
        line,
        column: opts.column || 1,
        severity: 'error',
        code: opts.code || 'E0001',
        message: opts.message || `error at line ${line}`,
    };
}

/**
 * A fake repair context. `builds` is the sequence of build results (the last one repeats), `fixes` maps an
 * error key to `'fixed'`, `'no-fix'`, `'failed'` or a function.
 */
function fakeRepair(builds, fixes, opts = {}) {
    let buildIndex = 0;
    let buildsRun = 0;
    const calls = { fix: [], revert: 0, progress: [], cancelled: 0 };
    const ctx = {
        async build() {
            buildsRun += 1;
            const step = builds[Math.min(buildIndex, builds.length - 1)];
            buildIndex += 1;
            return step;
        },
        async fix(error) {
            calls.fix.push(errorKey(error));
            const action = fixes[errorKey(error)];
            return typeof action === 'function' ? action(error) : action || 'no-fix';
        },
        async revert() {
            calls.revert += 1;
        },
        progress(text) {
            calls.progress.push(text);
        },
        cancelled() {
            calls.cancelled += 1;
            return opts.cancelAfter !== undefined && buildsRun >= opts.cancelAfter;
        },
    };
    return { ctx, calls };
}

test('a clean build stops at once and reports nothing to do', async () => {
    const { ctx, calls } = fakeRepair([{ errors: [] }], {});
    const report = await repairUntilClean(ctx);
    equal(report.stoppedBecause, 'clean');
    equal([report.started, report.applied, report.reverted, report.builds], [0, 0, 0, 1]);
    equal(report.remaining, []);
    contains(calls.progress.join('\n'), 'builds');
});

test('a fix that removes an error is kept and counted', async () => {
    const e1 = diag(1);
    const e2 = diag(2);
    const { ctx } = fakeRepair(
        [{ errors: [e1, e2] }, { errors: [e2] }, { errors: [] }],
        { [errorKey(e1)]: 'fixed', [errorKey(e2)]: 'fixed' },
    );
    const report = await repairUntilClean(ctx);
    equal(report.stoppedBecause, 'clean');
    equal([report.started, report.applied, report.reverted, report.builds], [2, 2, 0, 3]);
    equal(report.fixed, [e1, e2]);
    equal(report.remaining, []);
});

test('a fix that does not help is reverted and counted, and never retried', async () => {
    const e1 = diag(1);
    const { ctx, calls } = fakeRepair([{ errors: [e1] }, { errors: [e1] }], { [errorKey(e1)]: 'fixed' });
    const report = await repairUntilClean(ctx);
    equal([report.applied, report.reverted], [0, 1]);
    equal(calls.revert, 1);
    equal(calls.fix.length, 1, 'the same error is not tried again');
    equal(report.stoppedBecause, 'no-progress');
    equal(report.remaining, [e1]);
});

test('a no-fix result skips that error and moves on to the next', async () => {
    const e1 = diag(1);
    const e2 = diag(2);
    // The second build still reports e1: the fixer that understood e2 removed e2 but not e1.
    const { ctx, calls } = fakeRepair([{ errors: [e1, e2] }, { errors: [e1] }], {
        [errorKey(e1)]: 'no-fix',
        [errorKey(e2)]: 'fixed',
    });
    const report = await repairUntilClean(ctx);
    equal(calls.fix, [errorKey(e1), errorKey(e2)]);
    equal(report.applied, 1);
    equal(report.fixed, [e2]);
    equal(report.remaining, [e1], 'the error the fixer skipped is left for the user');
});

test('a fixer that throws is treated as failed and the loop moves on', async () => {
    const e1 = diag(1);
    const { ctx, calls } = fakeRepair([{ errors: [e1] }], {
        [errorKey(e1)]: () => {
            throw new Error('boom');
        },
    });
    const report = await repairUntilClean(ctx);
    equal(calls.fix.length, 1);
    equal(report.stoppedBecause, 'nothing-fixable');
    equal(report.remaining, [e1]);
});

test('cancellation stops before the next fix', async () => {
    const e1 = diag(1);
    const { ctx, calls } = fakeRepair([{ errors: [e1] }], {}, { cancelAfter: 1 });
    const report = await repairUntilClean(ctx);
    equal(report.stoppedBecause, 'cancelled');
    equal(report.builds, 1);
    equal(calls.fix, []);
    equal(report.remaining, [e1]);
});

test('a build that cannot run is build-failed, at the start and mid-loop', async () => {
    const first = fakeRepair([{ errors: [], failure: 'cargo not found' }], {});
    const failed = await repairUntilClean(first.ctx);
    equal(failed.stoppedBecause, 'build-failed');
    equal(failed.failure, 'cargo not found');
    equal(failed.builds, 1);

    const e1 = diag(1);
    const middle = fakeRepair([{ errors: [e1] }, { errors: [], failure: 'linker died' }], { [errorKey(e1)]: 'fixed' });
    const broke = await repairUntilClean(middle.ctx);
    equal(broke.stoppedBecause, 'build-failed');
    equal(broke.failure, 'linker died');
    equal(broke.builds, 2);
    equal(broke.remaining, [e1]);
});

test('an error whose fixer says no-fix is left for the user, not retried', async () => {
    const e1 = diag(1);
    const e2 = diag(2);
    const { ctx, calls } = fakeRepair([{ errors: [e1, e2] }], { [errorKey(e1)]: 'no-fix', [errorKey(e2)]: 'no-fix' });
    const report = await repairUntilClean(ctx);
    equal(calls.fix, [errorKey(e1), errorKey(e2)]);
    equal(report.stoppedBecause, 'nothing-fixable');
    equal(report.builds, 1);
    equal(report.remaining, [e1, e2]);
});

test('errorKey and describeError name an error the same way every time', () => {
    equal(errorKey({ file: '/a/b.rs', line: 3, column: 7, code: 'E0308' }), '/a/b.rs:3:7:E0308');
    equal(describeError({ file: 'C:\\proj\\src\\main.rs', line: 12, code: 'E0425' }), 'E0425 in main.rs:12');
    notOk(describeError({ file: '/a/b.rs', line: 3, code: 'E0001' }).includes('/a/b.rs'));
    ok(describeError({ file: '/a/b.rs', line: 3, code: 'E0001' }).startsWith('E0001 in b.rs:3'));
});
