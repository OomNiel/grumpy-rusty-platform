'use strict';

/**
 * Wireless boards: templates, generated Cargo.toml/main.rs and the pinned CYW43
 * firmware metadata. Everything here is pure — no downloads happen in this layer.
 */

const { test, ok, equal, notOk, contains, notContains, matches, throws } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const { BOARDS, boardById } = compiled('boards/catalog');
const {
    CRATE_VERSIONS,
    defaultTemplateFor,
    generateProjectFiles,
    isTemplateValidFor,
    requiredFirmware,
    templatesFor,
} = compiled('generate/files');
const {
    CYW43_BLOBS,
    CYW43_FIRMWARE_COMMIT,
    CYW43_FIRMWARE_RAW_BASE,
    CYW43_LICENCE_FILE,
    blobFor,
    cachedPathFor,
    cyw43CacheDir,
    filesForProject,
    missingBlobs,
    rawUrlFor,
    totalSize,
} = compiled('toolchain/cyw43Firmware');
const { detectBoardFromProject } = compiled('boards/detect');

const WIRED = ['pico', 'pico2'];
const WIRELESS = ['picow', 'pico2w'];

function filesFor(boardId, template, projectName = 'Wireless Test') {
    const files = generateProjectFiles({ board: boardById(boardId), projectName, template });
    return new Map(files.map((file) => [file.path, file.content]));
}

function templateIds(boardId) {
    return templatesFor(boardById(boardId)).map((info) => info.id);
}

// ------------------------------------------------------------------ catalogue

test('wired boards offer one template, wireless boards offer three', () => {
    for (const id of WIRED) {
        equal(templateIds(id), ['blinky'], `${id} template list`);
    }
    for (const id of WIRELESS) {
        equal(templateIds(id), ['wifi', 'blinky', 'wifi-bluetooth'], `${id} template list`);
    }
});

test('every offered template is described for the wizard', () => {
    for (const board of BOARDS) {
        for (const info of templatesFor(board)) {
            ok(info.label && info.label.length > 3, `${board.id}/${info.id} needs a label`);
            ok(info.description && info.description.length > 20, `${board.id}/${info.id} needs a description`);
        }
    }
});

test('the default template matches the board', () => {
    for (const id of WIRED) {
        equal(defaultTemplateFor(boardById(id)), 'blinky');
    }
    for (const id of WIRELESS) {
        equal(defaultTemplateFor(boardById(id)), 'wifi', 'wireless boards default to showing off Wi-Fi');
    }
});

test('a wireless template is rejected on a wired board', () => {
    ok(isTemplateValidFor(boardById('pico'), 'blinky'));
    notOk(isTemplateValidFor(boardById('pico'), 'wifi'));
    notOk(isTemplateValidFor(boardById('pico'), 'wifi-bluetooth'));
    throws(
        () => generateProjectFiles({ board: boardById('pico'), projectName: 'x', template: 'wifi' }),
        'generating a Wi-Fi project for a wired board must throw',
    );
});

test('a wireless board still accepts the plain blinky template', () => {
    ok(isTemplateValidFor(boardById('picow'), 'blinky'));
});

// ----------------------------------------------------------------- Cargo.toml

test('a wired Cargo.toml mentions no wireless crates at all', () => {
    const cargo = filesFor('pico', 'blinky').get('Cargo.toml');
    notContains(cargo, 'cyw43');
    notContains(cargo, 'embassy-net');
    notContains(cargo, 'bt-hci');
});

test('a wireless Cargo.toml pulls in cyw43, cyw43-pio, embassy-net and static_cell', () => {
    for (const id of WIRELESS) {
        const cargo = filesFor(id, 'wifi').get('Cargo.toml');
        contains(cargo, `cyw43 = { version = "${CRATE_VERSIONS.cyw43}", features = ["defmt"] }`);
        contains(cargo, `cyw43-pio = { version = "${CRATE_VERSIONS.cyw43Pio}"`);
        contains(cargo, `embassy-net = { version = "${CRATE_VERSIONS.embassyNet}"`);
        contains(cargo, 'static_cell');
        contains(cargo, 'dhcpv4');
    }
});

test('the plain Wi-Fi template does not enable Bluetooth', () => {
    const cargo = filesFor('picow', 'wifi').get('Cargo.toml');
    notContains(cargo, '"bluetooth"');
    notContains(cargo, 'bt-hci');
});

