'use strict';

/**
 * The model-agnostic core of the assistant.
 *
 * This module has no idea the target language is Rust: it normalises the settings, parses what a local
 * OpenAI-compatible server sends back (streamed or not), pulls the code out of a model's prose, and decides
 * how a prompt and its answer share the model's context window. Every branch is pure or takes an injected
 * `fetch`, so the suite pins them without a server, a model or a window.
 */

const { test, ok, equal, contains, runtimeSkip, notContains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const {
    normalizeAssistantConfig,
    normalizeEndpoint,
    assistantEnabled,
    looksLikeEmbeddingModel,
    parseSseChunk,
    parseSseDelta,
    parseChatCompletionFull,
    extractCode,
    looksLikeCode,
    estimateTokens,
    answerBudget,
    contextForBudget,
    promptRoom,
    fitPromptParts,
    descriptionAllowance,
    allowanceText,
    describeEmptyAnswer,
    describeModel,
    describeLoadedNow,
    DEFAULT_ENDPOINT,
} = compiled('ai/assistant');

test('junk settings fall back to the documented defaults', () => {
    const cfg = normalizeAssistantConfig({});
    equal(cfg.backend, 'off');
    equal(cfg.endpoint, DEFAULT_ENDPOINT);
    equal(cfg.model, '');
    equal(cfg.modelPath, '');
    equal(cfg.threads, 0);
    equal(cfg.contextSize, 4096);
    equal(cfg.gpuLayers, 0);
    equal(cfg.timeoutSeconds, 60);
    equal(cfg.maxTokens, 4096);
    equal(cfg.temperature, 0.2);
    equal(cfg.showDiff, true);
});

test('string numbers from the settings UI are read as numbers', () => {
    const cfg = normalizeAssistantConfig({
        threads: '8',
        contextSize: '2048',
        gpuLayers: '2',
        timeoutSeconds: '30',
        maxTokens: '1024',
        temperature: '0.5',
    });
    equal([cfg.threads, cfg.contextSize, cfg.gpuLayers, cfg.timeoutSeconds, cfg.maxTokens, cfg.temperature], [
        8, 2048, 2, 30, 1024, 0.5,
    ]);
});

test('numeric settings are clamped at both ends', () => {
    const high = normalizeAssistantConfig({ threads: 100, contextSize: 999999, gpuLayers: 5000, timeoutSeconds: 1000, maxTokens: 99999, temperature: 5 });
    equal([high.threads, high.contextSize, high.gpuLayers, high.timeoutSeconds, high.maxTokens, high.temperature], [
        32, 262144, 999, 600, 8192, 1,
    ]);
    const low = normalizeAssistantConfig({ threads: -5, contextSize: 1, gpuLayers: -1, timeoutSeconds: 1, maxTokens: 1, temperature: -1 });
    equal([low.threads, low.contextSize, low.gpuLayers, low.timeoutSeconds, low.maxTokens, low.temperature], [
        0, 512, 0, 5, 64, 0,
    ]);
});

test('showDiff is only off when it is explicitly false', () => {
    equal(normalizeAssistantConfig({ showDiff: false }).showDiff, false);
    equal(normalizeAssistantConfig({ showDiff: 0 }).showDiff, true);
    equal(normalizeAssistantConfig({ showDiff: 'false' }).showDiff, true);
    equal(normalizeAssistantConfig({ showDiff: true }).showDiff, true);
});

test('an unknown or junk backend is off, never a guess', () => {
    equal(normalizeAssistantConfig({ backend: 'external' }).backend, 'external');
    equal(normalizeAssistantConfig({ backend: 'bundled' }).backend, 'bundled');
    equal(normalizeAssistantConfig({ backend: 'junk' }).backend, 'off');
    equal(normalizeAssistantConfig({ backend: 42 }).backend, 'off');
});

test('the bundled native backend defaults to the CPU build', () => {
    equal(normalizeAssistantConfig({}).bundledBackend, 'cpu');
    equal(normalizeAssistantConfig({ bundledBackend: 'gpu' }).bundledBackend, 'cpu');
});

test('only the exact word vulkan asks for the GPU build', () => {
    equal(normalizeAssistantConfig({ bundledBackend: 'vulkan' }).bundledBackend, 'vulkan');
    equal(normalizeAssistantConfig({ bundledBackend: 'VULKAN' }).bundledBackend, 'vulkan');
    equal(normalizeAssistantConfig({ bundledBackend: 'cpu' }).bundledBackend, 'cpu');
    equal(normalizeAssistantConfig({ bundledBackend: 'gpu' }).bundledBackend, 'cpu');
});

test('normalizeEndpoint appends /v1 once and never twice', () => {
    equal(normalizeEndpoint('http://127.0.0.1:1234'), 'http://127.0.0.1:1234/v1');
    equal(normalizeEndpoint('http://127.0.0.1:1234/'), 'http://127.0.0.1:1234/v1');
    equal(normalizeEndpoint('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1');
    equal(normalizeEndpoint('http://127.0.0.1:1234/v1/'), 'http://127.0.0.1:1234/v1');
    equal(normalizeEndpoint('http://127.0.0.1:1234/v2'), 'http://127.0.0.1:1234/v2');
    equal(normalizeEndpoint(''), DEFAULT_ENDPOINT);
});

test('assistantEnabled needs the switch on, a backend, and somewhere to send the request', () => {
    // The switch is the first gate: a configured server and an answering endpoint mean nothing while the
    // assistant is off, which is its default (asked 2026-10-09 — "when off, all models are to be unloaded and
    // the llama-server is to be stopped").
    equal(assistantEnabled({ enabled: false, backend: 'external', endpoint: 'http://x/v1' }), false);
    equal(assistantEnabled({ enabled: false, backend: 'bundled', endpoint: '' }), false);
    equal(assistantEnabled({ enabled: true, backend: 'off', endpoint: 'http://x' }), false);
    equal(assistantEnabled({ enabled: true, backend: 'bundled', endpoint: '' }), true);
    equal(assistantEnabled({ enabled: true, backend: 'external', endpoint: 'http://x/v1' }), true);
    equal(assistantEnabled({ enabled: true, backend: 'external', endpoint: '' }), false);
});

test('looksLikeEmbeddingModel flags the obvious embedding names only', () => {
    for (const id of ['text-embedding-nomic-embed-text-v1.5', 'nomic-embed-text', 'bge-large', 'gte-base', 'e5-large']) {
        ok(looksLikeEmbeddingModel(id), `${id} is an embedding model`);
    }
    for (const id of ['llama-3.2-3b-instruct', 'gemma-4-e4b', 'cache5', 'qwen2.5-coder']) {
        ok(!looksLikeEmbeddingModel(id), `${id} can answer a chat request`);
    }
});

test('parseSseChunk reads content, reasoning, finish reason and usage', () => {
    const content = parseSseChunk('data: {"choices":[{"delta":{"content":"hello"}}]}');
    equal(content, { content: 'hello' });

    equal(parseSseChunk('data: {"choices":[{"delta":{"reasoning_content":"think"}}]}').reasoning, 'think');
    equal(parseSseChunk('data: {"choices":[{"delta":{"reasoning":"thought"}}]}').reasoning, 'thought');
    equal(parseSseChunk('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}').finishReason, 'stop');

    const withUsage = parseSseChunk(
        'data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"completion_tokens":42,"completion_tokens_details":{"reasoning_tokens":37}}}',
    );
    equal(withUsage.content, 'hi');
    // The prompt count is part of the same object now; absent fields are explicitly `undefined`, which is
    // what makes the runtime's early "this prompt is N tokens" chunk readable by the same parser.
    equal(withUsage.usage, { promptTokens: undefined, completionTokens: 42, reasoningTokens: 37 });
});

test('parseSseChunk ignores everything that is not a data payload', () => {
    equal(parseSseChunk('data: [DONE]'), undefined);
    equal(parseSseChunk('event: ping'), undefined);
    equal(parseSseChunk('data: not json'), undefined);
    equal(parseSseChunk('data: {"choices":[{"delta":{}}]}'), undefined);
    equal(parseSseChunk(''), undefined);
});

test('parseSseDelta is the narrow view of a chunk', () => {
    equal(parseSseDelta('data: {"choices":[{"delta":{"content":"x"}}]}'), 'x');
    equal(parseSseDelta('data: {"choices":[{"delta":{"reasoning_content":"r"}}]}'), undefined);
});

test('parseChatCompletionFull reads content, reasoning and the legacy text field', () => {
    equal(parseChatCompletionFull({ choices: [{ message: { content: 'code', reasoning_content: 'why' } }] }), {
        text: 'code',
        reasoning: 'why',
    });
    equal(parseChatCompletionFull({ choices: [{ message: { content: 'c', reasoning: 'r' } }] }), { text: 'c', reasoning: 'r' });
    equal(parseChatCompletionFull({ choices: [{ text: 'legacy' }] }), { text: 'legacy', reasoning: '' });
    equal(parseChatCompletionFull({}), { text: '', reasoning: '' });
});

test('extractCode takes the last fenced block, because the first is usually the echo', () => {
    const answer = 'Here is the method:\n```rust\nfn old() {}\n```\nAnd here is the answer:\n```rust\nfn new() {}\n```';
    const { code, note } = extractCode(answer);
    equal(code, 'fn new() {}');
    contains(note, 'repeated the code');
});

test('extractCode falls back to a JSON {"code": …} answer', () => {
    const { code, note } = extractCode('{"code":"fn x() {}","explanation":"why"}');
    equal(code, 'fn x() {}');
    equal(note, 'why');
});

test('extractCode salvages an unclosed fence instead of throwing the answer away', () => {
    const { code, note } = extractCode('Here:\n```rust\nfn broken() {\n    x');
    equal(code, 'fn broken() {\n    x');
    contains(note, 'cut off');
});

test('prose is rejected rather than substituted for a function', () => {
    equal(extractCode('I changed the function to blink the LED.'), { code: '', note: '' });
    equal(looksLikeCode('fn x() {}'), true);
    equal(looksLikeCode('let x = 1;\nlet y = 2;'), true);
    equal(looksLikeCode('I have updated the code.'), false);
    equal(looksLikeCode(''), false);
});

test('estimateTokens is characters over four', () => {
    equal(estimateTokens(''), 0);
    equal(estimateTokens('abcd'), 1);
    equal(estimateTokens('abcde'), 2);
});

test('answerBudget leaves the prompt its room and floors the answer at 64 tokens', () => {
    equal(answerBudget(4096, 4096, 1000), { maxTokens: 3032, reduced: true, room: 3032 });
    equal(answerBudget(512, 4096, 1000), { maxTokens: 512, reduced: false, room: 3032 });
    equal(answerBudget(4096, 4096, 5000), { maxTokens: 64, reduced: true, room: 64 });
});

test('contextForBudget honours an explicit size and grows to fit the answer otherwise', () => {
    equal(contextForBudget(0, 4096), 6144);
    equal(contextForBudget(8192, 4096), 8192);
    equal(contextForBudget(undefined, 512), 4096);
    equal(contextForBudget('2048', 4096), 2048);
});

test('promptRoom is what the window leaves after the answer and the slack', () => {
    equal(promptRoom(4096, 4096), 0);
    equal(promptRoom(8192, 2048), 6080);
    equal(promptRoom(1024, 4096), 0);
});

test('fitPromptParts reports an overflow when even the required parts do not fit', () => {
    const fit = fitPromptParts([{ name: 'required', text: 'x'.repeat(400), required: true }], 10);
    equal(fit.kept.length, 1);
    equal(fit.dropped, []);
    equal(fit.overflowTokens, 90);
    equal(fit.room, 10);
    equal(fit.usedTokens, 100);
});

test('fitPromptParts drops optional parts in order and restores the original order', () => {
    const parts = [
        { name: 'required', text: 'x'.repeat(40), required: true },
        { name: 'style', text: 'y'.repeat(400), required: false },
        { name: 'members', text: 'z'.repeat(40), required: false },
    ];
    const fit = fitPromptParts(parts, 25);
    equal(fit.dropped, ['style']);
    equal(fit.kept.map((p) => p.name), ['required', 'members']);
    equal(fit.overflowTokens, 0);
    equal(fit.usedTokens, 20);

    const all = fitPromptParts([{ name: 'a', text: 'xx', required: false }], 25);
    equal(all.dropped, []);
    equal(all.kept.map((p) => p.name), ['a']);
});

test('descriptionAllowance caps the user sentence and never goes negative', () => {
    equal(descriptionAllowance(1000, 400), 400);
    equal(descriptionAllowance(500, 400), 100);
    equal(descriptionAllowance(100, 400), 0);
    equal(allowanceText(315), '~315 tokens (~1260 characters)');
});

test('describeEmptyAnswer explains an empty answer from the numbers behind it', () => {
    contains(describeEmptyAnswer(''), 'returned an empty answer');
    contains(describeEmptyAnswer('', { finishReason: 'length' }), 'budget ran out');
    contains(
        describeEmptyAnswer('', { reasoningChars: 1200, reasoningTokens: 837, finishReason: 'length' }),
        'thinks before it answers',
    );
    contains(describeEmptyAnswer('', { finishReason: 'length', promptTokens: 3500, contextSize: 4096 }), 'The prompt was about 3500 tokens');
});

test('describeEmptyAnswer explains prose and an unclosed code block', () => {
    contains(describeEmptyAnswer('```rust\nfn x() {'), 'never closed');
    contains(describeEmptyAnswer('I updated the function.'), 'prose instead of code');
});

test('describeModel says what the next request will use', () => {
    contains(describeModel({ backend: 'bundled', model: '', modelPath: '/a/b/model.gguf' }), 'model.gguf (bundled runtime)');
    contains(describeModel({ backend: 'bundled', model: '', modelPath: '' }), 'Set Up Local Model');
    contains(describeModel({ backend: 'external', model: 'qwen' }), 'asked for by name');
    contains(describeModel({ backend: 'external', model: '' }, { ok: true, models: [{ id: 'one' }] }), 'only chat model');
    contains(describeModel({ backend: 'external', model: '' }, { ok: true, models: [{ id: 'a' }, { id: 'b' }] }), 'picks one of 2');
    contains(describeModel({ backend: 'external', model: '' }, { ok: true, models: [] }), 'no chat model offered');
    contains(describeModel({ backend: 'external', model: '' }, { ok: false, models: [] }), 'not answering');
    contains(describeModel({ backend: 'external', model: '' }), 'server decides');
});

test('describeLoadedNow speaks only for an external server and compares short names', () => {
    equal(describeLoadedNow({ backend: 'bundled', model: 'x' }, ['y']), undefined);
    contains(describeLoadedNow({ backend: 'external', model: 'm' }, []), 'loads m first');
    contains(describeLoadedNow({ backend: 'external', model: '' }, []), 'makes the server load one');
    equal(describeLoadedNow({ backend: 'external', model: '' }, ['google/gemma']), 'Loaded now: gemma');
    equal(describeLoadedNow({ backend: 'external', model: 'google/gemma' }, ['gemma']), 'Loaded now: gemma');
    contains(describeLoadedNow({ backend: 'external', model: 'other' }, ['x']), 'not other');
});

// The trap behind "No server answered" with `backend: bundled` (2026-10-04): the normalised config carries
// LM Studio's default endpoint, because the bundled runtime picks its own port only when it starts. Every
// request path therefore has to resolve the endpoint first (`configWithEndpoint` in `runtime.ts`); that
// function needs `vscode`, so what is pinned here is the fact that makes it necessary.
test('a bundled config carries no usable endpoint until the runtime is started', () => {
    const assistant = compiled('ai/assistant');
    const cfg = assistant.normalizeAssistantConfig({ enabled: true, backend: 'bundled' });
    equal(cfg.endpoint, assistant.DEFAULT_ENDPOINT, 'the settings default is LM Studio, not the bundled runtime');
    ok(assistant.assistantEnabled(cfg), 'and bundled still counts as "on" without one');
});

// "Is it actually still working?" The line is built in one place so the notification and the chat panel
// cannot word it differently, and it is a pure function so every branch is pinned here.
test('the progress line says what is happening, and how far in', () => {
    const assistant = compiled('ai/assistant');
    const base = { tokens: 0, characters: 0, reasoningChars: 0, elapsedMs: 400, sinceLastChunkMs: 400 };

    equal(assistant.describeProgress({ ...base, phase: 'connecting' }), 'Asking the model… (0.4s)');

    const reading = assistant.describeProgress({
        ...base, phase: 'waiting', elapsedMs: 3200, promptTokens: 1640, contextSize: 4096
    });
    contains(reading, 'reading the prompt');
    contains(reading, '3.2s');
    contains(reading, 'context 40% (1640/4096)');

    const thinking = assistant.describeProgress({ ...base, phase: 'thinking', reasoningChars: 312, elapsedMs: 6100 });
    contains(thinking, '312 characters of reasoning');

    const writing = assistant.describeProgress({
        ...base, phase: 'streaming', tokens: 42, characters: 120, elapsedMs: 6200, promptTokens: 1640, contextSize: 4096
    });
    contains(writing, '42 tokens');
    contains(writing, 'tokens/s');
    contains(writing, 'context 40%');

    // The rate is generation, not wall clock: 3 s of prompt reading must not be charged to the tokens.
    const afterPrefill = assistant.describeProgress({
        ...base, phase: 'streaming', tokens: 42, characters: 120, elapsedMs: 6200, firstTokenMs: 3000,
        promptTokens: 1640, contextSize: 4096
    });
    contains(afterPrefill, '13.1 tokens/s', `expected the post-prefill rate, got: ${afterPrefill}`);
});

test('an external server gets no context percentage, because its window is not ours to know', () => {
    const assistant = compiled('ai/assistant');
    const line = assistant.describeProgress({
        phase: 'streaming', tokens: 5, characters: 20, reasoningChars: 0, elapsedMs: 1000, sinceLastChunkMs: 10
    });
    ok(!line.includes('context'), `no window, no percentage: ${line}`);
    contains(line, '5 tokens');
});

test('the context percentage never exceeds 100', () => {
    const assistant = compiled('ai/assistant');
    const line = assistant.describeProgress({
        phase: 'waiting', tokens: 0, characters: 0, reasoningChars: 0, elapsedMs: 500, sinceLastChunkMs: 500,
        promptTokens: 5000, contextSize: 4096
    });
    contains(line, 'context 100%');
});

test('a prompt-token count sent before the first token is read', () => {
    const assistant = compiled('ai/assistant');
    const chunk = assistant.parseSseChunk('data: {"choices":[{"delta":{},"finish_reason":null}],"usage":{"prompt_tokens":1640}}');
    equal(chunk.usage.promptTokens, 1640);
});

// `chatDetailed` end to end against a fake server. This is the test the progress work needed and did not
// have: it caught nothing at the time, and "Cannot access 'outcome' before initialization" — a temporal dead
// zone from ticking before the outcome existed — broke every request in the meantime (2026-10-04).
function streamed(body) {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(body));
            controller.close();
        }
    });
}

