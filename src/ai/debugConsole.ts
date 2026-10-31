/* The Debug Console, read through the debug adapter (asked 2026-10-31: *"enable the ai model to access
 * (read) the … Debug Console … panes"*).
 *
 * WHY THIS IS A TRACKER AND NOT A PANE READ. VS Code has no API for a pane's text — not for the Debug Console,
 * not for a terminal, not for Output. The Debug Console is the one of the three with an official way in: a
 * `DebugAdapterTracker` is handed every message the adapter sends, and the console is made of exactly those
 * messages (`event: 'output'` with `stdout`/`stderr`/`console`, plus `stopped` and `exited`).
 *
 * TIME LIMITS THAT ARE PART OF THE DESIGN, not bugs to file later: a tracker sees nothing that happened before
 * it was attached, so the factory is registered at activation and never on demand. Between sessions the buffer
 * is cleared, because attributing yesterday's panic to today's program is worse than saying nothing — but the
 * **last** session's tail is kept after it terminates, since "why did it crash?" is usually asked afterwards.
 */

import * as vscode from 'vscode';
import { formatDebugConsole, type DebugConsoleLine } from './panes';

/** Lines kept. The adapter of a fast RTT stream can produce thousands; the prompt only ever shows the tail. */
const MAX_LINES = 500;

let lines: DebugConsoleLine[] = [];
let of = '';

/** The session name as a phrase for the prompt (`"Pico 2 W"`), so two consoles cannot be confused. */
function labelFor(session: vscode.DebugSession): string {
    return session.name ? `"${session.name}" session` : 'session';
}

/**
 * Registers the reader once, for the lifetime of the window: `'*'` because the factory must exist before a
 * session starts, and the filter inside decides which sessions are this project's.
 */
export function registerDebugConsoleReader(): vscode.Disposable {
    const onStart = vscode.debug.onDidStartDebugSession((session) => {
        // A new session is a new console. Keeping the old lines would let the model answer about the previous
        // program's failure, which is the one thing it cannot see is wrong.
        lines = [];
        of = labelFor(session);
    });
    const factory = vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker(session) {
            // Only `probe-rs*` sessions: those are the firmware runs this extension starts. Another debugger's
            // console (a Python or C++ session in a multi-language window) is not this project and is not sent.
            if (!session.type.startsWith('probe-rs')) return undefined;
            return {
                onDidSendMessage(message: unknown) {
                    record(message as DebugProtocolEvent);
                }
            };
        }
    });
    return vscode.Disposable.from(onStart, factory);
}

/** The shape of a DAP message this needs; the rest of the protocol is ignored. */
interface DebugProtocolEvent {
    type?: string;
    event?: string;
    body?: { output?: unknown; category?: unknown; reason?: unknown; description?: unknown; text?: unknown; exitCode?: unknown };
}

/** Turns the adapter's events into console lines. */
function record(message: DebugProtocolEvent): void {
    if (!message || message.type !== 'event') return;
    const body = message.body ?? {};
    if (message.event === 'output') {
        const text = typeof body.output === 'string' ? body.output : '';
        const category = body.category === 'stderr' ? 'stderr' : body.category === 'stdout' ? 'stdout' : 'console';
        push({ category, text });
    } else if (message.event === 'stopped') {
        const why = [body.reason, body.description, body.text]
            .filter((value): value is string => typeof value === 'string' && value !== '')
            .join(': ');
        push({ category: 'console', text: `[stopped] ${why || 'paused'}` });
    } else if (message.event === 'exited') {
        const code = body.exitCode;
        push({ category: 'console', text: `[exited] ${typeof code === 'number' ? `code ${code}` : 'no exit code'}` });
    }
}

function push(entry: DebugConsoleLine): void {
    for (const line of String(entry.text ?? '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        lines.push({ ...entry, text: line });
    }
    if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
}

/** What the last session's console says, as prompt text, or `''` when there has not been one. */
export function debugConsoleBlock(): string {
    return formatDebugConsole(lines, { of });
}
