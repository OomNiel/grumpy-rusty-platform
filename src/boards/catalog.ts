import { BoardProfile } from './types';

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
export const BOARD_CATALOG_VERSION = 1;

export const BOARDS: BoardProfile[] = [
    {
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
            flash: { origin: '0x10000100', length: '2048K - 0x100' },
            ram: { origin: '0x20000000', length: '264K' },
            extraRam: [],
        },
        ledPin: 'PIN_25',
        notes: 'Dual Cortex-M0+ @ 133 MHz, 264 KB RAM, 2 MB flash.',
    },
    {
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
            flash: { origin: '0x10000000', length: '4096K' },
            ram: { origin: '0x20000000', length: '512K' },
            extraRam: [
                { name: 'SRAM8', region: { origin: '0x20080000', length: '4K' } },
                { name: 'SRAM9', region: { origin: '0x20081000', length: '4K' } },
            ],
        },
        ledPin: 'PIN_25',
        notes: 'Dual Cortex-M33 @ 150 MHz (RISC-V deferred), 520 KB SRAM, 4 MB flash.',
    },
];

export function boardById(id: string | undefined): BoardProfile | undefined {
    return id === undefined ? undefined : BOARDS.find((b) => b.id === id);
}

/** Every target triple any supported board can need. */
export function allTargets(): string[] {
    return [...new Set(BOARDS.map((b) => b.target))].sort();
}
