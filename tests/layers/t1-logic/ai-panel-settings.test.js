'use strict';

/**
 * The panel's Save, and the list of settings it is allowed to write.
 *
 * THE BUG THESE TESTS COME FROM (reported 2026-10-13): *"This is the endpoint for Agnes … It is not in the
 * hand-off agent list."* The endpoint had been typed into the panel and saved, and the save wrote **nothing** —
 * `save()` listed the keys it would write by hand, five of them, and every field added afterwards was dropped.
 * A form that sends a key nobody writes is invisible: the panel refreshes from unchanged settings and the field
 * quietly reverts.
 *
 * So there are two guards here, and they are different in kind:
 *   - the **unit** tests pin what a payload means against the manifest (types, unknown keys, refusals);
 *   - the **drift** test reads the real `package.json` *and* the real form's own source, and fails if the form
 *     ever sends a key the manifest does not declare — which is the shape the bug would take next time.
 *
 * The save path itself cannot drift any more: it no longer contains a list of keys to keep in step.
 */

const fs = require('fs');
const path = require('path');
const { test, ok, notOk, equal, contains, notContains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');

const { planWrites, describeWrites } = compiled('ai/panelSettings');

const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
const PROPERTIES = MANIFEST.contributes.configuration.properties;

/** The keys the panel's form can actually send, read out of its own source. */
function formKeys() {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'ui', 'aiChatView.ts'), 'utf8');
    const block = /const now = \{([\s\S]*?)\n        \};/.exec(source);
    if (!block) throw new Error('the Save handler no longer has a `const now = {…}` block to check');
    return [...block[1].matchAll(/(?:^|\n)\s{12}([a-zA-Z][a-zA-Z0-9]*):/g)].map((m) => m[1]);
}

test('a payload is written against what the manifest declares', () => {
    const properties = {
        'rustyPlatform.assistant.backend': { type: 'string' },
        'rustyPlatform.assistant.model': { type: 'string' },
        'rustyPlatform.assistant.maxTokens': { type: 'number' },
        'rustyPlatform.assistant.showDiff': { type: 'boolean' },
        'rustyPlatform.assistant.conventions': { type: 'array' }
    };
    const plan = planWrites(
        { backend: 'bundled', maxTokens: 8192, showDiff: false, conventions: ['x'], notASetting: 1, model: 5 },
        properties
    );
    equal(plan.write.backend, 'bundled', 'a string is written');
    equal(plan.write.maxTokens, 8192, 'a number is written');
    equal(plan.write.showDiff, false, 'a boolean — including false — is written');
    ok(Array.isArray(plan.write.conventions), 'an array is written');
    equal(plan.unknown.join(), 'notASetting', 'a key the manifest does not declare is refused, with its name');
    equal(plan.wrongType.join(), 'model', 'and a value of the wrong type is refused, with its name');
    notOk('notASetting' in plan.write, 'nothing unknown is written');
    notOk('model' in plan.write, 'and nothing mistyped is written');
});

test('an undefined setting is not written by accident', () => {
    // A form that has not been filled in sends `undefined`; writing that would set a setting to nothing, which is
    // how "the field reverted" would become "the setting was erased".
    const plan = planWrites({ backend: undefined }, { 'rustyPlatform.assistant.backend': { type: 'string' } });
    equal(plan.wrongType.join(), 'backend', 'undefined does not match `string`');
    equal(Object.keys(plan.write).length, 0, 'so nothing is written');
});

test('NaN and Infinity are not numbers as far as a setting is concerned', () => {
    const properties = { 'rustyPlatform.assistant.maxTokens': { type: 'number' } };
    equal(planWrites({ maxTokens: NaN }, properties).wrongType.join(), 'maxTokens', 'NaN is refused');
    equal(planWrites({ maxTokens: Infinity }, properties).wrongType.join(), 'maxTokens', 'and so is Infinity');
});

test('a payload cannot write a setting outside the assistant namespace', () => {
    const plan = planWrites({ 'editor.fontSize': 30 }, PROPERTIES);
    equal(plan.unknown.join(), 'editor.fontSize', 'another extension\'s setting is not writable from this panel');
    equal(Object.keys(plan.write).length, 0, 'and nothing is written');
});

test('every field the panel\'s form can send is a setting the manifest declares', () => {
    // THE DRIFT GUARD. It reads the real form and the real manifest, so adding a field to the form without
    // declaring it in `package.json` fails here instead of failing in front of a developer as "it did not save".
    const keys = formKeys();
    ok(keys.length >= 12, `the form sends its fields (${keys.join(', ')})`);
    const plan = planWrites(Object.fromEntries(keys.map((k) => [k, 'sample'])), PROPERTIES);
    equal(plan.unknown.join(), '', 'every key the form sends is declared in the manifest');
    // `'sample'` is a string, so any non-string setting is expected in `wrongType` here — what matters is that the
    // manifest *knows* the key. A key that is neither known nor mistyped would be missing from both lists.
    const known = keys.filter((k) => !plan.unknown.includes(k));
    equal(known.length, keys.length, 'none is unknown');

    // And the six settings the hand-off needs are among them, by name — this is the exact list that was silently
    // dropped when `save()` wrote five keys by hand.
    for (const key of ['contextSize', 'maxTokens', 'handoff', 'handoffAgent', 'cloudEndpoint', 'cloudModel']) {
        ok(keys.includes(key), `the form sends \`${key}\``);
        ok(PROPERTIES[`rustyPlatform.assistant.${key}`], `and the manifest declares \`${key}\``);
    }
});

