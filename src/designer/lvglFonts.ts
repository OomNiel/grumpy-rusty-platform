/**
 * The design's font vocabulary, expressed in LVGL's.
 *
 * One canvas serves both languages, so a design names a font once — `Mono8x16`, `Vector(3)`, or a face somebody
 * imported as a BDF. The Rust crate draws those from its own bitmaps. LVGL has no such thing: it carries a family
 * of Montserrat faces at fixed point sizes, compiled in one at a time by `LV_FONT_MONTSERRAT_<size>`.
 *
 * So a C++ project gets the *nearest* Montserrat size for the font the design names, chosen against the line height
 * the canvas draws that font at (see `webview/designer/glyphs.ts`) — the number that decides whether a label still
 * fits the rectangle the design gave it. It is an approximation, and it is said out loud in the generated file, in
 * the Designer's output channel and in the changelog: pretending `Mono8x16` is a bitmap LVGL can use would be the
 * one thing worse than approximating it.
 *
 * Pure: no `vscode`, no filesystem, so the t1 layer pins the table and the emitter uses it while the Designer
 * reports it.
 */

/** A design font, and what a C++ project draws instead. */
export interface LvglFontChoice {
    /** The Montserrat point size, which is also the suffix of the `lv_font_montserrat_<n>` symbol. */
    size: number;
    /**
     * How the choice was made: `builtin` from the design's own font id, `declared` for a font whose pixels live in
     * a BDF file the crate rasterises (LVGL cannot read those), and `default` when the design named no font.
     */
    source: 'builtin' | 'declared' | 'default';
}

/**
 * The sizes this extension will enable, and the nearest for each design font.
 *
 * The right-hand column is the canvas's line height for that font — the number of pixels a line occupies — which is
 * what has to stay about the same for a label to keep its place in the rectangle. Montserrat's own ascent+descent
 * at size N is about N * 1.2, so a 12px line is Montserrat 10 and a 24px line is Montserrat 20.
 */
const FONT_SIZES: Readonly<Record<string, number>> = {
    Tiny3x5: 10, // line 6
    Medium4x7: 10, // line 8
    Medium5x7: 12, // line 9
    Scaled6x10: 14, // line 11
    Mono6x10: 14, // line 12
    Mono8x16: 20, // line 19
    'Vector(2)': 24, // line 24
    'Vector(3)': 34, // line 36
};

/** The size every LVGL build has to carry: `LV_FONT_DEFAULT`. */
export const DEFAULT_FONT_SIZE = 14;

/**
 * The largest size a build may switch on.
 *
 * Montserrat 44 is 60 KB of flash; the smaller boards have 2 MB in total and the sketch is already half of it, so a
 * design that asks for a giant font is capped here rather than turned into a link error nobody can read.
 */
export const MAX_FONT_SIZE = 36;

/** The Montserrat sizes LVGL can be asked for, smallest first — the set `lv_conf.h` may switch on. */
export const LVGL_FONT_SIZES: readonly number[] = [8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36];

/** The symbol for one size, as `lv_obj_set_style_text_font` wants it. */
export function fontSymbol(size: number): string {
    return `&lv_font_montserrat_${size}`;
}

/** The nearest size this build can actually give, for a size a design asked for. */
export function nearestFontSize(size: number): number {
    let best = LVGL_FONT_SIZES[0] ?? DEFAULT_FONT_SIZE;
    for (const candidate of LVGL_FONT_SIZES) {
        if (Math.abs(candidate - size) < Math.abs(best - size)) {
            best = candidate;
        }
    }
    return Math.min(best, MAX_FONT_SIZE);
}

/**
 * What a C++ project draws for a font a design names.
 *
 * `declared` is a font the design declared with pixels from a BDF file: LVGL cannot read it, so the nearest
 * generous size stands in — 24 points, about what an imported face is chosen for.
 */
export function lvglFontFor(fontId: string | undefined, declared: readonly string[] = []): LvglFontChoice {
    const id = fontId ?? '';
    if (id === '') {
        return { size: DEFAULT_FONT_SIZE, source: 'default' };
    }
    const builtin = FONT_SIZES[id];
    if (builtin !== undefined) {
        return { size: nearestFontSize(builtin), source: 'builtin' };
    }
    if (declared.includes(id)) {
        return { size: nearestFontSize(24), source: 'declared' };
    }
    // A name this build does not know: the canvas would fall back too, so the board does the same rather than
    // refusing to compile over a font.
    return { size: DEFAULT_FONT_SIZE, source: 'default' };
}

/** The `#define`s that switch on a set of sizes, with the default always among them. */
export function lvConfFontLines(sizes: Iterable<number>): string {
    const wanted = new Set<number>([DEFAULT_FONT_SIZE]);
    for (const size of sizes) {
        wanted.add(nearestFontSize(size));
    }
    const lines = [...wanted]
        .sort((left, right) => left - right)
        .map((size) => `#define LV_FONT_MONTSERRAT_${size} 1`);
    lines.push(`#define LV_FONT_DEFAULT ${fontSymbol(DEFAULT_FONT_SIZE)}`);
    return lines.join('\n');
}

/** The font the design names on one widget, if any. */
export function designFontOf(props: Record<string, unknown>): string | undefined {
    const value = props.font;
    return typeof value === 'string' && value !== '' ? value : undefined;
}
