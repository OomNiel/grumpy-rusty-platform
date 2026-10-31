'use strict';

/**
 * The Problems pane, as text a prompt can carry.
 *
 * Asked 2026-10-31: *"enable the ai model to access (read) the Problems … panes"*. Only this half is testable
 * without a window: `problemsBlock()` in `aiChatView.ts` asks VS Code for the diagnostics, and `formatProblems`
 * decides what a model is actually shown. The decisions pinned here are the ones that make the difference
 * between a useful block and a list that is merely complete:
 *
 *   - errors first, because a list truncated at forty items that starts with hints answers nothing;
 *   - duplicates dropped, because rust-analyzer and rustc report the same mistake and a small model will
 *     "fix" it twice;
 *   - the cut stated out loud, because otherwise the model reads a truncated list as the whole truth.
 */

const { test, ok, equal, contains, notContains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');

const { formatProblems } = compiled('ai/panes');

const diag = (file, line, severity, message, extra = {}) => ({ file, line, severity, message, ...extra });

test('an empty pane is an empty block, not a heading', () => {
    equal(formatProblems([]), '', 'nothing to say means nothing is sent');
});

test('errors come first, then warnings, each in file order', () => {
    const block = formatProblems([
        diag('src/warn.rs', 9, 'warning', 'unused variable: `y`', { source: 'rust-analyzer' }),
        diag('src/b.rs', 4, 'error', 'cannot find value `x` in this scope', { source: 'rustc' }),
        diag('src/a.rs', 2, 'error', 'mismatched types', { source: 'rustc' })
    ]);
    contains(block, 'The Problems pane shows 2 errors, 1 warning:', 'the counts lead');
    const order = block.split('\n').slice(1);
    ok(order[0].includes('src/a.rs:2:1') || order[0].includes('src/a.rs:2'), 'the first error listed is the first file');
    ok(order[1].includes('src/b.rs'), 'then the second error');
    ok(order[2].includes('src/warn.rs'), 'and the warning last, however the provider listed them');
});

test('the same problem reported by two providers is listed once', () => {
    const block = formatProblems([
        diag('src/main.rs', 7, 'error', 'unresolved import `embassy_time`', { source: 'rustc' }),
        diag('src/main.rs', 7, 'error', 'unresolved import `embassy_time`', { source: 'rust-analyzer' })
    ]);
    equal(block.split('\n').length - 1, 1, 'one line, not two');
    contains(block, '1 error:', 'and the count agrees');
});

test('a rustc explanation is cut to its headline', () => {
    // rustc's message often continues for a paragraph ("note: ... expected ..., found ..."). The pane shows the
    // first line; sending the rest fills a small model's window with prose it cannot act on.
    const block = formatProblems([
        diag('src/main.rs', 3, 'error', 'mismatched types\n\nexpected `u32`, found `&str`\n\nhelp: ...', { source: 'rustc' })
    ]);
    contains(block, 'mismatched types (rustc)');
    notContains(block, 'expected `u32`', 'the explanation is not forwarded');
});

test('what the block leaves out is said out loud', () => {
    const many = [];
    for (let i = 0; i < 50; i += 1) many.push(diag('src/main.rs', i + 1, 'error', `error number ${i}`));
    const byCount = formatProblems(many, { maxItems: 5 });
    contains(byCount, '50 errors:', 'the total is the true total');
    contains(byCount, 'the first 5 are below', 'and the cut is named');
    contains(byCount, '45 more are not shown', 'with the number left out');

    const bySize = formatProblems(many, { limit: 300 });
    const listed = bySize.split('\n').filter((line) => line.includes('error number')).length;
    ok(listed > 0 && listed < 50, 'a character budget cuts the list too');
    ok(bySize.length <= 300 + 200, 'and the block stays near the budget it was given');
});

test('a problem that names only a file, and one that says only what is wrong', () => {
    const block = formatProblems([
        diag('Cargo.toml', undefined, 'error', 'failed to load manifest for workspace member'),
        diag('src/main.rs', 1, 'warning', '`#[allow(dead_code)]` is never used')
    ]);
    contains(block, 'Cargo.toml: error: failed to load manifest', 'a file-level problem has no line to invent');
    contains(block, 'src/main.rs:1: warning:', 'a positioned one keeps its place');
    const withColumn = formatProblems([diag('src/lib.rs', 4, 'error', 'boom', { column: 12 })]);
    contains(withColumn, 'src/lib.rs:4:12: error: boom', 'and a column is carried when the provider gave one');
});

test('one of a kind is singular, and a lone error does not mention warnings', () => {
    contains(formatProblems([diag('src/a.rs', 1, 'error', 'boom')]), 'shows 1 error:', 'singular');
    const warningOnly = formatProblems([diag('src/a.rs', 1, 'warning', 'meh')]);
    contains(warningOnly, 'shows 1 warning:', 'a warning-only pane says nothing about errors');
    notContains(warningOnly, 'error', 'not even in passing');
});

// ---------------- the Debug Console ----------------

const { formatDebugConsole } = compiled('ai/panes');
const out = (text, category = 'stdout') => ({ category, text });

test('a silent console sends nothing', () => {
    equal(formatDebugConsole([]), '', 'no session yet, no block');
    equal(formatDebugConsole([out('   '), out('')]), '', 'and blank lines are not a session');
});

test('the tail is what is sent, and what was dropped is said', () => {
    // The end of a console is the failure — the panic, the exit code, the last line before the probe dropped.
    // The start is the same boot banner every run, which is why the head is the part that goes.
    const lines = [];
    for (let i = 1; i <= 100; i += 1) lines.push(out(`line ${i}`));
    const block = formatDebugConsole(lines, { limit: 200, of: '"Pico 2 W" session' });
    contains(block, 'of the "Pico 2 W" session', 'the session is named');
    contains(block, 'the start is not shown', 'the cut is stated');
    contains(block, 'line 100', 'the newest line is there');
    notContains(block, 'line 1\n', 'and the first one is not');
    ok(block.length <= 200 + 120, 'the block respects its budget');
    const order = block.split('\n').slice(1);
    equal(order[order.length - 1], 'line 100', 'the console keeps its own order, oldest first');
});

test('stderr is marked and the adapter events stay where they happened', () => {
    const block = formatDebugConsole([
        out('MainHeader::init() ok'),
        out('[stopped] exception: panic at src/main.rs:14', 'console'),
        out('panicked at src/main.rs:14:5:\nindex out of bounds', 'stderr'),
        out('[exited] code 101', 'console')
    ]);
    contains(block, '[stderr] panicked at src/main.rs:14:5:', 'a stderr line is marked');
    const order = block.split('\n').slice(1);
    equal(order[1], '[stopped] exception: panic at src/main.rs:14', 'the stop is where it happened');
    equal(order[2], '[stderr] panicked at src/main.rs:14:5:', 'then the program\'s own words');
    equal(order[3], '[stderr] index out of bounds', 'every line of a multi-line message keeps its mark');
    equal(order[4], '[exited] code 101', 'then how it ended');
});
