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

/* A switch for a two-state project setting (SD, SMTP). The checkbox is the control -- focusable and
   toggled by its label -- and the track/thumb are the drawing. The label names its own colour for the
   same reason every button does: a webview element does not inherit one, and the default would be
   black on a dark toolbar. */
.tool-toggle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--vscode-foreground);
    cursor: pointer;
    user-select: none;
}

/* Named again rather than inherited, so the label is legible even if it is ever moved out of the wrapper
   -- the same rule every button class follows. */
.tool-toggle-label {
    color: var(--vscode-foreground);
}

/* Visually hidden but still the control: the keyboard reaches it and the label toggles it. */
.tool-toggle-input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    margin: 0;
}

.tool-toggle-track {
    position: relative;
    width: 26px;
    height: 14px;
    box-sizing: border-box;
    border-radius: 7px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    transition: background 80ms linear, border-color 80ms linear;
}

.tool-toggle-thumb {
    position: absolute;
    top: 1px;
    left: 1px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--vscode-foreground);
    transition: left 80ms linear, background 80ms linear;
}

.tool-toggle-input:checked + .tool-toggle-track {
    background: var(--vscode-button-background);
    border-color: var(--vscode-button-background);
}

.tool-toggle-input:checked + .tool-toggle-track .tool-toggle-thumb {
    left: 13px;
    background: var(--vscode-button-foreground);
}

.tool-toggle-input:focus-visible + .tool-toggle-track {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
}

.tool-toggle-input:disabled + .tool-toggle-track,
.tool-toggle-input:disabled ~ .tool-toggle-label {
    opacity: 0.45;
    cursor: default;
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
    /* The middle track can shrink to nothing, so a design wider than the window scrolls inside the stage
       instead of pushing the property pane off the side of the panel. */
    grid-template-columns: 180px minmax(0, 1fr) 260px;
    min-height: 0;
}

.pane {
    min-height: 0;
    /* Vertical scrolling in practice: every row in a pane is built to shrink to the width it is handed, which
       is what the rules below are for. */
    overflow: auto;
}

/* Nothing in a pane may be wider than the pane.
 *
 * Belt and braces beside the zero minimums below: it is a flex or grid item's own *minimum* that pushes a
 * setting off the side (an input's default width, a select's widest option), and a maximum is what stops
 * anything that cannot shrink any other way from doing the same. A user should never have to scroll a pane
 * sideways to reach a field. */
.toolbox *,
.properties * {
    max-width: 100%;
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

.field-group {
    margin: 8px 0 4px;
    font-size: 0.8em;
    font-weight: 600;
    opacity: 0.7;
}

.field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    margin-bottom: 3px;
    min-width: 0;
}

/* The label gives up width first, and shows an ellipsis where it did; the control keeps the rest. A label that
   insists on its whole text is half of what puts a setting off the side of the pane. */
.field-label {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

/* Whatever a row holds besides its label takes the width that is left, and may shrink to nothing. */
.field > :not(.field-label) { flex: 1 1 0; min-width: 0; }

/* A checkbox is a box, not a field: it keeps its own size rather than stretching across the row. */
.field > input[type="checkbox"] { flex: 0 0 auto; width: auto; }

.field-input { flex: 1 1 0; width: 100%; min-width: 0; }

/* A path field is an input and its '...' button sharing one row. Without a flex row of its own, the input's
   default width and the button sit on a single unbreakable line -- there is no whitespace between them -- and
   the row is then wider than any pane. That was the setting that ran off the side. */
.asset-field {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1 1 0;
    min-width: 0;
}

.asset-field > .field-input { flex: 1 1 0; min-width: 0; }
.asset-field > button { flex: 0 0 auto; }

/* Two columns that may each shrink to nothing. With the grid's default 'auto' minimum, the number inputs'
   own widths decide the columns, and the geometry fields run off the side of the pane. */
.field-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 2px 8px; }
.field-grid .field { margin: 0; min-width: 0; }

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

.color-field { display: flex; gap: 4px; align-items: center; flex: 1 1 0; min-width: 0; }
.color-field > button { flex: 0 0 auto; }
.color-field input[type="color"] { padding: 0; width: 28px; height: 22px; min-width: 28px; }

/* The text areas a table or an option list is typed into: as wide as the pane, never wider. */
textarea.field-input { resize: vertical; }

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

/* The right-click menu on a placed control */

.context-menu {
    position: absolute;
    z-index: 10;
    min-width: 150px;
    padding: 3px;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
    border-radius: 3px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}

.context-item {
    display: block;
    width: 100%;
    padding: 4px 8px;
    text-align: left;
    /* A button element does not inherit color: left unset it is drawn in the browser's default button text,
       which is black, and disappears on a dark menu. Only the danger row and a hovered row named a colour,
       which is why Delete and the row under the pointer were the two that looked right. Naming the theme's own
       menu foreground here is what keeps every row legible in a light window as well as a dark one. */
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    background: transparent;
    border: none;
    border-radius: 2px;
}

.context-item:hover {
    background: var(--vscode-menu-selectionBackground, #094771);
    color: var(--vscode-menu-selectionForeground, #ffffff);
}

.context-item.danger { color: var(--vscode-errorForeground, #f48771); }

/* What a load changed, and what stopped the markup being written -- both under the properties. */

.load-notes {
    margin: 4px 0 0;
    padding-left: 18px;
    font-size: 0.9em;
    line-height: 1.4;
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
