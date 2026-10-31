/**
 * A TFT module wired to a Raspberry Pi Pico, and the GPIO numbers it is wired to.
 *
 * The ESP boards catalogue a panel as a property of the *board* (`EspDisplay`), because those panels are
 * soldered on. A Pico has no panel at all: a module is wired to whichever GPIOs somebody chose. So on the
 * Pico side the panel is a property of the *project* -- which module, and which pins -- and this module is
 * the single place that knows both.
 *
 * The three modules are the ones the ESP32-DevKitC's option already lists, under the same ids, so the facts
 * that cannot be read off a datasheet (`colorOrder`, `mirrorX`, and the ST7796's slower clock) are the ones
 * verified on real glass rather than a second, differently-wrong guess.
 *
 * Everything here is pure: no `vscode` import, so the wizard, the generator, the Designer host and the t1
 * layer all agree about what a legal wiring is. The panel of inputs in the Designer is a *view* of this
 * module's `validateWiring`, not a second set of rules.
 */

import { RpBoardProfile } from './types';

/** A controller mipidsi 0.10 ships a model for. Nothing here needs a hand-written init sequence. */
export type RpPanelController = 'ST7789' | 'ILI9341Rgb565' | 'ST7796';

/** One TFT module somebody can wire to a Pico. */
export interface PanelModule {
    /** Stable id. It is also the cargo feature suffix (`panel-<id>`), exactly as on the ESP side. */
    id: string;
    /** The name printed on the listing, used in the wizard, the README and the Designer. */
    label: string;
    /** A short description for the wizard's option list. */
    description: string;
    controller: RpPanelController;
    /** Native size in pixels, in the module's own orientation (rotation 0). */
    width: number;
    height: number;
    /** Whether the module brings an XPT2046 on the same SPI bus. */
    touch: boolean;
    /**
     * Whether the module has a microSD socket.
     *
     * All three do, and on every one of them the socket's four SPI pins are *separate* from the panel's --
     * the socket behaves like a module of its own. The wiring still carries them beside the panel's so one
     * file describes the whole assembly.
     */
    sd: boolean;
    /** `Builder::color_order` — a fact about the glass, invisible to a compiler. */
    colorOrder: 'rgb' | 'bgr';
    mirrorX: boolean;
    mirrorY: boolean;
    /** `Builder::invert_colors(ColorInversion::Inverted)`: white draws black on these glasses. */
    invertColors: boolean;
    /** Panel clock in Hz. The ST7796 module is the slow one, as on the CYD. */
    spiHz: number;
}

/**
 * The modules, in the order the wizard offers them.
 *
 * Colour order and mirroring are the ESP32-DevKitC catalogue's own numbers for the same three modules: the
 * ILI9341 and ST7796 modules draw BGR and are mirrored in X, the ST7789 is RGB. Those two facts cannot be
 * checked by a build (a wrong colour order turns white into a *colour*, a wrong mirror puts the origin in
 * the corner), so they are recorded once, here, rather than guessed again per family.
 */
export const PANEL_MODULES: readonly PanelModule[] = [
    {
        id: 'st7789',
        label: 'Generic 1.54" TFT SPI ST7789 240x240',
        description: 'A 1.54 inch 240x240 ST7789 panel over SPI. No touch controller.',
        controller: 'ST7789',
        width: 240,
        height: 240,
        touch: false,
        sd: true,
        colorOrder: 'rgb',
        mirrorX: false,
        mirrorY: false,
        invertColors: false,
        spiHz: 40_000_000,
    },
    {
        id: 'ili9341',
        label: 'Generic 2.8" TFT SPI ILI9341 240x320 with XPT2046 touch',
        description: 'A 2.8 inch 240x320 ILI9341 panel over SPI with an XPT2046 touch controller.',
        controller: 'ILI9341Rgb565',
        width: 240,
        height: 320,
        touch: true,
        sd: true,
        colorOrder: 'bgr',
        mirrorX: true,
        mirrorY: false,
        invertColors: false,
        spiHz: 40_000_000,
    },
    {
        id: 'st7796',
        label: '4-Inch-SPI-TFT-ST7796 320x480 with XPT2046 touch',
        description: 'A 4 inch 320x480 ST7796 panel over SPI with an XPT2046 touch controller.',
        controller: 'ST7796',
        width: 320,
        height: 480,
        touch: true,
        sd: true,
        colorOrder: 'bgr',
        mirrorX: true,
        mirrorY: false,
        invertColors: false,
        spiHz: 24_000_000,
    },
];

/** The module a project starts with: the cheapest, smallest, no-touch one. */
export const DEFAULT_PANEL_ID = 'st7789';

export function panelModule(id: string): PanelModule | undefined {
    return PANEL_MODULES.find((module) => module.id === id);
}

/** The module, or the default one when an id from an older project is not ours any more. */
export function panelModuleOrDefault(id: string | undefined): PanelModule {
    return panelModule(id ?? '') ?? (panelModule(DEFAULT_PANEL_ID) as PanelModule);
}

// ------------------------------------------------------------------------ pins

/**
 * What a GPIO can be used for on the SPI peripheral the panel is wired to.
 *
 * RP2040 and RP2350 have the same SPI alternative functions on GPIO0..GPIO29 -- the Pico 2 does not expose
 * any pin above 29, and the extra functions RP2350 adds live on GPIO32..47, which no header reaches. These
 * tables are the mirror of embassy-rp's own trait impls (`ClkPin<SPI0>`, `MosiPin<SPI0>`, ...), which is
 * why a pin that fails validation here would also fail to compile: the HAL makes the mistake impossible
 * and this makes it legible.
 */
export const SPI_PIN_FUNCTIONS: Record<0 | 1, { sclk: number[]; mosi: number[]; miso: number[] }> = {
    0: {
        sclk: [2, 6, 18],
        mosi: [3, 7, 19],
        miso: [0, 4, 16],
    },
    1: {
        sclk: [10, 14],
        mosi: [11, 15],
        miso: [8, 12],
    },
};

/** The highest GPIO number on a Pico header (both silicon revisions stop at 29). */
export const MAX_GPIO = 29;

