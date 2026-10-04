'use strict';

/**
 * Installing llama.cpp from its own prebuilt releases, and deciding which model the user's own server runs.
 *
 * This is the answer to the report that opened it (2026-10-04): *"If the server or the 27B model is not on the
 * host machine the extention must offer to download and install."* The offer is only as good as the file it
 * picks, and picking is exactly the kind of thing that goes wrong invisibly — a release carries 35 assets and
 * most of them are GPU builds, Android builds or the CUDA runtime. Choosing the wrong one downloads 600 MB and
 * then fails with "the server stopped immediately", which says nothing about the real problem.
 *
 * So the choice is pinned here against the **real release list** fetched on 2026-10-04 (build b11384), with
 * the real names and the real sha256 digests, and every branch that must refuse something says so.
 *
 * `localModels.ts` imports nothing but `modelSpecs.ts`, which is what lets this layer reach it without VS Code.
 */

const { test, ok, equal, notOk, contains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');

const models = compiled('ai/localModels');
const specs = compiled('ai/modelSpecs');

/**
 * A trimmed copy of the real API answer (`/repos/ggml-org/llama.cpp/releases`, 2026-10-04). Every name,
 * size and digest is verbatim — the GPU flavours are kept because they are the ones that must never be
 * picked.
 */
const RELEASE = {
    tag_name: 'b11384',
    assets: [
        { name: 'cudart-llama-b11384-bin-ubuntu-cuda-12.8-x64.tar.gz', size: 594377730, digest: 'sha256:aa', browser_download_url: 'https://x/cudart.tar.gz' },
        { name: 'llama-b11384-bin-android-arm64.tar.gz', size: 73920607, digest: 'sha256:bb', browser_download_url: 'https://x/android.tar.gz' },
        { name: 'llama-b11384-bin-linux-arm64-snapdragon.tar.gz', size: 19352608, digest: 'sha256:cc', browser_download_url: 'https://x/snapdragon.tar.gz' },
        { name: 'llama-b11384-bin-macos-arm64.tar.gz', size: 11925800, digest: 'sha256:b8a8d0a086643d1581c6d3d72047d54c9f9772bf997831e8f7dd653bcd22645d', browser_download_url: 'https://x/macos-arm64.tar.gz' },
        { name: 'llama-b11384-bin-macos-x64.tar.gz', size: 11477220, digest: 'sha256:dd', browser_download_url: 'https://x/macos-x64.tar.gz' },
        { name: 'llama-b11384-bin-ubuntu-arm64.tar.gz', size: 13703472, digest: 'sha256:ee', browser_download_url: 'https://x/ubuntu-arm64.tar.gz' },
        { name: 'llama-b11384-bin-ubuntu-cuda-13.4-x64.tar.gz', size: 152375833, digest: 'sha256:ff', browser_download_url: 'https://x/cuda.tar.gz' },
        { name: 'llama-b11384-bin-ubuntu-vulkan-x64.tar.gz', size: 31614424, digest: 'sha256:11', browser_download_url: 'https://x/vulkan.tar.gz' },
        { name: 'llama-b11384-bin-ubuntu-x64.tar.gz', size: 17669671, digest: 'sha256:fb688a481d4d18d7528445f6732a7a68b9bdd46d57e977c369197376c2860bf3', browser_download_url: 'https://x/ubuntu-x64.tar.gz' },
        { name: 'llama-b11384-bin-win-cpu-arm64.zip', size: 12218035, digest: 'sha256:22', browser_download_url: 'https://x/win-arm64.zip' },
        { name: 'llama-b11384-bin-win-cpu-x64.zip', size: 19366974, digest: 'sha256:1a393712446149dc94d52eee13acfb7bb9fdd277217025d5c44407fc272b9e66', browser_download_url: 'https://x/win-x64.zip' },
        { name: 'llama-b11384-bin-win-vulkan-x64.zip', size: 33287513, digest: 'sha256:33', browser_download_url: 'https://x/win-vulkan.zip' },
        { name: 'llama-b11384-ui.tar.gz', size: 3099976, digest: 'sha256:44', browser_download_url: 'https://x/ui.tar.gz' }
    ]
};

/**
 * The list as llama.cpp actually returns it: **`v0.5.0` first, with no binaries at all**, then the nightly
 * builds. This is the shape that made the first real install fail — the endpoint the extension used answered
 * `v0.5.0` and nothing else.
 */
const LIST = [
    { tag_name: 'v0.5.0', assets: [{ name: 'nightly-tag.txt', size: 7, digest: '', browser_download_url: 'https://x/nightly-tag.txt' }] },
    RELEASE
];

test('the release list is asked for, not "latest" — which on llama.cpp carries no binaries', () => {
    const url = models.llamaReleasesApiUrl();
    equal(url, 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20');
    // `/releases/latest` answers the tagged `v0.5.0` release, whose only asset is `nightly-tag.txt`. The
    // first real install reported "llama.cpp publishes no prebuilt server for this machine" because of it.
    notOk(/\/latest$/.test(url), 'the endpoint that returns no binaries is not used');
});

test('the release answer is read the way GitHub writes it', () => {
    const releases = models.parseReleases(LIST);
    equal(releases.length, 2);
    equal(releases[0].tag, 'v0.5.0');
    equal(releases[1].tag, 'b11384');
    equal(releases[1].assets.length, 13);
    const ubuntu = releases[1].assets.find((a) => a.name.endsWith('ubuntu-x64.tar.gz'));
    equal(ubuntu.url, 'https://x/ubuntu-x64.tar.gz');
    equal(ubuntu.bytes, 17669671);
    contains(ubuntu.digest, 'sha256:fb688a48');
});

test('an answer that is not a release list is refused rather than half-read', () => {
    equal(models.parseReleases(undefined), []);
    equal(models.parseReleases({}), []);
    equal(models.parseReleases({ tag_name: 'b1', assets: [] }), [], 'the list endpoint answers an array');
    equal(models.parseReleases([{ assets: [] }]), [], 'no tag, no release');
    equal(models.parseReleases([{ tag_name: 'b1', assets: 'nope' }]), []);
    // An asset with no URL is dropped: it cannot be downloaded, so it must not be offered.
    equal(models.parseReleases([{ tag_name: 'b1', assets: [{ name: 'x.tar.gz', size: 5 }] }])[0].assets.length, 0);
});

test('the newest release with a runnable, verifiable build is the one chosen', () => {
    const choice = models.installReleaseFor(LIST, 'linux', 'x64');
    // Not v0.5.0: it is newer in the list and has no server in it at all.
    equal(choice.tag, 'b11384');
    equal(choice.asset.name, 'llama-b11384-bin-ubuntu-x64.tar.gz');
    equal(models.digestHex(choice.asset.digest), 'fb688a481d4d18d7528445f6732a7a68b9bdd46d57e977c369197376c2860bf3');
});

test('a build with no digest is skipped in favour of an older one that has one', () => {
    // The digest is what the download is checked against, so a releasable-but-unverifiable build is not used —
    // and skipping it must not turn into "llama.cpp has nothing for you".
    const noDigest = { tag_name: 'b9999', assets: [{ name: 'llama-b9999-bin-ubuntu-x64.tar.gz', size: 17669671, digest: '', browser_download_url: 'https://x/newer.tar.gz' }] };
    const choice = models.installReleaseFor([noDigest, RELEASE], 'linux', 'x64');
    equal(choice.tag, 'b11384', 'the older, verifiable build');
});

test('the asset for this machine is the CPU build for its platform, never a GPU one', () => {
    const { assets } = models.parseReleases(LIST)[1];
    equal(models.installAssetFor(assets, 'linux', 'x64').name, 'llama-b11384-bin-ubuntu-x64.tar.gz');
    equal(models.installAssetFor(assets, 'linux', 'arm64').name, 'llama-b11384-bin-ubuntu-arm64.tar.gz');
    equal(models.installAssetFor(assets, 'darwin', 'arm64').name, 'llama-b11384-bin-macos-arm64.tar.gz');
    equal(models.installAssetFor(assets, 'darwin', 'x64').name, 'llama-b11384-bin-macos-x64.tar.gz');
    equal(models.installAssetFor(assets, 'win32', 'x64').name, 'llama-b11384-bin-win-cpu-x64.zip');
    equal(models.installAssetFor(assets, 'win32', 'arm64').name, 'llama-b11384-bin-win-cpu-arm64.zip');
    // Not a GPU build, not the Android one, not the UI tarball, not the CUDA runtime.
    for (const platform of ['linux', 'darwin', 'win32']) {
        for (const arch of ['x64', 'arm64']) {
            const asset = models.installAssetFor(assets, platform, arch);
            notOk(/cuda|rocm|vulkan|sycl|openvino|opencl|cudart|android|xcframework|s390x|ui\.tar/i.test(asset.name), `${asset.name} is a plain build for ${platform}/${arch}`);
        }
    }
});

test('a platform llama.cpp does not publish for is refused, not guessed at', () => {
    equal(models.installReleaseFor(LIST, 'linux', 'riscv64'), undefined);
    equal(models.installReleaseFor(LIST, 'freebsd', 'x64'), undefined);
    equal(models.installReleaseFor([], 'linux', 'x64'), undefined);
    equal(models.installReleaseFor(LIST, 'linux', 'x64') === undefined, false, 'and linux/x64 is not one of them');
});

test('a release with no digest is not verifiable, and is therefore not offered', () => {
    // The digest is what the download is checked against, so `digestHex` has to refuse anything that is not
    // exactly one sha256 — a truncated hash from a future API change must not read as "verified".
    equal(models.digestHex('sha256:fb688a481d4d18d7528445f6732a7a68b9bdd46d57e977c369197376c2860bf3'),
        'fb688a481d4d18d7528445f6732a7a68b9bdd46d57e977c369197376c2860bf3');
    equal(models.digestHex('SHA256:FB688A481D4D18D7528445F6732A7A68B9BDD46D57E977C369197376C2860BF3'),
        'fb688a481d4d18d7528445f6732a7a68b9bdd46d57e977c369197376c2860bf3');
    equal(models.digestHex(''), '');
    equal(models.digestHex('sha256:short'), '');
    equal(models.digestHex('md5:fb688a481d4d18d7528445f6732a7a68b9bdd46d57e977c369197376c2860bf3'), '');
    equal(models.digestHex(undefined), '');
});

test('the archive is unpacked with tar, and the flag follows its shape', () => {
    equal(models.archiveKind('llama-b11384-bin-ubuntu-x64.tar.gz'), 'tar.gz');
    equal(models.archiveKind('llama-b11384-bin-win-cpu-x64.zip'), 'zip');
    // GNU tar needs to be told about gzip; bsdtar (macOS, and Windows' tar.exe) infers it, but `-xzf` on a
    // tarball works on all of them, so the tarball branch is the explicit one.
    equal(models.extractArgs('/tmp/a.tar.gz', '/out').join(' '), '-xzf /tmp/a.tar.gz -C /out');
    equal(models.extractArgs('/tmp/a.zip', '/out').join(' '), '-xf /tmp/a.zip -C /out');
});

test('the binary is found in the archive by its own listing, shallowest first', () => {
    // Real `tar -tzf` output for the Linux tarball (2026-10-04): everything lives in one folder named after
    // the tag, beside the shared libraries the binary needs — so the folder is what has to be remembered.
    const listing = [
        'llama-b11384/',
        'llama-b11384/libggml-cpu-cooperlake.so',
        'llama-b11384/llama-completion',
        'llama-b11384/llama-server',
        'llama-b11384/libllama-server-impl.so',
        'llama-b11384/LICENSE'
    ];
    equal(models.pickBinaryFromListing(listing, 'linux'), 'llama-b11384/llama-server');
    equal(models.pickBinaryFromListing(['a/bin/llama-server', 'llama-server'], 'linux'), 'llama-server', 'the shallowest wins');
    equal(models.pickBinaryFromListing(['llama-b11384/llama-server.exe'], 'win32'), 'llama-b11384/llama-server.exe');
    equal(models.pickBinaryFromListing(['llama-b11384/llama-server'], 'win32'), undefined, 'no .exe, no match on Windows');
    equal(models.pickBinaryFromListing([], 'linux'), undefined);
    equal(models.llamaBinaryName('win32'), 'llama-server.exe');
    equal(models.llamaBinaryName('linux'), 'llama-server');
});

test('the offer says what will be downloaded and what it costs', () => {
    const { assets } = models.parseReleases(LIST)[1];
    const line = models.installOfferLine(models.installAssetFor(assets, 'linux', 'x64'));
    contains(line, 'llama-b11384-bin-ubuntu-x64.tar.gz');
    // The size is the extension's own decimal wording (`formatBytes`), so GitHub's 17.7 MB reads as 18 MB —
    // what matters is that the offer names the file and says what it costs.
    contains(line, '18 MB');
});

// ---------------------------------------------------------------- which model the own server runs

const exists = (present) => (p) => present.includes(p);

test('a model already chosen or already downloaded needs no question', () => {
    // The setting wins: it is the user's own last choice for this server.
    equal(
        models.ownServerModelPreference({ pinned: '/m/a.gguf', known: '/m/27b.gguf', exists: exists(['/m/a.gguf', '/m/27b.gguf']) }),
        { path: '/m/a.gguf', source: 'setting' }
    );
    // No setting: the verified 27B in the extension's storage is next.
    equal(
        models.ownServerModelPreference({ pinned: '', known: '/m/27b.gguf', exists: exists(['/m/27b.gguf']) }),
        { path: '/m/27b.gguf', source: 'known' }
    );
    // A setting pointing at something that is *gone* falls through rather than failing: the file was deleted
    // and the known model is still there.
    equal(
        models.ownServerModelPreference({ pinned: '/m/deleted.gguf', known: '/m/27b.gguf', exists: exists(['/m/27b.gguf']) }),
        { path: '/m/27b.gguf', source: 'known' }
    );
    // A path that is not a model is not one: the setting is shared with the bundled runtime, and this flow
    // must not try to serve a text file with llama.cpp.
    equal(
        models.ownServerModelPreference({ pinned: '/m/notes.txt', known: '', exists: exists(['/m/notes.txt']) }),
        { source: 'none' }
    );
});

test('the built-in runtime\'s own model is not an answer to which model THIS server runs', () => {
    // Found on a real machine 2026-10-04: `modelPath` held the built-in runtime's shipped 7B (the Designer's
    // copy of it), so "the setting wins" meant the user's own llama-server silently started a 4.4 GB model
    // when the whole request was about the 27B. A pinned file the bundled runtime knows by name falls through
    // to the 27B, and then to the picker — which still lists it as a model to *choose*.
    const pinned = '/home/niel/.config/Code/User/globalStorage/grumpy.avalonia-designer/models/qwen2.5-coder-7b-instruct-q4_k_m.gguf';
    equal(
        models.ownServerModelPreference({ pinned, pinnedIsBundled: true, known: '/gs/models/Qwen3.8-27B-Q4_K_M.gguf', exists: exists([pinned, '/gs/models/Qwen3.8-27B-Q4_K_M.gguf']) }),
        { path: '/gs/models/Qwen3.8-27B-Q4_K_M.gguf', source: 'known' },
        'the 27B, not the built-in runtime\'s 7B'
    );
    equal(
        models.ownServerModelPreference({ pinned, pinnedIsBundled: true, known: '', exists: exists([pinned]) }),
        { source: 'none' },
        'and with no 27B yet, the question is asked instead of starting the wrong model'
    );
    // The same file is a perfectly good answer when it is the user's own choice for this server (`llamaServer
    // ModelPath`), which is what `pinnedIsBundled: false` means.
    equal(
        models.ownServerModelPreference({ pinned, pinnedIsBundled: false, known: '', exists: exists([pinned]) }),
        { path: pinned, source: 'setting' }
    );
});

test('nothing known means ask — the picker or the download offer, never a guess', () => {
    equal(models.ownServerModelPreference({ pinned: '', known: '', exists: () => false }), { source: 'none' });
    equal(
        models.ownServerModelPreference({ pinned: '/m/a.gguf', known: '/m/27b.gguf', exists: () => false }),
        { source: 'none' },
        'paths that are not there are not answers'
    );
});

// ---------------------------------------------------------------- the 27B itself

test('the known 27B is the one the Designer names, with the numbers Hugging Face publishes', () => {
    const spec = specs.OWN_SERVER_SPECS[0];
    ok(spec, 'there is a known model for the user\'s own server');
    equal(spec.fileName, 'Qwen3.8-27B-Q4_K_M.gguf');
    equal(spec.url, 'https://huggingface.co/lmstudio-community/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-Q4_K_M.gguf');
    // Verified twice on 2026-10-04: the Hub's own API (`?blobs=true`) and this machine's LM Studio download
    // record. A wrong number here is a corrupt download for every user who asks for this model.
    equal(spec.bytes, 16810714336);
    equal(spec.sha256, 'e00082f779fa385cee8c68a3ec8833a75778cc87272240b942f74e0b8243e520');
    ok(spec.sha256.length === 64, 'a full sha256');
    equal(spec.id, 'qwen3.8-27b-q4_k_m');
});

test('a copy of the 27B under any other name is still the 27B', () => {
    // The file the user already has may be called anything; the name in the folder is what decides whether
    // the picker says "download 15.7 GB" or "use the one you already have".
    equal(specs.ownServerSpecByFileName('/home/x/.lmstudio/models/lmstudio-community/Qwen3.8-27B-GGUF/Qwen3.8-27B-Q4_K_M.gguf').id, 'qwen3.8-27b-q4_k_m');
    equal(specs.ownServerSpecByFileName('Qwen3.8-27B-Q4_K_M.gguf').id, 'qwen3.8-27b-q4_k_m');
    equal(specs.ownServerSpecByFileName('qwen3.8-27b-q4_k_m.GGUF').id, 'qwen3.8-27b-q4_k_m', 'case does not matter');
    equal(specs.ownServerSpecByFileName('Bonsai-27B-Q1_0.gguf'), undefined, 'a different 27B is a different model');
    equal(specs.ownServerSpecByFileName('mmproj-Qwen3.8-27B-BF16.gguf'), undefined, 'the vision projector is not the model');
});

test('the 27B is not one of the bundled runtime\'s models', () => {
    // The bundled picker offers two 4.4 GB entries on purpose; a 16.8 GB one appearing there would be a
    // different product decision, so the two lists are kept apart.
    equal(specs.MODEL_SPECS.some((s) => s.id === 'qwen3.8-27b-q4_k_m'), false);
    equal(specs.OWN_SERVER_SPECS.length, 1);
});

test('a failure says what IS answering, when something is', () => {
    // The 2026-10-04 report, in one sentence: the settings pointed at LM Studio's dead 1234 while a
    // llama-server was holding port 8080. "No server answered" was true and useless; this is the rest of it.
    const hint = models.endpointMismatchHint('http://127.0.0.1:1234/v1', {
        port: 8080, modelId: 'qwen3-coder-local', modelPath: '/home/niel/.cache/huggingface/hub/x/qwen3-coder-30b-a3b-instruct-q4_k_s.gguf'
    });
    contains(hint, 'llama-server IS answering on port 8080');
    contains(hint, 'qwen3-coder-30b-a3b-instruct-q4_k_s.gguf');
    contains(hint, 'http://127.0.0.1:1234/v1');

    // Nothing is running: silence is the honest answer, not a guess about which port was meant.
    equal(models.endpointMismatchHint('http://127.0.0.1:1234/v1', undefined), '');
    // It is answering *there*: the address was not the problem, so there is nothing to add.
    equal(models.endpointMismatchHint('http://127.0.0.1:8080/v1', { port: 8080, modelId: 'm' }), '');
    // An unreadable endpoint is still named, as "no address" rather than as an empty gap.
    contains(models.endpointMismatchHint('', { port: 8080, modelId: 'm' }), 'the settings point at no address');
    contains(models.endpointMismatchHint('', { port: 8080, modelId: 'm' }), '(m)');
});

// ------------------------------------------------ "the extension must not rely on the user"

test('a request that had nowhere to go is rescued from a llama-server this machine already has', () => {
    const noAnswer = 'No server answered at http://127.0.0.1:1234/v1 — is the local model server running (and the endpoint correct)?';
    // Nothing is listening on the configured local address, and a llama-server binary is here: start it.
    equal(models.endpointRescuePlan({ endpoint: 'http://127.0.0.1:1234/v1', backend: 'external', message: noAnswer, binaryFound: true }), 'start-own');
    // One is already answering elsewhere: use that one rather than starting a second copy of the weights.
    equal(models.endpointRescuePlan({ endpoint: 'http://127.0.0.1:1234/v1', backend: 'external', message: noAnswer, binaryFound: true, runningPort: 8080 }), 'use-running');
    // No binary at all: offer the install, which is the other half of the request.
    equal(models.endpointRescuePlan({ endpoint: 'http://127.0.0.1:1234/v1', backend: 'external', message: noAnswer, binaryFound: false }), 'offer-install');
    // …unless llama.cpp publishes nothing for this platform, in which case offering it would be a lie.
    equal(models.endpointRescuePlan({ endpoint: 'http://127.0.0.1:1234/v1', backend: 'external', message: noAnswer, binaryFound: false, canInstall: false }), 'none');
});

test('and left alone when starting a server is not the answer', () => {
    const noAnswer = 'No server answered at http://127.0.0.1:1234/v1';
    // A **remote** endpoint that is down must not make this machine start a process the user did not ask for:
    // they pointed at another computer on purpose.
    equal(models.endpointRescuePlan({ endpoint: 'http://build-box:8080/v1', backend: 'external', message: noAnswer, binaryFound: true }), 'none');
    equal(models.endpointRescuePlan({ endpoint: 'https://api.example.com/v1', backend: 'external', message: noAnswer, binaryFound: true, runningPort: 8080 }), 'none');
    // Only `external` is this path's business: the bundled runtime explains its own failures, and LM Studio's
    // are LM Studio's.
    equal(models.endpointRescuePlan({ endpoint: 'http://127.0.0.1:1234/v1', backend: 'bundled', message: noAnswer, binaryFound: true }), 'none');
    equal(models.endpointRescuePlan({ endpoint: 'http://127.0.0.1:1234/v1', backend: 'off', message: noAnswer, binaryFound: true }), 'none');
    // Not every failure is "nothing is listening": a 400, a truncated answer or a cancel is not cured by
    // starting a server, and retrying it would only waste the user's time.
    for (const message of [
        'The server answered HTTP 400: context overflow',
        'The request to http://127.0.0.1:1234/v1 was cancelled or timed out.',
        'Could not parse the answer'
    ]) {
        equal(models.endpointRescuePlan({ endpoint: 'http://127.0.0.1:1234/v1', backend: 'external', message, binaryFound: true }), 'none', message);
    }
});

test('"no server answered" is one decision, shared by the message and the rescue', () => {
    const assistant = compiled('ai/assistant');
    ok(assistant.isNoAnswerError('fetch failed'));
    ok(assistant.isNoAnswerError('connect ECONNREFUSED 127.0.0.1:1234'));
    ok(assistant.isNoAnswerError(assistant.describeError(new TypeError('fetch failed'), 'http://x/v1')), 'the sentence it writes is recognised again');
    notOk(assistant.isNoAnswerError('The server answered HTTP 500.'));
    notOk(assistant.isNoAnswerError(''));
    notOk(assistant.isNoAnswerError(undefined));
});

test('a llama.cpp this extension installed is found without the setting that points at it', () => {
    // The pure half: the extra candidates are tried after the usual build folders, so a hand-built llama.cpp
    // still wins over the copy we fetched.
    const exists = new Set(['/usr/local/bin/llama-server']);
    equal(
        models.findLlamaServer({
            homeDir: '/home/u',
            pathValue: '',
            preferred: '',
            extra: ['/gs/llama.cpp/b11384/llama-b11384/llama-server'],
            exists: (p) => exists.has(p)
        }),
        '/usr/local/bin/llama-server',
        'the user’s own build is preferred'
    );
    equal(
        models.findLlamaServer({
            homeDir: '/home/u',
            pathValue: '',
            preferred: '',
            extra: ['/gs/llama.cpp/b11384/llama-b11384/llama-server'],
            exists: (p) => p.startsWith('/gs/')
        }),
        '/gs/llama.cpp/b11384/llama-b11384/llama-server',
        'and ours is found when there is no other'
    );
    // A path the user set that is gone still refuses to fall back — that is their setting, and quietly running
    // a different binary would be worse than saying so.
    equal(
        models.findLlamaServer({ homeDir: '/home/u', pathValue: '', preferred: '/gone/llama-server', extra: ['/gs/llama-server'], exists: (p) => p === '/gs/llama-server' }),
        undefined
    );
});

test('a release fetched by the extension is found inside its own folder', () => {
    // What the real install produced on 2026-10-04: `/…/llama.cpp/b11385/llama-b11385/llama-server`. Both
    // shapes are offered because the archive's own root has moved between builds, and this is the layout that
    // decides whether a fetched llama.cpp counts as "installed" or gets offered again.
    const nested = models.installedLlamaServerCandidates('/gs/llama.cpp/b11385', ['llama-b11385', 'LICENSE', 'llama-cli'], 'linux');
    equal(nested[0], '/gs/llama.cpp/b11385/llama-server', 'the flat shape is tried first');
    ok(nested.includes('/gs/llama.cpp/b11385/llama-b11385/llama-server'), 'and the nested shape is offered');
    // Every entry is offered, including ones that are files: a flat listing cannot tell, and guessing from the
    // name meant a release whose listing began with `llama-cli` never reached the real subfolder.
    ok(nested.includes('/gs/llama.cpp/b11385/llama-cli/llama-server'), 'no name heuristic');
    ok(!nested.includes('/gs/llama.cpp/b11385/llama-server/llama-server'), 'the binary itself is not a folder');

    const flat = models.installedLlamaServerCandidates('/gs/llama.cpp/b1', ['llama-server', 'libllama.so'], 'linux');
    equal(flat[0], '/gs/llama.cpp/b1/llama-server', 'a flat archive is found directly');
    // The caller checks existence, so the first real hit wins: that is what makes the list safe.
    equal(flat.find((c) => c === '/gs/llama.cpp/b1/llama-server'), '/gs/llama.cpp/b1/llama-server');

    equal(
        models.installedLlamaServerCandidates('C:\\gs\\llama.cpp\\b1', ['llama-server.exe'], 'win32')[0],
        'C:\\gs\\llama.cpp\\b1/llama-server.exe'
    );
    // A trailing separator must not double up.
    equal(models.installedLlamaServerCandidates('/gs/b1/', ['llama-b1'], 'linux')[1], '/gs/b1/llama-b1/llama-server');
});

// ------------------------------------------------ Windows is not Linux (audited 2026-10-04)

test('the start target defaults by platform, and an explicit choice always wins', () => {
    // systemd is Linux-only. The old default asked for a unit everywhere, so on Windows the first Start failed
    // against a service manager that does not exist and only then fell back to a process.
    equal(models.resolveStartTarget(undefined, 'linux'), 'unit');
    equal(models.resolveStartTarget('', 'linux'), 'unit');
    equal(models.resolveStartTarget(undefined, 'win32'), 'process');
    equal(models.resolveStartTarget(undefined, 'darwin'), 'process');
    equal(models.resolveStartTarget('process', 'linux'), 'process', 'an explicit choice is honoured');
    equal(models.resolveStartTarget('unit', 'win32'), 'unit', 'even a pointless one');
    equal(models.resolveStartTarget('PROCESS', 'linux'), 'process');
    equal(models.resolveStartTarget('nonsense', 'win32'), 'process', 'garbage is the platform default');
});

test('who holds a port can only be inspected on Linux, and off Linux that is said out loud', () => {
    equal(models.canInspectServerOwner('linux'), true);
    equal(models.canInspectServerOwner('win32'), false);
    equal(models.canInspectServerOwner('darwin'), false);
});

test('the scan walks the other drives on Windows instead of mount points', () => {
    const exists = (p) => ['D:\\', 'E:\\'].includes(p);
    equal(models.windowsDriveRoots(exists), ['D:\\', 'D:\\models', 'E:\\', 'E:\\models']);
    // C: is the system drive: its interesting folders are the user's own, which are roots already. Walking it
    // would spend the scan's whole budget on Windows and Program Files.
    notOk(models.windowsDriveRoots(exists).some((r) => r.startsWith('C:')), 'no C:');

    const drives = models.windowsDriveRoots(exists);
    const win = models.scanRoots('C:/Users/me', 'win32', drives);
    ok(win.includes('C:/Users/me/Downloads'), 'the user’s own folders are still roots');
    ok(win.includes('D:\\models'), 'and so are the other drives');
    notOk(win.includes('/media'), 'no Linux mount points on Windows');
    notOk(win.includes('/Volumes'), 'nor macOS ones');

    // Linux and macOS are unchanged: the mount roots are how a removable drive is reached there.
    const lin = models.scanRoots('/home/me', 'linux');
    ok(lin.includes('/media') && lin.includes('/run/media') && lin.includes('/mnt'));
    // macOS shares the Unix list on purpose: the walker skips roots that do not exist, and `/Volumes` is the
    // one that matters there. Keeping one list is what stops the three Unix platforms drifting apart.
    const mac = models.scanRoots('/Users/me', 'darwin');
    ok(mac.includes('/Volumes'), 'macOS reaches external volumes');
});

test('the model search on Windows uses those roots', () => {
    const search = compiled('ai/localSearch');
    const roots = search.defaultModelRoots({ home: '/home/me', platform: 'win32' });
    ok(roots.some((r) => r.includes('Downloads')), 'the user folders are searched');
    notOk(roots.includes('/media'), 'and the Linux mount points are not pretended to exist');
});
