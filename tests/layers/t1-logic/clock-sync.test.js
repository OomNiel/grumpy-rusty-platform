'use strict';

/**
 * The clock's "Update Time" button, both halves of it.
 *
 * The button exists because an ESP32's RTC has no battery: the board is told the PC's time over the
 * console, once after a flash, and after that it counts on its own. Drifting, or a board that has been
 * running since yesterday, means the same line again without the rebuild -- and that needs the rules
 * to be right about the two cases that are not a happy path: a design with no clock, and no board on a
 * port.
 *
 * Everything asserted here is decided in `flash/clockSync.ts`, which cannot open a port by itself; the
 * runner is injected, so the tests can watch the exact shell line that would have been written.
 */

const { test, ok, equal, notOk, contains, notContains, compiled } = require('../../lib/harness');
const { clockUpdatePlan, updateClock, runShellCommand } = compiled('flash/clockSync');
const { widgetSpec } = compiled('designer/catalog');

/** A fixed moment, so the line is a constant and the test is not racing the wall clock. */
const AT = new Date(2026, 9, 17, 9, 5, 7);

test('a design with no clock widget is refused before anything is run', () => {
    let ran = false;
    const result = updateClock({
        hasClock: false,
        port: '/dev/ttyUSB0',
        now: AT,
        run: () => {
            ran = true;
            return { ok: true };
        },
    });
    notOk(result.ok, 'nothing to set, so nothing claims to have happened');
    contains(result.message, 'no clock widget', 'and it says why');
    notOk(ran, 'the port is not touched');
});

test('no port is refused, and the message names the setting that fixes it', () => {
    for (const port of [undefined, '', '   ']) {
        const plan = clockUpdatePlan({ hasClock: true, port, now: AT });
        equal(plan.kind, 'refuse', `port ${JSON.stringify(port)} has nowhere to go`);
        contains(plan.message, 'serialPort', 'and the message names the setting');
    }
    const result = updateClock({ hasClock: true, port: undefined, now: AT, run: () => ({ ok: true }) });
    notOk(result.ok, 'a refusal is not a success');
});

test('the line is the same TIME line a flash sends, on the port that was found', () => {
    const plan = clockUpdatePlan({ hasClock: true, port: '/dev/ttyUSB0', now: AT, platform: 'linux' });
    equal(plan.kind, 'write');
    equal(plan.line, 'TIME 09:05:07', 'the firmware parses exactly this');
    contains(plan.command, '/dev/ttyUSB0', 'the port is in the command');
    contains(plan.command, "printf '%s\\n' 'TIME 09:05:07'", 'and so is the line');
    contains(plan.command, 'stty', 'the port is put into raw mode first');
});

test('Windows writes the same line through the serial-port class', () => {
    const plan = clockUpdatePlan({ hasClock: true, port: 'COM4', now: AT, platform: 'win32' });
    equal(plan.kind, 'write');
    contains(plan.command, '[System.IO.Ports.SerialPort]::new(\'COM4\', 115200)');
    contains(plan.command, 'TIME 09:05:07');
    notContains(plan.command, 'stty', 'no stty on Windows');
});

test('a write that works says what was set and where', () => {
    const commands = [];
    const result = updateClock({
        hasClock: true,
        port: '/dev/ttyUSB0',
        now: AT,
        run: (command) => {
            commands.push(command);
            return { ok: true };
        },
    });
    ok(result.ok, 'the write is reported as done');
    equal(result.message, 'Clock set to 09:05:07 on /dev/ttyUSB0.');
    equal(commands.length, 1, 'one line, one shell command');
});

test('a port that will not take the line is a message, not an exception', () => {
    // The real one, on this bench: a Monitor terminal holds the port for as long as it runs.
    const result = updateClock({
        hasClock: true,
        port: '/dev/ttyUSB0',
        now: AT,
        run: () => ({ ok: false, error: 'stty: /dev/ttyUSB0: Device or resource busy' }),
    });
    notOk(result.ok, 'the failure is reported as one');
    contains(result.message, '/dev/ttyUSB0', 'with the port in it');
    contains(result.message, 'Device or resource busy', 'and the shell\'s own words');
    contains(result.message, 'Monitor', 'and the thing that usually causes it');
});

test('a failure with no stderr still reads as a sentence', () => {
    const result = updateClock({ hasClock: true, port: 'COM4', now: AT, run: () => ({ ok: false }) });
    notOk(result.ok);
    contains(result.message, 'did not accept it');
    contains(result.message, 'Monitor');
});

test('the shell runner hands back an error instead of throwing', () => {
    // A command that cannot work, run for real: the exit code is the answer, not an exception. Nothing
    // is written to a device here -- `false` is the shell's own builtin.
    const failed = runShellCommand('false', 'linux');
    notOk(failed.ok, 'a failing command is a failure');
    const worked = runShellCommand('true', 'linux');
    ok(worked.ok, 'and a succeeding one is a success');
});

test('the clock is the only widget that offers the buttons', () => {
    const clock = widgetSpec('clock');
    ok(clock !== undefined, 'the clock is in the catalogue');
    equal(clock.actions?.length, 2, 'two actions: one push, one listener');
    equal(clock.actions[0].id, 'updateClockTime', 'which the extension knows how to do');
    equal(clock.actions[0].label, 'Update Time', 'under the label that was asked for');
    ok(
        (clock.actions[0].help ?? '').includes('Monitor'),
        'and a tooltip that says the port has to be free',
    );
    equal(clock.actions[1].id, 'serveClockTime', 'the listener a board can ask, rather than a push');
    equal(clock.actions[1].label, 'Answer Time Requests', 'under its own label');
    ok(
        (clock.actions[1].help ?? '').includes('Monitor'),
        'and the same caveat: Monitor holds the port',
    );
    // Not a general facility: nothing else in the catalogue has a button.
    const others = compiled('designer/catalog')
        .KDL_WIDGETS.filter((widget) => widget.tag !== 'clock')
        .filter((widget) => (widget.actions?.length ?? 0) > 0)
        .map((widget) => widget.tag);
    equal(others, [], 'no other widget offers one yet');
});
