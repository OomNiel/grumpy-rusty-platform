import * as vscode from 'vscode';
import { RustyState } from '../state';
import { ActiveProject, readActiveProject } from '../project/activeProject';
import { ParsedDependency, parseCargoToml } from '../library/cargoToml';
import { coreIdFor, detectArduino, readSketchYaml } from '../toolchain/arduinoCli';
import { fqbnFromSketchYaml } from '../generate/arduinoIntelliSense';
import { execFileFn } from '../util/exec';
import { UDEV_RULES_DIR } from '../toolchain/detect';

/** Project view: what this workspace targets, whether it can build, and what it depends on. */
export class ProjectViewProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.emitter.event;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly state: RustyState) {
        // A Cargo.toml change — ours or the user's — redraws the dependency list.
        const watcher = vscode.workspace.createFileSystemWatcher('**/Cargo.toml');
        this.disposables.push(
            watcher,
            watcher.onDidChange(() => this.refresh()),
            watcher.onDidCreate(() => this.refresh()),
            watcher.onDidDelete(() => this.refresh()),
        );
    }

    dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables.length = 0;
    }

    /**
     * The rows a sketch needs: arduino-cli itself, the core its board is built with, and the board.
     *
     * Read here rather than kept in the state, because a sketch's toolchain is only ever looked at when a C++
     * project's view is drawn, and both calls are quick reads of the CLI's own index.
     */
    private async arduinoRows(project: ActiveProject): Promise<vscode.TreeItem[]> {
        const status = await detectArduino(execFileFn);
        const cli = new vscode.TreeItem(
            `arduino-cli ${status.version ?? 'not found'}`,
            vscode.TreeItemCollapsibleState.None,
        );
        cli.iconPath = new vscode.ThemeIcon(status.cli === undefined ? 'error' : 'pass');
        cli.description = status.cli;
        cli.tooltip = status.trouble;

        const rows = [cli];
        const sketchYaml = readSketchYaml(project.folder.fsPath);
        const fqbn = sketchYaml === undefined ? undefined : fqbnFromSketchYaml(sketchYaml);
        if (fqbn === undefined) {
            const missing = new vscode.TreeItem('no board in sketch.yaml', vscode.TreeItemCollapsibleState.None);
            missing.iconPath = new vscode.ThemeIcon('warning');
            rows.push(missing);
            return rows;
        }

        const core = coreIdFor(fqbn);
        const installed = status.cores.find((candidate) => candidate.id === core);
        const coreRow = new vscode.TreeItem(
            `core ${installed === undefined ? `${core} not installed` : `${core} ${installed.version}`}`,
            vscode.TreeItemCollapsibleState.None,
        );
        coreRow.iconPath = new vscode.ThemeIcon(installed === undefined ? 'error' : 'pass');
        coreRow.description = fqbn;
        rows.push(coreRow);

        const board = new vscode.TreeItem(
            project.board?.name ?? 'Unknown board',
            vscode.TreeItemCollapsibleState.None,
        );
        board.iconPath = new vscode.ThemeIcon('circuit-board');
        board.description = 'board';
        rows.push(board);
        return rows;
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (element instanceof DependenciesGroup) {
            return element.dependencies.map((dependency) => new DependencyItem(element.cargoTomlUri, dependency));
        }

        const items: vscode.TreeItem[] = [];
        const project = await readActiveProject();

        if (!project) {
            const none = new vscode.TreeItem('No Rusty Platform project in this workspace', vscode.TreeItemCollapsibleState.None);
            none.iconPath = new vscode.ThemeIcon('info');
            none.command = { command: 'rustyPlatform.newProject', title: 'New Project' };
            return [none];
        }

        if (project.language === 'arduino') {
            // A sketch has no Cargo.toml, no probe-rs and no rustup targets: cargo 'not found' in red would be a
            // warning about a tool this project never uses.
            items.push(...(await this.arduinoRows(project)));
            return items;
        }

        const boardItem = new vscode.TreeItem(project.board?.name ?? 'Unknown board', vscode.TreeItemCollapsibleState.None);
        boardItem.description = project.chip ? `chip ${project.chip}` : undefined;
        boardItem.iconPath = new vscode.ThemeIcon('circuit-board');
        boardItem.tooltip = project.board?.target;
        items.push(boardItem);

        // The dependency table, read from the same parser the Library Manager writes with.
        const model = parseCargoToml(project.cargoToml);
        items.push(
            new DependenciesGroup(model.dependencies, vscode.Uri.joinPath(project.folder, 'Cargo.toml')),
        );

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
            status.probeDiagnosis.kind === 'ok' || status.probeDiagnosis.kind === 'chip-not-autodetected'
                ? 'pass'
                : status.probes.length > 0
                    ? 'warning'
                    : 'circle-slash';
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
            udev.description = status.udevRulesPresent ? 'probe access granted' : 'no rule for a probe';
            udev.tooltip = status.udevRulesPresent
                ? `Granted by a rule in ${UDEV_RULES_DIR}, or by probe-rs already opening the probe.`
                : 'Install a udev rule so probe-rs can open a probe without root.';
            udev.command = { command: 'rustyPlatform.installUdevRules', title: 'Install USB Permissions' };
            items.push(udev);
        }

        return items;
    }

    refresh(): void {
        this.emitter.fire();
    }
}

/** The collapsible "Dependencies (n)" node; its children are the entries of `[dependencies]`. */
class DependenciesGroup extends vscode.TreeItem {
    constructor(
        readonly dependencies: ParsedDependency[],
        readonly cargoTomlUri: vscode.Uri,
    ) {
        super(
            `Dependencies${dependencies.length > 0 ? ` (${dependencies.length})` : ''}`,
            dependencies.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        this.iconPath = new vscode.ThemeIcon('library');
        this.contextValue = 'rustyPlatform.dependencies';
        this.description = dependencies.length === 0 ? 'none yet' : undefined;
        this.tooltip = 'The [dependencies] table of Cargo.toml';
    }
}

/** One dependency; clicking it opens Cargo.toml at that line. */
class DependencyItem extends vscode.TreeItem {
    constructor(cargoTomlUri: vscode.Uri, dependency: ParsedDependency) {
        super(dependency.name, vscode.TreeItemCollapsibleState.None);
        this.description = describe(dependency);
        this.iconPath = new vscode.ThemeIcon('package');
        this.tooltip = dependency.lines.join('\n');
        this.contextValue = 'rustyPlatform.dependency';
        this.command = {
            command: 'rustyPlatform.revealDependency',
            title: 'Show in Cargo.toml',
            arguments: [cargoTomlUri, dependency.startLine],
        };
    }
}

function describe(dependency: ParsedDependency): string {
    const parts: string[] = [];
    if (dependency.version !== undefined && dependency.version !== '') {
        parts.push(dependency.version);
    }
    if (dependency.features.length > 0) {
        parts.push(`${dependency.features.length} feature${dependency.features.length === 1 ? '' : 's'}`);
    }
    if (dependency.form === 'opaque') {
        parts.push('unrecognised form');
    }
    return parts.join(' · ');
}
