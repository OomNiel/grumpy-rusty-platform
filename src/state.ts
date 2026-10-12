import * as path from 'path';
import * as vscode from 'vscode';
import { detectToolchain, ToolchainStatus } from './toolchain/detect';
import { cargoBinDir, execFileFn } from './util/exec';
import { espTargets, rpTargets } from './boards/catalog';
import { chipsForTargets, EspToolchainStatus, espToolchainSummary } from './toolchain/espToolchain';
import { detectEspToolchainNow } from './toolchain/espDetect';
import { cargoVisibleOnShellPath, HealthFamily } from './toolchain/health';
import type { HealthSummaryInput } from './ui/controls';
import { readActiveProject } from './project/activeProject';

/**
 * Shared, cached toolchain state. Views and the status bar subscribe to
 * `onDidChange` instead of each running their own detection.
 */
export class RustyState implements vscode.Disposable {
    private current: ToolchainStatus | undefined;
    private currentEsp: EspToolchainStatus | undefined;
    private currentFamily: HealthFamily = 'unknown';
    private projectOpen = false;
    private readonly emitter = new vscode.EventEmitter<void>();
    private disposables: vscode.Disposable[] = [];

    readonly onDidChange = this.emitter.event;

    constructor(private readonly output: vscode.OutputChannel) {
        this.disposables.push(this.emitter);
    }

    get status(): ToolchainStatus | undefined {
        return this.current;
    }

    get espStatus(): EspToolchainStatus | undefined {
        return this.currentEsp;
    }

    /** Which silicon the open project is for. `unknown` when the workspace holds no project. */
    get family(): HealthFamily {
        return this.currentFamily;
    }

    /**
     * Whether a workspace folder holds a Rusty Platform project: a folder with a `Cargo.toml`. That is the
     * same rule the Project view's "No Rusty Platform project in this workspace" already uses, so the status
     * bar and the sidebar cannot disagree about whether there is a project.
     */
    get hasProject(): boolean {
        return this.projectOpen;
    }

    /**
     * Everything the health row needs, in one object.
     *
     * The ESP toolchain is only detected for an ESP project: it costs three process spawns, and for a
     * Raspberry Pi workspace its state is a line of information, never a problem (see
     * `toolchain/health.ts`).
     */
    get healthInput(): HealthSummaryInput {
        return {
            status: this.current,
            esp: this.currentEsp,
            family: this.currentFamily,
            cargoOnShellPath: cargoVisibleOnShellPath(process.env.PATH, cargoBinDir(), path.delimiter),
        };
    }

    /**
     * Which family the open project belongs to, and whether there is a project at all.
     *
     * `readActiveProject` reads the first workspace folder with a `Cargo.toml` and works out the board
     * from its contents, which is the same answer the Build/Flash buttons act on — so the health row
     * cannot report for one board while the controls flash another. `hasProject` is that same answer
     * reduced to a yes/no, which is what the status bar gates its action controls on.
     */
    private async detectActiveProject(): Promise<{ family: HealthFamily; hasProject: boolean }> {
        try {
            const project = await readActiveProject();
            return { family: project?.board?.kind ?? 'unknown', hasProject: project !== undefined };
        } catch (error) {
            this.log(`project detection failed: ${String(error)}`);
            return { family: 'unknown', hasProject: false };
        }
    }

    /** Re-detect the toolchain. Cheap enough to call on every relevant action. */
    async refresh(): Promise<ToolchainStatus> {
        const config = vscode.workspace.getConfiguration('rustyPlatform');
        try {
            this.current = await detectToolchain(execFileFn, {
                cargoPath: config.get<string>('cargoPath'),
                probeRsPath: config.get<string>('probeRsPath'),
                requiredTargets: rpTargets(),
            });
            const active = await this.detectActiveProject();
            this.projectOpen = active.hasProject;
            this.currentFamily = active.family;
            this.currentEsp = this.currentFamily === 'esp'
                ? await detectEspToolchainNow({ chips: chipsForTargets(espTargets()) })
                : undefined;
            this.log(
                `toolchain: family=${this.currentFamily} cargo=${this.current.cargo.version ?? 'missing'} ` +
                `probe-rs=${this.current.probeRs.version ?? 'missing'} ` +
                `missingTargets=[${this.current.missingTargets.join(', ')}] ` +
                `probe=${this.current.probeDiagnosis.kind}` +
                (this.currentEsp === undefined ? '' : ` esp=${espToolchainSummary(this.currentEsp)}`),
            );
        } catch (error) {
            this.log(`toolchain detection failed: ${String(error)}`);
            this.current = undefined;
        }
        this.emitter.fire();
        return this.current as ToolchainStatus;
    }

    log(message: string): void {
        this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
    }

    dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
    }
}
