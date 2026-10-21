'use strict';

// The code the SMTP wizard writes into a project: the smtp.rs module, and the two edits it makes to
// the Designer's `main.rs` and `Cargo.toml`. These are pure (text in, text out) so they can be pinned
// byte-for-byte here, the way the wifi/wizard tests do.

const { test, ok, equal, contains, notContains, matches, runtimeSkip, compiled } = require('../../lib/harness');
const { execFileSync } = require('child_process');

const { emitSmtpRs, declareSmtpModule, wireSmtpSpawn, enableEmbassyTcp, addEmbeddedIoAsyncDep, formatSmtpRs } =
    compiled('smtp/code');

const POSTS = {
    from: 'device@example.com',
    subscriptions: ['alice@example.com', 'bob@example.org'],
    keepaliveMinutes: 15,
    keepaliveSubject: 'Here',
    keepaliveBody: 'OK',
};

test('emitSmtpRs bakes the post configuration but reads credentials from option_env!', () => {
    const rs = emitSmtpRs(POSTS);
    // The firmware contract: every variable the extension injects is read at compile time.
    for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'SMTP_USE_STARTTLS']) {
        contains(rs, `option_env!("${key}")`, `${key} must be read with option_env!`);
    }
    // The Wi-Fi bring-up reuses the same credentials as the clock.
    contains(rs, 'option_env!("WIFI_SSID")');
    contains(rs, 'option_env!("WIFI_PASSWORD")');

    // The per-project post config is baked in as constants.
    contains(rs, 'const SMTP_FROM: &str = "device@example.com"');
    contains(rs, 'const SMTP_KEEPALIVE_MINUTES: u64 = 15');
    contains(rs, 'const SMTP_KEEPALIVE_SUBJECT: &str = "Here"');
    contains(rs, 'const SMTP_KEEPALIVE_BODY: &str = "OK"');
    contains(rs, 'const SMTP_SUBSCRIPTIONS: &[&str] = &[');
    contains(rs, '"alice@example.com"');
    contains(rs, '"bob@example.org"');
    // The password is never a literal in the generated source.
    notContains(rs, 's3cret');
});

test('emitSmtpRs produces a self-contained ESP task with the SMTP dialogue', () => {
    const rs = emitSmtpRs(POSTS);
    contains(rs, '#[embassy_executor::task]');
    contains(rs, 'pub async fn smtp_task(wifi: WIFI<');
    contains(rs, 'async fn smtp_post');
    contains(rs, 'fn base64_encode');
    contains(rs, 'async fn smtp_resolve');
    contains(rs, 'async fn smtp_send_line');
    contains(rs, 'async fn smtp_expect');
    // The radio is moved exactly once: smtp_task, not time_task, in this module.
    matches(rs, /\bsmtp_task\b/);
    notContains(rs, 'time_task', 'the clock task is not brought in here');
    // STARTTLS is recorded as a warning, not a handshake.
    contains(rs, 'SMTP_USE_STARTTLS is set, but this build sends in the clear');
});

test('emitSmtpRs emits const-correct Rust that the no_std ESP toolchain accepts', () => {
    // The generated module is compiled by the esp-hal toolchain, not by the editor: every value the
    // wizard injects is read with option_env!, which is const -- but str::parse and &str equality are
    // not const-stable, so those two values are parsed/compared with hand-rolled const fns. These
    // assertions pin that, along with the other ESP32-target fixes (lifetimes on TcpSocket, the dns
    // result type, the base64_encode lifetime, and the unused Read import).
    const rs = emitSmtpRs(POSTS);

    // The port is parsed by hand at compile time -- str::parse would not be const.
    contains(rs, 'const fn parse_port', 'the port is parsed by a const fn');
    contains(rs, 'const SMTP_PORT: u16 = match option_env!("SMTP_PORT")', 'SMTP_PORT is a true const');
    notContains(rs, 'value.parse()', 'str::parse is not used in the const port');

    // The STARTTLS flag is compared by hand -- str == is not const.
    contains(rs, 'const fn bytes_eq', 'the flag is compared by a const fn');
    contains(rs, 'const SMTP_USE_STARTTLS: bool = match option_env!("SMTP_USE_STARTTLS")', 'SMTP_USE_STARTTLS is a true const');
    notContains(rs, 'map_or(false, |value| value == "1")', 'str equality is not used in the const');

    // embassy_net::TcpSocket<'a> carries the stack lifetime; the borrow must be spelled out.
    contains(rs, '&mut TcpSocket<\'_>', 'the socket lifetime is spelled out');
    notContains(rs, '&mut TcpSocket,', 'a bare TcpSocket (no lifetime) is not emitted');

    // dns_query yields core::net::Ipv4Addr in this embassy-net version.
    contains(rs, 'Result<core::net::Ipv4Addr, SmtpError>', 'the resolve return type matches the dns result');
    notContains(rs, 'embassy_net::Ipv4Addr', 'the old, non-existent type is not used');

    // The timeout layer and the dns layer must both be flattened, or addresses.first() is called on a Result.
    contains(rs, '.and_then(|result| result.ok())', 'the inner DNS Result is flattened into an Option');
    notContains(rs, '.ok()\n    .ok()\n    .ok_or', 'the broken double-.ok() chaining is not emitted');

    // base64_encode returns bytes borrowed from the output buffer: the lifetime must be explicit.
    contains(rs, "fn base64_encode<'a>(input: &'a str, out: &'a mut [u8]) -> &'a str", 'the encode lifetime ties input, output and buffer');
    notContains(rs, 'fn base64_encode(input: &str, out: &mut [u8]) -> &str', 'the un-tied signature is not emitted');

    // Read is not needed: TcpSocket.read resolves without it, and an unused import is a denied warning.
    contains(rs, 'use embedded_io_async::Write;', 'only the Write trait is imported');
    notContains(rs, 'embedded_io_async::Read', 'the Read import is not emitted');
});

