'use strict';

/**
 * The command a probe flash runs.
 *
 * This exists because of a real bug: Flash used to be `cargo run`, whose runner is `probe-rs run`.
 * That flashes and then *stays attached* to stream defmt over RTT, so the probe was still claimed
 * afterwards and the next debug session failed with "The selected USB device could not be opened" -
 * which reads as a hardware fault rather than as "the last command never let go".
 *
 * So the shape of the command is pinned here: it must write the image and exit.
 */

const { test, ok, equal, contains, notContains } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const { probeFlashCommand, quotePath } = compiled('flash/probeFlash');

const ELF = '/home/somebody/My Projects/blinky/target/thumbv8m.main-none-eabihf/release/blinky';

test('a flash writes the image and lets go of the probe', () => {
    const command = probeFlashCommand('probe-rs', 'RP235x', ELF);
    contains(command, 'download', 'the image has to be written');
    contains(command, 'reset', 'and the new firmware has to start running');
    equal(command.match(/--chip RP235x/g).length, 2, 'both steps need the explicit chip id');

    // The two subcommands that hold the probe open, and the reason this file exists.
    notContains(command, ' run ', '`probe-rs run` attaches and streams RTT');
    notContains(command, ' attach ', '`probe-rs attach` would hold the probe too');
    ok(!command.includes('cargo run'), 'the runner from .cargo/config.toml is `probe-rs run`');
});

test('the path is quoted, because project names contain spaces', () => {
    const command = probeFlashCommand('probe-rs', 'RP2040', ELF);
    contains(command, `"${ELF}"`);
    equal(quotePath('a"b'), '"a\\"b"', 'a quote inside a path cannot break out');
});
