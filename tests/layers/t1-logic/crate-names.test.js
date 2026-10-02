'use strict';

const { test, equal, ok, notOk, contains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const {
    crateNameFrom,
    binaryNameFrom,
    isAcceptableProjectName,
} = compiled('generate/files');

test('crate names are lowercased and dashed', () => {
    equal(crateNameFrom('Blinky'), 'blinky');
    equal(crateNameFrom('My Pico Project'), 'my-pico-project');
    equal(crateNameFrom('blinky_pico2'), 'blinky-pico2');
});

test('runs of separators collapse and edges are trimmed', () => {
    equal(crateNameFrom('  --Blinky--Pico--  '), 'blinky-pico');
    equal(crateNameFrom('a___b'), 'a-b');
});

test('names starting with a digit get a prefix so Cargo accepts them', () => {
    equal(crateNameFrom('2pico'), 'fw-2pico');
});

test('an unusable name falls back to firmware', () => {
    equal(crateNameFrom('   '), 'firmware');
    equal(crateNameFrom('!!!'), 'firmware');
});

test('the binary name is the crate name verbatim (Cargo keeps hyphens)', () => {
    equal(binaryNameFrom('My Pico Project'), 'my-pico-project');
    equal(binaryNameFrom('Blinky'), 'blinky');
    equal(binaryNameFrom('My Pico Project'), crateNameFrom('My Pico Project'));
});

test('acceptable project names', () => {
    equal(isAcceptableProjectName('blinky-pico'), true);
    equal(isAcceptableProjectName('Blinky Pico 2'), true);
});

test('project names containing path or shell characters are rejected', () => {
    ok(typeof isAcceptableProjectName('') === 'string', 'empty name must be rejected');
    ok(typeof isAcceptableProjectName('   ') === 'string', 'blank name must be rejected');
    for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', '.', '..']) {
        ok(typeof isAcceptableProjectName(bad) === 'string', `"${bad}" must be rejected`);
    }
});

test('the rejection message explains the problem', () => {
    contains(isAcceptableProjectName('a/b'), '\\');
    contains(isAcceptableProjectName(''), 'name');
});
