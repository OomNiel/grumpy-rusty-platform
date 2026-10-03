'use strict';

/**
 * t2-cli: detecting the Espressif toolchain with fake `espup` / `espflash` / `rustup`.
 *
 * Real child processes and real file checks, no real toolchain -- the point is that the
 * extension knows the difference between "espup is not installed" and "espup is installed but
 * the Xtensa toolchain was never downloaded", because those need different advice.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, ok, equal, notOk } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');

const { detectEspToolchain } = compiled('toolchain/espDetect');
const { execFileFn } = compiled('util/exec');
const { espInstallCommands } = compiled('toolchain/espToolchain');

const SHIMS = path.join(__dirname, 'shims');
const CHIPS = ['esp32', 'esp32s3'];

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

/** A throwaway home directory, optionally holding espup's export file. */
function withHome(files = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rusty-esp-'));
    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), content);
    }
    return dir;
}

function options(homeDir) {
    return {
        chips: CHIPS,
        espupPath: path.join(SHIMS, 'espup'),
        espflashPath: path.join(SHIMS, 'espflash'),
        rustupPath: path.join(SHIMS, 'rustup'),
        homeDir,
    };
}

const EXPORT = 'export PATH="$HOME/.rustup/toolchains/esp/bin:$PATH"\n';

test('a machine with nothing installed reports every piece as missing', async () => {
    const home = withHome();
    try {
        const status = await withEnv(
            { SHIM_ESPUP_VERSION: undefined, SHIM_ESPFLASH_VERSION: undefined, SHIM_TOOLCHAINS: '' },
            () => detectEspToolchain(execFileFn, options(home)),
        );

        equal(status.ready, false);
        equal(status.espup.found, false, 'the shim exists but behaves like a missing binary');
        equal(status.espflash.found, false);
        equal(status.toolchainInstalled, false);
        equal(status.exportFile, undefined, 'no export file means espup never ran');
        equal(
            espInstallCommands(status, status.chips).map((step) => step.id),
            ['espup', 'toolchain', 'espflash'],
            'the plan has to cover all three',
        );
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('the installed versions are read from the tools themselves', async () => {
    const home = withHome();
    try {
        const status = await withEnv(
            { SHIM_ESPUP_VERSION: '0.18.0', SHIM_ESPFLASH_VERSION: '4.6.0' },
            () => detectEspToolchain(execFileFn, options(home)),
        );
        equal(status.espup.version, '0.18.0');
        equal(status.espflash.version, '4.6.0');
        ok(status.espup.path.endsWith('/shims/espup'), 'the shim is the tool that was found');
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('rustup\'s toolchain list decides whether the Xtensa toolchain is there', async () => {
    const home = withHome();
    try {
        const installed = await withEnv(
            { SHIM_TOOLCHAINS: 'stable-x86_64-unknown-linux-gnu (default)\nesp' },
            () => detectEspToolchain(execFileFn, options(home)),
        );
        equal(installed.toolchainInstalled, true);

        const missing = await withEnv(
            { SHIM_TOOLCHAINS: 'stable-x86_64-unknown-linux-gnu (default)' },
            () => detectEspToolchain(execFileFn, options(home)),
        );
        equal(missing.toolchainInstalled, false, 'a stable toolchain is not the Xtensa one');
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('everything installed means ready, with no install steps left', async () => {
    const home = withHome({ 'export-esp.sh': EXPORT });
    try {
        const status = await withEnv(
            {
                SHIM_ESPUP_VERSION: '0.18.0',
                SHIM_ESPFLASH_VERSION: '4.6.0',
                SHIM_TOOLCHAINS: 'esp',
            },
            () => detectEspToolchain(execFileFn, options(home)),
        );

        equal(status.ready, true);
        equal(status.exportFile, path.join(home, 'export-esp.sh'));
        equal(status.chips, CHIPS);
        equal(espInstallCommands(status, status.chips), []);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('a vanished espflash is the only thing planned for', async () => {
    const home = withHome({ 'export-esp.sh': EXPORT });
    try {
        const status = await withEnv(
            {
                SHIM_ESPUP_VERSION: '0.18.0',
                SHIM_ESPFLASH_VERSION: undefined,
                SHIM_TOOLCHAINS: 'esp',
            },
            () => detectEspToolchain(execFileFn, options(home)),
        );
        equal(status.ready, false);
        notOk(status.espflash.found);
        equal(
            espInstallCommands(status, status.chips).map((step) => step.command),
            ['cargo install espflash --locked'],
        );
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});
