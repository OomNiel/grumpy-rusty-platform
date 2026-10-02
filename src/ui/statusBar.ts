import * as vscode from 'vscode';
import { RustyState } from '../state';

/** Status bar buttons: board/toolchain health plus one-click Build / Flash / Monitor. */
export class StatusBarView implements vscode.Disposable {
    private readonly items: vscode.StatusBarItem[] = [];
    private readonly healthItem: vscode.StatusBarItem;

    constructor(private readonly state: RustyState) {
        const create = (priority: number, command: string) => {
            const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
            item.command = command;
            this.items.push(item);
            return item;
        };

        this.healthItem = create(100, 'rustyPlatform.checkToolchain');
        create(99, 'rustyPlatform.build').text = '$(tools) Build';
        create(98, 'rustyPlatform.flash').text = '$(zap) Flash';
        create(97, 'rustyPlatform.monitor').text = '$(output) Monitor';

        this.update();
    }

    update(): void {
        const status = this.state.status;
        if (!status) {
            this.healthItem.text = '$(chip) Rusty: detecting…';
            this.healthItem.tooltip = 'Detecting the Rust toolchain…';
        } else if (status.ready) {
            this.healthItem.text = '$(chip) Rusty: ready';
            this.healthItem.tooltip = new vscode.MarkdownString(
                [
                    `**cargo** ${status.cargo.version ?? '?'}`,
                    `**probe-rs** ${status.probeRs.version ?? '?'}`,
                    `**targets** ${status.installedTargets.filter((t) => t !== 'x86_64-unknown-linux-gnu').join(', ')}`,
                    `**probe** ${status.probes[0]?.name ?? 'none'} — ${status.probeDiagnosis.message}`,
                ].join('  \n'),
            );
        } else {
            this.healthItem.text = '$(warning) Rusty: setup needed';
            this.healthItem.tooltip = [
                status.cargo.found ? undefined : 'cargo is not installed',
                status.probeRs.found ? undefined : 'probe-rs is not installed',
                status.missingTargets.length > 0 ? `missing targets: ${status.missingTargets.join(', ')}` : undefined,
                status.probeDiagnosis.kind === 'ok' ? undefined : status.probeDiagnosis.message,
            ]
                .filter((line): line is string => Boolean(line))
                .join('\n');
        }
        for (const item of this.items) {
            item.show();
        }
    }

    dispose(): void {
        for (const item of this.items) {
            item.dispose();
        }
        this.items.length = 0;
    }
}
