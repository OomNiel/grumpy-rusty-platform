/* "Rusty: Back Up Project" — the control's half (asked 2026-10-05).
 *
 * The name and the exclusion rules are `project/backup.ts` (pure, tested); what is here is the copy, the
 * progress line and the report. `fs.cpSync` does the work: it is Node's own recursive copy, it takes a filter,
 * and it keeps symlinks as symlinks rather than following them into somewhere enormous.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { log, logError } from '../ai/log';
import { readActiveProject } from '../project/activeProject';
import { BACKUP_SKIP_DIRS, backupFolderName, backupPlanLine, shouldCopyEntry } from '../project/backup';

/** The project folder this window is working in. */
function projectRoot(): string | undefined {
    const project = readActiveProject() as { root?: string } | undefined;
    const root = project?.root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root && fs.existsSync(root) ? root : undefined;
}

/**
 * "Rusty: Back Up Project" — copy the folder next to itself, stamped with the date.
 *
 * The copy is announced rather than asked about: nothing is overwritten (the name carries the time, and a
 * collision gets `-2`), nothing leaves the machine, and the report names the folder so it can be found. What a
 * person does *not* get is a silent 20 GB copy of `target/`.
 */
export async function backupProject(): Promise<void> {
    const root = projectRoot();
    if (!root) {
        void vscode.window.showWarningMessage('No project folder is open in this window, so there is nothing to back up.');
        return;
    }
    const parent = path.dirname(root);
    const name = path.basename(root);

    let taken: string[] = [];
    try {
        taken = fs.readdirSync(parent);
    } catch (error) {
        logError(`backup: cannot read ${parent}: ${error instanceof Error ? error.message : String(error)}`);
        void vscode.window.showErrorMessage(`The parent folder (${parent}) could not be read, so there is nowhere to put the backup.`);
        return;
    }
    const destination = path.join(parent, backupFolderName(name, new Date(), taken));

    let copied = 0;
    let bytes = 0;
    try {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Backing up ${name}`, cancellable: false },
            async (progress) => {
                progress.report({ message: backupPlanLine(root, destination) });
                fs.cpSync(root, destination, {
                    recursive: true,
                    // One decision, from one place: leaving out the build output is what makes this a backup of
                    // the *project*. `.git` is copied — it is the history, not an artifact.
                    filter: (source) => {
                        let directory = false;
                        try {
                            directory = fs.statSync(source).isDirectory();
                        } catch {
                            return false; // vanished between the listing and the copy
                        }
                        const keep = shouldCopyEntry(path.basename(source), directory);
                        if (!keep) return false;
                        try {
                            const stat = fs.statSync(source);
                            if (stat.isFile()) {
                                copied += 1;
                                bytes += stat.size;
                            }
                        } catch { /* a size we cannot read only costs the report a number */ }
                        return true;
                    }
                });
            }
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError(`backup: failed: ${message}`);
        void vscode.window.showErrorMessage(
            `The backup stopped: ${message}. Whatever was copied is in ${destination} — delete it before trying again.`
        );
        return;
    }

    log(`backup: ${root} → ${destination} (${copied} file(s), ${bytes} bytes, skipped ${BACKUP_SKIP_DIRS.join('/')})`);
    const pick = await vscode.window.showInformationMessage(
        `Backed up to ${path.basename(destination)} — ${copied} file(s), ${formatSize(bytes)} (no ${BACKUP_SKIP_DIRS.join('/')}).`,
        'Show the folder',
        'OK'
    );
    if (pick === 'Show the folder') await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(destination));
}

/** `19.4 MB` — plain units, matching what `formatBytes` does for models rather than a second convention. */
export function formatSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '?';
    if (bytes < 1000) return `${Math.round(bytes)} B`;
    const units = ['kB', 'MB', 'GB', 'TB'];
    let value = bytes / 1000;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit += 1;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
