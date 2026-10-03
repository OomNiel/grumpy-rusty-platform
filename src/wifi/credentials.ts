/**
 * Wi-Fi credentials for the wireless templates.
 *
 * The generated templates read these with `option_env!`, so they have to be in the environment of
 * the *cargo* process — nothing can be injected at runtime. This module is deliberately free of
 * `vscode` imports so the t1 layer can test the env mapping and the validation; the keyring and the
 * prompts live in `wifiPrompt.ts`.
 */

/** The variables the templates read. Keep in step with the wireless templates in generate/files.ts. */
export const WIFI_ENV_KEYS = ['WIFI_SSID', 'WIFI_PASSWORD', 'WIFI_STATIC_IP', 'WIFI_GATEWAY'] as const;

export interface WifiCredentials {
    ssid: string;
    /** Empty selects an open network. */
    password: string;
    /** `a.b.c.d/prefix`; empty selects DHCP, which is the template's default. */
    staticIp: string;
    /** Router address for a static address; empty leaves the stack without a default route. */
    gateway: string;
}

export const EMPTY_CREDENTIALS: WifiCredentials = { ssid: '', password: '', staticIp: '', gateway: '' };

export interface StaticAddress {
    address: string;
    prefix: number;
}

/**
 * Whether a `src/main.rs` belongs to one of the wireless templates. They are the only ones that
 * read the credentials, and a wired project must never be interrupted by the prompt.
 */
export function isWirelessFirmware(mainRs: string): boolean {
    return mainRs.includes('option_env!("WIFI_SSID")');
}

/** True while nothing usable has been entered, so the prompt has something to ask about. */
export function isEmptyCredentials(credentials: WifiCredentials): boolean {
    return credentials.ssid.trim() === '';
}

type Ipv4Result = { ok: true; address: string } | { ok: false; message: string };

/**
 * The octet rules `core::net::Ipv4Addr::from_str` applies in the firmware: four decimal octets, at
 * most 255, and no leading zeros (Rust rejects `010.0.0.1`). Matching them here keeps a typo in the
 * prompt from turning into a silent fall back to DHCP on the board.
 */
function parseIpv4(value: string): Ipv4Result {
    const octets = value.split('.');
    if (octets.length !== 4) {
        return { ok: false, message: 'Use four decimal octets, for example 192.168.1.50' };
    }
    for (const octet of octets) {
        if (!/^\d{1,3}$/.test(octet)) {
            return { ok: false, message: 'Each octet must be a decimal number' };
        }
        if (octet.length > 1 && octet.startsWith('0')) {
            return { ok: false, message: `Drop the leading zero in "${octet}"` };
        }
        if (Number(octet) > 255) {
            return { ok: false, message: `"${octet}" is larger than 255` };
        }
    }
    return { ok: true, address: value };
}

/**
 * Validates `a.b.c.d/prefix` exactly as the generated `static_config()` does: a missing prefix, a
 * prefix above 32, or a bad octet all make the firmware ignore the setting and use DHCP instead.
 *
 * Returns the parsed address, or a message fit for an input box's `validateInput`.
 */
export function parseStaticAddress(value: string): StaticAddress | string {
    const text = value.trim();
    if (text === '') {
        return 'Enter an address like 192.168.1.50/24, or leave the box empty to use DHCP';
    }
    const slash = text.lastIndexOf('/');
    if (slash === -1) {
        return 'Add the prefix length, for example 192.168.1.50/24';
    }
    const prefixText = text.slice(slash + 1);
    if (!/^\d{1,3}$/.test(prefixText)) {
        return 'The prefix must be a number between 0 and 32';
    }
    const prefix = Number.parseInt(prefixText, 10);
    if (prefix > 32) {
        return 'The prefix must be between 0 and 32';
    }
    const host = parseIpv4(text.slice(0, slash));
    if (!host.ok) {
        return host.message;
    }
    return { address: host.address, prefix };
}

/** `validateInput` for the fixed-address box: empty is allowed and means DHCP. */
export function validateStaticAddress(value: string): string | undefined {
    if (value.trim() === '') {
        return undefined;
    }
    const parsed = parseStaticAddress(value);
    return typeof parsed === 'string' ? parsed : undefined;
}

/** `validateInput` for the router box: empty is allowed (no default route). */
export function validateGateway(value: string): string | undefined {
    const text = value.trim();
    if (text === '') {
        return undefined;
    }
    const parsed = parseIpv4(text);
    return parsed.ok ? undefined : parsed.message;
}

/**
 * The environment a cargo invocation needs. Only the keys the templates read, and the static pair
 * only when an address was given: exporting an empty `WIFI_GATEWAY` would make the firmware parse
 * "" instead of using the `None` path.
 */
export function buildWifiEnv(credentials: WifiCredentials): Record<string, string> {
    const env: Record<string, string> = {
        WIFI_SSID: credentials.ssid.trim(),
        WIFI_PASSWORD: credentials.password,
    };
    const staticIp = credentials.staticIp.trim();
    if (staticIp !== '') {
        env.WIFI_STATIC_IP = staticIp;
        const gateway = credentials.gateway.trim();
        if (gateway !== '') {
            env.WIFI_GATEWAY = gateway;
        }
    }
    return env;
}

/** How the setup reads in the log. Never includes the password. */
export function describeWifiSetup(credentials: WifiCredentials): string {
    const address = credentials.staticIp.trim();
    const network = address === '' ? 'DHCP' : `static ${address}`;
    return `SSID "${credentials.ssid.trim()}" (${network})`;
}

// ------------------------------------------------------------- active build environment

let active: Record<string, string> = {};
let version = 0;

/**
 * What every cargo invocation the extension starts gets. Set once per action (Flash, Debug) so the
 * terminal and task helpers do not each have to reach for the credentials themselves.
 */
export function activeWifiEnv(): Record<string, string> {
    return { ...active };
}

/** Bumped on every change, so a terminal created before the prompt is not reused after it. */
export function wifiEnvVersion(): number {
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

export function setActiveWifiEnv(env: Record<string, string>): void {
    const next = { ...env };
    // Only a real change is a new terminal: a wired project clears an already-empty environment on
    // every flash, and that must not spawn a fresh terminal each time.
    const changed = !sameEnv(next, active);
    active = next;
    if (changed) {
        version += 1;
    }
}
