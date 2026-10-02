'use strict';

/**
 * Zero-dependency test harness.
 *
 * Test files are plain Node modules that call `test(name, fn)` at require time.
 * The runner is responsible for calling `beginFile()` before each require so the
 * cases can be attributed to the right layer.
 *
 * Layers
 *   t1-logic   pure functions: board matrix, generator, parsers, install planner
 *   t2-cli     toolchain detection against fake cargo/rustup/probe-rs shims
 *   t3-golden  byte-for-byte snapshots of generated projects
 *   t4-e2e     (opt-in) real `cargo build` of a generated project
 *   t5-hil     (opt-in) real flash onto attached hardware
 */

const path = require('path');

const files = [];
let current = null;

function beginFile(relativePath, layer) {
    current = { path: relativePath, layer, cases: [] };
    files.push(current);
    return current;
}

function test(name, fn) {
    if (!current) {
        throw new Error(`test("${name}") called outside a file — runner must call beginFile() first`);
    }
    current.cases.push({ name, fn, file: current.path, layer: current.layer });
}

function skip(name, reason) {
    if (!current) {
        throw new Error('skip() called outside a file');
    }
    current.cases.push({ name, skip: reason || 'skipped', file: current.path, layer: current.layer });
}

/** `require` a compiled module from `out/`, relative to the repo root. */
function compiled(relativeModule) {
    const root = path.join(__dirname, '..', '..');
    return require(path.join(root, 'out', relativeModule.replace(/\.js$/, '')));
}

function repoRoot() {
    return path.join(__dirname, '..', '..');
}

// ---------------------------------------------------------------- assertions

class AssertionError extends Error { }

/** Thrown by `runtimeSkip()` to mark a test as skipped while it is running. */
class SkipSignal extends Error { }

function runtimeSkip(reason) {
    throw new SkipSignal(reason || 'skipped');
}

function fail(message) {
    throw new AssertionError(message || 'assertion failed');
}

function ok(value, message) {
    if (!value) {
        fail(message || `expected a truthy value, got ${format(value)}`);
    }
}

function notOk(value, message) {
    if (value) {
        fail(message || `expected a falsy value, got ${format(value)}`);
    }
}

function isDeepEqual(a, b) {
    if (a === b) {
        return true;
    }
    if (typeof a !== typeof b || a === null || b === null) {
        return false;
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
        return false;
    }
    if (typeof a !== 'object') {
        return Number.isNaN(a) && Number.isNaN(b);
    }
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
        return false;
    }
    return aKeys.every((key) => isDeepEqual(a[key], b[key]));
}

function equal(actual, expected, message) {
    if (!isDeepEqual(actual, expected)) {
        fail(`${message ? `${message}\n  ` : ''}expected: ${format(expected)}\n  actual:   ${format(actual)}`);
    }
}

function contains(haystack, needle, message) {
    if (String(haystack).includes(needle)) {
        return;
    }
    fail(
        `${message ? `${message}\n  ` : ''}expected to contain:\n    ${JSON.stringify(needle)}\n  in:\n    ${JSON.stringify(
            String(haystack).slice(0, 400),
        )}`,
    );
}

function notContains(haystack, needle, message) {
    if (!String(haystack).includes(needle)) {
        return;
    }
    fail(`${message ? `${message}\n  ` : ''}expected NOT to contain ${JSON.stringify(needle)}`);
}

function matches(text, regex, message) {
    if (regex.test(String(text))) {
        return;
    }
    fail(`${message ? `${message}\n  ` : ''}expected ${JSON.stringify(String(text).slice(0, 300))} to match ${regex}`);
}

function throws(fn, message) {
    let threw = false;
    try {
        fn();
    } catch {
        threw = true;
    }
    if (!threw) {
        fail(message || 'expected the function to throw');
    }
}

function format(value) {
    if (typeof value === 'string') {
        return JSON.stringify(value.length > 300 ? `${value.slice(0, 300)}…` : value);
    }
    try {
        const json = JSON.stringify(value);
        return json === undefined ? String(value) : json.length > 300 ? `${json.slice(0, 300)}…` : json;
    } catch {
        return String(value);
    }
}

module.exports = {
    AssertionError,
    SkipSignal,
    beginFile,
    compiled,
    contains,
    equal,
    fail,
    files,
    format,
    matches,
    notContains,
    notOk,
    ok,
    repoRoot,
    runtimeSkip,
    skip,
    test,
    throws,
};
