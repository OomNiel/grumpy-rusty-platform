'use strict';

/**
 * The bundled library catalog is data, so the tests are invariants.
 *
 * The catalog is the one part of the Library Manager that is not verified at runtime: a
 * wrong feature name here becomes a Cargo.toml that fails to build with a message the user
 * has to decode. Everything that can be pinned offline is pinned here.
 */

const { test, ok, equal, contains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const { CATALOG_VERSION, CATEGORIES, LIBRARY_CATALOG, catalogByCategory, catalogEntry, docsUrlFor } = compiled('library/catalog');

const CATEGORY_IDS = CATEGORIES.map((category) => category.id);

test('the catalog declares a version, like the board matrix does', () => {
    ok(Number.isInteger(CATALOG_VERSION) && CATALOG_VERSION >= 1);
});

test('crate names are unique and valid Cargo dependency keys', () => {
    const seen = new Set();
    for (const entry of LIBRARY_CATALOG) {
        ok(!seen.has(entry.name), `${entry.name} is listed twice`);
        seen.add(entry.name);
        ok(/^[a-z0-9][a-z0-9_-]*$/.test(entry.name), `${entry.name} is not a valid crate name`);
    }
    ok(LIBRARY_CATALOG.length >= 30, `expected a real catalog, found ${LIBRARY_CATALOG.length} entries`);
});

test('every version pin is an exact release, not a range', () => {
    for (const entry of LIBRARY_CATALOG) {
        ok(
            /^\d+\.\d+\.\d+$/.test(entry.version),
            `${entry.name} pins "${entry.version}"; the catalog holds exact versions only`,
        );
    }
});

test('every entry has a summary, a known category and at least one reason to exist', () => {
    for (const entry of LIBRARY_CATALOG) {
        ok(entry.summary.trim().length > 10, `${entry.name} needs a summary`);
        ok(CATEGORY_IDS.includes(entry.category), `${entry.name} has an unknown category "${entry.category}"`);
    }
});

test('feature names are unique per entry and never empty', () => {
    for (const entry of LIBRARY_CATALOG) {
        const seen = new Set();
        for (const feature of entry.features) {
            ok(feature.name.trim() !== '', `${entry.name} lists an empty feature name`);
            ok(!seen.has(feature.name), `${entry.name} lists "${feature.name}" twice`);
            seen.add(feature.name);
            ok(!/\s/.test(feature.name), `${entry.name}'s feature "${feature.name}" contains whitespace`);
        }
    }
});

test('what the picker pre-ticks is always offered', () => {
    for (const entry of LIBRARY_CATALOG) {
        const offered = new Set([...entry.features.map((feature) => feature.name), ...(entry.implicitFeatures ?? [])]);
        for (const feature of entry.recommended) {
            ok(offered.has(feature), `${entry.name} recommends "${feature}", which it does not offer`);
        }
    }
});

test('implicit features are also offered explicitly, with the reason on record', () => {
    for (const entry of LIBRARY_CATALOG) {
        for (const feature of entry.implicitFeatures ?? []) {
            ok(
                entry.features.some((listed) => listed.name === feature),
                `${entry.name}'s implicit feature "${feature}" must also appear in the feature list, or the picker never shows it`,
            );
        }
    }
});

test('portable-atomic documents the implicit-feature trap it exists to demonstrate', () => {
    const entry = catalogEntry('portable-atomic');
    ok(entry, 'portable-atomic is the crate a Cortex-M0+ build needs');
    equal([...entry.implicitFeatures].sort(), ['critical-section', 'serde']);
    contains(entry.note, 'optional dependencies', 'the note has to explain why the index does not list them');
    contains(entry.note, 'compare-exchange', 'and why the crate is needed at all');
});

test('no entry offers the executor features that break the link', () => {
    // NOTES.md 2.1: embassy-executor must not be given the platform features, because
    // embassy-rp already defines __pender. Offering them here would be offering a broken build.
    const executor = catalogEntry('embassy-executor');
    const offered = executor.features.map((feature) => feature.name);
    for (const forbidden of ['platform-cortex-m', 'executor-thread', 'executor-interrupt']) {
        ok(!offered.includes(forbidden), `embassy-executor must not offer ${forbidden}`);
    }
    contains(executor.note, '__pender', 'the entry explains why');
});

test('the board matrix decides embassy-rp\'s silicon features, and the note says so', () => {
    const entry = catalogEntry('embassy-rp');
    const offered = entry.features.map((feature) => feature.name);
    ok(offered.includes('rp2040') && offered.includes('rp235xa'), 'both silicon families are listed');
    equal(entry.recommended, [], 'nothing is pre-ticked: the right set depends on the board');
    ok(entry.note.includes('rp235xa'), 'the note names the combination RP2350 needs');
});

test('a crate whose feature set we refuse to guess is listed with none pre-ticked', () => {
    const trouble = catalogEntry('trouble-host');
    ok(trouble, 'trouble-host is the BLE host stack');
    equal(trouble.features, [], 'its 95 features are not curated here');
    equal(trouble.recommended, []);
    contains(trouble.note, '95 features');
});

test('every category has entries and every entry is reachable', () => {
    const groups = catalogByCategory();
    equal(
        groups.map((group) => group.category.id),
        CATEGORY_IDS,
        'categories are listed in declaration order and none is empty',
    );
    const listed = groups.reduce((total, group) => total + group.entries.length, 0);
    equal(listed, LIBRARY_CATALOG.length);
});

test('lookup is exact and misses are undefined', () => {
    equal(catalogEntry('heapless').version, '0.9.3');
    equal(catalogEntry('Heapless'), undefined, 'crate names are lowercase');
    equal(catalogEntry('nope'), undefined);
});

test('docs links point at the pinned version', () => {
    equal(docsUrlFor('heapless', '0.9.3'), 'https://docs.rs/heapless/0.9.3');
    equal(docsUrlFor('heapless'), 'https://docs.rs/heapless');
});

test('the catalog covers the categories a Pico project actually reaches for', () => {
    const names = new Set(LIBRARY_CATALOG.map((entry) => entry.name));
    for (const essential of ['embassy-sync', 'embedded-hal', 'heapless', 'embedded-graphics', 'littlefs2', 'cyw43']) {
        ok(names.has(essential), `${essential} should be in the catalog`);
    }
});
