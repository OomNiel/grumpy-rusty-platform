/**
 * "Where was I last time?" — the folder memory behind every file/folder picker in the extension.
 *
 * A picker that always opens at the OS default is a small tax on the user: a chart's workbook lives in
 * one place, a project's images in another, models in a third. Each picker therefore remembers the
 * folder it used last, and opens there next time.
 *
 * One memory per KIND, not one for everything: choosing a `.xlsx` must not move where the next `.gguf`
 * dialog opens. The kinds are grouped the way a user thinks about them (see `PickerKind`), and the
 * three folder pickers deliberately share one kind because they all answer the same question — "which
 * folder?".
 *
 * The memory lives in the extension's global state, so it is per machine and survives a reload or an
 * update. `initPickerFolders` registers that state once, from `activate` — the pickers themselves live
 * in modules that have no extension context to hand round (the same reason `initLlamaServer` exists).
 * Until it is registered every helper here does nothing, which is what keeps the tests free of `vscode`.
 */
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';

/** What a remembered folder belongs to. */
export type PickerKind =
    /** A chart's `.xlsx` workbook (GrumpyCharts `SourceFile`). */
    | 'workbook'
    /** A chart's DATA file for the DataFiles source (a CSV today) — its own memory, so a workbook
     *  pick and a data-file pick never move each other's starting folder. */
    | 'data'
    /** A picture: `Image Source`. */
    | 'image'
    /** A window/form icon: `Icon`, `TitleBarIcon`. */
    | 'icon'
    /** A SQLite file: the DataSet editor's "use this file" and "import tables". */
    | 'database'
    /** A `.gguf` model file (both model pickers share this one). */
    | 'model'
    /** The `llama-server` executable. */
    | 'binary'
    /** A folder to put something in: a new project, a new form, a new DataSet. */
    | 'folder';

/** The `vscode.Memento` slice this needs — a plain object satisfies it, which the tests rely on. */
export type FolderMemory = Pick<vscode.Memento, 'get' | 'update'>;

/** The one global-state key. A record, so a kind can be added without a new key. */
const STORE = 'pickerLastFolder';

/** The registered memory (undefined before `initPickerFolders`, and in tests that never call it). */
let store: FolderMemory | undefined;

/** Registers where the memory lives: `context.globalState`, called once from `activate`. */
export function initPickerFolders(globalState: FolderMemory): void {
    store = globalState;
}

function readAll(): Partial<Record<PickerKind, string>> {
    return store?.get<Partial<Record<PickerKind, string>>>(STORE) ?? {};
}

/** Writes one kind's folder. Never rejects — a failed write must not break the flow that used a picker. */
function write(kind: PickerKind, folder: string): Promise<void> {
    if (!store) return Promise.resolve();
    try {
        const next = { ...readAll(), [kind]: folder };
        return Promise.resolve(store.update(STORE, next)).then(() => undefined, () => undefined);
    } catch {
        return Promise.resolve();
    }
}

/**
 * The folder this kind of picker used last, or `undefined` when there is none to offer —
 * never picked before, or the remembered folder has since been deleted (a folder on an unplugged
 * drive would otherwise open the dialog inside a path that is not there).
 */
export function lastPickerFolder(kind: PickerKind): string | undefined {
    const folder = readAll()[kind];
    if (!folder) return undefined;
    try {
        if (!fs.statSync(folder).isDirectory()) return undefined;
    } catch {
        return undefined;
    }
    return folder;
}

/**
 * The folder to open a picker in, given what it remembers and the weaker default the call site already
 * had (a project folder, the home folder, …). The remembered folder WINS: it is the one the user
 * actually chose last time.
 */
export function pickerStartFolder(kind: PickerKind, fallback?: string): string | undefined {
    return lastPickerFolder(kind) ?? fallback;
}

/** Remembers the folder a FILE picker returned — the folder that holds that file. */
export function rememberPickerFile(kind: PickerKind, filePath: string): Promise<void> {
    const folder = path.dirname(String(filePath ?? ''));
    // `dirname('x.xlsx')` is '.', which would remember the process's working directory as "where I was".
    if (!folder || folder === '.') return Promise.resolve();
    return write(kind, folder);
}

/** Remembers the folder a FOLDER picker returned. */
export function rememberPickerFolder(kind: PickerKind, folderPath: string): Promise<void> {
    return folderPath ? write(kind, folderPath) : Promise.resolve();
}