test('emitSmtpRs emits const-correct Rust that the no_std ESP toolchain accepts', () => {
    const rs = emitSmtpRs(POSTS);
    // option_env! is const, but str::parse / str == / Option::map_or and two-input lifetime elision
    // are not, so those values use hand-rolled const fns and explicit lifetimes.
    contains(rs, 'const fn parse_port', 'the port is parsed by a const fn at compile time');
    contains(rs, 'match option_env!("SMTP_PORT")', 'SMTP_PORT is built with a const match');
    notContains(rs, 'value.parse()', 'str::parse is not used in the const port');
    contains(rs, 'const fn bytes_eq', 'the STARTTLS flag is compared by a const fn');
    contains(rs, 'match option_env!("SMTP_USE_STARTTLS")', 'SMTP_USE_STARTTLS is built with a const match');
    notContains(rs, 'map_or(false, |value| value ==', 'Option::map_or and str == are not used in the const');
    // embassy_net::TcpSocket<'a> carries the stack lifetime: the borrow must be spelled out.
    contains(rs, '&mut TcpSocket<\'_>', 'the socket lifetime is spelled out');
    notContains(rs, '&mut TcpSocket,', 'a bare TcpSocket (no lifetime) is not emitted');
    // dns_query returns Result<_, TimeoutError<Result<_,_, DnsError>>>: both layers must be flattened.
    contains(rs, '.and_then(|result| result.ok())', 'the inner DNS Result is flattened into an Option');
    contains(rs, 'Result<core::net::Ipv4Addr, SmtpError>', 'the resolve return type matches the dns result');
    notContains(rs, 'embassy_net::Ipv4Addr', 'the non-existent embassy_net::Ipv4Addr type is not used');
    // base64_encode borrows its output buffer: one explicit lifetime ties the inputs and the return.
    contains(rs, "fn base64_encode<'a>(input: &'a str, out: &'a mut [u8]) -> &'a str", 'the encode lifetime is explicit');
    notContains(rs, 'fn base64_encode(input: &str, out: &mut [u8]) -> &str', 'the un-tied signature is not emitted');
    // Read is unused here: TcpSocket.read resolves without it, and an unused import is a denied warning.
    contains(rs, 'use embedded_io_async::Write;', 'only the Write trait is imported');
    notContains(rs, 'embedded_io_async::Read', 'the Read import is not emitted');
});

// A minimal Designer main.rs that has both anchors the wizard edits.
const MAIN_RS = [
    '// Where the time comes from when no PC is listening on the cable.',
    'mod net;',
    '',
    'fn setup(spawner: &Spawner, peripherals: Peripherals) {',
    '    let needs_time = true;',
    '    if ui::HAS_CLOCK && needs_time {',
    '        spawner.spawn(',
    '            crate::net::time_task(peripherals.WIFI).expect("the network time task is spawned exactly once"),',
    '        );',
    '    }',
].join('\n');

test('declareSmtpModule inserts `mod smtp;` after `mod net;`', () => {
    const { text, note } = declareSmtpModule(MAIN_RS);
    equal(note, 'added');
    contains(
        text,
        'mod net;\n\n// SMTP client set up by the Rusty Platform SMTP wizard.\nmod smtp;',
        'smtp is declared as a peer of net',
    );
    // The original body is untouched.
    contains(text, 'crate::net::time_task(peripherals.WIFI)');
});

test('declareSmtpModule is idempotent when smtp is already declared', () => {
    const once = declareSmtpModule(MAIN_RS);
    const again = declareSmtpModule(once.text);
    equal(again.note, 'present');
    equal(again.text, once.text, 'a second pass leaves the file byte-for-byte the same');
});

test('declareSmtpModule falls back to the design modules and to manual insertion', () => {
    const designModules = [
        "// The design's own module, and the code-behind it calls.",
        'mod ui;',
        'mod ui_handlers;',
        '',
    ].join('\n');
    equal(declareSmtpModule(designModules).note, 'added');
    contains(declareSmtpModule(designModules).text, 'mod smtp;');

    const bare = 'fn main() {}';
    const manual = declareSmtpModule(bare);
    equal(manual.note, 'manual', 'no anchor is a deliberate escape, not a crash');
    contains(manual.text, 'mod smtp;');
});

