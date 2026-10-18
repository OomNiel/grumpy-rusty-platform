/**
 * What the board actually paints, drawn on the designer's canvas.
 *
 * The canvas used to draw every widget as a rounded rectangle with its type name in it. That was honest
 * about *shapes* and wrong about *pixels*: a slider has a track and a knob, a progress bar is a bare white
 * fill, a button's gradient is the crate's own and no markup attribute clears it. This module is the crate's
 * paint, as arithmetic.
 *
 * The authority is `tests/tmp/preview-spec.md`, which read the numbers off `embedded-gui` 0.2.7 (crate paths
 * in its citations are relative to that crate's `src/`) and off the vendored `embedded-gui-codegen`. Every
 * rule below carries its spec section number so a reviewer can check it; where the spec is silent or marked
 * "Uncertain", the comment says what was done and why.
 *
 * What is deliberately *not* here:
 *
 *   * No DOM beyond the 2D context, no `vscode`, no new dependencies. The module is importable by the
 *     webview bundle and by nothing else; the palette and the editor chrome stay in `theme.ts`.
 *   * No attempt to draw fonts whose glyph data is external (`Custom`, `Bitmap`, `Dynamic`, `MonoFont`,
 *     spec "Cannot be replicated" #1). A label whose `font=` names a declared BDF -- which the crate draws
 *     as `FontId::Bitmap` -- is approximated with the packed default font; the comment at the one place it
 *     happens says so rather than pretending.
 *   * `Vector(n)` is drawn from the crate's own polylines: `glyphs.ts` carries `vectorGlyph`, the points the
 *     crate strokes. Each coordinate is multiplied by `n` and consecutive points are stroked as 1px canvas
 *     segments, with the pen-up marker breaking a glyph into strokes. The crate's stroke pixel is dithered at
 *     opacity 220 while a canvas stroke blends, so the two are close but not pixel-identical (spec
 *     "Cannot be replicated" #2); the comment at the routine says so.
 *
 * The canvas is 1:1 in device pixels (see `canvas.ts`), so `widget.x/y/width/height` are already board
 * pixels and no zoom arithmetic belongs in here.
 */

import { resolveStyleValues, styleValuesOf, type ResolvedStyle } from '../../src/designer/appearance';
import { widgetSpec } from '../../src/designer/catalog';
import { isBuiltInFont } from '../../src/designer/fonts';
import { type DesignerWidget } from '../../src/designer/model';
import { glyphColumns, glyphMetrics, glyphRowCount, glyphRows, vectorGlyph, VECTOR_PEN_UP } from './glyphs';

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/**
 * An `Rgb565`, held as the crate holds it: `r`/`b` are 5-bit (0..=31), `g` is 6-bit (0..=63). The
 * constructor arguments in the spec are kept in those units rather than hex so they can be compared to the
 * crate's source line for line (spec "Citation conventions", `style.rs`).
 */
interface Rgb565 {
    readonly r: number;
    readonly g: number;
    readonly b: number;
}

/** `Rgb565::new(r,g,b)` (spec Citation conventions). */
function rgb(r: number, g: number, b: number): Rgb565 {
    return { r, g, b };
}

/**
 * A colour as CSS. The 5/6/5 components are expanded the way a packed pixel is, `r<<3|r>>2` etc., so the
 * canvas shows the same 24-bit colour the panel's framebuffer does (task brief; spec "Colour").
 */
function css(colour: Rgb565): string {
    const r = ((colour.r << 3) | (colour.r >> 2)) & 0xff;
    const g = ((colour.g << 2) | (colour.g >> 4)) & 0xff;
    const b = ((colour.b << 3) | (colour.b >> 2)) & 0xff;
    return `rgb(${r},${g},${b})`;
}

const WHITE = rgb(31, 63, 31);
const BLACK = rgb(0, 0, 0);

/**
 * `lerp_rgb565` (spec 2.4, `render/compositor.rs:64-90`), the one the gradient uses.
 *
 * The integer form is kept exactly: `((x*257 + 257) >> 16)` with `x = c1*inv + c2*alpha`. The spec notes
 * this equals `floor(x/255)` for the reachable range, and mirroring the expression means it also equals it
 * for values where that is not obvious.
 */
function lerp565(a: Rgb565, b: Rgb565, alpha: number): Rgb565 {
    if (alpha <= 0) {
        return a;
    }
    if (alpha >= 255) {
        return b;
    }
    const inv = 255 - alpha;
    const blend = (x: number, y: number): number => (((x * inv + y * alpha) * 257 + 257) >> 16) & 0xff;
    return rgb(blend(a.r, b.r), blend(a.g, b.g), blend(a.b, b.b));
}

/** `#rrggbb` as the crate's own 5/6/5 reduction (`parser.rs:970-985`), for a colour the design stores. */
function fromHex(hex: string): Rgb565 | undefined {
    const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
    const digits = match?.[1];
    if (digits === undefined) {
        return undefined;
    }
    return rgb(
        parseInt(digits.slice(0, 2), 16) >> 3,
        parseInt(digits.slice(2, 4), 16) >> 2,
        parseInt(digits.slice(4, 6), 16) >> 3,
    );
}

// ---------------------------------------------------------------------------
// Style, as data (spec 2.1-2.3)
// ---------------------------------------------------------------------------

interface EdgeInsets {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
}

interface Border {
    readonly color: Rgb565;
    readonly width: number;
}

interface Shadow {
    readonly color: Rgb565;
    readonly opacity: number;
    readonly offsetX: number;
    readonly offsetY: number;
    readonly spread: number;
}

interface Gradient {
    readonly start: Rgb565;
    readonly end: Rgb565;
    readonly direction: 'vertical' | 'horizontal';
}

interface Style {
    readonly background?: Rgb565;
    readonly gradient?: Gradient;
    readonly font: string;
    readonly foreground: Rgb565;
    readonly text: Rgb565;
    readonly accent: Rgb565;
    readonly opacity: number;
    readonly cornerRadius: number;
    readonly shadow?: Shadow;
    readonly border: Border;
    readonly padding: EdgeInsets;
}

function allEdges(value: number): EdgeInsets {
    return { left: value, right: value, top: value, bottom: value };
}

function symmetricEdges(horizontal: number, vertical: number): EdgeInsets {
    return { left: horizontal, right: horizontal, top: vertical, bottom: vertical };
}

/** `Style::new()` (spec 2.2, `style.rs:232-246`). */
function styleNew(): Style {
    return {
        font: 'Tiny3x5',
        foreground: WHITE,
        text: WHITE,
        accent: rgb(0, 42, 31),
        opacity: 255,
        cornerRadius: 0,
        border: { color: BLACK, width: 0 },
        padding: allEdges(0),
    };
}

/** `Style::label()` (spec 2.2, `style.rs:267-281`): field-for-field identical to `Style::new()` (spec U8). */
function styleLabel(): Style {
    return styleNew();
}

/** `Style::panel()` (spec 2.2, `style.rs:248-265`). */
function stylePanel(): Style {
    return {
        background: rgb(2, 4, 8),
        gradient: { start: rgb(4, 8, 12), end: rgb(1, 2, 5), direction: 'vertical' },
        font: 'Tiny3x5',
        foreground: WHITE,
        text: WHITE,
        accent: rgb(0, 42, 31),
        opacity: 255,
        cornerRadius: 2,
        shadow: { color: BLACK, opacity: 96, offsetX: 1, offsetY: 2, spread: 2 },
        border: { color: rgb(8, 16, 20), width: 1 },
        padding: allEdges(2),
    };
}

/** `Style::button()` (spec 2.2, `style.rs:283-306`). */
function styleButton(): Style {
    return {
        background: rgb(4, 8, 12),
        gradient: { start: rgb(6, 12, 16), end: rgb(2, 4, 8), direction: 'vertical' },
        font: 'Medium4x7',
        foreground: WHITE,
        text: WHITE,
        accent: rgb(0, 48, 40),
        opacity: 255,
        cornerRadius: 2,
        shadow: { color: BLACK, opacity: 88, offsetX: 1, offsetY: 1, spread: 1 },
        border: { color: rgb(12, 24, 28), width: 1 },
        padding: symmetricEdges(3, 2),
    };
}

/** `Style::progress()` (spec 2.2, `style.rs:308-325`). */
function styleProgress(): Style {
    return {
        background: rgb(3, 4, 5),
        gradient: { start: rgb(3, 5, 6), end: rgb(1, 2, 3), direction: 'horizontal' },
        font: 'Tiny3x5',
        foreground: rgb(0, 50, 18),
        text: WHITE,
        accent: rgb(0, 50, 18),
        opacity: 255,
        cornerRadius: 1,
        border: { color: rgb(9, 14, 14), width: 1 },
        padding: allEdges(1),
    };
}

/** `Style::selected(bool)` (spec 2.2, `style.rs:327-333`): background=accent, border=one(WHITE), gradient kept. */
function selected(style: Style): Style {
    return { ...style, background: style.accent, border: { color: WHITE, width: 1 } };
}

/** `WidgetStyle::new`'s disabled slot (spec 2.3, `style.rs:442-461`). */
function disabledStyle(style: Style): Style {
    return {
        ...style,
        foreground: rgb(8, 12, 12),
        text: rgb(12, 18, 18),
        opacity: 170,
    };
}

type VisualState = 'normal' | 'focused' | 'pressed' | 'disabled';

/**
 * `WidgetStyle::resolve` (spec 2.3, `style.rs:587-594`).
 *
 * The designer canvas has no runtime input to derive a state from, so it always asks for Normal; the other
 * three exist so a caller with a live state could ask for them.
 */
function resolveVisual(style: Style, state: VisualState): Style {
    switch (state) {
        case 'focused':
        case 'pressed':
            return selected(style);
        case 'disabled':
            return disabledStyle(style);
        case 'normal':
            return style;
        default:
            return style;
    }
}

/** One of the `style="…"` base names this project offers (`appearance.ts`; spec 5.3). */
function namedBase(name: string, fallback: Style): Style {
    switch (name) {
        case 'label':
            return styleLabel();
        case 'panel':
            return stylePanel();
        case 'progress':
            return styleProgress();
        case 'button':
            return styleButton();
        default:
            // A raw Rust expression cannot be interpreted here; the caller's own default is the closest
            // honest answer (spec 5.3: an unknown name is passed through verbatim as Rust).
            return fallback;
    }
}

/**
 * A resolved design appearance, laid over a base style.
 *
 * This is the canvas half of `src/designer/appearance.ts`: the same `resolveStyleValues` policy the emitter
 * compiles from, applied to the preview's own `Style` record rather than written as Rust. One policy, two
 * consumers -- so the canvas cannot apply a border the board will not paint, or drop one it will.
 *
 * `background` clears the gradient because `Block::render` paints the gradient *instead of* the background
 * (`block.rs:177-186`); the emitter writes `style.gradient = None;` for the same reason
 * (`appearance.ts` assignments), so the two agree by construction rather than by luck. The preview's fields
 * are `readonly`, so every change builds a new object.
 */
function applyResolved(base: Style, resolved: ResolvedStyle): Style {
    let style = base;
    if (resolved.background !== undefined) {
        const background = fromHex(resolved.background);
        if (background !== undefined) {
            style = { ...style, background, gradient: undefined };
        }
    }
    if (resolved.border !== undefined) {
        const colour = fromHex(resolved.border.colour);
        if (colour !== undefined) {
            style = { ...style, border: { color: colour, width: resolved.border.width } };
        }
    } else if (resolved.borderWidth !== undefined) {
        // A width on its own thickens the border the base already had, keeping its colour.
        style = { ...style, border: { ...style.border, width: resolved.borderWidth } };
    }
    if (resolved.radius !== undefined) {
        style = { ...style, cornerRadius: resolved.radius };
    }
    if (resolved.text !== undefined) {
        const colour = fromHex(resolved.text);
        if (colour !== undefined) {
            style = { ...style, text: colour };
        }
    }
    if (resolved.accent !== undefined) {
        const colour = fromHex(resolved.accent);
        if (colour !== undefined) {
            style = { ...style, accent: colour };
        }
    }
    if (resolved.foreground !== undefined) {
        const colour = fromHex(resolved.foreground);
        if (colour !== undefined) {
            style = { ...style, foreground: colour };
        }
    }
    if (resolved.font !== undefined) {
        style = { ...style, font: resolved.font };
    }
    return style;
}

/**
 * The style a widget wears in the design: the base style it names, with the appearance fields its `viaStyle`
 * properties carry folded on top.
 *
 * The base is the tag's *own* fallback rather than one global default, because a design that names one colour
 * must keep the surface the widget already had -- `Style::panel()` for a roller, spinbox or scale,
 * `Style::default()` for a toggle, checkbox or progress (the codegen fork's per-tag literals, `ownStyleOf`).
 * The properties come from the catalogue, which is the authority on which fields travel inside the style
 * expression rather than as attributes.
 */
function designStyle(widget: DesignerWidget, fallback: Style): Style {
    const name = stringProp(widget.props, 'style');
    const base = name === '' ? fallback : namedBase(name, fallback);
    return applyResolved(base, resolveStyleValues(styleValuesOf(widget, widgetSpec(widget.tag)?.props ?? [])));
}

// ---------------------------------------------------------------------------
// Rect arithmetic (spec "Pixel model", geometry.rs:14-34)
// ---------------------------------------------------------------------------

