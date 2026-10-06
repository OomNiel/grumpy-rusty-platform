import { BoardProfile, Cyw43Wiring } from './types';

/**
 * Features every board needs:
 *  - defmt            logging over RTT
 *  - unstable-pac     access to the PAC peripherals (`p.PIN_25`, ...)
 *  - time-driver      embassy-time backed by the RP timer
 *  - critical-section-impl
 *  - executor-thread / executor-interrupt  executor integration
 */
const COMMON_EMBASSY_FEATURES = [
    'defmt',
    'unstable-pac',
    'time-driver',
    'critical-section-impl',
    'executor-thread',
    'executor-interrupt',
];

/** Bumped together with `PROBE_RS_VERSION`; see NOTES.md before changing. */
export const BOARD_CATALOG_VERSION = 2;

export const BOARDS: BoardProfile[] = [
    {
        kind: 'rp',
        id: 'pico',
        name: 'Raspberry Pi Pico',
        vendor: 'Raspberry Pi',
        family: 'RP2040',
        probeChip: 'RP2040',
        target: 'thumbv6m-none-eabi',
        embassyFeatures: [...COMMON_EMBASSY_FEATURES, 'rp2040'],
        linkArgs: ['--nmagic', '-Tlink.x', '-Tlink-rp.x', '-Tdefmt.x'],
        memory: {
            boot2: true,
            bootInfoSections: false,
            // 2 MB of flash: 1.5 MB for the application and 512 KB at the end as
            // "drive space". Wireless builds are fat — the CYW43 Wi-Fi firmware alone
            // is 231 KB — so 1.5 MB is deliberately the larger half.
            flash: { origin: '0x10000100', length: '1536K - 0x100' },
            ram: { origin: '0x20000000', length: '264K' },
            flashReserve: { name: 'FS', region: { origin: '0x10180000', length: '512K' } },
            extraRam: [],
        },
        led: { kind: 'gpio', pin: 'PIN_25' },
        wireless: 'none',
        options: [],
        notes: 'Dual Cortex-M0+ @ 133 MHz, 264 KB RAM, 2 MB flash.',
    },
    {
        kind: 'rp',
        id: 'pico2',
        name: 'Raspberry Pi Pico 2',
        vendor: 'Raspberry Pi',
        family: 'RP2350',
        probeChip: 'RP235x',
        target: 'thumbv8m.main-none-eabihf',
        embassyFeatures: [...COMMON_EMBASSY_FEATURES, 'rp235xa', 'binary-info'],
        // RP2350 has no second-stage bootloader, so `link-rp.x` must NOT be linked in.
        // `binary-info` supplies the image definition the boot ROM requires.
        linkArgs: ['--nmagic', '-Tlink.x', '-Tdefmt.x'],
        memory: {
            boot2: false,
            bootInfoSections: true,
            // 4 MB of flash on a Pico 2: 3 MB for the application and 1 MB left at the
            // end as "drive space" for a future filesystem. See NOTES.md.
            flash: { origin: '0x10000000', length: '3072K' },
            ram: { origin: '0x20000000', length: '512K' },
            flashReserve: { name: 'FS', region: { origin: '0x10300000', length: '1024K' } },
            extraRam: [
                { name: 'SRAM8', region: { origin: '0x20080000', length: '4K' } },
                { name: 'SRAM9', region: { origin: '0x20081000', length: '4K' } },
            ],
        },
        led: { kind: 'gpio', pin: 'PIN_25' },
        wireless: 'none',
        options: [],
        notes: 'Dual Cortex-M33 @ 150 MHz (RISC-V deferred), 520 KB SRAM, 4 MB flash — 3 MB app + 1 MB drive.',
    },
    {
        kind: 'rp',
        id: 'picow',
        name: 'Raspberry Pi Pico W',
        vendor: 'Raspberry Pi',
        family: 'RP2040',
        probeChip: 'RP2040',
        target: 'thumbv6m-none-eabi',
        embassyFeatures: [...COMMON_EMBASSY_FEATURES, 'rp2040'],
        linkArgs: ['--nmagic', '-Tlink.x', '-Tlink-rp.x', '-Tdefmt.x'],
        memory: {
            boot2: true,
            bootInfoSections: false,
            // Same split as the plain Pico: 1.5 MB application + 512 KB drive.
            flash: { origin: '0x10000100', length: '1536K - 0x100' },
            ram: { origin: '0x20000000', length: '264K' },
            flashReserve: { name: 'FS', region: { origin: '0x10180000', length: '512K' } },
            extraRam: [],
        },
        led: { kind: 'cyw43', index: 0 },
        wireless: 'cyw43',
        cyw43: cyw43Wiring('DEFAULT_CLOCK_DIVIDER'),
        options: [],
        notes: 'RP2040 + CYW43439 Wi-Fi & Bluetooth. The on-board LED hangs off the wireless chip.',
    },
    {
        kind: 'rp',
        id: 'pico2w',
        name: 'Raspberry Pi Pico 2 W',
        vendor: 'Raspberry Pi',
        family: 'RP2350',
        probeChip: 'RP235x',
        target: 'thumbv8m.main-none-eabihf',
        embassyFeatures: [...COMMON_EMBASSY_FEATURES, 'rp235xa', 'binary-info'],
        linkArgs: ['--nmagic', '-Tlink.x', '-Tdefmt.x'],
        memory: {
            boot2: false,
            bootInfoSections: true,
            // Same split as the plain Pico 2: 3 MB application + 1 MB drive.
            flash: { origin: '0x10000000', length: '3072K' },
            ram: { origin: '0x20000000', length: '512K' },
            flashReserve: { name: 'FS', region: { origin: '0x10300000', length: '1024K' } },
            extraRam: [
                { name: 'SRAM8', region: { origin: '0x20080000', length: '4K' } },
                { name: 'SRAM9', region: { origin: '0x20081000', length: '4K' } },
            ],
        },
        led: { kind: 'cyw43', index: 0 },
        wireless: 'cyw43',
        // RP2350 needs a larger divider: the PIO SPI is too fast otherwise.
        cyw43: cyw43Wiring('RM2_CLOCK_DIVIDER'),
        options: [],
        notes: 'RP2350 + CYW43439 Wi-Fi & Bluetooth. LED via the wireless chip, not GPIO25.',
    },

    // ------------------------------------------------------------------ Espressif
    //
    // Everything below is flashed over USB serial with `espflash`: no probe-rs, no
    // BOOTSEL, no UF2. The pin numbers are plain ESP32 GPIO numbers and were taken
    // from primary sources rather than from memory -- see NOTES.md for which one.
    {
        kind: 'esp',
        id: 'esp32-devkitc',
        options: [],
        name: 'Espressif ESP32-DevKitC V4',
        vendor: 'Espressif',
        family: 'ESP32',
        target: 'xtensa-esp32-none-elf',
        espChip: 'esp32',
        flashSize: '4 MB',
        psram: false,
        // Espressif's own user guide lists a 5 V power LED and no user LED, so this is an
        // offer and not a claim: `external` makes the generator say "wire an LED here"
        // instead of pretending the board has one. GPIO4 is free of strapping duty --
        // GPIO0/2/5/12/15 all influence how the chip boots, so none of those is offered.
        led: { kind: 'gpio', pin: '4', external: true },
        displays: [],
        notes: 'ESP32-WROOM-32 with a USB-UART bridge (CP2102). No user LED. Wire one to GPIO4, or follow the serial log.',
    },
    {
        kind: 'esp',
        id: 'lilygo-tqt',
        options: [
            {
                id: 'panel',
                label: 'Display panel revision',
                prompt: 'Which T-QT panel does this board have?',
                choices: [
                    {
                        id: 'gc9107',
                        label: 'Older panel (GC9107, 27 MHz)',
                        description:
                            "LilyGo's first revision. Its init table is the \"old panel\" one in LilyGo's own repository.",
                    },
                    {
                        id: 'gc9a01',
                        label: 'Newer panel (GC9A01, 40 MHz)',
                        description: 'The current revision, driven by a stock GC9A01 sequence.',
                    },
                ],
                default: 'gc9107',
            },
        ],
        name: 'LilyGo T-QT (ESP32-S3)',
        vendor: 'LilyGo',
        family: 'ESP32S3',
        target: 'xtensa-esp32s3-none-elf',
        espChip: 'esp32s3',
        flashSize: '4 MB',
        psram: false,
        // The T-QT has no user LED: the only LED on the board belongs to the charger.
        led: { kind: 'none' },
        displays: [
            {
                controller: 'GC9107',
                label: '0.85" GC9107 128x128',
                width: 128,
                height: 128,
                cs: 5,
                dc: 6,
                rst: 1,
                backlight: 10,
                // LilyGo's setup defines TFT_BACKLIGHT_ON 0: the backlight transistor is
                // switched on by driving the pin low.
                backlightActiveLow: true,
                spi: { sclk: 3, mosi: 2 },
                colorOrder: 'rgb',
                mirrorX: false,
                mirrorY: false,
                spiHz: 27_000_000,
                panelChoice: 'gc9107',
            },
            {
                controller: 'GC9A01',
                label: '0.85" GC9A01 128x128',
                width: 128,
                height: 128,
                cs: 5,
                dc: 6,
                rst: 1,
                backlight: 10,
                backlightActiveLow: true,
                spi: { sclk: 3, mosi: 2 },
                colorOrder: 'rgb',
                mirrorX: false,
                mirrorY: false,
                // LilyGo's setup runs the newer panel at 40 MHz; the older one at 27 MHz.
                spiHz: 40_000_000,
                panelChoice: 'gc9a01',
            },
        ],
        notes: 'ESP32-S3 with a 0.85" 128x128 panel and 4 MB flash. LilyGo shipped two panel revisions under one name, so the wizard asks which one you have.',
    },
    {
        kind: 'esp',
        id: 'sunton-3248s035r',
        options: [],
        name: 'Sunton ESP32-3248S035R (3.5" CYD)',
        vendor: 'Sunton',
        family: 'ESP32',
        target: 'xtensa-esp32-none-elf',
        espChip: 'esp32',
        flashSize: '4 MB',
        psram: false,
        led: { kind: 'none' },
        displays: [
            {
                controller: 'ST7796',
                label: '3.5" ST7796 320x480',
                width: 320,
                height: 480,
                cs: 15,
                dc: 2,
                // No reset pin: the schematic ties the panel reset to the board reset, and
                // the community board definition spells that as GPIO_NUM_NC.
                backlight: 27,
                backlightActiveLow: false,
                spi: { sclk: 14, mosi: 13, miso: 12 },
                // The panel is wired for BGR and its X axis is mirrored relative to the
                // controller's default, both of which the board definition states outright.
                colorOrder: 'bgr',
                mirrorX: true,
                mirrorY: false,
                spiHz: 24_000_000,
            },
        ],
        // Traced from the board to the module by hand (2026-10-05) after the published pinout turned out
        // to be wrong for this unit: the community definition and two independent R-variant
        // configurations all say CS 33 / IRQ 36, but on this board the chip select goes to GPIO25 and
        // PENIRQ to GPIO39. With CS 33 the controller was never selected and every read came back from a
        // floating MISO line -- stable mid-scale values that never moved for a touch (NOTES 57).
        touch: { controller: 'XPT2046', cs: 25, irq: 39, spiHz: 2_000_000 },
        // Only three TF nets exist on the schematic (CS/CLK/MOSI) and the card shares the
        // panel's MISO, which is what the board definition implies as well.
        sd: { cs: 5, spi: { sclk: 18, mosi: 19, miso: 12 } },
        notes: 'ESP32-WROOM with a 3.5" 320x480 ST7796 panel, resistive touch and a microSD socket. The backlight pin drives a transistor and is active high.',
    },
];

