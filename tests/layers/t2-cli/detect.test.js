'use strict';

/**
 * t2-cli: toolchain detection driven by fake `cargo` / `rustup` / `probe-rs`
 * executables. Real child processes, real PATH resolution, no real toolchain —
 * so this layer is hermetic and safe in CI.
 */

const fs = require('fs');
const path = require('path');
const { test, skip, ok, equal, notOk, contains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');

const { detectToolchain } = compiled('toolchain/detect');
const { execFileFn } = compiled('util/exec');
const { allTargets } = compiled('boards/catalog');

const SHIMS = path.join(__dirname, 'shims');
const PICO_TARGET = 'thumbv6m-none-eabi';
const PICO2_TARGET = 'thumbv8m.main-none-eabihf';
const ALL_TARGETS = allTargets();

const REAL_PROBE = 'The following debug probes were found:\n[0]: Debug Probe (CMSIS-DAP) -- 2e8a:000c-0:E6614103E74B072F (CMSIS-DAP)';

const OUTDATED_FIRMWARE =
  'Error: Failed to open probe: Failed to open the debug probe.\n\n' +
  'Caused by:\n    0: The debug probe could not be created.\n' +
  '    1: An error specific with the selected probe occurred.\n' +
  '    2: The firmware on the probe is outdated, and not supported by probe-rs. The minimum supported firmware version is 2.2.0.';

/** Sets SHIM_* environment variables for the duration of `fn`. */
async function withEnv(vars, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function options(overrides = {}) {
  return {
    cargoPath: path.join(SHIMS, 'cargo'),
    rustupPath: path.join(SHIMS, 'rustup'),
    probeRsPath: path.join(SHIMS, 'probe-rs'),
    udevRulesPresent: () => true,
    requiredTargets: ALL_TARGETS,
    ...overrides,
  };
}

if (process.platform === 'win32') {
  test('t2-cli layer', () => {
    skip('t2-cli shims are POSIX shell scripts', 'skipped on Windows');
  });
} else {
  test('the shims exist and are executable', () => {
    for (const name of ['cargo', 'rustup', 'probe-rs']) {
      const file = path.join(SHIMS, name);
      ok(fs.existsSync(file), `${name} shim missing`);
      fs.accessSync(file, fs.constants.X_OK);
    }
  });

  test('a fully provisioned machine reports ready', async () => {
    const status = await withEnv(
      {
        SHIM_TARGETS: ALL_TARGETS.join('\n'),
        SHIM_PROBE_LIST: REAL_PROBE,
      },
      () => detectToolchain(execFileFn, options()),
    );

    equal(status.ready, true);
    equal(status.cargo.found, true);
    equal(status.cargo.version, '1.99.0');
    equal(status.rustup.version, '1.29.1');
    equal(status.probeRs.version, '0.32.0');
    equal(status.missingTargets, []);
    equal(status.probes.length, 1);
    equal(status.probeDiagnosis.kind, 'ok');
  });

  test('the detected executable paths are the shims, not a real toolchain', async () => {
    const status = await withEnv({ SHIM_TARGETS: ALL_TARGETS.join('\n') }, () =>
      detectToolchain(execFileFn, options()),
    );
    equal(status.cargo.path, path.join(SHIMS, 'cargo'));
    equal(status.probeRs.path, path.join(SHIMS, 'probe-rs'));
  });

  test('a missing target is reported and blocks readiness', async () => {
    const status = await withEnv(
      { SHIM_TARGETS: [PICO_TARGET, 'x86_64-unknown-linux-gnu'].join('\n') },
      () => detectToolchain(execFileFn, options()),
    );
    equal(status.missingTargets, [PICO2_TARGET]);
    equal(status.ready, false);
  });

  test('an empty target list means every supported target is missing', async () => {
    const status = await withEnv({ SHIM_TARGETS: '' }, () => detectToolchain(execFileFn, options()));
    equal(status.installedTargets, []);
    equal(status.missingTargets, ALL_TARGETS);
  });

  test('outdated probe firmware is surfaced with the required version', async () => {
    const status = await withEnv(
      {
        SHIM_TARGETS: ALL_TARGETS.join('\n'),
        SHIM_PROBE_LIST: REAL_PROBE,
        SHIM_INFO_ERR: OUTDATED_FIRMWARE,
      },
      () => detectToolchain(execFileFn, options()),
    );
    equal(status.probes.length, 1, 'the probe is still enumerable');
    equal(status.probeDiagnosis.kind, 'firmware-outdated');
    contains(status.probeDiagnosis.message, '2.2.0');
    equal(status.ready, true, 'a probe problem must not block building the project');
  });

  test('no connected probe is reported without failing detection', async () => {
    const status = await withEnv(
      { SHIM_TARGETS: ALL_TARGETS.join('\n'), SHIM_PROBE_LIST: undefined },
      () => detectToolchain(execFileFn, options()),
    );
    equal(status.probes, []);
    equal(status.probeDiagnosis.kind, 'none-connected');
    equal(status.probeRs.found, true, 'probe-rs itself is still installed');
  });

  test('a permission failure is diagnosed as such', async () => {
    const status = await withEnv(
      {
        SHIM_TARGETS: ALL_TARGETS.join('\n'),
        SHIM_PROBE_LIST: REAL_PROBE,
        SHIM_INFO_ERR: 'Error: Failed to open probe: Permission denied (os error 13)',
      },
      () => detectToolchain(execFileFn, options()),
    );
    equal(status.probeDiagnosis.kind, 'permission-denied');
  });

  test('a missing cargo path is reported as not found', async () => {
    const status = await withEnv(
      { SHIM_TARGETS: ALL_TARGETS.join('\n') },
      () => detectToolchain(execFileFn, options({ cargoPath: path.join(SHIMS, 'does-not-exist') })),
    );
    equal(status.cargo.found, false);
    equal(status.ready, false);
  });

  test('missing udev rules are reported on Linux only', async () => {
    const linux = await withEnv({ SHIM_TARGETS: ALL_TARGETS.join('\n') }, () =>
      detectToolchain(execFileFn, options({ udevRulesPresent: () => false })),
    );
    equal(linux.udevRulesPresent, false);
    equal(linux.platform, process.platform);

    const withRules = await withEnv({ SHIM_TARGETS: ALL_TARGETS.join('\n') }, () =>
      detectToolchain(execFileFn, options({ udevRulesPresent: () => true })),
    );
    equal(withRules.udevRulesPresent, true);
  });

  test('a failing rustup target listing does not throw', async () => {
    const status = await withEnv({ SHIM_TARGETS: undefined }, () =>
      detectToolchain(execFileFn, options({ rustupPath: path.join(SHIMS, 'does-not-exist') })),
    );
    notOk(status.rustup.found);
    equal(status.installedTargets, []);
    equal(status.missingTargets, ALL_TARGETS);
  });
}
