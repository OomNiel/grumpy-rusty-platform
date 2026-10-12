import * as vscode from 'vscode';
import { RustyState } from '../state';
import { activeProbeRsSession } from '../project/debugSessions';
import {
    ACTION_CONTROLS,
    ControlDescriptor,
    HEALTH_CONTROL,
    healthSummary,
    iconText,
    statusBarActions,
    statusBarText,
} from './controls';

/**
 * Status bar buttons: board/toolchain health plus one-click Build / Flash / Debug Stop / Monitor / Clean.
 *
 * The list itself lives in `ui/controls.ts`, because the sidebar's "Controls" section shows the same
 * buttons; this class is only the status-bar rendering of it.
 *
 * Two rules decide what is on screen, and both live in `controls.ts`:
 *  - the health row is always there: it is how the extension announces itself, and it already reports for a
 *    window with no project in it;
 *  - the action rows appear only while the window holds a Rusty Platform project, because Build, Flash and
 *    Monitor have nothing to act on otherwise (see `statusBarActions`).
 */
export class StatusBarView implements vscode.Disposable {
    private readonly items: vscode.StatusBarItem[] = [];
    /** The Build / Flash / … rows: hidden while no project is open (see `update()`). */
    private readonly actionItems: vscode.StatusBarItem[] = [];
    private readonly disposables: vscode.Disposable[] = [];
    private readonly healthItem: vscode.StatusBarItem;

    constructor(private readonly state: RustyState) {
        // Priorities count down from the health item, which is how the status bar keeps its order. Items are
        // created once from the full action list; which of them are *shown* is decided on every `update()`.
        this.healthItem = this.create(HEALTH_CONTROL, 100);
        ACTION_CONTROLS.forEach((control, index) => {
            this.create(control, 99 - index);
        });

        this.disposables.push(
            vscode.debug.onDidStartDebugSession(() => this.update()),
            vscode.debug.onDidTerminateDebugSession(() => this.update()),
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
        if (control !== HEALTH_CONTROL) {
            this.actionItems.push(item);
        }
        return item;
    }

    update(): void {
        const health = healthSummary(this.state.healthInput);
        this.healthItem.text = iconText(health.icon, health.label);
        this.healthItem.tooltip = new vscode.MarkdownString(health.markdown);
        this.healthItem.show();

        // One list answers both questions: which actions belong on screen at all (no project, no actions;
        // no probe-rs session, no Stop), and how each one is worded for the board in front of the user. The
        // captions never move — they are what the user has learned to press — only the tooltip does.
        const actions = new Map(
            statusBarActions(
                this.state.hasProject,
                activeProbeRsSession() !== undefined,
                this.state.family,
            ).map((control) => [control.command, control]),
        );
        for (const item of this.actionItems) {
            const control = typeof item.command === 'string' ? actions.get(item.command) : undefined;
            if (control === undefined) {
                item.hide();
                continue;
            }
            item.tooltip = control.tooltip;
            item.show();
        }
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
        this.actionItems.length = 0;
    }
}
