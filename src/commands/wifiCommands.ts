import * as vscode from 'vscode';
import { buildWifiEnv, describeWifiSetup, setActiveWifiEnv } from '../wifi/credentials';
import {
    forgetWifiCredentials,
    loadWifiCredentials,
    promptForWifiCredentials,
    saveWifiCredentials,
} from '../wifi/wifiPrompt';

/**
 * The two credential commands.
 *
 * Flash and Debug already ask when nothing is stored (see `ensureWifiEnv`), so these exist for the
 * cases the prompt cannot know about: changing the network, adding a fixed address later, or
 * wiping the keyring entry.
 */
export function registerWifiCommands(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('rustyPlatform.setWifiCredentials', async () => {
            const existing = await loadWifiCredentials(context);
            const entered = await promptForWifiCredentials(existing);
            if (entered === undefined) {
                return;
            }
            await saveWifiCredentials(context, entered);
            setActiveWifiEnv(buildWifiEnv(entered));
            output.appendLine(`wifi: stored ${describeWifiSetup(entered)}`);
            void vscode.window.showInformationMessage(
                `Wi-Fi credentials saved: ${describeWifiSetup(entered)}.`,
            );
        }),

        vscode.commands.registerCommand('rustyPlatform.clearWifiCredentials', async () => {
            const answer = await vscode.window.showWarningMessage(
                'Forget the stored Wi-Fi credentials? The wireless templates fall back to the ' +
                'placeholder SSID until you enter new ones.',
                { modal: true },
                'Forget them',
            );
            if (answer !== 'Forget them') {
                return;
            }
            await forgetWifiCredentials(context);
            setActiveWifiEnv({});
            output.appendLine('wifi: stored credentials cleared.');
        }),
    ];
}
