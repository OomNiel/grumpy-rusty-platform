'use strict';

// The credentials flow: which projects need a network name, how the values become the environment
// the templates are compiled with, and the validation that keeps a typo from turning into a silent
// fall back to DHCP on the board.

const { test, ok, equal, contains, notContains, compiled } = require('../../lib/harness');
const { boardById } = compiled('boards/catalog');
const { generateProjectFiles } = compiled('generate/files');
const {
    WIFI_ENV_KEYS,
    isWirelessFirmware,
    isEmptyCredentials,
    parseStaticAddress,
    validateStaticAddress,
    validateGateway,
    buildWifiEnv,
    describeWifiSetup,
    activeWifiEnv,
    setActiveWifiEnv,
    wifiEnvVersion,
} = compiled('wifi/credentials');

function mainFor(boardId, template) {
    const file = generateProjectFiles({ board: boardById(boardId), projectName: 'Test Wifi', template }).find(
        (candidate) => candidate.path === 'src/main.rs',
    );
    ok(file, `${boardId}/${template}: no src/main.rs`);
    return file.content;
}

test('only the wireless templates are asked for credentials', () => {
    ok(isWirelessFirmware(mainFor('pico2w', 'wifi')), 'the wifi template reads WIFI_SSID');
    ok(isWirelessFirmware(mainFor('picow', 'wifi-bluetooth')), 'the bluetooth template reads it too');
    ok(!isWirelessFirmware(mainFor('pico2', 'blinky')), 'a wired blinky project must never prompt');
    ok(!isWirelessFirmware('fn main() {}'), 'a hand-written project is left alone');
});

test('every variable the extension sets is one the firmware actually reads', () => {
    for (const template of ['wifi', 'wifi-bluetooth']) {
        const main = mainFor('pico2w', template);
        for (const key of WIFI_ENV_KEYS) {
            contains(main, `option_env!("${key}")`, `${template}: ${key} is not read by the template`);
        }
    }
});

test('the DHCP case exports exactly the two credentials', () => {
    const env = buildWifiEnv({ ssid: '  my-net ', password: 'secret', staticIp: '', gateway: '' });
    equal(Object.keys(env).sort(), ['WIFI_PASSWORD', 'WIFI_SSID'], 'a blank address must not be exported');
    equal(env.WIFI_SSID, 'my-net', 'the SSID is trimmed');
    equal(env.WIFI_PASSWORD, 'secret', 'the password is passed through untouched');
});

test('a fixed address adds the static pair, and only when it is complete', () => {
    const withGateway = buildWifiEnv({
        ssid: 'my-net',
        password: '',
        staticIp: ' 192.168.11.240/24 ',
        gateway: ' 192.168.11.1 ',
    });
    equal(withGateway.WIFI_STATIC_IP, '192.168.11.240/24', 'the address is trimmed');
    equal(withGateway.WIFI_GATEWAY, '192.168.11.1', 'the router is trimmed');

    const withoutGateway = buildWifiEnv({
        ssid: 'my-net',
        password: '',
        staticIp: '192.168.11.240/24',
        gateway: '',
    });
    ok(!('WIFI_GATEWAY' in withoutGateway), 'an empty router must fall back to the template default');
});

test('the environment never invents a variable name', () => {
    const allowed = new Set(WIFI_ENV_KEYS);
    const env = buildWifiEnv({ ssid: 'a', password: 'b', staticIp: '10.0.0.2/8', gateway: '10.0.0.1' });
    for (const key of Object.keys(env)) {
        ok(allowed.has(key), `${key} is not one of the template's variables`);
    }
});

test('a static address is validated the way the firmware parses it', () => {
    equal(parseStaticAddress('192.168.1.50/24'), { address: '192.168.1.50', prefix: 24 });
    equal(parseStaticAddress(' 10.0.0.2/8 '), { address: '10.0.0.2', prefix: 8 }, 'whitespace is tolerated');
    equal(parseStaticAddress('192.168.1.1/32'), { address: '192.168.1.1', prefix: 32 });
    equal(parseStaticAddress('0.0.0.0/0'), { address: '0.0.0.0', prefix: 0 });

    // Every one of these would make the firmware's `static_config()` return None and silently use
    // DHCP instead, so the prompt has to refuse them.
    for (const bad of [
        '192.168.1.1',
        '192.168.1.1/33',
        '192.168.1.1/x',
        '192.168.1/24',
        '192.168.1.256/24',
        '010.0.0.1/24',
        '192.168.1./24',
        'nonsense/24',
        '/24',
    ]) {
        ok(typeof parseStaticAddress(bad) === 'string', `${bad} should be rejected`);
    }
});

test('an empty address or router is allowed and means "not configured"', () => {
    equal(validateStaticAddress(''), undefined, 'a blank box selects DHCP');
    equal(validateStaticAddress('   '), undefined);
    equal(validateGateway(''), undefined, 'a blank router means no default route');
    equal(validateGateway('10.0.0.1'), undefined, 'a bare address is the expected form');
    ok(typeof validateStaticAddress('192.168.1.1') === 'string', 'a missing prefix is reported');
    ok(typeof validateGateway('10.0.0.1/24') === 'string', 'a prefix on the router is reported');
    ok(typeof validateGateway('300.0.0.1') === 'string', 'an impossible octet is reported');
});

test('nothing usable is recognised as nothing usable', () => {
    ok(isEmptyCredentials({ ssid: '   ', password: '', staticIp: '', gateway: '' }));
    ok(!isEmptyCredentials({ ssid: 'net', password: '', staticIp: '', gateway: '' }));
});

test('the log line names the network and the addressing, never the password', () => {
    const text = describeWifiSetup({
        ssid: 'my-net',
        password: 'hunter2',
        staticIp: '192.168.11.240/24',
        gateway: '192.168.11.1',
    });
    contains(text, 'my-net');
    contains(text, '192.168.11.240/24');
    notContains(text, 'hunter2', 'the password must never reach the log');
    contains(describeWifiSetup({ ssid: 'my-net', password: '', staticIp: '', gateway: '' }), 'DHCP');
});

test('the active environment is copied in and out, and its version tracks changes', () => {
    setActiveWifiEnv({ WIFI_SSID: 'a', WIFI_PASSWORD: 'b' });
    const handed = activeWifiEnv();
    equal(handed.WIFI_SSID, 'a');
    const before = wifiEnvVersion();

    handed.WIFI_SSID = 'mutated';
    equal(activeWifiEnv().WIFI_SSID, 'a', 'a caller must not be able to edit the live environment');

    setActiveWifiEnv({});
    ok(wifiEnvVersion() > before, 'setting the environment must invalidate terminals built with the old one');
    equal(activeWifiEnv(), {}, 'a wired project clears it');

    // A wired project clears an already-empty environment on every flash; that must not keep
    // spawning new terminals.
    const afterClear = wifiEnvVersion();
    setActiveWifiEnv({});
    equal(wifiEnvVersion(), afterClear, 'setting the same environment again is not a change');

    setActiveWifiEnv({ WIFI_SSID: 'x' });
    const afterSet = wifiEnvVersion();
    setActiveWifiEnv({ WIFI_SSID: 'x' });
    equal(wifiEnvVersion(), afterSet, 'same values, same version');
    setActiveWifiEnv({ WIFI_SSID: 'y' });
    ok(wifiEnvVersion() > afterSet, 'a changed value is a change');
    setActiveWifiEnv({});
});
