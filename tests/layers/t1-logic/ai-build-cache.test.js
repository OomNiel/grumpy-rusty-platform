'use strict';

/**
 * "Is the sidecar already built from exactly these sources?"
 *
 * The answer decides whether an extension update compiles llama.cpp again — minutes and hundreds of megabytes
 * — or reuses what is in global storage. It is a fingerprint rather than a timestamp because every file in a
 * freshly unpacked VSIX carries the install time, which is newer than any binary built before it, so a
 * timestamp would rebuild every single update.
 */

const { test, ok, equal } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');

const cache = compiled('ai/buildCache');

const file = (name, text) => ({ name, text });

test('the fingerprint depends on content, not on the order files arrive in', () => {
    const a = cache.fingerprintSources([file('src/main.rs', 'fn main() {}'), file('Cargo.toml', '[package]')]);
    const b = cache.fingerprintSources([file('Cargo.toml', '[package]'), file('src/main.rs', 'fn main() {}')]);
    equal(a, b, 'the filesystem order must not change the answer');
    ok(a.length === 32, `a fixed-length key, got ${a.length}`);
});

test('a changed source changes the fingerprint', () => {
    const before = cache.fingerprintSources([file('src/main.rs', 'fn main() {}')]);
    const after = cache.fingerprintSources([file('src/main.rs', 'fn main() { }')]);
    ok(before !== after, 'one character must be enough to force a rebuild');
});

test('a marker round-trips', () => {
    const text = cache.buildMarkerText('vulkan', 'abc123');
    equal(cache.parseBuildMarker(text), { backend: 'vulkan', fingerprint: 'abc123' });
});

test('a marker from the older format is stale, not trusted', () => {
    // The first version wrote the bare backend name and nothing about the sources.
    equal(cache.parseBuildMarker('cpu'), { backend: 'cpu', fingerprint: '' });
    ok(!cache.buildIsCurrent(cache.parseBuildMarker('cpu'), 'cpu', 'abc123'),
        'nothing recorded what it was built from, so it is rebuilt once');
});

test('only the same backend and the same sources count as current', () => {
    const marker = { backend: 'cpu', fingerprint: 'abc123' };
    ok(cache.buildIsCurrent(marker, 'cpu', 'abc123'));
    ok(!cache.buildIsCurrent(marker, 'vulkan', 'abc123'), 'a backend switch is a different build');
    ok(!cache.buildIsCurrent(marker, 'cpu', 'other'), 'changed sources are a different build');
    ok(!cache.buildIsCurrent(undefined, 'cpu', 'abc123'), 'no marker, no reuse');
});

test('junk in the marker file is treated as no marker', () => {
    equal(cache.parseBuildMarker(undefined), undefined);
    equal(cache.parseBuildMarker(''), undefined);
    equal(cache.parseBuildMarker('{}'), undefined, 'a JSON object without both fields tells us nothing');
});
