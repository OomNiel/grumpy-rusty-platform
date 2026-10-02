'use strict';

const { test, ok, equal, contains, notContains, matches, fail } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const { BOARDS, boardById } = compiled('boards/catalog');
const { generateProjectFiles } = compiled('generate/files');

const EXPECTED_PATHS = [
    'Cargo.toml',
    '.cargo/config.toml',
    'rust-toolchain.toml',
    'memory.x',
    'build.rs',
    'src/main.rs',
    '.vscode/settings.json',
    '.vscode/launch.json',
    '.gitignore',
    'README.md',
];

function filesFor(boardId, projectName = 'Test Project') {
    const files = generateProjectFiles({ board: boardById(boardId), projectName });
    const map = new Map(files.map((f) => [f.path, f.content]));
    return {
        files,
        map,
        get: (path) => map.get(path) ?? fail(`generated project has no ${path}`),
    };
}

test('every board generates the expected file list', () => {
    for (const board of BOARDS) {
        const { files } = filesFor(board.id);
        const expected =
            board.wireless === 'none' ? EXPECTED_PATHS : [...EXPECTED_PATHS, 'firmware/README.md'];
        equal(
            files.map((f) => f.path),
            expected,
            `${board.id} generated an unexpected file list`,
        );
    }
});

test('generated files are non-empty, newline-terminated and LF-only', () => {
    for (const board of BOARDS) {
        for (const file of generateProjectFiles({ board, projectName: 'Test' })) {
            ok(file.content.length > 0, `${board.id}/${file.path} is empty`);
            ok(file.content.endsWith('\n'), `${board.id}/${file.path} should end with a newline`);
            notContains(file.content, '\r', `${board.id}/${file.path} must use LF line endings`);
        }
    }
});

test('no generated file leaks an "undefined" interpolation', () => {
    for (const board of BOARDS) {
        for (const file of generateProjectFiles({ board, projectName: 'Test' })) {
            notContains(file.content, 'undefined', `${board.id}/${file.path} contains "undefined"`);
            notContains(file.content, '[object Object]', `${board.id}/${file.path} contains an object dump`);
        }
    }
});

test('Cargo.toml pins the verified embassy versions', () => {
    const cargo = filesFor('pico').get('Cargo.toml');
    contains(cargo, 'edition = "2024"');
    contains(cargo, 'embassy-rp = { version = "0.10.0"');
    contains(cargo, 'embassy-executor = { version = "0.10.0"');
    contains(cargo, 'embassy-time = { version = "0.5.1"');
    contains(cargo, 'panic-probe');
    contains(cargo, '[profile.release]');
});

test('embassy-executor is not given the cortex-m platform (duplicate __pender)', () => {
    for (const board of BOARDS) {
        const cargo = filesFor(board.id).get('Cargo.toml');
        const executorLine = /embassy-executor = \{[^}]*\}/.exec(cargo)?.[0] ?? '';
        ok(executorLine, `${board.id}: no embassy-executor dependency line`);
        notContains(executorLine, 'platform-cortex-m', 'embassy-rp already defines __pender');
        notContains(executorLine, 'executor-thread', 'embassy-rp already defines __pender');
        contains(executorLine, '"defmt"');
        contains(cargo, '"executor-thread"', 'embassy-rp still needs the executor features');
    }
});

test('Cargo.toml carries the board chip feature', () => {
    contains(filesFor('pico').get('Cargo.toml'), '"rp2040"');
    const pico2 = filesFor('pico2').get('Cargo.toml');
    contains(pico2, '"rp235xa"');
    contains(pico2, '"binary-info"');
    notContains(pico2, '"rp2040"', 'the RP2350 project must not enable the rp2040 feature');
});

test('Cargo.toml package name follows the crate name rules', () => {
    contains(filesFor('pico', 'My Pico Project').get('Cargo.toml'), 'name = "my-pico-project"');
});

test('.cargo/config.toml selects the target triple and probe-rs runner', () => {
    const pico = filesFor('pico').get('.cargo/config.toml');
    contains(pico, 'target = "thumbv6m-none-eabi"');
    contains(pico, 'runner = "probe-rs run --chip RP2040"');
    contains(pico, 'DEFMT_LOG = "debug"');

    const pico2 = filesFor('pico2').get('.cargo/config.toml');
    contains(pico2, 'target = "thumbv8m.main-none-eabihf"');
    contains(pico2, 'runner = "probe-rs run --chip RP235x"');
});

test('rust-toolchain.toml pins stable and the board target', () => {
    const toolchain = filesFor('pico2').get('rust-toolchain.toml');
    contains(toolchain, 'channel = "stable"');
    contains(toolchain, '"thumbv8m.main-none-eabihf"');
});

test('RP2040 memory.x has a boot2 region and reserved flash header', () => {
    const memory = filesFor('pico').get('memory.x');
    matches(memory, /BOOT2\s*:\s*ORIGIN = 0x10000000, LENGTH = 0x100/);
    matches(memory, /FLASH\s*:\s*ORIGIN = 0x10000100, LENGTH = 1536K - 0x100/);
    matches(memory, /RAM\s*:\s*ORIGIN = 0x20000000, LENGTH = 264K/);
    matches(memory, /FS\s*:\s*ORIGIN = 0x10180000, LENGTH = 512K/, 'the drive region must be exposed');
    notContains(memory, '.start_block', 'RP2040 does not use the RP2350 image definition');
});

