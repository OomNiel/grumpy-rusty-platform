'use strict';

/**
 * The AI Assistant's switch: what "off" does, and what it refuses to do without being asked.
 *
 * The switch is one boolean, but the thing it controls is other processes — a `llama-server` this window
 * started, one the user runs as a systemd unit, and the models LM Studio is holding. So the decision is a
 * pure function over the facts (`offPlan`) rather than a chain of `if`s buried in the command, and these tests
 * pin the three rules that matter:
 *
 *   - models are unloaded and this window's own server is stopped, always;
 *   - a server this window did **not** start is stopped only after the user says so, once per window;
 *   - something that cannot be stopped honestly is named with what to do instead, never guessed at.
 */

const { test, ok, notOk, equal, contains, compiled } = require('../../lib/harness');
const {
    offPlan,
    ownerKey,
    describeOffStep,
    disableOfferFor,
    disableUnitCommand,
    isNoopPlan,
    startupShouldStop,
} = compiled('ai/assistantSwitchPlan');
const { normalizeAssistantConfig, assistantEnabled } = compiled('ai/assistant');

/** Facts with nothing running at all, which every case overrides what it needs. */
function facts(over = {}) {
    return { loadedModelIds: [], ownServer: false, owner: { kind: 'none' }, ...over };
}

// ---------------------------------------------------------------- what off does

test('turning the assistant off with nothing running is a no-op rather than a string of complaints', () => {
    const plan = offPlan(facts());
    ok(isNoopPlan(plan), 'nothing to do');
    equal(plan.length, 0, 'and no steps invented');
});

test('every held model is unloaded and this window’s own server is stopped, without asking', () => {
    // The two things the window owns: the models a runtime is holding, and a server it spawned itself.
    const plan = offPlan(facts({ loadedModelIds: ['qwen2.5-coder-7b', 'gemma-4-e4b'], ownServer: true }));
    equal(plan.length, 2, JSON.stringify(plan));
    equal(plan[0].kind, 'unloadModels', 'models first — that is where the memory is');
    equal(plan[0].modelIds.join(','), 'qwen2.5-coder-7b,gemma-4-e4b', 'all of them, by name');
    equal(plan[1].kind, 'stopOwn', 'then the window’s own server');
    notOk(plan.some((step) => step.needsConsent), 'neither is a question — this window owns both');
});

test('a server this window did not start is a question the first time, and an answer afterwards', () => {
    const unitOwner = { kind: 'unit', unit: 'llama-server.service', scope: 'user', pid: 4242, enabled: true };
    const asked = offPlan(facts({ owner: unitOwner }));
    equal(asked.length, 1, JSON.stringify(asked));
    equal(asked[0].kind, 'stopForeign', 'the unit is a step of its own');
    equal(asked[0].needsConsent, true, 'and one the user has not answered yet');
    equal(ownerKey(unitOwner), 'unit:user:llama-server.service', 'keyed by the unit, so consent sticks to it');

    const approved = offPlan(facts({ owner: unitOwner }), new Map([['unit:user:llama-server.service', true]]));
    equal(approved[0].needsConsent, false, 'once approved, turning it off again does not ask');

    // A "leave it running" is remembered too: the same question at every reload is a nag, not a safeguard.
    const declined = offPlan(facts({ owner: unitOwner }), new Map([['unit:user:llama-server.service', false]]));
    ok(isNoopPlan(declined), 'declined means nothing happens, and nothing is asked again');
});

test('a foreign process is stopped with consent, and a system unit is refused with the command to run', () => {
    const process = offPlan(facts({ owner: { kind: 'process', pid: 99, command: 'llama-server -m x.gguf' } }));
    equal(process[0].kind, 'stopForeign', 'a plain process can be signalled');
    equal(ownerKey({ kind: 'process', pid: 99 }), 'process:99', 'keyed by pid');

    // Root is not ours to take, and pretending otherwise would end in a failed `systemctl` at the worst moment.
    const system = offPlan(facts({ owner: { kind: 'unit', unit: 'llama-server.service', scope: 'system' } }));
    equal(system.length, 1, JSON.stringify(system));
    equal(system[0].kind, 'cannotStop', 'a system unit is not a stop step');
    contains(system[0].reason, 'sudo systemctl stop llama-server.service', 'the reason says what to run instead');
    notOk(system.some((step) => step.kind === 'stopForeign'), 'and nothing is asked about it');
});

test('a server that cannot be inspected is reported, not guessed at', () => {
    // "Something answers on that address but this platform cannot say what" — killing it would be a guess.
    const plan = offPlan(facts({ owner: { kind: 'unknown', why: 'no ss and no /proc on this platform' } }));
    equal(plan.length, 1, JSON.stringify(plan));
    equal(plan[0].kind, 'cannotStop', 'nothing is stopped');
    contains(plan[0].reason, 'no ss and no /proc', 'and the reason is passed through, so it can be acted on');
});

test('unloading still happens when the server is somebody else’s and they said no', () => {
    // The two decisions are independent: leaving a foreign server running does not mean keeping every model
    // LM Studio is holding in memory as well.
    const plan = offPlan(
        facts({ loadedModelIds: ['a'], owner: { kind: 'unit', unit: 'u.service', scope: 'user' } }),
        new Map([['unit:user:u.service', false]])
    );
    equal(plan.map((step) => step.kind).join(','), 'unloadModels', 'the models still go');
});

