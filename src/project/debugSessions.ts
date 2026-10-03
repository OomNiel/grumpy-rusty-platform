import * as vscode from 'vscode';
import { pickProbeRsSession } from './launchConfig';

/**
 * The debug sessions started in this window, oldest first.
 *
 * `vscode.debug.sessions` does not exist (the 1.140 typings have only `activeDebugSession`), so the
 * list is maintained from the start/terminate events. Both the Debug Stop button and its command go
 * through `activeProbeRsSession()`, which keeps the choice itself in the testable launchConfig
 * module.
 */
const running: vscode.DebugSession[] = [];

/** Subscribes the tracker; push the result onto the extension context's subscriptions. */
export function trackDebugSessions(): vscode.Disposable {
    return vscode.Disposable.from(
        vscode.debug.onDidStartDebugSession((session) => {
            running.push(session);
        }),
        vscode.debug.onDidTerminateDebugSession((session) => {
            const index = running.indexOf(session);
            if (index >= 0) {
                running.splice(index, 1);
            }
        }),
    );
}

/**
 * The session a stop action should target: the focused one when it is ours, otherwise a probe-rs
 * session that is still running. Another debugger's session (Python, C++, ...) is never returned:
 * stopping it is not this extension's business.
 */
export function activeProbeRsSession(): vscode.DebugSession | undefined {
    return pickProbeRsSession(running, vscode.debug.activeDebugSession);
}