test('chatDetailed streams, counts tokens and reports progress', async () => {
    const assistant = compiled('ai/assistant');
    const sse = [
        'data: {"choices":[{"delta":{},"finish_reason":null}],"usage":{"prompt_tokens":120}}',
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":2}}',
        'data: [DONE]',
        ''
    ].join('\n');
    const fetchImpl = async () => ({
        ok: true,
        status: 200,
        body: streamed(sse),
        text: async () => '',
        json: async () => ({})
    });
    const cfg = assistant.normalizeAssistantConfig({ backend: 'bundled', contextSize: 4096 });
    const progress = [];
    const pieces = [];
    const outcome = await assistant.chatDetailed(cfg, [{ role: 'user', content: 'hi' }], {
        fetchImpl,
        onToken: (t) => pieces.push(t),
        onProgress: (p) => progress.push(p)
    });

    equal(outcome.text, 'Hello');
    equal(outcome.finishReason, 'stop');
    equal(outcome.completionTokens, 2);
    equal(pieces.join(''), 'Hello');

    ok(progress.length >= 1, 'progress must be reported while the request runs');
    const last = progress[progress.length - 1];
    equal(last.tokens, 2, 'two content pieces, two tokens');
    equal(last.characters, 5);
    equal(last.promptTokens, 120, 'the count the runtime sends before generating');
    equal(last.contextSize, 4096);
    equal(last.phase, 'streaming');
    contains(assistant.describeProgress(last), '2 tokens');
    contains(assistant.describeProgress(last), 'context 3% (120/4096)');
    ok(progress.some((p) => p.phase === 'connecting'), 'and the phase before the response is announced');
});

