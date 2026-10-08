'use strict';

/**
 * Touch as a project setting.
 *
 * It is the same mechanism as the rotation -- a key in `.cargo/esp-config.toml`, read at compile time -- for the
 * same reason: the choice belongs to the project and has to survive `src/main.rs` being written once. These
 * tests pin the reading, the writing, and the two judgements that are easy to get backwards: an *absent* key
 * means touch is on, and only an explicit "0" means off.
 */

const { test, ok, notOk, equal, contains, notContains, compiled } = require('../../lib/harness');
const {
    TOUCH_ENV,
    TOUCH_OFF_VALUE,
    TOUCH_ON_VALUE,
    touchLine,
    setTouchInConfig,
    configHasTouch,
    touchFromConfig,
    touchFirmwareLine,
    touchNeededBy,
} = compiled('display/touchSetting');

test('the setting round-trips through the config file', () => {
    for (const enabled of [true, false]) {
        const written = setTouchInConfig('', enabled);
        contains(written, touchLine(enabled), `the line for ${enabled}`);
        equal(touchFromConfig(written), enabled, 'and reads back');
        equal(configHasTouch(written, enabled), true, 'and is recognised as already set');
    }
});

test('an absent or unreadable value leaves touch on', () => {
    // Projects generated before this setting existed have a working touchscreen; a default of "off" would
    // silently take it away on their next build.
    equal(touchFromConfig(''), true, 'an empty file');
    equal(touchFromConfig('[env]\nOTHER = "1"\n'), true, 'a file that does not mention it');
    equal(touchFromConfig(`[env]\n${TOUCH_ENV} = "yes"\n`), true, 'a typo');
    equal(touchFromConfig(`[env]\n${TOUCH_ENV} = ""\n`), true, 'an empty value');
    equal(touchFromConfig(`[env]\n${TOUCH_ENV} = "${TOUCH_OFF_VALUE}"\n`), false, 'and only an explicit 0 is off');
});

test('writing the setting leaves the rest of the file alone', () => {
    const before = '# a comment of my own\n[env]\nESP_LOG = "info"\n\n[env.MYAPP]\nX = "1"\n';
    const after = setTouchInConfig(before, false);
    contains(after, '# a comment of my own', 'the comment survives');
    contains(after, 'ESP_LOG = "info"', 'and the other keys');
    contains(after, '[env.MYAPP]', 'and the subtables');
    contains(after, touchLine(false), 'with the setting added');

    // Replacing rather than accumulating, which is what a second change of mind does.
    const twice = setTouchInConfig(after, true);
    equal(twice.split(TOUCH_ENV).length - 1, 1, 'the key appears once');
    equal(touchFromConfig(twice), true, 'and carries the new value');
});

test('the firmware reads it as a compile-time constant', () => {
    // Both paths are generated and one is folded away, which is what lets the setting be flipped without
    // regenerating main.rs -- the same trick the rotation uses.
    const line = touchFirmwareLine();
    contains(line, 'option_env!("TOUCH_ENABLED")', 'the firmware reads the environment');
    contains(line, "b'0'", 'only an explicit 0 turns it off');
    contains(line, 'const TOUCH: bool', 'as a constant, so the dead branch is compiled out');
    contains(line, 'None => true', 'and an absent key leaves it on');
    // Matching a `&str` in a const is not stable Rust, so the comparison is a length and a byte. The first
    // version of this line used `matches!(value, "0")` and did not compile.
    notContains(line, 'matches!(option_env', 'no str matching in a const');
});

test('a design that needs touch is reported when the setting is off, and never blocked', () => {
    const widgets = [
        { id: 'title', events: [] },
        { id: 'go', events: ['clicked'] },
        { id: 'level', events: ['valueChanged'] },
    ];

    equal(touchNeededBy(widgets, true).length, 0, 'nothing to report when touch is on');

    const problems = touchNeededBy(widgets, false);
    equal(problems.length, 1, JSON.stringify(problems));
    contains(problems[0], 'go', 'the controls are named');
    contains(problems[0], 'level', 'all of them');
    contains(problems[0], 'still saves', 'and the wording says it is not a refusal');

    // One control reads as one, because "these controls cannot respond: go" is the sort of wording that makes a
    // panel look machine-written.
    contains(touchNeededBy([{ id: 'go', events: ['clicked'] }], false)[0], 'this control', 'singular');

    // A design of display-only widgets needs no touch at all, which is the point of making it optional.
    equal(touchNeededBy([{ id: 'title', events: [] }], false).length, 0, 'display-only needs nothing');
});