interface Rect {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

function rectRight(rect: Rect): number {
    return rect.x + rect.w;
}

function rectBottom(rect: Rect): number {
    return rect.y + rect.h;
}

function rectEmpty(rect: Rect): boolean {
    return rect.w <= 0 || rect.h <= 0;
}

/** `Rect::contains` (spec "Pixel model"): half-open on the right/bottom. */
function rectContains(rect: Rect, x: number, y: number): boolean {
    return x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h;
}

/**
 * `Rect::inset` (spec 3.6, `geometry.rs:78-92`): negative insets are treated as 0, and the total shrink is
 * clamped to the size so the result never has negative dimensions.
 */
function rectInset(rect: Rect, edges: EdgeInsets): Rect {
    const left = Math.max(0, edges.left);
    const right = Math.max(0, edges.right);
    const top = Math.max(0, edges.top);
    const bottom = Math.max(0, edges.bottom);
    const shrinkW = Math.min(left + right, rect.w);
    const shrinkH = Math.min(top + bottom, rect.h);
    return { x: rect.x + left, y: rect.y + top, w: rect.w - shrinkW, h: rect.h - shrinkH };
}

/** `radius = min(radius, min(w,h)/2)` (spec 3.3, `render/mod.rs:531`, `:625`). */
function clampRadius(rect: Rect, radius: number): number {
    return Math.min(radius, Math.floor(Math.min(rect.w, rect.h) / 2));
}

/**
 * `in_rounded_rect` (spec 3.5, `render/mod.rs:2522-2559`), integer circle test and all.
 *
 * The quadrant centres come from the *inclusive* last pixel (`right()-1`, `bottom()-1`) and the test is
 * `dx*dx + dy*dy <= radius*radius`.
 */
function inRoundedRect(x: number, y: number, rect: Rect, radius: number): boolean {
    if (rectEmpty(rect)) {
        return false;
    }
    if (radius <= 0) {
        return rectContains(rect, x, y);
    }
    const left = rect.x;
    const top = rect.y;
    const right = rectRight(rect) - 1;
    const bottom = rectBottom(rect) - 1;
    const innerLeft = left + radius;
    const innerRight = right - radius;
    const innerTop = top + radius;
    const innerBottom = bottom - radius;

    if ((x >= innerLeft && x <= innerRight) || (y >= innerTop && y <= innerBottom)) {
        return x >= left && y >= top && x <= right && y <= bottom;
    }

    let cx: number;
    let cy: number;
    if (x < innerLeft && y < innerTop) {
        cx = innerLeft;
        cy = innerTop;
    } else if (x > innerRight && y < innerTop) {
        cx = innerRight;
        cy = innerTop;
    } else if (x < innerLeft && y > innerBottom) {
        cx = innerLeft;
        cy = innerBottom;
    } else if (x > innerRight && y > innerBottom) {
        cx = innerRight;
        cy = innerBottom;
    } else {
        return x >= left && y >= top && x <= right && y <= bottom;
    }
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
}

/**
 * The x-run `[x0, x1)` of a rounded rect on row `y`.
 *
 * A rounded rect is convex, so every row's painted set is one contiguous run (this is the invariant the
 * crate's centre/side/corner split in `fill_rounded_rect_alpha` exploits, `render/mod.rs:560-611`); the
 * run is found by walking in from each edge, which keeps the exact `in_rounded_rect` decision.
 */
function rowExtent(rect: Rect, radius: number, y: number): readonly [number, number] | undefined {
    if (radius <= 0) {
        return [rect.x, rectRight(rect)];
    }
    let x0 = rect.x;
    let x1 = rectRight(rect);
    for (let i = 0; i < radius && x0 < x1; i += 1) {
        if (inRoundedRect(x0, y, rect, radius)) {
            break;
        }
        x0 += 1;
    }
    for (let i = 0; i < radius && x0 < x1; i += 1) {
        if (inRoundedRect(x1 - 1, y, rect, radius)) {
            break;
        }
        x1 -= 1;
    }
    return x0 >= x1 ? undefined : [x0, x1];
}

/** The y-run `[y0, y1)` of a rounded rect on column `x`, the horizontal mirror of `rowExtent`. */
function colExtent(rect: Rect, radius: number, x: number): readonly [number, number] | undefined {
    if (radius <= 0) {
        return [rect.y, rectBottom(rect)];
    }
    let y0 = rect.y;
    let y1 = rectBottom(rect);
    for (let i = 0; i < radius && y0 < y1; i += 1) {
        if (inRoundedRect(x, y0, rect, radius)) {
            break;
        }
        y0 += 1;
    }
    for (let i = 0; i < radius && y0 < y1; i += 1) {
        if (inRoundedRect(x, y1 - 1, rect, radius)) {
            break;
        }
        y1 -= 1;
    }
    return y0 >= y1 ? undefined : [y0, y1];
}

// ---------------------------------------------------------------------------
// Block geometry (spec 3.6)
// ---------------------------------------------------------------------------

function lineHeightOf(style: Style): number {
    return glyphMetrics(style.font).lineHeight;
}

/** A `padding.saturating_add(border)` edge, clamped to the `i16` the crate uses (spec 3.6). */
function edgeSum(value: number, border: number): number {
    return Math.min(32767, Math.max(-32768, value + border));
}

/** `Block::inner(rect)` (spec 3.6, `block.rs:59-68`). */
function blockInner(rect: Rect, style: Style): Rect {
    const border = style.border.width;
    return rectInset(rect, {
        left: edgeSum(style.padding.left, border),
        right: edgeSum(style.padding.right, border),
        top: edgeSum(style.padding.top, border),
        bottom: edgeSum(style.padding.bottom, border),
    });
}

/** `Block::title_area(rect)` (spec 3.6, `block.rs:70-83`); only meaningful when a title is set. */
function titleArea(rect: Rect, style: Style): Rect {
    const border = style.border.width;
    const left = Math.max(style.padding.left, 0);
    const right = Math.max(style.padding.right, 0);
    return {
        x: rect.x + border + left,
        y: rect.y,
        w: Math.max(0, rect.w - 2 * border - left - right),
        h: lineHeightOf(style) + 1,
    };
}

/** `Block::content_area(rect)` (spec 3.6, `block.rs:85-99`). */
function contentArea(rect: Rect, style: Style, hasTitle: boolean): Rect {
    const inner = blockInner(rect, style);
    if (!hasTitle) {
        return inner;
    }
    const titleHeight = lineHeightOf(style) + 3;
    return { x: inner.x, y: inner.y + titleHeight, w: inner.w, h: Math.max(0, inner.h - titleHeight) };
}

// ---------------------------------------------------------------------------
// Rasterisation
// ---------------------------------------------------------------------------

/**
 * The crate's ordered-dither decision (spec 3.7, `render/compositor.rs:43-61`): a pixel is drawn iff
 * `opacity > BAYER[(y&3)*4+(x&3)]*16+8`.
 *
 * This is the board's default compositor. It is *not* an alpha blend, so `globalAlpha` would be smoother and
 * darker than the glass; the parent asked for the dither, and this is it. The pattern is indexed by the
 * board's own framebuffer pixel (`render/compositor.rs:43-61`); the canvas works in the design's
 * rotation-applied coordinates (see `canvas.ts`), so at rotation 0 the two coincide and at 90/270 the mask's
 * phase can differ by the axis swap. That is a phase difference in a dither pattern, not a different model.
 */
const BAYER: readonly number[] = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function shouldDraw(x: number, y: number, opacity: number): boolean {
    if (opacity >= 255) {
        return true;
    }
    if (opacity <= 0) {
        return false;
    }
    const threshold = (BAYER[(y & 3) * 4 + (x & 3)] ?? 0) * 16 + 8;
    return opacity > threshold;
}

/** One dithered pixel, the replica of `RenderCtx::pixel` + `Dither::plot` (spec 3.7). */
function pixel(context: CanvasRenderingContext2D, x: number, y: number, colour: Rgb565, opacity: number): void {
    if (!shouldDraw(x, y, opacity)) {
        return;
    }
    context.fillStyle = css(colour);
    context.fillRect(x, y, 1, 1);
}

/**
 * A solid rounded-rect fill (spec 3.3, `render/mod.rs:519-611`).
 *
 * At full opacity the run is one `fillRect`; below it the dither decision is per pixel, exactly as the
 * compositor makes it.
 */
function fillSolid(context: CanvasRenderingContext2D, rect: Rect, radius: number, colour: Rgb565, opacity: number): void {
    if (rectEmpty(rect) || opacity <= 0) {
        return;
    }
    const clamped = clampRadius(rect, radius);
    if (clamped <= 0 && opacity >= 255) {
        context.fillStyle = css(colour);
        context.fillRect(rect.x, rect.y, rect.w, rect.h);
        return;
    }
    for (let y = rect.y; y < rectBottom(rect); y += 1) {
        const run = rowExtent(rect, clamped, y);
        if (run === undefined) {
            continue;
        }
        const [x0, x1] = run;
        if (opacity >= 255) {
            context.fillStyle = css(colour);
            context.fillRect(x0, y, x1 - x0, 1);
        } else {
            for (let x = x0; x < x1; x += 1) {
                pixel(context, x, y, colour, opacity);
            }
        }
    }
}

/**
 * A linear-gradient rounded-rect fill (spec 3.3, `render/mod.rs:613-751`).
 *
 * `t = ((y - rect.y).clamp(0, denom) * 255) / denom`, `denom = max(h-1,1)`, and the colour is
 * `lerp_rgb565(start, end, t)`. The fill is done per row (Vertical) or per column (Horizontal) so the
 * crate's per-row quantisation is reproduced exactly rather than smoothed by a canvas gradient. High
 * quality leaves `t` unquantised (spec "Render quality"), which is what this computes.
 */
function fillGradient(
    context: CanvasRenderingContext2D,
    rect: Rect,
    radius: number,
    gradient: Gradient,
    opacity: number,
): void {
    if (rectEmpty(rect) || opacity <= 0) {
        return;
    }
    const clamped = clampRadius(rect, radius);
    if (gradient.direction === 'vertical') {
        const denom = Math.max(rect.h - 1, 1);
        for (let y = rect.y; y < rectBottom(rect); y += 1) {
            const numer = Math.min(Math.max(y - rect.y, 0), denom);
            const colour = lerp565(gradient.start, gradient.end, Math.floor((numer * 255) / denom));
            const run = rowExtent(rect, clamped, y);
            if (run === undefined) {
                continue;
            }
            const [x0, x1] = run;
            if (opacity >= 255) {
                context.fillStyle = css(colour);
                context.fillRect(x0, y, x1 - x0, 1);
            } else {
                for (let x = x0; x < x1; x += 1) {
                    pixel(context, x, y, colour, opacity);
                }
            }
        }
        return;
    }
    const denom = Math.max(rect.w - 1, 1);
    for (let x = rect.x; x < rectRight(rect); x += 1) {
        const numer = Math.min(Math.max(x - rect.x, 0), denom);
        const colour = lerp565(gradient.start, gradient.end, Math.floor((numer * 255) / denom));
        const run = colExtent(rect, clamped, x);
        if (run === undefined) {
            continue;
        }
        const [y0, y1] = run;
        if (opacity >= 255) {
            context.fillStyle = css(colour);
            context.fillRect(x, y0, 1, y1 - y0);
        } else {
            for (let y = y0; y < y1; y += 1) {
                pixel(context, x, y, colour, opacity);
            }
        }
    }
}

/**
 * `stroke_rounded_rect_alpha` (spec 3.4, `render/mod.rs:806-934`).
 *
 * A zero-width border, an empty rect or zero opacity draws nothing. Otherwise: straight strips for the
 * edges, then the four `radius x radius` corner boxes scanned per pixel -- painted where the pixel is inside
 * the outer rounded rect and outside the one inset by the border's own width, which is the ring the crate
 * draws (`render/mod.rs`, `stroke_rounded_rect_alpha`).
 */
function strokeRounded(
    context: CanvasRenderingContext2D,
    rect: Rect,
    radius: number,
    border: Border,
    opacity: number,
): void {
    if (border.width <= 0 || rectEmpty(rect) || opacity <= 0) {
        return;
    }
    const clamped = clampRadius(rect, radius);
    const b = Math.min(border.width, Math.floor(rect.w / 2), Math.floor(rect.h / 2));

    if (clamped <= 0) {
        fillSolid(context, { x: rect.x, y: rect.y, w: rect.w, h: b }, 0, border.color, opacity);
        fillSolid(context, { x: rect.x, y: rectBottom(rect) - b, w: rect.w, h: b }, 0, border.color, opacity);
        if (rect.h > 2 * b) {
            fillSolid(context, { x: rect.x, y: rect.y + b, w: b, h: rect.h - 2 * b }, 0, border.color, opacity);
            fillSolid(context, { x: rectRight(rect) - b, y: rect.y + b, w: b, h: rect.h - 2 * b }, 0, border.color, opacity);
        }
        return;
    }

    const innerW = rect.w - 2 * clamped;
    const innerH = rect.h - 2 * clamped;
    if (innerW > 0) {
        fillSolid(context, { x: rect.x + clamped, y: rect.y, w: innerW, h: b }, 0, border.color, opacity);
        fillSolid(context, { x: rect.x + clamped, y: rectBottom(rect) - b, w: innerW, h: b }, 0, border.color, opacity);
    }
    if (innerH > 0) {
        fillSolid(context, { x: rect.x, y: rect.y + clamped, w: b, h: innerH }, 0, border.color, opacity);
        fillSolid(context, { x: rectRight(rect) - b, y: rect.y + clamped, w: b, h: innerH }, 0, border.color, opacity);
    }

    const boxes: readonly Rect[] = [
        { x: rect.x, y: rect.y, w: clamped, h: clamped },
        { x: rectRight(rect) - clamped, y: rect.y, w: clamped, h: clamped },
        { x: rect.x, y: rectBottom(rect) - clamped, w: clamped, h: clamped },
        { x: rectRight(rect) - clamped, y: rectBottom(rect) - clamped, w: clamped, h: clamped },
    ];
    for (const box of boxes) {
        for (let y = box.y; y < rectBottom(box); y += 1) {
            for (let x = box.x; x < rectRight(box); x += 1) {
                if (!inRoundedRect(x, y, rect, clamped)) {
                    continue;
                }
                // Inside the outer rounded rect and outside the one inset by the border's width: the ring. Not a
                // loop over every inset below the width -- that skipped a pixel as soon as the smallest inset
                // contained it, which made every border a hairline and left a one-pixel border testing nothing,
                // so the whole corner came out in the border colour.
                const inner: Rect = {
                    x: rect.x + b,
                    y: rect.y + b,
                    w: Math.max(0, rect.w - 2 * b),
                    h: Math.max(0, rect.h - 2 * b),
                };
                if (!rectEmpty(inner) && inRoundedRect(x, y, inner, Math.max(0, clamped - b))) {
                    continue;
                }
                pixel(context, x, y, border.color, opacity);
            }
        }
    }
}

/**
 * The shadow ring loop (spec 3.2, `block.rs:111-175`), with the crate's occluded-core optimisation.
 *
 * High quality means `spread` rings (`render/mod.rs:483-495`), `i` ascending so later rings paint over
 * earlier; the fade is `(opacity * (spread-i) / spread)` in integer arithmetic; the ring grows by `i` and its
 * radius by `i`.
 *
 * Each ring is a *filled* rounded rect, and at the shadow's opacity that fill is ordered-dithered, so painting
 * the ring whole costs one canvas op per ~1.7 pixels of the ring's **area** — 24 000 ops for a 360x120 panel,
 * on every repaint. The crate does not do that: when the block's own fill is opaque it clips each ring to four
 * strips around an inset *core* (`block.rs:113-171`), because the core is about to be painted over anyway, and
 * its own test asserts the clipped and unclipped loops are pixel-identical (`block.rs:225-290`). This does the
 * same thing the same way: the core's columns are skipped on the rows the core covers, which is the union of
 * those four strips, and the result is the same pixels for a fraction of the work.
 *
 * The core only exists when the block will actually cover it -- `opacity == 255` and a background or gradient
 * to paint with -- and when the rect is bigger than its corners (`block.rs:115-123`). A shape with a shadow and
 * nothing to fill with gets the whole ring, exactly as the crate does.
 */
function drawShadow(
    context: CanvasRenderingContext2D,
    rect: Rect,
    cornerRadius: number,
    shadow: Shadow,
    opaqueFill: boolean,
): void {
    const spread = shadow.spread;
    const radius = clampRadius(rect, cornerRadius);
    const core =
        opaqueFill && rect.w > radius * 2 && rect.h > radius * 2
            ? { x: rect.x + radius, y: rect.y + radius, w: rect.w - radius * 2, h: rect.h - radius * 2 }
            : undefined;

    for (let i = 0; i < spread; i += 1) {
        const ring: Rect = {
            x: rect.x + shadow.offsetX - i,
            y: rect.y + shadow.offsetY - i,
            w: rect.w + 2 * i,
            h: rect.h + 2 * i,
        };
        const opacity = Math.floor((shadow.opacity * (spread - i)) / spread);
        // The ring's radius grows with the ring (spec 3.2, `block.rs:138`).
        fillRing(context, ring, cornerRadius + i, shadow.color, opacity, core);
    }
}

/**
 * One dithered shadow ring, skipping the core's columns on the rows it covers.
 *
 * Splitting a row around the core is the same set of pixels as the crate's four clipped strips, without giving
 * the canvas a clip rectangle per strip.
 */
function fillRing(
    context: CanvasRenderingContext2D,
    ring: Rect,
    radius: number,
    colour: Rgb565,
    opacity: number,
    core: Rect | undefined,
): void {
    if (rectEmpty(ring) || opacity <= 0) {
        return;
    }
    const clamped = clampRadius(ring, radius);
    for (let y = ring.y; y < rectBottom(ring); y += 1) {
        const run = rowExtent(ring, clamped, y);
        if (run === undefined) {
            continue;
        }
        const [x0, x1] = run;
        const inCoreRows = core !== undefined && y >= core.y && y < rectBottom(core);
        if (!inCoreRows) {
            paintRun(context, x0, x1, y, colour, opacity);
            continue;
        }
        // Left strip, then right strip; either may be empty.
        paintRun(context, x0, Math.min(x1, core.x), y, colour, opacity);
        paintRun(context, Math.max(x0, rectRight(core)), x1, y, colour, opacity);
    }
}

/** One horizontal run of a dithered fill: a single `fillRect` at full opacity, per-pixel below it. */
function paintRun(
    context: CanvasRenderingContext2D,
    x0: number,
    x1: number,
    y: number,
    colour: Rgb565,
    opacity: number,
): void {
    if (x1 <= x0) {
        return;
    }
    if (opacity >= 255) {
        context.fillStyle = css(colour);
        context.fillRect(x0, y, x1 - x0, 1);
        return;
    }
    for (let x = x0; x < x1; x += 1) {
        pixel(context, x, y, colour, opacity);
    }
}

/**
 * `RenderCtx::fill_circle` (spec 4.12, `render/mod.rs:1279-1299`): a scanline fill whose half-width is
 * `sqrt(r² - dy²)` truncated to an integer, one run per row. The truncation is the crate's `as i32`, so it is
 * kept rather than smoothed.
 */
function fillCircle(
    context: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
    colour: Rgb565,
    opacity = 255,
): void {
    if (radius <= 0) {
        return;
    }
    const rSq = radius * radius;
    for (let dy = -radius; dy <= radius; dy += 1) {
        const dx = Math.trunc(Math.sqrt(rSq - dy * dy));
        if (dx >= 0) {
            fillSolid(context, { x: cx - dx, y: cy + dy, w: dx * 2 + 1, h: 1 }, 0, colour, opacity);
        }
    }
}

/**
 * `RenderCtx::stroke_circle` (spec 4.12, `render/mod.rs:1301-1333`): the crate's own midpoint circle, eight
 * pixels at a time. Used for the radial needle's white ring.
 */
function strokeCircle(
    context: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
    colour: Rgb565,
    opacity = 255,
): void {
    if (radius <= 0) {
        return;
    }
    let x = radius;
    let y = 0;
    let err = 1 - x;
    while (x >= y) {
        pixel(context, cx + x, cy + y, colour, opacity);
        pixel(context, cx + y, cy + x, colour, opacity);
        pixel(context, cx - y, cy + x, colour, opacity);
        pixel(context, cx - x, cy + y, colour, opacity);
        pixel(context, cx - x, cy - y, colour, opacity);
        pixel(context, cx - y, cy - x, colour, opacity);
        pixel(context, cx + y, cy - x, colour, opacity);
        pixel(context, cx + x, cy - y, colour, opacity);
        y += 1;
        if (err < 0) {
            err += 2 * y + 1;
        } else {
            x -= 1;
            err += 2 * (y - x) + 1;
        }
    }
}

/**
 * `RenderCtx::draw_line_styled` (spec 4.12, `render/mod.rs:1130-1172`): the crate's Bresenham with the square
 * pen the width selects.
 *
 * The pen is `2*floor(width/2)+1` pixels, not `width` -- a width of 2 draws a 3x3 block (`half` is 1, and the
 * loop runs `-half..=half`). A round cap fills a circle of radius `max(1, half)` at each *endpoint*, once per
 * step, which is how the crate draws it; at High quality the stroke is opaque (spec "Render quality").
 */
function drawLineStyled(
    context: CanvasRenderingContext2D,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    colour: Rgb565,
    options: { readonly width?: number; readonly roundCap?: boolean; readonly opacity?: number } = {},
): void {
    const width = options.width ?? 1;
    const opacity = options.opacity ?? 255;
    const half = Math.max(0, Math.floor(width / 2));
    let x = x0;
    let y = y0;
    const dx = Math.abs(x1 - x0);
    const sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0);
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;