/** The SPI peripheral a clock pin belongs to, or `undefined` when it belongs to neither. */
export function spiIndexOf(sclk: number): 0 | 1 | undefined {
    if (SPI_PIN_FUNCTIONS[0].sclk.includes(sclk)) {
        return 0;
    }
    if (SPI_PIN_FUNCTIONS[1].sclk.includes(sclk)) {
        return 1;
    }
    return undefined;
}

/** Every pin a wiring drives or reads, with the label used in messages. */
export type WiringField =
    | 'panel'
    | 'bus'
    | 'sclk'
    | 'mosi'
    | 'miso'
    | 'cs'
    | 'dc'
    | 'rst'
    | 'backlight'
    | 'touchCs'
    | 'touchIrq'
    | 'sdSclk'
    | 'sdMosi'
    | 'sdMiso'
    | 'sdCs'
    | 'timeSource';

/**
 * The GPIO numbers one Pico project uses, plus the two choices that are not pins.
 *
 * Nullable on purpose, and `null` rather than "absent": a field left out of the file and a field the user
 * cleared mean the same thing ("nothing wired here"), and reading the difference would be a way to
 * resurrect a pin nobody asked for.
 */
export interface PanelWiring {
    /** The module id, from `PANEL_MODULES`. */
    panel: string;
    /**
     * Which SPI peripheral the panel is on.
     *
     * The choice, as opposed to the pins: it is what the planner works from, and it is what the Hardware
     * panel's bus selector writes. A wiring whose SCK has been overridden onto the other bus contradicts it,
     * and `validateWiring` says so rather than silently planning against the wrong peripheral.
     */
    bus: 0 | 1;
    /**
     * Whether SPI0 is on its second group of pins -- clock 2, data out 3, data in 4, chip select 5.
     *
     * SPI0 is the only peripheral with two groups, and the choice is a field rather than a consequence of the
     * clock pin: the Hardware panel's bus list offers "SPI0" and "SPI0-Alt" as two options, and which one is
     * chosen is what the planner plans for. Always `false` on SPI1.
     */
    alt: boolean;
    /** Panel SPI. `miso` is only needed when something on the bus reads (touch, and a shared card bus). */
    sclk: number;
    mosi: number;
    miso: number | null;
    /** Driven by the firmware as a plain output, so it may be any free pin. */
    cs: number;
    dc: number;
    /** `null` when the module's RESET is tied to the board's — mipidsi's `NoResetPin`. */
    rst: number | null;
    /** `null` when BL is not wired; then there is no Brightness setting and no PWM channel. */
    backlight: number | null;
    /** Whether the backlight transistor switches on with a LOW level. */
    backlightActiveLow: boolean;
    /** XPT2046, when the module has one. Both `null` on a module without a controller. */
    touchCs: number | null;
    touchIrq: number | null;
    /**
     * The card socket, on its own four pins.
     *
     * `sdCs === null` means no card is in use. The other three falling on the panel's own pins (all three
     * equal) is allowed and means one bus with two chip selects, which is what a module with a shared bus
     * needs; anything else must be a complete set on the *other* SPI peripheral.
     */
    sdSclk: number | null;
    sdMosi: number | null;
    sdMiso: number | null;
    sdCs: number | null;
    /** Where a Clock design's time comes from. See `TimeSource`. */
    timeSource: TimeSource;
}

/**
 * Where the software RTC in a Pico design is seeded from.
 *
 * No RP2040/RP2350 board has an RTC on the chip, so all four boards count seconds in software; the
 * question is only what the count starts at.
 *
 * - `flash` — the extension writes the time into `.cargo/config.toml` before every build, so the firmware
 *   starts at "when it was flashed". Works on every board, needs no network and no extra hardware.
 * - `wifi` — the W boards join the network at boot and take the time from an SNTP server, which also
 *   corrects a board that has been powered for days. Offered on the two wireless boards only.
 * - `rtc` — a battery-backed module (DS3231 and friends). **Not implemented yet**; the value exists so a
 *   project file can record the choice the moment the driver lands, and `timeSourcesFor` refuses it today
 *   rather than generating firmware for hardware nobody has wired.
 */
export type TimeSource = 'flash' | 'wifi' | 'rtc';

/** The time sources a board can actually use today. */
export function timeSourcesFor(board: RpBoardProfile): TimeSource[] {
    return board.wireless === 'cyw43' ? ['flash', 'wifi'] : ['flash'];
}

// -------------------------------------------------------------------- defaults

/** One group of four SPI pins, and the chip select that goes with them. */
export interface SpiBlock {
    sclk: number;
    mosi: number;
    miso: number;
    cs: number;
}

/**
 * The four pins each SPI peripheral owns, as the planner assigns them.
 *
 * A block rather than a set of alternatives: all four are legal SPI0 or SPI1 functions, they sit together on
 * the header (16-19 and 10-13), and a block is what makes "the nearest free pin" mean something. embassy-rp's
 * typed pins accept any *combination* of legal pins, so this is a choice rather than a requirement -- which is
 * exactly why the plan can be overridden.
 */
/**
 * The module's header pin for each GPIO, on the 40-pin boards.
 *
 * A GPIO number is what the firmware needs and a pin number is what a soldering iron needs, and the two are not
 * the same thing to count: GPIO 18 is the twenty-fourth pin of the module. The mapping is identical on the
 * Pico, the Pico 2, the Pico W and the Pico 2 W -- all four are the same 40-pin module -- so one table serves
 * every board this planner knows.
 *
 * Four GPIOs are missing on purpose. 23, 24, 25 and 29 are the wireless chip's own pins and the on-board LED:
 * they are not brought out, so there is no pin to name, and `headerPin` says so rather than inventing one.
 * (For the record, the pins a GPIO number never reaches: 3, 8, 13, 18, 23, 28, 33 and 38 are ground; 30 is
 * RUN, 35 is ADC_VREF, 36 is 3V3(OUT), 37 is 3V3_EN, 39 is VSYS and 40 is VBUS.)
 */
