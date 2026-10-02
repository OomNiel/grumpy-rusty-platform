#!/usr/bin/env node
'use strict';

/**
 * Creates the scratch project that the extension development host opens, so the Rusty
 * Platform commands have something to act on as soon as F5 finishes.
 *
 * It lives under tests/tmp/ (gitignored) and is regenerated before every launch, so it can
 * never drift from the current generator or the pinned firmware hashes.
 *
 *   node tests/tools/make-demo-project.js
 *   DEMO_BOARD=pico DEMO_TEMPLATE=blinky node tests/tools/make-demo-project.js
 */

const fs = require('fs');
const path = require('path');
const { compiled, repoRoot } = require('../lib/harness');
const { installFirmware } = require('../lib/firmware');

const { boardById } = compiled('boards/catalog');
const { generateProjectFiles, requiredFirmware } = compiled('generate/files');

const boardId = process.env.DEMO_BOARD || 'pico2w';
const template = process.env.DEMO_TEMPLATE || 'blinky';

async function main() {
    const board = boardById(boardId);
    if (!board) {
        throw new Error(`unknown DEMO_BOARD "${boardId}"`);
    }

    const dir = path.join(repoRoot(), 'tests', 'tmp', `demo-${boardId}-${template}`);
    fs.rmSync(dir, { recursive: true, force: true });

    for (const file of generateProjectFiles({ board, projectName: `demo-${template}`, template })) {
        const target = path.join(dir, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.content, 'utf8');
    }

    // Wireless boards link the CYW43 blobs in, so they have to be in the project.
    const blobs = requiredFirmware(board, template).map((blob) => blob.fileName);
    if (blobs.length > 0) {
        await installFirmware(dir, blobs);
    }

    console.log(`demo project: ${dir}`);
    console.log(`  ${board.name}, template "${template}", ${blobs.length} firmware blob(s)`);
}

main().catch((error) => {
    console.error(`could not create the demo project: ${error.message}`);
    process.exit(1);
});
