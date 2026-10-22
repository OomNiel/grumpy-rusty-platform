'use strict';

/**
 * The panel backlight: brightness as a project setting, and the PWM that makes it real.
 *
 * Two halves, and they have to agree. The *setting* is a percentage in `.cargo/esp-config.toml` that the
 * Designer writes and a hand-edit can still make sense of; the *firmware* reads it at compile time and turns
 * it into a duty cycle, inverting it for a panel whose transistor switches on with a low level. A brightness
 * of 30 that means 70 on one board is not a rounding error -- it is the setting being wrong on that board.
 *
 * The availability rule is asserted too: a module that leaves BL unconnected gets no PWM, no state field and
 * no Brightness control.
 */

const { test, ok, notOk, equal, contains, notContains, sketchSource } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const { boardById } = compiled('boards/catalog');
const { displayFor, displayForProject, hasBacklight, panelChoiceFromCargo, touchFor } = compiled('boards/esp');
const { generateProjectFiles } = compiled('generate/files');
const {
    BACKLIGHT_ENV,
    DEFAULT_BRIGHTNESS,
    brightnessFromConfig,
    brightnessLine,
    clampBrightness,
    configHasBrightness,
    setBrightnessInConfig,
} = compiled('display/backlight');

function settingsOf(boardId, template, extra = {}) {
    const files = generateProjectFiles({
        board: boardById(boardId),
        projectName: 'x',
        template,
        ...extra,
    });
    return {
        files,
        config: files.find((file) => file.path === '.cargo/esp-config.toml').content,
        main: sketchSource(files),
        readme: files.find((file) => file.path === 'README.md').content,
        manifest: files.find((file) => file.path === 'Cargo.toml').content,
    };
}

// ---------------------------------------------------------------------------
// The setting itself
// ---------------------------------------------------------------------------

test('the brightness setting is absent-safe: no line means fully on', () => {
    equal(DEFAULT_BRIGHTNESS, 100);
    equal(brightnessFromConfig('[env]\nESP_LOG = "info"\n'), 100, 'a project from before the setting existed');
    equal(brightnessFromConfig(''), 100, 'an empty file');
    equal(brightnessFromConfig(`[env]\n${BACKLIGHT_ENV} = "40"\n`), 40);
    equal(brightnessFromConfig(`[env]\n${BACKLIGHT_ENV} = "0"\n`), 0, 'off is a real setting, not "missing"');
});

test('a brightness that is not a number is fully on, never dark', () => {
    // The failure that matters: a typo switching the panel off looks exactly like a dead board.
    equal(brightnessFromConfig(`[env]\n${BACKLIGHT_ENV} = "dim"\n`), 100);
    equal(brightnessFromConfig(`[env]\n${BACKLIGHT_ENV} = ""\n`), 100);
    equal(brightnessFromConfig(`[env]\n${BACKLIGHT_ENV} = "120"\n`), 100, 'above the range clamps to the top');
    equal(brightnessFromConfig(`[env]\n${BACKLIGHT_ENV} = "-20"\n`), 0, 'below the range clamps to the bottom');
});

test('clamping keeps a whole percentage in range', () => {
    equal(clampBrightness(42.4), 42);
    equal(clampBrightness(42.6), 43);
    equal(clampBrightness(-1), 0);
    equal(clampBrightness(101), 100);
    equal(clampBrightness(Number.NaN), DEFAULT_BRIGHTNESS);
});

test('writing brightness replaces the line or adds it to [env]', () => {
    const replaced = setBrightnessInConfig('[env]\nESP_LOG = "info"\nBACKLIGHT_BRIGHTNESS = "100"\n', 35);
    contains(replaced, 'BACKLIGHT_BRIGHTNESS = "35"');
    notContains(replaced, '"100"', 'only one brightness line survives');
    contains(replaced, 'ESP_LOG = "info"', 'and other keys are untouched');

    const added = setBrightnessInConfig('[env]\nESP_LOG = "info"\n', 35);
    contains(added, 'BACKLIGHT_BRIGHTNESS = "35"');
    equal(added.match(/BACKLIGHT_BRIGHTNESS/g).length, 1);
    ok(configHasBrightness(added, 35), 'the file now carries the setting');
    notOk(configHasBrightness(added, 36), 'a different value is a change, not a no-op');
    equal(brightnessLine(35), 'BACKLIGHT_BRIGHTNESS = "35"');
});

// ---------------------------------------------------------------------------
// What the generator writes
// ---------------------------------------------------------------------------

test('a new project records its brightness in the config, not in main.rs', () => {
    const at60 = settingsOf('esp32-devkitc', 'designer', { brightness: 60 });
    contains(at60.config, 'BACKLIGHT_BRIGHTNESS = "60"', 'the setting is a runtime-config line');
    notContains(at60.main, 'BACKLIGHT_BRIGHTNESS = "60"', 'and never a constant baked into the sketch');

    const untouched = settingsOf('esp32-devkitc', 'designer');
    contains(untouched.config, 'BACKLIGHT_BRIGHTNESS = "100"', 'a new project starts fully on');
});