export const HEADER_PINS: Readonly<Record<number, number>> = {
    0: 1,
    1: 2,
    2: 4,
    3: 5,
    4: 6,
    5: 7,
    6: 9,
    7: 10,
    8: 11,
    9: 12,
    10: 14,
    11: 15,
    12: 16,
    13: 17,
    14: 19,
    15: 20,
    16: 21,
    17: 22,
    18: 24,
    19: 25,
    20: 26,
    21: 27,
    22: 29,
    26: 31,
    27: 32,
    28: 34,
};

/**
 * The module pin a GPIO comes out on, or `null` when it is not brought out at all.
 *
 * `null` is an answer, not a gap: the panel shows a dash and the generated README names the GPIO without a pin,
 * because "GPIO 25" is a real signal (the LED) that simply has no header pin to solder to.
 */
export function headerPin(gpio: number | null): number | null {
    if (gpio === null) {
        return null;
    }
    return HEADER_PINS[gpio] ?? null;
}

export const SPI_BLOCKS: Record<0 | 1, SpiBlock> = {
    0: { sclk: 18, mosi: 19, miso: 16, cs: 17 },
    1: { sclk: 10, mosi: 11, miso: 12, cs: 13 },
};

/**
 * SPI0's second group of pins, low on the header.
 *
 * The peripheral has a clock on GPIO2, data out on 3, data in on 4 and a chip select on 5, and forcing the
 * clock there is how somebody says "I wired the low group, not the high one". The control lines follow the
 * same rule as everywhere else -- the nearest free pins above the block -- which lands them on 6/7/8. SPI1 has
 * no second group: its clock is on 10 or 14 and nothing lower.
 */
export const SPI_ALT_BLOCKS: Partial<Record<0 | 1, SpiBlock>> = {
    0: { sclk: 2, mosi: 3, miso: 4, cs: 5 },
};

/** The bus the card gets: the one the panel is not on. */
export function otherBus(bus: 0 | 1): 0 | 1 {
    return bus === 0 ? 1 : 0;
}

/**
 * The block a plan uses, from the choice the bus list offers: SPI0, SPI0-Alt or SPI1.
 *
 * `chooseBlock(0, false)` is the high set and `chooseBlock(0, true)` the low one; SPI1 has one group, so its
 * `alt` is a no-op. The objects come from the two tables, so `===` answers "is this the same block?".
 */
export function chooseBlock(bus: 0 | 1, alt: boolean): SpiBlock {
    const alternative = alt ? SPI_ALT_BLOCKS[bus] : undefined;
    return alternative ?? SPI_BLOCKS[bus];
}

/** `SPI0`, `SPI0-Alt` or `SPI1` -- the three entries of the Hardware panel's bus list. */
export function busLabel(bus: 0 | 1, alt: boolean): string {
    const block = chooseBlock(bus, alt);
    const name = bus === 0 ? (alt ? 'SPI0-Alt' : 'SPI0') : 'SPI1';
    return `${name} (GPIO ${block.sclk}/${block.mosi}/${block.miso}/${block.cs})`;
}

/**
 * The pins the board itself needs, which a plan must never take.
 *
 * The radio's four pins come from the board profile (`board.cyw43`), so a wireless board with different
 * wiring is covered without a second table. The on-board LED is included too: a design that stole GPIO25 to
 * dim a backlight would leave the board unable to blink, which is a surprise rather than an error and not
 * something "nearest free" should hand out.
 */
export function reservedPins(board: RpBoardProfile): number[] {
    const reserved: number[] = [];
    if (board.led.kind === 'gpio') {
        const pin = pinFromName(board.led.pin);
        if (pin !== undefined) {
            reserved.push(pin);
        }
    }
    if (board.wireless === 'cyw43' && board.cyw43 !== undefined) {
        const cyw = board.cyw43;
        for (const name of [cyw.pwrPin, cyw.csPin, cyw.dioPin, cyw.clkPin]) {
            const pin = pinFromName(name);
            if (pin !== undefined) {
                reserved.push(pin);
            }
        }
    }
    return reserved;
}

export interface PlanOptions {
    /** The module id. Its catalogue entry decides whether a touch pair is assigned at all. */
    panel: string;
    /** The SPI peripheral the panel is on. */
    bus: 0 | 1;
    /** Whether the card socket is in use; when it is not, its four pins are left free. */
    sd: boolean;
    /** The pins the board itself needs -- see `reservedPins`. */
    reserved: readonly number[];
    /** Where a clock design's time comes from; not a pin, carried through unchanged. */
    timeSource: TimeSource;
    /** Whether the backlight transistor is active low; carried through unchanged. */
    backlightActiveLow?: boolean;
    /**
     * Whether SPI0 is on its second group of pins. Ignored for SPI1, which has only one. See `PanelWiring.alt`.
     */
    alt: boolean;
    /**
     * The wiring being edited. Every pin that is still legal in the new plan is kept where it is, and because
     * it carries its own `bus` and `alt`, it also says which block the pins came from -- so a change of block
     * moves the pins the planner chose without touching the ones that were typed in.
     */
    keep?: PanelWiring;
}

/** The signals a plan assigns, in the order it assigns them. */
const PLAN_SIGNALS = [
    'sclk',
    'mosi',
    'miso',
    'cs',
    'sdSclk',
    'sdMosi',
    'sdMiso',
    'sdCs',
    'dc',
    'rst',
    'backlight',
    'touchCs',
    'touchIrq',
] as const;

type PlanSignal = (typeof PLAN_SIGNALS)[number];

const SIGNAL_LABELS: Record<PlanSignal, string> = {
    sclk: 'SCK',
    mosi: 'MOSI',
    miso: 'MISO',
    cs: 'CS',
    sdSclk: 'Card SCK',
    sdMosi: 'Card MOSI',
    sdMiso: 'Card MISO',
    sdCs: 'Card CS',
    dc: 'DC',
    rst: 'RESET',
    backlight: 'BL',
    touchCs: 'Touch CS',
    touchIrq: 'Touch IRQ',
};

function inRange(pin: number | null): pin is number {
    return pin !== null && Number.isInteger(pin) && pin >= 0 && pin <= MAX_GPIO;
}

