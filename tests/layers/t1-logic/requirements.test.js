'use strict';

// Asked on 2026-10-16: "The extension must prompt for any missing requirements when it loads." The *decision* of
// what to ask is pure, so it is pinned here: what is asked, what is deliberately not asked (a half-detected
// toolchain, a family whose route needs none of it), and what "don't show again" remembers. The host half —
// the warning, its buttons and where a dismissal is stored — is checked by reading the sources, the way the rest
// of this layer guards wiring it cannot execute.

const fs = require('fs');
const path = require('path');
const { test, ok, equal, notOk, contains, notContains, compiled, repoRoot } = require('../../lib/harness');
const { healthReport, HEALTH_ACTION_COMMANDS, HEALTH_ACTION_LABELS } = compiled('toolchain/health');
const { missingRequirements, missingSignature } = compiled('toolchain/requirements');

/** A ToolchainStatus with only the fields the health report reads filled in. */
function status(options = {}) {
    const missing = options.missing ?? [];
    const probe = options.probe ?? 'Debug probe is reachable.';
    return {
        platform: 'linux',
        rustup: { found: true, version: '1.99.0' },
        cargo: { found: options.cargoFound !== false, version: '1.99.0' },
        probeRs: { found: options.probeRsFound !== false, version: '0.32.0' },
        installedTargets: ['x86_64-unknown-linux-gnu'],
        missingTargets: missing,
        probes: [],
        probeDiagnosis: {
            kind: probe.includes('outdated')
                ? 'firmware-outdated'
                : /no debug probe/i.test(probe)
                    ? 'none-connected'
                    : 'ok',
            message: probe,
        },
        espTargets: [],
    };
}

/** The ESP toolchain, missing or present. */
function espStatus(ready) {
    return {
        espup: { found: ready, version: '0.14.0' },
        espflash: { found: ready, version: '4.6.0' },
        toolchainInstalled: ready,
        exportFile: ready ? '/home/niel/export-esp.sh' : undefined,
        chips: ['esp32'],
        ready,
    };
}

/** The report for a workspace, as the extension assembles it. */
function reportFor(options = {}) {
    const status_ = options.detected === false ? undefined : status(options);
    return healthReport({
        status: status_,
        esp: options.family === 'esp' ? espStatus(options.espReady === true) : undefined,
        family: options.family ?? 'rp',
        cargoOnShellPath: options.cargoOnShellPath !== false,
    });
}

function ask(options = {}) {
    return missingRequirements({
        report: reportFor(options),
        detected: options.detected !== false,
        dismissed: options.dismissed,
        enabled: options.enabled !== false,
    });
}

test('a window with everything in place is asked nothing', () => {
    const verdict = ask();
    notOk(verdict.ask, 'a ready toolchain produces no prompt');
    equal(verdict.message, '', 'and nothing to say');
    equal(verdict.signature, '', 'and nothing to remember');
    equal(verdict.actions.length, 0);
});

test('the prompt names what is missing and offers the fix for each', () => {
    const verdict = ask({ cargoFound: false, missing: ['thumbv6m-none-eabi'] });
    ok(verdict.ask, 'a missing cargo is worth asking about');
    contains(verdict.message, 'cargo is not installed', 'the message is the health report\'s own words');
    contains(verdict.message, 'missing targets: thumbv6m-none-eabi', 'every problem, not just the first');
    contains(verdict.message, '•', 'as a list, so two problems do not read as one sentence');
    ok(verdict.actions.includes('install-toolchain'), 'with the fix the report named');
    ok(verdict.signature.length > 0, 'and an identity to remember if it is dismissed');
});

// "The toolchain has not been detected yet" is a transient state, not a missing requirement: prompting about it
// would put a modal on screen on every single load.
test('nothing is asked before detection has finished', () => {
    const verdict = ask({ detected: false });
    notOk(verdict.ask, 'an undetected toolchain is not a missing one');
    equal(verdict.message, '');
});

// The family rules were learned the hard way (2026-10-05) and the prompt must not unlearn them: an ESP project is
// never nagged about a probe (Xtensa has no SWD and flashes over USB), and a Pico project is never nagged about
// the Xtensa toolchain.
test('the prompt follows the same family rules as the health row', () => {
    const esp = ask({ family: 'esp', espReady: true });
    notOk(esp.ask, 'a ready ESP toolchain on an ESP project asks nothing');
    ok(
        !reportFor({ family: 'esp', espReady: true }).problems.some((problem) => /probe/i.test(problem)),
        'and no probe is a problem on that route',
    );

    const espMissing = ask({ family: 'esp', espReady: false });
    ok(espMissing.ask, 'a missing Xtensa toolchain is asked about');
    contains(espMissing.message, 'ESP toolchain', 'by name');
    ok(espMissing.actions.includes('install-esp-toolchain'), 'with the ESP installer behind it');

    // A missing *probe* is hardware, not a missing requirement: the report names it, offers no fix, and the
    // prompt therefore stays quiet — the health row and the log still say it.
    const noProbe = reportFor({ family: 'rp', probe: 'no debug probe detected' });
    ok(noProbe.problems.some((problem) => /no debug probe/i.test(problem)), 'the health row reports it');
    equal(noProbe.actions.length, 0, 'but there is nothing to install behind it');
    notOk(ask({ family: 'rp', probe: 'no debug probe detected' }).ask, 'so the prompt does not ask about it');

    // Probe *firmware* is actionable, and the prompt offers that.
    const oldFirmware = ask({ family: 'rp', probe: 'the probe firmware is outdated' });
    ok(oldFirmware.ask, 'outdated probe firmware is asked about');
    ok(oldFirmware.actions.includes('update-probe-firmware'), 'with the updater behind it');

    // And a Pico project is never asked about Xtensa, which its route does not use.
    notContains(
        reportFor({ family: 'rp', missing: ['thumbv6m-none-eabi'] }).problems.join(' '),
        'ESP',
        'no Xtensa on the RP route',
    );
    const rpMissing = ask({ family: 'rp', missing: ['thumbv6m-none-eabi'] });
    ok(rpMissing.ask, 'a missing target is asked about');
    ok(rpMissing.actions.includes('install-toolchain'), 'with the installer behind it');
});

