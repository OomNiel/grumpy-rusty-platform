'use strict';

/**
 * The ESP32 radio templates: Wi-Fi station and Bluetooth LE peripheral.
 *
 * These assert the *contract* between the generated firmware and the rest of the extension,
 * plus the two ordering facts that are easy to get wrong and impossible to see until the
 * board is in your hand:
 *
 *  - the credentials the platform prompts for (and stores in the keyring) are exactly the ones
 *    the firmware reads, which is how one prompt serves both the Pico and the ESP32;
 *  - the scheduler starts *before* the radio is initialised. esp-radio's own documentation
 *    shouts about this ("THIS IS IMPORTANT FOR WIFI AND BLE: You MUST start the scheduler
 *    before initializing the radio!"), because getting it backwards does not fail to build --
 *    it stalls at runtime, which is the worst kind of bug to hand to someone.
 */

const { test, ok, equal, notOk } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const { boardById } = compiled('boards/catalog');
const { generateProjectFiles } = compiled('generate/files');
const { isWirelessFirmware, WIFI_ENV_KEYS } = compiled('wifi/credentials');

const CYD = 'sunton-3248s035r';
const DEVKITC = 'esp32-devkitc';

function filesFor(boardId, template) {
    // Any board: the credential-contract tests compare the ESP32 template against the Pico's.
    const board = boardById(boardId);
    ok(board, `unknown board ${boardId}`);
    const files = generateProjectFiles({ board, projectName: 'demo', template });
    return new Map(files.map((file) => [file.path, file.content]));
}

/** The generated `src/main.rs`, which is where every runtime fact below lives. */
function mainRs(boardId, template) {
    return filesFor(boardId, template).get('src/main.rs');
}

function cargoToml(boardId, template) {
    return filesFor(boardId, template).get('Cargo.toml');
}

test('the Wi-Fi firmware reads the credentials the prompt collects', () => {
    const main = mainRs(DEVKITC, 'wifi');
    for (const key of WIFI_ENV_KEYS) {
        // WIFI_STATIC_IP/WIFI_GATEWAY are optional, so only the pair the prompt always sends is required
        // to be present unconditionally; the static pair is checked by its own test below.
        if (key === 'WIFI_STATIC_IP' || key === 'WIFI_GATEWAY') {
            continue;
        }
        ok(
            main.includes(`option_env!("${key}")`),
            `the Wi-Fi firmware must read ${key}, or the prompt is collecting it for nothing`,
        );
    }
    // The platform's prompt is triggered by exactly this: a generated main.rs that reads WIFI_SSID.
    // Without this, pressing Flash would never ask for the network name on an ESP32 board.
    ok(
        isWirelessFirmware(main),
        'isWirelessFirmware must recognise the ESP Wi-Fi template, or the credential prompt never opens',
    );
});

test('the Pico Wi-Fi template and the ESP Wi-Fi template read the same keys', () => {
    // One prompt, two families, and the prompt is not family-aware -- it keys off the generated source. So
    // the two templates are compared against each other rather than against a list written here. The stacks
    // could hardly be more different (CYW43 + embassy-net on one side, esp-radio on the other), which is
    // exactly why the *contract* has to be checked: both read all four keys, and the ESP template really
    // uses the static pair -- embassy-net applies it, the radio driver never sees an address at all.
    const keysOf = (boardId) =>
        [...mainRs(boardId, 'wifi').matchAll(/option_env!\("(WIFI_[A-Z_]+)"\)/g)]
            .map((match) => match[1])
            .sort();
    equal(
        keysOf(DEVKITC),
        keysOf('picow'),
        'the Pico and ESP Wi-Fi templates must agree on the environment contract',
    );
    equal(
        keysOf(DEVKITC),
        ['WIFI_GATEWAY', 'WIFI_PASSWORD', 'WIFI_SSID', 'WIFI_STATIC_IP'],
        'all four keys, so a fixed address is supported and not merely offered',
    );
});

test('the radio templates ask for the radio crates and the scheduler glue', () => {
    for (const template of ['wifi', 'bluetooth']) {
        const toml = cargoToml(DEVKITC, template);
        ok(toml.includes('esp-radio'), `${template}: the radio crate is what provides the driver`);
        ok(
            toml.includes('esp-alloc'),
            `${template}: the vendor blobs and the host stack allocate at runtime, so a heap is required`,
        );
        // esp-rtos 0.4.0's manifest: esp-radio = ["dep:esp-radio-rtos-driver"]. Without the feature the
        // driver has no scheduler to run on.
        const rtosLine = toml.split('\n').find((line) => line.startsWith('esp-rtos'));
        ok(rtosLine, `${template}: esp-rtos is declared`);
        ok(
            rtosLine.includes('"esp-radio"'),
            `${template}: esp-rtos must be built with its esp-radio feature, not just embassy`,
        );
        ok(
            mainRs(DEVKITC, template).includes('heap_allocator!'),
            `${template}: declaring esp-alloc is not enough, the firmware has to install an allocator`,
        );
    }
});

