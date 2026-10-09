/**
 * How the canvas paints each widget.
 *
 * This file exists because of what the simulator found: the markup's properties do not always reach the
 * pixels. A `rect` becomes a theme-styled panel whatever colour the user picked, a `line` draws nothing at
 * all, a button's background is painted over by a gradient the markup cannot turn off. A WYSIWYG canvas that
 * ignored all that and painted the user's choices would be confidently wrong about the one thing it exists
 * to show.
 *
 * The shapes have since shipped board-side renderers in `rusty-gui-widgets`, so `rect`, `line` and the
 * other shapes now paint their own colour on both the canvas and the glass -- but the rule is the same:
 * `draws` is the source of truth for what the canvas paints, and every tag is drawn here according to it.
 *
 * So every tag is drawn here according to `KDL_WIDGETS[].draws`, and the parts that are *not* what the
 * document says are drawn as such: nothing is a dashed outline, a theme panel is the theme's surface colour,
 * and a placeholder that needs an asset says so. Where a property does reach the pixels -- button labels,
 * a panel's text -- it is used.
 *
 * These colours are the designer's own approximation of the crate's dark theme so the canvas reads like the
 * board. They are not read from the crate: the point is what shapes are where, not an exact match of a
 * palette that the board decides for itself.
 */

import { widgetSpec } from '../../src/designer/catalog';
import { type DesignerWidget, circleCentre, circleRadius } from '../../src/designer/model';

export interface Palette {
    /** The screen behind everything. */
    screen: string;
    /** What a widget drawn for real looks like when it has no colour property of its own. */
    widget: string;
    /** A widget's border. */
    border: string;
    /** What the engine actually paints for a `rect` or a `circle`. */
    themePanel: string;
    /** Text drawn on a widget. */
    text: string;
    /** The selection outline. */
    selection: string;
    /** The resize handles. */
    handle: string;
    /** A guide line shown while snapping. */
    guide: string;
    /** Anything the board will not draw. */
    placeholder: string;
    /** Grid lines on the empty screen. */
    grid: string;
}

/** The dark theme, near enough to the crate's own to read as the same board. */
export const DARK_PALETTE: Palette = {
    screen: '#101418',
    widget: '#2a3138',
    border: '#4a545e',
    themePanel: '#1b2026',
    text: '#e6e9ec',
    selection: '#4ea1ff',
    handle: '#ffffff',
    guide: '#ff5d8f',
    placeholder: '#8a939c',
    grid: '#1a1f25',
};

/** How far the id label sits from a widget's top-left corner. */
const LABEL_INSET = 3;

/** Rounds a rectangle path, so a widget with corners looks like one. */
function roundedRect(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
): void {
    const r = Math.max(0, Math.min(radius, Math.floor(Math.min(width, height) / 2)));
    context.beginPath();
    if (r === 0) {
        context.rect(x, y, width, height);
        return;
    }
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
}

/** The text a widget shows, from whichever property its tag actually uses. */
function labelOf(widget: DesignerWidget): string {
    for (const name of ['text', 'label', 'title', 'unit']) {
        const value = widget.props[name];
        if (typeof value === 'string' && value !== '') {
            return value;
        }
    }
    return widgetSpec(widget.tag)?.label ?? widget.tag;
}

/**
 * Marks the space a widget occupies when nothing of it is painted.
 *
 * A designer has to show a control it would not otherwise draw -- a spacer, or a shape filled with nothing and
 * outlined with nothing -- or there is nothing to select. The dashes say "this is the designer talking, not the
 * design", which is the same distinction the id label makes.
 */
function placeholderOutline(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, palette: Palette): void {
    context.save();
    context.setLineDash([4, 3]);
    context.strokeStyle = palette.placeholder;
    context.lineWidth = 1;
    context.strokeRect(x + 0.5, y + 0.5, Math.max(0, width - 1), Math.max(0, height - 1));
    context.restore();
}

