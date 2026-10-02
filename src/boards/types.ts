/**
 * Board profile model.
 *
 * These types are deliberately free of any `vscode` import so that the whole
 * board matrix and the project generator stay unit-testable (tests/layers/t1-logic).
 */

export type McuFamily = 'RP2040' | 'RP2350';

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
}

export interface BoardProfile {
    /** Stable id used in settings and the project manifest. */
    id: string;
    name: string;
    vendor: string;
    family: McuFamily;
    /** Chip id understood by `probe-rs` (`probe-rs chip list`). Note RP2350 is `RP235x`. */
    probeChip: string;
    /** Rust target triple. */
    target: string;
    /** `embassy-rp` feature flags required by this silicon. */
    embassyFeatures: string[];
    /** Link arguments the generated `build.rs` must pass to the linker. */
    linkArgs: string[];
    memory: BoardMemory;
    /** On-board LED pin, as an embassy-rp peripheral name. */
    ledPin: string;
    /** Human-readable note shown in the wizard. */
    notes: string;
}