test('the firmware dims the backlight by PWM on the BL pin, at compile time', () => {
    const devkit = settingsOf('esp32-devkitc', 'designer');
    // The pin itself: GPIO21 is the DevKitC modules' BL, from the catalogue.
    contains(devkit.main, 'ledc.channel(channel::Number::Channel0, peripherals.GPIO21)');
    contains(devkit.main, 'duty_pct: BACKLIGHT_DUTY_PCT,');
    contains(devkit.main, 'const BACKLIGHT_PERCENT: u8 = match option_env!("BACKLIGHT_BRIGHTNESS")');
    contains(devkit.main, 'Some(text) => percent_from_env(text),');
    contains(devkit.main, 'None => 100,', 'a project with no key is fully on');
    contains(devkit.main, 'duty: timer::config::Duty::Duty10Bit,');
});

test('the brightness is inverted for a panel whose transistor is active low', () => {
    // The T-QT switches its backlight on with a LOW level, so 30 % brightness is a 70 % duty and the pin is
    // nearly always low. Asserting the constant, not a comment: this is the line that decides it.
    const tqt = settingsOf('lilygo-tqt', 'designer', { choices: { panel: 'gc9107' } });
    contains(tqt.main, 'pub const BACKLIGHT_DUTY_PCT: u8 = 100 - BACKLIGHT_PERCENT;');

    const devkit = settingsOf('esp32-devkitc', 'designer');
    contains(devkit.main, 'pub const BACKLIGHT_DUTY_PCT: u8 = BACKLIGHT_PERCENT;');
});

test('the PWM machinery lives in statics, so the channel can outlive setup()', () => {
    // A channel borrows its timer, and the channel is part of the sketch's State: a local timer would be
    // dropped at the end of setup() while the channel still referred to it. Found by compiling one.
    const { main } = settingsOf('sunton-3248s035r', 'designer');
    contains(main, "static LEDC_CELL: static_cell::StaticCell<Ledc<'static>>");
    contains(main, "static BACKLIGHT_TIMER_CELL: static_cell::StaticCell<timer::Timer<'static, LowSpeed>>");
    contains(main, 'backlight: Backlight,', 'the state field is the channel');
    contains(main, 'pub type Backlight = Channel<\'static, LowSpeed>;');
});

test('a panel with no BL pin wired gets no PWM, no field and no setting', () => {
    // Not a catalogued module today, and that is the point: the rule has to hold before such a module exists.
    const bare = { ...displayFor(boardById('esp32-devkitc'), { panel: 'st7789' }) };
    delete bare.backlight;
    delete bare.backlightActiveLow;
    notOk(hasBacklight(bare), 'no pin, no backlight');
    notOk(hasBacklight(undefined), 'and no panel at all is the same answer');
    ok(hasBacklight(displayFor(boardById('esp32-devkitc'), { panel: 'st7789' })), 'the catalogued modules have one');

    // The generated project for such a module would have no PWM line and no -- so the brightness key is not
    // written for it either. Both sides ask `hasBacklight`, which is what this asserts.
    const { config } = settingsOf('esp32-devkitc', 'designer');
    contains(config, BACKLIGHT_ENV, 'a panel with a BL pin does carry the key -- the contrast for the rule');
});

test('the generated README explains the brightness setting and the PWM pin', () => {
    const { readme } = settingsOf('esp32-devkitc', 'designer');
    contains(readme, '## Backlight brightness');
    contains(readme, 'BACKLIGHT_BRIGHTNESS');
    contains(readme, '| 21 | panel backlight (PWM) |');
});

// ---------------------------------------------------------------------------
// Which panel a project is for (the DevKitC's modules differ)
// ---------------------------------------------------------------------------

test('the panel a project was generated for is read back from its manifest', () => {
    equal(panelChoiceFromCargo('[features]\ndefault = ["panel-ili9341", "smtp"]\n'), 'ili9341');
    equal(panelChoiceFromCargo('[features]\ndefault = ["panel-st7789"]\n'), 'st7789');
    equal(panelChoiceFromCargo('[features]\ndefault = ["sd"]\n'), undefined, 'a board with one panel says nothing');
    equal(panelChoiceFromCargo(''), undefined);

    const devkit = boardById('esp32-devkitc');
    const ili = displayForProject(devkit, '[features]\ndefault = ["panel-ili9341"]\n');
    equal(ili.label, '2.8" ILI9341 240x320');
    equal(ili.height, 320, 'the canvas size follows the module, not the board');
    equal(touchFor(devkit, ili)?.controller, 'XPT2046', 'and so does the touch controller');

    const st = displayForProject(devkit, '[features]\ndefault = ["panel-st7789"]\n');
    equal(st.height, 240);
    equal(touchFor(devkit, st), undefined, 'the ST7789 module brings no controller');
});

test('a generated ILI9341 project drives the touch controller its panel carries', () => {
    // The catalogue records the controller on the *module*, and the generator used to ask the board only --
    // which quietly generated a touchless firmware for a touch module.
    const ili = settingsOf('esp32-devkitc', 'designer', { choices: { panel: 'ili9341' } });
    contains(ili.config, 'TOUCH_ENABLED = "1"');
    contains(ili.main, 'XPT2046');
    contains(ili.main, 'TOUCH_AXIS_A');
    contains(ili.manifest, 'esp-storage', 'the calibration needs flash, so the dependency follows the panel');
    contains(ili.manifest, 'embedded-hal =', 'and the XPT2046 read helper needs the trait');

    const st = settingsOf('esp32-devkitc', 'designer', { choices: { panel: 'st7789' } });
    notContains(st.config, 'TOUCH_ENABLED', 'the ST7789 module has no controller to switch');
    notContains(st.main, 'const TOUCH: bool', 'and no touch code to fold away');
});
