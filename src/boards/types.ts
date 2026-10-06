/**
 * Board profile model.
 *
 * These types are deliberately free of any `vscode` import so that the whole
 * board matrix and the project generator stay unit-testable (tests/layers/t1-logic).
 */

/** Raspberry Pi silicon, programmed through a debug probe (SWD) or UF2 over USB. */
export type RpFamily = 'RP2040' | 'RP2350';

/**
 * Espressif silicon, programmed over USB serial with `espflash`.
 *
 * These chips are a different world from the RP ones: no probe-rs, no UF2, no
 * `memory.x` (the ESP-IDF bootloader owns the layout) and no CYW43. Keep every
 * RP-only field out of `EspBoardProfile` so the compiler, rather than a comment,
 * is what stops a Pico assumption leaking into an ESP project.
 */
export type EspFamily = 'ESP32' | 'ESP32S3';

export type McuFamily = RpFamily | EspFamily;

export function isRpFamily(family: McuFamily): family is RpFamily {
    return family === 'RP2040' || family === 'RP2350';
}

export function isEspFamily(family: McuFamily): family is EspFamily {
    return family === 'ESP32' || family === 'ESP32S3';
}

/** A linker MEMORY region. Kept as strings so it can be emitted verbatim into `memory.x`. */
export interface MemoryRegion {
    origin: string;
    length: string;
}

export interface BoardMemory {
    /** RP2040 boots through a 256-byte second-stage bootloader at the start of flash. */
    boot2: boolean;
    /** RP2350 needs `.start_block` / `.boot_info` / `.bi_entries` sections for the boot ROM. */
    bootInfoSections: boolean;
    flash: MemoryRegion;
    ram: MemoryRegion;
    /** RP2350 direct-mapped SRAM banks (no striping) — optional convenience regions. */
    extraRam: Array<{ name: string; region: MemoryRegion }>;
    /**
     * Flash kept out of the application region and exposed as its own MEMORY
     * region — the "drive space" for a future filesystem (littlefs/
     * embedded-storage). Nothing links into it yet; it records the reservation so
     * the application region cannot silently grow into it.
     */
    flashReserve?: { name: string; region: MemoryRegion };
}

/**
 * How the on-board LED is reached. On the W boards it hangs off the CYW43
 * wireless chip rather than a GPIO pin, so a plain `PIN_25` blink would be wrong.
 *
 * `external` marks a pin that is only an *offered* place to wire your own LED: the
 * ESP32-DevKitC V4 has no user LED at all (Espressif's own user guide lists a 5 V
 * power LED and nothing else), so claiming a built-in one would be a lie.
 */
export type BoardLed =
    | { kind: 'gpio'; pin: string; external?: boolean }
    | { kind: 'cyw43'; index: number }
    /**
     * A three-pin LED. Common cathode or common anode is not modelled: the pins are driven active high,
     * which is what the boards seen so far do.
     */
    | { kind: 'rgb'; red: string; green: string; blue: string }
    | { kind: 'none' };

/** Which wireless silicon, if any, the board carries. */
export type WirelessChip = 'none' | 'cyw43';

/** CYW43 SPI wiring, as peripheral names on the RP chip. */
export interface Cyw43Wiring {
    pwrPin: string;
    csPin: string;
    dioPin: string;
    clkPin: string;
    pio: string;
    dmaCh0: string;
    dmaCh1: string;
    /** PIO SPI clock divider constant from `cyw43-pio` (RP2040 and RP2350 differ). */
    clockDivider: string;
}

export interface BoardOptionChoice {
    id: string;
    label: string;
    description: string;
}

/**
 * A question the wizard has to ask because the hardware exists in more than one
 * revision. The LilyGo T-QT is what forced this: two 128x128 panels shipped under
 * the same name with different init sequences, and the only marking is a sticker
 * that may already be gone. An option is a first-class part of the board record so
 * the generator, the manifest and the README all agree on which one was chosen.
 */
export interface BoardOption {
    /** Referenced from `EspDisplay.panelChoice` for panel revisions. */
    id: string;
    label: string;
    prompt: string;
    choices: BoardOptionChoice[];
    /** id of the choice the wizard preselects. */
    default: string;
}

/** An SPI bus, as ESP32 GPIO numbers. */
export interface EspSpiBus {
    sclk: number;
    mosi: number;
    /** Absent when the board does not route MISO to the peripheral. */
    miso?: number;
}

/**
 * A panel that is soldered to the board.
 *
 * `controller` names a mipidsi model and was checked against mipidsi 0.10, which
 * ships `GC9107`, `GC9A01` and `ST7796` -- every panel used here is stock, so no
 * hand-written init sequence is needed.
 */
