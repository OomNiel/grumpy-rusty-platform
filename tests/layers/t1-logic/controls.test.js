'use strict';

/**
 * The status bar and the sidebar's "Controls" section are two renderings of one list, so the list is
 * what gets pinned here: the commands, their order, and the single control that only exists while a
 * probe-rs session runs. A drift between the two views shows up as a button the user can press in one
 * place but not the other.
 */

const fs = require('fs');
const path = require('path');
const { test, ok, equal, contains } = require('../../lib/harness');
const { compiled, repoRoot } = require('../../lib/harness');
const {
    CONTROLS,
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
        probeDiagnosis: { kind: probe.includes('outdated') ? 'firmware-outdated' : 'ok', message: probe },
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
    const detecting = healthSummary(undefined);
    contains(detecting.label, 'detecting');

    const ready = healthSummary(status({ ready: true }));
    contains(ready.label, 'ready');
    contains(ready.detail, 'cargo 1.99.0');
    contains(ready.detail, 'probe-rs 0.32.0');
    contains(ready.markdown, '**targets** thumbv8m.main-none-eabihf');
    ok(!ready.markdown.includes('x86_64-unknown-linux-gnu'), 'the host target is noise in the tooltip');

    const broken = healthSummary(
        status({
            ready: false,
            missing: ['thumbv6m-none-eabi'],
            probe: 'Debug Probe firmware is outdated and must be updated.',
        }),
    );
    contains(broken.label, 'setup needed');
    contains(broken.markdown, 'missing targets: thumbv6m-none-eabi');
    contains(broken.markdown, 'firmware is outdated');
    contains(broken.detail, 'missing targets', 'the sidebar row needs its one-line reason');
    equal(broken.icon, 'warning');
});