/** Pico W and Pico 2 W share the same CYW43 wiring; only the clock divider differs. */
function cyw43Wiring(clockDivider: string): Cyw43Wiring {
    return {
        pwrPin: 'PIN_23',
        csPin: 'PIN_25',
        dioPin: 'PIN_24',
        clkPin: 'PIN_29',
        pio: 'PIO0',
        dmaCh0: 'DMA_CH0',
        dmaCh1: 'DMA_CH1',
        clockDivider,
    };
}

export function boardById(id: string | undefined): BoardProfile | undefined {
    return id === undefined ? undefined : BOARDS.find((b) => b.id === id);
}

/** Every target triple any supported board can need. */
export function allTargets(): string[] {
    return [...new Set(BOARDS.map((b) => b.target))].sort();
}

/**
 * Every RP target triple.
 *
 * Worth separating from `allTargets`: these are the ones `rustup target add` can install. The
 * Xtensa triples are not rustup targets at all -- they only exist in Espressif's fork of rustc,
 * which espup installs -- so a plan that lumps them together asks rustup to do the impossible.
 */
export function rpTargets(): string[] {
    return [...new Set(BOARDS.filter((b) => b.kind === 'rp').map((b) => b.target))].sort();
}

/**
 * Can `rustup target add` install this triple at all?
 *
 * Xtensa is the one family it cannot: those triples exist only in Espressif's fork of rustc, which `espup`
 * installs as a separate toolchain. Asking stable rustup for one produces
 *
 *     error: toolchain 'stable-x86_64-unknown-linux-gnu' has no prebuilt artifacts available for target
 *     'xtensa-esp32-none-elf'
 *
 * — the exact failure reported on 2026-10-05, from a setup plan that lumped the two families together. The
 * comment above `rpTargets` warned about this; the planners had not been told.
 */
export function isRustupTarget(triple: string): boolean {
    return !/^xtensa-/.test(String(triple ?? '').trim());
}

/** Every Espressif target triple (installed with the espup toolchain, never with rustup). */
export function espTargets(): string[] {
    return [...new Set(BOARDS.filter((b) => b.kind === 'esp').map((b) => b.target))].sort();
}
