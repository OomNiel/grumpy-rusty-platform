#!/usr/bin/env node
'use strict';

/**
 * Drives `probe-rs dap-server` over DAP exactly the way VS Code does, so a launch configuration can
 * be tested without a human driving the IDE:
 *
 *     initialize -> attach/launch -> setBreakpoints -> configurationDone -> wait for `stopped`
 *
 * It answers the question "does a breakpoint set *before* the session starts actually fire?", which
 * is not the same question as "did the debugger accept it". Measured on the bench, 2026-10-03:
 *
 *   - `request: "attach"` programs a breakpoint perfectly (`verified: true`, a real address) and the
 *     core does halt on it - but only when that code runs again (a loop, an interrupt, a timer).
 *     Code that has already run (`main`, the boot banner, the Wi-Fi setup) can never be reached, and
 *     probe-rs rejects the reset options for an `attach` request outright, so nothing can bring it
 *     back. Those breakpoints look solid in the gutter and never fire.
 *   - A `launch` with `flashingConfig.flashingEnabled: false` writes nothing to the chip but *does*
 *     reset the target, so the same breakpoints bind anywhere. That is what the generated
 *     `Restart & Debug, no flashing` entry uses.
 *
 * So `verified: true` means "the source line resolved to an address", never "it will fire". This tool
 * reports both, which is how those two facts were told apart in the first place.
 *
 * Usage:
 *   node tests/tools/dap-session.js --project <dir> --line <n> [options]
 *
 * Options:
 *   --project <dir>   project folder holding .vscode/launch.json
 *                     (default: tests/tmp/demo-pico2w-blinky, as made by make-demo-project.js)
 *   --line <n>        line to break on; repeat the option to set several at once (leave it out to only
 *                     check that a session starts at all)
 *   --file <path>     source file for the breakpoint (default: <project>/src/main.rs)
 *   --config <text>   use the configuration whose name contains <text>, case-insensitive
 *                     (default: the first `attach` entry, otherwise the first configuration)
 *   --as <request>    override the request type: `attach` or `launch`
 *   --flash           with --as launch: write the chip first (off by default - see below)
 *   --halt            with --as launch: stop on the reset vector instead of running
 *   --wait <ms>       how long to wait for a stop event (default 12000)
 *   --pause           if nothing stopped, halt the core and continue once, then wait again. This is
 *                     the "does halting make it bind?" experiment, and it is how the two behaviours
 *                     above were separated.
 *   --port <n>        TCP port for the adapter to listen on (default 50779)
 *   --verbose         print every DAP message, not only the interesting ones
 *
 * Exit codes: 0 = stopped where it was asked to, 1 = the breakpoints were programmed but none fired,
 * 2 = the session could not run at all.
 *
 * The session is built from the chosen entry's `chip`, `coreConfigs` and `name`; whether it writes the
 * chip comes from the flags, and the default is **not** to - pass `--flash` for that. A session that
 * flashes writes the attached target, so it is opt-in. The tool never chooses a probe of its own: it
 * writes whatever chip the connected probe is wired to.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const { compiled, repoRoot } = require('../lib/harness');
const { augmentedEnv, findExecutable } = compiled('util/exec');
const { parseJsonc } = compiled('project/launchConfig');

const EXIT_STOPPED = 0;
const EXIT_NO_STOP = 1;
const EXIT_CANNOT_RUN = 2;

const HELP = 'Run with --help for the options.';

function parseArgs(argv) {
    const options = { lines: [], wait: 12_000, port: 50779, verbose: false, flash: false, halt: false, pause: false };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        const value = () => {
            const next = argv[++index];
            if (next === undefined) {
                throw new Error(`${arg} needs a value`);
            }
            return next;
        };
        switch (arg) {
            case '--help':
            case '-h':
                options.help = true;
                break;
            case '--project':
                options.project = value();
                break;
            case '--config':
                options.config = value();
                break;
            case '--as':
                options.as = value();
                break;
            case '--file':
                options.file = value();
                break;
            case '--line':
                options.lines.push(Number(value()));
                break;
            case '--wait':
                options.wait = Number(value());
                break;
            case '--port':
                options.port = Number(value());
                break;
            case '--flash':
                options.flash = true;
                break;
            case '--halt':
                options.halt = true;
                break;
            case '--pause':
                options.pause = true;
                break;
            case '--verbose':
                options.verbose = true;
                break;
            default:
                throw new Error(`unknown option ${arg}. ${HELP}`);
        }
    }
    if (options.as !== undefined && !['attach', 'launch'].includes(options.as)) {
        throw new Error(`--as takes "attach" or "launch", not "${options.as}"`);
    }
    if (options.lines.some((line) => !Number.isFinite(line))) {
        throw new Error('--line takes a number');
    }
    return options;
}

function readConfigurations(project) {
    const launchJson = path.join(project, '.vscode', 'launch.json');
    const text = fs.readFileSync(launchJson, 'utf8');
    const parsed = parseJsonc(text);
    const configurations = parsed?.configurations;
    if (!Array.isArray(configurations) || configurations.length === 0) {
        throw new Error(`${launchJson} has no configurations`);
    }
    return configurations;
}

function pickConfiguration(configurations, wanted) {
    if (wanted === undefined) {
        return configurations.find((entry) => entry.request === 'attach') ?? configurations[0];
    }
    const needle = wanted.toLowerCase();
    const matches = configurations.filter((entry) => String(entry.name ?? '').toLowerCase().includes(needle));
    if (matches.length === 0) {
        const available = configurations.map((entry) => `  ${entry.name}`).join('\n');
        throw new Error(`no configuration name contains "${wanted}". Available:\n${available}`);
    }
    return matches[0];
}

/** The DAP client: framing, pending requests, and the events that matter. */
class DapClient {
    constructor(port, verbose) {
        this.port = port;
        this.verbose = verbose;
        this.socket = new net.Socket();
        this.buffer = Buffer.alloc(0);
        this.seq = 0;
        this.pending = new Map();
        this.events = [];
        this.stopped = undefined;
        this.rtt = [];
        this.console = [];
    }