test('wireSmtpSpawn adds the SMTP task as the else-branch of the clock spawn', () => {
    const { text, note } = wireSmtpSpawn(MAIN_RS);
    equal(note, 'added');
    contains(text, 'crate::smtp::smtp_task(peripherals.WIFI)', 'the SMTP task is spawned');
    matches(text, /else \{\n\s*\/\/ Added by the Rusty Platform SMTP wizard/);
    // The original clock spawn is preserved.
    contains(text, 'crate::net::time_task(peripherals.WIFI)');
});

test('wireSmtpSpawn is idempotent and refuses to double-spawn', () => {
    const once = wireSmtpSpawn(MAIN_RS);
    const again = wireSmtpSpawn(once.text);
    equal(again.note, 'present');
    equal(again.text, once.text, 'a second pass leaves the file byte-for-byte the same');
    matches(once.text, /smtp_task/g);
});

test('wireSmtpSpawn reports manual when the clock spawn is absent', () => {
    const { note } = wireSmtpSpawn('fn main() {}');
    equal(note, 'manual');
});

const CARGO_TOML = [
    '[package]',
    'name = "proj"',
    '',
    '[dependencies]',
    'embassy-net = { version = "0.9.1", features = ["dhcpv4", "medium-ethernet", "dns", "udp"] }',
    'log = "0.4"',
    '',
].join('\n');

test('enableEmbassyTcp adds the `tcp` feature and preserves the others', () => {
    const { text, note } = enableEmbassyTcp(CARGO_TOML);
    equal(note, 'added');
    contains(text, 'features = ["dhcpv4", "medium-ethernet", "dns", "udp", "tcp"]', 'tcp is appended, the rest kept');
    contains(text, 'log = "0.4"', 'siblings are untouched');
    contains(text, 'name = "proj"', 'the rest of the file is untouched');
});

test('enableEmbassyTcp is idempotent', () => {
    const once = enableEmbassyTcp(CARGO_TOML);
    const again = enableEmbassyTcp(once.text);
    equal(again.note, 'present');
    equal(again.text, once.text, 'a second pass leaves Cargo.toml byte-for-byte the same');
});

test('enableEmbassyTcp refuses an opaque embassy-net entry', () => {
    // A multi-line inline table is valid TOML but outside this editor's scope.
    const opaque = [
        '[dependencies]',
        'embassy-net = {',
        '  version = "0.9.1",',
        '  features = ["dhcpv4", "medium-ethernet", "dns", "udp"],',
        '}',
        'log = "0.4"',
    ].join('\n');
    equal(enableEmbassyTcp(opaque).note, 'opaque');
});

test('addEmbeddedIoAsyncDep adds the dependency the smtp module needs', () => {
    const { text, note } = addEmbeddedIoAsyncDep(CARGO_TOML);
    equal(note, 'added');
    contains(text, 'embedded-io-async = { version = "0.7" }', 'the trait crate is named directly so smtp.rs can import it');
    contains(text, 'embassy-net = { version = "0.9.1"', 'the existing entry is preserved as-is');
});

test('addEmbeddedIoAsyncDep is idempotent', () => {
    const once = addEmbeddedIoAsyncDep(CARGO_TOML);
    equal(addEmbeddedIoAsyncDep(once.text).note, 'present');
});

test('the smtp module the wizard writes is rustfmt-clean', () => {
    try {
        execFileSync('rustfmt', ['--version'], { encoding: 'utf8' });
    } catch {
        runtimeSkip('rustfmt is not installed in this environment');
    }

    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const raw = emitSmtpRs(POSTS);
    const rawFile = path.join(os.tmpdir(), `smtp-raw-${process.pid}.rs`);
    const fmtFile = path.join(os.tmpdir(), `smtp-fmt-${process.pid}.rs`);
    fs.writeFileSync(rawFile, raw);

    // Sanity: the raw template is NOT canonical -- rustfmt would reformat it. (Using a named file,
    // because `rustfmt --check` only checks real files, not stdin.)
    let rawStatus = 0;
    try {
        execFileSync('rustfmt', ['--edition', '2021', '--check', rawFile], { encoding: 'utf8' });
    } catch (e) {
        rawStatus = e.status;
    }
    ok(rawStatus !== 0, 'emitSmtpRs alone is not canonical -- rustfmt would reformat it');

    // The wizard writes `formatSmtpRs(emitSmtpRs(...))`, and that must pass `rustfmt --check`.
    fs.writeFileSync(fmtFile, formatSmtpRs(raw));
    try {
        execFileSync('rustfmt', ['--edition', '2021', '--check', fmtFile], { encoding: 'utf8' });
    } catch (e) {
        throw new Error(`formatSmtpRs output failed rustfmt --check:\n${e.stderr || e.message}`);
    }
});
