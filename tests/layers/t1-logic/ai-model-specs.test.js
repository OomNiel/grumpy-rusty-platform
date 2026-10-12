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
    // `contextSize`, not `ctx`: the test asked for `ctx` and so was asserting the default by accident, which
    // held while the default happened to equal the number it expected (2026-10-12).
    const argv = specs.sidecarArgs({ modelPath: '/m/x.gguf', port: 8123, contextSize: 4096, gpuLayers: 0, backend: 'cpu' });
    // Every option is always present, so the log line is the evidence of what was asked for.
    equal(argv[0], '--model');
    equal(argv[1], '/m/x.gguf');
    equal(argv[2], '--port');
    equal(argv[3], '8123');
    contains(argv.join(' '), '--ctx 4096', 'the window it was told to use');
    contains(argv.join(' '), '--gpu-layers 0');
    contains(argv.join(' '), '--backend cpu');
    notOk(argv.includes('--threads'), 'no thread count when none was chosen');
    // And with no size asked for, the floor is the one the answer needs room inside (8192 since 2026-10-12).
    contains(
        specs.sidecarArgs({ modelPath: '/m/x.gguf', port: 1 }).join(' '),
        `--ctx ${specs.DEFAULT_CONTEXT_SIZE}`,
        'an unset window is the default, not zero'
    );
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
    // One less than the cores, capped at 16. The cap was 8 — chosen on a 12-thread laptop — and it left most
    // of a bigger machine idle, which is the complaint this answers (2026-10-04). A 16-thread machine gets 15;
    // a 64-thread one still gets 16, because llama.cpp's returns flatten there (and `threads` overrides it).
    equal(specs.defaultThreads(16), 15);
    equal(specs.defaultThreads(32), 16);
    equal(specs.defaultThreads(64), 16);
    equal(specs.defaultThreads(2), 1);
    // A machine with a big card gets a context worth having; the old ceiling was 16 k for everyone.
    equal(specs.recommendedContextFor(128), 65536);
    equal(specs.recommendedContextFor(64), 32768);
    equal(specs.recommendedContextFor(24), 16384);
    equal(specs.recommendedContextFor(14), 8192);
    equal(specs.recommendedContextFor(6), 4096);
});

// ------------------------------------------------ models for machines that are not this one (2026-10-04)

test('GPU offload is decided from the card, not from this laptop', () => {
    const models = compiled('ai/localModels');
    // With no VRAM figure the conservative shared-memory rule stands (and says so, including the way out).
    equal(models.gpuOffloadFor(4.7, undefined).gpuLayers, 999, 'a small model on a shared-memory GPU: offload');
    equal(models.gpuOffloadFor(16.8, undefined).gpuLayers, 0, 'a big one on a shared-memory GPU: CPU');
    contains(models.gpuOffloadFor(16.8, undefined).reason, 'gpuVramGb');
    // With a card, the model fits or it does not, and the arithmetic is in the sentence.
    equal(models.gpuOffloadFor(4.7, 24).gpuLayers, 999);
    equal(models.gpuOffloadFor(16.8, 24).gpuLayers, 999, 'a 27B on a 24 GB card is exactly what the card is for');
    equal(models.gpuOffloadFor(16.8, 8).gpuLayers, 0);
    contains(models.gpuOffloadFor(16.8, 8).reason, '8.0 GB');
    contains(models.gpuOffloadFor(16.8, 8).reason, 'PCIe');
    // The context allowance is part of the sum: 22 GB of weights does not fit a 24 GB card with a 64 k window.
    equal(models.gpuOffloadFor(22.5, 24).gpuLayers, 0);
    equal(models.gpuOffloadFor(22.5, 26).gpuLayers, 999);
});

test('a model is offered with its cost and the free memory, never vetoed', () => {
    // The old rule was a veto that needed *twice* the file size in RAM, so the 16.8 GB 27B was "not offered"
    // on the 28 GB machine that runs it in 16.5 GiB. Now: the cost, what is free, and the user decides.
    const spec = { bytes: 16_810_714_336, minRamGb: 19, id: 'x', label: 'x', detail: '', fileName: 'x.gguf', url: '', sha256: '' };
    const fits = specs.specFit(spec, { totalRamGb: 28, freeRamGb: 20 });
    equal(fits.fits, true);
    equal(fits.neededGb, 18.8);
    const notFits = specs.specFit(spec, { totalRamGb: 28, freeRamGb: 8 });
    equal(notFits.fits, false);
    contains(notFits.reason, 'needs about 18.8 GB free');
    contains(notFits.reason, '8.0 GB free now');
    contains(notFits.reason, '28 GB in total', 'a big machine that is busy right now reads differently');
    // A tiny model on a busy machine: the reason is still arithmetic, not a shrug.
    const small = specs.specFit({ bytes: 1_900_000_000, minRamGb: 8, id: 's', label: 's', detail: '', fileName: 's.gguf', url: '', sha256: '' }, { totalRamGb: 8, freeRamGb: 2 });
    equal(small.fits, false);
    equal(small.neededGb, 3.9);
});

test('a model added from the Hub is sized by what it needs, not by twice its file', () => {
    const spec = specs.hubFileSpec({ repo: 'lmstudio-community/Qwen3.8-27B-GGUF', file: 'Qwen3.8-27B-Q4_K_M.gguf', bytes: 16_810_714_336, sha256: 'e0'.repeat(32) });
    // 16.8 GB of weights plus the 2 GB context allowance, rounded up — the figure that lets a 28 GB machine
    // hear "yes, with 9 GB to spare" instead of "needs 31 GB".
    equal(spec.minRamGb, 19);
    contains(spec.url, 'huggingface.co/lmstudio-community/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-Q4_K_M.gguf');
    equal(spec.fileName, 'Qwen3.8-27B-Q4_K_M.gguf');
});

test('the driver is asked about a card, and an APU carve-out is not a card', () => {
    const sys = compiled('ai/sys');
    equal(sys.parseNvidiaSmiMemory('24564\n'), 24);
    equal(sys.parseNvidiaSmiMemory('8192\n24564\n'), 8, 'the first card');
    equal(sys.parseNvidiaSmiMemory('N/A\n'), undefined);
    equal(sys.parseNvidiaSmiMemory(''), undefined);
    equal(sys.parseAmdgpuVramGb('17163091968'), 17.2);
    equal(sys.parseAmdgpuVramGb('536870912'), undefined, 'a shared-memory figure is not a card');
    // Measured here: this machine's integrated Radeon reports 3.2 GB through the same sysfs file, and offload
    // is *faster* on it — so a figure under 8 GB is ignored and the shared-memory rule applies.
    equal(sys.isDedicatedAmdVram(3.2), false);
    equal(sys.isDedicatedAmdVram(8), true);
    equal(sys.isDedicatedAmdVram(24), true);
});
