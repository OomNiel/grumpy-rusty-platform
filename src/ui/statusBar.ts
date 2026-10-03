import * as vscode from 'vscode';
import { RustyState } from '../state';
import { activeProbeRsSession } from '../project/debugSessions';
import {
    CONTROLS,
    ControlDescriptor,
    HEALTH_CONTROL,
    healthSummary,
    iconText,
    statusBarText,
} from './controls';

/**
 * Status bar buttons: board/toolchain health plus one-click Build / Flash / Debug / Debug Stop /
 * Monitor / Clean.
 *
 * The list itself lives in `ui/controls.ts`, because the sidebar's "Controls" section shows the same
 * buttons; this class is only the status-bar rendering of it.
 */
export class StatusBarView implements vscode.Disposable {
    private readonly items: vscode.StatusBarItem[] = [];
    private readonly disposables: vscode.Disposable[] = [];
    private readonly healthItem: vscode.StatusBarItem;
    /** Only shown while a probe-rs session is running — see updateSessionControls(). */
    private readonly sessionItems: vscode.StatusBarItem[] = [];

    constructor(private readonly state: RustyState) {
        // Priorities count down from the health item, which is how the status bar keeps its order.
        this.healthItem = this.create(HEALTH_CONTROL, 100);
        CONTROLS.filter((control) => control !== HEALTH_CONTROL).forEach((control, index) => {
            this.create(control, 99 - index);
        });

        this.disposables.push(
            vscode.debug.onDidStartDebugSession(() => this.updateSessionControls()),
            vscode.debug.onDidTerminateDebugSession(() => this.updateSessionControls()),
        );

        this.update();
    }

    /** One status bar item, spelled exactly as the sidebar section spells the same control. */
    private create(control: ControlDescriptor, priority: number): vscode.StatusBarItem {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
        item.command = control.command;
        item.text = statusBarText(control);
        item.tooltip = control.tooltip;
        this.items.push(item);
        if (control.sessionOnly === true) {
            this.sessionItems.push(item);
        }
        return item;
    }

    /**
     * The Stop button is only meaningful during a session, and only for sessions this extension
     * starts: another debugger's session is not ours to kill.
     */
    private updateSessionControls(): void {
        const running = activeProbeRsSession() !== undefined;
        for (const item of this.sessionItems) {
            if (running) {
                item.show();
            } else {
                item.hide();
            }
        }
    }

    update(): void {
        const health = healthSummary(this.state.status);
        this.healthItem.text = iconText(health.icon, health.label);
        this.healthItem.tooltip = new vscode.MarkdownString(health.markdown);

        for (const item of this.items) {
            if (!this.sessionItems.includes(item)) {
                item.show();
            }
        }
        this.updateSessionControls();
    }

    dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables.length = 0;
        for (const item of this.items) {
            item.dispose();
        }
        this.items.length = 0;
    }
}
