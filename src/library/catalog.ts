/**
 * Bundled library catalog for the crates.io Library Manager (Phase 3).
 *
 * Every entry here was read off the crates.io sparse index and the crates.io HTTP API,
 * not recalled — versions are the latest unyanked release at the time of writing and
 * every feature name is one the registry actually advertises for that version.
 *
 * Two verified facts shape this file (see NOTES.md and library/registry.ts):
 *
 * 1. The sparse index splits a crate's features across `features` and `features2`, so a
 *    reader that looks at only one of them misses modern `dep:`-style features such as
 *    `embassy-rp`'s `time-driver` and `executor-thread`.
 * 2. The index lists only the manifest's `[features]` table. A feature that exists
 *    implicitly, because the crate has an *optional dependency* of that name, does not
 *    appear at all — `portable-atomic`'s `critical-section` and `serde` are the proof
 *    (`cargo metadata` reports both; the index reports neither). Those are listed in
 *    `implicitFeatures` so the picker can still offer them, and so a test can guard the
 *    distinction.
 *
 * Nothing here is a version range: the string is written verbatim into `Cargo.toml`,
 * where a bare `"1.1.1"` is the usual caret requirement.
 */

export type LibraryCategory = 'runtime' | 'hal' | 'storage' | 'display' | 'led' | 'wireless' | 'util';

export interface CategoryInfo {
    id: LibraryCategory;
    label: string;
}

export interface CatalogFeature {
    name: string;
    /** Why you would tick it. Shown in the picker's detail line. */
    note?: string;
}

export interface CatalogEntry {
    name: string;
    /** Latest unyanked version on crates.io when this file was written. */
    version: string;
    category: LibraryCategory;
    /** The crate's own one-line description, trimmed of the registry's padding. */
    summary: string;
    /** Features offered in the picker. Every name is advertised by the registry. */
    features: CatalogFeature[];
    /** Pre-ticked in the picker — the set that is useful on a Pico. */
    recommended: string[];
    /** Features that exist through an optional dependency rather than `[features]`. */
    implicitFeatures?: string[];
    /** A warning worth reading before adding this crate. */
    note?: string;
}

/** Bumped when the catalog's shape changes; the wizard-free version of BOARD_CATALOG_VERSION. */
export const CATALOG_VERSION = 1;

export const CATEGORIES: CategoryInfo[] = [
    { id: 'runtime', label: 'Embassy runtime & logging' },
    { id: 'hal', label: 'HAL & I/O traits' },
    { id: 'wireless', label: 'Wireless & USB' },
    { id: 'storage', label: 'Storage' },
    { id: 'display', label: 'Display & graphics' },
    { id: 'led', label: 'LEDs & PIO' },
    { id: 'util', label: 'Utilities' },
];

/**
 * The curated set. Ordered by category, then roughly by how likely it is to be wanted.
 */