test('RP2350 memory.x declares the image-definition sections and no boot2', () => {
    const memory = filesFor('pico2').get('memory.x');
    notContains(memory, 'BOOT2', 'RP2350 has no boot2 region');
    matches(memory, /FLASH\s*:\s*ORIGIN = 0x10000000, LENGTH = 3072K/);
    matches(memory, /RAM\s*:\s*ORIGIN = 0x20000000, LENGTH = 512K/);
    matches(memory, /SRAM8\s*:\s*ORIGIN = 0x20080000, LENGTH = 4K/);
    matches(memory, /SRAM9\s*:\s*ORIGIN = 0x20081000, LENGTH = 4K/);
    matches(memory, /FS\s*:\s*ORIGIN = 0x10300000, LENGTH = 1024K/, 'the drive region must be exposed');
    contains(memory, '.start_block');
    contains(memory, 'KEEP(*(.boot_info));');
    contains(memory, '.bi_entries');
    contains(memory, '} INSERT AFTER .vector_table;');
    contains(memory, '} INSERT AFTER .text;');
});

test('every board exposes a drive region and app + drive fill the whole chip', () => {
    const chipKilobytes = { pico: 2048, picow: 2048, pico2: 4096, pico2w: 4096 };
    for (const board of BOARDS) {
        const reserve = board.memory.flashReserve;
        ok(reserve, `${board.id} should expose a drive region`);
        equal(reserve.name, 'FS', `${board.id} drive region name`);
        const total = leadingKilobytes(board.memory.flash.length) + leadingKilobytes(reserve.region.length);
        equal(total, chipKilobytes[board.id], `${board.id}: app + drive must fill the chip exactly`);
    }
});

test('every memory.x MEMORY line has both ORIGIN and LENGTH', () => {
    for (const board of BOARDS) {
        const memory = filesFor(board.id).get('memory.x');
        const body = /MEMORY \{([\s\S]*?)\}/.exec(memory)?.[1] ?? '';
        const regions = body
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '' && !line.startsWith('/*'));
        ok(regions.length >= 2, `${board.id} memory.x should declare at least FLASH and RAM`);
        for (const region of regions) {
            matches(region, /^[A-Z0-9_]+\s*:\s*ORIGIN = 0x[0-9a-fA-F]+, LENGTH = \S+/, `${board.id}: bad region line`);
        }
    }
});

test('build.rs emits exactly the link arguments the board needs', () => {
    for (const board of BOARDS) {
        const buildRs = filesFor(board.id).get('build.rs');
        for (const arg of board.linkArgs) {
            contains(buildRs, `println!("cargo:rustc-link-arg-bins=${arg}");`);
        }
        const emitted = [...buildRs.matchAll(/rustc-link-arg-bins=(\S+?)"/g)].map((m) => m[1]);
        equal(emitted, board.linkArgs, `${board.id} link args drifted from the catalog`);
        contains(buildRs, 'cargo:rerun-if-changed=memory.x');
    }
});

test("main.rs names embassy-rp's executor and the cortex-m-rt entry point", () => {
    for (const board of BOARDS) {
        const main = filesFor(board.id).get('src/main.rs');
        contains(
            main,
            '#[embassy_executor::main(executor = "embassy_rp::executor::Executor", entry = "cortex_m_rt::entry")]',
        );
    }
});

test('main.rs declares the no_std panic handler plumbing', () => {
    const main = filesFor('pico2').get('src/main.rs');
    contains(main, '#![no_std]');
    contains(main, '#![no_main]');
    contains(main, 'use defmt_rtt as _;');
    contains(main, 'use panic_probe as _;');
    contains(main, 'embassy_rp::init(Default::default())');
    contains(main, 'p.PIN_25');
    contains(main, 'Timer::after_millis(500)');
});

test('.vscode/settings.json points rust-analyzer at the embedded target', () => {
    const settings = JSON.parse(filesFor('pico2').get('.vscode/settings.json'));
    equal(settings['rust-analyzer.cargo.target'], 'thumbv8m.main-none-eabihf');
});

test('launch.json satisfies the probe-rs-debug schema', () => {
    for (const board of BOARDS) {
        const launch = JSON.parse(filesFor(board.id).get('.vscode/launch.json'));
        const config = launch.configurations[0];
        equal(config.type, 'probe-rs-debug');
        equal(config.request, 'launch');
        equal(config.chip, board.probeChip, 'launch.json chip must match probe-rs');
        ok(Array.isArray(config.coreConfigs) && config.coreConfigs.length === 1, 'coreConfigs is required');
        contains(config.coreConfigs[0].programBinary, `target/${board.target}/debug/`);
    }
});

test('launch.json programBinary matches the artefact cargo actually writes', () => {
    const launch = JSON.parse(filesFor('pico', 'My Pico Project').get('.vscode/launch.json'));
    contains(launch.configurations[0].coreConfigs[0].programBinary, '/my-pico-project');
    notContains(launch.configurations[0].coreConfigs[0].programBinary, '/my_pico_project');
});

test('the generated README names the board and target', () => {
    const readme = filesFor('pico2').get('README.md');
    contains(readme, 'Raspberry Pi Pico 2');
    contains(readme, 'thumbv8m.main-none-eabihf');
    contains(readme, 'RP235x');
});

/** Reads the leading `NNNK` of a linker length such as `1536K - 0x100`. */
function leadingKilobytes(text) {
    const match = /^(\d+)K/.exec(text);
    if (!match) {
        throw new Error(`unexpected flash size ${text}`);
    }
    return Number(match[1]);
}