test('a fix with no button behind it is not a prompt', () => {
    // The report can carry a problem it has no action for; asking with nothing to press would be worse than
    // saying nothing, since the words are already in the health row and the log.
    const verdict = missingRequirements({
        report: { ok: false, problems: ['something is wrong'], notes: [], actions: [] },
        detected: true,
        enabled: true,
    });
    notOk(verdict.ask, 'no actions, no prompt');
});

test('"Don\'t show again" silences that set — and only that set', () => {
    const first = ask({ cargoFound: false });
    const same = ask({ cargoFound: false, dismissed: first.signature });
    notOk(same.ask, 'the same requirements are not announced twice');

    const changed = ask({ cargoFound: false, missing: ['thumbv6m-none-eabi'], dismissed: first.signature });
    ok(changed.ask, 'a different set is a different question');
    ok(changed.signature !== first.signature, 'with its own identity');

    // Order-independence: the same problems reached in another order are the same requirements, not a new set to
    // announce all over again.
    equal(
        missingSignature(['b is missing', 'a is missing']),
        missingSignature(['a is missing', 'b is missing']),
    );
    equal(missingSignature(['  a is missing  ', '']), 'a is missing', 'and whitespace and blanks do not count');
});

test('the prompt can be switched off', () => {
    const off = ask({ cargoFound: false, enabled: false });
    notOk(off.ask, 'the setting silences the prompt');
    ok(reportFor({ cargoFound: false }).problems.length > 0, 'while the health row keeps reporting it');
});

test('every fix the prompt can offer is a declared command with a label', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf8'));
    const declared = new Set(manifest.contributes.commands.map((entry) => entry.command));
    for (const [action, command] of Object.entries(HEALTH_ACTION_COMMANDS)) {
        ok(declared.has(command), `${action} runs ${command}, which is not declared in package.json`);
        ok((HEALTH_ACTION_LABELS[action] ?? '').trim() !== '', `${action} needs a button label`);
    }
    equal(
        Object.keys(HEALTH_ACTION_COMMANDS).length,
        4,
        'every action still has a command (the four Rust verdicts)',
    );
});

test('the load-time prompt is registered, and reads the one health report', () => {
    const extension = fs.readFileSync(path.join(repoRoot(), 'src/extension.ts'), 'utf8');
    contains(extension, 'registerRequirementsPrompt(context, state, output)', 'activation registers it');
    contains(extension, 'state.onDidChange', 'and the state it watches feeds it');

    const prompt = fs.readFileSync(path.join(repoRoot(), 'src/commands/requirementsPrompt.ts'), 'utf8');
    contains(prompt, 'state.healthInput', 'the prompt asks the state for the toolchain facts');
    contains(prompt, 'healthReport(', 'and the report decides what is missing — not a second list of requirements');
    contains(prompt, 'DISMISSED_REQUIREMENTS_KEY', 'a dismissal is remembered');
    contains(prompt, 'globalState', 'across windows rather than per window');
    contains(prompt, 'announced', 'and the same set is not announced twice in one window');
    contains(prompt, 'HEALTH_ACTION_COMMANDS[chosen]', 'a button runs the command behind its action');
    contains(prompt, 'executeCommand', 'through the same command the palette runs');

    // The setting the prompt obeys has to exist, or the switch does nothing.
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf8'));
    const setting = manifest.contributes.configuration.properties['rustyPlatform.promptMissingRequirements'];
    ok(setting, 'the switch is a declared setting');
    equal(setting.default, true, 'and it is on by default: a missing requirement is worth saying once');
    contains(prompt, 'promptMissingRequirements', 'which is the setting the code reads');

    // One action list for both doors onto a fix: the Check Toolchain modal used to spell the mapping out a second
    // time, and a second copy is how the two disagree.
    const commands = fs.readFileSync(path.join(repoRoot(), 'src/commands/toolchainCommands.ts'), 'utf8');
    contains(commands, 'HEALTH_ACTION_LABELS', 'the modal uses the shared labels');
    contains(commands, 'HEALTH_ACTION_COMMANDS[chosen]', 'and the shared command mapping');
    notContains(
        commands,
        "'install-toolchain': 'Install Missing Pieces'",
        'and does not keep a copy of the label list of its own',
    );
});
