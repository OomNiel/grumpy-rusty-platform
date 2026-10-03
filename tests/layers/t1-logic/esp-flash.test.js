'use strict';

/**
 * Flashing an ESP over USB serial.
 *
 * Two things are worth pinning here. The route: an ESP has no SWD, so no probe diagnosis may
 * change where a flash goes. And the port: this bench has a board on `/dev/ttyACM0` that must
 * never be written to, so the port picker has to refuse it even when it is the only thing
 * plugged in.
 */

const { test, ok, equal, notOk, contains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const {
    espFlashArgs,
    espMonitorArgs,
    espFlashCommand,
    espMonitorCommand,
    espFlashAndMonitorCommand,
    isEspProgrammerName,
    serialPortCandidates,
    pickSerialPort,
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
