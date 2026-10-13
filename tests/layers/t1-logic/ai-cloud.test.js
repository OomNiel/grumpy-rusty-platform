'use strict';

/**
 * The cloud hand-off provider: the settings that describe it, the key that authenticates it, and the header that
 * carries the key.
 *
 * Agnes (`https://apihub.agnes-ai.com/v1`) is the reason this exists: the hand-off already spoke
 * `/chat/completions`, but the request had no `Authorization` header, so a cloud API could only ever answer 401.
 * These tests pin the three things that fix has to get right — the key is stored per endpoint, it is sent as a
 * bearer token, and it never appears anywhere it could be read back.
 */

const { test, ok, notOk, equal, contains, notContains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');

const { normalizeHandoff, handoffKeyName, envFileKey, importableKeyFiles } = compiled('ai/pool');
const { scanAgents, chooseAgent, describeAgent } = compiled('ai/agents');

/** A real env file, of the shape `~/.config/jcode/openai-compatible.env` has. */
const ENV_FILE = [
    '# Agnes',
    'JCODE_OPENAI_COMPAT_API_BASE=https://apihub.agnes-ai.com/v1',
    'JCODE_OPENAI_COMPAT_DEFAULT_MODEL=agnes-2.5-flash',
    'OPENAI_COMPAT_API_KEY=sk-test-not-a-real-key',
    ''
].join('\n');

test('a cloud provider is a setting pair, and its key is not one of them', () => {
    const cfg = normalizeHandoff({
        handoff: 'pool',
        cloudEndpoint: 'https://apihub.agnes-ai.com/v1',
        cloudModel: 'agnes-2.5-flash'
    });
    equal(cfg.cloudEndpoint, 'https://apihub.agnes-ai.com/v1', 'the endpoint is kept');
    equal(cfg.cloudModel, 'agnes-2.5-flash', 'and the model');
    notOk(
        Object.keys(cfg).some((k) => /key|token|secret/i.test(k)),
        'no field of the config is a credential — the key lives in secret storage'
    );

    // A bare host is accepted and normalised, so the two ways of writing the same provider are one provider.
    equal(
        normalizeHandoff({ cloudEndpoint: 'https://apihub.agnes-ai.com' }).cloudEndpoint,
        'https://apihub.agnes-ai.com/v1',
        'a missing /v1 is added'
    );
    equal(normalizeHandoff({ cloudEndpoint: '   ' }).cloudEndpoint, '', 'a blank endpoint means no cloud provider');
    equal(normalizeHandoff({}).cloudModel, '', 'and both default to empty');
});

test('a key is stored per endpoint, so one provider cannot be sent another\'s token', () => {
    const agnes = handoffKeyName('https://apihub.agnes-ai.com/v1');
    const other = handoffKeyName('https://api.example.com/v1');
    notOk(agnes === other, 'two providers do not share one secret');
    contains(agnes, 'apihub.agnes-ai.com', 'the endpoint is part of the storage name');
    // The same provider written two ways must land on the same secret, or setting the key once would not be
    // enough for the request that goes out.
    equal(handoffKeyName('https://apihub.agnes-ai.com'), agnes, 'and normalisation happens before the key name');
});

test('a key is read out of an env file, and nothing else is', () => {
    equal(envFileKey(ENV_FILE), 'sk-test-not-a-real-key', 'the OpenAI-compatible key');
    equal(envFileKey('OPENAI_API_KEY="quoted"'), 'quoted', 'quotes are stripped');
    equal(envFileKey('export API_KEY=exported'), 'exported', 'an `export` prefix is allowed');
    equal(envFileKey('SOMETHING_ELSE=value'), undefined, 'an unrelated variable is not a key');
    equal(envFileKey(''), undefined, 'and an empty file has none');
    // The one that matters for a file like Agnes's: the *endpoint* variable must never be mistaken for a key.
    equal(envFileKey('JCODE_OPENAI_COMPAT_API_BASE=https://apihub.agnes-ai.com/v1'), undefined, 'an API base is not a key');
});

test('the files worth offering are few and named', () => {
    const files = importableKeyFiles('/home/someone');
    ok(files.length >= 1, 'at least one path is offered');
    ok(files.every((f) => f.startsWith('/home/someone')), 'all under the home it was given');
    contains(files.join(' '), 'jcode', 'including the layout this machine has');
});

test('the key travels as a bearer token — and no key means no header at all', async () => {
    // The whole reason a cloud API could not be used before this: the request had no `Authorization` header, so
    // Agnes could only answer 401. Asserted on the real client with an injected fetch, so what is checked is the
    // request the extension would actually send.
    const { chatDetailed, normalizeAssistantConfig } = compiled('ai/assistant');
    const cfg = normalizeAssistantConfig({
        backend: 'external',
        endpoint: 'https://apihub.agnes-ai.com/v1',
        model: 'agnes-2.5-flash'
    });
    const answer = { choices: [{ message: { content: 'done' } }] };
    const capture = async (url, init) => {
        capture.url = String(url);
        capture.headers = (init ?? {}).headers ?? {};
        return { ok: true, json: async () => answer };
    };

    const withKey = await chatDetailed(cfg, [{ role: 'user', content: 'hi' }], { fetchImpl: capture, apiKey: 'sk-secret' });
    equal(capture.url, 'https://apihub.agnes-ai.com/v1/chat/completions', 'the cloud endpoint is called');
    equal(capture.headers.Authorization, 'Bearer sk-secret', 'with the key as a bearer token');
    equal(withKey.text, 'done', 'and the answer is read back');
    equal(capture.headers['Content-Type'], 'application/json', 'the body is still JSON');

    // No key: no header, so a local server is unaffected and a cloud API fails with its own 401 rather than with
    // something the extension invented.
    await chatDetailed(cfg, [{ role: 'user', content: 'hi' }], { fetchImpl: capture });
    notOk('Authorization' in capture.headers, 'an absent key adds no Authorization header');

    // An empty key is absent, not a header with nothing in it — a server would reject `Bearer `.
    await chatDetailed(cfg, [{ role: 'user', content: 'hi' }], { fetchImpl: capture, apiKey: '' });
    notOk('Authorization' in capture.headers, 'and an empty key is the same as none');
});

test('a configured cloud API appears in the scan, usable only once it has a key', async () => {
    // Only the cloud host answers here, so the localhost probes stay silent — otherwise every local port would
    // look like a running server and the "nothing usable is chosen" assertion would be measuring the stub.
    const fetchImpl = async (url) => {
        if (String(url).startsWith('https://apihub.agnes-ai.com')) {
            return { ok: true, json: async () => ({ data: [{ id: 'agnes-2.5-flash' }] }) };
        }
        return { ok: false, json: async () => ({}) };
    };
    const without = await scanAgents({
        env: { PATH: '/nonexistent' },
        cloud: { endpoint: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.5-flash', hasKey: false },
        fetchImpl
    });
    const listed = without.find((a) => a.endpoint === 'https://apihub.agnes-ai.com/v1');
    ok(listed, 'the cloud API is listed even with no key');
    notOk(listed.available, 'but it is not usable yet');
    contains(describeAgent(listed), 'no API key stored yet', 'and says what is missing');
    notOk(chooseAgent(without), 'so an unauthenticated cloud API is never picked automatically');

    const withKey = await scanAgents({
        env: { PATH: '/nonexistent' },
        cloud: { endpoint: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.5-flash', hasKey: true },
        fetchImpl
    });
    const usable = withKey.find((a) => a.endpoint === 'https://apihub.agnes-ai.com/v1');
    ok(usable.available, 'with a key it is available');
    equal(usable.model, 'agnes-2.5-flash', 'and named by its model');
    equal(chooseAgent(withKey).id, usable.id, 'and it can be chosen');
    // A cloud API is only *ever* an answering agent: it cannot be given the project to edit.
    equal(usable.kind, 'openai', 'and it is never driven as an editor');
    notContains(describeAgent(usable), 'build what it changes', 'which the wording says');
});
