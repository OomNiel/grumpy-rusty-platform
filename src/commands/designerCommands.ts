/**
 * The designer's command: one entry point, on the Project view's title bar and in the palette.
 *
 * A thin wrapper, deliberately. Everything about the panel lives in `designer/editor.ts`, which is where the
 * `vscode` dependency is concentrated; this file exists so the command registration reads like every other
 * one in the extension.
 */

import * as vscode from 'vscode';
import { readActiveProject } from '../project/activeProject';
import { importFontIntoDesigner, refreshDesignerSmtp, showDesigner } from '../designer/editor';
import { runSmtpWizard } from '../smtp/wizard';

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
        // The SMTP wizard is offered from the Designer control bar and here. It is the palette entry for a
        // project that is not the one open in a panel, and is gated the same way the panel is: an ESP board
        // with a display, which is the only design the generated smtp_task is written for.
        vscode.commands.registerCommand('rustyPlatform.setupSmtp', async () => {
            const project = await readActiveProject();
            if (project === undefined) {
                void vscode.window.showWarningMessage('Open a Rusty Platform project before setting up SMTP.');
                return;
            }
            const board = project.board;
            if (board === undefined || board.kind !== 'esp' || board.displays.length === 0 || !project.designer) {
                void vscode.window.showWarningMessage(
                    'SMTP setup needs a Designer project on an ESP board with a display.',
                );
                return;
            }
            await runSmtpWizard(project.folder, context, output);
            // The panel, if one is open, has to learn that the module and the feature now exist.
            await refreshDesignerSmtp();
        }),
    ];
}