/** The next free pin at or after `start`, walking in `step` and wrapping once round the header. */
function freeFrom(start: number, taken: ReadonlySet<number>, step: 1 | -1): number | null {
    const span = MAX_GPIO + 1;
    for (let offset = 0; offset < span; offset += 1) {
        const pin = (((start + step * offset) % span) + span) % span;
        if (!taken.has(pin)) {
            return pin;
        }
    }
    return null;
}

/**
 * Plans every pin of a panel project.
 *
 * The block comes first, because it is a choice rather than a consequence: `chooseBlock` takes the one the bus
 * list names, so picking SPI0-Alt moves the whole panel to SPI0's low group. Then, each rule taking its pins
 * before the next looks:
 *
 * 1. **The panel's SPI block**: SCK, MOSI, MISO and the chip select, with any of that block already spoken for
 *    stepping along the same role's alternatives.
 * 2. **The card**, on the *other* bus and on its default block, when the socket is in use. This is what keeps
 *    the two peripherals apart: they are the only two the chip has, and a card that shared the panel's would
 *    have been the alternative -- the modules wire the socket separately.
 * 3. **DC, RESET and BL**, ascending from the top of the block: the nearest free pins, skipping anything
 *    reserved or already taken (20/21/22 for the high group, 6/7/8 for the low one).
 * 4. **The touch pair**, from the bottom of the block, because a controller sits beside the glass rather than
 *    past it: 14/15 for SCK 18, 8/9 for SPI1, 0/1 for the low group.
 *
 * A pin in `keep` is taken as it stands whenever it is still legal for its signal under this plan and free --
 * that is what makes an override survive a bus change, and what stops the control lines wandering when the
 * only thing that really has to move is the bus itself. A pin the planner chose last time follows a change of
 * block instead: `keep` carries the bus and the group it was planned for, so comparing that with the choice
 * being planned is enough to tell the two apart. Everything that moves is reported in `notes`, in the words
 * the panel shows.
 */
export function planWiring(options: PlanOptions): { wiring: PanelWiring; notes: string[] } {
    const block = chooseBlock(options.bus, options.alt);
    const keep = options.keep;
    const oldBlock = keep === undefined ? block : chooseBlock(keep.bus, keep.alt);
    // What the wiring looked like when the planner last saw it. A pin that still holds that value is the
    // planner's and follows a change of block; a pin holding anything else was typed in and stays put.
    const before =
        keep === undefined
            ? undefined
            : planBlock(
                {
                    panel: keep.panel,
                    bus: keep.bus,
                    alt: keep.alt,
                    sd: keep.sdCs !== null,
                    reserved: options.reserved,
                    timeSource: keep.timeSource,
                    backlightActiveLow: keep.backlightActiveLow,
                },
                oldBlock,
                undefined,
                false,
            ).wiring;
    return planBlock(options, block, before, oldBlock !== block);
}

/** One plan, for one block. Split out so `planWiring` can work out what the previous block would have been. */
function planBlock(
    options: PlanOptions,
    block: SpiBlock,
    before: PanelWiring | undefined,
    blockChanged: boolean,
): { wiring: PanelWiring; notes: string[] } {
    const module = panelModuleOrDefault(options.panel);
    const card = SPI_BLOCKS[otherBus(options.bus)];
    const cardBus = otherBus(options.bus);
    const taken = new Set<number>(options.reserved);
    const notes: string[] = [];
    const keep = options.keep;

    /** Keeps the pin the wiring already has when it is still legal, and plans one when it is not. */
    const settle = (
        signal: PlanSignal,
        legal: (pin: number) => boolean,
        preferred: () => number | null,
    ): number | null => {
        const current = keep === undefined ? null : keep[signal];
        const followsBlock = blockChanged && before !== undefined && before[signal] === current;
        if (inRange(current) && legal(current) && !taken.has(current) && !followsBlock) {
            taken.add(current);
            return current;
        }
        const planned = preferred();
        if (planned !== null) {
            taken.add(planned);
        }
        if (inRange(current) && current !== planned) {
            notes.push(
                planned === null
                    ? `${SIGNAL_LABELS[signal]} GPIO${current} had nowhere to go: no free pin is left`
                    : `${SIGNAL_LABELS[signal]} moved from GPIO${current} to GPIO${planned}`,
            );
        }
        return planned;
    };

    /** The block pin when it is free, otherwise the first free alternative for that role. */
    const pick = (choices: readonly number[], preferred: number): number | null => {
        if (!taken.has(preferred)) {
            return preferred;
        }
        for (const pin of choices) {
            if (!taken.has(pin)) {
                return pin;
            }
        }
        return null;
    };

    const spiLegal = (bus: 0 | 1, role: 'sclk' | 'mosi' | 'miso') => (pin: number): boolean =>
        inRange(pin) && SPI_PIN_FUNCTIONS[bus][role].includes(pin);
    const anywhere = (pin: number): boolean => inRange(pin);

    // The chip select is a plain output, so any free pin will do -- except a pin one of the blocks owns,
    // because the card is about to take the other block as a whole. Keeping CS on 17 after moving the panel to
    // SPI1 is how it ended up on the same pin as the card's chip select.
    const blockPins = new Set<number>();
    for (const group of [SPI_BLOCKS[0], SPI_BLOCKS[1], SPI_ALT_BLOCKS[0]]) {
        if (group !== undefined) {
            blockPins.add(group.sclk);
            blockPins.add(group.mosi);
            blockPins.add(group.miso);
            blockPins.add(group.cs);
        }
    }
    const chipSelect = (pin: number): boolean => inRange(pin) && (!blockPins.has(pin) || pin === block.cs);

    // 1. the panel's own block
    const sclk = settle('sclk', spiLegal(options.bus, 'sclk'), () => pick(SPI_PIN_FUNCTIONS[options.bus].sclk, block.sclk));
    const mosi = settle('mosi', spiLegal(options.bus, 'mosi'), () => pick(SPI_PIN_FUNCTIONS[options.bus].mosi, block.mosi));
    const miso = settle('miso', spiLegal(options.bus, 'miso'), () => pick(SPI_PIN_FUNCTIONS[options.bus].miso, block.miso));
    const cs = settle('cs', chipSelect, () => freeFrom(block.cs, taken, 1));

    // 2. the card, on the other bus, only while its socket is in use
    const sdSclk = options.sd
        ? settle('sdSclk', spiLegal(cardBus, 'sclk'), () => pick(SPI_PIN_FUNCTIONS[cardBus].sclk, card.sclk))
        : null;
    const sdMosi = options.sd
        ? settle('sdMosi', spiLegal(cardBus, 'mosi'), () => pick(SPI_PIN_FUNCTIONS[cardBus].mosi, card.mosi))
        : null;
    const sdMiso = options.sd
        ? settle('sdMiso', spiLegal(cardBus, 'miso'), () => pick(SPI_PIN_FUNCTIONS[cardBus].miso, card.miso))
        : null;
    const sdCs = options.sd ? settle('sdCs', chipSelect, () => freeFrom(card.cs, taken, 1)) : null;

    // 3. the control lines, ascending from the top of the block
    const top = Math.max(block.sclk, block.mosi, block.miso, block.cs) + 1;
    const dc = settle('dc', anywhere, () => freeFrom(top, taken, 1));
    const rst = settle('rst', anywhere, () => freeFrom(top, taken, 1));
    const backlight = settle('backlight', anywhere, () => freeFrom(top, taken, 1));

    // 4. the touch controller: the two free pins just below the block, ascending, because a controller sits
    //    beside its glass rather than past it. SCK 18 gives 14/15, the low group 0/1, SPI1's clock 8/9.
    const below = Math.min(block.sclk, block.mosi, block.miso, block.cs) - 2;
    const touchCs = module.touch ? settle('touchCs', anywhere, () => freeFrom(below, taken, 1)) : null;
    const touchIrq = module.touch
        ? settle('touchIrq', anywhere, () => freeFrom((touchCs ?? below) + 1, taken, 1))
        : null;

    if (sclk === null || mosi === null || miso === null || cs === null) {
        notes.push('the panel\'s own SPI pins could not all be assigned: this board has no room for them');
    }

    return {
        wiring: {
            panel: module.id,
            bus: options.bus,
            // SPI1 has one group, so a stale `true` would be a claim about a block that does not exist.
            alt: options.bus === 0 && options.alt,
            sclk: sclk ?? block.sclk,
            mosi: mosi ?? block.mosi,
            miso,
            cs: cs ?? block.cs,
            dc: dc ?? block.cs,
            rst,
            backlight,
            backlightActiveLow: options.backlightActiveLow ?? keep?.backlightActiveLow ?? false,
            touchCs,
            touchIrq,
            sdSclk,
            sdMosi,
            sdMiso,
            sdCs,
            timeSource: options.timeSource,
        },
        notes,
    };
}

