/**
 * The SMTP-over-Wi-Fi wizard.
 *
 * It is the Wi-Fi credential flow's twin: it prompts for the SMTP connection info and the keep-alive
 * post configuration, tucks the secrets into the editor keyring the same way Wi-Fi does, injects the
 * connection variables into the build environment, and writes the `src/smtp.rs` the firmware compiles
 * against. Re-running it overwrites the project files in place and refreshes everything.
 *
 * Triggered both from the Designer control bar and from the palette; the two entry points share this
 * one body, because the disk work and the prompts are identical -- only the folder differs.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { readProjectAt } from '../project/activeProject';
import { buildWifiEnv, setActiveWifiEnv } from '../wifi/credentials';
import { loadWifiCredentials, promptForWifiCredentials, saveWifiCredentials } from '../wifi/wifiPrompt';
import {
    DEFAULT_KEEPALIVE_MINUTES,
    DEFAULT_SMTP_PORT,
    SmtpCredentials,
    SmtpPosts,
    buildSmtpEnv,
    describeSmtpSetup,
    setActiveSmtpEnv,
    validateEmail,
    validateEmails,
    validateHost,
    validatePort,
} from './credentials';
import {
    addEmbeddedIoAsyncDep,
    declareSmtpModule,
    emitSmtpRs,
    enableEmbassyTcp,
    ensureNetAllowDeadCode,
    ensureSmtpFeature,
    formatSmtpRs,
    wireSmtpSpawn,
} from './code';

/** What lives in the keyring: the connection info (password included) and the per-project post config. */
const SECRET_KEY = 'rustyPlatform.smtp.setup';

interface SmtpSetup {
    credentials: SmtpCredentials;
    posts: SmtpPosts;
}

/** Reads the stored setup, or `undefined` when none has been entered yet. */
export async function loadSmtpCredentials(
    context: vscode.ExtensionContext,
): Promise<SmtpCredentials | undefined> {
    const setup = await loadSmtpSetup(context);
    return setup?.credentials;
}

export async function loadSmtpSetup(
    context: vscode.ExtensionContext,
): Promise<SmtpSetup | undefined> {
    const raw = await context.secrets.get(SECRET_KEY);
    if (raw === undefined || raw === '') {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw) as Partial<SmtpSetup>;
        const credentials: SmtpCredentials = {
            host: typeof parsed.credentials?.host === 'string' ? parsed.credentials.host : '',
            port: typeof parsed.credentials?.port === 'number' ? parsed.credentials.port : DEFAULT_SMTP_PORT,
            username: typeof parsed.credentials?.username === 'string' ? parsed.credentials.username : '',
            password: typeof parsed.credentials?.password === 'string' ? parsed.credentials.password : '',
            useStartTls: typeof parsed.credentials?.useStartTls === 'boolean' ? parsed.credentials.useStartTls : false,
        };
        const posts: SmtpPosts = {
            from: typeof parsed.posts?.from === 'string' ? parsed.posts.from : '',
            subscriptions: Array.isArray(parsed.posts?.subscriptions)
                ? parsed.posts.subscriptions.map(String)
                : [],
            keepaliveMinutes:
                typeof parsed.posts?.keepaliveMinutes === 'number'
                    ? parsed.posts.keepaliveMinutes
                    : DEFAULT_KEEPALIVE_MINUTES,
            keepaliveSubject: typeof parsed.posts?.keepaliveSubject === 'string' ? parsed.posts.keepaliveSubject : '',
            keepaliveBody: typeof parsed.posts?.keepaliveBody === 'string' ? parsed.posts.keepaliveBody : '',
        };
        return { credentials, posts };
    } catch {
        return undefined;
    }
}

/** Persists the SMTP setup to the keyring. The project tree never sees the password. */
export async function saveSmtpCredentials(
    context: vscode.ExtensionContext,
    setup: SmtpSetup,
): Promise<void> {
    await context.secrets.store(SECRET_KEY, JSON.stringify(setup));
}

