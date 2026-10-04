'use strict';

/**
 * Publishing a firmware project as a `.deb` (asked 2026-10-05).
 *
 * Every string that ends up inside the package is a pure function of its arguments, so it is pinned here rather
 * than by building a package and reading it back: `dpkg-deb` refuses a malformed control file with a message
 * about a line number, which is a slow way to find a missing field. The one thing a test cannot check is what
 * dpkg *does* with the result — that part is verified against the real dpkg (`NOTES.md` §44).
 */

const { test, ok, equal, contains, notOk } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');

const deb = compiled('deb/package');

test('the package name and file name follow Debian rules', () => {
    // A crate name is not a package name: `my_blinky_pico2w` has underscores, which dpkg rejects.
    equal(deb.debianPackageName('my_blinky_pico2w'), 'my-blinky-pico2w');
    equal(deb.debianPackageName('My Project'), 'my-project');
    equal(deb.debianPackageName('  weird!!name  '), 'weirdname');
    equal(deb.debianPackageName(''), 'firmware', 'never an empty name');
    // `name_version_arch.deb` is the shape every dpkg tool expects.
    equal(deb.debFileName('my_blinky_pico2w', '0.1.0', 'amd64'), 'my-blinky-pico2w_0.1.0_amd64.deb');
    // A version or architecture that would break the file name is sanitised, not passed through.
    equal(deb.debFileName('x', '1.0/../evil', 'amd64'), 'x_1.0..evil_amd64.deb');
    equal(deb.debFileName('x', '', ''), 'x_0.0.0_all.deb');
});

test('the control file has every field dpkg insists on', () => {
    const text = deb.controlFileText({
        crateName: 'my_blinky_pico2w',
        version: '0.1.0',
        architecture: 'amd64',
        maintainer: 'Niel <niel@example.com>',
        description: 'Firmware for Pico 2 W',
        board: 'Raspberry Pi Pico 2 W',
        packageSizeBytes: 4096
    });
    contains(text, 'Package: my-blinky-pico2w\n');
    contains(text, 'Version: 0.1.0\n');
    // The HOST's architecture, never the board's: an `arm64` line because the microcontroller is ARM would make
    // dpkg refuse to install on the x86-64 laptop the package was built for.
    contains(text, 'Architecture: amd64\n');
    contains(text, 'Maintainer: Niel <niel@example.com>\n');
    contains(text, 'Installed-Size: 4\n');
    contains(text, 'Description: Firmware for Pico 2 W\n');
    // The long description: continuation lines are indented, and a blank one is a single space — that is what
    // dpkg's parser expects, and getting it wrong is "line 6: field name ..." at build time.
    const lines = text.trimEnd().split('\n');
    const desc = lines.indexOf('Description: Firmware for Pico 2 W');
    ok(desc > 0, 'the description is there');
    for (const line of lines.slice(desc + 1)) {
        ok(line.startsWith(' '), `continuation line is indented: ${JSON.stringify(line)}`);
    }
    contains(text, 'Raspberry Pi Pico 2 W');
    notOk(text.includes('\n\n'), 'no empty lines, which dpkg reads as the end of the paragraph');
});

test('a missing maintainer or description still makes a valid control file', () => {
    const text = deb.controlFileText({ crateName: 'x', version: '', architecture: '', maintainer: '   ', description: '' });
    contains(text, 'Maintainer: unknown <unknown@localhost>');
    contains(text, 'Version: 0.0.0');
    contains(text, 'Architecture: all');
    // A description is mandatory, so an empty one becomes the package's own name rather than nothing.
    contains(text, 'Description: x firmware');
});

test('the flash helper is a script that checks its tools before doing anything', () => {
    const script = deb.flashWrapperScript('my_blinky_pico2w', 'my-blinky-pico2w.elf');
    ok(script.startsWith('#!/bin/sh\n'), 'it is a shell script');
    contains(script, 'DIR=/usr/share/my-blinky-pico2w');
    contains(script, 'ARTIFACT="$DIR/my-blinky-pico2w.elf"');
    contains(script, 'set -eu', 'it stops on the first error rather than flashing half a board');
    contains(script, 'command -v probe-rs');
    contains(script, 'exec probe-rs run "$@" "$ARTIFACT"', 'extra arguments reach probe-rs');
    notOk(/sudo/.test(script), 'flashing does not require root, and asking for it would be a surprise in /usr/bin');
});

test('the two controls are declared, and Linux-only is said rather than assumed', () => {
    const controls = require('../../../out/ui/controls');
    // In the Controls *section* (which is what was asked for) — not in `CONTROLS`, which also lays out the
    // status bar and has to stay short.
    const commands = controls.visibleControls(false).map((c) => c.command);
    ok(commands.includes('rustyPlatform.publishDeb'), 'the publish control is in the section');
    ok(commands.includes('rustyPlatform.installDeb'), 'the install control is in the section');
    notOk(controls.CONTROLS.some((c) => c.command === 'rustyPlatform.publishDeb'),
        'and the status bar is left as it was');
    for (const control of controls.PACKAGE_CONTROLS) {
        ok(control.label && control.detail && control.tooltip, `${control.command} is fully described`);
        ok(control.icon, `${control.command} has an icon`);
    }
    equal(deb.debUnsupportedReason('linux'), undefined);
    contains(deb.debUnsupportedReason('win32'), 'Linux-only');
    contains(deb.debUnsupportedReason('darwin'), 'Linux-only');
});
