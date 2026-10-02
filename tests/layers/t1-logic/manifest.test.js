'use strict';

/**
 * The manifest has to agree with the code.
 *
 * Two drifts already happened here: `rustyPlatform.defaultBoard` listed only the first two
 * boards (so a W board could not be pre-selected in the wizard), and nothing checked that a
 * command registered in the code actually exists in the palette. Both are cheap to pin.
 */

const fs = require('fs');
const path = require('path');
const { test, ok, equal } = require('../../lib/harness');
const { compiled, repoRoot } = require('../../lib/harness');
const { BOARDS } = compiled('boards/catalog');

function readManifest() {
    return JSON.parse(fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf8'));
}

/** Every .ts file under src/, so the command scan cannot miss one. */
function sourceFiles(dir) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            found.push(...sourceFiles(full));
        } else if (entry.name.endsWith('.ts')) {
            found.push(full);
        }
    }
    return found;
}

test('every board can be chosen as the wizard default', () => {
    const manifest = readManifest();
    const properties = manifest.contributes.configuration.properties;
    const allowed = properties['rustyPlatform.defaultBoard'].enum;

    for (const board of BOARDS) {
        ok(allowed.includes(board.id), `${board.id} is missing from rustyPlatform.defaultBoard`);
    }
    equal(allowed.length, BOARDS.length, 'and the enum must not list boards that do not exist');
    ok(allowed.includes(properties['rustyPlatform.defaultBoard'].default), 'the default must be one of them');
});

test('every command the code registers is declared in the manifest', () => {
    const manifest = readManifest();
    const declared = new Set(manifest.contributes.commands.map((entry) => entry.command));

    const registered = new Set();
    for (const file of sourceFiles(path.join(repoRoot(), 'src'))) {
        const text = fs.readFileSync(file, 'utf8');
        for (const match of text.matchAll(/registerCommand\(\s*'([^']+)'/g)) {
            registered.add(match[1]);
        }
    }

    ok(registered.size >= 8, `expected to find the commands, found ${registered.size}`);
    for (const command of registered) {
        ok(declared.has(command), `${command} is registered in the code but not declared in package.json`);
    }
});

test('the manifest points at files that exist', () => {
    const manifest = readManifest();
    const icon = manifest.contributes.viewsContainers.activitybar[0].icon;
    ok(fs.existsSync(path.join(repoRoot(), icon)), `missing activity bar icon: ${icon}`);

    const main = path.join(repoRoot(), manifest.main);
    ok(fs.existsSync(main), `missing extension entry point: ${manifest.main}`);
});
