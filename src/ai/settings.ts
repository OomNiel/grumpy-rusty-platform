/* Writing a setting **where it already lives**.
 *
 * Found the hard way on 2026-09-15, after six exchanges with the user: their app project contained
 *
 *     <project folder>/.vscode/settings.json
 *     { "rustyPlatform.assistant.backend": "external" }
 *
 * — a *workspace* setting. A workspace value beats a global one, so every `backend: bundled` the panel saved to
 * Global was shadowed: the load really did work, the built-in runtime answered, and the panel — which reads the
 * *effective* value — went back to "Let the server decide…" the moment it was refreshed with a state. That is why
 * the two LM Studio models worked there (external is exactly what they need) and the two built-in ones could never
 * stick.
 *
 * Writing where the value already lives is what VS Code's own Settings UI does, and it is the only way a
 * project-level pin can be *updated* rather than argued with. A value that exists in no scope is written to the
 * user's settings, as before.
 */

import * as vscode from 'vscode';
import { writeTargetFor, type SettingScopes } from './localModels';
import { log } from './log';

/** The scopes this extension may write to, as VS Code reports them. */
function scopesOf(cfg: vscode.WorkspaceConfiguration, key: string): SettingScopes {
    const inspect = cfg.inspect?.(key);
    if (!inspect) return {};
    return {
        globalValue: (inspect as SettingScopes).globalValue,
        workspaceValue: (inspect as SettingScopes).workspaceValue,
        workspaceFolderValue: (inspect as SettingScopes).workspaceFolderValue
    };
}

function targetFor(where: 'workspaceFolder' | 'workspace' | 'global', hasWorkspace: boolean): vscode.ConfigurationTarget {
    if (!hasWorkspace) return vscode.ConfigurationTarget.Global;
    if (where === 'workspaceFolder') return vscode.ConfigurationTarget.WorkspaceFolder;
    if (where === 'workspace') return vscode.ConfigurationTarget.Workspace;
    return vscode.ConfigurationTarget.Global;
}

/**
 * Updates one setting, in the scope that already supplies it.
 *
 * The caller's own target is deliberately ignored: every caller here means "make this true", and the only thing
 * that can make it true is writing to the scope that would otherwise win.
 */
export async function updateSetting(cfg: vscode.WorkspaceConfiguration, key: string, value: unknown): Promise<void> {
    const where = writeTargetFor(scopesOf(cfg, key));
    const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    await cfg.update(key, value, targetFor(where, hasWorkspace));
    if (where !== 'global') {
        // Said out loud (Output → Grumpy's WYSIWYG Designer): a shadowed write looks exactly like a load that did nothing.
        log(`Setting "${key}" written to the ${where} settings — a value there would have overridden the user setting.`);
    }
}

/**
 * A configuration view whose `update` writes to the owning scope.
 *
 * Used wherever the AI settings are read and written, so no call site has to remember this rule — the bug was
 * exactly one call site remembering `Global` while the project pinned the same key.
 */
export function configView(section: string): vscode.WorkspaceConfiguration {
    const cfg = vscode.workspace.getConfiguration(section);
    const view = {
        get: (key: string, fallback?: unknown) => cfg.get(key, fallback as never),
        update: (key: string, value: unknown) => updateSetting(cfg, key, value),
        inspect: (key: string) => cfg.inspect(key),
        has: (key: string) => cfg.has(key)
    };
    return view as unknown as vscode.WorkspaceConfiguration;
}
