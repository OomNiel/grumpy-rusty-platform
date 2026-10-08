/**
 * The designer's command: one entry point, on the Project view's title bar and in the palette.
 *
 * A thin wrapper, deliberately. Everything about the panel lives in `designer/editor.ts`, which is where the
 * `vscode` dependency is concentrated; this file exists so the command registration reads like every other
 * one in the extension.
 */

import * as vscode from 'vscode';
import { showDesigner } from '../designer/editor';

export function registerDesignerCommands(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('rustyPlatform.openDesigner', async () => {
            await showDesigner(context, output);
        }),
    ];
}