    /** The adapter needs a moment before its port accepts connections; VS Code retries the same way. */
    async connect() {
        for (let attempt = 0; attempt < 40; attempt++) {
            // eslint-disable-next-line no-await-in-loop
            const connected = await new Promise((resolve) => {
                const onConnect = () => {
                    this.socket.off('error', onError);
                    resolve(true);
                };
                const onError = () => {
                    this.socket.off('connect', onConnect);
                    resolve(false);
                };
                this.socket.once('connect', onConnect);
                this.socket.once('error', onError);
                this.socket.connect(this.port, '127.0.0.1');
            });
            if (connected) {
                return;
            }
            this.socket.destroy();
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
        throw new Error('the debug adapter never started listening');
    }

    /** Reads one `Content-Length` framed message after another out of the stream. */
    listen() {
        this.socket.on('data', (chunk) => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            for (; ;) {
                const headerEnd = this.buffer.indexOf('\r\n\r\n');
                if (headerEnd < 0) {
                    return;
                }
                const match = /Content-Length: (\d+)/i.exec(this.buffer.slice(0, headerEnd).toString('utf8'));
                const length = Number(match[1]);
                if (this.buffer.length < headerEnd + 4 + length) {
                    return;
                }
                const body = this.buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
                this.buffer = this.buffer.slice(headerEnd + 4 + length);
                this.handle(JSON.parse(body));
            }
        });
    }

    send(command, args) {
        const request = { seq: ++this.seq, type: 'request', command, arguments: args };
        const payload = Buffer.from(JSON.stringify(request), 'utf8');
        this.socket.write(`Content-Length: ${payload.length}\r\n\r\n`);
        this.socket.write(payload);
        if (this.verbose) {
            console.log(`REQUEST  ${command} ${JSON.stringify(args)}`);
        }
        return new Promise((resolve) => this.pending.set(request.seq, resolve));
    }

