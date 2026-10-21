'use strict';

/**
 * The host half of the clock hand-over: a listener that answers the board's `TIME?`.
 *
 * The firmware asks once a second while its RTC has never been set. That request only becomes a time
 * if something on the other end of the cable answers, and this is the extension's answer: a shell line
 * that keeps one handle on the port open and writes `TIME HH:MM:SS` whenever it hears the request.
 *
 * It answers every request, not one, because a board's RTC loses the time with the power: a cold boot
 * makes it ask again, and a listener that had exited would leave the clock frozen with the PC sitting
 * right there. The port is released when the terminal closes -- the designer panel's dispose, a flash
 * or Monitor -- which is the only moment somebody else wants it.
 *
 * What a test can pin down without a board is the policy and the exact command -- the same trade-off
 * `clockSync.test.js` makes for the single push. The parts that matter are the ones a wrong shape would
 * break silently: the port opened once (a second open would reset the board), the hello that the CYD
 * needs before it can know a host exists, no early exit, and the refusal of a design with no clock.
 */

const { test, ok, equal, notOk, contains, notContains, compiled } = require('../../lib/harness');
const { clockHostPlan, clockHostCommand } = compiled('flash/clockHost');

test('a design with no clock is refused before a terminal is opened', () => {
    const plan = clockHostPlan({ hasClock: false, port: '/dev/ttyUSB0' });
    equal(plan.kind, 'refuse', 'nothing on the glass would follow an answer');
    contains(plan.message, 'no clock widget', 'and it says why');
});

test('no port is refused, and the message names the setting that fixes it', () => {
    for (const port of [undefined, '', '   ']) {
        const plan = clockHostPlan({ hasClock: true, port });
        equal(plan.kind, 'refuse', `port ${JSON.stringify(port)} has nowhere to listen`);
        contains(plan.message, 'serialPort', 'and the message names the setting');
    }
});

test('the listener holds one handle, says hello, and answers TIME? with the local time', () => {
    const plan = clockHostPlan({ hasClock: true, port: '/dev/ttyUSB0', platform: 'linux' });
    equal(plan.kind, 'serve');
    equal(plan.port, '/dev/ttyUSB0');

    contains(plan.command, 'stty', 'the port is put into raw mode first');
    contains(plan.command, 'raw -echo -hupcl', 'and closing it must not drop DTR and reset the board');
    contains(plan.command, 'exec 3<>"/dev/ttyUSB0"', 'one handle, opened once, for both directions');
    equal(
        plan.command.split('/dev/ttyUSB0').length - 1,
        3,
        'the port is named by stty, the exec and the read loop -- and never reopened per answer',
    );
    contains(plan.command, "for i in 1 2 3 4 5 6 7 8 9 10; do printf 'RUSTY?\\n' >&3; sleep 0.3; done", 'the hello is repeated while the board reboots from the port being opened');
    contains(plan.command, 'while IFS= read -r line <&3', 'then it listens for as long as the terminal is open');
    contains(plan.command, '*"TIME?"*', 'the request is matched literally, so a log line cannot trigger it');
    contains(plan.command, 'answer=$(date +%H:%M:%S)', 'the answer is this PC\'s local time');
    contains(plan.command, "printf 'TIME %s\\n' \"$answer\" >&3", 'written in the line the firmware parses');
    contains(plan.command, 'clock: time sent ($answer)', 'and said in the terminal, so the developer can see it');
    contains(plan.command, 'exec 3>&-', 'the handle is closed when the loop ends, releasing the port');

    // A cold boot must be answered too, so nothing may end the loop early.
    notContains(plan.command, 'break', 'the loop does not stop after one answer');
    notContains(plan.command, 'deadline', 'and there is no idle timeout to surprise a rebooted board');

    contains(plan.command, 'the port could not be opened (is Monitor holding it?)', 'a port someone else holds says so');

    // The board's parser is the contract, and both halves must agree on it.
    contains(plan.command, 'TIME %s', 'the answer is TIME HH:MM:SS, the same line a flash sends');
});

test('Windows keeps its port open and answers every request', () => {
    const command = clockHostCommand('COM4', 'win32');
    contains(command, "[System.IO.Ports.SerialPort]::new('COM4', 115200)");
    contains(command, '$p.Open()', 'opened once');
    contains(command, "for ($i = 0; $i -lt 10; $i++) { $p.WriteLine('RUSTY?'); Start-Sleep -Milliseconds 300 }", 'the same repeated hello');
    contains(command, 'while ($true)', 'it listens for the life of the terminal');
    contains(command, "Contains('TIME?')", 'the same request');
    contains(command, "Get-Date).ToString('HH:mm:ss')", 'and the same local-time answer');
    contains(command, 'clock: ', 'said in the terminal');
    notContains(command, 'break', 'no early exit after one answer');
    notContains(command, '`n', 'no PowerShell backtick escapes: this line travels through a JavaScript template');
});

test('the automatic start and the flash agree on the terminal that holds the port', () => {
    // The listener runs in a terminal named exactly this. The flash closes that terminal before it
    // opens the port, so the two names have to stay the same string -- a source-level check, because
    // the vscode imports in both files keep them out of any test that could run them.
    const fs = require('fs');
    const path = require('path');
    const { repoRoot } = require('../../lib/harness');
    const editor = fs.readFileSync(path.join(repoRoot(), 'src', 'designer', 'editor.ts'), 'utf8');
    const commands = fs.readFileSync(path.join(repoRoot(), 'src', 'commands', 'projectCommands.ts'), 'utf8');
    contains(editor, "runInTerminal('Rusty: clock'", 'the designer starts the listener under the name');
    contains(editor, 'autoServeClock()', 'automatically, once the panel is open');
    contains(editor, "closeTerminal('Rusty: clock')", 'and closing the panel releases the port');
    contains(commands, "closeTerminal('Rusty: clock')", 'while a flash and Monitor close that same terminal');
});
