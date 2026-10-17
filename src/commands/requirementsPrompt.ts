/**
 * The load-time prompt for whatever is missing.
 *
 * Asked for on 2026-10-16: *"The extension must prompt for any missing requirements when it loads."* The decision
 * of *what* to ask is pure (`toolchain/requirements.ts`); this is the part that talks to VS Code.
 *
 * It is wired to `RustyState.onDidChange` rather than run once at activation, and that is the point: a window can
 * open with no project at all, and the family that decides the requirements only becomes known when one is
 * opened. Opening the CYD project in a window that had been sitting on a Pico one is exactly when "the ESP
 * toolchain is missing" becomes true — and exactly when the user should hear it, rather than at the next reload.
 *
 * Two guards keep it from nagging:
 *
 * - **once per signature per window** (a folder change that re-derives the same answer says nothing twice);
 * - **"Don't show again"** persists the signature in `globalState`, so an unchanged set never comes back — in this
 *   window or any later one — while a *different* set still will.
 */

import * as vscode from 'vscode';
import { RustyState } from '../state';
import { healthReport } from '../toolchain/health';
import {
    HEALTH_ACTION_COMMANDS,
    HEALTH_ACTION_LABELS,
    missingRequirements,
} from '../toolchain/requirements';

/** Where a dismissed requirement set is remembered, across windows. */
export const DISMISSED_REQUIREMENTS_KEY = 'rustyPlatform.requirements.dismissed';

/** The button that silences an unchanged set for good. */
export const DISMISS_LABEL = "Don't Show Again";

/** True when the prompt is switched off in settings. Default on: a missing requirement is worth saying once. */
function promptEnabled(): boolean {
    return vscode.workspace.getConfiguration('rustyPlatform').get<boolean>('promptMissingRequirements', true);
}

/**
 * Starts watching the toolchain state, and offers to fix what is missing.
 *
 * Not awaited anywhere: activation must not wait for a question, and a prompt that is still on screen when the
 * user gets to work is fine — it is a warning, not a modal.
 */
export function registerRequirementsPrompt(
    context: vscode.ExtensionContext,
    state: RustyState,
    output: vscode.OutputChannel,
): vscode.Disposable {
    // Signatures already announced in this window. A folder change re-derives the same requirements; saying the
    // same sentence twice in one session is how a helpful prompt becomes a nag.
    const announced = new Set<string>();

    const check = async (): Promise<void> => {
        const input = state.healthInput;
        const report = healthReport(input);
        const stored = context.globalState.get<string>(DISMISSED_REQUIREMENTS_KEY);
        const requirements = missingRequirements({
            report,
            // `undefined` means detection has not produced a verdict yet — including a detection that failed.
            detected: input.status !== undefined,
            dismissed: stored,
            enabled: promptEnabled(),
        });

        if (!requirements.ask || announced.has(requirements.signature)) {
            return;
        }
        announced.add(requirements.signature);

        const buttons = requirements.actions.map((action) => HEALTH_ACTION_LABELS[action]);
        const choice = await vscode.window.showWarningMessage(
            requirements.message,
            ...buttons,
            DISMISS_LABEL,
        );

        if (choice === DISMISS_LABEL) {
            await context.globalState.update(DISMISSED_REQUIREMENTS_KEY, requirements.signature);
            output.appendLine(
                `requirements: the user does not want to be asked about this set again (${requirements.signature})`,
            );
            return;
        }

        const chosen = requirements.actions.find((action) => HEALTH_ACTION_LABELS[action] === choice);
        if (chosen !== undefined) {
            output.appendLine(`requirements: running ${HEALTH_ACTION_COMMANDS[chosen]}`);
            await vscode.commands.executeCommand(HEALTH_ACTION_COMMANDS[chosen]);
        }
    };

    const disposable = state.onDidChange(() => void check());
    // If detection already finished before this was registered (it cannot today, but the order is not
    // load-bearing), the prompt would otherwise wait for the next change.
    void check();
    return disposable;
}