test('the Bluetooth template enables the feature and offers the host stack as a comment', () => {
    const cargo = filesFor('pico2w', 'wifi-bluetooth').get('Cargo.toml');
    contains(cargo, '"bluetooth"');
    contains(cargo, `bt-hci = { version = "${CRATE_VERSIONS.btHci}"`);
    contains(cargo, 'trouble-host');
    matches(cargo, /#\s*trouble-host = \{/, 'trouble-host must stay commented out');
});

test('the RP2350 W keeps its chip features in every template', () => {
    for (const template of ['wifi', 'blinky', 'wifi-bluetooth']) {
        const cargo = filesFor('pico2w', template).get('Cargo.toml');
        contains(cargo, '"rp235xa"');
        contains(cargo, '"binary-info"');
        notContains(cargo, '"rp2040"');
    }
});

// -------------------------------------------------------------------- main.rs

test('the wireless LED blink drives the CYW43, not a GPIO', () => {
    for (const id of WIRELESS) {
        const main = filesFor(id, 'blinky').get('src/main.rs');
        contains(main, 'control.gpio_set(0, true)');
        contains(main, 'control.gpio_set(0, false)');
        notContains(main, 'led.set_high()', 'there is no GPIO LED on a W board');
        contains(main, 'cyw43::new(');
        contains(main, 'aligned_bytes!("../firmware/43439A0.bin")');
        contains(main, 'aligned_bytes!("../firmware/43439A0_clm.bin")');
        contains(main, 'aligned_bytes!("../firmware/nvram_rp2040.bin")');
        contains(main, 'let cs = Output::new(p.PIN_25, Level::High);', 'PIN_25 is the chip select on a W board');
    }
});

test('the wireless templates use the board-specific PIO clock divider', () => {
    contains(filesFor('picow', 'blinky').get('src/main.rs'), 'DEFAULT_CLOCK_DIVIDER');
    contains(filesFor('pico2w', 'blinky').get('src/main.rs'), 'RM2_CLOCK_DIVIDER');
});

test('the Wi-Fi template joins the network and logs the IP', () => {
    for (const id of WIRELESS) {
        const main = filesFor(id, 'wifi').get('src/main.rs');
        contains(main, 'use cyw43::{aligned_bytes, JoinOptions};');
        contains(main, '.join(WIFI_SSID, JoinOptions::new(WIFI_PASSWORD.as_bytes()))');
        contains(main, 'stack.wait_config_up().await');
        contains(main, 'config.address.address().octets()');
        contains(main, 'let mut rng = RoscRng;');
        contains(main, 'net_task');
    }
});

test('the wireless templates target the published embassy-net 0.9 API', () => {
    const main = filesFor('picow', 'wifi').get('src/main.rs');
    contains(main, 'embassy_net::new(');
    contains(main, 'embassy_net::Config::dhcpv4(Default::default())');
    contains(main, 'embassy_net::StackResources<3>');
    // Both of these belong to the unreleased main-branch API and do not exist in 0.9.1.
    notContains(main, 'StackStorage');
    notContains(main, 'add_iface_borrowed');
});

test('the PIO SPI binds a single DMA channel, as cyw43-pio 0.10.0 requires', () => {
    for (const id of WIRELESS) {
        for (const template of templateIds(id)) {
            const main = filesFor(id, template).get('src/main.rs');
            contains(main, 'dma::Channel::new(p.DMA_CH0, Irqs),');
            notContains(main, 'DMA_CH1', `${id}/${template} must not bind a second DMA channel`);
        }
    }
});

test('Wi-Fi credentials are read from the build environment, never hard-coded', () => {
    const main = filesFor('picow', 'wifi').get('src/main.rs');
    contains(main, 'option_env!("WIFI_SSID")');
    contains(main, 'option_env!("WIFI_PASSWORD")');
    contains(main, 'YOUR_WIFI_SSID');
});

test('the LED-only wireless template carries no networking code', () => {
    for (const id of WIRELESS) {
        const main = filesFor(id, 'blinky').get('src/main.rs');
        notContains(main, 'embassy_net');
        notContains(main, 'JoinOptions');
        notContains(main, 'RoscRng');
        notContains(main, 'StackStorage');
    }
});

test('the Bluetooth template leaves a commented, honest starting point', () => {
    const main = filesFor('picow', 'wifi-bluetooth').get('src/main.rs');
    contains(main, '43439A0_btfw.bin');
    contains(main, 'trouble-host');
    matches(main, /\/\/\s+cyw43::new_with_bluetooth/, 'the Bluetooth snippet must be commented out');
    contains(main, 'Bluetooth');
});

test('the Bluetooth template is otherwise the Wi-Fi template', () => {
    const wifi = filesFor('picow', 'wifi').get('src/main.rs');
    const bt = filesFor('picow', 'wifi-bluetooth').get('src/main.rs');
    ok(bt.length > wifi.length, 'the Bluetooth template adds commentary');
    contains(bt, '.join(WIFI_SSID, JoinOptions::new(WIFI_PASSWORD.as_bytes()))');
});

// ------------------------------------------------------------------ firmware

test('wired boards need no firmware blobs', () => {
    for (const id of WIRED) {
        equal(requiredFirmware(boardById(id), 'blinky'), []);
    }
});

test('firmware requirements follow the template', () => {
    const wifi = ['43439A0.bin', '43439A0_clm.bin', 'nvram_rp2040.bin'];
    for (const id of WIRELESS) {
        equal(requiredFirmware(boardById(id), 'wifi').map((b) => b.fileName), wifi);
        equal(
            requiredFirmware(boardById(id), 'blinky').map((b) => b.fileName),
            wifi,
            'even the LED-only build still needs the Wi-Fi blobs',
        );
        equal(requiredFirmware(boardById(id), 'wifi-bluetooth').map((b) => b.fileName), [...wifi, '43439A0_btfw.bin']);
    }
});

test('every required blob has a pinned hash and a matching size', () => {
    for (const id of WIRELESS) {
        for (const template of templateIds(id)) {
            for (const blob of requiredFirmware(boardById(id), template)) {
                const pinned = blobFor(blob.fileName);
                ok(pinned, `${blob.fileName} has no pinned entry`);
                equal(pinned.sha256.length, 64, `${blob.fileName} needs a full SHA-256`);
                ok(/^[0-9a-f]{64}$/.test(pinned.sha256), `${blob.fileName} hash must be lowercase hex`);
                equal(pinned.size, blob.size, `${blob.fileName} documented size must match the pinned one`);
                ok(pinned.size > 0);
            }
        }
    }
});

test('the firmware is pinned to a commit, never a branch', () => {
    matches(CYW43_FIRMWARE_COMMIT, /^[0-9a-f]{40}$/, 'a full commit SHA is required');
    contains(CYW43_FIRMWARE_RAW_BASE, CYW43_FIRMWARE_COMMIT);
    notContains(CYW43_FIRMWARE_RAW_BASE, '/main/');
    notContains(CYW43_FIRMWARE_RAW_BASE, '/master/');
});

test('raw URLs address the pinned commit', () => {
    contains(rawUrlFor('43439A0.bin'), `embassy/${CYW43_FIRMWARE_COMMIT}/cyw43-firmware/43439A0.bin`);
});

test('the Wi-Fi blob is the biggest and the nvram the smallest', () => {
    const sizes = CYW43_BLOBS.map((blob) => blob.size);
    equal(Math.max(...sizes), 231_077);
    equal(Math.min(...sizes), 742);
});

test('a project also receives the binary licence', () => {
    const names = filesForProject(['43439A0.bin', 'nvram_rp2040.bin']).map((blob) => blob.fileName);
    ok(names.includes(CYW43_LICENCE_FILE.fileName), 'the binary licence must travel with the blobs');
    ok(names.includes('43439A0.bin'));
    notOk(names.includes('43439A0_btfw.bin'), 'a blob that was not requested must not be pulled in');
});

test('asking for an unknown blob is an error, not a silent skip', () => {
    throws(() => filesForProject(['nope.bin']));
});

test('the firmware cache is keyed by the pinned commit', () => {
    const dir = cyw43CacheDir('/home/niel');
    contains(dir, CYW43_FIRMWARE_COMMIT.slice(0, 8));
    contains(dir, '.grumpy-rusty-platform');
    contains(cachedPathFor(CYW43_BLOBS[0], '/home/niel'), '43439A0.bin');
});

test('missing blobs are reported against an injected existence check', () => {
    const blobs = filesForProject(['43439A0.bin', 'nvram_rp2040.bin']);
    equal(missingBlobs(blobs, () => true), []);
    const missing = missingBlobs(blobs, (name) => name === '43439A0.bin').map((blob) => blob.fileName);
    equal(missing.sort(), [CYW43_LICENCE_FILE.fileName, 'nvram_rp2040.bin']);
});

test('total download size is summed for progress reporting', () => {
    equal(totalSize([]), 0);
    ok(totalSize(filesForProject(['43439A0.bin'])) > 231_000);
});

// --------------------------------------------------------------- documentation

test('the wireless project documents where the firmware came from', () => {
    const readme = filesFor('picow', 'wifi').get('firmware/README.md');
    contains(readme, CYW43_FIRMWARE_COMMIT);
    contains(readme, '43439A0.bin');
    contains(readme, 'LICENSE-permissive-binary-license-1.0.txt');
    notContains(readme, '43439A0_btfw.bin', 'the Wi-Fi template does not need the Bluetooth patch');
});

test('the Bluetooth project documents the extra patch blob', () => {
    const readme = filesFor('picow', 'wifi-bluetooth').get('firmware/README.md');
    contains(readme, '43439A0_btfw.bin');
});

test('generated wireless projects are detected as the right board', () => {
    for (const id of [...WIRED, ...WIRELESS]) {
        for (const template of templateIds(id)) {
            const board = boardById(id);
            const map = filesFor(id, template, `detect-${id}`);
            const detected = detectBoardFromProject({
                cargoToml: map.get('Cargo.toml'),
                cargoConfigToml: map.get('.cargo/config.toml'),
            });
            ok(detected, `${id}/${template} was not detected at all`);
            equal(
                detected.id,
                id,
                `${id}/${template} was detected as ${detected.id} — the W boards must not be confused with their wired twins`,
            );
        }
    }
});

test('the project README explains how to supply Wi-Fi credentials', () => {
    const readme = filesFor('picow', 'wifi').get('README.md');
    contains(readme, 'WIFI_SSID');
    contains(readme, 'WIFI_PASSWORD');
    contains(readme, 'CYW43');
});