export const LIBRARY_CATALOG: CatalogEntry[] = [
    // ------------------------------------------------------------- runtime
    {
        name: 'embassy-executor',
        version: '0.10.0',
        category: 'runtime',
        summary: 'async/await executor designed for embedded usage',
        features: [
            { name: 'defmt', note: 'log through defmt' },
            { name: 'log' },
            { name: 'scheduler-deadline', note: 'deadline-based scheduling' },
            { name: 'turbowakers', note: 'faster wake path, more code size' },
        ],
        recommended: ['defmt'],
        note:
            'Do not add platform-cortex-m / executor-thread / executor-interrupt here: embassy-rp ' +
            'already supplies them, and enabling both defines __pender twice and fails to link ' +
            '(NOTES.md 2.1). The wizard writes the correct wiring.',
    },
    {
        name: 'embassy-time',
        version: '0.5.1',
        category: 'runtime',
        summary: 'Instant and Duration for embedded no-std systems, with async timer support',
        features: [
            { name: 'defmt' },
            { name: 'log' },
            { name: 'mock-driver', note: 'test builds without hardware' },
        ],
        recommended: ['defmt'],
        note: 'The tick rate comes from embassy-rp\'s time-driver feature, not from here.',
    },
    {
        name: 'embassy-sync',
        version: '0.8.0',
        category: 'runtime',
        summary: 'no-std, no-alloc synchronization primitives with async support',
        features: [{ name: 'defmt' }, { name: 'log' }, { name: 'turbowakers' }],
        recommended: ['defmt'],
    },
    {
        name: 'embassy-futures',
        version: '0.1.2',
        category: 'runtime',
        summary: 'no-std, no-alloc utilities for working with futures',
        features: [],
        recommended: [],
    },
    {
        name: 'embassy-embedded-hal',
        version: '0.6.0',
        category: 'runtime',
        summary: 'Utilities to use embedded-hal and embedded-storage traits with Embassy',
        features: [
            { name: 'defmt' },
            { name: 'time', note: 'timeouts via embassy-time' },
        ],
        recommended: ['defmt', 'time'],
    },
    {
        name: 'defmt',
        version: '1.1.1',
        category: 'runtime',
        summary: 'A highly efficient logging framework for resource-constrained devices',
        features: [
            { name: 'alloc' },
            { name: 'encoding-raw', note: 'skip RLE compression; faster, bigger' },
            { name: 'encoding-rzcobs' },
            { name: 'ip_in_core' },
        ],
        recommended: [],
        note: 'Generated projects already depend on this; adding it again updates the pin.',
    },
    {
        name: 'defmt-rtt',
        version: '1.3.0',
        category: 'runtime',
        summary: 'Transmit defmt log messages over the RTT (Real-Time Transfer) protocol',
        features: [
            { name: 'disable-blocking-mode', note: 'drop instead of waiting for the host' },
            { name: 'drop-on-contention' },
        ],
        recommended: [],
        note: 'Needs a debug probe to read the log; the USB flash route has no RTT.',
    },
    {
        name: 'panic-probe',
        version: '1.0.0',
        category: 'runtime',
        summary: 'Panic handler that exits the debug session with an error code',
        features: [
            { name: 'print-defmt', note: 'the panic message goes out over defmt' },
            { name: 'print-rtt' },
            { name: 'defmt-error' },
        ],
        recommended: ['print-defmt'],
    },
    {
        name: 'panic-halt',
        version: '1.0.0',
        category: 'runtime',
        summary: 'Set panicking behavior to halt',
        features: [],
        recommended: [],
        note: 'Silent on panic — useful when there is no probe attached.',
    },
    {
        name: 'static_cell',
        version: '2.1.1',
        category: 'runtime',
        summary: 'Statically allocated, initialized at runtime cell',
        features: [{ name: 'nightly' }],
        recommended: [],
    },
    {
        name: 'portable-atomic',
        version: '1.15.0',
        category: 'runtime',
        summary: 'Portable atomic types, including a CAS fallback for cores that have none',
        features: [
            { name: 'critical-section', note: 'implicit optional-dependency feature; the one thumbv6m needs' },
            { name: 'serde', note: 'implicit optional-dependency feature' },
            { name: 'fallback', note: 'on by default' },
            { name: 'force-amo' },
            { name: 'require-cas' },
            { name: 'unsafe-assume-single-core' },
        ],
        recommended: ['critical-section'],
        implicitFeatures: ['critical-section', 'serde'],
        note:
            'Mandatory on the Cortex-M0+ (Pico / Pico W), which has no atomic compare-exchange. ' +
            'critical-section and serde come from optional dependencies, so they are absent from ' +
            'the sparse index yet perfectly valid in Cargo.toml (verified with cargo metadata).',
    },
    {
        name: 'critical-section',
        version: '1.2.0',
        category: 'runtime',
        summary: 'Cross-platform critical section',
        features: [
            { name: 'restore-state-u8', note: 'what embassy-rp\'s implementation uses' },
            { name: 'restore-state-bool' },
            { name: 'restore-state-none' },
        ],
        recommended: [],
        note: 'embassy-rp supplies the implementation through its critical-section-impl feature.',
    },
    {
        name: 'cortex-m',
        version: '0.7.9',
        category: 'runtime',
        summary: 'Low level access to Cortex-M processors',
        features: [
            { name: 'inline-asm' },
            { name: 'critical-section-single-core' },
            { name: 'cm7', note: 'Cortex-M7 specifics; not the RP chips' },
            { name: 'linker-plugin-lto' },
        ],
        recommended: ['inline-asm'],
    },
    {
        name: 'cortex-m-rt',
        version: '0.7.7',
        category: 'runtime',
        summary: 'Minimal runtime / startup for Cortex-M microcontrollers',
        features: [
            { name: 'device', note: 'interrupt vectors from a PAC' },
            { name: 'set-vtor' },
            { name: 'paint-stack', note: 'fill the stack with a pattern to measure usage' },
            { name: 'zero-init-ram' },
        ],
        recommended: [],
    },

    // ----------------------------------------------------------------- hal
    {
        name: 'embassy-rp',
        version: '0.10.0',
        category: 'hal',
        summary: 'Embassy HAL for the Raspberry Pi RP2040 or RP235x microcontroller',
        features: [
            { name: 'defmt' },
            { name: 'time-driver', note: 'embassy-time backed by the RP timer' },
            { name: 'unstable-pac' },
            { name: 'critical-section-impl' },
            { name: 'executor-thread', note: 'supplies __pender; enable on embassy-rp, never both crates' },
            { name: 'executor-interrupt' },
            { name: 'binary-info', note: 'required on RP2350 (needs rp235xa too)' },
            { name: 'rp2040', note: 'Pico / Pico W silicon' },
            { name: 'rp235xa', note: 'Pico 2 / Pico 2 W silicon' },
            { name: 'run-from-ram' },
            { name: 'rom-func-cache' },
            { name: 'qspi-as-gpio' },
        ],
        recommended: [],
        note:
            'The chip feature must match the board (rp2040, or rp235xa plus binary-info). The ' +
            'project wizard already writes the full set, so this entry is mainly for projects ' +
            'that lost it.',
    },
    {
        name: 'embedded-hal',
        version: '1.0.0',
        category: 'hal',
        summary: 'A Hardware Abstraction Layer (HAL) for embedded systems',
        features: [{ name: 'defmt-03', note: 'defmt::Format on HAL errors' }],
        recommended: [],
    },
    {
        name: 'embedded-hal-async',
        version: '1.0.0',
        category: 'hal',
        summary: 'An asynchronous Hardware Abstraction Layer (HAL) for embedded systems',
        features: [{ name: 'defmt-03' }],
        recommended: [],
    },
    {
        name: 'embedded-hal-nb',
        version: '1.0.0',
        category: 'hal',
        summary: 'Non-blocking HAL traits built on the nb crate',
        features: [],
        recommended: [],
    },
    {
        name: 'embedded-io',
        version: '0.7.1',
        category: 'hal',
        summary: 'Embedded IO traits',
        features: [{ name: 'defmt' }, { name: 'alloc' }, { name: 'std' }],
        recommended: [],
    },
    {
        name: 'embedded-io-async',
        version: '0.7.0',
        category: 'hal',
        summary: 'Async embedded IO traits',
        features: [{ name: 'defmt' }, { name: 'alloc' }, { name: 'std' }],
        recommended: [],
    },

    // ------------------------------------------------------------ wireless
    {
        name: 'cyw43',
        version: '0.7.0',
        category: 'wireless',
        summary: 'Rust driver for the CYW43439 Wi-Fi chip, used in the Raspberry Pi Pico W',
        features: [
            { name: 'defmt' },
            { name: 'bluetooth', note: 'turn on the Bluetooth side of the chip' },
            { name: 'firmware-logs', note: 'very chatty chip firmware output' },
            { name: 'log' },
        ],
        recommended: ['defmt'],
        note:
            'W boards only. The firmware blobs in ./firmware must be linked in with aligned_bytes!, ' +
            'and the chip needs the PIO wiring plus cyw43-pio (see the generated wifi template).',
    },
    {
        name: 'cyw43-pio',
        version: '0.10.0',
        category: 'wireless',
        summary: 'RP2040 PIO SPI implementation for cyw43',
        features: [{ name: 'defmt' }],
        recommended: ['defmt'],
    },
    {
        name: 'embassy-net',
        version: '0.9.1',
        category: 'wireless',
        summary: 'Async TCP/IP network stack for embedded systems',
        features: [
            { name: 'defmt' },
            { name: 'dhcpv4', note: 'ask the router for an address' },
            { name: 'dhcpv4-hostname' },
            { name: 'medium-ethernet', note: 'required by the cyw43 driver' },
            { name: 'medium-ip' },
            { name: 'proto-ipv4' },
            { name: 'proto-ipv6' },
            { name: 'tcp' },
            { name: 'udp' },
            { name: 'dns' },
            { name: 'mdns' },
            { name: 'icmp' },
            { name: 'multicast' },
            { name: 'raw' },
            { name: 'alloc', note: 'needs a global allocator; off by default' },
        ],
        recommended: ['defmt', 'dhcpv4', 'medium-ethernet', 'proto-ipv4'],
    },
    {
        name: 'bt-hci',
        version: '0.10.1',
        category: 'wireless',
        summary: 'Bluetooth HCI data types — the controller interface for a host stack',
        features: [
            { name: 'defmt' },
            { name: 'serde' },
            { name: 'uuid' },
        ],
        recommended: ['defmt'],
        note: 'The data types only; pair it with a host stack such as trouble-host.',
    },
    {
        name: 'trouble-host',
        version: '0.8.0',
        category: 'wireless',
        summary: 'An async Rust BLE host',
        features: [],
        recommended: [],
        note:
            'Exposes 95 features (about 30 of them are the interesting ones: gatt, peripheral, ' +
            'central, security, scan, …). None are pre-ticked on purpose: guessing a set for you ' +
            'is exactly what this project should not do.',
    },
    {
        name: 'embassy-usb',
        version: '0.6.0',
        category: 'wireless',
        summary: 'Async USB device stack for embedded devices',
        features: [
            { name: 'defmt' },
            { name: 'usbd-hid' },
            { name: 'max-handler-count-4', note: 'raise the handler slots' },
            { name: 'max-interface-count-4', note: 'raise the interface slots' },
        ],
        recommended: ['defmt'],
    },
    {
        name: 'embassy-usb-logger',
        version: '0.6.0',
        category: 'wireless',
        summary: 'log implementation for USB serial using embassy-usb',
        features: [],
        recommended: [],
    },
    {
        name: 'embassy-boot',
        version: '0.7.0',
        category: 'wireless',
        summary: 'A lightweight bootloader with power-fail-safe firmware updates',
        features: [
            { name: 'defmt' },
            { name: 'flash-erase-zero' },
            { name: 'ed25519-dalek', note: 'signed firmware' },
            { name: 'ed25519-salty' },
        ],
        recommended: ['defmt'],
        note: 'Needs a linker layout with two application slots — not the memory.x we generate.',
    },

    // ------------------------------------------------------------- storage
    {
        name: 'embedded-storage',
        version: '0.3.2',
        category: 'storage',
        summary: 'A Storage Abstraction Layer for Embedded Systems',
        features: [],
        recommended: [],
    },
    {
        name: 'embedded-storage-async',
        version: '0.4.2',
        category: 'storage',
        summary: 'Async storage abstraction traits',
        features: [],
        recommended: [],
    },
    {
        name: 'embedded-sdmmc',
        version: '0.10.0',
        category: 'storage',
        summary: 'A basic SD/MMC driver for Embedded Rust',
        features: [
            { name: 'defmt-log', note: 'log card traffic through defmt' },
            { name: 'log' },
        ],
        recommended: [],
    },
    {
        name: 'littlefs2',
        version: '0.8.1',
        category: 'storage',
        summary: 'Idiomatic Rust API for littlefs',
        features: [
            { name: 'alloc' },
            { name: 'defmt' },
            { name: 'serde' },
        ],
        recommended: ['alloc', 'defmt'],
        note: 'Pairs with the FS region we reserve at the end of flash in memory.x.',
    },

    // ------------------------------------------------------------- display
    {
        name: 'embedded-graphics',
        version: '0.8.2',
        category: 'display',
        summary: 'Embedded graphics library for small hardware displays',
        features: [
            { name: 'defmt' },
            { name: 'fixed_point', note: 'fixed-point instead of floating point' },
        ],
        recommended: ['defmt'],
    },
    {
        name: 'ssd1306',
        version: '0.10.0',
        category: 'display',
        summary: 'I2C/SPI driver for the SSD1306 OLED display controller',
        features: [
            { name: 'graphics', note: 'embedded-graphics integration' },
            { name: 'async' },
        ],
        recommended: ['graphics'],
    },
    {
        name: 'mipidsi',
        version: '0.10.0',
        category: 'display',
        summary: 'MIPI Display Command Set compatible generic driver',
        features: [{ name: 'defmt' }, { name: 'batch' }],
        recommended: [],
    },
    {
        name: 'display-interface',
        version: '0.5.0',
        category: 'display',
        summary: 'Traits for interfaces used to drive displays',
        features: [{ name: 'defmt-03' }],
        recommended: [],
    },

    // ----------------------------------------------------------------- led
    {
        name: 'smart-leds',
        version: '0.4.0',
        category: 'led',
        summary: 'A crate to use smart-leds device drivers',
        features: [{ name: 'serde' }],
        recommended: [],
    },
    {
        name: 'ws2812-pio',
        version: '0.9.0',
        category: 'led',
        summary: 'Driver for WS2812 smart LEDs using the RP2040\'s PIO peripheral',
        features: [],
        recommended: [],
        note: 'PIO-based, so it needs a free PIO block and a state machine.',
    },
    {
        name: 'pio',
        version: '0.4.0',
        category: 'led',
        summary: 'Support for the RP2040\'s PIO state machines',
        features: [],
        recommended: [],
    },
    {
        name: 'pio-proc',
        version: '0.4.0',
        category: 'led',
        summary: 'proc-macro for assembling PIO code in a Rust program at compile time',
        features: [],
        recommended: [],
        note: 'Pairs with pio: the macro turns PIO assembly into instructions.',
    },

    // ---------------------------------------------------------------- util
    {
        name: 'heapless',
        version: '0.9.3',
        category: 'util',
        summary: 'static-friendly data structures that don\'t require dynamic memory allocation',
        features: [
            { name: 'defmt' },
            { name: 'serde' },
            { name: 'ufmt' },
            { name: 'zeroize' },
            { name: 'bytes' },
            { name: 'mpmc_large', note: 'bigger multi-producer queues' },
            { name: 'portable-atomic' },
        ],
        recommended: ['defmt'],
    },
    {
        name: 'fixed',
        version: '1.31.0',
        category: 'util',
        summary: 'Fixed-point numbers',
        features: [
            { name: 'defmt' },
            { name: 'serde' },
            { name: 'num-traits' },
            { name: 'az' },
        ],
        recommended: ['defmt'],
        note: 'Needs rustc 1.93 or newer, which the generated rust-toolchain.toml (stable) provides.',
    },
    {
        name: 'fugit',
        version: '0.6.0',
        category: 'util',
        summary: 'Time library for embedded targets with ease-of-use and performance first',
        features: [{ name: 'serde' }],
        recommended: [],
    },
    {
        name: 'nb',
        version: '1.1.0',
        category: 'util',
        summary: 'Minimal non-blocking I/O layer',
        features: [{ name: 'defmt-0-3' }],
        recommended: [],
    },
    {
        name: 'micromath',
        version: '2.1.0',
        category: 'util',
        summary: 'Embedded-friendly math with fast floating point approximations',
        features: [
            { name: 'vector', note: '2D/3D vector types' },
            { name: 'statistics' },
            { name: 'quaternion' },
        ],
        recommended: [],
    },
    {
        name: 'libm',
        version: '0.2.16',
        category: 'util',
        summary: 'libm in pure Rust',
        features: [{ name: 'force-soft-floats' }],
        recommended: [],
        note: 'Useful on the Cortex-M0+, which has no floating point unit.',
    },
    {
        name: 'byte-slice-cast',
        version: '1.2.3',
        category: 'util',
        summary: 'Safely cast byte slices to and from slices of numeric types',
        features: [],
        recommended: [],
    },
    {
        name: 'hash32',
        version: '1.0.0',
        category: 'util',
        summary: '32-bit hashing algorithms',
        features: [],
        recommended: [],
    },
    {
        name: 'embedded-alloc',
        version: '0.7.0',
        category: 'util',
        summary: 'A heap allocator for embedded systems',
        features: [
            { name: 'llff', note: 'linked-list first-fit allocator' },
            { name: 'tlsf', note: 'two-level segregated fit allocator' },
            { name: 'allocator_api', note: 'nightly' },
        ],
        recommended: ['llff'],
    },
    {
        name: 'shared-bus',
        version: '0.3.1',
        category: 'util',
        summary: 'Abstraction for sharing a bus between multiple devices',
        features: [
            { name: 'cortex-m', note: 'interrupt-free locking via critical-section' },
            { name: 'eh-alpha' },
        ],
        recommended: ['cortex-m'],
    },
];

/** Look a crate up by name (exact, case-sensitive as crates.io names are lowercase). */
export function catalogEntry(name: string): CatalogEntry | undefined {
    return LIBRARY_CATALOG.find((entry) => entry.name === name);
}

/** The catalog grouped for the picker, empty categories omitted. */
export function catalogByCategory(): Array<{ category: CategoryInfo; entries: CatalogEntry[] }> {
    return CATEGORIES.map((category) => ({
        category,
        entries: LIBRARY_CATALOG.filter((entry) => entry.category === category.id),
    })).filter((group) => group.entries.length > 0);
}

export function docsUrlFor(name: string, version?: string): string {
    return version === undefined ? `https://docs.rs/${name}` : `https://docs.rs/${name}/${version}`;
}
