'use strict';

/**
 * The scan itself: what the machine is asked, and what it answers.
 *
 * Driven with a temporary folder on a **fake PATH** and an **injected fetch**, so it is hermetic — no real agent
 * is run and no real port is knocked on — while still being the real scanner: the PATH walk, the executable
 * test, the id building and the ordering are all exercised for real.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, ok, notOk, equal, contains, notContains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');

const { scanAgents, chooseAgent } = compiled('ai/agents');

/** A temporary directory holding executable fakes, the way a developer's PATH holds real ones. */
function fakeBin(names) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rusty-agents-'));
    for (const name of names) {
        const file = path.join(dir, name);
        fs.writeFileSync(file, '#!/bin/sh\necho fake\n');
        fs.chmodSync(file, 0o755);
    }
    return dir;
}

/** A fetch that answers on the ports it is given and nothing else. */
function fetchAnsweringOn(ports) {
    const answered = ports.map((p) => `http://127.0.0.1:${p}/v1`);
    return async (url) => {
        const base = String(url).replace(/\/models$/, '');
        if (!answered.includes(base)) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => ({ data: [{ id: 'local-model' }] }) };
    };
}

test('the scan reports the CLI agents on the machine, and which one can be driven', async () => {
    const bin = fakeBin(['pool', 'aider', 'continue']);
    const found = await scanAgents({ env: { PATH: bin }, fetchImpl: fetchAnsweringOn([]) });

    const pool = found.find((a) => a.id === 'cli:pool');
    ok(pool.available, 'pool is found when it is on the PATH');
    ok(pool.drivable, 'and is the one this extension can drive');
    equal(pool.command, path.join(bin, 'pool'), 'by its absolute path, ready to spawn');
    ok(pool.args.includes('{dir}'), 'with the project folder in its argument list');
    equal(pool.kind, 'pool', 'under the kind whose runner is measured');

    const aider = found.find((a) => a.id === 'cli:aider');
    ok(aider.available, 'aider is found too');
    notOk(aider.drivable, 'and reported as found but not drivable');
    equal(aider.args, undefined, 'with no invented flag list');

    const codex = found.find((a) => a.id === 'cli:codex');
    notOk(codex.available, 'an agent that is not installed is not available');
    contains(codex.why, 'not on the PATH', 'and says why');
});

test('a name that is also a shell builtin is not mistaken for an agent', async () => {
    // `continue` is a bash builtin: `command -v continue` answers about the *shell* on a machine with no such
    // program. The scanner walks the PATH itself, so the answer is about the disk.
    const withFile = await scanAgents({ env: { PATH: fakeBin(['continue']) }, fetchImpl: fetchAnsweringOn([]) });
    const withoutFile = await scanAgents({ env: { PATH: fakeBin([]) }, fetchImpl: fetchAnsweringOn([]) });
    // `continue` is not in the preset list, so the check is the mechanism: nothing appears that is not a file.
    const names = withoutFile.filter((a) => a.available).map((a) => a.id);
    equal(names.length, 0, 'an empty PATH yields no available agents at all');
    ok(withFile.length > 0, 'and the scan always returns the full picture, available or not');
    notContains(withoutFile.map((a) => a.label).join(' '), 'continue', 'a builtin is never listed as an agent');
});

test('endpoints are probed, and only the ones that answer are available', async () => {
    const found = await scanAgents({
        env: { PATH: fakeBin([]) },
        fetchImpl: fetchAnsweringOn([1234])
    });
    const lms = found.find((a) => a.id === 'openai:1234');
    ok(lms.available, 'LM Studio is available when its port answers');
    equal(lms.model, 'local-model', 'named by the model it offers');
    equal(lms.kind, 'openai', 'as an answering endpoint, not an editor');
    equal(lms.why, undefined, 'and an available endpoint carries no reason for absence');

    const ollama = found.find((a) => a.id === 'openai:11434');
    notOk(ollama.available, 'a port with nothing behind it is not available');
    contains(ollama.why, 'nothing is listening', 'and says so');
});

test('the endpoint the assistant already uses is an agent too', async () => {
    // It is not found by looking at ports and PATH, and it is the one a user of the `external` backend already
    // has — leaving it out of the list would hide the obvious choice on that machine.
    const found = await scanAgents({
        env: { PATH: fakeBin([]) },
        configuredEndpoint: 'http://127.0.0.1:5000/v1',
        fetchImpl: fetchAnsweringOn([5000])
    });
    const configured = found.find((a) => a.endpoint === 'http://127.0.0.1:5000/v1');
    ok(configured, 'the configured endpoint is in the list');
    ok(configured.available, 'and is available when it answers');
    contains(configured.label, 'endpoint', 'labelled as the one from the settings');
});

test('the bundled runtime is an agent when it is up', async () => {
    const found = await scanAgents({
        env: { PATH: fakeBin([]) },
        bundledEndpoint: 'http://127.0.0.1:39271/v1',
        fetchImpl: fetchAnsweringOn([39271])
    });
    const bundled = found.find((a) => a.endpoint === 'http://127.0.0.1:39271/v1');
    ok(bundled?.available, "the extension's own runtime can be chosen like any other endpoint");
    contains(bundled.label, 'own runtime', 'and is named as such');
});

test('choosing one of the scan results picks what the scan said', async () => {
    // The whole point of the feature: the list decides, not a hard-wired name.
    const found = await scanAgents({
        env: { PATH: fakeBin(['pool']) },
        fetchImpl: fetchAnsweringOn([1234])
    });
    equal(chooseAgent(found).id, 'cli:pool', 'by default the agent that can edit the project wins');
    equal(
        chooseAgent(found, 'openai:1234').id,
        'openai:1234',
        'and a hand-made choice for the endpoint is honoured over it'
    );
    const endpointOnly = await scanAgents({ env: { PATH: fakeBin([]) }, fetchImpl: fetchAnsweringOn([1234]) });
    equal(chooseAgent(endpointOnly).id, 'openai:1234', 'with no CLI agent at all, the endpoint is chosen');
});

test('a version probe asks the binary itself, and a machine without it is not an error', async () => {
    const { probeVersion } = compiled('ai/agents');
    const bin = fakeBin(['pool']);
    equal(await probeVersion(path.join(bin, 'pool')), undefined, 'a fake that prints no number yields no version');
    equal(await probeVersion('/nonexistent/pool'), undefined, 'and a missing binary is not a throw');
});