/** True when a property names a colour the board would actually paint. */
function hasColor(value: string | number | boolean | undefined): boolean {
    return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

/** A colour pulled from a widget's property, falling back to a palette swatch when it is absent or malformed. */
function colorProp(value: string | number | boolean | undefined, fallback: string): string {
    return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

/**
 * Paints a designer-native circle from its bounding rect.
 *
 * The rect carries the shape's geometry (centre and radius are derived from it), and four appearance
 * properties paint the arc: a fill the board has no equivalent for, and an outline of the chosen colour and
 * thickness. `line_thickness` of zero means "no outline", which is the only case the fallback border is not
 * needed.
 */
function paintCircle(context: CanvasRenderingContext2D, widget: DesignerWidget, palette: Palette): void {
    const { cx, cy } = circleCentre(widget);
    const radius = Math.max(0, circleRadius(widget));
    context.beginPath();
    context.arc(cx, cy, radius, 0, 2 * Math.PI);

    // Not filled means *nothing painted there*, not the screen colour painted over what is behind it: the
    // board passes `fill: None` and leaves the backdrop, so an erasing canvas would show a hole in an
    // overlapping shape that the glass does not have.
    const fill = widget.props.fill === true;
    if (fill) {
        context.fillStyle = colorProp(widget.props.fill_color, palette.themePanel);
        context.fill();
    }

    const thickness = typeof widget.props.line_thickness === 'number' ? widget.props.line_thickness : 1;
    if (thickness > 0) {
        context.strokeStyle = colorProp(widget.props.line_color, palette.border);
        context.lineWidth = thickness;
        context.stroke();
    } else if (!fill) {
        placeholderOutline(context, widget.x, widget.y, widget.width, widget.height, palette);
    }
}

/**
 * Paints a designer rectangle: its own fill colour on the cell, a stroke of the
 * chosen colour and thickness, and rounded corners from `radius`. Matches the
 * board's `rusty_gui_widgets::Rectangle`, which derives every dimension from the
 * cell rect.
 */
function paintRect(context: CanvasRenderingContext2D, widget: DesignerWidget, palette: Palette): void {
    const radius = typeof widget.props.radius === 'number' ? widget.props.radius : 0;
    context.fillStyle = colorProp(widget.props.fill, palette.widget);
    roundedRect(context, widget.x, widget.y, widget.width, widget.height, radius);
    context.fill();
    const sw = typeof widget.props.stroke_width === 'number' ? widget.props.stroke_width : 0;
    if (sw > 0) {
        context.strokeStyle = colorProp(widget.props.stroke, palette.border);
        context.lineWidth = sw;
        context.stroke();
    }
    if (!hasColor(widget.props.fill) && sw <= 0) {
        placeholderOutline(context, widget.x, widget.y, widget.width, widget.height, palette);
    }
}

/**
 * Paints a designer line: a single segment along the cell's longer axis, in the
 * chosen colour and thickness. Matches `rusty_gui_widgets::Line`, which the board
 * orients the same way from the rect.
 */
function paintLine(context: CanvasRenderingContext2D, widget: DesignerWidget, palette: Palette): void {
    const sw = typeof widget.props.stroke_width === 'number' ? widget.props.stroke_width : 1;
    const color = colorProp(widget.props.color, palette.border);
    context.strokeStyle = color;
    context.lineWidth = sw;
    context.beginPath();
    if (widget.width >= widget.height) {
        const y = widget.y + widget.height / 2;
        context.moveTo(widget.x, y);
        context.lineTo(widget.x + widget.width, y);
    } else {
        const x = widget.x + widget.width / 2;
        context.moveTo(x, widget.y);
        context.lineTo(x, widget.y + widget.height);
    }
    context.stroke();
}

/**
 * Paints a designer triangle inscribed in the cell: apex at the top edge centre,
 * base on the bottom edge. Fill and stroke follow `rusty_gui_widgets::Triangle`,
 * which derives the three vertices from the rect.
 */
function paintTriangle(context: CanvasRenderingContext2D, widget: DesignerWidget, palette: Palette): void {
    const cx = widget.x + widget.width / 2;
    context.beginPath();
    context.moveTo(cx, widget.y);
    context.lineTo(widget.x, widget.y + widget.height);
    context.lineTo(widget.x + widget.width, widget.y + widget.height);
    context.closePath();
    context.fillStyle = colorProp(widget.props.fill, palette.widget);
    context.fill();
    const sw = typeof widget.props.stroke_width === 'number' ? widget.props.stroke_width : 1;
    if (sw > 0) {
        context.strokeStyle = colorProp(widget.props.stroke, palette.border);
        context.lineWidth = sw;
        context.stroke();
    }
    if (!hasColor(widget.props.fill) && sw <= 0) {
        placeholderOutline(context, widget.x, widget.y, widget.width, widget.height, palette);
    }
}

/**
 * Draws one widget at its document rectangle.
 *
 * `offsetX`/`offsetY` are the canvas origin in *device* pixels, so the panel can draw at whatever zoom the
 * context has been scaled to without this function knowing about it.
 */
export function drawWidget(
    context: CanvasRenderingContext2D,
    widget: DesignerWidget,
    palette: Palette,
): void {
    const spec = widgetSpec(widget.tag);
    const draws = spec?.draws ?? 'widget';
    const { x, y, width, height } = widget;

    if (draws === 'nothing') {
        // A spacer reserves its space and paints none of it: show the space, mark it as empty.
        placeholderOutline(context, x, y, width, height, palette);
    } else {
        if (draws === 'circle') {
            paintCircle(context, widget, palette);
        } else if (draws === 'rectangle') {
            paintRect(context, widget, palette);
        } else if (draws === 'line') {
            paintLine(context, widget, palette);
        } else if (draws === 'triangle') {
            paintTriangle(context, widget, palette);
        } else {
            const radius = typeof widget.props.corner_radius === 'number' ? widget.props.corner_radius : 2;
            // A theme panel is what the engine paints for the shapes; everything else is a widget surface.
            const background = draws === 'panel' ? palette.themePanel : palette.widget;
            context.fillStyle = background;
            roundedRect(context, x, y, width, height, radius);
            context.fill();
            context.strokeStyle = palette.border;
            context.lineWidth = 1;
            context.stroke();
        }

        if (width > 16 && height > 12) {
            context.save();
            context.beginPath();
            context.rect(x, y, width, height);
            context.clip();
            context.fillStyle = palette.text;
            context.font = '11px sans-serif';
            context.textBaseline = 'middle';
            context.fillText(labelOf(widget), x + LABEL_INSET + 2, y + height / 2, width - 8);
            context.restore();
        }
    }

    // The widget's name, small, in the corner: the fastest way to find the one the property panel is showing.
    if (width > 24 && height > 14) {
        context.save();
        context.fillStyle = palette.placeholder;
        context.font = '9px sans-serif';
        context.textBaseline = 'top';
        context.fillText(widget.id, x + LABEL_INSET, y + LABEL_INSET, width - LABEL_INSET * 2);
        context.restore();
    }

    // An asset-backed widget will not build until its file exists, which is worth saying on the canvas.
    if (spec?.tag === 'image' || spec?.tag === 'mesh') {
        const source = widget.props.src;
        if (typeof source !== 'string' || source === '') {
            context.save();
            context.fillStyle = palette.placeholder;
            context.font = '9px sans-serif';
            context.textAlign = 'center';
            context.textBaseline = 'bottom';
            context.fillText('needs an asset', x + width / 2, y + height - 2);
            context.restore();
        }
    }
}

/** The eight handles around a selected widget. */
export function drawSelection(
    context: CanvasRenderingContext2D,
    widget: DesignerWidget,
    palette: Palette,
    handleSize: number,
): void {
    context.save();
    context.strokeStyle = palette.selection;
    context.lineWidth = 1;
    context.strokeRect(widget.x + 0.5, widget.y + 0.5, Math.max(0, widget.width - 1), Math.max(0, widget.height - 1));

    const half = Math.floor(handleSize / 2);
    const centres: [number, number][] = [
        [widget.x, widget.y],
        [widget.x + Math.floor(widget.width / 2), widget.y],
        [widget.x + widget.width, widget.y],
        [widget.x + widget.width, widget.y + Math.floor(widget.height / 2)],
        [widget.x + widget.width, widget.y + widget.height],
        [widget.x + Math.floor(widget.width / 2), widget.y + widget.height],
        [widget.x, widget.y + widget.height],
        [widget.x, widget.y + Math.floor(widget.height / 2)],
    ];
    context.fillStyle = palette.handle;
    for (const [cx, cy] of centres) {
        context.fillRect(cx - half, cy - half, handleSize, handleSize);
    }
    context.restore();
}