export interface EspDisplay {
    controller: 'GC9107' | 'GC9A01' | 'ST7796';
    /** The name printed on the panel, for logs and the README. */
    label: string;
    width: number;
    height: number;
    cs: number;
    dc: number;
    /** Absent when the panel reset is tied to the board reset. */
    rst?: number;
    backlight: number;
    backlightActiveLow: boolean;
    spi: EspSpiBus;
    colorOrder: 'rgb' | 'bgr';
    mirrorX: boolean;
    mirrorY: boolean;
    /** Panel clock in Hz. Lower it first if the image is unstable. */
    spiHz: number;
    /** `BoardOption` choice this panel belongs to, when the board has revisions. */
    panelChoice?: string;
}

/**
 * An on-board light sensor.
 *
 * Its own type rather than a bare pin because an LDR is a divider into an ADC, and the *pin* is what decides
 * which ADC channel and whether it can be read at all -- GPIO34-39 on an ESP32 are input-only with no
 * internal pull-ups, which is exactly right for a divider and useless for a digital input.
 */
export interface EspLdr {
    pin: string;
    /** One line for the generated README, e.g. what it is wired against. */
    note?: string;
}

/** Resistive touch controller sharing the panel's SPI bus. */
export interface EspTouch {
    controller: 'XPT2046';
    cs: number;
    irq: number;
    spiHz: number;
}

/** A microSD socket on the board. */
export interface EspSdCard {
    cs: number;
    spi: EspSpiBus;
}

export interface BoardProfileBase {
    /** Stable id used in settings and the project manifest. */
    id: string;
    name: string;
    vendor: string;
    family: McuFamily;
    /** Rust target triple. */
    target: string;
    /** The on-board LED, an offered pin for an external one, or nothing at all. */
    led: BoardLed;
    /** Questions the wizard must ask; empty for boards with a single revision. */
    options: BoardOption[];
    /** Human-readable note shown in the wizard. */
    notes: string;
}

/** A Raspberry Pi board: embassy-rp, memory.x, probe-rs (or BOOTSEL/UF2 over USB). */
export interface RpBoardProfile extends BoardProfileBase {
    kind: 'rp';
    family: RpFamily;
    /** Chip id understood by `probe-rs` (`probe-rs chip list`). Note RP2350 is `RP235x`. */
    probeChip: string;
    /** `embassy-rp` feature flags required by this silicon. */
    embassyFeatures: string[];
    /** Link arguments the generated `build.rs` must pass to the linker. */
    linkArgs: string[];
    memory: BoardMemory;
    /** Wireless silicon, or `none` for the plain boards. */
    wireless: WirelessChip;
    /** CYW43 wiring — present exactly when `wireless === 'cyw43'`. */
    cyw43?: Cyw43Wiring;
}

/**
 * An Espressif board: esp-hal + esp-rtos, flashed over USB serial with `espflash`.
 *
 * Deliberately has no `memory`, `probeChip`, `linkArgs` or `cyw43`: an ESP build has
 * none of those, and the union makes it a type error to reach for them.
 */
export interface EspBoardProfile extends BoardProfileBase {
    kind: 'esp';
    family: EspFamily;
    /** Chip name for `espflash --chip` and the esp-hal feature (`esp32`, `esp32s3`). */
    espChip: string;
    /** Flash size of the module, as printed on it. */
    flashSize: string;
    /**
     * True when the module carries PSRAM. It stays a cargo feature that is *off* by
     * default, because driving PSRAM wrongly faults at boot and the difference is
     * not visible from outside the board.
     */
    psram: boolean;
    /** Panels soldered to the board; empty for boards without one. */
    displays: EspDisplay[];
    touch?: EspTouch;
    sd?: EspSdCard;
    /** On-board light sensor, when the board has one. */
    ldr?: EspLdr;
}

export type BoardProfile = RpBoardProfile | EspBoardProfile;

export function isRpBoard(board: BoardProfile): board is RpBoardProfile {
    return board.kind === 'rp';
}

export function isEspBoard(board: BoardProfile): board is EspBoardProfile {
    return board.kind === 'esp';
}

/**
 * The chip id the flashing tool should be told, if this board has one.
 *
 * RP boards hand it to probe-rs, ESP boards to espflash. One accessor keeps the union
 * check in a single place rather than repeating it at every call site.
 */
export function chipNameOf(board: BoardProfile): string | undefined {
    return board.kind === 'rp' ? board.probeChip : board.espChip;
}
