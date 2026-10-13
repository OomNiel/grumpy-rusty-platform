'use strict';

/**
 * The agent registry and the choice between agents.
 *
 * The distinction these tests exist to protect is the one the feature turns on: an agent being *installed* is
 * not the same as this extension being able to *drive* it unattended. Conflating them is how a hand-off
 * appears to run and does nothing.
 */

const { test, ok, notOk, equal, contains, notContains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const fs = require('fs');
const path = require('path');

const {
    CLI_PRESETS,
    ENDPOINT_PRESETS,
    cliAgentId,
    endpointAgentId,
    presetEndpoint,
    parseVersion,
    describeAgent,
    chooseAgent,
    whyNoAgent,
    agentScanLines,
    agentShortName,
    handoffButtonLabel
} = compiled('ai/agents');

/** A candidate with the fields a test cares about, defaulted the way the scanner would build it. */
const candidate = (over = {}) => ({
    id: 'pool',
    label: 'Poolside CLI agent',
    kind: 'pool',
    command: '/usr/local/bin/pool',
    available: true,
    drivable: true,
    ...over
});

test('the ids are stable, because a setting stores one', () => {
    equal(cliAgentId('pool'), 'cli:pool', 'a CLI is keyed by its command');
    equal(endpointAgentId(1234), 'openai:1234', 'a local endpoint by its port, so a restart keeps the id');
    equal(presetEndpoint(11434), 'http://127.0.0.1:11434/v1', 'and its base URL always carries the /v1');
});

test('every CLI preset that claims to be drivable has a measured contract', () => {
    // `drivable` is a claim about a *measured contract*. Adding one means either measuring the invocation or
    // shipping a hand-off that silently does nothing, so the list is asserted rather than counted: the two that
    // claim it are pool (prompt on stdin) and jcode (prompt as the one positional argument), and each has to
    // show the evidence of its own measurement.
    const drivable = CLI_PRESETS.filter((p) => p.drivable);
    equal(drivable.map((p) => p.command).join(', '), 'pool, jcode', 'exactly the two measured CLIs are drivable');

    const pool = drivable[0];
    equal(pool.kind, 'pool', 'pool is the kind whose runner is measured');
    contains(pool.args.join(' '), '-p -', 'and its prompt goes in on stdin');
    notContains(pool.args.join(' '), '{prompt}', 'never as an argument — that would put code in `ps`');
    ok(pool.args.includes('{dir}'), 'while the project folder is passed as one');

    const jcode = drivable[1];
    equal(jcode.kind, 'jcode', 'jcode has its own kind, so hand-off dispatch can tell the drivers apart');
    contains(jcode.args.join(' '), '--ndjson', 'and its measured machine-readable output flag');
    ok(jcode.args.includes('{dir}'), 'it is given the project folder too');
    // The message is argv for this CLI, but it is *not* listed here: the driver adds it last, where it cannot be
    // read as a flag's value. A `{prompt}` placeholder would be a second, contradicting description of the call.
    notContains(jcode.args.join(' '), '{prompt}', 'the prompt is not described twice');

    // And each claim has a driver to back it: `kind` names the module that builds the call.
    for (const preset of drivable) {
        const driver = path.join(__dirname, '..', '..', '..', 'src', 'ai', `${preset.kind}.ts`);
        ok(fs.existsSync(driver), `ai/${preset.kind}.ts exists — the invocation this preset claims`);
    }
});

test('the machine is looked at for agents that are not usable yet, too', () => {
    // Silence about an agent the user has would read as "the extension cannot see it"; the wording has to say
    // *found but not drivable* rather than nothing at all.
    ok(CLI_PRESETS.length > 5, 'several CLI agents are looked for');
    for (const preset of CLI_PRESETS.filter((p) => !p.drivable)) {
        equal(preset.args, undefined, `${preset.command} carries no invented flag list`);
    }
});

test('the three states of an agent read differently', () => {
    contains(describeAgent(candidate({ version: '1.0.16' })), '1.0.16', 'a ready agent names its version');
    contains(describeAgent(candidate()), 'build', 'and says it can work in the project');

    const found = describeAgent(candidate({ id: 'cli:aider', kind: 'cli', drivable: false, why: undefined }));
    contains(found, 'found, but', 'an installed agent the extension cannot run says so');
    contains(found, 'no verified way', 'in as many words');

    const missing = describeAgent(candidate({ id: 'cli:codex', label: 'OpenAI Codex CLI', kind: 'cli', available: false, drivable: false, why: '`codex` is not on the PATH' }));
    contains(missing, 'Codex', 'an absent one is named');
    contains(missing, 'not on the PATH', 'with the reason standing as the sentence, so absent and unauthenticated read differently');

    // A cloud API that has no key yet is not "not found": it is configured and waiting for a secret.
    const cloud = describeAgent(
        candidate({
            id: 'openai:https://apihub.example.com/v1',
            kind: 'openai',
            label: 'Cloud API (https://apihub.example.com/v1)',
            available: false,
            drivable: false,
            why: 'no API key stored yet — run "Rusty AI: Set the Hand-off API Key…"'
        })
    );
    contains(cloud, 'no API key stored yet', 'a configured cloud API says a key is missing');
    notContains(cloud, 'not found', 'and is not described as absent');

    const endpoint = describeAgent(
        candidate({ id: 'openai:1234', kind: 'openai', label: 'LM Studio on port 1234', model: 'qwen3' })
    );
    contains(endpoint, 'review the code', 'an endpoint is honest about what it can do: answer, not edit');
    notContains(endpoint, 'build what it changes', 'it is not described as working in the project');
});

test('the user\'s own choice wins, and nothing is guessed when nothing can run', () => {
    const pool = candidate();
    const endpoint = candidate({ id: 'openai:1234', kind: 'openai', label: 'LM Studio on port 1234' });
    const absent = candidate({ id: 'cli:codex', kind: 'cli', available: false, drivable: false });
    const seen = [absent, pool, endpoint];

    equal(chooseAgent(seen, 'openai:1234').id, 'openai:1234', 'an explicit choice is honoured even when something else comes first');
    equal(chooseAgent(seen, 'cli:codex'), pool, 'a choice that cannot run falls back to the first usable one');
    equal(chooseAgent(seen, 'cli:not-there'), pool, 'and so does a choice that does not exist');
    equal(chooseAgent(seen).id, 'pool', 'with no choice, the first usable candidate wins — the one that edits');
    equal(chooseAgent([pool], 'openai:1234').id, 'pool', 'a preference for an agent this machine does not have is not a failure');

    equal(chooseAgent([absent]), undefined, 'nothing usable chooses nothing rather than hoping');
    equal(chooseAgent([candidate({ drivable: false })]), undefined, 'installed but undrivable is not usable');
});

test('why there is nothing to hand off to names what was found', () => {
    const none = whyNoAgent([candidate({ available: false, drivable: false }), candidate({ id: 'cli:aider', kind: 'cli', available: false, drivable: false })]);
    contains(none, 'No agent was found', 'nothing at all says so');
    contains(none, 'pool', 'and names the thing to install');

    const onlyFound = whyNoAgent([candidate({ id: 'cli:aider', label: 'Aider', kind: 'cli', drivable: false })]);
    contains(onlyFound, 'Aider', 'something found but undrivable names it');
    contains(onlyFound, 'not one this extension knows how to run', 'and explains the gap');

    const onlyEndpoint = whyNoAgent([candidate({ id: 'openai:1234', kind: 'openai', label: 'LM Studio on port 1234' })]);
    contains(onlyEndpoint, 'cannot change files', 'an endpoint-only machine is told what that means');
});

test('the scan lines are one per candidate, in order', () => {
    const lines = agentScanLines([candidate(), candidate({ id: 'openai:1234', kind: 'openai', label: 'LM Studio on port 1234' })]);
    equal(lines.length, 2, 'one line each');
    contains(lines[0], 'Poolside', 'in the order they were scanned');
    contains(lines[1], 'LM Studio', 'so the picker reads CLI agents first');
});

test('a version banner is read, whatever else it says', () => {
    equal(parseVersion('pool 1.0.16 (fake)'), '1.0.16', 'out of a banner');
    equal(parseVersion('v2.1'), '2.1', 'two parts are enough');
    equal(parseVersion('no digits here'), undefined, 'and nothing is nothing');
    equal(ENDPOINT_PRESETS.length, 4, 'four local ports are worth knocking on');
});

test('every action names the agent it will really use', () => {
    // Reported 2026-10-13: *"the prompt in the response box reads: Hand to the Pool agent"* — after pool had
    // stopped being the only answer, and with a cloud provider configured. The button text is derived from the
    // chosen agent, so it cannot promise one thing and do another.
    const cloud = candidate({
        id: 'openai:https://apihub.agnes-ai.com/v1',
        kind: 'openai',
        label: 'Cloud API (https://apihub.agnes-ai.com/v1)',
        endpoint: 'https://apihub.agnes-ai.com/v1'
    });
    equal(agentShortName(cloud), 'apihub.agnes-ai.com', 'a remote endpoint is named by its host, which is what a person calls it');
    equal(handoffButtonLabel(cloud), 'Hand it to apihub.agnes-ai.com…', 'and that is what the button says');

    equal(agentShortName(candidate()), 'the Poolside agent', 'the CLI agent keeps a readable name');
    equal(handoffButtonLabel(candidate()), 'Hand it to the Poolside agent…', 'in the same sentence');

    const local = candidate({ id: 'openai:1234', kind: 'openai', label: 'LM Studio on port 1234', endpoint: 'http://127.0.0.1:1234/v1' });
    equal(agentShortName(local), 'LM Studio on port 1234', 'a local server is named as the list names it, because that says which one it is');

    const cli = candidate({ id: 'cli:aider', kind: 'cli', label: 'Aider', drivable: false });
    equal(agentShortName(cli), 'Aider', 'another CLI keeps its own short label');
    equal(agentShortName(undefined), 'an agent', 'and with nothing chosen the wording stays honest');
    equal(handoffButtonLabel(undefined), 'Hand it to an agent…', 'rather than naming one that is not there');

    // Nothing may read as if pool were the answer whatever the settings say.
    notContains(handoffButtonLabel(cloud), 'ool', 'a cloud hand-off never mentions pool');
});
