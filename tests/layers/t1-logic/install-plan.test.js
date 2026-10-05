'use strict';

const fs = require('fs');
const path = require('path');
const { test, ok, equal, notOk, contains, repoRoot } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const {
    planInstallation,
    probeRsAssetFor,
    rustupInitUrl,
    rustupInitTarget,
    PROBE_RS_VERSION,
    UDEV_RULES_CONTENT,
    UDEV_RULES_PATH,
} = compiled('toolchain/installPlan');
// Only the RP triples are rustup's business. The Xtensa targets live in Espressif's fork of
// rustc and arrive with espup, so a rustup plan that mentions them is asking for the impossible.
const { rpTargets } = compiled('boards/catalog');

/** Builds a ToolchainStatus with sensible "nothing installed" defaults. */
function status(overrides = {}) {
    return {
        platform: 'linux',
        rustup: { name: 'rustup', found: false },
        cargo: { name: 'cargo', found: false },
        probeRs: { name: 'probe-rs', found: false },
        installedTargets: [],
        missingTargets: [...rpTargets()],
        probes: [],
        probeDiagnosis: { kind: 'none-connected', message: 'No debug probe detected.' },
        udevRulesPresent: false,
        ready: false,
        ...overrides,
    };
}

const LINUX = { targets: rpTargets(), platform: 'linux', arch: 'x64' };
const WIN = { targets: rpTargets(), platform: 'win32', arch: 'x64' };
const MAC = { targets: rpTargets(), platform: 'darwin', arch: 'arm64' };

test('a bare Linux machine gets rustup, targets, probe-rs and udev, in that order', () => {
    const steps = planInstallation(status(), LINUX);
    equal(
        steps.map((s) => s.kind),
        ['rustup', 'target', 'target', 'probe-rs', 'udev'],
    );
    equal(steps[0].id, 'rustup');
    equal(steps[steps.length - 1].id, 'udev');
});

test('the udev step is the only one needing elevation', () => {
    const steps = planInstallation(status(), LINUX);
    for (const step of steps) {
        equal(step.requiresElevation, step.kind === 'udev', `${step.id} elevation flag is wrong`);
    }
});

test('one target step per missing triple', () => {
    const steps = planInstallation(status(), LINUX);
    const targets = steps.filter((s) => s.kind === 'target').map((s) => s.target);
    equal(targets, rpTargets());
});

test('a complete Linux toolchain plans nothing', () => {
    const complete = status({
        rustup: { name: 'rustup', found: true, version: '1.29.1' },
        cargo: { name: 'cargo', found: true, version: '1.99.0' },
        probeRs: { name: 'probe-rs', found: true, version: '0.32.0' },
        installedTargets: rpTargets(),
        missingTargets: [],
        udevRulesPresent: true,
        ready: true,
    });
    equal(planInstallation(complete, LINUX), []);
});

test('only the missing targets are planned when the rest is present', () => {
    const partial = status({
        rustup: { name: 'rustup', found: true },
        cargo: { name: 'cargo', found: true },
        probeRs: { name: 'probe-rs', found: true },
        installedTargets: ['thumbv6m-none-eabi'],
        missingTargets: ['thumbv8m.main-none-eabihf'],
        udevRulesPresent: true,
    });
    const steps = planInstallation(partial, LINUX);
    equal(steps.map((s) => s.kind), ['target']);
    equal(steps[0].target, 'thumbv8m.main-none-eabihf');
    contains(steps[0].detail, 'rustup target add thumbv8m.main-none-eabihf');
});

test('a missing cargo triggers a rustup install that also carries the targets', () => {
    const steps = planInstallation(status({ rustup: { name: 'rustup', found: true } }), LINUX);
    equal(steps[0].kind, 'rustup');
    equal(
        steps.filter((s) => s.kind === 'target').length,
        rpTargets().length,
        'targets cannot be added without rustup, so they ride along with it',
    );
});

test('no udev step outside Linux', () => {
    for (const options of [WIN, MAC]) {
        const steps = planInstallation(status({ platform: options.platform }), options);
        notOk(steps.some((s) => s.kind === 'udev'), `${options.platform} must not plan a udev step`);
    }
});

test('a missing probe-rs becomes a probe-rs step only', () => {
    const steps = planInstallation(
        status({
            rustup: { name: 'rustup', found: true },
            cargo: { name: 'cargo', found: true },
            installedTargets: rpTargets(),
            missingTargets: [],
            udevRulesPresent: true,
            ready: true,
        }),
        LINUX,
    );
    equal(steps.map((s) => s.kind), ['probe-rs']);
    ok(steps[0].asset, 'the probe-rs step should carry a prebuilt release asset');
});