test('the radio build rebuilds alloc as well as core', () => {
    // esp-radio's documentation asks for a heap, and `alloc` is not in the Xtensa target's prebuilt core,
    // so the build has to compile it from source. Without this the first allocation is a link error.
    const config = filesFor(DEVKITC, 'wifi').get('.cargo/config.toml');
    const buildStdLine = config.split('\n').find((line) => line.includes('build-std'));
    ok(buildStdLine, 'the cargo config sets build-std');
    ok(buildStdLine.includes('"alloc"'), `expected alloc in ${buildStdLine}`);
});

test('the scheduler starts before the radio is initialised', () => {
    // The ordering esp-radio insists on. A reversed order still compiles and then hangs.
    for (const template of ['wifi', 'bluetooth']) {
        const main = mainRs(CYD, template);
        const schedulerAt = main.indexOf('esp_rtos::start(');
        const radioAt = main.search(/WifiController::new\(|BleConnector::new\(/);
        ok(schedulerAt !== -1, `${template}: the firmware starts the scheduler`);
        ok(radioAt !== -1, `${template}: the firmware initialises the radio`);
        ok(
            schedulerAt < radioAt,
            `${template}: the scheduler must start before the radio, or the driver stalls at runtime`,
        );
    }
});

test('the Bluetooth template carries a host stack, because a controller alone cannot advertise', () => {
    // esp-radio exposes an HCI controller: it moves bytes but knows nothing about advertising or GATT.
    // A phone can only see the device once a host stack drives those. This is the crate esp-radio's own
    // BLE example uses, so the generated project follows the vendor's shape.
    const toml = cargoToml(CYD, 'bluetooth');
    ok(toml.includes('trouble-host'), 'the Bluetooth template needs a host stack on top of the controller');
    const main = mainRs(CYD, 'bluetooth');
    ok(/advertise/i.test(main), 'the firmware has to actually advertise, or no phone will ever see it');
    ok(
        main.includes('BleConnector'),
        'the controller is esp-radio\'s BleConnector; the host stack is driven from it',
    );
});

test('the wireless templates do not creep into the wired ones', () => {
    // The same discipline the Pico blinky is held to: a project that does not need a radio must not carry
    // one, or every build pays for a stack it never starts.
    for (const template of ['blinky']) {
        const toml = cargoToml(DEVKITC, template);
        notOk(toml.includes('esp-radio'), `${template} must not pull the radio`);
        notOk(toml.includes('trouble-host'), `${template} must not pull a Bluetooth host stack`);
        notOk(
            mainRs(DEVKITC, template).includes('heap_allocator!'),
            `${template} must not install a heap it does not use`,
        );
    }
    // And a board that *is* offered the peripherals template, to cover the other wired shape.
    const peripherals = cargoToml(CYD, 'peripherals');
    notOk(peripherals.includes('esp-radio'), 'peripherals must not pull the radio');
    notOk(
        mainRs(CYD, 'peripherals').includes('heap_allocator!'),
        'peripherals must not install a heap it does not use',
    );
});

test('the Bluetooth template carries the ROM-symbol workaround, on the chip that needs it', () => {
    // Hard-won and invisible: crates.io's esp-rom-sys 0.1.5 (which esp-radio 1.0.0-beta.1 pins with
    // `=0.1.5`) is missing three ROM PROVIDEs that the upstream repository has at the same tag, and the
    // ESP32-classic BLE blob (esp-wifi-sys-esp32's libbtdm_app.a) refers to all three. Without these link
    // arguments the build dies with a bare `undefined reference`, which says nothing about the cause.
    const config = filesFor(CYD, 'bluetooth').get('.cargo/config.toml');
    for (const [symbol, address] of [
        ['ld_iscan_evt_start_cbk', '0x4003b58c'],
        ['ld_page_evt_start_cbk', '0x4003cf40'],
        ['ld_pscan_evt_start_cbk', '0x4003e924'],
    ]) {
        ok(config.includes(`${symbol}=${address}`), `the classic ESP32 BLE link needs ${symbol}`);
    }
    // They are ESP32 ROM addresses. Another chip's blob is a different binary with different addresses,
    // so defining these there would be meaningless -- and for Wi-Fi there is no Bluetooth blob at all.
    notOk(
        filesFor('lilygo-tqt', 'bluetooth').get('.cargo/config.toml').includes('ld_iscan_evt_start_cbk'),
        'the S3 has its own blob and must not be handed ESP32 ROM addresses',
    );
    notOk(
        filesFor(CYD, 'wifi').get('.cargo/config.toml').includes('ld_iscan_evt_start_cbk'),
        'the Wi-Fi image does not link the Bluetooth blob',
    );
});

test('the advertised name fits in the advertisement payload', () => {
    // The name shares a 31-byte advertisement with the flags and the service UUID, and encode_slice fails
    // at *runtime* if it does not fit -- so it is checked here rather than discovered on the board.
    const main = mainRs(CYD, 'bluetooth');
    const name = /const DEVICE_NAME: &str = "([^"]*)";/.exec(main);
    ok(name, 'the Bluetooth template names the device');
    const budget = 31 - 3 /* flags */ - 4 /* 16-bit service uuid */ - 2 /* name header */;
    ok(
        name[1].length <= budget,
        `the name "${name[1]}" is ${name[1].length} bytes and the payload leaves ${budget}`,
    );
});

