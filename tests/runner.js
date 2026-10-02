#!/usr/bin/env node
'use strict';

/**
 * Test runner.
 *
 *   node tests/runner.js                    # t1 + t2 + t3 (fast, hermetic)
 *   node tests/runner.js --layer t1-logic   # one layer
 *   node tests/runner.js --file cargo-toml  # one file (substring match)
 *   node tests/runner.js --e2e              # + real `cargo build` of a generated project
 *   node tests/runner.js --hil              # + real flash onto attached hardware
 *   node tests/runner.js --no-compile       # skip the tsc pre-step
 *
 * Requires the compiled output in `out/`; the runner compiles unless --no-compile
 * so refactoring cannot leave stale JS behind.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const harness = require('./lib/harness');

const REPO_ROOT = path.join(__dirname, '..');
const LAYERS_DIR = path.join(__dirname, 'layers');

const ALWAYS = ['t1-logic', 't2-cli', 't3-golden'];
const OPT_IN = { e2e: 't4-e2e', hil: 't5-hil' };

function parseArgs(argv) {
    const options = { layers: [...ALWAYS], file: undefined, compile: true, onlyLayers: false, e2e: false, hil: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--layer') {
            const layer = argv[++i];
            if (!options.onlyLayers) {
                options.layers = [];
                options.onlyLayers = true;
            }
            options.layers.push(layer);
        } else if (arg === '--file') {
            options.file = argv[++i];
        } else if (arg === '--no-compile') {
            options.compile = false;
        } else if (arg === '--e2e') {
            options.e2e = true;
        } else if (arg === '--hil') {
            options.hil = true;
        } else if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        } else {
            console.error(`Unknown option: ${arg}`);
            printHelp();
            process.exit(2);
        }
    }
    if (!options.onlyLayers) {
        if (options.e2e) {
            options.layers.push(OPT_IN.e2e);
        }
        if (options.hil) {
            options.layers.push(OPT_IN.e2e, OPT_IN.hil);
        }
    }
    return options;
}

function printHelp() {
    console.log(`Usage: node tests/runner.js [options]

  --layer <name>   run only this layer (repeatable); also disables the default layers
  --file <substr>  run only test files whose path contains <substr>
  --e2e            include t4-e2e (real cargo build, slow, network)
  --hil            include t5-hil (real flash onto attached hardware)
  --no-compile     skip the tsc pre-step

Layers: ${[...ALWAYS, ...Object.values(OPT_IN)].join(', ')}`);
}

function compile() {
    const tsc = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!fs.existsSync(tsc)) {
        console.error('TypeScript is not installed. Run `npm install` first.');
        process.exit(2);
    }
    const result = spawnSync(process.execPath, [tsc, '-p', '.'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (result.status !== 0) {
        console.error(result.stdout || '');
        console.error(result.stderr || '');
        console.error('Compilation failed — tests were not run.');
        process.exit(1);
    }
}

function discover(layer) {
    const dir = path.join(LAYERS_DIR, layer);
    if (!fs.existsSync(dir)) {
        return [];
    }
    return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.test.js'))
        .sort()
        .map((name) => path.join(dir, name));
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.compile) {
        compile();
    }

    const started = Date.now();
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const failures = [];

    for (const layer of options.layers) {
        const files = discover(layer);
        if (files.length === 0) {
            continue;
        }
        console.log(`\n▸ ${layer}`);

        for (const file of files) {
            const relative = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
            if (options.file && !relative.includes(options.file)) {
                continue;
            }

            const record = harness.beginFile(relative, layer);
            try {
                require(file);
            } catch (error) {
                failed += 1;
                failures.push({ name: `${relative} (failed to load)`, error });
                console.log(`  ✗ ${relative} — failed to load: ${error.message}`);
                continue;
            }

            for (const testCase of record.cases) {
                if (testCase.skip) {
                    skipped += 1;
                    console.log(`  ○ ${testCase.name} — ${testCase.skip}`);
                    continue;
                }
                try {
                    const returned = testCase.fn();
                    if (returned && typeof returned.then === 'function') {
                        await returned;
                    }
                    passed += 1;
                    console.log(`  ✓ ${testCase.name}`);
                } catch (error) {
                    if (error instanceof harness.SkipSignal) {
                        skipped += 1;
                        console.log(`  ○ ${testCase.name} — ${error.message}`);
                        continue;
                    }
                    failed += 1;
                    failures.push({ name: `${testCase.name} (${relative})`, error });
                    console.log(`  ✗ ${testCase.name}`);
                    console.log(`      ${String(error.message).split('\n').join('\n      ')}`);
                }
            }
        }
    }

    const elapsed = Date.now() - started;
    console.log('');
    if (failures.length > 0) {
        console.log(`${failed} failed, ${passed} passed, ${skipped} skipped (${elapsed} ms)`);
        process.exitCode = 1;
    } else {
        console.log(`${passed} passed, ${skipped} skipped (${elapsed} ms)`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
