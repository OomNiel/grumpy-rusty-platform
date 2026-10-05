import * as vscode from 'vscode';
import { RustyState } from '../state';
import { activeProbeRsSession } from '../project/debugSessions';
import { HEALTH_CONTROL, healthSummary, visibleControls } from './controls';

/**
 * Sidebar section "Controls": the same buttons as the status bar, for the times the status bar is
 * crowded, hidden, or simply not where the user is looking.
 *
 * Both are rendered from `ui/controls.ts`, so there is one list to keep right. The one piece of
 * live state is the Stop control, which appears only while a probe-rs session runs — the same rule
 * the status bar follows.
 */
export class ControlsViewProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.emitter.event;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly state: RustyState) {
        this.disposables.push(
            vscode.debug.onDidStartDebugSession(() => this.refresh()),
            vscode.debug.onDidTerminateDebugSession(() => this.refresh()),
        );
    }

    dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables.length = 0;
        this.emitter.dispose();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): vscode.TreeItem[] {
        const health = healthSummary(this.state.healthInput);
        const healthItem = new vscode.TreeItem(health.label, vscode.TreeItemCollapsibleState.None);
        healthItem.iconPath = new vscode.ThemeIcon(health.icon);
        healthItem.description = health.detail;
        healthItem.tooltip = new vscode.MarkdownString(health.markdown);
        healthItem.command = { command: HEALTH_CONTROL.command, title: health.label };

        const items = [healthItem];
        for (const control of visibleControls(activeProbeRsSession() !== undefined, this.state.family)) {
            const item = new vscode.TreeItem(control.label, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon(control.icon);
            item.description = control.detail;
            item.tooltip = control.tooltip;
            item.command = { command: control.command, title: control.label };
            items.push(item);
        }
        return items;
    }

    refresh(): void {
        this.emitter.fire();
    }
}
