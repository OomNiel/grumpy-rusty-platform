'use strict';

/**
 * SD card support in generated ESP projects.
 *
 * Only one board carries an SD socket (the Sunton "cheap yellow display"), so "whichever file system is most
 * suitable for the target board" is unambiguous there: the card is FAT, and the FAT crate is `embedded-sdmmc`
 * -- the same one the `sdcard`/`board` templates mount. For the Designer template the card is optional and is
 * switched with a cargo `feature`; for the dedicated `sdcard`/`board` templates it is mandatory and ungated,
 * because those projects exist to mount a card.
 *
 * The host toolchain here is the native `rustc`, with no `xtensa-esp32-*` target, so the generated Rust is not
 * compiled: it is read for the bytes the `#[cfg]` / optional-dependency gating leaves behind.
 */

const { test, ok, notOk, contains, notContains, compiled } = require('../../lib/harness');
const { generateProjectFiles } = compiled('generate/files');
const { BOARDS } = compiled('boards/catalog');

function board(id) {
    const found = BOARDS.find((candidate) => candidate.id === id);
    ok(found, `unknown board ${id}`);
    return found;
}

/** One generated file's content as a string. */
function generated(boardId, template, rel) {
    const files = generateProjectFiles({ board: board(boardId), projectName: 'demo', template });
    const file = files.find((candidate) => candidate.path === rel);
    ok(file, `${template} for ${boardId} must produce ${rel}`);
    return file.content;
}

test('an SD-socket Designer project gates sd behind a cargo feature', () => {
    const cargo = generated('sunton-3248s035r', 'designer', 'Cargo.toml');
    const main = generated('sunton-3248s035r', 'designer', 'src/main.rs');

    // The file system is an optional dependency switched in by the `sd` feature (embedded-sdmmc = FAT).
    contains(cargo, 'embedded-sdmmc = { version = "0.8.2", optional = true }');
    contains(cargo, 'critical-section = { version = "1.2.0", optional = true }');
    contains(cargo, 'sd = ["dep:embedded-sdmmc", "dep:critical-section"]');
    contains(cargo, 'default = ["sd"]');

    // The Rust is compiled only when the feature is on.
    contains(main, '#[cfg(feature = "sd")]\nmod sd;');
    contains(main, '#[cfg(feature = "sd")]\n    sd::init(');
});

test('a Designer project without an SD socket omits all of it', () => {
    const cargo = generated('lilygo-tqt', 'designer', 'Cargo.toml');
    const main = generated('lilygo-tqt', 'designer', 'src/main.rs');

    notContains(cargo, 'embedded-sdmmc');
    notContains(cargo, 'dep:embedded-sdmmc');
    notContains(cargo, 'sd = [');
    notContains(main, 'mod sd;');
    notContains(main, 'sd::init');
});

test('the sdcard and board templates keep sd mandatory and ungated', () => {
    // Those templates are the card itself, so they never use the Designer toggle: the crate stays a plain
    // dependency (not optional, not behind a feature) and there is no #[cfg] around the mount. This is the
    // line the Designer feature-toggle must not cross.
    const sdcardCargo = generated('sunton-3248s035r', 'sdcard', 'Cargo.toml');
    contains(sdcardCargo, 'embedded-sdmmc = "0.8.2"');
    notContains(sdcardCargo, 'dep:embedded-sdmmc');
    notContains(sdcardCargo, 'optional = true');

    const boardCargo = generated('sunton-3248s035r', 'board', 'Cargo.toml');
    contains(boardCargo, 'embedded-sdmmc = "0.8.2"');
    notContains(boardCargo, 'dep:embedded-sdmmc');
    notContains(boardCargo, 'optional = true');
});