/**
 * The wiring a new project starts from.
 *
 * Panel on SPI0 by default -- SCK 18, MOSI 19, MISO 16, CS 17, then DC 20, RESET 21, BL 22 and the touch
 * pair on 14/15, with the card on SPI1's block (10-13). Nothing lands on a pin the wireless chip owns and
 * nothing lands on the on-board LED, and every number is editable in the Designer.
 */
export function defaultWiring(board: RpBoardProfile, panelId: string = DEFAULT_PANEL_ID, bus: 0 | 1 = 0): PanelWiring {
    const module = panelModuleOrDefault(panelId);
    return planWiring({
        panel: module.id,
        bus,
        alt: false,
        sd: module.sd,
        reserved: reservedPins(board),
        timeSource: timeSourcesFor(board).includes('wifi') ? 'wifi' : 'flash',
    }).wiring;
}

// ------------------------------------------------------------------ validation

export interface WiringProblem {
    field: WiringField;
    severity: 'error' | 'warning';
    message: string;
}

export function wiringHasErrors(problems: readonly WiringProblem[]): boolean {
    return problems.some((problem) => problem.severity === 'error');
}

/** Every pin the wiring uses, in the order the Designer lists them, with a human label. */
function pinFields(wiring: PanelWiring): Array<{ field: WiringField; pin: number | null; label: string }> {
    return [
        { field: 'sclk', pin: wiring.sclk, label: 'Panel SCK' },
        { field: 'mosi', pin: wiring.mosi, label: 'Panel MOSI' },
        { field: 'miso', pin: wiring.miso, label: 'Panel MISO' },
        { field: 'cs', pin: wiring.cs, label: 'Panel CS' },
        { field: 'dc', pin: wiring.dc, label: 'Panel DC' },
        { field: 'rst', pin: wiring.rst, label: 'Panel RESET' },
        { field: 'backlight', pin: wiring.backlight, label: 'Backlight' },
        { field: 'touchCs', pin: wiring.touchCs, label: 'Touch CS' },
        { field: 'touchIrq', pin: wiring.touchIrq, label: 'Touch IRQ' },
        { field: 'sdSclk', pin: wiring.sdSclk, label: 'Card SCK' },
        { field: 'sdMosi', pin: wiring.sdMosi, label: 'Card MOSI' },
        { field: 'sdMiso', pin: wiring.sdMiso, label: 'Card MISO' },
        { field: 'sdCs', pin: wiring.sdCs, label: 'Card CS' },
    ];
}

/**
 * Whether the card sits on the panel's own SPI bus.
 *
 * Decided by the three data pins agreeing with the panel's, because that is the only way one bus can be
 * shared: same clock, same two data lines, two chip selects. A module whose socket has its own pins (all
 * three of ours) therefore reads back as `false` with the default wiring.
 */
export function cardSharesPanelBus(wiring: PanelWiring): boolean {
    return (
        wiring.sdCs !== null &&
        wiring.sdSclk === wiring.sclk &&
        wiring.sdMosi === wiring.mosi &&
        wiring.sdMiso === wiring.miso
    );
}

/**
 * Everything wrong with a wiring, for the Designer's Hardware panel and for the generator.
 *
 * Errors stop a project from being generated (or the panel's save from reaching `panel.rs`); warnings are
 * things that work but that the user probably did not mean. The message says which pin and why, because
 * the alternative is a compile error from embassy-rp's trait bounds, which names a type rather than a
 * number.
 */
