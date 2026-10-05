'use strict';

/**
 * The status bar and the sidebar's "Controls" section are two renderings of one list, so the list is
 * what gets pinned here: the commands, their order, and the single control that only exists while a
 * probe-rs session runs. A drift between the two views shows up as a button the user can press in one
 * place but not the other.
 */

const fs = require('fs');
const path = require('path');
const { test, ok, equal, contains, notContains } = require('../../lib/harness');
const { compiled, repoRoot } = require('../../lib/harness');
const {
    CONTROLS,
    FLASH_PROFILE_CONTROLS,
    HEALTH_CONTROL,
    healthSummary,
    iconText,
    statusBarText,
    visibleControls,
} = compiled('ui/controls');

/** The order the status bar has always shown, health first. */
const ORDER = [
    'rustyPlatform.checkToolchain',
    'rustyPlatform.build',
    'rustyPlatform.flash',
    'rustyPlatform.debug',
    'rustyPlatform.debugStop',
    'rustyPlatform.monitor',
    'rustyPlatform.clean',
];

/** A ToolchainStatus with only the fields the health row reads filled in. */
function status(options) {
    const ready = options.ready;
    const missing = options.missing ?? [];
    const probe = options.probe ?? 'Debug probe is reachable.';
    return {
        platform: 'linux',
        rustup: { found: true, version: '1.99.0' },
        cargo: { found: true, version: options.cargo ?? '1.99.0' },
        probeRs: { found: true, version: options.probeRs ?? '0.32.0' },
        installedTargets: ['x86_64-unknown-linux-gnu', 'thumbv8m.main-none-eabihf'],
        missingTargets: missing,
        probes: [{ index: 0, name: 'Debug Probe', selector: '2e8a:000c', protocol: 'CMSIS-DAP' }],
        probeDiagnosis: {
            kind: probe.includes('outdated')
                ? 'firmware-outdated'
                : /no debug probe/i.test(probe)
                    ? 'none-connected'
                    : 'ok',
            message: probe,
        },
        udevRulesPresent: true,
        ready,
    };
}

test('the control list is the status bar order, health first', () => {
    equal(CONTROLS.map((control) => control.command).join(' '), ORDER.join(' '));
    equal(CONTROLS[0], HEALTH_CONTROL, 'the health item is the one the live status text belongs to');
});

test('every control is a declared command with a plain codicon name', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf8'));
    const declared = new Set(manifest.contributes.commands.map((entry) => entry.command));

    for (const control of CONTROLS) {
        ok(declared.has(control.command), `${control.command} is shown as a control but not declared in package.json`);
        ok(control.label.trim() !== '', `${control.command} needs a label`);
        ok(!control.icon.includes('$('), `${control.command}: the icon is a bare codicon name, the views add the wrapper`);
        ok(control.detail.trim() !== '', `${control.command} needs a line of detail for the sidebar row`);
        ok(control.tooltip.trim() !== '', `${control.command} needs a tooltip`);
    }

    equal(iconText('tools', 'Build'), '$(tools) Build');
    equal(statusBarText(CONTROLS[1]), '$(tools) Build', 'the status bar caption comes from the same fields');
});

test('Stop is the only control that comes and goes', () => {
    const without = visibleControls(false).map((control) => control.command);
    const during = visibleControls(true).map((control) => control.command);

    equal(
        CONTROLS.filter((control) => control.sessionOnly === true).map((control) => control.command).join(','),
        'rustyPlatform.debugStop',
        'nothing else may hide itself',
    );
    ok(!without.includes('rustyPlatform.debugStop'), 'with no session there is nothing to stop');
    equal(during.length, without.length + 1, 'during a session exactly one control appears');
    ok(during.includes('rustyPlatform.debugStop'));
});

test('the health row says what is wrong, not just that something is', () => {
    const detecting = healthSummary({ family: 'rp', cargoOnShellPath: true });
    contains(detecting.label, 'detecting');

    const ready = healthSummary({ status: status({ ready: true }), family: 'rp', cargoOnShellPath: true });
    contains(ready.label, 'ready');
    contains(ready.detail, 'cargo 1.99.0');
    contains(ready.detail, 'probe-rs 0.32.0');
    contains(ready.markdown, '**targets** thumbv8m.main-none-eabihf');
    ok(!ready.markdown.includes('x86_64-unknown-linux-gnu'), 'the host target is noise in the tooltip');

    const broken = healthSummary({
        status: status({
            ready: false,
            missing: ['thumbv6m-none-eabi'],
            probe: 'Debug Probe firmware is outdated and must be updated.',
        }),
        family: 'rp',
        cargoOnShellPath: true,
    });
    contains(broken.label, 'setup needed');
    contains(broken.markdown, 'missing targets: thumbv6m-none-eabi');
    contains(broken.markdown, 'firmware is outdated');
    contains(broken.detail, 'missing targets', 'the sidebar row needs its one-line reason');
    equal(broken.icon, 'warning');
});