/**
 * Puts this project's stored SMTP connection info into the environment its cargo runs will get.
 *
 * `runSmtpWizard` sets it when it runs, but the environment lives in the extension host: after a reload
 * it would be empty and the firmware would be built with the placeholder (an empty `SMTP_HOST`, which
 * sends nothing) and say so only on the board's console. Called immediately after `ensureWifiEnv` in
 * Flash and Debug, because both values are read at compile time and a prompt after the build is too late.
 *
 * A project without `src/smtp.rs` clears the environment, so a setup stored for another project cannot
 * leak into this build.
 */
export async function ensureSmtpEnv(
    context: vscode.ExtensionContext,
    folder: vscode.Uri,
    output: vscode.OutputChannel,
): Promise<void> {
    if (!fs.existsSync(path.join(folder.fsPath, 'src', 'smtp.rs'))) {
        setActiveSmtpEnv({});
        return;
    }
    const stored = await loadSmtpSetup(context);
    if (stored === undefined) {
        setActiveSmtpEnv({});
        output.appendLine(
            'smtp: this project has src/smtp.rs, but no SMTP setup is stored - the keep-alive posts stay ' +
            'off; run "Rusty Platform: Set up SMTP over Wi-Fi".',
        );
        return;
    }
    setActiveSmtpEnv(buildSmtpEnv(stored.credentials));
    output.appendLine(`smtp: using ${describeSmtpSetup(stored.credentials, stored.posts)}`);
}

export async function forgetSmtpCredentials(context: vscode.ExtensionContext): Promise<void> {
    await context.secrets.delete(SECRET_KEY);
}

/** The SMTP connection info, as a sequence of input boxes prefilled with whatever is stored. */
async function promptForSmtpCredentials(
    existing?: SmtpCredentials,
): Promise<SmtpCredentials | undefined> {
    const current = existing ?? {
        host: '',
        port: DEFAULT_SMTP_PORT,
        username: '',
        password: '',
        useStartTls: false,
    };

    const host = await vscode.window.showInputBox({
        title: 'SMTP setup (1/5)',
        prompt: 'Relay hostname or IP, e.g. mail.example.com',
        value: current.host,
        ignoreFocusOut: true,
        validateInput: validateHost,
    });
    if (host === undefined) {
        return undefined;
    }

    const port = await vscode.window.showInputBox({
        title: 'SMTP setup (2/5)',
        prompt: 'Relay port (25 for plain, 587 for submission)',
        value: String(current.port || DEFAULT_SMTP_PORT),
        ignoreFocusOut: true,
        validateInput: validatePort,
    });
    if (port === undefined) {
        return undefined;
    }

    const username = await vscode.window.showInputBox({
        title: 'SMTP setup (3/5)',
        prompt: 'Account name for AUTH LOGIN (leave empty to send unauthenticated)',
        value: current.username,
        ignoreFocusOut: true,
    });
    if (username === undefined) {
        return undefined;
    }

    const password = await vscode.window.showInputBox({
        title: 'SMTP setup (4/5)',
        prompt: username.trim() === '' ? 'Leave empty (unauthenticated)' : 'Account password',
        password: true,
        value: current.password,
        ignoreFocusOut: true,
        validateInput: (value) => {
            if (username.trim() !== '' && value.trim() === '') {
                return 'A password is required with a username.';
            }
            return undefined;
        },
    });
    if (password === undefined) {
        return undefined;
    }

    const startTls = await vscode.window.showQuickPick(
        [
            { label: 'No (plain TCP, the default for port 25)', value: false },
            { label: 'Yes (STARTTLS, port 587)', value: true },
        ],
        {
            title: 'SMTP setup (5/5)',
            prompt: 'Advertise STARTTLS?',
            placeHolder: current.useStartTls ? 'Yes' : 'No',
        },
    );
    if (startTls === undefined) {
        return undefined;
    }

    return {
        host: host.trim(),
        port: Number(port),
        username: username.trim(),
        password,
        useStartTls: startTls.value,
    };
}

