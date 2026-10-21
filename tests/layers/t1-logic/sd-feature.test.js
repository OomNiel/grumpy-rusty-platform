'use strict';

/**
 * SD as a cargo feature.
 *
 * Where touch is a `.cargo/esp-config.toml` key, the SD card is a cargo `feature`: enabling it is what adds
 * the FAT filesystem (`embedded-sdmmc`) to the build, and only a feature can switch a dependency in or out.
 * These tests pin the one line it edits -- the `default = [...]` list inside `[features]` -- and the rule that
 * everything else in `Cargo.toml` is left exactly as it was.
 */

const { test, ok, notOk, equal, contains, notContains, compiled } = require('../../lib/harness');
const { isSdEnabled, setSdEnabled } = compiled('designer/sdFeature');
const { generateProjectFiles } = compiled('generate/files');
const { BOARDS } = compiled('boards/catalog');

function board(id) {
    const found = BOARDS.find((candidate) => candidate.id === id);
    ok(found, `unknown board ${id}`);
    return found;
}

/** The real generated `Cargo.toml` for a Designer project on a board. */
function designerCargoToml(boardId) {
    const files = generateProjectFiles({ board: board(boardId), projectName: 'demo', template: 'designer' });
    const file = files.find((candidate) => candidate.path === 'Cargo.toml');
    ok(file, 'the generator must produce a Cargo.toml');
    return file.content;
}

test('an SD-socket Designer project ships with sd on by default', () => {
    const cargo = designerCargoToml('sunton-3248s035r');
    ok(isSdEnabled(cargo), 'the sunton project starts with the sd feature enabled');
    contains(cargo, 'default = ["sd"]');
    contains(cargo, 'sd = ["dep:embedded-sdmmc", "dep:critical-section"]');
    contains(cargo, 'embedded-sdmmc = { version = "0.8.2", optional = true }');
    contains(cargo, 'critical-section = { version = "1.2.0", optional = true }');
});

test('a Designer project without an SD socket has no sd feature', () => {
    const cargo = designerCargoToml('lilygo-tqt');
    notOk(isSdEnabled(cargo), 'the lilygo project has no sd feature');
    notContains(cargo, 'dep:embedded-sdmmc');
});

test('the toggle removes and re-adds sd in default', () => {
    const cargo = designerCargoToml('sunton-3248s035r');

    const off = setSdEnabled(cargo, false);
    equal(off.note, 'removed', 'disabling is recorded');
    notOk(isSdEnabled(off.text), 'sd is off after disabling');
    contains(off.text, 'default = []', 'only sd was dropped from default');
    contains(off.text, 'sd = ["dep:embedded-sdmmc", "dep:critical-section"]', 'the feature line itself is left in place');
    // Nothing else is disturbed.
    contains(off.text, 'embedded-sdmmc = { version = "0.8.2", optional = true }');
    contains(off.text, 'embedded-gui = { version = "0.2.7"');

    const back = setSdEnabled(off.text, true);
    equal(back.note, 'added', 'enabling is recorded');
    ok(isSdEnabled(back.text), 'sd is on again after re-enabling');
    equal(back.text, cargo, 're-enabling restores the exact manifest');
});

test('the toggle leaves sibling default features alone', () => {
    // A board that has both a panel-revision switch and an SD card. The catalog only exposes one today, so
    // this hands the editor the mixed default the generator would produce for it -- and checks that toggling
    // sd never touches the panel feature.
    const cargo =
        '[features]\n' +
        'default = ["panel-gc9107", "sd"]\n' +
        'panel-gc9107 = []\n' +
        'panel-gc9a01 = []\n' +
        'sd = ["dep:embedded-sdmmc", "dep:critical-section"]\n';

    const off = setSdEnabled(cargo, false).text;
    contains(off, 'default = ["panel-gc9107"]', 'only "sd" is dropped from the mixed default');
    contains(off, 'panel-gc9a01 = []', 'sibling features are untouched');
    notOk(isSdEnabled(off));

    const on = setSdEnabled(off, true).text;
    contains(on, 'default = ["panel-gc9107", "sd"]', 're-adding lands back in the old order');
    ok(isSdEnabled(on));
});

test('a no-op toggle is reported as none', () => {
    const cargo = designerCargoToml('sunton-3248s035r');
    equal(setSdEnabled(cargo, true).note, 'none', 'already-on is a no-op');
    const off = setSdEnabled(cargo, false);
    equal(setSdEnabled(off.text, false).note, 'none', 'already-off is a no-op');
});