export function validateWiring(board: RpBoardProfile, wiring: PanelWiring): WiringProblem[] {
    const problems: WiringProblem[] = [];
    const module = panelModule(wiring.panel);
    if (module === undefined) {
        problems.push({
            field: 'panel',
            severity: 'error',
            message: `"${wiring.panel}" is not a module this extension knows.`,
        });
        return problems;
    }

    // --- range, duplicates and the pins the board itself owns
    const owned = boardOwnedPins(board);
    for (const { field, pin, label } of pinFields(wiring)) {
        if (pin === null) {
            continue;
        }
        if (!Number.isInteger(pin) || pin < 0 || pin > MAX_GPIO) {
            problems.push({
                field,
                severity: 'error',
                message: `${label} is GPIO${pin}: a Pico has GPIO0 to GPIO${MAX_GPIO}.`,
            });
            continue;
        }
        const owner = owned.get(pin);
        if (owner !== undefined) {
            problems.push({
                field,
                severity: owner.hard ? 'error' : 'warning',
                message: owner.hard
                    ? `${label} is GPIO${pin}, which ${owner.why}.`
                    : `${label} is GPIO${pin}, ${owner.why} — the board's LED stops working.`,
            });
        }
    }

    const used = new Map<number, string>();
    // A card on the panel's own bus shares three wires with it *by design*, so those three are not a
    // duplicate: the chip selects are what separate the two devices.
    const sharedCardBus = cardSharesPanelBus(wiring);
    for (const { field, pin, label } of pinFields(wiring)) {
        if (pin === null || !Number.isInteger(pin) || pin < 0 || pin > MAX_GPIO) {
            continue;
        }
        if (sharedCardBus && (field === 'sdSclk' || field === 'sdMosi' || field === 'sdMiso')) {
            continue;
        }
        const already = used.get(pin);
        if (already !== undefined) {
            problems.push({
                field: 'panel',
                severity: 'error',
                message: `GPIO${pin} is used twice: ${already} and ${label}.`,
            });
        } else {
            used.set(pin, label);
        }
    }

    // --- the panel's own bus
    const bus = spiIndexOf(wiring.sclk);
    if (bus !== undefined && bus !== wiring.bus) {
        // The planner works from `bus`, the firmware from the pin. An override that moves SCK onto the other
        // peripheral leaves the two disagreeing, and every pin it planned after that would be wrong.
        problems.push({
            field: 'sclk',
            severity: 'error',
            message:
                `GPIO${wiring.sclk} is an SPI${bus} clock pin, but this project's display bus is SPI${wiring.bus}. ` +
                `Pick an SPI${wiring.bus} clock pin (${SPI_PIN_FUNCTIONS[wiring.bus].sclk.join(', ')}) or switch ` +
                'the bus.',
        });
    }
    // --- the group of pins within that bus
    //
    // Two ways to get this wrong, and both are warnings rather than errors: the wiring is legal and will work,
    // it just is not the group the bus list says. Saying so is the difference between a mixed set nobody meant
    // and a delivered one.
    const group = chooseBlock(wiring.bus, wiring.alt);
    if (group.sclk !== wiring.sclk) {
        const wanted = wiring.bus === 0 && !wiring.alt && wiring.sclk === SPI_ALT_BLOCKS[0]?.sclk
            ? 'Choose SPI0-Alt to plan the low group (2/3/4/5, with DC 6, RESET 7 and BL 8).'
            : `Choose ${busLabel(wiring.bus, wiring.alt)} to plan that group around it, or set SCK to ` +
              `GPIO${group.sclk}.`;
        problems.push({
            field: 'sclk',
            severity: 'warning',
            message: `This project is on ${busLabel(wiring.bus, wiring.alt)}, but SCK is GPIO${wiring.sclk}. ${wanted}`,
        });
    }

    if (bus === undefined) {
        problems.push({
            field: 'sclk',
            severity: 'error',
            message:
                `GPIO${wiring.sclk} is not an SPI clock pin. SPI0 uses 2, 6 or 18; SPI1 uses 10 or 14.`,
        });
    } else {
        const functions = SPI_PIN_FUNCTIONS[bus];
        if (!functions.mosi.includes(wiring.mosi)) {
            problems.push({
                field: 'mosi',
                severity: 'error',
                message:
                    `GPIO${wiring.mosi} is not an SPI${bus} data-out pin. ` +
                    `SPI${bus} uses ${functions.mosi.join(', ')}.`,
            });
        }
        if (wiring.miso !== null && !functions.miso.includes(wiring.miso)) {
            problems.push({
                field: 'miso',
                severity: 'error',
                message:
                    `GPIO${wiring.miso} is not an SPI${bus} data-in pin. ` +
                    `SPI${bus} uses ${functions.miso.join(', ')}.`,
            });
        }
    }

    // --- touch
    if (module.touch) {
        if (wiring.touchCs === null) {
            problems.push({
                field: 'touchCs',
                severity: 'error',
                message: `${module.label} has an XPT2046, so it needs a touch chip select.`,
            });
        }
        if (wiring.touchIrq === null) {
            problems.push({
                field: 'touchIrq',
                severity: 'error',
                message: `${module.label} has an XPT2046, so it needs a touch interrupt pin.`,
            });
        }
        if (wiring.miso === null) {
            problems.push({
                field: 'miso',
                severity: 'error',
                message: 'Touch reads the panel bus, so Panel MISO has to be wired.',
            });
        }
    } else if (wiring.touchCs !== null || wiring.touchIrq !== null) {
        problems.push({
            field: 'touchCs',
            severity: 'warning',
            message: `${module.label} has no touch controller; the touch pins are ignored.`,
        });
    }

    // --- the card
    if (wiring.sdCs !== null) {
        const cardPins: Array<{ field: WiringField; pin: number | null; label: string }> = [
            { field: 'sdSclk', pin: wiring.sdSclk, label: 'Card SCK' },
            { field: 'sdMosi', pin: wiring.sdMosi, label: 'Card MOSI' },
            { field: 'sdMiso', pin: wiring.sdMiso, label: 'Card MISO' },
        ];
        const missing = cardPins.filter((entry) => entry.pin === null);
        for (const entry of missing) {
            problems.push({
                field: entry.field,
                severity: 'error',
                message: `${entry.label} is empty, and the card cannot be reached with three of its four pins.`,
            });
        }
        if (missing.length === 0) {
            const cardBus = spiIndexOf(wiring.sdSclk as number);
            if (cardBus === undefined) {
                problems.push({
                    field: 'sdSclk',
                    severity: 'error',
                    message:
                        `GPIO${wiring.sdSclk} is not an SPI clock pin. SPI0 uses 2, 6 or 18; ` +
                        'SPI1 uses 10 or 14.',
                });
            } else {
                const functions = SPI_PIN_FUNCTIONS[cardBus];
                if (!functions.mosi.includes(wiring.sdMosi as number)) {
                    problems.push({
                        field: 'sdMosi',
                        severity: 'error',
                        message:
                            `GPIO${wiring.sdMosi} is not an SPI${cardBus} data-out pin. ` +
                            `SPI${cardBus} uses ${functions.mosi.join(', ')}.`,
                    });
                }
                if (!functions.miso.includes(wiring.sdMiso as number)) {
                    problems.push({
                        field: 'sdMiso',
                        severity: 'error',
                        message:
                            `GPIO${wiring.sdMiso} is not an SPI${cardBus} data-in pin. ` +
                            `SPI${cardBus} uses ${functions.miso.join(', ')}.`,
                    });
                }
                // One peripheral serves one set of pins. Two complete sets on the same instance would be
                // two `Spi` drivers over one SPI block, which embassy-rp refuses at compile time.
                if (cardBus === bus && !cardSharesPanelBus(wiring)) {
                    problems.push({
                        field: 'sdSclk',
                        severity: 'error',
                        message:
                            `SPI${cardBus} is already the panel's bus. Either give the card the other ` +
                            'SPI pins, or use the panel\'s own three data pins so the two share one bus.',
                    });
                }
            }
        }
    }

    // --- time
    const sources = timeSourcesFor(board);
    if (!sources.includes(wiring.timeSource)) {
        problems.push({
            field: 'timeSource',
            severity: 'error',
            message:
                wiring.timeSource === 'rtc'
                    ? 'A battery-backed RTC module is not supported yet; use the flash time or Wi-Fi.'
                    : `${board.name} has no Wi-Fi, so its clock is set when it is flashed.`,
        });
    }

    return problems;
}