    for (; ;) {
        for (let oy = -half; oy <= half; oy += 1) {
            for (let ox = -half; ox <= half; ox += 1) {
                pixel(context, x + ox, y + oy, colour, opacity);
            }
        }
        if (options.roundCap === true) {
            fillCircle(context, x0, y0, Math.max(1, half), colour, opacity);
            fillCircle(context, x1, y1, Math.max(1, half), colour, opacity);
        }
        if (x === x1 && y === y1) {
            break;
        }
        const e2 = 2 * err;
        if (e2 >= dy) {
            err += dy;
            x += sx;
        }
        if (e2 <= dx) {
            err += dx;
            y += sy;
        }
    }
}

/** The title `Block::render` draws (spec 4.11, `block.rs:194-204`): `style.accent` on the block font. */
function drawTitle(context: CanvasRenderingContext2D, rect: Rect, style: Style, title: string): void {
    const area = titleArea(rect, style);
    drawCrateText(context, area.x, area.y, title, style.font, style.accent, {
        width: area.w,
        height: area.h,
        align: 'center',
        verticalAlign: 'top',
        opacity: style.opacity,
    });
}

// ---------------------------------------------------------------------------
// Text (spec 1.3-1.6)
// ---------------------------------------------------------------------------

export interface CrateTextOptions {
    /** The target rect's width, for horizontal alignment and wrapping (spec 1.5). */
    readonly width?: number;
    /** The target rect's height, for vertical alignment (spec 1.5). */
    readonly height?: number;
    readonly align?: 'left' | 'center' | 'right';
    readonly verticalAlign?: 'top' | 'middle' | 'bottom';
    readonly opacity?: number;
    /** `TextStyle::line_spacing`; the crate's default is 1 (spec 1.5, `render/text_style.rs:79`). */
    readonly lineSpacing?: number;
    readonly wrap?: 'none' | 'word' | 'character';
}

/** Rust's `.chars().count()`: characters, not UTF-16 units. */
function charCount(text: string): number {
    return Array.from(text).length;
}

/** The `n` of a `Vector(n)` font, or 0 for a packed bitmap font (spec 1.2/1.6). */
function vectorScale(font: string): number {
    const match = /^Vector\((\d+)\)$/.exec(font);
    return match?.[1] !== undefined ? Math.max(1, parseInt(match[1], 10)) : 0;
}

/**
 * The block size for a packed glyph's set bit (spec 1.4): one canvas pixel for `Tiny3x5`/`Medium4x7`, a 2x2
 * block for `Scaled6x10`. A named font that is not one of the crate's built-ins is a declared BDF, drawn by
 * the crate as `FontId::Bitmap` (external data, spec "Cannot be replicated" #1); it falls back to the 1x1
 * packed walk.
 */
function glyphBlockSize(font: string): number {
    return font === 'Scaled6x10' ? 2 : 1;
}

/** `draw_char_with_font` for the bitmap fonts (spec 1.3-1.4, `render/mod.rs:1897-1928`). */
function drawGlyph(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    ch: string,
    font: string,
    colour: Rgb565,
    opacity: number,
): void {
    const scale = vectorScale(font);
    if (scale > 0) {
        drawVectorGlyph(context, x, y, ch, scale, colour, opacity);
        return;
    }
    const rows = glyphRows(font, ch);
    const block = glyphBlockSize(font);
    const columns = glyphColumns(font);
    for (let row = 0; row < glyphRowCount(font); row += 1) {
        const bits = rows[row] ?? 0;
        for (let col = 0; col < columns; col += 1) {
            if ((bits & (1 << (columns - 1 - col))) === 0) {
                continue;
            }
            const px = x + col * block;
            const py = y + row * block;
            if (opacity >= 255) {
                context.fillStyle = css(colour);
                context.fillRect(px, py, block, block);
            } else {
                for (let dy = 0; dy < block; dy += 1) {
                    for (let dx = 0; dx < block; dx += 1) {
                        pixel(context, px + dx, py + dy, colour, opacity);
                    }
                }
            }
        }
    }
}

/**
 * `FontId::Vector(scale)` (spec 1.4, `render/mod.rs:1929-1951`): the crate's own polyline, scaled by `n`.
 *
 * `vectorGlyph` is the flat `(x,y)` list the crate strokes; `(VECTOR_PEN_UP, VECTOR_PEN_UP)` lifts the pen
 * and breaks the glyph into strokes. Each coordinate is `x + px*scale` (the crate multiplies the `u8` by the
 * scale as `f32` and truncates; for an integer scale the product is exact). One-pixel canvas segments are the
 * closest honest match for `draw_line_styled(..., width 1, antialias true)`; the crate draws each stroke
 * pixel at opacity 220 through its ordered-dither compositor, so the canvas blends where the crate dithers
 * and the result is not pixel-identical (spec "Render quality", "Cannot be replicated" #2).
 */
function drawVectorGlyph(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    ch: string,
    scale: number,
    colour: Rgb565,
    opacity: number,
): void {
    const points = vectorGlyph(ch);
    context.save();
    context.strokeStyle = css(colour);
    context.lineWidth = 1;
    // `stroke_opacity` is 220 at High quality (spec "Render quality", `render/mod.rs:2102-2113`).
    context.globalAlpha = (220 / 255) * (opacity / 255);
    let last: readonly [number, number] | undefined;
    for (let i = 0; i + 1 < points.length; i += 2) {
        const px = points[i] ?? 0;
        const py = points[i + 1] ?? 0;
        if (px === VECTOR_PEN_UP && py === VECTOR_PEN_UP) {
            last = undefined;
            continue;
        }
        const current: readonly [number, number] = [x + px * scale, y + py * scale];
        if (last !== undefined) {
            context.beginPath();
            context.moveTo(last[0], last[1]);
            context.lineTo(current[0], current[1]);
            context.stroke();
        }
        last = current;
    }
    context.restore();
}

/**
 * Splits text into the lines the engine would draw (spec 1.5, `render/mod.rs:2561-2607`).
 *
 * `TextWrap::None` (the default) only breaks on `\n`; `Character` and `Word` break at `max_chars`. This is a
 * faithful port of the common cases, not an exhaustive one: the crate's word wrap prefers the last
 * whitespace break (`line_len_at`), which the greedy word pass below mirrors.
 */
function wrapLines(text: string, wrap: 'none' | 'word' | 'character', width: number | undefined, advance: number): string[] {
    const paragraphs = text.split('\n');
    // A trailing newline is consumed, not an empty extra line (spec 1.5, `line_len_at`).
    if (paragraphs.length > 1 && paragraphs[paragraphs.length - 1] === '') {
        paragraphs.pop();
    }
    if (wrap === 'none' || width === undefined) {
        return paragraphs.length === 0 ? [''] : paragraphs;
    }
    const maxChars = Math.max(Math.floor(width / advance), 1);
    const lines: string[] = [];
    for (const paragraph of paragraphs) {
        if (paragraph === '') {
            lines.push('');
            continue;
        }
        if (wrap === 'character') {
            const chars = Array.from(paragraph);
            for (let i = 0; i < chars.length; i += maxChars) {
                lines.push(chars.slice(i, i + maxChars).join(''));
            }
            continue;
        }
        let line = '';
        for (const word of paragraph.split(/(\s+)/)) {
            if (word === '') {
                continue;
            }
            if (line === '') {
                line = word;
            } else if (charCount(line) + charCount(word) <= maxChars) {
                line += word;
            } else {
                lines.push(line);
                line = word;
            }
        }
        if (line !== '') {
            lines.push(line);
        }
    }
    return lines.length === 0 ? [''] : lines;
}

/**
 * The crate's text engine (spec 1.3-1.6).
 *
 * `x`/`y` are the top-left of the target rect. Pen advance is `font.advance()` per character with no
 * kerning (spec 1.5: `kerning` defaults false); vertical placement is the "centring" rule with no baseline
 * concept; horizontal placement is the align rule with `line_w = chars * advance`.
 *
 * `opts.opacity` below 255 is applied with the compositor's dither, per pixel, rather than `globalAlpha`,
 * because the default compositor does not alpha-blend (spec 3.7).
 */
export function drawCrateText(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    text: string,
    font: string,
    colour: Rgb565,
    opts: CrateTextOptions = {},
): void {
    const metrics = glyphMetrics(font);
    const advance = metrics.advance;
    const lineHeight = metrics.lineHeight;
    const lineSpacing = opts.lineSpacing ?? 1;
    const opacity = opts.opacity ?? 255;
    const lines = wrapLines(text, opts.wrap ?? 'none', opts.width, advance);
    const totalHeight = lines.length * lineHeight + Math.max(0, lines.length - 1) * lineSpacing;

    let top = y;
    if (opts.verticalAlign === 'middle') {
        top = y + Math.floor(Math.max(0, (opts.height ?? 0) - totalHeight) / 2);
    } else if (opts.verticalAlign === 'bottom') {
        top = y + Math.max(0, (opts.height ?? 0) - totalHeight);
    }

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        const lineWidth = charCount(line) * advance;
        let left = x;
        // The crate saturates before dividing (`rect.w.saturating_sub(line_w) as i32 / 2`,
        // render/mod.rs:1072-1076), so an overflowing line starts at the rect edge rather than left of it.
        if (opts.width !== undefined && opts.align === 'center') {
            left = x + Math.floor(Math.max(0, opts.width - lineWidth) / 2);
        } else if (opts.width !== undefined && opts.align === 'right') {
            left = x + Math.max(0, opts.width - lineWidth);
        }
        let cursor = left;
        for (const ch of line) {
            drawGlyph(context, cursor, top + index * (lineHeight + lineSpacing), ch, font, colour, opacity);
            cursor += advance;
        }
    }
}

/** `draw_text_in` (spec 1.5): the rect form of `drawCrateText`. */
function drawTextIn(
    context: CanvasRenderingContext2D,
    rect: Rect,
    text: string,
    font: string,
    colour: Rgb565,
    opts: Omit<CrateTextOptions, 'width' | 'height'> = {},
): void {
    drawCrateText(context, rect.x, rect.y, text, font, colour, { ...opts, width: rect.w, height: rect.h });
}

// ---------------------------------------------------------------------------
// Block (spec 3)
// ---------------------------------------------------------------------------

/**
 * `Block::render` (spec 3.1, `block.rs:101-207`): shadow rings, then fill (gradient wins over background,
 * spec 3.3), then the border, then an optional title. It does not clip itself; the caller's clip applies
 * (spec 3.1), which the designer supplies as the widget's own rect.
 */
export function drawBlock(context: CanvasRenderingContext2D, rect: Rect, style: Style, title?: string): void {
    if (rectEmpty(rect)) {
        return;
    }
    if (style.shadow !== undefined) {
        // The core is only occluded when the block will paint over it: an opaque fill with something to paint
        // (`block.rs:115-123`). Anything else gets the whole ring, as the crate does.
        const opaqueFill = style.opacity === 255 && (style.background !== undefined || style.gradient !== undefined);
        drawShadow(context, rect, style.cornerRadius, style.shadow, opaqueFill);
    }
    if (style.gradient !== undefined) {
        fillGradient(context, rect, style.cornerRadius, style.gradient, style.opacity);
    } else if (style.background !== undefined) {
        fillSolid(context, rect, style.cornerRadius, style.background, style.opacity);
    }
    if (style.border.width > 0) {
        strokeRounded(context, rect, style.cornerRadius, style.border, style.opacity);
    }
    if (title !== undefined && title !== '') {
        drawTitle(context, rect, style, title);
    }
}

// ---------------------------------------------------------------------------
// Design properties
// ---------------------------------------------------------------------------

function stringProp(props: Record<string, string | number | boolean>, ...names: readonly string[]): string {
    for (const name of names) {
        const value = props[name];
        if (typeof value === 'string' && value !== '') {
            return value;
        }
    }
    return '';
}

