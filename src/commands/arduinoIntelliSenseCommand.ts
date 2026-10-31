import * as vscode from 'vscode';
import { readActiveProject } from '../project/activeProject';
import { writeArduinoIntelliSense } from '../toolchain/arduinoIntelliSense';

/**
 * "Arduino: Refresh C++ IntelliSense".
 *
 * The wizard writes this for a new C++ project, but a project can outlive the answer: a library is installed,
 * the core is upgraded, the board in `sketch.yaml` is changed by hand. This is the button for that, and it is
 * also what a project created before the config existed needs once.
 *
 * Refuses politely everywhere it does not apply, because it is in the command palette for every window.
 */
export function registerArduinoIntelliSenseCommand(
    output: vscode.OutputChannel,
): vscode.Disposable {
    return vscode.commands.registerCommand('rustyPlatform.arduino.refreshIntelliSense', async () => {
        const project = await readActiveProject();
        if (project === undefined || project.language !== 'arduino') {
            void vscode.window.showWarningMessage(
                'Open an Arduino (C++) project first: this refreshes the include paths for a sketch.',
            );
            return;
        }

        output.show(true);
        const outcome = await writeArduinoIntelliSense({ project: project.folder, output });
        switch (outcome) {
            case 'written':
                void vscode.window.showInformationMessage(
                    'C++ IntelliSense refreshed from arduino-cli. Open a .cpp file if anything still looks stale.',
                );
                break;
            case 'no-cli':
                void vscode.window.showWarningMessage(
                    'arduino-cli was not found, so the include paths could not be generated. Install it (or put ' +
                    'it on the PATH) and run this again.',
                );
                break;
            case 'no-fqbn':
                void vscode.window.showWarningMessage(
                    'This project\'s sketch.yaml has no `fqbn:` line, so there is no board to ask arduino-cli ' +
                    'about. Add one, then run this again.',
                );
                break;
            default:
                // The log was already shown before the attempt, so the reason is on screen behind this.
                void vscode.window.showErrorMessage(
                    'arduino-cli could not describe this sketch — usually because the board\'s core is not ' +
                    'installed. The Rusty Platform log has its own words for it.',
                );
                break;
        }
    });
}
