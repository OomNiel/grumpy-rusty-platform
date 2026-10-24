/**
 * Setting the module's RTC from the designer, without a flash.
 *
 * A flashed board is told the PC's time once, on the console, right after the write (see
 * `clockHandoverLines`). That leaves two moments it does not cover: a board that has been running long
 * enough for its clock to drift, and a user who simply wants the hands right *now* rather than after a
 * full rebuild-and-flash. Both are the same line on the same port, so this is that line on its own.
 *
 * The rules the designer's button follows, all of them decided here so they can be tested without a
 * board attached:
 *
 * - **A design with no clock widget is refused.** There is nothing on the glass that would follow the
 *   time, so writing it would be a silent no-op dressed up as success.
 * - **No port is refused, not guessed.** espflash may pick a port for itself; a single line written by
 *   hand has no fallback, and guessing between two boards is worse than saying so.
 * - **A write that fails is a message, never an exception.** The common failure is a Monitor terminal
 *   holding the port, which is the user's to close -- and the one thing this must not do is make a
 *   designer click throw.
 */

import { execFileSync } from 'child_process';
import { clockHandoverLines, writeSerialLineCommand } from './espFlash';

/** What pressing the button did, in the words the panel can show as-is. */
export interface ClockUpdateResult {
    ok: boolean;
    message: string;
}

/** What is about to happen, or why it will not. */
export type ClockUpdatePlan =
    | { kind: 'write'; port: string; lines: string[]; command: string }
    | { kind: 'refuse'; message: string };

/** Running one shell line: a command string in, whether it worked out. */
export type ShellRunner = (command: string) => { ok: boolean; error?: string };

/**
 * Decide what the button does before anything is run.
 *
 * Pure: the clock check, the port check and the line itself are all policy, and policy is the part a
 * test can pin down without a serial port on the bench.
 */
export function clockUpdatePlan(options: {
    hasClock: boolean;
    port?: string;
    now?: Date;
    platform?: NodeJS.Platform;
}): ClockUpdatePlan {
    if (!options.hasClock) {
        return {
            kind: 'refuse',
            message: 'This design has no clock widget, so there is no clock on the board to set.',
        };
    }
    const port = (options.port ?? '').trim();
    if (port === '') {
        return {
            kind: 'refuse',
            message:
                'No module is on a serial port. Connect the board, or set "rustyPlatform.serialPort" to the ' +
                'port it appears on.',
        };
    }
    const lines = clockHandoverLines(options.now ?? new Date());
    return { kind: 'write', port, lines, command: writeSerialLineCommand(port, lines, options.platform) };
}

/** Run a shell line with no window, a short timeout, and its stderr kept for the message. */
export function runShellCommand(
    command: string,
    platform: NodeJS.Platform = process.platform,
): { ok: boolean; error?: string } {
    const file = platform === 'win32' ? 'powershell' : 'sh';
    const args = platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command];
    try {
        execFileSync(file, args, {
            encoding: 'utf8',
            timeout: 5_000,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { ok: true };
    } catch (error) {
        const stderr = (error as { stderr?: unknown }).stderr;
        const first = String(stderr ?? '')
            .split('\n')
            .map((line) => line.trim())
            .find((line) => line !== '');
        return {
            ok: false,
            error: first ?? (error instanceof Error ? error.message.split('\n')[0] : String(error)),
        };
    }
}

/**
 * Write the time, and say what happened.
 *
 * `run` is handed the shell line rather than the plan, so a test can assert the exact command that
 * would have gone to the port. Nothing here throws: every failure is a result with `ok: false`.
 */
export function updateClock(options: {
    hasClock: boolean;
    port?: string;
    now?: Date;
    platform?: NodeJS.Platform;
    run: ShellRunner;
}): ClockUpdateResult {
    const plan = clockUpdatePlan(options);
    if (plan.kind === 'refuse') {
        return { ok: false, message: plan.message };
    }
    const outcome = options.run(plan.command);
    if (!outcome.ok) {
        const reason = outcome.error ?? 'the port did not accept it';
        return {
            ok: false,
            message:
                `Could not write to ${plan.port}: ${reason}. ` +
                'A Monitor terminal holds the port while it runs -- close it and press Update Time again.',
        };
    }
    return { ok: true, message: `Clock set to ${plan.lines[0]?.replace(/^TIME /, '') ?? ''} on ${plan.port}.` };
}
