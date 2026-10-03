'use strict';

/**
 * The crates.io client's pure half.
 *
 * The `features` / `features2` split (NOTES.md 2.3) and the *implicit* features Cargo
 * creates for optional dependencies are both invisible in the obvious reading of an index
 * entry, and both produce a Cargo.toml that fails to build when they are got wrong. The
 * fixtures below are trimmed copies of the real index entries, so the expectations are the
 * registry's own answers rather than invented ones.
 */

const { test, ok, equal, contains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const {
    indexPathFor,
    parseIndexEntries,
    latestVersion,
    compareVersions,
    featureNamesFor,
    parseSearchResponse,
    fetchCrateFeatures,
    searchCrates,
} = compiled('library/registry');

/** Real embassy-rp 0.10.0 index entry, trimmed to the keys that matter here. */
const EMBASSY_RP = {
    vers: '0.10.0',
    features: {
        'critical-section-impl': ['critical-section/restore-state-u8'],
        default: ['rt'],
        rp2040: ['rp-pac/rp2040'],
        rp235xa: ['_rp235x'],
        'unstable-pac': [],
    },
    features2: {
        'binary-info': ['rt', 'dep:rp-binary-info', 'rp-binary-info?/binary-info'],
        defmt: ['dep:defmt', 'embassy-hal-internal/defmt'],
        'executor-thread': ['dep:embassy-executor', 'dep:embassy-executor-macros'],
        'time-driver': ['dep:embassy-time-driver', 'embassy-time-driver?/tick-hz-1_000_000'],
    },
    deps: [
        { name: 'embassy-executor', req: '^0.10.0', optional: true },
        { name: 'embassy-time-driver', req: '^0.2.2', optional: true },
        { name: 'rp-binary-info', req: '^0.1.0', optional: true },
        { name: 'rp-pac', req: '^8', optional: false },
    ],
};

/** Real portable-atomic 1.15.0 index entry: no features map entry for its optional deps. */
const PORTABLE_ATOMIC = {
    vers: '1.15.0',
    features: {
        default: ['fallback'],
        fallback: [],
        'force-amo': [],
        'require-cas': [],
        std: [],
    },
    deps: [
        { name: 'critical-section', req: '^1', optional: true },
        { name: 'serde', req: '^1.0.60', optional: true },
    ],
};

test('the sparse-index path follows the registry layout', () => {
    equal(indexPathFor('a'), '1/a');
    equal(indexPathFor('ab'), '2/ab');
    equal(indexPathFor('abc'), '3/a/abc');
    equal(indexPathFor('serde'), 'se/rd/serde');
    equal(indexPathFor('embassy-rp'), 'em/ba/embassy-rp');
    equal(indexPathFor('Portable-Atomic'), 'po/rt/portable-atomic', 'names are lowercased');
});

test('index entries parse as newline-delimited JSON, bad lines skipped', () => {
    const text = ['{"vers":"0.1.0"}', '', 'not json', '{"vers":"0.2.0","yanked":true}'].join('\n');
    const versions = parseIndexEntries(text);
    equal(versions.length, 2);
    equal(versions[0].vers, '0.1.0');
    equal(versions[1].vers, '0.2.0');
    equal(versions[1].yanked, true);
});

test('the newest version wins numerically, not alphabetically', () => {
    const versions = parseIndexEntries(
        ['{"vers":"0.9.3"}', '{"vers":"0.10.0"}', '{"vers":"0.10.0-rc.1"}'].join('\n'),
    );
    equal(latestVersion(versions).vers, '0.10.0', '0.10.0 sorts above 0.9.3');
    ok(compareVersions('0.10.0', '0.9.3') > 0);
});

test('a yanked release is never offered', () => {
    const versions = parseIndexEntries(['{"vers":"1.0.0","yanked":true}', '{"vers":"0.9.0"}'].join('\n'));
    equal(latestVersion(versions).vers, '0.9.0');
});

test('a pre-release is only chosen when there is nothing else', () => {
    const withStable = parseIndexEntries(['{"vers":"1.0.0-rc.1"}', '{"vers":"1.0.0"}'].join('\n'));
    equal(latestVersion(withStable).vers, '1.0.0');

    const onlyPre = parseIndexEntries(['{"vers":"1.0.0-rc.1"}'].join('\n'));
    equal(latestVersion(onlyPre).vers, '1.0.0-rc.1');
});

test('features are merged across `features` and `features2` (NOTES 2.3)', () => {
    const { features } = featureNamesFor(EMBASSY_RP);
    for (const expected of ['binary-info', 'time-driver', 'executor-thread', 'rp2040', 'critical-section-impl']) {
        ok(features.includes(expected), `${expected} should be offered`);
    }
});

test('features that live only in features2 are not missed', () => {
    const { features } = featureNamesFor(EMBASSY_RP);
    ok(features.includes('binary-info'), 'binary-info is defined in features2 and is required on RP2350');
    ok(!('binary-info' in EMBASSY_RP.features), 'and it really is absent from features');
});

test('an optional dependency becomes an implicit feature the index never lists', () => {
    const { features, implicit } = featureNamesFor(PORTABLE_ATOMIC);
    ok(features.includes('critical-section'), 'cargo accepts it; the index does not list it');
    ok(features.includes('serde'), 'same for serde');
    equal(implicit, ['critical-section', 'serde']);
    ok(!Object.keys(PORTABLE_ATOMIC.features).includes('critical-section'), 'the fixture is honest about the gap');
});

test('a `dep:`-enabled optional dependency is NOT an implicit feature', () => {
    const version = {
        vers: '1.0.0',
        features: { all: ['dep:foo'] },
        deps: [{ name: 'foo', req: '^1', optional: true }],
    };
    const { features, implicit } = featureNamesFor(version);
    ok(!features.includes('foo'), 'cargo suppresses the implicit feature when dep: syntax is used');
    equal(implicit, []);
});

test('a renamed optional dependency offers its Cargo.toml key', () => {
    const version = {
        vers: '1.0.0',
        features: {},
        deps: [{ name: 'real-crate', explicit_name_in_toml: 'alias', req: '^1', optional: true }],
    };
    const { features, implicit } = featureNamesFor(version);
    ok(features.includes('alias'), 'the key in Cargo.toml is what a feature is named after');
    ok(!features.includes('real-crate'));
    equal(implicit, ['alias']);
});

test('a feature that is both declared and optional is not offered twice', () => {
    const version = {
        vers: '1.0.0',
        features: { foo: [] },
        deps: [{ name: 'foo', req: '^1', optional: true }],
    };
    const { features, implicit } = featureNamesFor(version);
    equal(features.filter((name) => name === 'foo').length, 1);
    equal(implicit, [], 'it is an ordinary feature, already listed');
});

test('the search payload is read defensively', () => {
    const payload = {
        crates: [
            { name: 'embassy-rp', max_version: '0.10.0', description: '  HAL for RP2040  ', downloads: 426303 },
            { description: 'no name, so it is skipped' },
            { name: '' },
            { name: 'heapless' },
        ],
    };
    const results = parseSearchResponse(payload);
    equal(results.length, 2);
    equal(results[0].name, 'embassy-rp');
    equal(results[0].description, 'HAL for RP2040', 'descriptions are trimmed');
    equal(results[1].name, 'heapless');
    equal(results[1].description, '', 'a missing description is empty, not undefined');
    equal(parseSearchResponse({}), []);
    equal(parseSearchResponse(null), []);
});

test('the search payload is capped at the requested limit', () => {
    const payload = { crates: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] };
    equal(parseSearchResponse(payload, 2).map((item) => item.name), ['a', 'b']);
});