function numberProp(props: Record<string, string | number | boolean>, name: string, fallback: number): number {
    const value = props[name];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function boolProp(props: Record<string, string | number | boolean>, name: string, fallback: boolean): boolean {
    const value = props[name];
    return typeof value === 'boolean' ? value : fallback;
}

function colourProp(props: Record<string, string | number | boolean>, name: string): Rgb565 | undefined {
    const value = props[name];
    return typeof value === 'string' ? fromHex(value) : undefined;
}

/** The `option "…"` children of a dropdown, roller or carousel (`parser.rs`; spec 4.8-4.9). */
function optionValues(widget: DesignerWidget): string[] {
    const children = widget.children;
    return children !== undefined && children.kind === 'options' ? [...children.values] : [];
}

/**
 * The table's rows (spec 4.10, with the corrected emitter).
 *
 * The vendored fork now emits the parsed header row first and then the body rows, so a header is simply the
 * first row -- the renderer has no separate concept. An absent header list contributes nothing.
 */
function tableRows(widget: DesignerWidget): string[][] {
    const children = widget.children;
    if (children === undefined || children.kind !== 'table') {
        return [];
    }
    const rows: string[][] = [];
    if (children.headers.length > 0) {
        rows.push([...children.headers]);
    }
    for (const row of children.rows) {
        rows.push([...row]);
    }
    return rows;
}

// ---------------------------------------------------------------------------
// Per-widget style expressions (spec 5.1-5.3)
// ---------------------------------------------------------------------------

/**
 * A label or carousel's style (spec 5.1, 5.3; `emitter.rs:162-168`, `:587-609`, `:1101-1138`).
 *
 * `font=` on these two tags is read by the parser, and a name that resolves to an embedded BDF *replaces*
 * the whole style expression with `Style::label()` carrying a `FontId::Bitmap`. That glyph data is external
 * (spec "Cannot be replicated" #1), so the replacement base is honoured and the font is approximated with
 * the packed default; a *built-in* font, by contrast, rides in the style expression and its metrics are
 * reproducible.
 */
function labelOrCarouselStyle(widget: DesignerWidget, fallback: Style): Style {
    const fontProp = stringProp(widget.props, 'font');
    if (fontProp !== '' && !isBuiltInFont(fontProp)) {
        return styleLabel();
    }
    const styleName = stringProp(widget.props, 'style');
    let style = styleName === '' ? fallback : namedBase(styleName, fallback);
    if (isBuiltInFont(fontProp)) {
        style = { ...style, font: fontProp };
    }
    const colour = colourProp(widget.props, 'text_color');
    if (colour !== undefined) {
        style = { ...style, text: colour };
    }
    return style;
}

/** A panel's `style=` (spec 5.1, `emitter.rs:438-445`): the panel base unless a named style is chosen. */
function panelStyle(widget: DesignerWidget): Style {
    const styleName = stringProp(widget.props, 'style');
    return styleName === '' ? stylePanel() : namedBase(styleName, stylePanel());
}

/**
 * A button's normal style (spec 5.2, `emitter.rs:204-259`).
 *
 * The base is `WidgetStyle::button()` unless a `style` expression is present (which this project builds as
 * `WidgetStyle::button().with_normal(<Style>)`). The parser's colour and radius attributes are then chained
 * in the emitter's own order; `with_bg` does not clear the gradient, so the visible fill above stays the
 * button gradient, and `with_border_color`/`with_corner_radius` reach all four states. Only the Normal state
 * is drawn here.
 */
function buttonStyle(widget: DesignerWidget): Style {
    const styleName = stringProp(widget.props, 'style');
    let style = styleName === '' ? styleButton() : namedBase(styleName, styleButton());
    const fontProp = stringProp(widget.props, 'font');
    if (isBuiltInFont(fontProp)) {
        style = { ...style, font: fontProp };
    } else if (fontProp !== '') {
        // A declared BDF becomes FontId::Bitmap (spec 5.1, external data); approximate with the packed default.
        style = { ...style, font: 'Tiny3x5' };
    }
    const background = colourProp(widget.props, 'bg');
    if (background !== undefined) {
        style = { ...style, background };
    }
    const foreground = colourProp(widget.props, 'fg');
    if (foreground !== undefined) {
        style = { ...style, foreground };
    }
    const text = colourProp(widget.props, 'text_color');
    if (text !== undefined) {
        style = { ...style, text };
    }
    const border = colourProp(widget.props, 'border_color');
    if (border !== undefined) {
        style = { ...style, border: { color: border, width: 1 } };
    }
    if (widget.props.corner_radius !== undefined) {
        style = { ...style, cornerRadius: numberProp(widget.props, 'corner_radius', style.cornerRadius) };
    }
    return style;
}

// ---------------------------------------------------------------------------
// Per-widget content (spec 4)
// ---------------------------------------------------------------------------

/** Panel (spec 4.1, `widgets/mod.rs:1311-1323`): the block and nothing inside. */
function previewPanel(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    drawBlock(context, rectOf(widget), resolveVisual(panelStyle(widget), state));
}

/** Label (spec 4.2, `widgets/mod.rs:1325-1344`): block, then left/top text; the label ignores the live state. */
function previewLabel(context: CanvasRenderingContext2D, widget: DesignerWidget, _state: VisualState): void {
    // §4.2 resolves VisualState::Normal for a label whatever the input state is.
    const style = resolveVisual(labelOrCarouselStyle(widget, styleNew()), 'normal');
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    drawTextIn(context, blockInner(rect, style), stringProp(widget.props, 'text', 'label', 'title'), style.font, style.text);
}

/** Button (spec 4.3, `widgets/mod.rs:1346-1368`): block, then centred/middle text. */
function previewButton(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(buttonStyle(widget), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    drawTextIn(context, blockInner(rect, style), stringProp(widget.props, 'text', 'label'), style.font, style.text, {
        align: 'center',
        verticalAlign: 'middle',
    });
}

/**
 * Toggle (spec 4.4, `widgets/mod.rs:1459-1494`): a fixed track at the right whose colour is the state.
 *
 * The off-track is the design's `off_color`, or the crate's own `Rgb565::new(7, 10, 10)`
 * (`builders.rs:220`, `emitter.rs:278`); on is `style.accent`, as upstream. The widget's border frames the
 * whole control; the design's own `track_border` optionally outlines the switch track itself
 * (`widgets/mod.rs:1640-1652`), and draws only when a colour is set and the width is above zero.
 */
function previewToggle(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(designStyle(widget, styleNew()), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    const inner = blockInner(rect, style);
    const knobWidth = Math.min(Math.max(Math.floor(inner.w / 4), 8), inner.w);
    const track: Rect = {
        x: rectRight(inner) - knobWidth - 2,
        y: inner.y + 1,
        w: knobWidth,
        h: Math.max(0, inner.h - 2),
    };
    const off = colourProp(widget.props, 'off_color') ?? rgb(7, 10, 10);
    fillSolid(context, track, 0, boolProp(widget.props, 'checked', false) ? style.accent : off, 255);
    // The outline around the switch itself, not the widget's frame (`render_toggle`, `widgets/mod.rs:1642-1652`).
    const trackBorder = colourProp(widget.props, 'track_border');
    const trackBorderWidth = Math.max(0, Math.trunc(numberProp(widget.props, 'track_border_width', 0)));
    if (trackBorder !== undefined && trackBorderWidth > 0) {
        strokeRounded(context, track, 0, { color: trackBorder, width: trackBorderWidth }, 255);
    }
    drawTextIn(
        context,
        { x: inner.x, y: inner.y, w: Math.max(0, inner.w - (knobWidth + 4)), h: inner.h },
        stringProp(widget.props, 'label', 'text'),
        style.font,
        style.text,
    );
}

/**
 * Checkbox: an outlined box and, when checked, an accent square that scales with the box.
 *
 * `box_width`/`box_height` are the size the box wants, each still capped by the cell so it cannot draw outside
 * its own box, and `0` keeps the crate's own `min(inner.h, 8)`, which is why the default box is small.
 * `label_position` puts the label on any of the box's four sides -- the crate's own arrangement is to the
 * right, which is what a design that names nothing gets. `box_color` is the outline, defaulting to
 * `style.text`, the colour the label shares.
 */
function previewCheckbox(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(designStyle(widget, styleNew()), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    const inner = blockInner(rect, style);
    // The crate reads the older, single `box_size` only when the width or the height is *absent* -- an explicit
    // `0` is the sentinel that asks for the crate's own rule, not "use the old size". So this passes `box_size`
    // as the fallback rather than as a value, which is what keeps an older design WYSIWYG while a widget the
    // designer drops -- which names both sizes, at zero -- still draws the crate's default box.
    const legacySize = Math.max(0, Math.trunc(numberProp(widget.props, 'box_size', 0)));
    const requestedWidth = Math.max(0, Math.trunc(numberProp(widget.props, 'box_width', legacySize)));
    const requestedHeight = Math.max(0, Math.trunc(numberProp(widget.props, 'box_height', legacySize)));
    const boxW = requestedWidth === 0 ? Math.min(inner.w, 8) : Math.min(requestedWidth, inner.w);
    const boxH = requestedHeight === 0 ? Math.min(inner.h, 8) : Math.min(requestedHeight, inner.h);
    const gap = 3;
    const textH = Math.max(1, Math.min(lineHeightOf(style), inner.h));
    const position = stringProp(widget.props, 'label_position', '') || 'right';

    let box: Rect;
    let label: Rect;
    if (position === 'left' || position === 'right') {
        // One row: the box at the edge the label is not on, both vertically centred, and the label gets
        // whatever is left.
        const labelW = Math.max(0, inner.w - (boxW + gap));
        box = {
            x: position === 'right' ? inner.x : inner.x + labelW + gap,
            y: inner.y + Math.floor(Math.max(0, inner.h - boxH) / 2),
            w: boxW,
            h: boxH,
        };
        label = {
            x: position === 'right' ? inner.x + boxW + gap : inner.x,
            y: inner.y,
            w: labelW,
            h: inner.h,
        };
    } else {
        // Two rows: the label keeps a band a line tall and the box is centred in what is left, so a box
        // taller than that band is not pushed off the widget.
        const labelH = textH;
        const bandH = Math.max(0, inner.h - (labelH + gap));
        box = {
            x: inner.x + Math.floor(Math.max(0, inner.w - boxW) / 2),
            y:
                position === 'top'
                    ? inner.y + labelH + gap + Math.floor(Math.max(0, bandH - boxH) / 2)
                    : inner.y + Math.floor(Math.max(0, bandH - boxH) / 2),
            w: boxW,
            h: boxH,
        };
        label = {
            x: inner.x,
            y: position === 'top' ? inner.y : inner.y + Math.max(0, inner.h - labelH),
            w: inner.w,
            h: labelH,
        };
    }

    strokeRounded(context, box, 0, { color: colourProp(widget.props, 'box_color') ?? style.text, width: 1 }, 255);
    // A quarter of the box's shorter side, so the tick scales with the box rather than being a fixed two pixels
    // that a large box would swallow and a small one would leave no room in.
    const inset = Math.max(1, Math.floor(Math.min(boxW, boxH) / 4));
    const tick = rectInset(box, allEdges(inset));
    if (boolProp(widget.props, 'checked', false) && tick.w > 0 && tick.h > 0) {
        fillSolid(context, tick, 0, style.accent, 255);
    }
    // Centred on the side it was given, both axes, matching the crate's `TextStyle::centered()`: a label
    // pushed to the far edge of a wide band reads as misplaced rather than as deliberate.
    drawTextIn(context, label, stringProp(widget.props, 'label', 'text'), style.font, style.text, {
        align: 'center',
        verticalAlign: 'middle',
    });
}

/**
 * Slider (spec 4.6, `widgets/mod.rs:1851-1874`): a one-pixel track and an accent grip.
 *
 * The track is `style.text` and the grip `style.accent`, and all three numbers are floats, so the base
 * style is the tag's own `Style::default()` (`emitter.rs:314-325`) with the design's appearance folded on.
 *
 * The grip fills the block's inner height -- the space between the top and bottom borders -- and is `Grip
 * width` pixels across (`render_slider`, `widgets/mod.rs`), travelling across `inner.w - knobWidth` so it
 * sits flush with either end. An absent width means eight pixels, the same default the builder passes.
 */
function previewSlider(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(designStyle(widget, styleNew()), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    const inner = blockInner(rect, style);
    const min = numberProp(widget.props, 'min', 0);
    const max = numberProp(widget.props, 'max', 100);
    const value = numberProp(widget.props, 'value', 0);
    // `f32::EPSILON` in the crate; only its role (a non-zero denominator) matters here.
    const range = Math.max(max - min, 1e-7);
    const t = Math.min(Math.max((value - min) / range, 0), 1);
    const trackY = inner.y + Math.floor(inner.h / 2);
    fillSolid(context, { x: inner.x, y: trackY, w: inner.w, h: 1 }, 0, style.text, 255);
    const requested = Math.trunc(numberProp(widget.props, 'knob_width', 0));
    const knobWidth = Math.min(Math.max(requested === 0 ? 8 : requested, 1), Math.max(inner.w, 1));
    if (inner.h === 0) {
        return;
    }
    const knobX = inner.x + Math.trunc(Math.max(0, inner.w - knobWidth) * t);
    fillSolid(context, { x: knobX, y: inner.y, w: knobWidth, h: inner.h }, 0, style.accent, 255);
}

/**
 * Progress bar (spec 4.7, `widgets/mod.rs:1431-1456`).
 *
 * The emitter passes `Style::default()` unless the design names a style (spec 5.1, `emitter.rs:414-421`), so
 * the block is inert by default and the fill is `style.foreground` (WHITE) in Normal -- `Style::progress()`'s
 * bordered horizontal gradient is *not* what a KDL progress bar gets unless the design picks it.
 */
function previewProgress(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(designStyle(widget, styleNew()), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    const inner = blockInner(rect, style);
    const value = Math.min(Math.max(numberProp(widget.props, 'value', 0), 0), 1);
    const fillWidth = Math.min(Math.trunc(inner.w * value), inner.w);
    if (fillWidth > 0) {
        const colour = state === 'focused' ? style.accent : style.foreground;
        fillSolid(context, { x: inner.x, y: inner.y, w: fillWidth, h: inner.h }, 0, colour, 255);
    }
}

/** Dropdown (spec 4.8, `widgets/mod.rs:2606-2666`): the selected item and a centred arrow, `Style::panel()`. */
function previewDropdown(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    // `designStyle`, not a bare `stylePanel()`: the widget carries its own style, and a chosen font, base
    // style or colour lives in it. Dropping it here was why a dropdown's Font field changed nothing on the
    // canvas while the KDL -- and so the glass -- already had it.
    const style = resolveVisual(designStyle(widget, stylePanel()), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    const inner = blockInner(rect, style);
    const items = optionValues(widget);
    const selected = Math.min(numberProp(widget.props, 'selected', 0), Math.max(0, items.length - 1));
    const text = items[selected] ?? '-';
    // `render_dropdown` (`widgets/mod.rs`) passes the design's alignment to both the selected item and the
    // popup rows; `middle` is the markup's spelling of the crate's `TextAlign::Center`.
    const align: 'left' | 'center' | 'right' =
        stringProp(widget.props, 'align') === 'middle'
            ? 'center'
            : stringProp(widget.props, 'align') === 'right'
                ? 'right'
                : 'left';
    drawTextIn(context, { x: inner.x, y: inner.y, w: Math.max(0, inner.w - 8), h: inner.h }, text, style.font, style.text, {
        align,
    });
    // The design exposes no `open` property, so the popup is never drawn (spec 4.8).
    drawTextIn(
        context,
        { x: rectRight(inner) - 7, y: inner.y, w: 7, h: inner.h },
        'v',
        style.font,
        style.accent,
        { align: 'center', verticalAlign: 'middle' },
    );
}

/** Roller (spec 4.9, `widgets/mod.rs:2733-2774`): previous/current/next in thirds, middle highlighted. */
function previewRoller(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(designStyle(widget, stylePanel()), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    const items = optionValues(widget);
    if (items.length === 0) {
        return;
    }
    const inner = blockInner(rect, style);
    const selected = Math.min(numberProp(widget.props, 'selected', 0), items.length - 1);
    const previous = items[(selected + items.length - 1) % items.length] ?? '';
    const current = items[selected] ?? '';
    const next = items[(selected + 1) % items.length] ?? '';
    const rowHeight = Math.max(Math.floor(inner.h / 3), 1);
    const rows = [previous, current, next];
    for (let index = 0; index < rows.length; index += 1) {
        const row: Rect = { x: inner.x, y: inner.y + index * rowHeight, w: inner.w, h: rowHeight };
        if (index === 1) {
            fillSolid(context, row, 0, style.accent, 255);
        }
        drawTextIn(context, row, rows[index] ?? '', style.font, style.text, {
            align: 'center',
            verticalAlign: 'middle',
        });
    }
}

/** Table (spec 4.10, `widgets/mod.rs:2714-2760`, with the corrected emitter). */
function previewTable(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    // The design's own style, font included -- a table's headers and cells are drawn in it (see the
    // catalogue's note on the tag).
    const style = resolveVisual(designStyle(widget, stylePanel()), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    const rows = tableRows(widget);
    if (rows.length === 0) {
        return;
    }
    const inner = blockInner(rect, style);
    const rowHeight = Math.max(Math.floor(inner.h / rows.length), 1);
    let maxColumns = 1;
    for (const row of rows) {
        maxColumns = Math.max(maxColumns, row.length);
    }
    const columnWidth = Math.max(Math.floor(inner.w / maxColumns), 1);
    for (let r = 0; r < rows.length; r += 1) {
        const row = rows[r] ?? [];
        for (let c = 0; c < maxColumns; c += 1) {
            const cell: Rect = {
                x: inner.x + c * columnWidth,
                y: inner.y + r * rowHeight,
                w: columnWidth,
                h: rowHeight,
            };
            // Separators are hard-coded true and the padding 1 (spec 4.10, `context/builders.rs:929-938`).
            strokeRounded(context, cell, 0, { color: style.border.color, width: 1 }, 255);
            drawTextIn(context, rectInset(cell, allEdges(1)), row[c] ?? '', style.font, style.text);
        }
    }
}

/** Dialog (spec 4.11, `widgets/mod.rs:2025-2063`): a panel block with a centred title and a wrapped body. */
function previewDialog(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    // Title, body and the block itself all come from the design's style, so the widget's own one has to be
    // read here rather than the bare panel default.
    const style = resolveVisual(designStyle(widget, stylePanel()), state);
    const rect = rectOf(widget);
    const title = stringProp(widget.props, 'title');
    // An empty title is treated as absent so content_area returns `inner`; the crate's `Block` would carry
    // `Some("")` if the emitter wrote one, but the designer's default is non-empty.
    drawBlock(context, rect, style, title === '' ? undefined : title);
    const body = contentArea(rect, style, title !== '');
    drawTextIn(context, body, stringProp(widget.props, 'message'), style.font, style.text, {
        align: 'center',
        verticalAlign: 'middle',
        wrap: 'character',
        opacity: style.opacity,
    });
}

/** `scale_rgb565` (spec 4.12, `widgets/mod.rs:169-175`). */
function scale565(colour: Rgb565, num5: number, num6: number): Rgb565 {
    return rgb(
        Math.trunc((colour.r * num5) / 31),
        Math.trunc((colour.g * num6) / 63),
        Math.trunc((colour.b * num5) / 31),
    );
}

/** `carousel_slot_color` (spec 4.12, `widgets/mod.rs:177-184`). */
const CAROUSEL_FALLOFF: readonly (readonly [number, number])[] = [
    [31, 63],
    [12, 24],
    [6, 12],
    [3, 6],
];

function carouselSlotColor(text: Rgb565, distance: number): Rgb565 {
    const falloff = CAROUSEL_FALLOFF[Math.min(distance, 3)] ?? ([31, 63] as const);
    return scale565(text, falloff[0], falloff[1]);
}

/**
 * Carousel (spec 4.12, `widgets/mod.rs:3230-3335`).
 *
 * Rows are drawn with the cursor text engine, not `draw_text_in`, and are *not* clipped to `inner` by the
 * crate -- the inherited clip is what bounds them; on this canvas that is the widget's own rect, so an
 * overflowing row is confined to the widget (which is the closest honest reading, per the parent's host
 * observation, even though spec "Clipping" says the widget clip is the inherited one).
 */
function previewCarousel(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(labelOrCarouselStyle(widget, styleLabel()), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    const items = optionValues(widget);
    const inner = blockInner(rect, style);
    if (items.length === 0 || rectEmpty(inner)) {
        return;
    }
    const count = items.length;
    const step = Math.max(numberProp(widget.props, 'item_step', 16), 1);
    const half = Math.max(numberProp(widget.props, 'visible', 7), 1) / 2 | 0;
    const centreY = inner.y + Math.floor(inner.h / 2);
    const advance = glyphMetrics(style.font).advance;
    const lineHeight = glyphMetrics(style.font).lineHeight;
    const selected = Math.min(numberProp(widget.props, 'selected', 0), items.length - 1);
    const shift = numberProp(widget.props, 'shift', 0);

    for (let rel = -half; rel <= half; rel += 1) {
        const rowCentre = centreY + rel * step + shift;
        if (rowCentre + Math.floor(lineHeight / 2) < inner.y || rowCentre - Math.floor(lineHeight / 2) >= rectBottom(inner)) {
            continue;
        }
        const index = (() => {
            const raw = (selected + rel) % count;
            return raw < 0 ? raw + count : raw;
        })();
        const textValue = items[index] ?? '';
        // `text_left` in the crate is `inner.x + (inner.w - chars*advance) / 2` with non-saturating u32
        // arithmetic (spec 4.12, U7); an item wider than `inner.w` is therefore unspecified there. This
        // floors the signed difference instead, so an overflowing row stays centred about the widget.
        const left = inner.x + Math.floor((inner.w - charCount(textValue) * advance) / 2);
        drawCrateText(context, left, rowCentre - Math.floor(lineHeight / 2), textValue, style.font, carouselSlotColor(style.text, Math.abs(rel)));
    }

    const background = style.background ?? BLACK;
    if (boolProp(widget.props, 'fade', true)) {
        for (let i = 0; i < 6; i += 1) {
            const shade = i < 2 ? background : i < 4 ? scale565(style.text, 1, 2) : scale565(style.text, 2, 4);
            fillSolid(context, { x: inner.x, y: inner.y + i, w: inner.w, h: 1 }, 0, shade, 255);
            fillSolid(context, { x: inner.x, y: rectBottom(inner) - 1 - i, w: inner.w, h: 1 }, 0, shade, 255);
        }
    }
    if (boolProp(widget.props, 'indicator', false)) {
        const pulse = numberProp(widget.props, 'pulse', 255);
        const glow = scale565(style.accent, Math.trunc((pulse * 31) / 255), Math.trunc((pulse * 63) / 255));
        const barWidth = Math.max(numberProp(widget.props, 'indicator_bar_w', 5), 1);
        const barHeight = Math.max(numberProp(widget.props, 'indicator_bar_h', 3), 1);
        const textValue = items[selected] ?? '';
        const left = inner.x + Math.floor((inner.w - charCount(textValue) * advance) / 2);
        const width = charCount(textValue) * advance;
        const y = centreY + shift - Math.floor(barHeight / 2);
        const leftX = left - numberProp(widget.props, 'indicator_gap', 6) - barWidth;
        const rightX = left + width + numberProp(widget.props, 'indicator_gap', 6);
        if (leftX >= inner.x) {
            fillSolid(context, { x: leftX, y, w: barWidth, h: barHeight }, 0, glow, 255);
        }
        if (rightX + barWidth <= rectRight(inner)) {
            fillSolid(context, { x: rightX, y, w: barWidth, h: barHeight }, 0, glow, 255);
        }
    }
    const maskTop = numberProp(widget.props, 'mask_top', 0);
    if (maskTop > 0) {
        fillSolid(context, { x: rect.x, y: rect.y - maskTop, w: rect.w, h: maskTop }, 0, background, 255);
    }
    const maskBottom = numberProp(widget.props, 'mask_bottom', 0);
    if (maskBottom > 0) {
        fillSolid(context, { x: rect.x, y: rectBottom(rect), w: rect.w, h: maskBottom }, 0, background, 255);
    }
}

// ---------------------------------------------------------------------------
// Spinbox and Gauge (spec 4.13-4.14)
//
// The crate has carried both for a while; the canvas had no arm for either, so both fell through to the
// generic outline. They are drawn here from the crate's own render functions rather than from the spec,
// because the spec never covered them: `widgets/spinbox.rs:127-205` and `widgets/scale.rs:95-332`.
// ---------------------------------------------------------------------------

/**
 * `SpinboxWidget::format_text` (`widgets/spinbox.rs:95-125`): the sign, the integer part zero-padded to
 * `digits`, and `decimals` digits after the point.
 *
 * The two are read from the design, because the board's widget gets them: `add_spinbox_styled` takes `digits`
 * and `decimals` (`context/builders.rs`) and the emitter forwards what the panel holds, so a six-digit spinbox
 * prints six digits on the glass. The canvas formats the same two fields, or it would show a number the board
 * does not.
 */
function spinboxText(value: number, digits: number, decimals: number): string {
    const magnitude = Math.abs(Math.trunc(value));
    const sign = value < 0 ? '-' : '';
    if (decimals === 0) {
        return `${sign}${String(magnitude).padStart(digits, '0')}`;
    }
    let divisor = 1;
    for (let i = 0; i < decimals; i += 1) {
        divisor *= 10;
    }
    const integer = Math.floor(magnitude / divisor);
    const fraction = magnitude % divisor;
    const width = Math.max(0, digits - decimals);
    return `${sign}${String(integer).padStart(width, '0')}.${String(fraction).padStart(decimals, '0')}`;
}

/** The value the board's widget holds: `add_spinbox_styled` clamps it to `[min, max]` (`builders.rs:1181`). */
function spinboxValue(widget: DesignerWidget): number {
    const min = numberProp(widget.props, 'min', 0);
    const max = numberProp(widget.props, 'max', 9999);
    const value = numberProp(widget.props, 'value', 0);
    return Math.min(Math.max(value, min), max);
}

/**
 * Spinbox (`widgets/spinbox.rs:127-205`): the block, the value centred on the chosen font's advance, the
 * focused digit's two-pixel underline, and the `-`/`+` chevrons when the inner width reaches 80.
 *
 * The runtime fork measures with `resolved.font.advance()` and `line_height()` rather than the crate's fixed
 * four-pixel cell (`spinbox.rs:146-150`), because measuring with a constant while drawing in a wider face
 * clipped the number and underlined the wrong digit. The canvas mirrors that, so a spinbox in a big font
 * shows the same placement here as on the glass.
 *
 * Every board-built spinbox has `focused_digit: 0` (`builders.rs:1187`), so the underline sits under the
 * *last* formatted character at `start_y + line_h + 1`, two pixels tall and one advance wide. The chevrons
 * are 14-wide boxes at inset 2, stroked in `chevron_color`, with the `-`/`+` centred in them in the text
 * colour; they are skipped entirely below 80 pixels, exactly as the crate's `if inner.w >= 80` does.
 */
function previewSpinbox(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(designStyle(widget, stylePanel()), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    const inner = blockInner(rect, style);

    const digits = numberProp(widget.props, 'digits', 4);
    const decimals = numberProp(widget.props, 'decimals', 0);
    const text = spinboxText(spinboxValue(widget), digits, decimals);
    const metrics = glyphMetrics(style.font);
    const lineHeight = metrics.lineHeight;
    const cellWidth = metrics.advance;
    const totalChars = charCount(text);
    const startX = inner.x + Math.floor(Math.max(0, inner.w - totalChars * cellWidth) / 2);
    const startY = inner.y + Math.floor(Math.max(0, inner.h - lineHeight) / 2);
    drawCrateText(context, startX, startY, text, style.font, style.text);

    const underline: Rect = {
        x: startX + Math.max(0, totalChars - 1) * cellWidth,
        y: startY + lineHeight + 1,
        w: cellWidth,
        h: 2,
    };
    fillSolid(context, underline, 0, colourProp(widget.props, 'accent_color') ?? rgb(0, 63, 31), 255);

    if (inner.w >= 80) {
        const height = Math.max(0, inner.h - 4);
        const left: Rect = { x: inner.x + 2, y: inner.y + 2, w: 14, h: height };
        const right: Rect = { x: rectRight(inner) - 16, y: inner.y + 2, w: 14, h: height };
        const chevron = colourProp(widget.props, 'chevron_color') ?? rgb(16, 32, 16);
        strokeRounded(context, left, 0, { color: chevron, width: 1 }, 255);
        strokeRounded(context, right, 0, { color: chevron, width: 1 }, 255);
        drawTextIn(context, left, '-', style.font, style.text, { align: 'center' });
        drawTextIn(context, right, '+', style.font, style.text, { align: 'center' });
    }
}

/** The `scale mode=` attribute (`emitter.rs:362-368`): radial, vertical, and everything else horizontal. */
function scaleModeOf(widget: DesignerWidget): 'radial' | 'linear_horizontal' | 'linear_vertical' {
    const mode = stringProp(widget.props, 'mode');
    if (mode === '' || mode === 'radial') {
        return 'radial';
    }
    return mode === 'linear_vertical' ? 'linear_vertical' : 'linear_horizontal';
}

/** Rust's `f32::round` (`scale.rs:156`, `:225`, `:295`): half away from zero, unlike `Math.round`. */
function roundHalfAwayFromZero(value: number): number {
    return Math.sign(value) * Math.round(Math.abs(value));
}

/**
 * Gauge (`widgets/scale.rs:95-332`): a graduated dial or bar with a needle.
 *
 * All three modes draw the block first; the radial one then returns without drawing anything when
 * `radius < 8` (`scale.rs:266-269`). Angles are degrees with `y` increasing downwards, because the crate
 * feeds them straight to `sin`/`cos` in framebuffer coordinates and the canvas shares that orientation:
 * 0° is to the right, 90° down, 270° up -- so the default 135°..45° sweep runs across the bottom.
 *
 * The `start_angle`/`end_angle`, the tick counts, the label/needle switches and the two colours all arrive
 * from the design now (`emitter.rs:346-393`); the tick counts were previously unreachable.
 */
function previewScale(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(designStyle(widget, stylePanel()), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    const inner = blockInner(rect, style);

    const mode = scaleModeOf(widget);
    const min = numberProp(widget.props, 'min', 0);
    const max = numberProp(widget.props, 'max', 100);
    const value = numberProp(widget.props, 'value', 0);
    // The builder lifts both counts to at least one (`context/builders.rs:1093-1094`).
    const majorTicks = Math.max(1, Math.trunc(numberProp(widget.props, 'major_ticks', 5)));
    const minorTicks = Math.max(1, Math.trunc(numberProp(widget.props, 'minor_ticks', 2)));
    const startAngle = numberProp(widget.props, 'start_angle', 135);
    const endAngle = numberProp(widget.props, 'end_angle', 45);
    const showLabels = boolProp(widget.props, 'show_labels', true);
    const showNeedle = boolProp(widget.props, 'show_needle', true);
    const tickColour = colourProp(widget.props, 'tick_color') ?? rgb(16, 32, 16);
    const needleColour = colourProp(widget.props, 'needle_color') ?? rgb(31, 0, 0);
    const totalSteps = majorTicks * minorTicks;
    // `f32::EPSILON`'s role: a non-zero denominator when min == max (`scale.rs:140`).
    const range = Math.max(max - min, 1e-7);
    const labelsAt = (t: number): string => String(roundHalfAwayFromZero(min + t * range));

    if (mode === 'radial') {
        const cx = inner.x + Math.floor(inner.w / 2);
        const cy = inner.y + Math.floor(inner.h / 2);
        const radius = Math.max(0, Math.floor(Math.min(inner.w, inner.h) / 2) - 4);
        if (radius < 8) {
            return;
        }
        const sweep = endAngle - startAngle;
        for (let step = 0; step <= totalSteps; step += 1) {
            const t = step / totalSteps;
            const angle = ((startAngle + sweep * t) * Math.PI) / 180;
            const major = step % minorTicks === 0;
            const length = major ? 8 : 4;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            drawLineStyled(
                context,
                cx + Math.trunc((radius - length) * cos),
                cy + Math.trunc((radius - length) * sin),
                cx + Math.trunc(radius * cos),
                cy + Math.trunc(radius * sin),
                tickColour,
                { width: major ? 2 : 1 },
            );
            if (major && showLabels && radius > 20) {
                const lx = cx + Math.trunc((radius - 18) * cos);
                const ly = cy + Math.trunc((radius - 18) * sin);
                drawTextIn(
                    context,
                    { x: lx - 12, y: ly - 6, w: 24, h: 12 },
                    labelsAt(t),
                    style.font,
                    style.text,
                    { align: 'center' },
                );
            }
        }
        if (showNeedle) {
            const t = Math.min(Math.max((value - min) / range, 0), 1);
            const angle = ((startAngle + sweep * t) * Math.PI) / 180;
            const length = radius - 6;
            const nx = cx + Math.trunc(length * Math.cos(angle));
            const ny = cy + Math.trunc(length * Math.sin(angle));
            drawLineStyled(context, cx, cy, nx, ny, needleColour, { width: 2, roundCap: true });
            fillCircle(context, cx, cy, 4, needleColour, 255);
            strokeCircle(context, cx, cy, 4, WHITE, 255);
        }
        return;
    }

    if (mode === 'linear_horizontal') {
        const baseline = inner.y + Math.trunc((inner.h * 2) / 3);
        drawLineStyled(context, inner.x, baseline, rectRight(inner), baseline, tickColour, { width: 1 });
        for (let step = 0; step <= totalSteps; step += 1) {
            const t = step / totalSteps;
            const x = inner.x + Math.trunc(t * inner.w);
            const major = step % minorTicks === 0;
            const length = major ? 8 : 4;
            drawLineStyled(context, x, baseline, x, baseline - length, tickColour, { width: major ? 2 : 1 });
            if (major && showLabels) {
                drawTextIn(
                    context,
                    { x: x - 15, y: baseline - 20, w: 30, h: lineHeightOf(style) },
                    labelsAt(t),
                    style.font,
                    style.text,
                    { align: 'center' },
                );
            }
        }
        if (showNeedle) {
            const t = Math.min(Math.max((value - min) / range, 0), 1);
            const nx = inner.x + Math.trunc(t * inner.w);
            drawLineStyled(context, nx, baseline - 12, nx, baseline + 6, needleColour, { width: 2, roundCap: true });
            fillCircle(context, nx, baseline, 3, needleColour, 255);
        }
        return;
    }

    const baseline = inner.x + Math.trunc(inner.w / 3);
    drawLineStyled(context, baseline, inner.y, baseline, rectBottom(inner), tickColour, { width: 1 });
    for (let step = 0; step <= totalSteps; step += 1) {
        const t = step / totalSteps;
        const y = rectBottom(inner) - Math.trunc(t * inner.h);
        const major = step % minorTicks === 0;
        const length = major ? 8 : 4;
        drawLineStyled(context, baseline, y, baseline + length, y, tickColour, { width: major ? 2 : 1 });
        if (major && showLabels) {
            drawTextIn(
                context,
                { x: baseline + 12, y: y - 4, w: 30, h: lineHeightOf(style) },
                labelsAt(t),
                style.font,
                style.text,
            );
        }
    }
    if (showNeedle) {
        const t = Math.min(Math.max((value - min) / range, 0), 1);
        const ny = rectBottom(inner) - Math.trunc(t * inner.h);
        drawLineStyled(context, baseline - 4, ny, baseline + 12, ny, needleColour, { width: 2, roundCap: true });
        fillCircle(context, baseline, ny, 3, needleColour, 255);
    }
}

// ---------------------------------------------------------------------------
// Sweeping arc, busy wheel, chart, plotter and vector path
//
// These are `WidgetKind` variants the crate has always had but the canvas had no arm for. The workers
// below are the crate's own render functions, read line for line rather than from the spec.
// ---------------------------------------------------------------------------

/** `f32::EPSILON`, the crate's own non-zero denominator (`widgets/mod.rs:1868`, `:2793`, `:2910`). */
const F32_EPSILON = 1.1920928955078125e-7;

/** A value clamped the way `f32::clamp(0.0, 1.0)` resolves it (NaN falls through, as in Rust). */
function clamp01(value: number): number {
    if (value < 0) {
        return 0;
    }
    if (value > 1) {
        return 1;
    }
    return value;
}

/** A Rust `.clamp(min, max)` for integers. */
function clampInt(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

/** `Rect::intersection` (`geometry.rs`): the overlap, or an empty rect when the two miss. */
function rectIntersect(a: Rect, b: Rect): Rect {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const right = Math.min(rectRight(a), rectRight(b));
    const bottom = Math.min(rectBottom(a), rectBottom(b));
    return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
}

/** `normalize_angle_deg` (`render/mod.rs:2482-2490`). */
function normalizeAngleDeg(deg: number): number {
    let value = deg;
    while (value < 0) {
        value += 360;
    }
    while (value >= 360) {
        value -= 360;
    }
    return value;
}

/** `cardinal_unit` (`render/mod.rs:2501-2515`): the exact axes, or `undefined` for a real trig call. */
function cardinalUnit(deg: number): readonly [number, number] | undefined {
    const EPS = 1e-4;
    const normalized = normalizeAngleDeg(deg);
    if (Math.abs(normalized) < EPS) {
        return [1, 0];
    }
    if (Math.abs(normalized - 90) < EPS) {
        return [0, 1];
    }
    if (Math.abs(normalized - 180) < EPS) {
        return [-1, 0];
    }
    if (Math.abs(normalized - 270) < EPS) {
        return [0, -1];
    }
    return undefined;
}

/** `cross` (`render/mod.rs:2518-2520`). */
function cross(ux: number, uy: number, vx: number, vy: number): number {
    return ux * vy - uy * vx;
}

/**
 * `RenderCtx::fill_sector_sweep` (`render/mod.rs:1396-1479`).
 *
 * The crate reduces the sweep to two boundary direction vectors and classifies each pixel inside the circle
 * with two cross products (a convex wedge at 180° or less) or the complement (a reflex one). `clip` is the
 * context's own clip, which the engine sets to the widget's cell, so this walks the same `visible_rect`.
 */
function fillSectorSweep(
    context: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
    startDeg: number,
    sweepDeg: number,
    colour: Rgb565,
    clip: Rect,
): void {
    if (radius === 0) {
        return;
    }
    const draw = rectIntersect({ x: cx - radius, y: cy - radius, w: radius * 2 + 1, h: radius * 2 + 1 }, clip);
    if (rectEmpty(draw)) {
        return;
    }
    const maxSweep = Math.min(Math.abs(sweepDeg), 360);
    if (maxSweep <= 0) {
        return;
    }
    const rr = radius * radius;
    const start = normalizeAngleDeg(startDeg);
    const ccw = sweepDeg >= 0;
    const loDeg = ccw ? start : start - maxSweep;
    const hiDeg = ccw ? start + maxSweep : start;
    const lo = cardinalUnit(loDeg) ?? [Math.cos((loDeg * Math.PI) / 180), Math.sin((loDeg * Math.PI) / 180)];
    const hi = cardinalUnit(hiDeg) ?? [Math.cos((hiDeg * Math.PI) / 180), Math.sin((hiDeg * Math.PI) / 180)];
    const fullCircle = maxSweep >= 360;
    const reflex = maxSweep > 180;
    for (let y = draw.y; y < rectBottom(draw); y += 1) {
        for (let x = draw.x; x < rectRight(draw); x += 1) {
            const dx = x - cx;
            const dy = y - cy;
            if (dx * dx + dy * dy > rr) {
                continue;
            }
            let inSweep: boolean;
            if (fullCircle) {
                inSweep = true;
            } else if (!reflex) {
                inSweep = cross(lo[0], lo[1], dx, dy) >= 0 && cross(dx, dy, hi[0], hi[1]) >= 0;
            } else {
                inSweep = !(cross(hi[0], hi[1], dx, dy) >= 0 && cross(dx, dy, lo[0], lo[1]) >= 0);
            }
            if (inSweep) {
                pixel(context, x, y, colour, 255);
            }
        }
    }
}

/**
 * `RenderCtx::stroke_arc_styled` (`render/mod.rs:1354-1391`): the angle walk with the square pen.
 *
 * The step is two degrees at High quality, the crate's default (`render/mod.rs:1369-1373`), and the
 * endpoints are swapped when the sweep runs backwards. `left/right` and `top/bottom` are the pen offsets.
 */
function strokeArcStyled(
    context: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
    startDeg: number,
    endDeg: number,
    colour: Rgb565,
    options: { readonly width?: number; readonly opacity?: number; readonly joinRound?: boolean } = {},
): void {
    let start = startDeg;
    let end = endDeg;
    if (end < start) {
        const swap = start;
        start = end;
        end = swap;
    }
    const half = Math.max(0, Math.floor((options.width ?? 1) / 2));
    const opacity = options.opacity ?? 255;
    for (let deg = start; deg <= end; deg += 2) {
        const rad = (deg * Math.PI) / 180;
        const x = cx + Math.trunc(radius * Math.cos(rad));
        const y = cy + Math.trunc(radius * Math.sin(rad));
        for (let oy = -half; oy <= half; oy += 1) {
            for (let ox = -half; ox <= half; ox += 1) {
                pixel(context, x + ox, y + oy, colour, opacity);
            }
        }
        if (options.joinRound === true) {
            fillCircle(context, x, y, Math.max(1, half), colour);
        }
    }
}

/**
 * `parse_value_series` (`crates/embedded-gui-codegen/src/parser.rs:291-300`): split on commas or whitespace,
 * drop the empty tokens, parse each as an `f32`, and skip whatever will not parse.
 */
function parseValueSeries(raw: string): number[] {
    const values: number[] = [];
    for (const token of raw.split(/[\s,]+/)) {
        if (token === '') {
            continue;
        }
        const value = rustF32(token);
        if (value !== undefined) {
            values.push(value);
        }
    }
    return values;
}

/** Rust's `f32::from_str`: a decimal with an optional exponent, or the literal infinities / NaN. */
function rustF32(text: string): number | undefined {
    const lower = text.toLowerCase();
    if (lower === 'inf' || lower === '+inf' || lower === 'infinity' || lower === '+infinity') {
        return Infinity;
    }
    if (lower === '-inf' || lower === '-infinity') {
        return -Infinity;
    }
    if (lower === 'nan' || lower === '+nan' || lower === '-nan') {
        return NaN;
    }
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
        return undefined;
    }
    return Number(text);
}

/** One command of an SVG path, in design pixels relative to the widget's top-left corner. */
type PathCommand =
    | { readonly kind: 'move'; readonly x: number; readonly y: number }
    | { readonly kind: 'line'; readonly x: number; readonly y: number }
    | { readonly kind: 'quad'; readonly cx: number; readonly cy: number; readonly x: number; readonly y: number }
    | {
        readonly kind: 'cubic';
        readonly c1x: number;
        readonly c1y: number;
        readonly c2x: number;
        readonly c2y: number;
        readonly x: number;
        readonly y: number;
    }
    | { readonly kind: 'close' };

/** `f32::round` (half away from zero) followed by Rust's saturating `as i32` cast. */
function rustRoundToI32(value: number): number {
    if (Number.isNaN(value)) {
        return 0;
    }
    const rounded = Math.sign(value) * Math.round(Math.abs(value));
    return clampInt(rounded, -2147483648, 2147483647);
}

/**
 * `parse_svg_path_d` (`crates/embedded-gui-codegen/src/parser.rs:64-240`), a line-for-line port.
 *
 * A command letter starts a run of numbers; every number is parsed as an `f32` and rounded to an `i32`, so
 * the board's own coordinates are integers. An unknown letter still consumes its numbers, as the crate does.
 */
function parseSvgPathD(d: string): PathCommand[] {
    const commands: PathCommand[] = [];
    let curX = 0;
    let curY = 0;
    let index = 0;
    while (index < d.length) {
        const ch = d[index] ?? '';
        if (/\s/.test(ch) || ch === ',') {
            index += 1;
            continue;
        }
        if (!/[A-Za-z]/.test(ch)) {
            index += 1;
            continue;
        }
        const command = ch;
        index += 1;
        const relative = command >= 'a' && command <= 'z';
        const numbers: number[] = [];
        while (index < d.length) {
            const next = d[index] ?? '';
            if (/\s/.test(next) || next === ',') {
                index += 1;
                continue;
            }
            if (!/[0-9]/.test(next) && next !== '-' && next !== '+' && next !== '.') {
                break;
            }
            let token = '';
            while (index < d.length) {
                const digit = d[index] ?? '';
                if (/[0-9]/.test(digit) || digit === '-' || digit === '+' || digit === '.') {
                    token += digit;
                    index += 1;
                } else {
                    break;
                }
            }
            const value = rustF32(token);
            if (value !== undefined) {
                numbers.push(rustRoundToI32(value));
            }
        }
        switch (command.toUpperCase()) {
            case 'M': {
                for (let i = 0; i + 1 < numbers.length; i += 2) {
                    curX = relative ? curX + (numbers[i] ?? 0) : numbers[i] ?? 0;
                    curY = relative ? curY + (numbers[i + 1] ?? 0) : numbers[i + 1] ?? 0;
                    commands.push(i === 0 ? { kind: 'move', x: curX, y: curY } : { kind: 'line', x: curX, y: curY });
                }
                break;
            }
            case 'L': {
                for (let i = 0; i + 1 < numbers.length; i += 2) {
                    curX = relative ? curX + (numbers[i] ?? 0) : numbers[i] ?? 0;
                    curY = relative ? curY + (numbers[i + 1] ?? 0) : numbers[i + 1] ?? 0;
                    commands.push({ kind: 'line', x: curX, y: curY });
                }
                break;
            }
            case 'H': {
                for (const x of numbers) {
                    curX = relative ? curX + x : x;
                    commands.push({ kind: 'line', x: curX, y: curY });
                }
                break;
            }
            case 'V': {
                for (const y of numbers) {
                    curY = relative ? curY + y : y;
                    commands.push({ kind: 'line', x: curX, y: curY });
                }
                break;
            }
            case 'Q': {
                for (let i = 0; i + 3 < numbers.length; i += 4) {
                    const cx = relative ? curX + (numbers[i] ?? 0) : numbers[i] ?? 0;
                    const cy = relative ? curY + (numbers[i + 1] ?? 0) : numbers[i + 1] ?? 0;
                    curX = relative ? curX + (numbers[i + 2] ?? 0) : numbers[i + 2] ?? 0;
                    curY = relative ? curY + (numbers[i + 3] ?? 0) : numbers[i + 3] ?? 0;
                    commands.push({ kind: 'quad', cx, cy, x: curX, y: curY });
                }
                break;
            }
            case 'C': {
                for (let i = 0; i + 5 < numbers.length; i += 6) {
                    const c1x = relative ? curX + (numbers[i] ?? 0) : numbers[i] ?? 0;
                    const c1y = relative ? curY + (numbers[i + 1] ?? 0) : numbers[i + 1] ?? 0;
                    const c2x = relative ? curX + (numbers[i + 2] ?? 0) : numbers[i + 2] ?? 0;
                    const c2y = relative ? curY + (numbers[i + 3] ?? 0) : numbers[i + 3] ?? 0;
                    curX = relative ? curX + (numbers[i + 4] ?? 0) : numbers[i + 4] ?? 0;
                    curY = relative ? curY + (numbers[i + 5] ?? 0) : numbers[i + 5] ?? 0;
                    commands.push({ kind: 'cubic', c1x, c1y, c2x, c2y, x: curX, y: curY });
                }
                break;
            }
            case 'Z':
                commands.push({ kind: 'close' });
                break;
            default:
                break;
        }
    }
    return commands;
}

/**
 * `CURVE_STEPS` (`rusty-gui-widgets/src/lib.rs:484`): the fixed twelve segments a curve is flattened into,
 * the number that makes the canvas and the board agree.
 */
const CURVE_STEPS = 12;

/** `VectorPath::stroke` (`rusty-gui-widgets/src/lib.rs:504-522`): the segment stamped with the square pen. */
function pathStroke(
    context: CanvasRenderingContext2D,
    rect: Rect,
    colour: Rgb565,
    half: number,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
): void {
    const ax = rect.x + fromX;
    const ay = rect.y + fromY;
    const bx = rect.x + toX;
    const by = rect.y + toY;
    for (let oy = -half; oy <= half; oy += 1) {
        for (let ox = -half; ox <= half; ox += 1) {
            drawLineStyled(context, ax + ox, ay + oy, bx + ox, by + oy, colour, { width: 1 });
        }
    }
}

/** `VectorPath::quad` (`rusty-gui-widgets/src/lib.rs:525-546`), integer de Casteljau scaled by 12². */
function pathQuad(
    context: CanvasRenderingContext2D,
    rect: Rect,
    colour: Rgb565,
    half: number,
    fromX: number,
    fromY: number,
    controlX: number,
    controlY: number,
    toX: number,
    toY: number,
): void {
    const denominator = CURVE_STEPS * CURVE_STEPS;
    let previousX = fromX;
    let previousY = fromY;
    for (let step = 1; step <= CURVE_STEPS; step += 1) {
        const t = step;
        const inv = CURVE_STEPS - step;
        const x = Math.trunc((inv * inv * fromX + 2 * inv * t * controlX + t * t * toX) / denominator);
        const y = Math.trunc((inv * inv * fromY + 2 * inv * t * controlY + t * t * toY) / denominator);
        pathStroke(context, rect, colour, half, previousX, previousY, x, y);
        previousX = x;
        previousY = y;
    }
}

/** `VectorPath::cubic` (`rusty-gui-widgets/src/lib.rs:549-578`), integer de Casteljau scaled by 12³. */
function pathCubic(
    context: CanvasRenderingContext2D,
    rect: Rect,
    colour: Rgb565,
    half: number,
    fromX: number,
    fromY: number,
    firstX: number,
    firstY: number,
    secondX: number,
    secondY: number,
    toX: number,
    toY: number,
): void {
    const denominator = CURVE_STEPS * CURVE_STEPS * CURVE_STEPS;
    let previousX = fromX;
    let previousY = fromY;
    for (let step = 1; step <= CURVE_STEPS; step += 1) {
        const t = step;
        const inv = CURVE_STEPS - step;
        const x = Math.trunc(
            (inv * inv * inv * fromX + 3 * inv * inv * t * firstX + 3 * inv * t * t * secondX + t * t * t * toX) /
            denominator,
        );
        const y = Math.trunc(
            (inv * inv * inv * fromY + 3 * inv * inv * t * firstY + 3 * inv * t * t * secondY + t * t * t * toY) /
            denominator,
        );
        pathStroke(context, rect, colour, half, previousX, previousY, x, y);
        previousX = x;
        previousY = y;
    }
}

/**
 * Sweeping arc (`render_sweeping_arc`, `widgets/mod.rs:2587-2619`; emitted by `emitter.rs:440-478`).
 *
 * `arc_radius` of zero means "fit the cell", which the emitter inlines as `min(w,h)/2 - 8`, so the canvas
 * evaluates the same expression. The frame is filled, and painted *after* the sector, so only the sector
 * outside the frame is visible -- the crate's own order, kept.
 */
/**
 * Clock (`widgets/clock.rs`): the gauge's radial dial with twelve hour marks, sixty minute marks,
 * the hour numerals, and three hands.
 *
 * The angles are the crate's: degrees with `y` down, so -90 is twelve o'clock. The hands sit
 * *between* the marks as the smaller units pass (`3:30` points halfway between 3 and 4), which is
 * what makes a clock face read as a time rather than as three unrelated needles. The numerals are
 * magnified by `Number size`, because the built-in faces are fixed bitmaps -- `drawClockLabel`
 * mirrors `draw_scaled_text` in the crate, one block per glyph pixel.
 */
function previewClock(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(designStyle(widget, stylePanel()), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    if (rectEmpty(rect)) {
        return;
    }
    const inner = blockInner(rect, style);
    const cx = inner.x + Math.trunc(inner.w / 2);
    const cy = inner.y + Math.trunc(inner.h / 2);
    const radius = Math.max(0, Math.trunc(Math.min(inner.w, inner.h) / 2) - 4);
    if (radius < 12) {
        return;
    }

    // `TWELVE_OCLOCK` and the two step sizes, exactly as `clock.rs` has them.
    const twelve = -90;
    const hourTick = colourProp(widget.props, 'hour_tick_color') ?? rgb(16, 32, 16);
    const minuteTick = colourProp(widget.props, 'minute_tick_color') ?? rgb(10, 20, 10);
    const tick = (angleDeg: number, length: number, width: number, colour: Rgb565) => {
        const radians = (angleDeg * Math.PI) / 180;
        const innerR = Math.max(0, radius - length);
        strokeClockLine(
            context,
            cx + Math.trunc(innerR * Math.cos(radians)),
            cy + Math.trunc(innerR * Math.sin(radians)),
            cx + Math.trunc(radius * Math.cos(radians)),
            cy + Math.trunc(radius * Math.sin(radians)),
            colour,
            width,
            'butt',
        );
    };
    // The minutes first: an hour mark is drawn over the position it shares with one, so the long
    // tick is never half-hidden behind a short one.
    for (let minute = 0; minute < 60; minute += 1) {
        if (minute % 5 === 0) {
            continue;
        }
        tick(twelve + minute * 6, 4, 1, minuteTick);
    }
    for (let hour = 0; hour < 12; hour += 1) {
        tick(twelve + hour * 30, 8, 2, hourTick);
    }

    if (boolProp(widget.props, 'show_labels', true) && radius > 24) {
        const labelColour = colourProp(widget.props, 'label_color') ?? rgb(31, 63, 31);
        const scale = Math.max(1, Math.trunc(numberProp(widget.props, 'label_scale', 1)));
        const inset = Math.max(0, radius - 16);
        for (let hour = 1; hour <= 12; hour += 1) {
            const radians = ((twelve + hour * 30) * Math.PI) / 180;
            drawClockLabel(
                context,
                cx + Math.trunc(inset * Math.cos(radians)),
                cy + Math.trunc(inset * Math.sin(radians)),
                String(hour),
                style.font,
                labelColour,
                scale,
            );
        }
    }

    const hour = Math.min(Math.max(Math.trunc(numberProp(widget.props, 'hour', 10)), 0), 23);
    const minute = Math.min(Math.max(Math.trunc(numberProp(widget.props, 'minute', 10)), 0), 59);
    const second = Math.min(Math.max(Math.trunc(numberProp(widget.props, 'second', 0)), 0), 59);
    const hands: [number, number, number, Rgb565][] = [
        [twelve + (hour % 12 + minute / 60) * 30, 0.5, 3, colourProp(widget.props, 'hour_color') ?? rgb(31, 63, 31)],
        // The minute hand steps half a tick at a time, exactly as `clock.rs` draws it: on the mark
        // for the first half of the minute, halfway between marks for the second half.
        [twelve + (minute + (second >= 30 ? 0.5 : 0)) * 6, 0.72, 2, colourProp(widget.props, 'minute_color') ?? rgb(31, 63, 31)],
        [twelve + second * 6, 0.88, 1, colourProp(widget.props, 'second_color') ?? rgb(31, 0, 0)],
    ];
    for (const [angle, fraction, width, colour] of hands) {
        const radians = (angle * Math.PI) / 180;
        const length = radius * fraction;
        strokeClockLine(
            context,
            cx,
            cy,
            cx + Math.trunc(length * Math.cos(radians)),
            cy + Math.trunc(length * Math.sin(radians)),
            colour,
            width,
            'round',
        );
    }
    fillSolid(context, { x: cx - 3, y: cy - 3, w: 6, h: 6 }, 3, colourProp(widget.props, 'hour_color') ?? rgb(31, 63, 31), 255);
}

/** One straight stroke, the way `draw_line_styled` paints it: a colour, a width and a cap. */
function strokeClockLine(
    context: CanvasRenderingContext2D,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    colour: Rgb565,
    width: number,
    cap: 'butt' | 'round',
): void {
    context.strokeStyle = css(colour);
    context.lineWidth = width;
    context.lineCap = cap;
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
    context.stroke();
}

/**
 * The crate's `draw_scaled_text`: text centred on a point, every glyph pixel a block.
 *
 * The block follows the face -- `Scaled6x10` is two-by-two blocks of the 3x5 table, everything else one
 * pixel per bit (`render/mod.rs`) -- and the box that is centred is the glyph's **ink** (three columns,
 * five rows), not its cell: a packed digit's ink is three of the four pixels of its advance, so
 * centring the cell leaves the number visibly off to one side of the tick it belongs to.
 *
 * The bit test is the crate's: bit `width - 1 - col` of a row is column `col`, so the ink of a 3x5
 * face occupies columns 0..2 of its cell and a rasterised one all six or eight. Reading the low bits as
 * high columns is what made every numeral sit a few pixels to the right of its tick.
 */
function drawClockLabel(
    context: CanvasRenderingContext2D,
    centreX: number,
    centreY: number,
    text: string,
    font: string,
    colour: Rgb565,
    scale: number,
): void {
    const metrics = glyphMetrics(font);
    const block = glyphBlockSize(font) * scale;
    const advance = metrics.advance * scale;
    const columns = glyphColumns(font);
    const inkWidth = columns * block;
    const inkHeight = glyphRowCount(font) * block;
    const width = inkWidth + Math.max(0, charCount(text) - 1) * advance;
    const top = centreY - Math.trunc(inkHeight / 2);
    let cursor = centreX - Math.trunc(width / 2);
    for (const ch of text) {
        const rows = glyphRows(font, ch);
        for (let row = 0; row < glyphRowCount(font); row += 1) {
            const bits = rows[row] ?? 0;
            for (let col = 0; col < columns; col += 1) {
                if ((bits & (1 << (columns - 1 - col))) === 0) {
                    continue;
                }
                context.fillStyle = css(colour);
                context.fillRect(cursor + col * block, top + row * block, block, block);
            }
        }
        cursor += advance;
    }
}

function previewArc(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(designStyle(widget, stylePanel()), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    fillSolid(context, rect, 0, colourProp(widget.props, 'bg_color') ?? rgb(2, 4, 8), 255);
    const cx = rect.x + Math.trunc(rect.w / 2);
    const cy = rect.y + Math.trunc(rect.h / 2);
    const requested = Math.max(0, Math.trunc(numberProp(widget.props, 'arc_radius', 0)));
    const radius =
        requested === 0 ? Math.max(0, Math.trunc(Math.min(rect.w, rect.h) / 2) - 8) : requested;
    const progress = clamp01(numberProp(widget.props, 'progress', 0.5));
    const sweep = progress * 360;
    const signed = boolProp(widget.props, 'clockwise', true) ? -sweep : sweep;
    fillSectorSweep(context, cx, cy, radius, -90, signed, colourProp(widget.props, 'arc_color') ?? rgb(0, 40, 31), rect);
    const inset = Math.max(0, Math.trunc(numberProp(widget.props, 'frame_inset', 4)));
    const frame: Rect = {
        x: rect.x + inset,
        y: rect.y + inset,
        w: Math.max(0, rect.w - 2 * inset),
        h: Math.max(0, rect.h - 2 * inset),
    };
    const corner = Math.max(0, Math.trunc(numberProp(widget.props, 'corner_radius', 4)));
    const frameColour = colourProp(widget.props, 'frame_color') ?? rgb(8, 16, 8);
    fillSolid(context, frame, corner, frameColour, 255);
    strokeRounded(context, frame, corner, { color: frameColour, width: 1 }, 255);
}

/**
 * Busy wheel (`render_spinner`, `widgets/mod.rs:2940-2969`): a 120° arc whose start follows `phase`.
 *
 * `base = (phase.fract() * 360) as i32` then `rem_euclid(360)`; the arc is stroked at width two with
 * antialiasing, which the crate's High-quality compositor dithers at opacity 220 (`render/mod.rs:2102-2112`).
 */
function previewSpinner(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(designStyle(widget, stylePanel()), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    const inner = blockInner(rect, style);
    const cx = inner.x + Math.trunc(inner.w / 2);
    const cy = inner.y + Math.trunc(inner.h / 2);
    const radius = Math.max(0, Math.trunc(Math.min(inner.w, inner.h) / 2) - 1);
    const phase = numberProp(widget.props, 'phase', 0);
    // Rust's `(phase.fract() * 360.0) as i32) .rem_euclid(360)`: fract keeps the sign, the cast truncates.
    const base = (((Math.trunc((phase % 1) * 360) % 360) + 360) % 360);
    strokeArcStyled(context, cx, cy, radius, base, base + 120, style.accent, { width: 2, opacity: 220 });
}

/**
 * Chart (`render_chart`, `widgets/mod.rs:2709-2853`), as `add_chart` configures it (`builders.rs:767-794`):
 * a `Line` series at thickness one, no fill, markers, grid, axes or labels.
 */
function previewChart(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(designStyle(widget, stylePanel()), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    const values = parseValueSeries(stringProp(widget.props, 'values'));
    if (values.length < 2) {
        return;
    }
    const inner = blockInner(rect, style);
    const min = numberProp(widget.props, 'min', 0);
    const max = numberProp(widget.props, 'max', 10);
    const range = Math.max(max - min, F32_EPSILON);
    const step = Math.max(0, inner.w - 1) / Math.max(1, values.length - 1);
    for (let i = 1; i < values.length; i += 1) {
        const v0 = clamp01(((values[i - 1] ?? 0) - min) / range);
        const v1 = clamp01(((values[i] ?? 0) - min) / range);
        const x0 = inner.x + Math.trunc((i - 1) * step);
        const x1 = inner.x + Math.trunc(i * step);
        const y0 = rectBottom(inner) - 1 - Math.trunc(v0 * Math.max(0, inner.h - 1));
        const y1 = rectBottom(inner) - 1 - Math.trunc(v1 * Math.max(0, inner.h - 1));
        drawLineStyled(context, x0, y0, x1, y1, style.accent, { width: 1, opacity: 220 });
    }
}

/**
 * Plotter (`render_plotter`, `widgets/mod.rs:2856-2938`): the same trace, but the newest value is at `head`
 * and the older ones wrap around behind it.
 */
function previewPlotter(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(designStyle(widget, stylePanel()), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    const values = parseValueSeries(stringProp(widget.props, 'values'));
    if (values.length < 2) {
        return;
    }
    const inner = blockInner(rect, style);
    const min = numberProp(widget.props, 'min', 0);
    const max = numberProp(widget.props, 'max', 10);
    const range = Math.max(max - min, F32_EPSILON);
    const head = Math.max(0, Math.trunc(numberProp(widget.props, 'head', 0)));
    const step = Math.max(0, inner.w - 1) / Math.max(1, values.length - 1);
    for (let i = 1; i < values.length; i += 1) {
        const idx0 = (head + i - 1) % values.length;
        const idx1 = (head + i) % values.length;
        const v0 = clamp01(((values[idx0] ?? 0) - min) / range);
        const v1 = clamp01(((values[idx1] ?? 0) - min) / range);
        const x0 = inner.x + Math.trunc((i - 1) * step);
        const x1 = inner.x + Math.trunc(i * step);
        const y0 = rectBottom(inner) - 1 - Math.trunc(v0 * Math.max(0, inner.h - 1));
        const y1 = rectBottom(inner) - 1 - Math.trunc(v1 * Math.max(0, inner.h - 1));
        drawLineStyled(context, x0, y0, x1, y1, style.accent, { width: 1, opacity: 220 });
    }
}

/**
 * Vector path (`VectorPath::render`, `rusty-gui-widgets/src/lib.rs:581-649`): the design's own verbs,
 * stroked through the canvas's one-pixel line, with the pen width spread symmetrically around each segment.
 *
 * It draws no block: a custom widget paints only what it paints. The cell's origin is added here, so the
 * path is written relative to its widget.
 */
function previewPath(context: CanvasRenderingContext2D, widget: DesignerWidget, _state: VisualState): void {
    const colour = colourProp(widget.props, 'colour');
    if (colour === undefined) {
        return;
    }
    const rect = rectOf(widget);
    const commands = parseSvgPathD(stringProp(widget.props, 'd', 'data'));
    if (commands.length === 0 || rect.w === 0 || rect.h === 0) {
        return;
    }
    const half = Math.max(1, Math.trunc(numberProp(widget.props, 'stroke_width', 1))) >> 1;
    let penX = 0;
    let penY = 0;
    let startX = 0;
    let startY = 0;
    let open = false;
    for (const command of commands) {
        switch (command.kind) {
            case 'move':
                penX = command.x;
                penY = command.y;
                startX = command.x;
                startY = command.y;
                open = true;
                break;
            case 'line':
                if (!open) {
                    startX = penX;
                    startY = penY;
                    open = true;
                }
                pathStroke(context, rect, colour, half, penX, penY, command.x, command.y);
                penX = command.x;
                penY = command.y;
                break;
            case 'quad':
                if (!open) {
                    startX = penX;
                    startY = penY;
                    open = true;
                }
                pathQuad(context, rect, colour, half, penX, penY, command.cx, command.cy, command.x, command.y);
                penX = command.x;
                penY = command.y;
                break;
            case 'cubic':
                if (!open) {
                    startX = penX;
                    startY = penY;
                    open = true;
                }
                pathCubic(context, rect, colour, half, penX, penY, command.c1x, command.c1y, command.c2x, command.c2y, command.x, command.y);
                penX = command.x;
                penY = command.y;
                break;
            case 'close':
                pathStroke(context, rect, colour, half, penX, penY, startX, startY);
                penX = startX;
                penY = startY;
                open = false;
                break;
        }
    }
}

/**
 * `StatusBarWidget::render` (`widgets/status_bar.rs:134-240`) with the fields `render_status_bar`
 * (`widgets/mod.rs:1666-1691`) maps a style onto: background from `style.background` when set, foreground
 * from `style.text`, accent from `style.accent`, and the face from `style.font` -- which reaches every glyph
 * the bar draws: the clock, the Bluetooth mark and the battery's charge mark.
 *
 * The clock is centred on the *chosen* font's advance and sits on its line height (`status_bar.rs:164-175`),
 * so a bar in a big face draws a big clock in the middle rather than a big clock pushed off to one side.
 */
function drawStatusBar(
    context: CanvasRenderingContext2D,
    rect: Rect,
    time: string,
    font: string,
    background: Rgb565,
    foreground: Rgb565,
    accent: Rgb565,
): void {
    // `StatusBarWidget::render` returns on an empty bounds (`status_bar.rs:143`).
    if (rectEmpty(rect)) {
        return;
    }
    const metrics = glyphMetrics(font);
    fillSolid(context, rect, 0, background, 255);
    fillSolid(context, { x: rect.x, y: rectBottom(rect) - 1, w: rect.w, h: 1 }, 0, rgb(6, 12, 18), 255);
    const centerY = rect.y + Math.trunc(rect.h / 2);
    // Clock: centred on the font's own advance (`status_bar.rs:170-183`).
    const textWidth = time.length * metrics.advance;
    drawCrateText(
        context,
        rect.x + Math.trunc((rect.w - textWidth) / 2),
        centerY - Math.trunc(metrics.lineHeight / 2),
        time,
        font,
        foreground,
    );
    // Bluetooth glyph, left inset six (`status_bar.rs:176-185`).
    const bx = rect.x + 6;
    const by = centerY - 4;
    strokeRounded(context, { x: bx, y: by, w: 6, h: 8 }, 0, { color: accent, width: 1 }, 255);
    drawCrateText(context, bx + 1, by + 1, 'B', font, accent);
    // Battery shell, terminal nipple and level (`status_bar.rs:195-230`).
    const battW = 16;
    const battH = 8;
    const battX = rectRight(rect) - 6 - battW;
    const battY = centerY - 4;
    strokeRounded(context, { x: battX, y: battY, w: battW, h: battH }, 0, { color: foreground, width: 1 }, 255);
    fillSolid(context, { x: battX + battW, y: battY + 2, w: 2, h: 4 }, 0, foreground, 255);
    const maxFill = battW - 4;
    const fillWidth = Math.max(Math.trunc((85 * maxFill) / 100), 1);
    fillSolid(context, { x: battX + 2, y: battY + 2, w: fillWidth, h: battH - 4 }, 0, foreground, 255);
}

/**
 * Status bar (crate `render_status_bar`, `widgets/mod.rs:1666-1691`).
 *
 * The style maps onto the widget's own fields, so `text_color` is the clock and icon colour and `accent`
 * the Bluetooth colour; the separator and the battery's own geometry come from the default widget.
 */
/** The keypad's rows, exactly as `keypad.rs` lays them out: a legend (or an action) and its weight. */
type KeypadKeySpec = readonly [string, number];

/** The mode key's label is the mode it moves to, so the action is a placeholder until it is drawn. */
const KEYPAD_MODE_KEY = 'mode';

function letterRow(text: string): readonly KeypadKeySpec[] {
    return Array.from(text).map((ch): KeypadKeySpec => [ch, 1]);
}

const KEYPAD_TEXT_ROWS: readonly (readonly KeypadKeySpec[])[] = [
    // The digit row sits above `qwerty`, which is why the mode key no longer offers a digits page.
    letterRow('1234567890'),
    letterRow('qwertyuiop'),
    letterRow('asdfghjkl;'),
    letterRow('zxcvbnm,./'),
    // Shift and the mode key are wide enough to hit with a thumb; the space bar takes the middle.
    // The keys that act are labelled with words, not single letters that read as alphabet keys.
    [['SHIFT', 2], [KEYPAD_MODE_KEY, 2], [' ', 4], ['<', 2]],
    [['CLR', 4], ['ENT', 6]],
];

const KEYPAD_NUMERIC_ROWS: readonly (readonly KeypadKeySpec[])[] = [
    letterRow('123'),
    letterRow('456'),
    letterRow('789'),
    [['.', 1], ['0', 1], ['<', 1]],
    [[KEYPAD_MODE_KEY, 1], ['CLR', 1], ['ENT', 1]],
];

// The set asked for on 2026-10-17: `~!@#$%^&*()-=_+[]\{}|;':",./<>?`, in that order, broken at eight.
const KEYPAD_SYMBOL_ROWS: readonly (readonly KeypadKeySpec[])[] = [
    letterRow('~!@#$%^&'),
    letterRow('*()-_=+['),
    letterRow("]\\{}|;':"),
    letterRow('",./<>?'),
    [[KEYPAD_MODE_KEY, 2], [' ', 4], ['<', 2]],
    [['CLR', 3], ['ENT', 5]],
];

/** The mode key says where it goes, so the key is a promise rather than a label. */
function keypadModeLabel(mode: string): string {
    // Two pages: the digits are on the letters page now, so the key promises the symbols instead.
    return mode === 'text' ? '%%...' : 'ABC';
}

/**
 * `KeypadWidget::render` (`keypad.rs`): the entry box on the top edge, then the mode's rows of keys
 * whose widths are their share of the row's weights.
 *
 * The geometry is the widget's own and is written out the same way there, so a drag in the canvas
 * lands on the key the panel would act on. The typed line is the app's, not the design's, so the
 * preview shows the empty box and its caret.
 */
function previewKeypad(
    context: CanvasRenderingContext2D,
    widget: DesignerWidget,
    state: VisualState,
): void {
    const style = resolveVisual(designStyle(widget, stylePanel()), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    if (rectEmpty(rect)) {
        return;
    }
    const mode = stringProp(widget.props, 'mode', 'text');
    const shift = boolProp(widget.props, 'shift', false);
    const rows =
        mode === 'numeric' ? KEYPAD_NUMERIC_ROWS : mode === 'symbol' ? KEYPAD_SYMBOL_ROWS : KEYPAD_TEXT_ROWS;
    const line = glyphMetrics(style.font).lineHeight;
    const entryHeight = Math.min(Math.max(1, Math.trunc(line + 5)), Math.max(1, Math.trunc(rect.h / 2)));
    const entry: Rect = {
        x: rect.x + 2,
        y: rect.y + 2,
        w: Math.max(0, rect.w - 4),
        h: Math.min(entryHeight, Math.max(0, rect.h - 2)),
    };
    const areaY = entry.y + entry.h + 1;
    const area: Rect = {
        x: rect.x + 2,
        y: areaY,
        w: Math.max(0, rect.w - 4),
        h: Math.max(0, rect.y + rect.h - areaY - 1),
    };

    // The six surfaces the design colours, with the widget's own defaults behind them.
    const textColour = colourProp(widget.props, 'text_color') ?? rgb(31, 63, 31);
    const keyColour = colourProp(widget.props, 'key_color') ?? rgb(6, 12, 16);
    const legendColour = colourProp(widget.props, 'legend_color') ?? rgb(31, 63, 31);
    const accentColour = colourProp(widget.props, 'accent_color') ?? rgb(2, 16, 24);
    // Caps lock is shown the only way a keypad can show it: the Shift key wears the pressed face.
    const pressedColour = colourProp(widget.props, 'pressed_key_color') ?? rgb(12, 24, 31);
    const entryFace = colourProp(widget.props, 'entry_face') ?? rgb(1, 2, 4);
    const entryBorder = colourProp(widget.props, 'entry_border') ?? rgb(16, 32, 16);

    // The entry box: its face, its one-pixel edge and the caret of an empty line.
    fillSolid(context, entry, 0, entryFace, 255);
    fillSolid(context, { x: entry.x, y: entry.y, w: entry.w, h: 1 }, 0, entryBorder, 255);
    fillSolid(context, { x: entry.x, y: entry.y + entry.h - 1, w: entry.w, h: 1 }, 0, entryBorder, 255);
    fillSolid(context, { x: entry.x, y: entry.y, w: 1, h: entry.h }, 0, entryBorder, 255);
    fillSolid(context, { x: entry.x + entry.w - 1, y: entry.y, w: 1, h: entry.h }, 0, entryBorder, 255);
    // The line is left-justified three pixels in and centred between the box's edges, as the widget
    // draws it; the caret is an underscore after the last character.
    drawTextIn(context, { x: entry.x + 3, y: entry.y, w: Math.max(0, entry.w - 6), h: entry.h }, '_', style.font, textColour, {
        align: 'left',
        verticalAlign: 'middle',
    });

    const rowHeight = Math.trunc(area.h / rows.length);
    rows.forEach((keys, row) => {
        const total = keys.reduce((sum, [, weight]) => sum + weight, 0);
        const y = area.y + row * rowHeight;
        const height = row + 1 === rows.length ? Math.max(0, area.y + area.h - y) : rowHeight;
        let used = 0;
        keys.forEach(([legend, weight]) => {
            const x = area.x + Math.trunc((area.w * used) / total);
            const nextX = area.x + Math.trunc((area.w * (used + weight)) / total);
            used += weight;
            const cell: Rect = { x, y, w: Math.max(0, nextX - x), h: Math.max(0, height) };
            if (cell.w <= 2 || cell.h <= 2) {
                return;
            }
            // The keys that act instead of typing wear the accent colour, as the widget draws them.
            const control =
                legend === 'SHIFT' || legend === KEYPAD_MODE_KEY || legend === '<' || legend === 'CLR' || legend === 'ENT';
            const lit = control && legend === 'SHIFT' && shift;
            const face = lit ? pressedColour : control ? accentColour : keyColour;
            const inner: Rect = { x: cell.x + 1, y: cell.y + 1, w: cell.w - 2, h: cell.h - 2 };
            fillSolid(context, inner, 0, face, 255);
            // Shift is a caps lock: the letter keys say what they will type, exactly as the widget
            // redraws them when it toggles.
            const shifted = shift && legend.length === 1 && /[a-z]/.test(legend);
            const label =
                legend === KEYPAD_MODE_KEY
                    ? keypadModeLabel(mode)
                    : shifted
                        ? legend.toUpperCase()
                        : legend;
            if (label !== ' ') {
                const colour = control ? textColour : legendColour;
                drawTextIn(context, inner, label, style.font, colour, {
                    align: 'center',
                    verticalAlign: 'middle',
                });
            }
        });
    });
}

function previewStatusBar(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(designStyle(widget, stylePanel()), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    drawStatusBar(
        context,
        rect,
        stringProp(widget.props, 'time'),
        style.font,
        style.background ?? rgb(2, 4, 8),
        style.text,
        style.accent,
    );
}

/**
 * `TimePickerWidget::render` twice over (`picker.rs:192-310`), through `render_time_picker`
 * (`widgets/mod.rs:1694-1722`): background from `style.background`, `text_color` from `style.text` and
 * `focus_color` from `style.accent`. The hour/min/minute clamp and the focused Hour segment are the
 * constructor's and the default's.
 */
function previewTimePicker(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(designStyle(widget, stylePanel()), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    if (rectEmpty(rect)) {
        return;
    }
    const is12h = boolProp(widget.props, 'is_12h', true);
    const isPm = boolProp(widget.props, 'is_pm', false);
    const parsedHour = clampInt(Math.trunc(numberProp(widget.props, 'hour', 12)), 0, 23);
    const parsedMinute = clampInt(Math.trunc(numberProp(widget.props, 'minute', 0)), 0, 59);
    const hour = is12h ? clampInt(parsedHour, 1, 12) : Math.min(parsedHour, 23);
    const minute = Math.min(parsedMinute, 59);
    const background = style.background ?? rgb(3, 6, 12);
    const textColour = style.text;
    const focusColour = style.accent;
    const metrics = glyphMetrics(style.font);
    fillSolid(context, rect, 6, background, 255);
    strokeRounded(context, rect, 6, { color: rgb(6, 16, 26), width: 1 }, 255);
    const numFields = is12h ? 3 : 2;
    const spacing = 6;
    const totalSpacing = spacing * (numFields - 1);
    const cellW = Math.max(Math.trunc((rect.w - 24 - totalSpacing) / numFields), 28);
    const cellH = Math.max(Math.max(0, rect.h - 16), 24);
    const startX = rect.x + Math.trunc((rect.w - (cellW * numFields + totalSpacing)) / 2);
    const cellY = rect.y + Math.trunc((rect.h - cellH) / 2);
    const fields = is12h ? ['hour', 'minute', 'period'] : ['hour', 'minute'];
    for (let i = 0; i < numFields; i += 1) {
        const field = fields[i] ?? 'hour';
        // `TimePickerWidget::default` focuses the hour (`picker.rs:84`).
        const isFocused = field === 'hour';
        const cx = startX + i * (cellW + spacing);
        const cell: Rect = { x: cx, y: cellY, w: cellW, h: cellH };
        fillSolid(context, cell, 4, isFocused ? rgb(0, 30, 45) : rgb(4, 8, 16), 255);
        strokeRounded(context, cell, 4, { color: isFocused ? focusColour : rgb(8, 16, 24), width: 1 }, 255);
        const text =
            field === 'hour' ? String(hour).padStart(2, '0') : field === 'minute' ? String(minute).padStart(2, '0') : isPm ? 'PM' : 'AM';
        // `TimePickerWidget::render` centres each field on the font's own advance and sits it on that font's
        // line height (`picker.rs:293-300`), which is the only way a bigger face stays inside its cell.
        const textX = cell.x + Math.trunc((cellW - text.length * metrics.advance) / 2);
        drawCrateText(
            context,
            textX,
            cell.y + Math.trunc(cellH / 2) - Math.trunc(metrics.lineHeight / 2),
            text,
            style.font,
            isFocused ? focusColour : textColour,
        );
        if (isFocused) {
            const caretX = cell.x + Math.trunc(cellW / 2) - 2;
            drawCrateText(context, caretX, cell.y - 8, '^', style.font, focusColour);
            drawCrateText(context, caretX, rectBottom(cell) + 2, 'v', style.font, focusColour);
        }
    }
}

/**
 * Number picker (`NumberPickerWidget::render`, `picker.rs:357-395`; `render_number_picker`,
 * `widgets/mod.rs:1725-1746`).
 *
 * The widget always paints its own focused card -- `rgb(0,30,40)` with a `CSS_CYAN` border -- and its text
 * is always `CSS_WHITE`; `render_number_picker` passes no colour field to it, so the design's `text_color`
 * reaches only the block underneath, which the card covers. The face, though, *is* handed over
 * (`picker.rs:395-407`), and the value is centred on that face's advance and sits on its line height.
 * The value is clamped the way the builder does before `NumberPickerWidget::new` clamps it again.
 */
function previewNumberPicker(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(designStyle(widget, stylePanel()), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    if (rectEmpty(rect)) {
        return;
    }
    const min = Math.trunc(numberProp(widget.props, 'min', 0));
    const max = Math.trunc(numberProp(widget.props, 'max', 100));
    const initial = Math.trunc(numberProp(widget.props, 'value', 0));
    const value = clampInt(initial, Math.min(min, max), Math.max(min, max));
    const unit = stringProp(widget.props, 'unit');
    fillSolid(context, rect, 4, rgb(0, 30, 40), 255);
    strokeRounded(context, rect, 4, { color: rgb(0, 63, 31), width: 1 }, 255);
    const text = `${value} ${unit}`;
    const metrics = glyphMetrics(style.font);
    const textX = rect.x + Math.trunc((rect.w - text.length * metrics.advance) / 2);
    drawCrateText(
        context,
        textX,
        rect.y + Math.trunc(rect.h / 2) - Math.trunc(metrics.lineHeight / 2),
        text,
        style.font,
        rgb(31, 63, 31),
    );
}

/**
 * Content indicator (`ContentIndicatorWidget::render`, `wearable.rs:42-75`; `render_content_indicator`,
 * `widgets/mod.rs:1749-1774`).
 *
 * It is a chevron, not a row of dots: `count` and `active` only choose the direction, and the accent is the
 * arrow colour. While items remain below the active one the hint points down; on the last one it points up.
 */
function previewContentIndicator(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(designStyle(widget, stylePanel()), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    if (rect.w === 0 || rect.h === 0) {
        return;
    }
    const count = Math.trunc(numberProp(widget.props, 'count', 3));
    const active = Math.trunc(numberProp(widget.props, 'active', 0));
    const up = count > 1 && active + 1 >= count;
    const cx = rect.x + Math.trunc(rect.w / 2);
    const cy = rect.y + Math.trunc(rect.h / 2);
    const s = Math.max(Math.trunc(Math.min(rect.w, rect.h) / 3), 2);
    const halfS = Math.trunc(s / 2);
    if (up) {
        drawLineStyled(context, cx - s, cy + halfS, cx, cy - halfS, style.accent, { width: 1 });
        drawLineStyled(context, cx, cy - halfS, cx + s, cy + halfS, style.accent, { width: 1 });
    } else {
        drawLineStyled(context, cx - s, cy - halfS, cx, cy + halfS, style.accent, { width: 1 });
        drawLineStyled(context, cx, cy + halfS, cx + s, cy - halfS, style.accent, { width: 1 });
    }
}

/**
 * Crumbs indicator (`CrumbsIndicatorWidget::render`, `wearable.rs:113-143`; `render_crumbs`,
 * `widgets/mod.rs:1777-1796`).
 *
 * `count` dots at six-pixel spacing; the active one is a pixel larger and the accent, the rest
 * `rgb(10,20,10)`. A zero count returns before painting, exactly as the widget does, and the active index is
 * clamped to the last dot.
 */
function previewCrumbs(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(designStyle(widget, stylePanel()), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    const count = clampInt(Math.trunc(numberProp(widget.props, 'count', 3)), 0, 255);
    if (count === 0) {
        return;
    }
    const active = clampInt(Math.trunc(numberProp(widget.props, 'active', 0)), 0, count - 1);
    const startX = rect.x + Math.trunc((rect.w - ((count - 1) * 6 + 4)) / 2) + 2;
    const cy = rect.y + Math.trunc(rect.h / 2);
    for (let i = 0; i < count; i += 1) {
        const isActive = i === active;
        fillCircle(context, startX + i * 6, cy, isActive ? 3 : 2, isActive ? style.accent : rgb(10, 20, 10), 255);
    }
}

function rectOf(widget: DesignerWidget): Rect {
    return { x: widget.x, y: widget.y, w: widget.width, h: widget.height };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * The visual state the board would resolve (`WidgetStyle::resolve`, spec 2.3).
 *
 * The designer's canvas has no pressed/focused/disabled input, so it always paints Normal; accepting a state
 * here keeps the door open for a caller that has one.
 */
export interface PreviewOptions {
    readonly state?: VisualState;
}

/**
 * Draws the crate's paint for a widget tag, or returns false for a tag this module does not cover so the
 * caller can keep its own fallback.
 *
 * The caller must clip to the widget's own rect: `Block::render` does not clip itself (spec 3.1) and the
 * board's widget clip is its cell.
 */
export function previewWidget(
    context: CanvasRenderingContext2D,
    widget: DesignerWidget,
    options: PreviewOptions = {},
): boolean {
    const state = options.state ?? 'normal';
    switch (widget.tag) {
        case 'panel':
        case 'card':
            previewPanel(context, widget, state);
            return true;
        case 'label':
        case 'banner':
            previewLabel(context, widget, state);
            return true;
        case 'button':
            previewButton(context, widget, state);
            return true;
        case 'toggle':
            previewToggle(context, widget, state);
            return true;
        case 'checkbox':
            previewCheckbox(context, widget, state);
            return true;
        case 'slider':
            previewSlider(context, widget, state);
            return true;
        case 'progress':
        case 'progress_bar':
            previewProgress(context, widget, state);
            return true;
        case 'dropdown':
            previewDropdown(context, widget, state);
            return true;
        case 'roller':
            previewRoller(context, widget, state);
            return true;
        case 'spinbox':
            previewSpinbox(context, widget, state);
            return true;
        case 'scale':
        case 'gauge':
            previewScale(context, widget, state);
            return true;
        case 'clock':
            previewClock(context, widget, state);
            return true;
        case 'keypad':
            previewKeypad(context, widget, state);
            return true;
        case 'arc':
        case 'sweeping_arc':
            previewArc(context, widget, state);
            return true;
        case 'busy_wheel':
        case 'spinner':
            previewSpinner(context, widget, state);
            return true;
        case 'chart':
            previewChart(context, widget, state);
            return true;
        case 'plotter':
            previewPlotter(context, widget, state);
            return true;
        case 'path':
        case 'vector_path':
            previewPath(context, widget, state);
            return true;
        case 'status_bar':
            previewStatusBar(context, widget, state);
            return true;
        case 'time_picker':
            previewTimePicker(context, widget, state);
            return true;
        case 'number_picker':
            previewNumberPicker(context, widget, state);
            return true;
        case 'content_indicator':
            previewContentIndicator(context, widget, state);
            return true;
        case 'crumbs':
        case 'crumbs_indicator':
            previewCrumbs(context, widget, state);
            return true;
        case 'table':
            previewTable(context, widget, state);
            return true;
        case 'dialog':
            previewDialog(context, widget, state);
            return true;
        case 'carousel':
            previewCarousel(context, widget, state);
            return true;
        default:
            return false;
    }
}
