import * as vscode from 'vscode';
import {
    EMPTY_CREDENTIALS,
    WifiCredentials,
    buildWifiEnv,
    describeWifiSetup,
    isWirelessFirmware,
    setActiveWifiEnv,
    validateGateway,
    validateStaticAddress,
} from './credentials';

/**
 * Where the credentials are kept: the editor's keyring (`context.secrets`), never a settings file
 * and never the project tree. The password is only ever passed on as an environment variable to the
 * cargo process, because the templates read it at compile time with `option_env!`.
 */
const SECRET_KEY = 'rustyPlatform.wifi.credentials';

/** Reads the stored credentials, or nothing when none have been entered yet. */
export async function loadWifiCredentials(
    context: vscode.ExtensionContext,
): Promise<WifiCredentials | undefined> {
    const raw = await context.secrets.get(SECRET_KEY);
    if (raw === undefined || raw === '') {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw) as Partial<WifiCredentials>;
        const credentials: WifiCredentials = {
            ssid: typeof parsed.ssid === 'string' ? parsed.ssid : '',
            password: typeof parsed.password === 'string' ? parsed.password : '',
            staticIp: typeof parsed.staticIp === 'string' ? parsed.staticIp : '',
            gateway: typeof parsed.gateway === 'string' ? parsed.gateway : '',
        };
        return credentials.ssid.trim() === '' ? undefined : credentials;
    } catch {
        // An entry we cannot read is treated as "nothing stored"; the next prompt overwrites it.
        return undefined;
    }
}

export async function saveWifiCredentials(
    context: vscode.ExtensionContext,
    credentials: WifiCredentials,
): Promise<void> {
    await context.secrets.store(SECRET_KEY, JSON.stringify(credentials));
}

export async function forgetWifiCredentials(context: vscode.ExtensionContext): Promise<void> {
    await context.secrets.delete(SECRET_KEY);
}

/**
 * Asks for the network, the password and (optionally) a fixed address. Each box is prefilled with
 * what is already stored, and Escape at any point cancels the whole flow.
 */
export async function promptForWifiCredentials(
    existing?: WifiCredentials,
): Promise<WifiCredentials | undefined> {
    const current = existing ?? EMPTY_CREDENTIALS;

    const ssid = await vscode.window.showInputBox({
        title: 'Wi-Fi credentials (1/2)',
        prompt: 'Network name (SSID)',
        value: current.ssid,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() === '' ? 'The SSID cannot be empty.' : undefined),
    });
    if (ssid === undefined) {
        return undefined;
    }

    const password = await vscode.window.showInputBox({
        title: 'Wi-Fi credentials (2/2)',
        prompt: 'Wi-Fi password (leave empty for an open network)',
        password: true,
        value: current.password,
        ignoreFocusOut: true,
    });
    if (password === undefined) {
        return undefined;
    }

    // Static addressing is the escape hatch for networks whose DHCP server never answers, so it is
    // offered here rather than buried in a config file.
    const staticIp = await vscode.window.showInputBox({
        title: 'Wi-Fi address (optional)',
        prompt: 'Fixed IP address - leave empty to use DHCP',
        placeHolder: '192.168.1.50/24',
        value: current.staticIp,
        ignoreFocusOut: true,
        validateInput: validateStaticAddress,
    });
    if (staticIp === undefined) {
        return undefined;
    }

    let gateway = '';
    if (staticIp.trim() !== '') {
        const answer = await vscode.window.showInputBox({
            title: 'Wi-Fi address (optional)',
            prompt: 'Router address for the fixed IP (leave empty for none)',
            placeHolder: '192.168.1.1',
            value: current.gateway,
            ignoreFocusOut: true,
            validateInput: validateGateway,
        });
        if (answer === undefined) {
            return undefined;
        }
        gateway = answer.trim();
    }

    return { ssid: ssid.trim(), password, staticIp: staticIp.trim(), gateway };
}

/**
 * Puts this project's credentials into the environment its cargo runs will get.
 *
 * A wired project clears the environment; a wireless one uses what is stored and otherwise asks,
 * because the placeholder SSID the template ships with produces a board that cannot join and never
 * says why. Cancelling the prompt is not an error: the flash goes ahead with the placeholder, and
 * the warning names the command that fixes it.
 */
export async function ensureWifiEnv(
    context: vscode.ExtensionContext,
    folder: vscode.Uri,
    output: vscode.OutputChannel,
): Promise<void> {
    const mainRs = await readMainRs(folder);
    if (mainRs === undefined || !isWirelessFirmware(mainRs)) {
        setActiveWifiEnv({});
        return;
    }

    const stored = await loadWifiCredentials(context);
    if (stored !== undefined) {
        useCredentials(stored, output, 'using');
        return;
    }

    const entered = await promptForWifiCredentials();
    if (entered !== undefined) {
        await saveWifiCredentials(context, entered);
        useCredentials(entered, output, 'stored');
        return;
    }

    setActiveWifiEnv({});
    output.appendLine(
        'wifi: no credentials entered - the firmware keeps the placeholder SSID from the template and will not join a network.',
    );
    const choice = await vscode.window.showWarningMessage(
        'No Wi-Fi credentials were entered, so the firmware will not join your network. ' +
        'You can add them later with "Rusty Platform: Set Wi-Fi Credentials".',
        'Enter credentials',
        'Flash anyway',
    );
    if (choice !== 'Enter credentials') {
        return;
    }

    const retry = await promptForWifiCredentials();
    if (retry !== undefined) {
        await saveWifiCredentials(context, retry);
        useCredentials(retry, output, 'stored');
    }
}

function useCredentials(
    credentials: WifiCredentials,
    output: vscode.OutputChannel,
    verb: string,
): void {
    setActiveWifiEnv(buildWifiEnv(credentials));
    output.appendLine(`wifi: ${verb} ${describeWifiSetup(credentials)}`);
}

async function readMainRs(folder: vscode.Uri): Promise<string | undefined> {
    try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, 'src', 'main.rs'));
        return Buffer.from(bytes).toString('utf8');
    } catch {
        // No src/main.rs means no firmware to hand a network name to.
        return undefined;
    }
}