test('the offer to disable is made only where it can do something', () => {
    // The user's request (2026-10-09): a third button in the stop dialog, "Disable it so it doesn't come back",
    // for the server that reserves gigabytes while idle. It is offered for exactly one thing — an enabled *user*
    // unit, the only case where "it comes back at your next login" is both true and undoable from here.
    const stopForeign = (owner) => offPlan(facts({ owner }))[0];
    const offer = (owner) => disableOfferFor(stopForeign(owner));

    const enabled = offer({ kind: 'unit', unit: 'llama-server.service', scope: 'user', pid: 42, enabled: true });
    equal(enabled?.unit, 'llama-server.service', 'an enabled user unit is the case it exists for');
    equal(enabled?.label, "Disable it so it doesn't come back", 'with the words the user asked for');

    equal(
        offer({ kind: 'unit', unit: 'llama-server.service', scope: 'user', enabled: false }),
        undefined,
        'a unit that is not enabled has nothing to undo',
    );
    equal(
        offer({ kind: 'unit', unit: 'llama-server.service', scope: 'user' }),
        undefined,
        'and an unknown state is not a yes: the offer is not made for what systemctl did not confirm',
    );
    equal(
        offer({ kind: 'process', pid: 42, command: 'llama-server' }),
        undefined,
        'a plain process has no login target',
    );
    // The window's own server never reaches the dialog at all: it is a `stopOwn` step, which is not a question.
    equal(
        disableOfferFor(offPlan(facts({ ownServer: true }))[0]),
        undefined,
        'nor has this window’s own server',
    );

    // A system unit never reaches the dialog at all: `offPlan` refuses it with the command to run as root.
    const system = offPlan(facts({ owner: { kind: 'unit', unit: 'llama-server.service', scope: 'system' } }));
    equal(system[0].kind, 'cannotStop', 'a system unit is a refusal, not a question');
    equal(disableOfferFor(system[0]), undefined, 'so there is no offer to make');
});

test('disabling a unit is `systemctl --user disable`, and nothing else', () => {
    // The one part of the disable worth asserting without a machine: the verb, the scope, and the order. The
    // doing is a single call with this in `llamaService`, next to the `stop` that always precedes it.
    const command = disableUnitCommand('llama-server.service');
    equal(command.command, 'systemctl', 'systemctl');
    equal(command.args.join(' '), '--user disable llama-server.service', 'user scope, disable, the unit');
});

test('every step has one line that says what it does', () => {
    equal(describeOffStep({ kind: 'unloadModels', modelIds: ['a'] }), 'unloading a', 'one model is named');
    equal(describeOffStep({ kind: 'unloadModels', modelIds: ['a', 'b'] }), 'unloading 2 models', 'several are counted');
    equal(describeOffStep({ kind: 'stopOwn' }), 'stopping the server this window started', 'our own server');
    contains(
        describeOffStep({ kind: 'stopForeign', key: 'k', needsConsent: true, owner: { kind: 'unit', unit: 'u.service', scope: 'user' } }),
        'u.service',
        'a unit is named'
    );
    contains(
        describeOffStep({ kind: 'stopForeign', key: 'k', needsConsent: true, owner: { kind: 'process', pid: 7 } }),
        'pid 7',
        'a process is named by its pid'
    );
    ok(describeOffStep({ kind: 'cannotStop', reason: 'because' }).includes('because'), 'a refusal keeps its reason');
});

// ---------------------------------------------------------------- the startup option

test('the switch off enforces itself at startup unless the user says otherwise', () => {
    // Chosen 2026-10-09: off means off, so a window that opens with the switch down unloads and stops. The
    // option is next to the switch in the panel, because someone who runs their own llama-server for other
    // work does not want an editor stopping it at every launch.
    equal(startupShouldStop({ enabled: false, stopServersAtStartup: true }), true, 'off, and enforcing');
    equal(startupShouldStop({ enabled: false, stopServersAtStartup: false }), false, 'off, but leaving servers alone');
    equal(startupShouldStop({ enabled: true, stopServersAtStartup: true }), false, 'on is not the moment to stop anything');
    equal(startupShouldStop({ enabled: true, stopServersAtStartup: false }), false, 'and on with the option off is still on');
});

test('the switch is off by default, and only an explicit value moves either setting', () => {
    const fresh = normalizeAssistantConfig({});
    equal(fresh.enabled, false, 'a machine that has never seen the panel is off');
    equal(fresh.stopServersAtStartup, true, 'and enforces that at startup');
    notOk(assistantEnabled(fresh), 'so the assistant does not answer');

    // Only an explicit `true` is consent to start a server: anything unreadable must not look like a yes.
    for (const junk of ['yes', 1, {}, null, 'true']) {
        equal(normalizeAssistantConfig({ enabled: junk }).enabled, false, `enabled: ${JSON.stringify(junk)} is not a yes`);
    }
    equal(normalizeAssistantConfig({ enabled: true }).enabled, true, 'but a real true is');

    // The other way round for the startup option: only an explicit `false` turns it off, so a missing or
    // unreadable value keeps the meaning the switch implies.
    for (const junk of ['no', 0, {}, undefined]) {
        equal(
            normalizeAssistantConfig({ stopServersAtStartup: junk }).stopServersAtStartup,
            true,
            `stopServersAtStartup: ${JSON.stringify(junk)} keeps enforcing`
        );
    }
    equal(
        normalizeAssistantConfig({ stopServersAtStartup: false }).stopServersAtStartup,
        false,
        'and an explicit false is respected'
    );
});
