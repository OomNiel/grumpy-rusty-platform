import * as vscode from 'vscode';
import { RustyState } from '../state';
import { readActiveProject } from '../project/activeProject';

/** Project view: what this workspace targets, and whether the toolchain can build it. */
export class ProjectViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.emitter.event;

    constructor(private readonly state: RustyState) { }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(): Promise<vscode.TreeItem[]> {
        const items: vscode.TreeItem[] = [];
        const project = await readActiveProject();

        if (!project) {
            const none = new vscode.TreeItem('No Rusty Platform project in this workspace', vscode.TreeItemCollapsibleState.None);
            none.iconPath = new vscode.ThemeIcon('info');
            none.command = { command: 'rustyPlatform.newProject', title: 'New Project' };
            return [none];
        }

        const boardItem = new vscode.TreeItem(project.board?.name ?? 'Unknown board', vscode.TreeItemCollapsibleState.None);
        boardItem.description = project.chip ? `chip ${project.chip}` : undefined;
        boardItem.iconPath = new vscode.ThemeIcon('circuit-board');
        boardItem.tooltip = project.board?.target;
        items.push(boardItem);

        const status = this.state.status ?? (await this.state.refresh());

        const cargo = new vscode.TreeItem(`cargo ${status.cargo.found ? status.cargo.version ?? '' : 'not found'}`, vscode.TreeItemCollapsibleState.None);
        cargo.iconPath = new vscode.ThemeIcon(status.cargo.found ? 'pass' : 'error');
        cargo.description = status.cargo.path;
        items.push(cargo);

        const probeRs = new vscode.TreeItem(`probe-rs ${status.probeRs.found ? status.probeRs.version ?? '' : 'not found'}`, vscode.TreeItemCollapsibleState.None);
        probeRs.iconPath = new vscode.ThemeIcon(status.probeRs.found ? 'pass' : 'error');
        probeRs.description = status.probeRs.path;
        items.push(probeRs);

        const targets = new vscode.TreeItem('targets', vscode.TreeItemCollapsibleState.None);
        targets.iconPath = new vscode.ThemeIcon(status.missingTargets.length === 0 ? 'pass' : 'warning');
        targets.description =
            status.missingTargets.length === 0 ? 'all installed' : `missing ${status.missingTargets.join(', ')}`;
        items.push(targets);

        const probeIcon =
            status.probeDiagnosis.kind === 'ok' ? 'pass' : status.probes.length > 0 ? 'warning' : 'circle-slash';
        const probe = new vscode.TreeItem(status.probes[0]?.name ?? 'no debug probe', vscode.TreeItemCollapsibleState.None);
        probe.iconPath = new vscode.ThemeIcon(probeIcon);
        probe.description = status.probeDiagnosis.message;
        probe.tooltip = status.probeDiagnosis.raw ?? status.probeDiagnosis.message;
        probe.command =
            status.probeDiagnosis.kind === 'firmware-outdated'
                ? { command: 'rustyPlatform.updateProbeFirmware', title: 'Update Probe Firmware' }
                : { command: 'rustyPlatform.showProbes', title: 'Show Probes' };
        items.push(probe);

        if (status.platform === 'linux') {
            const udev = new vscode.TreeItem('USB permissions', vscode.TreeItemCollapsibleState.None);
            udev.iconPath = new vscode.ThemeIcon(status.udevRulesPresent ? 'pass' : 'warning');
            udev.description = status.udevRulesPresent ? 'udev rules installed' : 'udev rules missing';
            udev.command = { command: 'rustyPlatform.installUdevRules', title: 'Install USB Permissions' };
            items.push(udev);
        }

        return items;
    }

    refresh(): void {
        this.emitter.fire();
    }
}
