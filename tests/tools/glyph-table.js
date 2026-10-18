#!/usr/bin/env node
'use strict';

/**
 * Writes the webview's glyph table from the crate's own font data.
 *
 *   node tests/tools/glyph-table.js            # regenerate webview/designer/glyphs.ts
 *   node tests/tools/glyph-table.js --check    # fail if the committed table is out of step
 *
 * Why this exists: the designer's canvas is supposed to show what the board will show, and the board draws text
 * with `embedded-gui`'s bitmap fonts. A browser font of a similar size is *nearly* the same, which is the one
 * thing a WYSIWYG canvas cannot be -- every measurement taken off it (does the label fit? does the button text
 * overflow?) would be taken off the wrong font. So the glyphs are read out of the crate through its public
 * `glyph_rows`, and committed as a table the webview draws from.
 *
 * The Rust side is `tests/sim/src/bin/glyphs.rs`; this only runs it and formats the answer.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { repoRoot } = require('../lib/harness');

const TARGET = path.join(repoRoot(), 'webview', 'designer', 'glyphs.ts');
// The ambient cargo home, not a scratch one: this is a maintenance command rather than a test, and
// the crate it builds shares the workspace's own dependencies, which are already in that cache. A
// scratch home made it fail outright after a clean-out, because it had nothing to build from offline.
const CARGO_HOME = process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo');
const TARGET_DIR = path.join(repoRoot(), 'tests', 'out', 'sim-target');
const FIRST_CHAR = 32;
const LAST_CHAR = 126;

/** Runs the dump binary and parses its sections. */
function readFonts() {
    fs.mkdirSync(CARGO_HOME, { recursive: true });
    const run = spawnSync(
        'cargo',
        ['run', '--quiet', '--manifest-path', path.join(repoRoot(), 'tests', 'sim', 'Cargo.toml'), '--offline', '--bin', 'glyphs'],
        {
            cwd: repoRoot(),
            encoding: 'utf8',
            env: { ...process.env, CARGO_HOME, CARGO_TARGET_DIR: TARGET_DIR },
        },
    );
    if (run.status !== 0) {
        process.stderr.write(run.stderr ?? '');
        throw new Error('the glyph dump failed to build or run');
    }

    const fonts = [];
    const vectors = new Map();
    let inVector = false;
    for (const line of run.stdout.split('\n')) {
        if (line.trim() === 'vector') {
            inVector = true;
            continue;
        }
        const point = /^v (\d+)((?: \d+ \d+)*)$/.exec(line.trim());
        if (point !== null) {
            vectors.set(Number(point[1]), (point[2] ?? '').trim().split(/\s+/).filter((p) => p !== '').map(Number));
            continue;
        }
        if (inVector && line.trim() !== '' && !line.startsWith('font')) {
            continue;
        }
        if (line.startsWith('font')) {
            inVector = false;
        }
        const header = /^font (\S+) advance=(\d+) line_height=(\d+) width=(\d+) height=(\d+)$/.exec(line.trim());
        if (header !== null) {
            fonts.push({
                name: header[1],
                advance: Number(header[2]),
                lineHeight: Number(header[3]),
                width: Number(header[4]),
                height: Number(header[5]),
                rows: [],
            });
            continue;
        }
        const entry = /^(\d+)((?: \d+)*)$/.exec(line.trim());
        if (entry !== null && fonts.length > 0) {
            fonts[fonts.length - 1].rows.push(
                (entry[2] ?? '').trim().split(/\s+/).filter((n) => n !== '').map(Number),
            );
        }
    }
    if (fonts.length === 0) {
        throw new Error('the glyph dump produced nothing');
    }
    for (const font of fonts) {
        const expected = LAST_CHAR - FIRST_CHAR + 1;
        if (font.rows.length !== expected) {
            throw new Error(`${font.name}: ${font.rows.length} glyphs, expected ${expected}`);
        }
        for (const rows of font.rows) {
            if (rows.length !== font.height) {
                throw new Error(`${font.name}: a glyph has ${rows.length} rows, expected ${font.height}`);
            }
        }
    }
    if (vectors.size !== LAST_CHAR - FIRST_CHAR + 1) {
        throw new Error(`the vector table has ${vectors.size} glyphs, expected ${LAST_CHAR - FIRST_CHAR + 1}`);
    }
    return { fonts, vectors };
}