interface OwnedPin {
    why: string;
    /** A hard claim (the radio's own pins) rather than a soft one (the on-board LED). */
    hard: boolean;
}

/**
 * The GPIOs the board itself needs, so a panel cannot take them.
 *
 * Read off the board profile rather than hard-coded: the CYW43 pins come from `board.cyw43`, so a future
 * wireless board with different wiring is covered without a second table. The LED is a *warning*: GPIO25
 * works, the board just stops blinking.
 */
function boardOwnedPins(board: RpBoardProfile): Map<number, OwnedPin> {
    const owned = new Map<number, OwnedPin>();
    if (board.led.kind === 'gpio') {
        const pin = pinFromName(board.led.pin);
        if (pin !== undefined) {
            owned.set(pin, {
                why: board.led.external ? 'offered for an external LED' : 'the on-board LED is',
                hard: false,
            });
        }
    }
    if (board.wireless === 'cyw43' && board.cyw43 !== undefined) {
        const wiring = board.cyw43;
        const roles: Array<[string, string]> = [
            [wiring.pwrPin, 'the wireless chip\'s power switch'],
            [wiring.csPin, 'the wireless chip\'s chip select'],
            [wiring.dioPin, 'the wireless chip\'s data line'],
            [wiring.clkPin, 'the wireless chip\'s clock'],
        ];
        for (const [name, why] of roles) {
            const pin = pinFromName(name);
            if (pin !== undefined) {
                owned.set(pin, { why, hard: true });
            }
        }
    }
    return owned;
}

/** `PIN_23` -> 23, and anything else -> `undefined`. */
export function pinFromName(name: string): number | undefined {
    const match = /^PIN_(\d+)$/.exec(name);
    return match === null ? undefined : Number(match[1]);
}

// --------------------------------------------------------------------- reading

/**
 * A wiring read back from `designer/panel.hardware.json`.
 *
 * Deliberately forgiving, exactly like the design document's own loader: a file written by an older
 * version, or edited by hand, must not be able to stop the Designer from opening. Unknown keys are
 * dropped, a missing pin is filled in from the defaults, and a module id that is no longer ours falls back
 * to the default module -- with a note, so the change is said out loud rather than silently applied.
 *
 * `null` is honoured (a cleared pin stays cleared); only a *missing* key is defaulted, because that is
 * what an older file looks like.
 */
