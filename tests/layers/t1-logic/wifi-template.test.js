'use strict';

// The Wi-Fi templates' bring-up diagnostics. These were the difference between "the terminal
// repeats DHCP request retries exceeded" (which says nothing) and knowing whether the lease or the
// association failed, so they are pinned here rather than left to the golden files alone.

const { test, ok, equal, contains, notContains, matches } = require('../../lib/harness');
const { compiled } = require('../../lib/harness');
const { boardById } = compiled('boards/catalog');
const { generateProjectFiles } = compiled('generate/files');

const WIRELESS_BOARDS = ['picow', 'pico2w'];

function mainFor(boardId, template) {
    const files = generateProjectFiles({ board: boardById(boardId), projectName: 'Test Wifi', template });
    const main = files.find((file) => file.path === 'src/main.rs');
    ok(main, `${boardId}/${template}: no src/main.rs`);
    return main.content;
}

test('the wifi template logs the association, so a lease failure is not confused with it', () => {
    for (const boardId of WIRELESS_BOARDS) {
        const main = mainFor(boardId, 'wifi');
        contains(main, 'info!("associated to {}", WIFI_SSID)', `${boardId}: association is not logged`);
        contains(main, 'info!("joining Wi-Fi...")', `${boardId}: the join attempt is not logged`);
        contains(main, 'info!("join failed: {:?}", err)', `${boardId}: a refused password says nothing`);
    }
});

test('the wifi template waits for a lease with a timeout and keeps retrying', () => {
    for (const boardId of WIRELESS_BOARDS) {
        const main = mainFor(boardId, 'wifi');
        // A bare wait_config_up() would block forever and only smoltcp's own retry notice shows up.
        contains(
            main,
            'embassy_time::with_timeout(Duration::from_secs(30), stack.wait_config_up())',
            `${boardId}: the lease wait is unbounded`,
        );
        matches(
            main,
            /loop \{\s*if let Ok\(\(\)\) = embassy_time::with_timeout/,
            `${boardId}: the wait must be inside a retry loop`,
        );
    }
});

test('the DHCP failure message stays factual and offers the way out', () => {
    for (const boardId of WIRELESS_BOARDS) {
        const main = mainFor(boardId, 'wifi');
        // Only the live message is judged: the inert, commented-out superseded text further down
        // still carries the old theory about the network.
        const message = /warn!\(\s*"([^"]*)"/.exec(main)?.[1];
        ok(message, `${boardId}: no DHCP warning found`);
        contains(message, 'no DHCP lease after 30 s', `${boardId}: no bounded-wait message`);
        contains(message, 'the exchange did not complete', `${boardId}: the message should describe the symptom`);
        contains(message, 'WIFI_STATIC_IP', `${boardId}: the static escape hatch is not mentioned`);
        // A packet capture on a network where this client failed showed a conforming OFFER, so the
        // message must not send people chasing their DHCP server (or a second one).
        notContains(message, 'second DHCP server', `${boardId}: the message must not blame the network`);
        notContains(message, '2.4 GHz', `${boardId}: the band is not the established cause`);
    }
});