/** The file, as text, so `--check` can compare without writing. */
function render(fonts, vectors) {
    // The fonts share a glyph table almost exactly, but not quite: `Medium4x7` has its own spelling of `*` and
    // `@`. So the tables are stored as they come and deduped by content -- identical fonts point at one copy,
    // and a font whose table changes gets its own without the generator having to be told.
    const tables = [];
    const index = new Map();
    const tableOf = (rows) => {
        const key = JSON.stringify(rows);
        if (!index.has(key)) {
            index.set(key, tables.length);
            tables.push(rows);
        }
        return index.get(key);
    };
    const tiny = fonts.find((font) => font.name === 'Tiny3x5') ?? fonts[0];
    const metrics = fonts
        .map((font) => {
            const table = tableOf(font.rows);
            const entry =
                `{ advance: ${font.advance}, lineHeight: ${font.lineHeight}, width: ${font.width}, ` +
                `height: ${font.height}, table: ${table} }`;
            return `    ${JSON.stringify(font.name)}: ${font.name === 'Tiny3x5' ? 'DEFAULT_FONT' : entry},`;
        })
        .join('\n');
    // Each table is its own named constant, and the first one doubles as the fallback: the webview compiles with
    // `noUncheckedIndexedAccess`, so `TABLES[0]` is `possibly undefined` and may not be used as a default.
    const packed = tables
        .map(
            (rows, index) =>
                `const TABLE_${index}: readonly number[] = [\n${rows
                    .map((row) => `    ${row.join(', ')},`)
                    .join('\n')}\n];`,
        )
        .join('\n\n');

    const vectorRows = [...vectors.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, points]) => `    [${points.join(', ')}],`)
        .join('\n');

    return `/**
 * The crate's own glyphs, and its per-font metrics -- GENERATED, DO NOT EDIT.
 *
 * Produced by \`node tests/tools/glyph-table.js\`, which runs \`tests/sim/src/bin/glyphs.rs\`: a host binary that
 * reads \`embedded_gui::font::glyph_rows\` for every printable ASCII character. The canvas draws text from this
 * table so that what it shows is the font the board will use, not one that looks a bit like it.
 *
 * A glyph is \`height\` row numbers. In row \`r\`, bit \`1 << (width - 1 - col)\` is set when the pixel at
 * column \`col\` (0 = leftmost) is ink -- the walk is \`PackedFont::draw_glyph\` for the 3x5 faces and
 * \`BitmapFont::draw_glyph_to\` for the rasterised ones, both in the crate's \`font.rs\`. Each font also
 * carries its own \`width\`, \`height\`, \`advance\` and \`lineHeight\`, which is what the canvas measures
 * text with.
 */

/** The first character code the table covers. */
export const GLYPH_FIRST_CHAR = ${FIRST_CHAR};

/** The last character code the table covers. */
export const GLYPH_LAST_CHAR = ${LAST_CHAR};

/** One line of a glyph: \`width\` bits, leftmost column in bit \`width - 1\`. */
export interface GlyphMetrics {
    /** Pixels from one character's origin to the next. */
    advance: number;
    /** Pixels from one line's origin to the next. */
    lineHeight: number;
    /** Columns in a glyph -- three for the 3x5 faces, six or eight for a rasterised one. */
    width: number;
    /** Rows in a glyph -- five for the 3x5 faces, ten or sixteen for a rasterised one. */
    height: number;
    /** Which of \`TABLES\` holds this font's glyphs. */
    table: number;
}

/** The crate's default font, and what anything unrecognised falls back to. */
const DEFAULT_FONT: GlyphMetrics = { advance: ${tiny.advance}, lineHeight: ${tiny.lineHeight}, width: ${tiny.width}, height: ${tiny.height}, table: ${tableOf(tiny.rows)} };

/** The fonts the designer offers, by the name the design stores. */
export const GLYPH_FONTS: Record<string, GlyphMetrics> = {
${metrics}
};

/** Five row bytes per character, from \`GLYPH_FIRST_CHAR\`, one entry per distinct font table. */
${packed}

/** Every distinct table, in the order the fonts above point at them. */
const TABLES: readonly (readonly number[])[] = [${tables.map((_, index) => `TABLE_${index}`).join(', ')}];

/** How many columns a glyph of this font has. */
export function glyphColumns(font: string): number {
    return glyphMetrics(font).width;
}

/** How many rows a glyph of this font has. */
export function glyphRowCount(font: string): number {
    return glyphMetrics(font).height;
}

/**
 * The row numbers of one character in the crate's glyph table for a font.
 *
 * A character outside the table answers with the crate's own fallback, \`?\` -- which is what \`glyph_rows\`
 * does, and the canvas has to agree with the board about what an unsupported character looks like.
 */
export function glyphRows(font: string, ch: string): readonly number[] {
    const metrics = glyphMetrics(font);
    const table = TABLES[metrics.table] ?? TABLE_0;
    const code = ch.codePointAt(0) ?? 0;
    const wanted = code >= GLYPH_FIRST_CHAR && code <= GLYPH_LAST_CHAR ? code : '?'.codePointAt(0) ?? 0;
    const start = (wanted - GLYPH_FIRST_CHAR) * metrics.height;
    return table.slice(start, start + metrics.height);
}

/** The metrics of a font the design names, falling back to the crate's own default (\`Tiny3x5\`). */
export function glyphMetrics(font: string): GlyphMetrics {
    return GLYPH_FONTS[font] ?? DEFAULT_FONT;
}

/**
 * The crate's pen-up marker in a vector glyph: a point of \`(255, 255)\` lifts the pen rather than drawing
 * (\`draw_char_with_font\`'s \`FontId::Vector(scale)\` arm), so a glyph can be more than one stroke.
 */
export const VECTOR_PEN_UP = 255;

/** One vector glyph's points, flat pairs interleaved with \`VECTOR_PEN_UP\` where the pen lifts. */
const VECTOR_GLYPHS: readonly (readonly number[])[] = [
${vectorRows}
];

/**
 * The points of one character's vector glyph, for the crate's \`Vector(n)\` fonts.
 *
 * The points do not depend on \`n\`: the engine scales each coordinate by the variant's scale as it strokes the
 * polyline, so a canvas replicating it must multiply by the same scale and draw one-pixel segments between
 * consecutive points (breaking wherever the pen-up marker appears).
 */
export function vectorGlyph(ch: string): readonly number[] {
    const code = ch.codePointAt(0) ?? 0;
    const index = code >= GLYPH_FIRST_CHAR && code <= GLYPH_LAST_CHAR
        ? code - GLYPH_FIRST_CHAR
        : ('?'.codePointAt(0) ?? 0) - GLYPH_FIRST_CHAR;
    return VECTOR_GLYPHS[index] ?? [];
}
`;
}

const { fonts, vectors } = readFonts();
const source = render(fonts, vectors);

if (process.argv.includes('--check')) {
    const existing = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
    if (existing !== source) {
        console.error('webview/designer/glyphs.ts is out of step with the crate: run node tests/tools/glyph-table.js');
        process.exit(1);
    }
    console.log(`the glyph table matches the crate (${fonts.length} fonts, ${vectors.size} vector glyphs)`);
} else {
    fs.writeFileSync(TARGET, source);
    console.log(
        `wrote ${path.relative(repoRoot(), TARGET)}: ${fonts.length} fonts, ` +
            `${LAST_CHAR - FIRST_CHAR + 1} bitmap glyphs each, ${vectors.size} vector glyphs`,
    );
}
