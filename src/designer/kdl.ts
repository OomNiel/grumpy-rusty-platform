/**
 * Emitting the KDL the firmware compiles.
 *
 * The markup is a build artifact: `src/ui.rs` in a generated project calls
 * `embedded_gui::include_gui!("src/ui.kdl")`, and `embedded-gui-macros` reads this file at compile time and
 * turns it into typed `no_std` Rust. So this module's job is narrow and testable -- turn the document into
 * text the crate's parser accepts, with nothing invented.
 *
 * Three decisions are worth stating, because each one is a place where markup that *looks* right would in
 * fact build to something else:
 *
 * - **Every track is in pixels.** `parse_tracks` accepts `Nfr` as well as `Npx`, but a fractional track lets
 *   the layout engine redistribute space, so the positions on the glass would stop matching the canvas.
 * - **`gap` and `padding` are zero.** They are what make the track boundaries land exactly on the widgets'
 *   own edges (see `grid.ts`). Any other value would shift every widget by a few pixels.
 * - **An empty string is omitted, not written.** Several properties are optional in the parser's eyes
 *   (`tint`, `font`, `unit`), and it distinguishes "absent" from "present and empty" -- a written-out
 *   `tint=""` would be handed to the colour parser rather than treated as no tint.
 *
 * Booleans are written bare (`checked=true`), which is what the crate's own serializer writes and what its
 * test fixtures use; strings are quoted and escaped; colours stay the `#rrggbb` the user picked, since the
 * crate converts them to RGB565 itself.
 */

import { type DesignerDocument, type DesignerIconPart, type DesignerWidget, validateDocument } from './model';
import { designCanvasSize } from './model';
import { layoutToGrid, trackSpec, type GridLayout } from './grid';
import { widgetSpec } from './catalog';
import { supportsFontAttribute } from './fonts';
import { appearanceExpression, styleValuesOf } from './appearance';

/** Escapes a value for a KDL quoted string. */
function quote(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** How a property value is written: numbers and booleans bare, everything else quoted. */
function literal(value: string | number | boolean): string {
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }
    if (typeof value === 'number') {
        return String(value);
    }
    return quote(value);
}

/**
 * True when a property should not appear in the markup at all.
 *
 * Deliberately only the empty string: a `0` or a `false` is a real value the user chose, and dropping it
 * would let the parser's own default take over and quietly disagree with the canvas.
 */
function isEmpty(value: string | number | boolean | undefined): boolean {
    return value === undefined || value === '';
}

function iconPartLine(part: DesignerIconPart, indent: string): string {
    const parts = [`src=${quote(part.src)}`, `x=${part.x}`, `y=${part.y}`];
    if (part.visible === false) {
        parts.push('visible=false');
    }
    if (!isEmpty(part.tint)) {
        parts.push(`tint=${quote(part.tint)}`);
    }
    return `${indent}part ${parts.join(' ')}`;
}

/** The widget's opening line: tag, id, the properties in catalogue order, then the grid placement. */
function widgetLine(
    widget: DesignerWidget,
    placement: { col: number; row: number; colSpan: number; rowSpan: number },
    indent: string,
    declared: ReadonlySet<string> = new Set(),
): string {
    const spec = widgetSpec(widget.tag);
    const parts = [`${widget.tag} id=${quote(widget.id)}`];

    // The base style, a built-in font and the widget's own colours are not separate attributes: a built-in font
    // *is* a style expression (the markup has no attribute for the crate's own fonts), and a colour the tag has
    // no field for has to ride in the same expression. So all of them are composed into one, and the properties
    // that travelled that way are skipped by the loop below. See `src/designer/appearance.ts`.
    const values = styleValuesOf(widget, spec?.props ?? []);
    // A declared font reaches a widget that does not read a `font` attribute the way the crate's own faces do:
    // through `style.font`, naming the `BitmapFont` static the asset pipeline emits for it. Labels and carousels
    // keep the attribute, which is the one the codegen rewrites for them.
    const chosen = widget.props.font;
    const viaStyleFont =
        spec !== undefined
        && !supportsFontAttribute(spec.fontSupport)
        && typeof chosen === 'string'
        && declared.has(chosen);
    if (viaStyleFont) {
        values.font = chosen as string;
        values.declaredFont = true;
    }
    const appearance = appearanceExpression({
        tag: widget.tag,
        style: typeof widget.props.style === 'string' ? widget.props.style : undefined,
        values,
    });

    // A circle is not emitted with its catalogue property names: the codegen parser reads `stroke_width`,
    // `fill` and `stroke` (colour strings, which it RGB565-ifies itself) and derives the radius from the cell
    // rect, so the designer props are mapped onto those names and the generic property loop below is skipped.
    if (spec?.draws === 'circle') {
        const thickness = widget.props.line_thickness;
        if (!isEmpty(thickness)) {
            parts.push(`stroke_width=${literal(thickness as number)}`);
        }
        // `fill` is a designer bool: only a true one hands the codegen a fill colour, and only when the
        // designer actually named one. `radius` is never emitted -- the board derives it from the rect.
        if (widget.props.fill === true && !isEmpty(widget.props.fill_color)) {
            parts.push(`fill=${literal(widget.props.fill_color as string)}`);
        }
        const outline = widget.props.line_color;
        if (!isEmpty(outline)) {
            parts.push(`stroke=${literal(outline as string)}`);
        }
        parts.push(`col=${placement.col}`, `row=${placement.row}`);
        parts.push(`col_span=${placement.colSpan}`, `row_span=${placement.rowSpan}`);
        return `${indent}${parts.join(' ')}`;
    }

    for (const property of spec?.props ?? []) {
        const value = widget.props[property.name];
        if (isEmpty(value)) {
            continue;
        }
        // A property the designer keeps for itself: the clock's movement is about the generated
        // code-behind, not about the face the crate draws, so it has no attribute to write.
        if (property.designerOnly === true) {
            continue;
        }
        // A font that travelled in the style expression has no attribute of its own: a built-in never had
        // one, and a declared one took that route above.
        if (property.kind === 'font' && values.font !== undefined) {
            continue;
        }
        if (property.kind === 'style' || property.viaStyle !== undefined) {
            continue;
        }
        parts.push(`${property.name}=${literal(value as string | number | boolean)}`);
    }
    if (appearance !== undefined) {
        parts.push(`style=${literal(appearance)}`);
    }
    parts.push(`col=${placement.col}`, `row=${placement.row}`);
    parts.push(`col_span=${placement.colSpan}`, `row_span=${placement.rowSpan}`);
    return `${indent}${parts.join(' ')}`;
}