/** The keep-alive post configuration, as input boxes prefilled with the last run. */
async function promptForSmtpPosts(existing?: SmtpPosts): Promise<SmtpPosts | undefined> {
    const current = existing ?? {
        from: '',
        subscriptions: [],
        keepaliveMinutes: DEFAULT_KEEPALIVE_MINUTES,
        keepaliveSubject: 'I am still here',
        keepaliveBody: 'This device is powered on and connected to the network.',
    };

    const from = await vscode.window.showInputBox({
        title: 'Keep-alive post (1/5)',
        prompt: 'The address the keep-alive posts are sent from',
        value: current.from,
        ignoreFocusOut: true,
        validateInput: validateEmail,
    });
    if (from === undefined) {
        return undefined;
    }

    const subscriptionsText = await vscode.window.showInputBox({
        title: 'Keep-alive post (2/5)',
        prompt: 'Comma-separated recipient addresses that receive the post',
        value: current.subscriptions.join(', '),
        ignoreFocusOut: true,
        validateInput: validateEmails,
    });
    if (subscriptionsText === undefined) {
        return undefined;
    }

    const minutes = await vscode.window.showInputBox({
        title: 'Keep-alive post (3/5)',
        prompt: 'How often, in minutes, a keep-alive post is sent',
        value: String(current.keepaliveMinutes),
        ignoreFocusOut: true,
        validateInput: (value) => {
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
                return 'Enter a whole number of minutes (at least 1).';
            }
            return undefined;
        },
    });
    if (minutes === undefined) {
        return undefined;
    }

    const subject = await vscode.window.showInputBox({
        title: 'Keep-alive post (4/5)',
        prompt: 'Subject line of the keep-alive post',
        value: current.keepaliveSubject,
        ignoreFocusOut: true,
    });
    if (subject === undefined) {
        return undefined;
    }

    const body = await vscode.window.showInputBox({
        title: 'Keep-alive post (5/5)',
        prompt: 'Body text of the keep-alive post',
        value: current.keepaliveBody,
        ignoreFocusOut: true,
    });
    if (body === undefined) {
        return undefined;
    }

    return {
        from: from.trim(),
        subscriptions: subscriptionsText
            .split(',')
            .map((address) => address.trim())
            .filter((address) => address !== ''),
        keepaliveMinutes: Number(minutes),
        keepaliveSubject: subject,
        keepaliveBody: body,
    };
}

/**
 * The whole flow, shared by the Designer control-bar button and the palette command.
 *
 * It guarantees the project has Wi-Fi credentials first (the SMTP client joins the network and reuses
 * the same credentials as the clock), then the SMTP setup, then writes the firmware files. A
 * cancellation at any prompt aborts without touching the disk.
 */
export async function runSmtpWizard(
    folder: vscode.Uri,
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    const project = await readProjectAt(folder);
    if (project === undefined) {
        void vscode.window.showWarningMessage('Open a Rusty Platform project before setting up SMTP.');
        return;
    }
    const board = project.board;
    if (board === undefined || board.kind !== 'esp' || board.displays.length === 0 || !project.designer) {
        void vscode.window.showWarningMessage(
            'SMTP setup needs a Designer project on an ESP board with a display: the generated task is ' +
            'wired into that project\'s main.rs and reuses the clock\'s radio bring-up.',
        );
        return;
    }

    // Wi-Fi first: the SMTP client needs the radio, and reuses the same credentials as the clock.
    let wifi = await loadWifiCredentials(context);
    if (wifi === undefined || wifi.ssid.trim() === '') {
        wifi = await promptForWifiCredentials();
        if (wifi === undefined) {
            output.appendLine('smtp: cancelled before Wi-Fi credentials were entered.');
            return;
        }
        await saveWifiCredentials(context, wifi);
    }
    setActiveWifiEnv(buildWifiEnv(wifi));
    output.appendLine(`smtp: using Wi-Fi ${wifi.ssid}`);

    // SMTP connection info + the post configuration, persisted in the keyring together so a re-run
    // pre-fills every box (the password is never echoed, the rest is not secret anyway).
    const stored = await loadSmtpSetup(context);
    const credentials = await promptForSmtpCredentials(stored?.credentials);
    if (credentials === undefined) {
        output.appendLine('smtp: cancelled before SMTP credentials were entered.');
        return;
    }
    const posts = await promptForSmtpPosts(stored?.posts);
    if (posts === undefined) {
        output.appendLine('smtp: cancelled before the keep-alive posts were entered.');
        return;
    }
    await saveSmtpCredentials(context, { credentials, posts });
    setActiveSmtpEnv(buildSmtpEnv(credentials));
    output.appendLine(`smtp: using ${describeSmtpSetup(credentials, posts)}`);

    // Write the firmware files.
    try {
        await writeSmtpModule(folder, posts);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`smtp: failed to write the firmware files: ${message}`);
        void vscode.window.showErrorMessage(`SMTP setup did not finish: ${message.split('\n')[0]}`, 'Show Log');
        return;
    }

    output.appendLine('smtp: wrote src/smtp.rs; rebuild for the SMTP task to run.');
    void vscode.window.showInformationMessage(
        `SMTP client over Wi-Fi is set up: ${describeSmtpSetup(credentials, posts)}. Rebuild to compile the SMTP task in.`,
    );
}

