'use strict';

/**
 * The contract between the extension and the Rust sidecar.
 *
 * These are the numbers and words two programs have to agree on, and they are the kind of thing that
 * drifts silently: `sidecarArgs` writes a command line the sidecar parses, `parseHealth` reads a body the
 * sidecar writes, and `sidecarBackend` decides which cargo feature the build is asked for. A typo in any
 * of them shows up as "the model runtime stopped" with no explanation, so each is pinned here instead.
 *
 * `modelSpecs.ts` imports nothing and has no `vscode`, which is exactly what lets the t1 layer reach it.
 */

const { test, ok, equal, contains, notOk } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');

const specs = compiled('ai/modelSpecs');

test('the CPU build is the default and every GPU build is nameable', () => {
    equal(specs.sidecarBackend(undefined), 'cpu');
    equal(specs.sidecarBackend(''), 'cpu');
    equal(specs.sidecarBackend('CPU'), 'cpu');
    equal(specs.sidecarBackend('vulkan'), 'vulkan');
    equal(specs.sidecarBackend('VULKAN'), 'vulkan');
    equal(specs.sidecarBackend('cuda'), 'cuda');
    equal(specs.sidecarBackend('metal'), 'metal');
    // A value nobody recognises is the CPU build, never a GPU request nobody made.
    equal(specs.sidecarBackend('gpu'), 'cpu');
    equal(specs.sidecarBackend(42), 'cpu');
});

test('a GPU build falls back to the CPU one, and the CPU build does not retry', () => {
    equal(specs.sidecarAttempts('cpu'), ['cpu']);
    equal(specs.sidecarAttempts('vulkan'), ['vulkan', 'cpu']);
    equal(specs.sidecarAttempts('cuda'), ['cuda', 'cpu']);
    equal(specs.sidecarAttempts('metal'), ['metal', 'cpu']);
});

test('the argv is the one the sidecar parses', () => {
    const argv = specs.sidecarArgs({ modelPath: '/m/x.gguf', port: 8123, ctx: 4096, gpuLayers: 0, backend: 'cpu' });
    // Every option is always present, so the log line is the evidence of what was asked for.
    equal(argv[0], '--model');
    equal(argv[1], '/m/x.gguf');
    equal(argv[2], '--port');
    equal(argv[3], '8123');
    contains(argv.join(' '), '--ctx 4096');
    contains(argv.join(' '), '--gpu-layers 0');
    contains(argv.join(' '), '--backend cpu');
    notOk(argv.includes('--threads'), 'no thread count when none was chosen');
});

test('a chosen thread count is passed through', () => {
    const argv = specs.sidecarArgs({ modelPath: 'm.gguf', port: 1, threads: 6, backend: 'vulkan' });
    contains(argv.join(' '), '--threads 6');
    contains(argv.join(' '), '--backend vulkan');
});

test('health is read the way the sidecar writes it', () => {
    const loading = specs.parseHealth({ ok: false, loaded: false, loading: true, model: 'model' });
    equal(loading.ok, false);
    equal(loading.loading, true);

    const loaded = specs.parseHealth({ ok: true, loaded: true, model: 'qwen', backend: 'cuda', device: 'RTX 3060' });
    equal(loaded.ok, true);
    equal(loaded.loading, false);
    equal(loaded.model, 'qwen');
    equal(loaded.backend, 'cuda');
    equal(loaded.device, 'RTX 3060');

    const failed = specs.parseHealth({ ok: false, loaded: false, loading: false, error: 'the model file does not exist' });
    equal(failed.ok, false);
    equal(failed.error, 'the model file does not exist');
});

test('the native-backend line never claims a GPU llama.cpp did not use', () => {
    contains(specs.nativeBackendLine('cpu'), 'CPU build');
    contains(specs.nativeBackendLine('vulkan'), 'Vulkan build');
    // The runtime reported CPU while Vulkan was asked for: say so.
    const fellBack = specs.nativeBackendLine('vulkan', { backend: 'cpu' });
    contains(fellBack, 'CPU build');
    contains(fellBack, 'could not use it');
    // The runtime reported a GPU build: name it.
    contains(specs.nativeBackendLine('vulkan', { backend: 'vulkan', device: 'AMD Radeon' }), 'Vulkan build');
    contains(specs.nativeBackendLine('vulkan', { backend: 'vulkan', device: 'AMD Radeon' }), 'AMD Radeon');
});

test('the shipped model entries name one download and two builds', () => {
    const byFile = new Map();
    for (const spec of specs.MODEL_SPECS) {
        if (!byFile.has(spec.fileName)) byFile.set(spec.fileName, []);
        byFile.get(spec.fileName).push(spec);
    }
    for (const [fileName, entries] of byFile) {
        equal(entries.length, 2, `${fileName} should be offered as a CPU and a GPU entry`);
        const builds = entries.map((e) => e.backend).sort();
        equal(builds, ['cpu', 'vulkan']);
        // One download means the two entries must agree about bytes and hash, or the second one re-downloads.
        equal(entries[0].bytes, entries[1].bytes, 'the same file must have one size');
        equal(entries[0].sha256, entries[1].sha256, 'the same file must have one hash');
    }
    ok(specs.sidecarBackend('cpu') === 'cpu', 'the CPU entry names a real backend');
});

test('formatBytes and defaultThreads are the wording and rule the log uses', () => {
    equal(specs.formatBytes(4_683_073_536), '4.7 GB');
    equal(specs.formatBytes(0), '0 B');
    const threads = specs.defaultThreads(16);
    ok(threads >= 1 && threads <= 8, `one less than the cores, capped at 8 (got ${threads})`);
    equal(specs.defaultThreads(2), 1);
});
