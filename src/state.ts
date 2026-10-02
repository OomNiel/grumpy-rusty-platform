import * as vscode from 'vscode';
import { detectToolchain, ToolchainStatus } from './toolchain/detect';
import { execFileFn } from './util/exec';
import { allTargets } from './boards/catalog';

/**
 * Shared, cached toolchain state. Views and the status bar subscribe to
 * `onDidChange` instead of each running their own detection.
 */
export class RustyState implements vscode.Disposable {
    private current: ToolchainStatus | undefined;
    private readonly emitter = new vscode.EventEmitter<void>();
    private disposables: vscode.Disposable[] = [];

    readonly onDidChange = this.emitter.event;

    constructor(private readonly output: vscode.OutputChannel) {
        this.disposables.push(this.emitter);
    }

    get status(): ToolchainStatus | undefined {
        return this.current;
    }

    /** Re-detect the toolchain. Cheap enough to call on every relevant action. */
    async refresh(): Promise<ToolchainStatus> {
        const config = vscode.workspace.getConfiguration('rustyPlatform');
        try {
            this.current = await detectToolchain(execFileFn, {
                cargoPath: config.get<string>('cargoPath'),
                probeRsPath: config.get<string>('probeRsPath'),
                requiredTargets: allTargets(),
            });
            this.log(
                `toolchain: cargo=${this.current.cargo.version ?? 'missing'} ` +
                `probe-rs=${this.current.probeRs.version ?? 'missing'} ` +
                `missingTargets=[${this.current.missingTargets.join(', ')}] ` +
                `probe=${this.current.probeDiagnosis.kind}`,
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
