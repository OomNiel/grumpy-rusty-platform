'use strict';

/**
 * The LCD rotation: 0 = none, 1 = 90, 2 = 180, 3 = 270 degrees clockwise.
 *
 * The point of the design is *where* the value lives. `src/main.rs` is generated once and then belongs to
 * the user, so a rotation stored there could never be changed afterwards without either editing it by hand
 * or losing the user's own code to a regeneration. Instead the number goes into the project's
 * `.cargo/esp-config.toml` (`[env]`, which cargo applies to the rustc invocations, so `option_env!` sees it)
 * and into the workspace's `.vscode/settings.json` as the handle the user turns. These tests pin both halves,
 * and the rewrite that keeps them in step.
 */

const fs = require('fs');
const path = require('path');
const { test, ok, notOk, equal, contains, notContains, compiled } = require('../../lib/harness');
const { repoRoot } = require('../../lib/harness');
const { boardById } = compiled('boards/catalog');
const { generateProjectFiles } = compiled('generate/files');
const {
    LCD_ROTATIONS,
    LCD_ROTATION_ENV,
    LCD_ROTATION_LABELS,
    asLcdRotation,
    isLcdRotation,
    templateUsesPanel,
    lcdRotationLine,
    setLcdRotationInConfig,
    configHasRotation,
} = compiled('display/rotation');

const CYD = 'sunton-3248s035r';
const DEVKITC = 'esp32-devkitc';

/** The templates that build a panel, and the ones that do not, as the generator sees them. */
const PANEL_TEMPLATES = ['display', 'touch', 'board'];
const WIRED_TEMPLATES = ['blinky', 'wifi', 'bluetooth', 'sdcard', 'peripherals'];

/**
 * A board that offers each template. The DevKitC has no panel, no card socket and no sensors, so the panel
 * and peripheral templates are not offered for it at all -- `sdcard` and `peripherals` have to be exercised
 * on the CYD, which is exactly the interesting case: a board *with* a panel and a template that ignores it.
 */
const BOARD_FOR = {
    display: CYD,
    touch: CYD,
    board: CYD,
    blinky: DEVKITC,
    wifi: DEVKITC,
    bluetooth: DEVKITC,
    sdcard: CYD,
    peripherals: CYD,
};

function filesFor(boardId, template, rotation) {
    const files = generateProjectFiles({
        board: boardById(boardId),
        projectName: 'demo',
        template,
        rotation,
    });
    return new Map(files.map((file) => [file.path, file.content]));
}

test('the four values are the only ones, and anything else is no rotation', () => {
    equal([...LCD_ROTATIONS], [0, 1, 2, 3], 'the setting offers exactly 0-3');
    for (const value of LCD_ROTATIONS) {
        ok(isLcdRotation(value), `${value} is a rotation`);
        ok(LCD_ROTATION_LABELS[value], `${value} has a label to show the user`);
    }
    // A settings.json is editable by hand, so a wrong value must degrade rather than throw: the rotation is a
    // cosmetic choice, and 0 is what the panel does when it is not told anything.
    for (const wrong of [4, -1, 1.5, '1', null, undefined, NaN, {}]) {
        notOk(isLcdRotation(wrong), `${JSON.stringify(wrong)} is not a rotation`);
        equal(asLcdRotation(wrong), 0, `${JSON.stringify(wrong)} falls back to no rotation`);
    }
    equal(asLcdRotation(2), 2, 'a good value is passed through');
});

test('the rotation is only asked about for templates that drive a panel', () => {
    for (const template of PANEL_TEMPLATES) {
        ok(templateUsesPanel(template), `${template} draws on a panel`);
    }
    for (const template of WIRED_TEMPLATES) {
        notOk(templateUsesPanel(template), `${template} has no panel to turn`);
    }
    // And that list has to agree with the templates that actually build a panel, or the prompt would be
    // offered for a project with no display and skipped for one that has it. This is the check that keeps
    // the two lists from drifting, including for a board that has a panel and a template that ignores it.
    for (const template of [...PANEL_TEMPLATES, ...WIRED_TEMPLATES]) {
        const main = filesFor(BOARD_FOR[template], template).get('src/main.rs');
        equal(
            templateUsesPanel(template),
            main.includes('Builder::new('),
            `${template}: the prompt list and the generated code disagree`,
        );
    }
});

test('the project carries the chosen rotation and reads it at compile time', () => {
    for (const rotation of LCD_ROTATIONS) {
        const files = filesFor(CYD, 'display', rotation);
        contains(
            files.get('.cargo/esp-config.toml'),
            `${LCD_ROTATION_ENV} = "${rotation}"`,
            `rotation ${rotation} reaches the config file`,
        );
        contains(
            files.get('.vscode/settings.json'),
            `"rustyPlatform.lcdRotation": ${rotation}`,
            `rotation ${rotation} is the setting's value`,
        );
        // main.rs never learns the number: it reads the environment, which is what makes the value changeable
        // without regenerating the file.
        contains(files.get('src/main.rs'), `option_env!("${LCD_ROTATION_ENV}")`);
        contains(files.get('src/main.rs'), 'Rotation::Deg0', 'none is the fallback');
        contains(files.get('src/main.rs'), 'Rotation::Deg90');
        contains(files.get('src/main.rs'), 'Rotation::Deg180');
        contains(files.get('src/main.rs'), 'Rotation::Deg270');
        // The number is not chosen in main.rs; the match arms cover all four and the environment decides.
        contains(files.get('src/main.rs'), 'Some("1") => Rotation::Deg90');
        // And the build says which one it got, so the board's log can settle the question during a test.
        contains(files.get('src/main.rs'), 'panel rotation setting:');
        contains(files.get('src/main.rs'), 'option_env!("LCD_ROTATION").unwrap_or("0")');
    }
});