/** The widget's body, when its grammar has one. */
function childLines(widget: DesignerWidget, indent: string): string[] | undefined {
    const children = widget.children;
    if (children === undefined) {
        return undefined;
    }
    if (children.kind === 'options') {
        return children.values.map((value) => `${indent}option ${quote(value)}`);
    }
    if (children.kind === 'table') {
        const lines: string[] = [];
        if (children.headers.length > 0) {
            lines.push(`${indent}headers ${children.headers.map(quote).join(' ')}`);
        }
        for (const row of children.rows) {
            lines.push(`${indent}row ${row.map(quote).join(' ')}`);
        }
        return lines;
    }
    if (children.kind === 'lines') {
        // One `line` child per entry, not a newline-joined `text` attribute: an entry may itself contain a
        // quote or a backslash, and the attribute spelling would need those escaped twice over.
        return children.values.map((value) => `${indent}line ${quote(value)}`);
    }
    return children.parts.map((part) => iconPartLine(part, indent));
}

/**
 * Lays the document out and builds the `screen` node.
 *
 * Exposed separately from `emitKdl` because the canvas itself wants the same answer -- which track a dragged
 * widget landed on -- and having two implementations of that would defeat the point of testing one.
 */
export function layoutDocument(document: DesignerDocument): GridLayout {
    const canvas = designCanvasSize(document.panelWidth, document.panelHeight, document.rotation);
    return layoutToGrid(
        document.widgets.map((widget) => ({
            x: widget.x,
            y: widget.y,
            width: widget.width,
            height: widget.height,
        })),
        canvas.width,
        canvas.height,
    );
}

/**
 * The markup for the whole document.
 *
 * Refuses an invalid document rather than emitting markup that will not build: the editor validates on every
 * edit and shows the reasons, so reaching this with a bad document is a bug in the caller, and a build error
 * reading `GUI Codegen Error: MissingAttribute` is a much worse way to find out.
 */
export function emitKdl(document: DesignerDocument): string {
    const problems = validateDocument(document);
    if (problems.length > 0) {
        throw new Error(`the design is not valid: ${problems[0]}`);
    }

    const canvas = designCanvasSize(document.panelWidth, document.panelHeight, document.rotation);
    // Designer-native widgets paint themselves on the canvas but have no crate builder yet, so they are not
    // written into the board's markup: a valid design must still build even with a circle on it. They are
    // filtered out before the grid is laid out, so the widgets that do follow keep their placements aligned.
    const emittable = document.widgets.filter((widget) => widgetSpec(widget.tag)?.native !== true);
    const layout = layoutToGrid(
        emittable.map((widget) => ({ x: widget.x, y: widget.y, width: widget.width, height: widget.height })),
        canvas.width,
        canvas.height,
    );

    const attributes = [
        `id=${quote(document.screenId)}`,
        `width=${canvas.width}`,
        `height=${canvas.height}`,
    ];
    if (!isEmpty(document.theme)) {
        attributes.push(`theme=${quote(document.theme)}`);
    }

    const lines: string[] = [`screen ${attributes.join(' ')} {`];
    // The fonts come first, before the grid: a widget names one, and a reader that meets `font="title"` should
    // have met the declaration already. `chars` is left out when empty so the loader embeds every glyph.
    for (const font of document.fonts ?? []) {
        const parts = [`font id=${quote(font.id)}`, `src=${quote(font.src)}`];
        if (font.chars !== '') {
            parts.push(`chars=${quote(font.chars)}`);
        }
        lines.push(`    ${parts.join(' ')}`);
    }
    lines.push(
        `    grid cols=${quote(trackSpec(layout.cols))} rows=${quote(trackSpec(layout.rows))} gap=0 padding=0 {`,
    );

    // Which fonts are the screen's own: a widget naming one of these may be routed through the style.
    const declared = new Set((document.fonts ?? []).map((font) => font.id));
    for (let index = 0; index < emittable.length; index += 1) {
        const widget = emittable[index];
        const placement = layout.placements[index];
        if (widget === undefined || placement === undefined) {
            throw new Error('internal: the layout and the widget list disagree');
        }
        const children = childLines(widget, '            ');
        if (children === undefined || children.length === 0) {
            lines.push(widgetLine(widget, placement, '        ', declared));
            continue;
        }
        // Braces, not indentation. KDL has no indentation-based nesting: children written on deeper lines are
        // *siblings* of their widget, and codegen rejects them outright -- "Unknown widget or container node:
        // 'option'" -- so a dropdown or an icon produced markup that could not be parsed at all. The screen and
        // the grid were always braced, which is what made the omission here invisible.
        lines.push(`${widgetLine(widget, placement, '        ', declared)} {`);
        lines.push(...children);
        lines.push('        }');
    }

    lines.push('    }');
    lines.push('}');
    return `${lines.join('\n')}\n`;
}
