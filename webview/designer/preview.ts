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

import { isBuiltInFont } from '../../src/designer/fonts';
import { type DesignerWidget } from '../../src/designer/model';
import { glyphMetrics, glyphRows, GLYPH_COLUMNS, GLYPH_ROWS, vectorGlyph, VECTOR_PEN_UP } from './glyphs';

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
 * edges, then the four `radius x radius` corner boxes scanned with the exact `in_rounded_rect` test against
 * the outer rect and an innermost inset.
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
                let innerHit = false;
                for (let i = 1; i < border.width; i += 1) {
                    const inner: Rect = {
                        x: rect.x + i,
                        y: rect.y + i,
                        w: Math.max(0, rect.w - 2 * i),
                        h: Math.max(0, rect.h - 2 * i),
                    };
                    if (!rectEmpty(inner) && inRoundedRect(x, y, inner, clamped - i)) {
                        innerHit = true;
                        break;
                    }
                }
                if (!innerHit) {
                    pixel(context, x, y, border.color, opacity);
                }
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
    for (let row = 0; row < GLYPH_ROWS; row += 1) {
        const bits = rows[row] ?? 0;
        for (let col = 0; col < GLYPH_COLUMNS; col += 1) {
            if ((bits & (1 << (GLYPH_COLUMNS - 1 - col))) === 0) {
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

/** Toggle (spec 4.4, `widgets/mod.rs:1398-1439`): a fixed track at the right whose colour is the state. */
function previewToggle(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(styleNew(), state);
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
    fillSolid(context, track, 0, boolProp(widget.props, 'checked', false) ? style.accent : rgb(7, 10, 10), 255);
    drawTextIn(
        context,
        { x: inner.x, y: inner.y, w: Math.max(0, inner.w - (knobWidth + 4)), h: inner.h },
        stringProp(widget.props, 'label', 'text'),
        style.font,
        style.text,
    );
}

/** Checkbox (spec 4.5, `widgets/mod.rs:1442-1482`): an outlined box and, when checked, an accent square. */
function previewCheckbox(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(styleNew(), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    const inner = blockInner(rect, style);
    const boxSize = Math.min(inner.h, 8);
    const box: Rect = {
        x: inner.x,
        y: inner.y + Math.floor(Math.max(0, inner.h - boxSize) / 2),
        w: boxSize,
        h: boxSize,
    };
    strokeRounded(context, box, 0, { color: style.text, width: 1 }, 255);
    if (boolProp(widget.props, 'checked', false) && boxSize > 4) {
        fillSolid(context, rectInset(box, allEdges(2)), 0, style.accent, 255);
    }
    drawTextIn(
        context,
        { x: inner.x + boxSize + 3, y: inner.y, w: Math.max(0, inner.w - (boxSize + 3)), h: inner.h },
        stringProp(widget.props, 'label', 'text'),
        style.font,
        style.text,
    );
}

/** Slider (spec 4.6, `widgets/mod.rs:1485-1508`): a one-pixel track and a 3x5 accent knob. */
function previewSlider(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(styleNew(), state);
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
    const knobX = inner.x + Math.trunc(Math.max(0, inner.w - 3) * t);
    fillSolid(context, { x: knobX, y: trackY - 2, w: 3, h: 5 }, 0, style.accent, 255);
}

/**
 * Progress bar (spec 4.7, `widgets/mod.rs:1370-1395`).
 *
 * The emitter passes `Style::default()` (spec 5.1, `emitter.rs:347-353`), so the block is inert and the fill
 * is `style.foreground` (WHITE) in Normal -- `Style::progress()`'s bordered horizontal gradient is *not* what
 * a KDL progress bar gets.
 */
function previewProgress(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(styleNew(), state);
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
    const style = resolveVisual(stylePanel(), state);
    const rect = rectOf(widget);
    drawBlock(context, rect, style);
    const inner = blockInner(rect, style);
    const items = optionValues(widget);
    const selected = Math.min(numberProp(widget.props, 'selected', 0), Math.max(0, items.length - 1));
    const text = items[selected] ?? '-';
    drawTextIn(context, { x: inner.x, y: inner.y, w: Math.max(0, inner.w - 8), h: inner.h }, text, style.font, style.text);
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

/** Roller (spec 4.9, `widgets/mod.rs:2669-2710`): previous/current/next in thirds, middle highlighted. */
function previewRoller(context: CanvasRenderingContext2D, widget: DesignerWidget, state: VisualState): void {
    const style = resolveVisual(stylePanel(), state);
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
    const style = resolveVisual(stylePanel(), state);
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
    const style = resolveVisual(stylePanel(), state);
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
