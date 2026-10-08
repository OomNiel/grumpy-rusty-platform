/**
 * The designer's stylesheet, as a string the panel injects.
 *
 * Kept in TypeScript rather than as a `.css` file so the bundle stays a single script and the packaging stays
 * simple: a stylesheet file would need its own URI decision, its own entry in the local-resource roots, and
 * its own line in the `.vscodeignore` reasoning. It is a small, self-contained sheet.
 *
 * The colours are VS Code's own theme variables, so the panel looks native in a light or a dark window. The
 * *canvas* is a different matter and does not follow the theme: it shows the board's dark palette, because
 * that is what the board will show.
 */

export function designerStyles(): string {
    return `
* { box-sizing: border-box; }

body {
    margin: 0;
    padding: 0;
    height: 100vh;
    overflow: hidden;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
}

#designer {
    display: grid;
    grid-template-rows: auto 1fr auto;
    height: 100vh;
}

/* The toolbar */

.toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
}

.tool-button, .secondary-button, .toolbox-item, .layer-name, .icon-button {
    font-family: inherit;
    font-size: inherit;
    color: var(--vscode-foreground);
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    border: 1px solid transparent;
    border-radius: 3px;
    padding: 3px 8px;
    cursor: pointer;
}

.tool-button:hover, .secondary-button:hover, .toolbox-item:hover, .icon-button:hover {
    background: var(--vscode-button-secondaryHoverBackground, #45494e);
}

.tool-button:disabled, .icon-button:disabled {
    opacity: 0.45;
    cursor: default;
}

.tool-select, .field-input {
    font-family: inherit;
    font-size: inherit;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    border-radius: 3px;
    padding: 2px 4px;
}

.toolbar-separator {
    width: 1px;
    height: 18px;
    background: var(--vscode-panel-border);
    margin: 0 4px;
}

.toolbar-spacer { flex: 1; }

.toolbar-note {
    opacity: 0.7;
    font-variant-numeric: tabular-nums;
}

/* The three panes */

.body {
    display: grid;
    grid-template-columns: 180px 1fr 260px;
    min-height: 0;
}

.pane {
    min-height: 0;
    overflow: auto;
}

.toolbox, .properties {
    padding: 6px 8px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-right: 1px solid var(--vscode-panel-border);
}

.properties {
    border-right: none;
    border-left: 1px solid var(--vscode-panel-border);
}

.stage {
    overflow: auto;
    padding: 12px;
    /* A checkerboard would fight the canvas; a flat surface lets the panel read as the panel. */
    background: var(--vscode-editor-background);
}

.canvas {
    display: block;
    /* The canvas is drawn at design size and scaled here, so a click only has to be divided by the zoom. */
    image-rendering: pixelated;
    box-shadow: 0 0 0 1px var(--vscode-panel-border);
    cursor: crosshair;
    touch-action: none;
}

/* Panels */

.panel-title {
    margin: 0 0 6px;
    font-size: 1.05em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.85;
}

.group-title {
    margin: 8px 0 4px;
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.6;
}

.toolbox-group { margin-bottom: 6px; }

.toolbox-item {
    display: block;
    width: 100%;
    margin-bottom: 2px;
    text-align: left;
}

.toolbox-item.has-caveat::after {
    content: ' *';
    opacity: 0.6;
}

.panel-section {
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
}

.field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    margin-bottom: 3px;
}

.field-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.field-input { flex: 1; min-width: 0; }
.field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px; }
.field-grid .field { margin: 0; }

.field-static {
    flex: 1;
    opacity: 0.8;
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

/* A property the code generator ignores: visible, but marked as not doing anything. */
.field-ignored .field-label { opacity: 0.55; text-decoration: line-through dotted; }

.color-field { display: flex; gap: 4px; align-items: center; }
.color-field input[type="color"] { padding: 0; width: 28px; height: 22px; }

.panel-note {
    margin: 4px 0;
    font-size: 0.9em;
    opacity: 0.7;
    line-height: 1.35;
}

.panel-empty { opacity: 0.7; }

.layer-list { list-style: none; margin: 0; padding: 0; }

.layer-item {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 1px 0;
}

.layer-item.is-selected .layer-name {
    background: var(--vscode-list-activeSelectionBackground, #094771);
    color: var(--vscode-list-activeSelectionForeground, #ffffff);
}

.layer-name {
    flex: 1;
    min-width: 0;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.icon-button { padding: 1px 5px; }
.icon-button.danger { color: var(--vscode-errorForeground, #f48771); }

/* The footer */

.footer {
    padding: 3px 8px;
    border-top: 1px solid var(--vscode-panel-border);
    font-size: 0.9em;
    opacity: 0.85;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.footer.is-problem {
    color: var(--vscode-errorForeground, #f48771);
    opacity: 1;
}

.problem-list {
    margin: 4px 0 0;
    padding-left: 18px;
    color: var(--vscode-errorForeground, #f48771);
    font-size: 0.9em;
    line-height: 1.4;
}
`;
}