test('every panel template rotates, and no other template carries the machinery', () => {
    for (const template of PANEL_TEMPLATES) {
        const files = filesFor(CYD, template, 1);
        contains(files.get('src/main.rs'), '.rotate(rotation)');
        contains(files.get('src/main.rs'), `option_env!("${LCD_ROTATION_ENV}")`);
        contains(files.get('.cargo/esp-config.toml'), `${LCD_ROTATION_ENV} = "1"`);
    }
    for (const template of WIRED_TEMPLATES) {
        // Note `sdcard` and `peripherals` run on the CYD: it has a panel, and these templates do not use it,
        // so they must still carry no rotation at all.
        const files = filesFor(BOARD_FOR[template], template, 1);
        notContains(
            files.get('.cargo/esp-config.toml'),
            LCD_ROTATION_ENV,
            `${template}: no panel means no rotation to carry`,
        );
        notContains(files.get('src/main.rs'), 'Rotation::Deg90', `${template}: nothing to rotate`);
        notContains(
            files.get('.vscode/settings.json'),
            'rustyPlatform.lcdRotation',
            `${template}: the setting would be meaningless`,
        );
    }
});

test('the README tells the reader how to change the rotation', () => {
    const readme = filesFor(CYD, 'display', 3).get('README.md');
    contains(readme, 'LCD_ROTATION');
    contains(readme, '.cargo/esp-config.toml');
    contains(readme, 'rustyPlatform.lcdRotation');
    contains(readme, LCD_ROTATION_LABELS[3], 'the chosen rotation is named');
    // The consequence of a rotation: the image turns, the drawing area does not.
    contains(readme, 'does not change the drawing area');
});

test('the setting is declared with the four values and no rotation as the default', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf8'));
    const setting = manifest.contributes.configuration.properties['rustyPlatform.lcdRotation'];
    ok(setting, 'the setting is contributed');
    equal(setting.enum, [0, 1, 2, 3], 'the four rotations are the only choices');
    equal(setting.default, 0, 'nothing is turned unless asked');
    equal(setting.scope, 'resource', 'the rotation belongs to the project, not the window');
    equal(setting.enumDescriptions.length, 4, 'every value explains itself in the settings UI');
});

// --------------------------------------------------------------- the config rewrite
//
// This is what the setting change runs, and it is line-wise on purpose: by the time the user changes the
// rotation the project may have [env] entries of its own, and a regeneration would throw them away.

test('rewriting the rotation keeps everything else in the config file', () => {
    const original = `# Runtime configuration for the ESP logging stack.
[env]
# a comment the user added
ESP_LOG = "debug"
MY_OWN_SETTING = "keep me"
`;
    const updated = setLcdRotationInConfig(original, 2);
    contains(updated, `${LCD_ROTATION_ENV} = "2"`);
    contains(updated, 'ESP_LOG = "debug"', 'the logging level survives');
    contains(updated, 'MY_OWN_SETTING = "keep me"', 'so does anything the user added');
    contains(updated, '# a comment the user added', 'and the comments');
    ok(configHasRotation(updated, 2));
    notOk(configHasRotation(updated, 3));
});

test('rewriting replaces an existing entry instead of adding a second one', () => {
    const once = setLcdRotationInConfig(`[env]\nESP_LOG = "info"\n`, 1);
    const twice = setLcdRotationInConfig(once, 3);
    equal(twice.split('\n').filter((line) => line.startsWith(LCD_ROTATION_ENV)).length, 1);
    contains(twice, `${LCD_ROTATION_ENV} = "3"`);
    notContains(twice, `${LCD_ROTATION_ENV} = "1"`);
    // Idempotent: writing the same value twice does not keep adding lines.
    equal(setLcdRotationInConfig(twice, 3), twice);
});

test('a config with no [env] section gets one', () => {
    const updated = setLcdRotationInConfig('# nothing here yet\n', 1);
    contains(updated, '[env]');
    contains(updated, `${LCD_ROTATION_ENV} = "1"`);
    contains(updated, '# nothing here yet', 'the original content is still there');
    // And an empty file is not a special case that produces a broken table.
    contains(setLcdRotationInConfig('', 0), `[env]\n${lcdRotationLine(0)}`);
});

test('a hand-edited line is recognised by its value, not by its position', () => {
    const handEdited = `[env]\n${LCD_ROTATION_ENV} = "1"  \n`;
    notOk(configHasRotation(handEdited, 0), 'a different value is not the requested one');
    contains(setLcdRotationInConfig(handEdited, 0), `${LCD_ROTATION_ENV} = "0"`);
    equal(
        setLcdRotationInConfig(handEdited, 0).split('\n').filter((line) => line.includes(LCD_ROTATION_ENV)).length,
        1,
        'the hand-edited line is replaced, not duplicated',
    );
});
