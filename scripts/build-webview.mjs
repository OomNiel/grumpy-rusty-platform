#!/usr/bin/env node
// Bundles the designer's frontend into one script the webview can load.
//
// The designer's canvas is a real application -- a toolbox, a draggable canvas, a property panel and undo --
// and the extension has no bundler today: its one existing webview builds its markup as a string in
// TypeScript. That is fine for a chat panel and hopeless for this.
//
// Two properties matter here and are the reason the entry point is bundled rather than copied:
//
//   * The pure logic (the document model, the catalogue, the grid mapping, the editing operations) lives in
//     `src/designer/` and is compiled by `tsc` for the tests. The frontend imports the same files, so there
//     is one implementation of the rules rather than one per side of the message channel.
//   * Nothing is minified. A designer's frontend is the kind of code someone will want to read in a
//     `--disable-extensions`-broken panel, and the size is not worth the obscurity.
//
// Run by `npm run compile`, so `vsce package` cannot ship a stale bundle.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const result = await build({
    entryPoints: [path.join(root, 'webview', 'designer', 'main.ts')],
    outfile: path.join(root, 'out', 'webview', 'designer.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    minify: false,
    logLevel: 'warning',
    metafile: true,
});

const outputs = Object.entries(result.metafile.outputs);
for (const [file, info] of outputs) {
    const bytes = info.bytes;
    const size = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`;
    console.log(`built ${path.relative(root, file)} (${size})`);
}
