'use strict';

/**
 * Flashing an ESP over USB serial.
 *
 * Two things are worth pinning here. The route: an ESP has no SWD, so no probe diagnosis may
 * change where a flash goes. And the port: this bench has a board on `/dev/ttyACM0` that must
 * never be written to, so the port picker has to refuse it even when it is the only thing
 * plugged in.
 */

const { test, ok, equal, notOk, contains, notContains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const {
    espFlashArgs,
    espMonitorArgs,
    espFlashCommand,
    espMonitorCommand,
    clockHandoverLine,
    espFlashAndMonitorCommand,
    isEspProgrammerName,
    serialPortCandidates,
    pickSerialPort,
    parseWindowsSerialPorts,
    windowsSerialPortsQuery,
    serialPortEntriesForPlatform,
    WINDOWS_SERIAL_PORT_SCRIPT,
} = compiled('flash/espFlash');
const { flashRouteForProject, usesSerialFlash } = compiled('flash/route');
const { boardById } = compiled('boards/catalog');

test('the flash arguments name the chip and come before the image', () => {
    equal(espFlashArgs('esp32', 'app'), ['flash', '--chip', 'esp32', 'app']);
    equal(espFlashArgs('esp32s3', 'app'), ['flash', '--chip', 'esp32s3', 'app']);
    equal(
        espFlashArgs('esp32', 'app', '/dev/ttyUSB0'),
        ['flash', '--chip', 'esp32', '--port', '/dev/ttyUSB0', 'app'],
    );
    equal(espFlashArgs('esp32', 'app', ''), ['flash', '--chip', 'esp32', 'app'], 'an empty port is no port');
});

test('the monitor arguments are a monitor, not a flash', () => {
    equal(espMonitorArgs('esp32'), ['monitor', '--chip', 'esp32']);
    equal(espMonitorArgs('esp32', '/dev/ttyUSB0'), ['monitor', '--chip', 'esp32', '--port', '/dev/ttyUSB0']);
    notOk(espMonitorArgs('esp32').includes('flash'), 'monitoring must never write the chip');
});

test('the commands are shell-ready and quote the path', () => {
    // `quotePath` always quotes, which is what the probe route does too: one rule, no special cases.
    equal(espFlashCommand('espflash', 'esp32', 'app'), 'espflash flash --chip esp32 "app"');
    contains(espFlashCommand('espflash', 'esp32', '/tmp/a b/app'), '"/tmp/a b/app"');
    equal(espMonitorCommand('espflash', 'esp32'), 'espflash monitor --chip esp32');
});

test('flash-and-monitor is one terminal line, monitor last', () => {
    const line = espFlashAndMonitorCommand('espflash', 'esp32', 'app', '/dev/ttyUSB0');
    equal(
        line,
        'espflash flash --chip esp32 --port /dev/ttyUSB0 "app" && espflash monitor --chip esp32 --port /dev/ttyUSB0',
    );
    ok(line.indexOf(' monitor ') > line.indexOf(' flash '), 'the log may only start after the write');
});

test('the port picker never chooses a Raspberry Pi board', () => {
    // The bench Pico publishes a name here too, and it must never be flashed.
    notOk(isEspProgrammerName('usb-Raspberry_Pi_Pico_E663589863663823-if00'));
    notOk(isEspProgrammerName('usb-Raspberry_Pi_Pico_2-if00'));

    ok(isEspProgrammerName('usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0'));
    ok(isEspProgrammerName('usb-1a86_USB_Serial-if00-port0'), 'the CYD uses a CH340');
    ok(isEspProgrammerName('usb-Espressif_USB_JTAG_serial_debug_unit_00:00:00:00:00:00-if00'));
    ok(isEspProgrammerName('usb-FTDI_FT232R_USB_UART_A50285BI-if00-port0'));
    notOk(isEspProgrammerName('ttyUSB0'), 'a bare device name says nothing about the board');
});

test('the candidates are the ESP programmers, without repeats', () => {
    const entries = [
        { name: 'usb-Raspberry_Pi_Pico_E663589863663823-if00', target: '/dev/ttyACM0' },
        { name: 'usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0', target: '/dev/ttyUSB0' },
        { name: 'usb-1a86_USB_Serial-if00-port0', target: '/dev/ttyUSB1' },
        { name: 'usb-1a86_USB_Serial-if00-port1', target: '/dev/ttyUSB1' },
    ];
    equal(serialPortCandidates(entries), ['/dev/ttyUSB0', '/dev/ttyUSB1']);
});

test('a configured port always wins, and an ambiguous set is left to espflash', () => {
    equal(pickSerialPort(['/dev/ttyUSB0', '/dev/ttyUSB1'], ''), undefined, 'two boards: espflash asks');
    equal(pickSerialPort([], ''), undefined, 'nothing found: espflash detects');
    equal(pickSerialPort(['/dev/ttyUSB0'], ''), '/dev/ttyUSB0', 'one candidate is unambiguous');
    equal(
        pickSerialPort(['/dev/ttyUSB0', '/dev/ttyUSB1'], '/dev/ttyUSB1'),
        '/dev/ttyUSB1',
        'the setting overrides what was found',
    );
    equal(pickSerialPort([], '/dev/ttyUSB5'), '/dev/ttyUSB5', 'even with nothing plugged in');
});

test('the board decides the route before any probe is considered', () => {
    const esp = boardById('sunton-3248s035r');
    const rp = boardById('pico');

    // A perfectly working probe must not divert an ESP project: it has no SWD at all.
    equal(flashRouteForProject(esp, 'ok'), 'usb-serial');
    equal(flashRouteForProject(esp, 'none-connected'), 'usb-serial');

    // The cheap predicate the commands use to skip the probe scan entirely.
    equal(usesSerialFlash(esp), true);
    equal(usesSerialFlash(boardById('lilygo-tqt')), true);
    equal(usesSerialFlash(rp), false);
    equal(usesSerialFlash(undefined), false, 'an unknown project keeps the probe path');

    equal(flashRouteForProject(rp, 'ok'), 'probe');
    equal(flashRouteForProject(rp, 'none-connected'), 'usb');
    equal(flashRouteForProject(undefined, 'ok'), 'probe', 'an unknown project keeps the old behaviour');
});

// ------------------------------------------------------------------------- Windows
//
// Windows has no `/dev/serial/by-id`, so the port comes from the device manager instead. What must
// survive that rewrite is the *identity* of the port: the vendor id is what keeps this extension
// off a Raspberry Pi Pico, and on Windows it lives in the PNP device id rather than in a file name.

/** `Get-CimInstance Win32_PnPEntity | Select Name, PNPDeviceID | ConvertTo-Json -Compress`, one match. */
const ONE_CH340 = JSON.stringify({
    Name: 'USB-SERIAL CH340 (COM5)',
    PNPDeviceID: 'USB\\VID_1A86&PID_7523\\5&2B5D2B&0&1',
});

/** Several matches: `ConvertTo-Json` emits an array once there is more than one. */
const SEVERAL_PORTS = JSON.stringify([
    { Name: 'USB Serial Device (COM7)', PNPDeviceID: 'USB\\VID_2E8A&PID_000A\\E663589863663823' },
    { Name: 'USB-SERIAL CH340 (COM5)', PNPDeviceID: 'USB\\VID_1A86&PID_7523\\5&2B5D2B&0&1' },
    { Name: 'Silicon Labs CP210x USB to UART Bridge (COM9)', PNPDeviceID: 'USB\\VID_10C4&PID_EA60\\0001' },
    { Name: 'USB Serial Device (com11)', PNPDeviceID: 'USB\\VID_303A&PID_1001\\30:30:F9:00:00:01' },
]);

test('a Windows COM port is read from the device manager JSON', () => {
    const entries = parseWindowsSerialPorts(ONE_CH340);
    equal(entries.length, 1);
    equal(entries[0].target, 'COM5', 'the port is what espflash takes');
    contains(entries[0].name, 'CH340', 'the friendly name is kept for the log');
    contains(entries[0].name, '1A86', 'the vendor id is what identifies the device');
});

test('a Raspberry Pi Pico is not a candidate on Windows either', () => {
    // The bench rule, carried across: 2e8a is the Pico family, so its COM port is never offered.
    const entries = parseWindowsSerialPorts(SEVERAL_PORTS);
    equal(entries.length, 4, 'every COM port is read');
    const candidates = serialPortCandidates(entries);
    notOk(candidates.includes('COM7'), 'the Pico (VID_2E8A) must not be a candidate');
    equal(candidates.join(','), 'COM11,COM5,COM9', 'the ESP programmers are, sorted, upper-cased');
});

test('the query asks for every COM port, not just the serial-driver ones', () => {
    const query = windowsSerialPortsQuery();
    equal(query.file, 'powershell');
    ok(query.args.includes('-NoProfile'), 'a user profile must not be able to change the answer');
    ok(query.args.includes('-Command'));
    contains(WINDOWS_SERIAL_PORT_SCRIPT, 'Win32_PnPEntity', 'Win32_SerialPort misses a loading driver');
    contains(WINDOWS_SERIAL_PORT_SCRIPT, 'ConvertTo-Json');
    contains(WINDOWS_SERIAL_PORT_SCRIPT, 'PNPDeviceID', 'the vendor id has to come back');
});

test('malformed device-manager output is "no ports", never a crash', () => {
    equal(parseWindowsSerialPorts('').length, 0, 'an empty result');
    equal(parseWindowsSerialPorts('not json').length, 0, 'a PowerShell error message');
    equal(parseWindowsSerialPorts('null').length, 0);
    equal(parseWindowsSerialPorts(JSON.stringify({ Name: 'No port here' })).length, 0, 'no (COMx)');
});

test('the platform decides where ports are enumerated', () => {
    const asked = [];
    const runner = (file, args) => {
        asked.push(file);
        return ONE_CH340;
    };
    const windows = serialPortEntriesForPlatform('win32', runner);
    equal(asked.length, 1, 'Windows must run the PowerShell query');
    equal(windows[0].target, 'COM5');

    asked.length = 0;
    const linux = serialPortEntriesForPlatform('linux', runner);
    equal(asked.length, 0, 'Linux must read /dev/serial/by-id, not spawn PowerShell');
    ok(Array.isArray(linux), 'Linux still returns a list (empty here, no such directory)');

    equal(serialPortEntriesForPlatform('win32', () => undefined).length, 0, 'a query that cannot run');
});

test('flashing and monitoring chain in a way the shell accepts', () => {
    const posix = espFlashAndMonitorCommand('espflash', 'esp32', 'app', 'COM5', 'linux');
    contains(posix, ' && ', 'POSIX shells take &&');
    contains(posix, 'monitor --chip esp32 --port COM5');

    const windows = espFlashAndMonitorCommand('espflash', 'esp32', 'app', 'COM5', 'win32');
    notContains(windows, '&&', 'Windows PowerShell 5.1 rejects && outright');
    contains(windows, '; if ($LASTEXITCODE -eq 0) { espflash monitor', 'the monitor runs only after a good flash');
    contains(windows, '}', 'and the block is closed');
});

test('the PC clock is handed over the console once the write finishes', () => {
    // An ESP32's internal RTC has no battery: the extension sends `TIME HH:MM:SS` (local, no zone)
    // after espflash exits, and the firmware's console reader takes the design's clock from it. The
    // write belongs *between* the flash and the monitor, because the monitor holds the port.
    equal(clockHandoverLine(new Date(2026, 9, 17, 14, 5, 9)), 'TIME 14:05:09');
    equal(clockHandoverLine(new Date(2026, 9, 17, 0, 0, 0)), 'TIME 00:00:00');

    const handover = { port: '/dev/ttyUSB0', line: 'TIME 14:05:09' };
    const flash = espFlashCommand('espflash', 'esp32', 'app', '/dev/ttyUSB0', handover, 'linux');
    contains(flash, 'TIME 14:05:09', 'the line is written');
    contains(flash, '> /dev/ttyUSB0', 'to the board\'s port');
    ok(flash.indexOf('espflash flash') < flash.indexOf('TIME 14:05:09'), 'after the write');

    // Flash and monitor: the hand-over sits between them, and the monitor is last.
    const both = espFlashAndMonitorCommand('espflash', 'esp32', 'app', '/dev/ttyUSB0', 'linux', handover);
    ok(both.indexOf('TIME 14:05:09') < both.indexOf('espflash monitor'), 'before the monitor takes the port');

    // Windows has no `&&` in PowerShell 5.1: the same intent, written the way it accepts.
    const windows = espFlashAndMonitorCommand('espflash', 'esp32', 'app', 'COM5', 'win32', handover);
    contains(windows, 'System.IO.Ports.SerialPort', 'PowerShell opens the port');
    ok(windows.indexOf('TIME 14:05:09') < windows.indexOf('espflash monitor'));

    // Without a port there is nothing to write to, and the commands are exactly what they were.
    equal(
        espFlashCommand('espflash', 'esp32', 'app', undefined, undefined),
        'espflash flash --chip esp32 "app"',
        'no hand-over, no change',
    );
});