/** Writes `src/smtp.rs`, wires `mod smtp;` and the task spawn into `main.rs`, and adds the TCP deps. */
async function writeSmtpModule(folder: vscode.Uri, posts: SmtpPosts): Promise<void> {
    await writeText(folder, 'src/smtp.rs', formatSmtpRs(emitSmtpRs(posts)));

    const main = await readText(folder, 'src/main.rs');
    if (main === undefined) {
        throw new Error('src/main.rs was not found; is this a Designer project?');
    }
    const declared = declareSmtpModule(main);
    if (declared.note === 'manual') {
        throw new Error(
            'The wizard could not find `mod net;` in src/main.rs to anchor `mod smtp;` on; add it by hand.',
        );
    }
    const spawned = wireSmtpSpawn(declared.text);
    if (spawned.note === 'manual') {
        throw new Error(
            'The wizard could not find the clock task spawn in src/main.rs to add the SMTP task alongside it; add it by hand.',
        );
    }
    await writeText(folder, 'src/main.rs', spawned.text);

    // net.rs's clock task is not spawned when this client owns the radio, so the module has to say that
    // its items are kept on purpose (see `ensureNetAllowDeadCode`).
    const net = await readText(folder, 'src/net.rs');
    if (net !== undefined) {
        const patched = ensureNetAllowDeadCode(net);
        if (patched.note === 'added') {
            await writeText(folder, 'src/net.rs', patched.text);
        }
    }

    const cargoToml = await readText(folder, 'Cargo.toml');
    if (cargoToml === undefined) {
        throw new Error('Cargo.toml was not found; is this a project folder?');
    }
    const withTcp = enableEmbassyTcp(cargoToml);
    if (withTcp.note === 'opaque') {
        throw new Error(
            'embassy-net in Cargo.toml is written in a form the wizard cannot edit (try a single-line inline table).',
        );
    }
    const withIoAsync = addEmbeddedIoAsyncDep(withTcp.text);
    if (withIoAsync.note === 'opaque') {
        throw new Error('Cargo.toml is written in a form the wizard cannot edit.');
    }
    // The module is gated behind the `smtp` feature, so the Designer switch can take it out of the
    // build without deleting it. Setting it up is what turns the switch on.
    const withFeature = ensureSmtpFeature(withIoAsync.text);
    await writeText(folder, 'Cargo.toml', withFeature.text);
}

/** Reads a project file as utf-8, or `undefined` when it does not exist. */
async function readText(folder: vscode.Uri, relative: string): Promise<string | undefined> {
    try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, relative));
        return Buffer.from(bytes).toString('utf8');
    } catch {
        return undefined;
    }
}

/** Writes a project file, creating whatever directories it needs. */
async function writeText(folder: vscode.Uri, relative: string, content: string): Promise<void> {
    const uri = vscode.Uri.joinPath(folder, relative);
    const parent = path.dirname(uri.fsPath);
    // `path` rather than `Uri.joinPath(uri, '..')`: it normalises the way a filesystem path does, and a
    // directory literally named `..` is not what anyone writes.
    if (!fs.existsSync(parent)) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(parent));
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
}
