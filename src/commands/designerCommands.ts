/**
 * The designer's command: one entry point, on the Project view's title bar and in the palette.
 *
 * A thin wrapper, deliberately. Everything about the panel lives in `designer/editor.ts`, which is where the
 * `vscode` dependency is concentrated; this file exists so the command registration reads like every other
 * one in the extension.
 */

import * as vscode from 'vscode';
import { importFontIntoDesigner, showDesigner } from '../designer/editor';

export function registerDesignerCommands(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('rustyPlatform.openDesigner', async () => {
            await showDesigner(context, output);
        }),
        // A system font has to be rasterised to be used on the glass, and that has to happen while a design
        // is open -- so it is a rejection with a reason rather than a command that quietly does nothing.
        vscode.commands.registerCommand('rustyPlatform.importFont', async () => {
            await importFontIntoDesigner();
        }),
    ];
}