test('rustup-init URLs are correct per platform', () => {
    equal(
        rustupInitUrl('linux', 'x64'),
        'https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init',
    );
    equal(
        rustupInitUrl('win32', 'x64'),
        'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe',
    );
    equal(
        rustupInitUrl('darwin', 'arm64'),
        'https://static.rust-lang.org/rustup/dist/aarch64-apple-darwin/rustup-init',
    );
    equal(rustupInitTarget('linux', 'ia32'), undefined);
    equal(rustupInitUrl('linux', 'ia32'), undefined);
});

test('probe-rs assets are pinned to the verified release', () => {
    const linux = probeRsAssetFor('linux', 'x64');
    equal(linux.fileName, 'probe-rs-tools-x86_64-unknown-linux-gnu.tar.xz');
    equal(linux.kind, 'tar.xz');
    contains(linux.url, `/v${PROBE_RS_VERSION}/`);
    contains(linux.url, 'github.com/probe-rs/probe-rs/releases/download');
    equal(linux.binaries, ['probe-rs', 'cargo-embed', 'cargo-flash']);
});

test('Windows gets a zip archive with .exe binaries', () => {
    const win = probeRsAssetFor('win32', 'x64');
    equal(win.kind, 'zip');
    contains(win.fileName, 'x86_64-pc-windows-msvc.zip');
    equal(win.binaries, ['probe-rs.exe', 'cargo-embed.exe', 'cargo-flash.exe']);
});

test('Apple silicon gets an aarch64 archive', () => {
    const mac = probeRsAssetFor('darwin', 'arm64');
    equal(mac.fileName, 'probe-rs-tools-aarch64-apple-darwin.tar.xz');
});

test('unsupported platforms fall back to a source build (no asset)', () => {
    equal(probeRsAssetFor('linux', 'ia32'), undefined);
    equal(probeRsAssetFor('freebsd', 'x64'), undefined);
});

test('the no-asset probe-rs step tells the user to build from source', () => {
    const options = { targets: [], platform: 'freebsd', arch: 'x64' };
    const steps = planInstallation(status({ platform: 'freebsd', missingTargets: [] }), options);
    const probeStep = steps.find((s) => s.kind === 'probe-rs');
    ok(probeStep, 'expected a probe-rs step');
    equal(probeStep.asset, undefined);
    contains(probeStep.detail, 'cargo install probe-rs-tools');
});

test('the udev rules cover the Raspberry Pi vendor id and use uaccess', () => {
    contains(UDEV_RULES_CONTENT, 'ATTR{idVendor}=="2e8a"');
    contains(UDEV_RULES_CONTENT, 'TAG+="uaccess"');
    equal(UDEV_RULES_PATH, '/etc/udev/rules.d/69-probe-rs.rules');
});

test('rustup is never asked for a target it cannot install', () => {
    // Reported 2026-10-05, from an ESP32 project: "Setup did not finish: rustup exited with 1: error: toolchain
    // 'stable-x86_64-unknown-linux-gnu' has no prebuilt artifacts available for target
    // 'xtensa-esp32-none-elf'". Xtensa exists only in Espressif's fork, which `espup` installs — so a plan that
    // lists it as a `rustup target add` step can only fail. `rpTargets`/`espTargets` documented the split; the
    // planners had not been told.
    const catalog = compiled('boards/catalog');
    ok(catalog.isRustupTarget('thumbv6m-none-eabi'));
    ok(catalog.isRustupTarget('thumbv8m.main-none-eabihf'));
    ok(catalog.isRustupTarget('riscv32imc-unknown-none-elf'));
    ok(catalog.isRustupTarget('x86_64-unknown-linux-gnu'));
    notOk(catalog.isRustupTarget('xtensa-esp32-none-elf'));
    notOk(catalog.isRustupTarget('xtensa-esp32s3-none-elf'));
    notOk(catalog.isRustupTarget(' xtensa-esp32-none-elf '));
    ok(catalog.isRustupTarget(''), 'an empty triple is not an Xtensa one; nothing is asked of rustup for it');

    // And the plan itself: the two families must not be lumped together (the source of the failure).
    const plan = fs.readFileSync(path.join(repoRoot(), 'src/toolchain/installPlan.ts'), 'utf8');
    ok((plan.match(/filter\(isRustupTarget\)/g) || []).length >= 2, 'both planners filter, not just one');
});