test('a server that ignores stream:true still yields its answer', async () => {
    const assistant = compiled('ai/assistant');
    const fetchImpl = async () => ({
        ok: true,
        status: 200,
        body: undefined,
        text: async () => '',
        json: async () => ({ choices: [{ message: { content: 'Hi there' } }] })
    });
    const outcome = await assistant.chatDetailed(assistant.normalizeAssistantConfig({ backend: 'bundled' }), [
        { role: 'user', content: 'x' }
    ], { fetchImpl });
    equal(outcome.text, 'Hi there');
});

test('an HTTP failure carries the server’s own words', async () => {
    const assistant = compiled('ai/assistant');
    const fetchImpl = async () => ({
        ok: false,
        status: 503,
        body: undefined,
        text: async () => 'the model is still loading',
        json: async () => ({})
    });
    let message = '';
    try {
        await assistant.chatDetailed(assistant.normalizeAssistantConfig({ backend: 'bundled' }), [
            { role: 'user', content: 'x' }
        ], { fetchImpl });
    } catch (error) {
        message = error.message;
    }
    contains(message, 'HTTP 503');
    contains(message, 'still loading');
});

// ---------------------------------------------------------------- a failure that names the address

test('a request that cannot connect says which address it tried', async () => {
    // The report of 2026-10-04: the settings had been overwritten with LM Studio's dead 1234 (a stale settings
    // form), and every prompt answered "No server answered — is the local model server running (and the
    // endpoint correct)?" with *no address in it*. The address is the whole diagnosis.
    const assistant = compiled('ai/assistant');
    const cfg = assistant.normalizeAssistantConfig({ backend: 'external', endpoint: 'http://127.0.0.1:1234/v1', timeoutSeconds: 5 });
    const fetchImpl = async () => { throw new TypeError('fetch failed'); };
    let message = '';
    try {
        await assistant.chatDetailed(cfg, [{ role: 'user', content: 'hi' }], { fetchImpl });
    } catch (error) {
        message = error.message;
    }
    contains(message, 'No server answered at http://127.0.0.1:1234/v1');
    contains(message, 'endpoint correct');
});

