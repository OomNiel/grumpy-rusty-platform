/**
 * Espressif-specific board helpers.
 *
 * Pure (no `vscode`), so the wizard, the generator and the tests all agree on what a
 * board's options mean. The interesting case is the T-QT: LilyGo shipped two 128x128
 * panels under one name, so "which panel" is a question the *project* has to answer
 * and the answer has to survive into Cargo.toml, the generated source and the README.
 */

import { BoardOptionChoice, BoardProfile, EspBoardProfile, EspDisplay, EspTouch } from './types';

/** Answers to a board's `options`, keyed by option id. */
export type BoardChoices = Record<string, string>;

/** The option id that selects a panel revision. */
export const PANEL_OPTION_ID = 'panel';

/** Preselection for every option a board declares. */
export function defaultChoices(board: BoardProfile): BoardChoices {
    const choices: BoardChoices = {};
    for (const option of board.options) {
        choices[option.id] = option.default;
    }
    return choices;
}

/** The choice list for the panel option, in the order the wizard should offer it. */
export function panelChoices(board: EspBoardProfile): BoardOptionChoice[] {
    return board.options.find((option) => option.id === PANEL_OPTION_ID)?.choices ?? [];
}

/** True when the board needs the user to pick a panel revision. */
export function needsPanelChoice(board: EspBoardProfile): boolean {
    return board.displays.some((display) => display.panelChoice !== undefined);
}

/**
 * Whether the panel has a backlight pin wired at all.
 *
 * A module may leave BL unconnected, and then there is nothing to switch, nothing to dim and no Brightness
 * setting to offer. Every panel catalogued today wires it -- the check exists so a future one that does not
 * cannot get a PWM channel driving a pin that goes nowhere.
 */
export function hasBacklight(display: EspDisplay | undefined): boolean {
    return display?.backlight !== undefined;
}

/**
 * The touch controller a project drives: the panel's own, or the board's.
 *
 * A DevKitC carries whatever display module was plugged in, so a controller is a fact of the module (`display`)
 * while the CYD's XPT2046 is soldered to the board. The panel wins when it has one -- it is the more specific
 * fact, and it is the one the wizard asked about.
 */
export function touchFor(
    board: EspBoardProfile,
    display: EspDisplay | undefined,
): EspTouch | undefined {
    return display?.touch ?? board.touch;
}

/**
 * The panel choice a generated project records in its own `Cargo.toml`.
 *
 * The generator puts `panel-<id>` in `[features] default`, so the manifest is the durable answer to "which
 * display was this project made for" -- the generated `src/main.rs` is not something the Designer can read
 * back, and a board like the DevKitC has modules that differ in size and in whether they bring a touch
 * controller. Absent for a board with one panel and for a project generated before the option existed.
 */
export function panelChoiceFromCargo(cargoToml: string): string | undefined {
    const match = /^\s*default\s*=\s*\[([^\]]*)\]/m.exec(cargoToml);
    if (match === null) {
        return undefined;
    }
    const feature = /panel-([A-Za-z0-9_-]+)/.exec(match[1] ?? '');
    return feature?.[1];
}

/**
 * The panel a project was generated for, read back from its manifest.
 *
 * Falls back to `displayFor`'s own rule (the single panel, or the option's default) when the manifest does not
 * say -- which is what a project generated before a board had panel revisions looks like.
 */
export function displayForProject(
    board: EspBoardProfile,
    cargoToml: string,
): EspDisplay | undefined {
    const choice = panelChoiceFromCargo(cargoToml);
    return displayFor(board, choice === undefined ? {} : { panel: choice });
}

/**
 * The panel this project is generated for.
 *
 * A board with one panel returns it outright. A board with revisions needs a choice;
 * an unknown id falls back to the first panel rather than generating nothing, because a
 * project without a panel cannot build at all.
 */
export function displayFor(
    board: EspBoardProfile,
    choices: BoardChoices = {},
): EspDisplay | undefined {
    if (board.displays.length === 0) {
        return undefined;
    }
    const single = board.displays.find((display) => display.panelChoice === undefined);
    if (single) {
        return single;
    }
    const option = board.options.find((candidate) => candidate.id === PANEL_OPTION_ID);
    const wanted = option ? (choices[option.id] ?? option.default) : undefined;
    return board.displays.find((display) => display.panelChoice === wanted) ?? board.displays[0];
}

/**
 * Cargo feature that selects a panel revision.
 *
 * The feature, not a generated `#[cfg]` constant, is what makes the choice switchable:
 * LilyGo's own instructions for the ambiguous T-QT are "copy the other init table over
 * and rebuild", which in Cargo terms is exactly a feature flip.
 */
export function panelFeature(choiceId: string): string {
    return `panel-${choiceId}`;
}

/** Every GPIO a generated project drives, as `<pin>: <what>`. For the README table. */
export function espPinUsage(board: EspBoardProfile, choices: BoardChoices = {}): string[] {
    const lines: string[] = [];
    const display = displayFor(board, choices);
    if (display) {
        lines.push(`${display.cs}: panel chip select (${display.label})`);
        lines.push(`${display.dc}: panel data/command`);
        if (display.rst !== undefined) {
            lines.push(`${display.rst}: panel reset`);
        }
        if (display.backlight !== undefined) {
            lines.push(
                `${display.backlight}: panel backlight (${display.backlightActiveLow === true ? 'active low' : 'active high'}, PWM)`,
            );
        }
        lines.push(`${display.spi.sclk}: panel SPI clock`);
        lines.push(`${display.spi.mosi}: panel SPI data out`);
        if (display.spi.miso !== undefined) {
            lines.push(`${display.spi.miso}: panel SPI data in`);
        }
    }
    const touch = touchFor(board, display);
    if (touch) {
        lines.push(`${touch.cs}: touch chip select (${touch.controller})`);
        lines.push(`${touch.irq}: touch interrupt`);
    }
    if (board.sd) {
        lines.push(`${board.sd.cs}: microSD chip select`);
        lines.push(`${board.sd.spi.sclk}: microSD clock`);
        lines.push(`${board.sd.spi.mosi}: microSD data out`);
    }
    if (board.led.kind === 'gpio') {
        lines.push(`${board.led.pin}: ${board.led.external ? 'offered pin for an external LED' : 'on-board LED'}`);
    }
    return lines;
}