// The regression this test exists for: pressing the health control on the Sunton CYD raised a modal
// about a debug probe that board can never use, while saying nothing about the ESP toolchain it does
// need (2026-10-05).
test('the health row reads the open project, not just the probe-rs side', () => {
    const noProbe = status({ ready: true, probe: 'No debug probe detected. Connect a Debug Probe or picoprobe.' });

    const rp = healthSummary({ status: noProbe, family: 'rp', cargoOnShellPath: true });
    contains(rp.label, 'setup needed', 'a Pico really is blocked without a probe');
    contains(rp.markdown, 'No debug probe detected');

    const esp = healthSummary({
        status: noProbe,
        esp: espStatus({ ready: true }),
        family: 'esp',
        cargoOnShellPath: true,
    });
    contains(esp.label, 'ready', 'an ESP32 has no probe route at all');
    notContains(esp.markdown, 'No debug probe detected', 'so that is not what the user is told');
    notContains(esp.markdown, 'probe-rs 0.32.0', 'and probe-rs is not advertised as a requirement');
    contains(esp.markdown, '**esp** ready');

    const espMissing = healthSummary({
        status: noProbe,
        esp: espStatus({ missing: ['espup', 'espflash'], chips: ['esp32', 'esp32s3'] }),
        family: 'esp',
        cargoOnShellPath: true,
    });
    contains(espMissing.label, 'setup needed');
    contains(espMissing.detail, 'ESP toolchain', 'the first line has to name the thing that is missing');
    contains(espMissing.markdown, 'missing: espup, espflash');

    // With nothing open the old, safe reading is kept: report the probe-rs side, and the ESP toolchain
    // as a line rather than a fault.
    const nothing = healthSummary({
        status: noProbe,
        esp: espStatus({ missing: ['espup'] }),
        family: 'unknown',
        cargoOnShellPath: true,
    });
    contains(nothing.label, 'setup needed');
    notContains(nothing.markdown, 'espup', 'an RP-only user does not need the Xtensa toolchain');
});

/** An EspToolchainStatus with only what the health row reads filled in. */
function espStatus(options) {
    const missing = options.missing ?? [];
    return {
        espup: { found: !missing.includes('espup'), version: '0.14.0' },
        espflash: { found: !missing.includes('espflash'), version: '4.6.0' },
        toolchainInstalled: !missing.includes('toolchain'),
        exportFile: missing.includes('export-esp.sh') ? undefined : '/home/niel/export-esp.sh',
        chips: options.chips ?? ['esp32'],
        ready: options.ready ?? missing.length === 0,
    };
}

// The profile overrides live in the sidebar only: the status bar keeps its six, and the two buttons are
// one flash each rather than a setting that rewrites itself (2026-10-05).
test('the two profile overrides are sidebar controls, and the setting behind them exists', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf8'));
    const declared = new Map(manifest.contributes.commands.map((entry) => [entry.command, entry]));
    const shown = visibleControls(false).map((control) => control.command);
    const statusBar = CONTROLS.map((control) => control.command);
    const pkgSettings = manifest.contributes.configuration.properties;

    equal(FLASH_PROFILE_CONTROLS.length, 2, 'one for each profile');
    equal(FLASH_PROFILE_CONTROLS.map((c) => c.command).join(','),
        'rustyPlatform.flashDebug,rustyPlatform.flashRelease');

    for (const control of FLASH_PROFILE_CONTROLS) {
        ok(declared.has(control.command), `${control.command} is not declared in package.json`);
        ok(shown.includes(control.command), `${control.command} has to be reachable in the sidebar`);
        ok(!statusBar.includes(control.command), `${control.command} must not crowd the status bar`);
        ok(control.label.includes(control.command.endsWith('Debug') ? 'debug' : 'release'),
            'the label says which profile it writes');
        ok(control.tooltip.length > 60, 'and the tooltip explains when to reach for it');
    }

    const setting = pkgSettings['rustyPlatform.flashProfile'];
    ok(setting, 'the standing choice is a setting');
    equal(setting.enum.join(','), 'auto,debug,release');
    equal(setting.default, 'auto', 'auto is the default: the board knows best');
    equal(setting.enumDescriptions.length, 3, 'each value has to explain itself in the Settings UI');
});

// Flash, Debug and Monitor describe a *route*, and the route differs by family: they said "probe" and
// "RTT" on an ESP project, where Monitor runs `espflash monitor` and Debug has no breakpoints at all. The
// captions must not move — they are what the status bar shows and what the user has learned to press.
test('the rows that name a route are worded for the board in front of the user', () => {
    const rp = visibleControls(false);
    const esp = visibleControls(false, 'esp');
    const find = (list, id) => list.find((control) => control.command === id);

    equal(esp.map((c) => c.command).join(','), rp.map((c) => c.command).join(','), 'the same rows');
    equal(esp.map((c) => c.label).join(','), rp.map((c) => c.label).join(','), 'with the same captions');

    contains(find(rp, 'rustyPlatform.monitor').detail, 'RTT');
    contains(find(esp, 'rustyPlatform.monitor').detail, 'serial');
    contains(find(esp, 'rustyPlatform.monitor').tooltip, 'espflash monitor');
    notContains(find(esp, 'rustyPlatform.monitor').tooltip, 'probe-rs attach');

    contains(find(rp, 'rustyPlatform.debug').tooltip, 'probe-rs');
    contains(find(esp, 'rustyPlatform.debug').tooltip, 'JTAG', 'an ESP32 gets no breakpoints and is told so');
    notContains(find(esp, 'rustyPlatform.debug').tooltip, 'probe-rs debug session');

    contains(find(rp, 'rustyPlatform.flash').tooltip, 'probe');
    contains(find(esp, 'rustyPlatform.flash').tooltip, 'espflash');
    contains(find(esp, 'rustyPlatform.flash').tooltip, 'flashProfile', 'the profile setting is named where it matters');

    // The rows that are not about a route must not be rewritten at all.
    for (const id of ['rustyPlatform.build', 'rustyPlatform.clean', 'rustyPlatform.flashDebug', 'rustyPlatform.flashRelease']) {
        equal(find(esp, id).detail, find(rp, id).detail, `${id} is board-neutral`);
        equal(find(esp, id).tooltip, find(rp, id).tooltip, `${id} is board-neutral`);
    }

    // And a project we could not identify keeps the wording every line was written for.
    equal(visibleControls(false, 'unknown').map((c) => c.tooltip).join('|'),
        rp.map((c) => c.tooltip).join('|'));
});