test('the words are the same when there is no address to name', () => {
    const assistant = compiled('ai/assistant');
    equal(assistant.describeError(new TypeError('fetch failed')),
        'No server answered — is the local model server running (and the endpoint correct)?');
    equal(assistant.describeError(new TypeError('fetch failed'), 'http://127.0.0.1:8080/v1'),
        'No server answered at http://127.0.0.1:8080/v1 — is the local model server running (and the endpoint correct)?');
});

test('a timeout names the address too, and anything else is passed through untouched', () => {
    const assistant = compiled('ai/assistant');
    equal(assistant.describeError(new Error('This operation was aborted'), 'http://127.0.0.1:8080/v1'),
        'The request to http://127.0.0.1:8080/v1 was cancelled or timed out.');
    equal(assistant.describeError(new Error('This operation was aborted')), 'The request was cancelled or timed out.');
    // A message from the server itself is never rewritten: it is the server's own words about its own problem.
    equal(assistant.describeError(new Error('The server answered HTTP 400: context overflow'), 'http://x/v1'),
        'The server answered HTTP 400: context overflow');
});

// ------------------------------------------------ "implement this code" under an answer (2026-10-04)

test('the code in an answer is found, and only the Rust is offered', () => {
    const assistant = compiled('ai/assistant');
    const answer = [
        'Here is the refactor.',
        '',
        '```rust',
        'fn flash_led(interval: u64) {',
        '    led.toggle();',
        '}',
        '```',
        '',
        'And the dependency:',
        '',
        '```toml',
        '[dependencies]',
        'embassy-time = "0.3"',
        '```',
        '',
        'Done.'
    ].join('\n');
    const all = assistant.codeBlocks(answer);
    equal(all.length, 2);
    equal(all[0].language, 'rust');
    equal(all[1].language, 'toml');
    // The button is offered for the Rust block only: a `Cargo.toml` snippet is not code to implement in a .rs
    // file, and neither is a shell command.
    const offered = assistant.rustCodeBlocks(answer);
    equal(offered.length, 1);
    contains(offered[0].code, 'fn flash_led');
    notContains(offered[0].code, 'embassy-time');
});