export function parseWiring(
    raw: unknown,
    board: RpBoardProfile,
    fallbackPanel: string = DEFAULT_PANEL_ID,
): { wiring: PanelWiring; notes: string[] } {
    const defaults = defaultWiring(board, fallbackPanel);
    const notes: string[] = [];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { wiring: defaults, notes: raw === undefined ? [] : ['the hardware file is not an object'] };
    }
    const source = raw as Record<string, unknown>;
    const moduleId = typeof source.panel === 'string' ? source.panel : defaults.panel;
    if (panelModule(moduleId) === undefined) {
        notes.push(`"${moduleId}" is not a module this version knows; using ${defaults.panel}`);
    }
    const base = defaultWiring(board, panelModule(moduleId) === undefined ? defaults.panel : moduleId);

    const count = (key: keyof PanelWiring, fallback: number, min = 0): number => {
        const value = source[key];
        if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= MAX_GPIO) {
            return value;
        }
        if (value !== undefined) {
            notes.push(`"${String(key)}" was not a GPIO number; using ${fallback}`);
        }
        return fallback;
    };
    const optional = (key: keyof PanelWiring, fallback: number | null): number | null => {
        const value = source[key];
        if (value === null) {
            return null;
        }
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_GPIO) {
            return value;
        }
        if (value !== undefined) {
            notes.push(`"${String(key)}" was not a GPIO number; using the default`);
        }
        return fallback;
    };
    const flag = (key: keyof PanelWiring, fallback: boolean): boolean => {
        const value = source[key];
        return typeof value === 'boolean' ? value : fallback;
    };

    const timeSource: TimeSource =
        source.timeSource === 'flash' || source.timeSource === 'wifi' || source.timeSource === 'rtc'
            ? source.timeSource
            : base.timeSource;
    if (source.timeSource !== undefined && source.timeSource !== timeSource) {
        notes.push(`"timeSource" was not a source this version knows; using ${base.timeSource}`);
    }

    // The bus is a choice, and a project written before it existed does not say: the clock pin is the honest
    // answer there, because that is what the firmware was compiled against. A file whose bus contradicts its
    // own SCK keeps the bus it states -- `validateWiring` reports the contradiction and the user decides.
    const sclk = count('sclk', base.sclk);
    const derived = spiIndexOf(sclk) ?? base.bus;
    const bus: 0 | 1 =
        source.bus === 0 || source.bus === 1
            ? source.bus
            : derived;
    if (source.bus !== undefined && source.bus !== 0 && source.bus !== 1) {
        notes.push(`"bus" was not SPI0 or SPI1; using SPI${derived}`);
    }

    // A file written before the low group existed says nothing about it; the clock pin is the honest answer,
    // because that is the group the firmware was compiled against. SPI0-Alt is only a choice on SPI0.
    const lowClock = SPI_ALT_BLOCKS[bus]?.sclk;
    const alt: boolean =
        typeof source.alt === 'boolean'
            ? bus === 0 && source.alt
            : bus === 0 && lowClock !== undefined && sclk === lowClock;
    if (source.alt !== undefined && typeof source.alt !== 'boolean') {
        notes.push(`"alt" was not true or false; using ${alt}`);
    }

    return {
        wiring: {
            panel: base.panel,
            bus,
            alt,
            sclk,
            mosi: count('mosi', base.mosi),
            miso: optional('miso', base.miso),
            cs: count('cs', base.cs),
            dc: count('dc', base.dc),
            rst: optional('rst', base.rst),
            backlight: optional('backlight', base.backlight),
            backlightActiveLow: flag('backlightActiveLow', base.backlightActiveLow),
            touchCs: optional('touchCs', base.touchCs),
            touchIrq: optional('touchIrq', base.touchIrq),
            sdSclk: optional('sdSclk', base.sdSclk),
            sdMosi: optional('sdMosi', base.sdMosi),
            sdMiso: optional('sdMiso', base.sdMiso),
            sdCs: optional('sdCs', base.sdCs),
            timeSource,
        },
        notes,
    };
}

/**
 * The hardware file's text, in a fixed key order.
 *
 * Fixed order rather than `JSON.stringify` of whatever object arrived, so that a save produces a minimal
 * diff and a repository does not churn. Two-space indent and one trailing newline, like every other file
 * this extension writes.
 */
export function wiringFile(wiring: PanelWiring): string {
    const ordered: PanelWiring = {
        panel: wiring.panel,
        bus: wiring.bus,
        // Normalised on the way out as well as in: SPI1 has one group, so a `true` here would be a claim about
        // a block that does not exist -- and a file that reads back as what was written is worth more.
        alt: wiring.bus === 0 && wiring.alt,
        sclk: wiring.sclk,
        mosi: wiring.mosi,
        miso: wiring.miso,
        cs: wiring.cs,
        dc: wiring.dc,
        rst: wiring.rst,
        backlight: wiring.backlight,
        backlightActiveLow: wiring.backlightActiveLow,
        touchCs: wiring.touchCs,
        touchIrq: wiring.touchIrq,
        sdSclk: wiring.sdSclk,
        sdMosi: wiring.sdMosi,
        sdMiso: wiring.sdMiso,
        sdCs: wiring.sdCs,
        timeSource: wiring.timeSource,
    };
    return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * The pins a project uses, as `<GPIO>: <what>` lines for the generated README.
 *
 * The same shape the ESP side's `espPinUsage` produces, so a generated project's README reads the same on
 * both families.
 */
export function rpPinUsage(wiring: PanelWiring): string[] {
    const module = panelModuleOrDefault(wiring.panel);
    // `GPIO18 (pin 24): ...` -- the number the firmware uses first, because that is what the wiring names, and
    // the header pin in brackets because that is what a soldering iron finds. A GPIO with no header pin is
    // named on its own.
    const at = (gpio: number): string => {
        const pin = headerPin(gpio);
        return pin === null ? `GPIO${gpio}` : `GPIO${gpio} (pin ${pin})`;
    };
    const lines = [
        `${at(wiring.sclk)}: panel SPI clock (SPI${spiIndexOf(wiring.sclk) ?? '?'})`,
        `${at(wiring.mosi)}: panel SPI data out`,
    ];
    if (wiring.miso !== null) {
        lines.push(`${at(wiring.miso)}: panel SPI data in`);
    }
    lines.push(`${at(wiring.cs)}: panel chip select (${module.label})`);
    lines.push(`${at(wiring.dc)}: panel data/command`);
    if (wiring.rst !== null) {
        lines.push(`${at(wiring.rst)}: panel reset`);
    }
    if (wiring.backlight !== null) {
        lines.push(
            `${at(wiring.backlight)}: panel backlight ` +
            `(${wiring.backlightActiveLow ? 'active low' : 'active high'}, PWM)`,
        );
    }
    if (module.touch && wiring.touchCs !== null && wiring.touchIrq !== null) {
        lines.push(`${at(wiring.touchCs)}: touch chip select (XPT2046)`);
        lines.push(`${at(wiring.touchIrq)}: touch interrupt`);
    }
    if (wiring.sdCs !== null) {
        const shared = cardSharesPanelBus(wiring);
        lines.push(`${at(wiring.sdCs)}: microSD chip select${shared ? ' (shared panel bus)' : ''}`);
        if (!shared) {
            lines.push(`${at(wiring.sdSclk as number)}: microSD clock (SPI${spiIndexOf(wiring.sdSclk as number) ?? '?'})`);
            lines.push(`${at(wiring.sdMosi as number)}: microSD data out`);
            lines.push(`${at(wiring.sdMiso as number)}: microSD data in`);
        }
    }
    return lines;
}
