'use strict';

// The SMTP credential flow: which env keys the firmware reads, how the values become the build
// environment (mirroring the Wi-Fi flow exactly), and the validation that keeps a typo'd relay or
// recipient from turning into a silent post that lands nowhere.

const { test, ok, equal, contains, notContains, compiled } = require('../../lib/harness');

const {
    SMTP_ENV_KEYS,
    DEFAULT_SMTP_PORT,
    DEFAULT_KEEPALIVE_MINUTES,
    buildSmtpEnv,
    describeSmtpSetup,
    keepaliveDisplay,
    validateEmail,
    validateEmails,
    validateHost,
    validatePort,
    activeSmtpEnv,
    smtpEnvVersion,
    setActiveSmtpEnv,
} = compiled('smtp/credentials');

test('the env keys are the names the firmware reads with option_env!', () => {
    equal(
        [...SMTP_ENV_KEYS].sort(),
        ['SMTP_HOST', 'SMTP_PASSWORD', 'SMTP_PORT', 'SMTP_USE_STARTTLS', 'SMTP_USERNAME'].sort(),
        'every variable the extension sets is one smtp.rs reads',
    );
});

test('the defaults match the usual mail submission port and a quarter-hour cadence', () => {
    equal(DEFAULT_SMTP_PORT, 25);
    equal(DEFAULT_KEEPALIVE_MINUTES, 15);
});

test('buildSmtpEnv maps credentials to the compile-time variables the firmware reads', () => {
    const env = buildSmtpEnv({
        host: '  mail.example.com ',
        port: 587,
        username: '  agent ',
        password: 's3cret',
        useStartTls: true,
    });
    equal(Object.keys(env).sort(), [...SMTP_ENV_KEYS].sort());
    equal(env.SMTP_HOST, 'mail.example.com', 'the host is trimmed');
    equal(env.SMTP_PORT, '587', 'the port is a string for the environment');
    equal(env.SMTP_USERNAME, 'agent', 'the username is trimmed');
    equal(env.SMTP_PASSWORD, 's3cret', 'the password is passed through untouched -- never trimmed');
    equal(env.SMTP_USE_STARTTLS, '1', 'STARTTLS is a 0/1 flag');
});

test('buildSmtpEnv does not emit STARTTLS unless it was asked for', () => {
    const env = buildSmtpEnv({ host: 'h', port: 25, username: '', password: '', useStartTls: false });
    equal(env.SMTP_USE_STARTTLS, '0');
    equal(env.SMTP_USE_STARTTLS, '0');
});

test('describeSmtpSetup names the relay and the cadence, never the password', () => {
    const credentials = { host: 'mail.example.com', port: 587, username: 'agent', password: 's3cret', useStartTls: true };
    const posts = {
        from: 'device@example.com',
        subscriptions: ['alice@example.com', 'bob@example.org'],
        keepaliveMinutes: 15,
        keepaliveSubject: 'Here',
        keepaliveBody: 'OK',
    };
    const text = describeSmtpSetup(credentials, posts);
    contains(text, 'mail.example.com:587', 'the relay is named');
    contains(text, 'as "agent"', 'the auth identity is named');
    contains(text, '2 subscriptions', 'the recipient count is named');
    contains(text, keepaliveDisplay(15), 'the cadence is named');
    notContains(text, 's3cret', 'the password is never in the description');
});

test('describeSmtpSetup reads "unauthenticated" when there is no username', () => {
    const text = describeSmtpSetup(
        { host: 'h', port: 25, username: '', password: '', useStartTls: false },
        { from: 'd@e.com', subscriptions: ['a@e.com'], keepaliveMinutes: 1, keepaliveSubject: 's', keepaliveBody: 'b' },
    );
    contains(text, 'unauthenticated');
    contains(text, keepaliveDisplay(1));
});

test('keepaliveDisplay spells minutes and a single minute', () => {
    equal(keepaliveDisplay(15), '15 minutes');
    equal(keepaliveDisplay(1), '1 minute');
});

test('validateHost rejects an empty relay', () => {
    ok(validateHost(''), 'empty is refused');
    ok(validateHost('   '), 'whitespace-only is refused');
    equal(validateHost('mail.example.com'), undefined, 'a name is accepted');
});

test('validatePort accepts 1..65535 and rejects the rest', () => {
    equal(validatePort('25'), undefined);
    equal(validatePort('587'), undefined);
    ok(validatePort('0'), 'zero is refused');
    ok(validatePort('70000'), 'the upper bound is refused');
    ok(validatePort('abc'), 'non-numbers are refused');
    ok(validatePort('12.5'), 'floats are refused');
});

test('validateEmail accepts an address and rejects a typo', () => {
    equal(validateEmail('device@example.com'), undefined);
    ok(validateEmail(''), 'an empty address is refused');
    ok(validateEmail('not an address'), 'a word with no @ is refused');
    ok(validateEmail('a@b'), 'an address needs a dot in the domain');
});

test('validateEmails rejects the whole list when one recipient is bad', () => {
    equal(validateEmails('alice@example.com, bob@example.org'), undefined);
    ok(validateEmails(''), 'an empty recipient list is refused');
    ok(validateEmails('alice@example.com, not-an-address'), 'a bad recipient in a list is refused');
});

test('setActiveSmtpEnv publishes the credentials and bumps the version on change only', () => {
    const before = smtpEnvVersion();
    const first = buildSmtpEnv({ host: 'a', port: 25, username: 'u', password: 'p', useStartTls: false });
    setActiveSmtpEnv(first);
    const afterFirst = smtpEnvVersion();
    ok(afterFirst > before, 'the version bumps once when the env changes');
    equal(activeSmtpEnv(), first, 'the active env carries the credentials');
    equal(activeSmtpEnv(), first, 'activeSmtpEnv returns a copy, not the live object');

    setActiveSmtpEnv(first);
    equal(smtpEnvVersion(), afterFirst, 're-setting the same env does not bump the version');

    const second = buildSmtpEnv({ host: 'b', port: 25, username: 'u', password: 'p', useStartTls: false });
    setActiveSmtpEnv(second);
    ok(smtpEnvVersion() > afterFirst, 'a different host bumps the version again');
    equal(activeSmtpEnv(), second);
});

test('every compile-time entry point injects the stored SMTP setup', () => {
    // The environment lives in the extension host, so a reload empties it: without these calls a
    // flash after a restart bakes the placeholder (an empty SMTP_HOST) and the posts silently stop.
    // Source-level, because the vscode imports keep these files out of a runnable test.
    const fs = require('fs');
    const path = require('path');
    const { repoRoot } = require('../../lib/harness');
    const projects = fs.readFileSync(path.join(repoRoot(), 'src', 'commands', 'projectCommands.ts'), 'utf8');
    const debug = fs.readFileSync(path.join(repoRoot(), 'src', 'commands', 'debugProject.ts'), 'utf8');
    const wizard = fs.readFileSync(path.join(repoRoot(), 'src', 'smtp', 'wizard.ts'), 'utf8');

    contains(wizard, 'export async function ensureSmtpEnv', 'the wizard owns the re-injection');
    ok(
        projects.split('await ensureSmtpEnv(context, project.folder, output)').length - 1 >= 5,
        'both flash routes and all three build commands inject it',
    );
    contains(projects, 'cargo build --release', 'the release build is among them');
    contains(debug, 'await ensureSmtpEnv(context, project.folder, output)', 'and the debug session does too');
});