test('a block with no language counts as Rust, and an unclosed one is not offered at all', () => {
    const assistant = compiled('ai/assistant');
    // Models omit the info string often, and this project is Rust — refusing those would hide the button on
    // perfectly good answers.
    equal(assistant.rustCodeBlocks('```\nfn helper() {}\n```').length, 1);
    equal(assistant.rustCodeBlocks('```RS\nfn helper() {}\n```').length, 1);
    // A block cut off by the token budget: `extractCode` salvages it for the editor flows, where the user is
    // watching a diff. A *button* that writes half a function into a file is a different promise.
    equal(assistant.rustCodeBlocks('```rust\nfn cut_off() {\n    led.toggle();').length, 0);
});

test('two blocks in one answer are two offers, and prose alone is none', () => {
    const assistant = compiled('ai/assistant');
    const two = assistant.rustCodeBlocks('before:\n```rust\nfn old() {}\n```\nafter:\n```rust\nfn new() {}\n```');
    equal(two.length, 2);
    contains(two[0].code, 'fn old');
    contains(two[1].code, 'fn new');
    equal(assistant.rustCodeBlocks('The loop is blocking because the timer future is not awaited.').length, 0);
    equal(assistant.rustCodeBlocks('').length, 0);
    equal(assistant.rustCodeBlocks('```\n\n```').length, 0, 'an empty block is not code');
});
