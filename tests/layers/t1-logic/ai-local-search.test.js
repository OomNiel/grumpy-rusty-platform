'use strict';

/**
 * "Is this model already on the machine?" — the search that runs before a download.
 *
 * The behaviour worth pinning is the *decision*: a file is only adopted when its SHA-256 matches the spec,
 * so a same-named `.gguf` of the wrong quantisation is refused and a differently-named copy of the right
 * weights is accepted. The tests drive a real temporary directory rather than a mock filesystem, because
 * the thing under test is a walk over real `readdir`/`stat` results — and because the module has no `vscode`
 * import, which is exactly what lets t1 reach it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { test, ok, equal, notOk } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');

const search = compiled('ai/localSearch');
const specs = compiled('ai/modelSpecs');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function makeDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rusty-local-search-'));
}

function writeFile(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

/** A spec shaped like the real ones, sized for a temp file. */
function specFor(fileName, content) {
    const buf = Buffer.from(content);
    return {
        id: 'test-model',
        label: 'Test model',
        detail: '',
        fileName,
        url: 'https://example.invalid/model.gguf',
        bytes: buf.length,
        sha256: sha256(buf),
        minRamGb: 0
    };
}

test('an exact filename with the right hash is found', async () => {
    const dir = makeDir();
    try {
        const spec = specFor('qwen-test-q4_k_m.gguf', 'the-right-weights');
        const file = writeFile(path.join(dir, 'qwen-test-q4_k_m.gguf'), 'the-right-weights');
        equal(await search.findLocalCopy(spec, { roots: [dir] }), file);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the same bytes under another name are found too', async () => {
    const dir = makeDir();
    try {
        const spec = specFor('qwen-test-q4_k_m.gguf', 'the-right-weights');
        const renamed = writeFile(path.join(dir, 'copy of my model.gguf'), 'the-right-weights');
        equal(await search.findLocalCopy(spec, { roots: [dir] }), renamed);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a same-named file with the wrong contents is refused', async () => {
    const dir = makeDir();
    try {
        const spec = specFor('qwen-test-q4_k_m.gguf', 'the-right-weights');
        writeFile(path.join(dir, 'qwen-test-q4_k_m.gguf'), 'a different quantisation');
        notOk(await search.findLocalCopy(spec, { roots: [dir] }), 'the hash must be what decides');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the right weights are found even next to a wrong same-named one', async () => {
    const dir = makeDir();
    try {
        const spec = specFor('qwen-test-q4_k_m.gguf', 'the-right-weights');
        writeFile(path.join(dir, 'a', 'qwen-test-q4_k_m.gguf'), 'wrong');
        const good = writeFile(path.join(dir, 'b', 'qwen-test-q4_k_m.gguf'), 'the-right-weights');
        equal(await search.findLocalCopy(spec, { roots: [dir] }), good);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a non-gguf file is never a candidate', async () => {
    const dir = makeDir();
    try {
        const spec = specFor('qwen-test-q4_k_m.gguf', 'the-right-weights');
        writeFile(path.join(dir, 'qwen-test-q4_k_m.txt'), 'the-right-weights');
        writeFile(path.join(dir, 'mmproj-qwen-test-q4_k_m.gguf'), 'the-right-weights');
        notOk(await search.findLocalCopy(spec, { roots: [dir] }));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('an empty or missing root yields nothing', async () => {
    const dir = makeDir();
    try {
        const spec = specFor('m.gguf', 'x');
        notOk(await search.findLocalCopy(spec, { roots: [dir, path.join(dir, 'nope')] }));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('cancellation stops the search', async () => {
    const dir = makeDir();
    try {
        const spec = specFor('m.gguf', 'the-right-weights');
        writeFile(path.join(dir, 'm.gguf'), 'the-right-weights');
        notOk(await search.findLocalCopy(spec, { roots: [dir], isCancelled: () => true }));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('an expired budget gives up rather than scanning for ever', async () => {
    const dir = makeDir();
    try {
        const spec = specFor('m.gguf', 'the-right-weights');
        writeFile(path.join(dir, 'm.gguf'), 'the-right-weights');
        notOk(await search.findLocalCopy(spec, { roots: [dir], budgetMs: 0 }));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('progress names the folders it is looking in', async () => {
    const dir = makeDir();
    try {
        const spec = specFor('m.gguf', 'nothing here');
        const lines = [];
        await search.findLocalCopy(spec, { roots: [dir], onProgress: (m) => lines.push(m) });
        ok(lines.length > 0, 'at least one progress line');
        ok(lines.some((l) => l.includes('looking for m.gguf')), `expected a "looking for" line, got ${JSON.stringify(lines)}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('adopting a copy puts the bytes where the runtime expects them', async () => {
    const dir = makeDir();
    try {
        const source = writeFile(path.join(dir, 'downloads', 'm.gguf'), 'weights');
        const dest = path.join(dir, 'storage', 'models', 'm.gguf');
        const how = search.adoptLocalCopy(dest, source);
        equal(fs.readFileSync(dest, 'utf8'), 'weights');
        ok(how === 'hard link' || how === 'copy', `unexpected adoption: ${how}`);
        if (how === 'hard link') {
            equal(fs.statSync(dest).ino, fs.statSync(source).ino, 'a hard link shares the inode');
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('adopting replaces a stale file already at the destination', async () => {
    const dir = makeDir();
    try {
        const source = writeFile(path.join(dir, 'downloads', 'm.gguf'), 'good');
        const dest = writeFile(path.join(dir, 'storage', 'models', 'm.gguf'), 'stale-partial');
        search.adoptLocalCopy(dest, source);
        equal(fs.readFileSync(dest, 'utf8'), 'good');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('sha256File hashes a real file', async () => {
    const dir = makeDir();
    try {
        const file = writeFile(path.join(dir, 'x.bin'), 'hello');
        equal(await search.sha256File(file), sha256(Buffer.from('hello')));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// The ranking is the pure half of the same decision, and lives in `modelSpecs`.
test('rankLocalCandidates puts the name match first and drops the implausible', () => {
    const spec = specs.MODEL_SPECS[0];
    const ranked = specs.rankLocalCandidates(
        [
            { file: '/a/other.gguf', name: 'other.gguf', bytes: spec.bytes + 10 },
            { file: '/b/named.gguf', name: spec.fileName, bytes: spec.bytes + 999 },
            { file: '/c/same-size.gguf', name: 'same-size.gguf', bytes: spec.bytes },
            { file: '/d/nothing.gguf', name: 'nothing.gguf', bytes: 1 }
        ],
        spec
    );
    equal(ranked.map((c) => c.name), [spec.fileName, 'same-size.gguf']);
});

test('rankLocalCandidates is empty when nothing matches', () => {
    const spec = specs.MODEL_SPECS[0];
    equal(specs.rankLocalCandidates([{ file: '/x/a.gguf', name: 'a.gguf', bytes: 7 }], spec), []);
});

// The point of the feature is to search the *machine*, so the roots have to include where drives appear.
test('the search roots cover the usual external-drive mount points', () => {
    const localModels = compiled('ai/localModels');
    const roots = localModels.scanRoots('/home/someone');
    for (const root of ['/media', '/run/media', '/mnt', '/Volumes']) {
        ok(roots.includes(root), `the roots must include ${root}`);
    }
    ok(roots.some((r) => r.startsWith('/home/someone/Downloads')), 'and the home folders');
});

// The reported case (2026-10-04): a `.gguf` already on the PC, inside another extension's storage.
test('the VS Code user-data folders are found per platform', () => {
    const linux = search.vscodeUserDirs('/home/x', 'linux');
    ok(linux.includes('/home/x/.config/Code/User'), 'linux stable');
    ok(linux.includes('/home/x/.vscode-server/data/User'), 'a remote window keeps its storage here');

    const mac = search.vscodeUserDirs('/Users/x', 'darwin');
    ok(mac.includes('/Users/x/Library/Application Support/Code/User'), 'macOS');

    const win = search.vscodeUserDirs('C:\\Users\\x', 'win32', 'C:\\Users\\x\\AppData\\Roaming');
    ok(win.some((d) => d.endsWith('Code\\User')), `windows: ${JSON.stringify(win)}`);
    equal(search.vscodeUserDirs('C:\\Users\\x', 'win32', '').length, 0, 'no APPDATA, nothing to guess');
});

test('only an extension models folder counts as a model root', () => {
    const dir = makeDir();
    try {
        const userDir = path.join(dir, 'Code', 'User');
        const wanted = path.join(userDir, 'globalStorage', 'grumpy.avalonia-designer', 'models');
        fs.mkdirSync(wanted, { recursive: true });
        fs.mkdirSync(path.join(userDir, 'globalStorage', 'other.extension', 'webview'), { recursive: true });
        equal(search.globalStorageModelFolders([userDir]), [wanted]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a model in another extension storage is found and used', async () => {
    const dir = makeDir();
    try {
        const content = 'the-shipped-weights';
        const spec = specFor('qwen-test-q4_k_m.gguf', content);
        const userDir = path.join(dir, '.config', 'Code', 'User');
        const models = path.join(userDir, 'globalStorage', 'grumpy.avalonia-designer', 'models');
        const file = writeFile(path.join(models, spec.fileName), content);

        // The exact reported scenario: the file is on the PC, in another extension's storage.
        const roots = search.globalStorageModelFolders(search.vscodeUserDirs(dir, 'linux'));
        equal(await search.findLocalCopy(spec, { roots }), file);

        // and the roots production actually uses include that folder
        ok(search.defaultModelRoots({ home: dir, platform: 'linux' }).includes(models),
            'defaultModelRoots must include extension storage');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// A machine can have models and no working LM Studio: the `lms` binary is installed but its daemon will not
// start, so `discover()` lists nothing while `~/.lmstudio/models` is full. Then the files are the answer.
test('files inside LM Studio are offered only when LM Studio has models to offer', () => {
    const localModels = compiled('ai/localModels');
    const files = [
        { file: '/home/x/Downloads/a.gguf', inLmStudio: false },
        { file: '/home/x/.lmstudio/models/b.gguf', inLmStudio: true },
        { file: '/home/x/.lmstudio/models/c.gguf', inLmStudio: true }
    ];

    // LM Studio is answering: its own list already has those weights, so they are not shown twice.
    equal(localModels.filesOfferedForSelection(files, true).map((f) => f.file), ['/home/x/Downloads/a.gguf']);

    // LM Studio is not answering: every file on the machine is offered.
    equal(localModels.filesOfferedForSelection(files, false).map((f) => f.file), files.map((f) => f.file));

    // The caller's array is never rearranged in place.
    equal(files.map((f) => f.file), ['/home/x/Downloads/a.gguf', '/home/x/.lmstudio/models/b.gguf', '/home/x/.lmstudio/models/c.gguf']);
    equal(localModels.filesOfferedForSelection([], false), []);
});
