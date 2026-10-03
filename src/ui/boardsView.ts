import * as vscode from 'vscode';
import { BOARDS } from '../boards/catalog';
import { BoardProfile } from '../boards/types';

/** Board Manager: every supported board, click to start the project wizard. */
export class BoardsViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.emitter.event;

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): vscode.TreeItem[] {
        return BOARDS.map((board) => new BoardItem(board));
    }

    refresh(): void {
        this.emitter.fire();
    }
}

class BoardItem extends vscode.TreeItem {
    constructor(board: BoardProfile) {
        super(board.name, vscode.TreeItemCollapsibleState.None);
        this.description = `${board.family} · ${board.target}`;
        this.iconPath = new vscode.ThemeIcon('circuit-board');

        // RP boards are flashed through a probe, ESP boards over USB serial with espflash.
        // Showing probe-rs' chip id for an ESP board would be actively misleading.
        const tooling =
            board.kind === 'rp'
                ? [
                    `- probe-rs chip: \`${board.probeChip}\``,
                    `- embassy features: \`${board.embassyFeatures.join(', ')}\``,
                ]
                : [
                    `- espflash chip: \`${board.espChip}\``,
                    `- flash: \`${board.flashSize}\``,
                    board.displays.length > 0
                        ? `- panel: \`${board.displays.map((d) => d.label).join(' / ')}\``
                        : '- panel: none',
                ];

        this.tooltip = new vscode.MarkdownString(
            [
                `**${board.name}**`,
                '',
                board.notes,
                '',
                ...tooling,
                `- target: \`${board.target}\``,
            ].join('\n'),
        );
        this.contextValue = 'board';
        this.command = {
            command: 'rustyPlatform.newProject',
            title: 'New Project',
            arguments: [board.id],
        };
    }
}
