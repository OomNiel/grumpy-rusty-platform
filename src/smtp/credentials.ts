/**
 * SMTP credentials and posting config for the SMTP wizard.
 *
 * A generated SMTP client reads the connection info at *compile* time with
 * `option_env!`, the same way the Wi-Fi templates read their credentials
 * (`src/wifi/credentials.ts` keys off `option_env!("WIFI_SSID")`). The secrets
 * therefore never leave the editor's keyring: only the variable names flow into
 * the project, and the values are injected by the extension into every cargo
 * invocation it starts -- see `activeSmtpEnv`.
 *
 * This module is deliberately `vscode`-free so the t1 layer can cover the env
 * mapping and the validation without faking the editor.
 */

/** Variables the generated `src/smtp.rs` reads with `option_env!`. */
export const SMTP_ENV_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'SMTP_USE_STARTTLS'] as const;

/** The connection info, kept like Wi-Fi credentials: in the keyring, never in the project tree. */
export interface SmtpCredentials {
    /** Hostname or IP of the SMTP relay, e.g. `mail.example.com`. */
    host: string;
    /** TCP port (25 for plain, 587 for mail submission). */
    port: number;
    /** Account name for AUTH LOGIN; empty to send unauthenticated. */
    username: string;
    /** Account password for AUTH LOGIN; empty with a username is refused. */
    password: string;
    /** True to advertise STARTTLS. A no_std TLS stack is not bundled yet, so this logs a warning and
     *  sends in the clear -- see `emitSmtpRs` for where that is recorded. */
    useStartTls: boolean;
}

/** The keep-alive post and the subscriptions it is sent to. Non-secret: written as constants in `src/smtp.rs`. */
export interface SmtpPosts {
    /** The address the keep-alive posts appear to come from. */
    from: string;
    /** Recipient addresses that receive every keep-alive post. */
    subscriptions: string[];
    /** How often, in minutes, a keep-alive post is sent. */
    keepaliveMinutes: number;
    /** Subject line of the keep-alive post. */
    keepaliveSubject: string;
    /** Body text of the keep-alive post. */
    keepaliveBody: string;
}

export const DEFAULT_SMTP_PORT = 25;
export const DEFAULT_KEEPALIVE_MINUTES = 15;

/** The environment a cargo invocation needs for SMTP; merged in by `buildEnv` and `runInTerminal`. */
export function buildSmtpEnv(credentials: SmtpCredentials): Record<string, string> {
    return {
        SMTP_HOST: credentials.host.trim(),
        SMTP_PORT: String(credentials.port),
        SMTP_USERNAME: credentials.username.trim(),
        SMTP_PASSWORD: credentials.password,
        SMTP_USE_STARTTLS: credentials.useStartTls ? '1' : '0',
    };
}

/** How the setup reads in the log. Never includes the password. */
export function describeSmtpSetup(credentials: SmtpCredentials, posts: SmtpPosts): string {
    const auth = credentials.username.trim() === '' ? 'unauthenticated' : `as "${credentials.username.trim()}"`;
    return `SMTP ${credentials.host}:${credentials.port} ${auth}; `
        + `${posts.subscriptions.length} subscription${posts.subscriptions.length === 1 ? '' : 's'}; `
        + `keep-alive every ${keepaliveDisplay(posts.keepaliveMinutes)}`;
}

/** A readable summary of the keep-alive cadence, for the log line. */
export function keepaliveDisplay(minutes: number): string {
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/** A trivial email-shape check, strict enough to catch a typo'd recipient. */
export function validateEmail(value: string): string | undefined {
    const text = value.trim();
    if (text === '') {
        return 'An address is required.';
    }
    // No URL/regex engine in no_std, so this is a pragmatic gate -- the firmware would reject a bad
    // address at the MAIL FROM / RCPT TO line anyway, but the prompt catches it first.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
        return 'Not a valid address: "user@example.com".';
    }
    return undefined;
}

/** Validate a comma-separated recipient list for the input box. */
export function validateEmails(value: string): string | undefined {
    const trimmed = value.trim();
    if (trimmed === '') {
        return 'List at least one recipient address.';
    }
    for (const token of trimmed.split(',')) {
        const problem = validateEmail(token);
        if (problem !== undefined) {
            return problem;
        }
    }
    return undefined;
}

/** `validateInput` for the host box. */
export function validateHost(value: string): string | undefined {
    return value.trim() === '' ? 'The SMTP server is required.' : undefined;
}

/** `validateInput` for the port box. */
export function validatePort(value: string): string | undefined {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        return 'Enter a port number between 1 and 65535.';
    }
    return undefined;
}

// ------------------------------------------------------------- active build environment

let active: Record<string, string> = {};
let version = 0;

/**
 * What every cargo invocation the extension starts gets. Set once per action (Flash, Debug) so the
 * terminal and task helpers do not each have to reach for the credentials themselves -- mirroring
 * `activeWifiEnv` exactly.
 */
export function activeSmtpEnv(): Record<string, string> {
    return { ...active };
}

/** Bumped on every change, so a terminal created before the prompt is not reused after it. */
export function smtpEnvVersion(): number {
    return version;
}

/** Key order is not meaningful, so compare by key:value pairs. */
function sameEnv(left: Record<string, string>, right: Record<string, string>): boolean {
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) {
        return false;
    }
    return keys.every((key) => left[key] === right[key]);
}

export function setActiveSmtpEnv(env: Record<string, string>): void {
    const next = { ...env };
    const changed = !sameEnv(next, active);
    active = next;
    if (changed) {
        version += 1;
    }
}
