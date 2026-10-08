/**
 * Opening a designer across a window reload.
 *
 * "New Project" ends by making the folder it just wrote part of the window, and VS Code may **restart the
 * extension host** while doing that: the API says so for the first folder being added and for the change from a
 * single-folder to a multi-folder workspace, which between them cover most of the ways this wizard is used. A
 * webview panel cannot survive that restart, so the request to open the Designer has to survive it instead.
 *
 * The request therefore goes into `globalState` -- global rather than workspace state, because the workspace it
 * belongs to is precisely the thing being created, and there is no identity to key it on yet. `activate` picks it
 * up on the other side, which also covers the reload `vscode.openFolder` performs.
 *
 * The timestamp is not decoration: a request that was never consumed (the user closed the window instead of
 * waiting for the restart) must not open a panel an hour later, when the same folder is opened by hand for an
 * unrelated reason.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { showDesigner } from './editor';

/** Where the request lives between the two sessions. */
export const PENDING_DESIGNER_KEY = 'rustyPlatform.designer.pendingOpen';

/** How long a request stays valid. Generous enough for a cold extension host, short enough not to surprise. */
const VALID_FOR_MS = 120_000;

interface PendingDesigner {
    /** The project folder the designer should be opened for. */
    projectRoot: string;
    /** When it was asked for, as `Date.now()`. */
    at: number;
}

/**
 * Records that the Designer should be open for this project once the window has settled.
 *
 * Called *before* the folder is loaded, because loading it is what may kill this session.
 */
export async function requestDesignerAfterReload(
    context: vscode.ExtensionContext,
    projectRoot: string,
): Promise<void> {
    const pending: PendingDesigner = { projectRoot, at: Date.now() };
    await context.globalState.update(PENDING_DESIGNER_KEY, pending);
}

/** Cancels a request that this session went on to satisfy itself. */
export async function forgetPendingDesigner(context: vscode.ExtensionContext): Promise<void> {
    await context.globalState.update(PENDING_DESIGNER_KEY, undefined);
}

/**
 * Opens a Designer that was asked for before the window was reloaded, if the request is still fresh and the
 * project is still there.
 *
 * The request is consumed whether or not it leads anywhere: one that cannot be honoured is stale, and leaving it
 * behind would only make it fire later on the wrong occasion.
 */
export async function resumePendingDesigner(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    const pending = context.globalState.get<PendingDesigner>(PENDING_DESIGNER_KEY);
    if (pending === undefined) {
        return;
    }
    await forgetPendingDesigner(context);

    if (!fs.existsSync(pending.projectRoot)) {
        output.appendLine(`The Designer was not reopened: ${pending.projectRoot} is not there any more.`);
        return;
    }
    if (Date.now() - pending.at > VALID_FOR_MS) {
        output.appendLine(
            `The Designer was not reopened: the request for ${pending.projectRoot} is stale by ` +
                `${Math.round((Date.now() - pending.at) / 1000)}s.`,
        );
        return;
    }

    await showDesigner(context, output, vscode.Uri.file(pending.projectRoot));
}
