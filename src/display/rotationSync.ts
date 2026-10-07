import * as vscode from 'vscode';
import { asLcdRotation, configHasRotation, setLcdRotationInConfig } from './rotation';

/**
 * Keeps a project's `.cargo/esp-config.toml` in step with the `rustyPlatform.lcdRotation` setting.
 *
 * The setting is the handle and the config file is what the compiler reads, so that a build started from a
 * plain terminal behaves the same as one started here. Direction matters: the setting is written *into* the
 * file. A hand-edited file is therefore authoritative for the build, and is only overwritten when the
 * setting itself is changed -- which is the one moment the user has said what they want.
 *
 * A folder without `.cargo/esp-config.toml` is not one of ours (or is an RP project) and is left alone.
 */

const CONFIG_SEGMENTS = ['.cargo', 'esp-config.toml'];

export function registerLcdRotationSync(output: vscode.OutputChannel): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(async (event) => {
        if (!event.affectsConfiguration('rustyPlatform.lcdRotation')) {
            return;
        }
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            try {
                await syncFolder(folder, output);
            } catch (error) {
                output.appendLine(`lcd: could not write the rotation for ${folder.name}: ${String(error)}`);
            }
        }
    });
}

async function syncFolder(folder: vscode.WorkspaceFolder, output: vscode.OutputChannel): Promise<void> {
    const uri = vscode.Uri.joinPath(folder.uri, ...CONFIG_SEGMENTS);
    let content: string;
    try {
        content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
        return;
    }

    const rotation = asLcdRotation(
        vscode.workspace.getConfiguration('rustyPlatform', folder.uri).get('lcdRotation'),
    );
    if (configHasRotation(content, rotation)) {
        return;
    }

    const updated = setLcdRotationInConfig(content, rotation);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));
    output.appendLine(
        `lcd: rotation set to ${rotation} in ${vscode.workspace.asRelativePath(uri)}; rebuild to apply it`,
    );
}