/** A stand-in for `util/http` that answers from a table and records what was asked. */
function fakeHttp(handler) {
    const asked = [];
    const get = async (url) => {
        asked.push(url);
        return handler(url);
    };
    return { get, asked };
}

test('reading a crate asks the sparse index for the right path', async () => {
    const http = fakeHttp(() => ({ status: 200, body: JSON.stringify(PORTABLE_ATOMIC) }));
    const info = await fetchCrateFeatures('portable-atomic', http.get);
    equal(http.asked, ['https://index.crates.io/po/rt/portable-atomic']);
    equal(info.version, '1.15.0');
    ok(info.features.includes('critical-section'));
    equal(info.implicitFeatures, ['critical-section', 'serde']);
});

test('a crate that does not exist says so instead of returning nothing', async () => {
    const http = fakeHttp(() => ({ status: 404, body: 'not found' }));
    await fetchCrateFeatures('no-such-crate-xyz', http.get).then(
        () => {
            throw new Error('expected a rejection');
        },
        (error) => {
            contains(error.message, 'No crate named "no-such-crate-xyz"');
        },
    );
});

test('a registry error surfaces the status code', async () => {
    const http = fakeHttp(() => ({ status: 503, body: '' }));
    await fetchCrateFeatures('embassy-rp', http.get).then(
        () => {
            throw new Error('expected a rejection');
        },
        (error) => {
            contains(error.message, 'HTTP 503');
        },
    );
});

test('search encodes the query and rejects an empty one without a request', async () => {
    const http = fakeHttp(() => ({ status: 200, body: JSON.stringify({ crates: [{ name: 'ssd1306' }] }) }));
    const results = await searchCrates('temperature sensor', http.get);
    equal(results.map((item) => item.name), ['ssd1306']);
    contains(http.asked[0], 'q=temperature%20sensor');
    contains(http.asked[0], 'per_page=20');

    const quiet = fakeHttp(() => ({ status: 200, body: '{}' }));
    equal(await searchCrates('   ', quiet.get), []);
    equal(quiet.asked.length, 0, 'nothing is requested for an empty query');
});

test('a non-JSON search response is reported, not thrown as a parse error', async () => {
    const http = fakeHttp(() => ({ status: 200, body: '<html>nope</html>' }));
    await searchCrates('serde', http.get).then(
        () => {
            throw new Error('expected a rejection');
        },
        (error) => {
            contains(error.message, 'not JSON');
        },
    );
});

test('a payload whose `crates` field is not an array yields nothing', () => {
    equal(parseSearchResponse({ crates: 'nope' }), []);
    equal(parseSearchResponse(['nope']), []);
    equal(parseSearchResponse(undefined), []);
});
