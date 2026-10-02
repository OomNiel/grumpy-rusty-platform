'use strict';

/**
 * Guards the HIL capture helper.
 *
 * On real hardware `t5-hil` reported "captured RTT output: ''" while the firmware was
 * blinking happily: a fixed 5 s window killed `probe-rs run` while it was still
 * programming the image (~10 s), so the test looked like a silent target. These cases
 * pin the behaviour that replaced it — stop when the evidence arrives, never on a guess.
 */

const { EventEmitter } = require('events');
const { test, ok, equal, notOk, contains } = require('../../lib/harness');
const { captureUntil } = require('../../lib/rtt');

/** A stand-in for a spawned process: feed it data by hand and observe the kill. */
function fakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => {
        child.signalCode = signal;
        child.exitCode = 0;
        return true;
    };
    return child;
}

/** Emit `chunks` on `stream` after `delayMs`. */
function emit(stream, chunks, delayMs = 0) {
    return new Promise((resolve) => {
        setTimeout(() => {
            for (const chunk of chunks) {
                stream.emit('data', Buffer.from(chunk));
            }
            resolve();
        }, delayMs);
    });
}

test('capture stops as soon as the expected line arrives', async () => {
    const child = fakeChild();
    const pending = captureUntil(child, { fragment: 'CYW43 is up', timeoutMs: 5000 });

    // A chatty prelude, then the line split across two chunks — buffering must cope.
    await emit(child.stdout, ['[DEBUG] loading fw\n', '[INFO ] CYW43 ', 'is up\n']);
    const { output, matched } = await pending;

    ok(matched, 'expected the fragment to end the capture');
    contains(output, '[DEBUG] loading fw');
    contains(output, 'CYW43 is up');
    equal(child.signalCode, 'SIGKILL', 'the child should be stopped once the line is seen');
});

test('capture returns evidence well before the timeout expires', async () => {
    const child = fakeChild();
    const started = Date.now();
    const pending = captureUntil(child, { fragment: 'Wi-Fi is up', timeoutMs: 30000 });

    await emit(child.stdout, ['[INFO ] Wi-Fi is up\n'], 15);
    const { matched } = await pending;

    ok(matched);
    notOk(Date.now() - started > 1000, 'a matching line must not wait for the timeout');
});

test('capture matches a fragment that arrives on stderr', async () => {
    const child = fakeChild();
    const pending = captureUntil(child, { fragment: 'Hello from', timeoutMs: 5000 });

    await emit(child.stderr, ['Hello from RP2040\n']);
    const { output, matched } = await pending;

    ok(matched);
    contains(output, 'Hello from RP2040');
});

test('capture keeps what it collected when the process exits on its own', async () => {
    const child = fakeChild();
    const pending = captureUntil(child, { fragment: 'never printed', timeoutMs: 5000 });

    await emit(child.stdout, ['[ERROR] init failed\n']);
    child.exitCode = 1;
    child.emit('close');

    const { output, matched } = await pending;
    notOk(matched, 'the fragment never appeared, so this must not report a match');
    contains(output, '[ERROR] init failed');
    equal(child.signalCode, null, 'an already-exited child must not be killed');
});

test('capture gives up at the timeout and says so', async () => {
    const child = fakeChild();
    const pending = captureUntil(child, { fragment: 'CYW43 is up', timeoutMs: 20 });

    await emit(child.stdout, ['[DEBUG] still flashing\n']);

    const { output, matched } = await pending;
    notOk(matched, 'a timeout is not a match');
    contains(output, 'still flashing', 'whatever was captured is still reported, for diagnosis');
    equal(child.signalCode, 'SIGKILL', 'the stalled child is stopped');
});

test('capture reports a spawn failure instead of hanging', async () => {
    const child = fakeChild();
    const pending = captureUntil(child, { fragment: 'CYW43 is up', timeoutMs: 5000 });

    child.emit('error', new Error('spawn probe-rs ENOENT'));

    const { output, matched } = await pending;
    equal(output, '', 'nothing was captured');
    notOk(matched);
});