test('the save path no longer keeps its own list of keys', () => {
    // The structural fix, asserted: the class of bug was "a second list of setting names went stale", so a
    // `cfg.update('name', …)` chain reappearing in that method would reintroduce it.
    const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'ui', 'aiChatView.ts'), 'utf8');
    const method = /private async save\(settings: Record<string, unknown>\): Promise<void> \{([\s\S]*?)\n    \}/.exec(source);
    ok(method, 'the save method is where the tests expect it');
    ok(/planWrites\(/.test(method[1]), 'and it decides through the manifest-driven plan');
    notOk(/cfg\.update\('(backend|endpoint|model|maxTokens|cloudEndpoint)'/.test(method[1]), 'with no hand-written key list');
});

test('the switch reads as a switch, not as a list of agents', () => {
    // Reported 2026-10-13: *"'When a request is beyond the local model' only have the Pool agent in the list.
    // Where is the agnes option."* — that control is the on/off switch, and its option text still said "Hand it
    // to the pool agent", which reads exactly like an agent list with one entry. The agent list is the next
    // control (`handoffAgent`), and the switch must not pretend to be it.
    const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'ui', 'aiChatView.ts'), 'utf8');
    const select = /<select id="handoff"[\s\S]*?<\/select>/.exec(source);
    ok(select, 'the switch is where the test expects it');
    notContains(select[0], 'pool agent', 'the switch does not name an agent');
    contains(select[0], 'Warn me and stop', 'it offers stopping');
    contains(select[0], 'Hand it to an agent', 'and handing off to *an* agent');
    contains(select[0], 'value="off"', 'still with the same stored values');
    contains(select[0], 'value="pool"', 'so an existing configuration keeps meaning what it meant');

    const agentSelect = /<select id="handoffAgent"[\s\S]*?<\/select>/.exec(source);
    ok(agentSelect, 'and the agent list is its own control');
    contains(agentSelect[0], 'Automatic', 'with automatic first');
});

test('the log line says what was written and what was refused', () => {
    const plan = planWrites({ backend: 'bundled', nope: 1, model: 5 }, {
        'rustyPlatform.assistant.backend': { type: 'string' },
        'rustyPlatform.assistant.model': { type: 'string' }
    });
    const line = describeWrites(plan);
    contains(line, '1 setting(s) written', 'the count');
    contains(line, 'backend', 'the name');
    contains(line, 'not a setting', 'the unknown key, described');
    contains(line, 'wrong type', 'and the mistyped one');
});

test('each CLI agent\'s own fields are shown only when that agent will run', () => {
    // Reported 2026-10-13: *"the 'The pool command' entry box must not be visible when 'Hand it to the pool
    // agent' is not selected."* With a cloud API chosen, a box asking which "pool" executable to run is a
    // question with no referent — and the same question came back the moment there were two CLI agents (the
    // Agnes Code CLI was added the same day), where showing pool's command while jcode is the chosen agent
    // would be exactly as wrong.
    //
    // The rule is enforced in two places, and the test checks both, because either half alone is silently
    // useless: the markup must group each agent's fields and start hidden, and the script must unhide the group
    // belonging to the agent the extension says it will really use.
    const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'ui', 'aiChatView.ts'), 'utf8');

    // The group's closing tag is the one at the form's own indent. A lazy match would stop at `poolStatus`'s
    // inner `</div>` instead, and every assertion after it would then be made against the wrong element.
    const poolGroup = /<div id="poolSettings"[^>]*>[\s\S]*?\n        <\/div>/.exec(source);
    ok(poolGroup, 'the pool fields are one group, so they can be shown or hidden together');
    contains(poolGroup[0], 'hidden', 'and the group starts hidden, not shown before the scan answers');
    contains(poolGroup[0], 'id="poolCommand"', 'it holds the pool command');
    contains(poolGroup[0], 'id="poolAutoAllow"', 'and pool auto-allow, which is pool\'s own flag too');
    notContains(poolGroup[0], 'id="cloudEndpoint"', 'while the cloud fields stay outside it');
    notContains(poolGroup[0], 'id="handoffAgent"', 'as does the agent list itself');
    notContains(poolGroup[0], 'id="jcodeCommand"', 'and the other agent\'s settings are not inside it');

    const jcodeGroup = /<div id="jcodeSettings"[^>]*>[\s\S]*?\n        <\/div>/.exec(source);
    ok(jcodeGroup, 'the Agnes Code CLI has a group of its own');
    contains(jcodeGroup[0], 'hidden', 'hidden for the same reason');
    contains(jcodeGroup[0], 'id="jcodeCommand"', 'holding its command');
    contains(jcodeGroup[0], 'id="jcodeProvider"', 'the provider to ask (-p)');
    contains(jcodeGroup[0], 'id="jcodeModel"', 'and the model (-m)');
    notContains(jcodeGroup[0], 'id="poolCommand"', 'with nothing of pool\'s inside it');

    ok(/effective: chooseAgent\(/.test(source), 'the extension decides which agent would really be used');
    ok(/setAgents\(msg\.agents, msg\.chosen, msg\.effective\)/.test(source), 'and the panel is told it');
    ok(/function refreshAgentSettings\(\)/.test(source), 'one function decides both groups');
    ok(
        /poolSettings'\)[\s\S]{0,140}hidden = who !== 'cli:pool'/.test(source),
        'the pool group is shown only for the pool agent'
    );
    ok(
        /jcodeSettings'\)[\s\S]{0,140}hidden = who !== 'cli:jcode'/.test(source),
        'and jcode\'s only for jcode, named explicitly in both comparisons'
    );
    ok(/handoffAgent'\)\.addEventListener\('change'/.test(source), 'and picking another agent updates them at once');
});