    handle(message) {
        if (message.type === 'event') {
            this.events.push(message.event);
            if (message.event === 'stopped') {
                this.stopped = message.body;
            }
            if (message.event === 'probe-rs-rtt-data') {
                this.rtt.push(message.body?.data ?? '');
            }
            if (message.event === 'output' && message.body?.category === 'console') {
                this.console.push((message.body.output ?? '').trimEnd());
            }
            if (this.verbose || ['stopped', 'continued'].includes(message.event)) {
                console.log(`EVENT    ${message.event} ${JSON.stringify(message.body ?? {})}`);
            }
            return;
        }
        if (message.type === 'response') {
            if (this.verbose) {
                console.log(
                    `RESPONSE ${message.command} success=${message.success} ` +
                    JSON.stringify(message.body ?? message.message ?? ''),
                );
            }
            const resolve = this.pending.get(message.request_seq);
            if (resolve) {
                this.pending.delete(message.request_seq);
                resolve(message);
            }
        }
    }

    /** Waits for a `stopped` event, or gives up. Returns the event body or undefined. */
    async waitForStop(milliseconds) {
        const deadline = Date.now() + milliseconds;
        while (Date.now() < deadline && this.stopped === undefined) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return this.stopped;
    }
}

function startAdapter(probeRs, port, cwd) {
    const adapter = spawn(probeRs, ['dap-server', '--port', String(port), '--vscode'], {
        cwd,
        env: { ...augmentedEnv(), CLICOLOR_FORCE: '1' },
    });
    adapter.stderr.on('data', (data) => process.stderr.write(`[adapter] ${data}`));
    return adapter;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        const source = fs.readFileSync(__filename, 'utf8');
        const header = source.slice(source.indexOf('/**') + 3, source.indexOf('*/'));
        console.log(
            header
                .split('\n')
                .map((line) => line.replace(/^\s*\*\s?/, ''))
                .join('\n')
                .trim(),
        );
        return EXIT_STOPPED;
    }

    const project = path.resolve(options.project ?? path.join(repoRoot(), 'tests', 'tmp', 'demo-pico2w-blinky'));
    const configurations = readConfigurations(project);
    const chosen = pickConfiguration(configurations, options.config);

    const request = options.as ?? chosen.request ?? 'launch';
    if (request === 'attach' && (options.flash || options.halt)) {
        throw new Error(
            'probe-rs rejects the flashing and reset options for an attach session; use --as launch',
        );
    }

    // The chip, the binary and the RTT setup are the chosen entry's, so this exercises the real thing.
    const session = {
        type: chosen.type ?? 'probe-rs-debug',
        request,
        name: chosen.name,
        cwd: project,
        chip: chosen.chip,
        coreConfigs: chosen.coreConfigs,
        ...(request === 'launch'
            ? { flashingConfig: { flashingEnabled: options.flash, haltAfterReset: options.halt } }
            : {}),
    };

    console.log(`project : ${project}`);
    console.log(`config  : ${chosen.name}`);
    console.log(`request : ${session.request}`);
    if (session.flashingConfig !== undefined) {
        console.log(
            `flashing: ${session.flashingConfig.flashingEnabled ? 'YES - this writes the chip' : 'no'}` +
            `, halt at reset: ${session.flashingConfig.haltAfterReset === true ? 'yes' : 'no'}`,
        );
    } else {
        console.log('flashing: no (an attach session never writes or resets the chip)');
    }
    if (options.lines.length > 0) {
        const file = options.file ?? path.join(project, 'src', 'main.rs');
        console.log(`breakpoints: ${file}:${options.lines.join(', ')} (${options.lines.length})`);
    }

    const probeRs = findExecutable('probe-rs');
    if (probeRs === undefined) {
        throw new Error('probe-rs was not found (looked in ~/.cargo/bin and PATH)');
    }

    const adapter = startAdapter(probeRs, options.port, project);
    const client = new DapClient(options.port, options.verbose);
    client.listen();
    try {
        await client.connect();

        await client.send('initialize', {
            adapterID: 'probe-rs-debug',
            clientID: 'vscode',
            linesStartAt1: true,
            columnsStartAt1: true,
            pathFormat: 'path',
            supportsRunInTerminalRequest: true,
            supportsProgressReporting: true,
            supportsVariableType: true,
            supportsMemoryReferences: true,
        });

        const start = await client.send(session.request, session);
        if (start.success !== true) {
            console.error(`\nsession failed to start: ${start.message ?? JSON.stringify(start.body ?? {})}`);
            return EXIT_CANNOT_RUN;
        }

        let programmed = 0;
        if (options.lines.length > 0) {
            // The whole point of the tool: set them *before* configurationDone, as an IDE does.
            const response = await client.send('setBreakpoints', {
                source: { name: path.basename(options.file ?? 'main.rs'), path: options.file ?? path.join(project, 'src', 'main.rs') },
                breakpoints: options.lines.map((line) => ({ line })),
                lines: options.lines,
            });
            const breakpoints = response.body?.breakpoints ?? [];
            console.log('');
            for (const [index, breakpoint] of breakpoints.entries()) {
                const accepted = breakpoint.verified === true;
                if (accepted) {
                    programmed++;
                }
                console.log(
                    `  ${accepted ? 'programmed ' : 'NOT SET    '} line ${breakpoint.line ?? options.lines[index]}` +
                    `${breakpoint.instructionReference ? ` at ${breakpoint.instructionReference}` : ''}` +
                    `${accepted ? '' : ` - ${breakpoint.message ?? 'no reason given'}`}`,
                );
            }
            console.log(`${programmed} of ${options.lines.length} breakpoints programmed`);
        }

        await client.send('configurationDone', {});
        console.log(`\nwaiting up to ${options.wait} ms for a stop...`);
        let stopped = await client.waitForStop(options.wait);

        if (stopped === undefined && options.pause) {
            console.log('nothing stopped; halting the core and continuing once, to see if that changes it');
            await client.send('pause', {});
            await new Promise((resolve) => setTimeout(resolve, 500));
            await client.send('continue', { threadId: 0 });
            stopped = await client.waitForStop(options.wait);
        }

        for (const line of client.rtt) {
            console.log(`[rtt] ${line.trimEnd()}`);
        }
        for (const line of client.console) {
            console.log(`[console] ${line}`);
        }

        let code;
        if (options.lines.length === 0) {
            console.log('\nVERDICT: the session started.');
            code = EXIT_STOPPED;
        } else if (stopped !== undefined && stopped.reason === 'breakpoint') {
            console.log(
                `\nVERDICT: a breakpoint fired - ${stopped.description ?? 'stopped'} ` +
                `(${programmed} of ${options.lines.length} could be programmed)`,
            );
            code = EXIT_STOPPED;
        } else if (stopped !== undefined) {
            console.log(`\nVERDICT: the core stopped, but not at a breakpoint: ${JSON.stringify(stopped)}`);
            code = EXIT_NO_STOP;
        } else if (programmed > 0) {
            console.log(
                `\nVERDICT: ${programmed} of ${options.lines.length} breakpoints were programmed but none ` +
                'fired. That is what an attach session does with a line that has already run - use a ' +
                'configuration that resets the target (`Restart & Debug, no flashing`) or pick lines that ' +
                'run again.',
            );
            code = EXIT_NO_STOP;
        } else {
            console.log('\nVERDICT: no breakpoint could be programmed at all.');
            code = EXIT_NO_STOP;
        }

        await client.send('disconnect', { terminateDebuggee: false });
        console.log(`events: ${client.events.join(', ')}`);
        return code;
    } finally {
        adapter.kill();
        client.socket.destroy();
    }
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(`\ncould not run the session: ${error.message}`);
        process.exit(EXIT_CANNOT_RUN);
    });