test('a static address can be supplied at build time, and DHCP is then skipped', () => {
    for (const boardId of WIRELESS_BOARDS) {
        const main = mainFor(boardId, 'wifi');
        contains(main, 'option_env!("WIFI_STATIC_IP")', `${boardId}: WIFI_STATIC_IP is not read`);
        contains(main, 'option_env!("WIFI_GATEWAY")', `${boardId}: WIFI_GATEWAY is not read`);
        contains(main, 'fn static_config()', `${boardId}: no parser for the static settings`);
        contains(main, 'embassy_net::Config::ipv4_static(fixed)', `${boardId}: the static config is unused`);
        contains(main, 'embassy_net::Config::dhcpv4', `${boardId}: DHCP is no longer the default`);
        matches(
            main,
            /match static_config\(\) \{\s*Some\(fixed\) =>/,
            `${boardId}: static settings should win over DHCP`,
        );
    }
});

test('the static parser falls back to DHCP instead of panicking on a typo', () => {
    for (const boardId of WIRELESS_BOARDS) {
        const main = mainFor(boardId, 'wifi');
        // Every step is an Option-based ? so a bad string yields None, which selects DHCP.
        contains(main, 'STATIC_IP?.split_once(\'/\')?', `${boardId}: a missing prefix should not panic`);
        contains(main, 'let prefix: u8 = prefix.parse().ok()?', `${boardId}: a bad prefix should not panic`);
        contains(main, 'if prefix > 32 {', `${boardId}: a prefix above /32 is not rejected`);
        contains(main, 'embassy_net::Ipv4Address::from_str(host).ok()?', `${boardId}: a bad address should not panic`);
    }
});

test('the blinky template carries none of the Wi-Fi machinery', () => {
    for (const boardId of WIRELESS_BOARDS) {
        const main = mainFor(boardId, 'blinky');
        notContains(main, 'dhcp', `${boardId}/blinky unexpectedly talks DHCP`);
        notContains(main, 'WIFI_', `${boardId}/blinky unexpectedly reads Wi-Fi settings`);
    }
});

/**
 * A tiny Rust lexer, enough to prove a generated file is well-formed: the Wi-Fi templates once
 * carried a leftover explanation inside a string argument, which reaches the compiler as
 * "unterminated double quote string". Quotes in comments are legal (the superseded wording below
 * ends with one), so counting them is not enough - the states have to be tracked.
 */
function lexicalState(text) {
    let state = 'code';
    for (let i = 0; i < text.length; i += 1) {
        const two = text.slice(i, i + 2);
        const char = text[i];
        if (state === 'code') {
            if (two === '//') {
                state = 'line';
                i += 1;
            } else if (two === '/*') {
                state = 'block';
                i += 1;
            } else if (char === '"') {
                state = 'string';
            }
        } else if (state === 'line') {
            if (char === '\n') {
                state = 'code';
            }
        } else if (state === 'block') {
            if (two === '*/') {
                state = 'code';
                i += 1;
            }
        } else if (char === '\\') {
            i += 1;
        } else if (char === '"') {
            state = 'code';
        }
    }
    return state;
}

test('every wireless template is lexically well-formed Rust', () => {
    for (const boardId of WIRELESS_BOARDS) {
        for (const template of ['blinky', 'wifi', 'wifi-bluetooth']) {
            const main = mainFor(boardId, template);
            equal(lexicalState(main), 'code', `${boardId}/${template}: a string or comment is never closed`);
        }
    }
});

test('the superseded DHCP wording is inert: it sits inside a block comment', () => {
    for (const boardId of WIRELESS_BOARDS) {
        const main = mainFor(boardId, 'wifi');
        // The message argument is closed before the comment opens, so the macro stays well-formed.
        contains(main, 'skip DHCP." /* superseded wording follows:', `${boardId}: the message is not closed`);
        matches(
            main,
            /\/\* superseded wording follows:[\s\S]*?\*\//,
            `${boardId}: the superseded wording is not wrapped in a block comment`,
        );
    }
});

test('the wireless project tells the reader where the credentials come from', () => {
    for (const boardId of WIRELESS_BOARDS) {
        for (const template of ['wifi', 'wifi-bluetooth']) {
            const files = generateProjectFiles({
                board: boardById(boardId),
                projectName: 'Test Wifi',
                template,
            });
            const readmeFile = files.find((file) => file.path === 'README.md');
            ok(readmeFile, `${boardId}/${template}: no README.md`);
            const readme = readmeFile.content;

            // The prompt is the path a template user never has to be told about; the README has to
            // name it, or the only documented route is the terminal one.
            contains(
                readme,
                'press **Flash** or **Debug**',
                `${boardId}/${template}: the README does not mention the prompt`,
            );
            contains(
                readme,
                "VS Code's keyring",
                `${boardId}/${template}: the README does not say where the credentials are kept`,
            );
            contains(
                readme,
                'WIFI_STATIC_IP',
                `${boardId}/${template}: the README does not mention a fixed address`,
            );
            contains(
                mainFor(boardId, template),
                'press Flash or Debug',
                `${boardId}/${template}: main.rs does not mention the prompt`,
            );
        }
    }
});

test('every firmware marks where the current run starts', () => {
    // RTT replays the previous image's bytes after a reset, and a stale frame can even decode into
    // one of defmt's own strings. Without a marker the reader cannot tell history from this run.
    const pairs = [
        ['pico', 'blinky'],
        ['pico2', 'blinky'],
        ['picow', 'blinky'],
        ['pico2w', 'blinky'],
        ['picow', 'wifi'],
        ['pico2w', 'wifi'],
        ['picow', 'wifi-bluetooth'],
        ['pico2w', 'wifi-bluetooth'],
    ];
    for (const [boardId, template] of pairs) {
        const main = mainFor(boardId, template);
        contains(main, 'starting ===', `${boardId}/${template}: no boot marker`);
        contains(main, 'env!("CARGO_PKG_NAME")', `${boardId}/${template}: the marker should name the crate`);
        contains(main, 'env!("CARGO_PKG_VERSION")', `${boardId}/${template}: the marker should name the version`);
    }
});

test('the wait message matches the addressing that is configured', () => {
    for (const boardId of WIRELESS_BOARDS) {
        const main = mainFor(boardId, 'wifi');
        // "using a static IP" followed by "waiting for DHCP" is how a reader stops trusting the log.
        contains(main, 'let waiting_for_dhcp = STATIC_IP.is_none();', `${boardId}: no addressing decision`);
        contains(main, 'info!("waiting for DHCP...");', `${boardId}: the DHCP wording disappeared`);
        contains(main, 'info!("waiting for the network stack...");', `${boardId}: the static wording is missing`);
        matches(
            main,
            /if waiting_for_dhcp \{\s*warn!/,
            `${boardId}: the DHCP warning must be guarded by the addressing decision`,
        );
        contains(
            main,
            'the network stack never came up',
            `${boardId}: the static case needs its own warning`,
        );
    }
});
